"""Tests for hooks/validate_artifact.py (v2 schema-backed hook).

Covers: 4 adapter parsers, YAML schema validation (pass + fail),
markdown validation, main() integration via stdin.
"""

from __future__ import annotations

import importlib.util
import io
import json
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture(scope="session")
def hook():
    mod_path = REPO_ROOT / "hooks" / "validate_artifact.py"
    spec = importlib.util.spec_from_file_location("validate_artifact", mod_path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def project_dir(tmp_path):
    (tmp_path / ".agentera").mkdir()
    return tmp_path


# ── Adapter parsers ────────────────────────────────────────────────


class TestParseClaude:
    def test_edit_with_content(self, hook):
        data = {"tool_name": "Edit", "tool_input": {"file_path": "/a.md", "content": "x"}}
        assert hook._parse_claude(data) == ("/a.md", "x")

    def test_write_no_content(self, hook):
        data = {"tool_name": "Write", "tool_input": {"file_path": "/b.yaml"}}
        assert hook._parse_claude(data) == ("/b.yaml", None)

    def test_no_tool_input(self, hook):
        assert hook._parse_claude({}) is None

    def test_no_file_path(self, hook):
        assert hook._parse_claude({"tool_input": {"content": "x"}}) is None


class TestParseOpenCode:
    def test_path_and_content(self, hook):
        data = {"input": {"path": "progress.yaml", "content": "cycles: []"}}
        assert hook._parse_opencode(data) == ("progress.yaml", "cycles: []")

    def test_path_only(self, hook):
        data = {"input": {"path": "f.yaml"}}
        assert hook._parse_opencode(data) == ("f.yaml", None)

    def test_no_path(self, hook):
        assert hook._parse_opencode({"input": {"content": "x"}}) is None


class TestParseCodex:
    def test_direct_path(self, hook):
        data = {"tool_input": {"path": ".agentera/health.yaml", "patch": "@@\n-old\n+new"}}
        assert hook._parse_codex(data) == (".agentera/health.yaml", None)

    def test_patch_file_header(self, hook):
        body = "*** Begin Patch\n*** Update File: .agentera/plan.yaml\n@@\n-old\n+new\n"
        data = {"tool_input": {"command": body}}
        assert hook._parse_codex(data) == (".agentera/plan.yaml", None)

    def test_no_path_no_headers(self, hook):
        assert hook._parse_codex({"tool_input": {"command": "plain text"}}) is None


class TestParseCopilot:
    def test_filePath(self, hook):
        data = {"input": {"filePath": "/TODO.md", "content": "# TODO"}}
        assert hook._parse_copilot(data) == ("/TODO.md", "# TODO")

    def test_file_path_key(self, hook):
        data = {"input": {"file_path": "TODO.md"}}
        assert hook._parse_copilot(data) == ("TODO.md", None)


class TestRoute:
    def test_routes_claude_edit(self, hook):
        data = {"tool_name": "Edit", "tool_input": {"file_path": "f.yaml", "content": "x"}}
        assert hook._route(data) == ("f.yaml", "x")

    def test_routes_codex_apply_patch(self, hook):
        data = {"tool_name": "apply_patch", "tool_input": {"path": "f.yaml", "patch": "@@"}}
        assert hook._route(data) == ("f.yaml", None)

    def test_routes_opencode(self, hook):
        data = {"input": {"path": "f.yaml", "content": "x"}}
        assert hook._route(data) == ("f.yaml", "x")

    def test_routes_copilot(self, hook):
        data = {"tool_name": "create", "input": {"filePath": "f.yaml", "content": "x"}}
        assert hook._route(data) == ("f.yaml", "x")

    def test_returns_none_for_unknown(self, hook):
        assert hook._route({}) is None


# ── YAML validation ────────────────────────────────────────────────


def _load_schema(name: str) -> dict:
    import yaml

    path = REPO_ROOT / "skills" / "agentera" / "schemas" / "artifacts" / f"{name}.yaml"
    with open(path) as f:
        return yaml.safe_load(f)


class TestValidateYamlProgress:
    def test_valid_progress(self, hook):
        schema = _load_schema("progress")
        content = yaml_dump({
            "cycles": [
                {
                    "number": 1,
                    "timestamp": "2026-05-04 10:00",
                    "type": "feat",
                    "phase": "build",
                    "what": "Added login handler",
                    "commit": "abc123",
                    "context": {"intent": "Ship auth"},
                }
            ]
        })
        violations = hook._validate_yaml(content, schema, "progress")
        assert violations == []

    def test_non_mapping_root(self, hook):
        schema = _load_schema("progress")
        content = yaml_dump([{"number": 1}])
        violations = hook._validate_yaml(content, schema, "progress")
        assert any("root must be a mapping" in v for v in violations)

    def test_duplicate_cycle_numbers(self, hook):
        schema = _load_schema("progress")
        content = yaml_dump({
            "cycles": [
                {"number": 2, "timestamp": "2026-05-04 10:00", "type": "feat",
                 "phase": "build", "what": "x", "commit": "a",
                 "context": {"intent": "y"}},
                {"number": 2, "timestamp": "2026-05-04 11:00", "type": "fix",
                 "phase": "build", "what": "z", "commit": "b",
                 "context": {"intent": "w"}},
            ]
        })
        violations = hook._validate_yaml(content, schema, "progress")
        assert any("duplicate numbers" in v for v in violations)

    def test_invalid_yaml_syntax(self, hook):
        schema = _load_schema("progress")
        violations = hook._validate_yaml("{{{\n  invalid", schema, "progress")
        assert any("invalid YAML" in v for v in violations)

    def test_non_mapping_root(self, hook):
        schema = _load_schema("progress")
        violations = hook._validate_yaml("[1, 2, 3]", schema, "progress")
        assert any("root must be a mapping" in v for v in violations)


class TestValidateYamlPlan:
    def test_valid_plan(self, hook):
        schema = _load_schema("plan")
        content = yaml_dump({
            "header": {"level": "full", "created": "2026-05-04", "status": "active",
                       "title": "Test plan"},
            "what": "Build the thing",
            "why": "Because reasons",
            "scope": {"included": ["src/"], "excluded": ["vendor/"]},
            "tasks": [{"number": 1, "name": "First", "status": "pending"}],
        })
        violations = hook._validate_yaml(content, schema, "plan")
        assert violations == []

    def test_missing_scope(self, hook):
        schema = _load_schema("plan")
        content = yaml_dump({
            "header": {"level": "full", "created": "2026-05-04", "status": "active",
                       "title": "Plan"},
            "what": "Build",
            "why": "Reasons",
            "scope": {},
            "tasks": [{"number": 1, "name": "T1", "status": "pending"}],
        })
        violations = hook._validate_yaml(content, schema, "plan")
        assert any("missing required field" in v for v in violations)


class TestValidateYamlDecisions:
    def test_valid_decisions(self, hook):
        schema = _load_schema("decisions")
        content = yaml_dump({
            "decisions": [
                {
                    "number": 1, "date": "2026-05-04",
                    "question": "Which format?", "context": "Need portability",
                    "choice": "YAML", "reasoning": "Widely supported",
                    "confidence": "firm",
                    "alternatives": [{"name": "JSON", "status": "rejected"}],
                }
            ]
        })
        violations = hook._validate_yaml(content, schema, "decisions")
        assert violations == []

    def test_out_of_order_numbers(self, hook):
        schema = _load_schema("decisions")
        content = yaml_dump({
            "decisions": [
                {"number": 2, "date": "2026-05-04", "question": "Q",
                 "context": "C", "choice": "A", "reasoning": "R",
                 "confidence": "firm",
                 "alternatives": [{"name": "A", "status": "chosen"}]},
                {"number": 1, "date": "2026-05-04", "question": "Q2",
                 "context": "C", "choice": "B", "reasoning": "R",
                 "confidence": "firm",
                 "alternatives": [{"name": "B", "status": "chosen"}]},
            ]
        })
        violations = hook._validate_yaml(content, schema, "decisions")
        assert any("not in ascending order" in v for v in violations)


class TestValidateYamlVision:
    def test_valid_vision(self, hook):
        schema = _load_schema("vision")
        content = yaml_dump({
            "header": {"project_name": "Test"},
            "north_star": {"content": "Be the best"},
            "personas": [{"name": "Dev", "description": "A developer"}],
            "principles": [{"name": "Simplicity", "description": "Keep it simple"}],
            "direction": {"content": "Forward"},
            "identity": {
                "personality": "Friendly",
                "voice": "Direct",
                "emotional_register": "Calm",
                "naming": "Swedish verbs",
            },
            "tension": {"content": "Speed vs quality"},
        })
        violations = hook._validate_yaml(content, schema, "vision")
        assert violations == []

    def test_missing_identity_field(self, hook):
        schema = _load_schema("vision")
        content = yaml_dump({
            "header": {"project_name": "Test"},
            "north_star": {"content": "Be the best"},
            "personas": [{"name": "Dev", "description": "A developer"}],
            "principles": [{"name": "Simplicity", "description": "Keep it simple"}],
            "direction": {"content": "Forward"},
            "identity": {"personality": "Friendly"},
            "tension": {"content": "Speed vs quality"},
        })
        violations = hook._validate_yaml(content, schema, "vision")
        assert any("missing required field" in v for v in violations)


class TestWordBudget:
    def test_within_budget(self, hook):
        schema = _load_schema("vision")
        content = yaml_dump({
            "header": {"project_name": "T"},
            "north_star": {"content": "X"},
            "personas": [{"name": "A", "description": "B"}],
            "principles": [{"name": "C", "description": "D"}],
            "direction": {"content": "E"},
            "identity": {"personality": "F", "voice": "G",
                         "emotional_register": "H", "naming": "I"},
            "tension": {"content": "J"},
        })
        violations = hook._validate_yaml(content, schema, "vision")
        assert not any("budget" in v for v in violations)

    def test_exceeds_budget(self, hook):
        schema = _load_schema("health")
        padding = " ".join(["word"] * 3000)
        content = yaml_dump({"header": {"last_audit": "2026-05-04 (test)"},
                             "data": padding})
        violations = hook._validate_yaml(content, schema, "health")
        assert any("budget" in v for v in violations)


# ── Markdown validation ────────────────────────────────────────────


class TestValidateMarkdown:
    def test_valid_md(self, hook):
        assert hook._validate_md("# TODO\n\n- [ ] item\n", "TODO.md") == []

    def test_empty_content(self, hook):
        assert any("empty" in v for v in hook._validate_md("  \n", "TODO.md"))

    def test_unclosed_fence(self, hook):
        assert any("code fence" in v for v in hook._validate_md("# T\n```\ncode\n", "TODO.md"))


# ── Schema loading ─────────────────────────────────────────────────


class TestSchemaLoading:
    def test_known_schema(self, hook):
        assert hook._load_schema("progress") is not None

    def test_unknown_schema(self, hook):
        assert hook._load_schema("nonexistent_xyz") is None


# ── Main integration via stdin ─────────────────────────────────────


def _run_main(hook, monkeypatch, data: dict, cwd: str):
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps({**data, "cwd": cwd})))
    captured_err = io.StringIO()
    monkeypatch.setattr("sys.stderr", captured_err)
    captured_out = io.StringIO()
    monkeypatch.setattr("sys.stdout", captured_out)
    rc = hook.main()
    return rc, captured_err.getvalue(), captured_out.getvalue()


class TestMainYamlArtifact:
    def test_valid_yaml_passes(self, hook, project_dir, monkeypatch):
        artifact = project_dir / ".agentera" / "session.yaml"
        artifact.write_text(yaml_dump({
            "bookmarks": [{"timestamp": "2026-05-04 10:00", "artifacts": ["PROGRESS"]}]
        }))
        rc, err, out = _run_main(hook, monkeypatch, {
            "tool_name": "Edit",
            "tool_input": {"file_path": str(artifact)},
        }, str(project_dir))
        assert rc == 0

    def test_invalid_yaml_fails(self, hook, project_dir, monkeypatch):
        artifact = project_dir / ".agentera" / "session.yaml"
        artifact.write_text("{{{\n  broken yaml")
        rc, err, out = _run_main(hook, monkeypatch, {
            "tool_name": "Write",
            "tool_input": {"file_path": str(artifact)},
        }, str(project_dir))
        assert rc == 2
        assert "invalid YAML" in err

    def test_non_artifact_exits_zero(self, hook, project_dir, monkeypatch):
        rc, err, out = _run_main(hook, monkeypatch, {
            "tool_name": "Edit",
            "tool_input": {"file_path": "/tmp/random.py"},
        }, str(project_dir))
        assert rc == 0
        assert err == ""

    def test_human_facing_markdown_valid(self, hook, project_dir, monkeypatch):
        todo = project_dir / "TODO.md"
        todo.write_text("# TODO\n\n- [ ] something\n")
        rc, err, out = _run_main(hook, monkeypatch, {
            "tool_name": "Write",
            "tool_input": {"file_path": str(todo)},
        }, str(project_dir))
        assert rc == 0

    def test_human_facing_markdown_invalid(self, hook, project_dir, monkeypatch):
        todo = project_dir / "TODO.md"
        todo.write_text("")
        rc, err, out = _run_main(hook, monkeypatch, {
            "tool_name": "Write",
            "tool_input": {"file_path": str(todo)},
        }, str(project_dir))
        assert rc == 2
        assert "empty" in err

    def test_empty_stdin(self, hook, monkeypatch):
        monkeypatch.setattr("sys.stdin", io.StringIO(""))
        assert hook.main() == 0

    def test_malformed_json(self, hook, monkeypatch):
        monkeypatch.setattr("sys.stdin", io.StringIO("{bad json"))
        assert hook.main() == 0


class TestMainAdapterFormats:
    def test_opencode_format(self, hook, project_dir, monkeypatch):
        artifact = project_dir / ".agentera" / "session.yaml"
        artifact.write_text(yaml_dump({
            "bookmarks": [{"timestamp": "2026-05-04 10:00", "artifacts": ["PROGRESS"]}]
        }))
        rc, err, out = _run_main(hook, monkeypatch, {
            "input": {"path": str(artifact)},
        }, str(project_dir))
        assert rc == 0

    def test_copilot_format(self, hook, project_dir, monkeypatch):
        artifact = project_dir / ".agentera" / "session.yaml"
        artifact.write_text("not: [valid\n  yaml")
        rc, err, out = _run_main(hook, monkeypatch, {
            "tool_name": "create",
            "input": {"filePath": str(artifact)},
        }, str(project_dir))
        assert rc == 2

    def test_codex_format(self, hook, project_dir, monkeypatch):
        artifact = project_dir / ".agentera" / "session.yaml"
        artifact.write_text("not: [valid\n  yaml")
        rc, err, out = _run_main(hook, monkeypatch, {
            "tool_name": "apply_patch",
            "tool_input": {"path": str(artifact), "patch": "@@\n-old\n+new"},
        }, str(project_dir))
        assert rc == 2


class TestFailOpenGuard:
    SCRIPT = str(REPO_ROOT / "hooks" / "validate_artifact.py")

    def test_non_dict_json_exits_zero(self, tmp_path):
        """JSON list input is handled gracefully, exits 0."""
        result = subprocess.run(
            [sys.executable, self.SCRIPT],
            input="[]",
            capture_output=True,
            text=True,
            cwd=str(tmp_path),
        )
        assert result.returncode == 0

    def test_normal_exit_0(self, tmp_path):
        import subprocess
        data = json.dumps({"tool_name": "Edit", "tool_input": {"file_path": "/dev/null"}})
        result = subprocess.run(
            [sys.executable, self.SCRIPT],
            input=data,
            capture_output=True,
            text=True,
            cwd=str(tmp_path),
        )
        assert result.returncode == 0


# ── Helpers ─────────────────────────────────────────────────────────


def yaml_dump(data: dict) -> str:
    import yaml
    return yaml.dump(data, default_flow_style=False, allow_unicode=True)
