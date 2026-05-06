"""Tests for hooks/validate_artifact.py (v2 schema-backed hook).

Covers: runtime event parsing, artifact schema validation (pass + fail),
markdown validation, and CLI adapter integration via stdin.
"""

from __future__ import annotations

import importlib.util
import io
import json
import subprocess
import sys
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


@pytest.fixture()
def parser(hook):
    return hook.RuntimeEventParser()


@pytest.fixture()
def write_cls(hook):
    return hook.ArtifactWrite


# ── Adapter parsers ────────────────────────────────────────────────


class TestParseClaude:
    def test_edit_with_content(self, parser, write_cls):
        data = {"tool_name": "Edit", "tool_input": {"file_path": "/a.md", "content": "x"}}
        assert parser.parse_claude(data) == write_cls("/a.md", "x")

    def test_write_no_content(self, parser, write_cls):
        data = {"tool_name": "Write", "tool_input": {"file_path": "/b.yaml"}}
        assert parser.parse_claude(data) == write_cls("/b.yaml")

    def test_no_tool_input(self, parser):
        assert parser.parse_claude({}) is None

    def test_no_file_path(self, parser):
        assert parser.parse_claude({"tool_input": {"content": "x"}}) is None


class TestParseOpenCode:
    def test_path_and_content(self, parser, write_cls):
        data = {"input": {"path": "progress.yaml", "content": "cycles: []"}}
        assert parser.parse_opencode(data) == write_cls("progress.yaml", "cycles: []")

    def test_path_only(self, parser, write_cls):
        data = {"input": {"path": "f.yaml"}}
        assert parser.parse_opencode(data) == write_cls("f.yaml")

    def test_no_path(self, parser):
        assert parser.parse_opencode({"input": {"content": "x"}}) is None


class TestParseCodex:
    def test_direct_path(self, parser, write_cls):
        data = {"tool_input": {"path": ".agentera/health.yaml", "patch": "@@\n-old\n+new"}}
        assert parser.parse_codex(data) == write_cls(".agentera/health.yaml")

    def test_patch_file_header(self, parser, write_cls):
        body = "*** Begin Patch\n*** Update File: .agentera/plan.yaml\n@@\n-old\n+new\n"
        data = {"tool_input": {"command": body}}
        assert parser.parse_codex(data) == write_cls(".agentera/plan.yaml")

    def test_no_path_no_headers(self, parser):
        assert parser.parse_codex({"tool_input": {"command": "plain text"}}) is None


class TestParseCopilot:
    def test_filePath(self, parser, write_cls):
        data = {"input": {"filePath": "/TODO.md", "content": "# TODO"}}
        assert parser.parse_copilot(data) == write_cls("/TODO.md", "# TODO")

    def test_file_path_key(self, parser, write_cls):
        data = {"input": {"file_path": "TODO.md"}}
        assert parser.parse_copilot(data) == write_cls("TODO.md")


class TestRoute:
    def test_routes_claude_edit(self, parser, write_cls):
        data = {"tool_name": "Edit", "tool_input": {"file_path": "f.yaml", "content": "x"}}
        assert parser.parse(data) == write_cls("f.yaml", "x")

    def test_routes_codex_apply_patch(self, parser, write_cls):
        data = {"tool_name": "apply_patch", "tool_input": {"path": "f.yaml", "patch": "@@"}}
        assert parser.parse(data) == write_cls("f.yaml")

    def test_routes_opencode(self, parser, write_cls):
        data = {"input": {"path": "f.yaml", "content": "x"}}
        assert parser.parse(data) == write_cls("f.yaml", "x")

    def test_routes_copilot(self, parser, write_cls):
        data = {"tool_name": "create", "input": {"filePath": "f.yaml", "content": "x"}}
        assert parser.parse(data) == write_cls("f.yaml", "x")

    def test_returns_none_for_unknown(self, parser):
        assert parser.parse({}) is None


# ── YAML validation ────────────────────────────────────────────────

class TestValidateYamlProgress:
    def test_valid_progress(self, hook):
        schema = hook.load_schema("progress")
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
        violations = hook.validate_yaml(content, schema, "progress")
        assert violations == []

    def test_non_mapping_root(self, hook):
        schema = hook.load_schema("progress")
        content = yaml_dump([{"number": 1}])
        violations = hook.validate_yaml(content, schema, "progress")
        assert any("root must be a mapping" in v for v in violations)

    def test_duplicate_cycle_numbers(self, hook):
        schema = hook.load_schema("progress")
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
        violations = hook.validate_yaml(content, schema, "progress")
        assert any("duplicate numbers" in v for v in violations)

    def test_progress_cycles_are_newest_first(self, hook):
        schema = hook.load_schema("progress")
        content = yaml_dump({
            "cycles": [
                {"number": 2, "timestamp": "2026-05-04 11:00", "type": "fix",
                 "phase": "build", "what": "newer", "commit": "b",
                 "context": {"intent": "w"}},
                {"number": 1, "timestamp": "2026-05-04 10:00", "type": "feat",
                 "phase": "build", "what": "older", "commit": "a",
                 "context": {"intent": "y"}},
            ]
        })
        assert hook.validate_yaml(content, schema, "progress") == []

    def test_progress_cycles_reject_invalid_phase(self, hook):
        schema = hook.load_schema("progress")
        content = yaml_dump({
            "cycles": [
                {"number": 2, "timestamp": "2026-05-04 11:00", "type": "fix",
                 "phase": "verify", "what": "newer", "commit": "b",
                 "context": {"intent": "w"}},
            ]
        })
        violations = hook.validate_yaml(content, schema, "progress")
        assert any("invalid value 'verify'" in v for v in violations)

    def test_progress_cycles_reject_oldest_first(self, hook):
        schema = hook.load_schema("progress")
        content = yaml_dump({
            "cycles": [
                {"number": 1, "timestamp": "2026-05-04 10:00", "type": "feat",
                 "phase": "build", "what": "older", "commit": "a",
                 "context": {"intent": "y"}},
                {"number": 2, "timestamp": "2026-05-04 11:00", "type": "fix",
                 "phase": "build", "what": "newer", "commit": "b",
                 "context": {"intent": "w"}},
            ]
        })
        violations = hook.validate_yaml(content, schema, "progress")
        assert any("not in descending order" in v for v in violations)

    def test_invalid_yaml_syntax(self, hook):
        schema = hook.load_schema("progress")
        violations = hook.validate_yaml("{{{\n  invalid", schema, "progress")
        assert any("invalid YAML" in v for v in violations)

    def test_non_mapping_root(self, hook):
        schema = hook.load_schema("progress")
        violations = hook.validate_yaml("[1, 2, 3]", schema, "progress")
        assert any("root must be a mapping" in v for v in violations)


class TestValidateYamlPlan:
    def test_valid_plan(self, hook):
        schema = hook.load_schema("plan")
        content = yaml_dump({
            "header": {"level": "full", "created": "2026-05-04", "status": "active",
                       "title": "Test plan"},
            "what": "Build the thing",
            "why": "Because reasons",
            "scope": {"included": ["src/"], "excluded": ["vendor/"]},
            "tasks": [{"number": 1, "name": "First", "status": "pending"}],
        })
        violations = hook.validate_yaml(content, schema, "plan")
        assert violations == []

    def test_missing_scope(self, hook):
        schema = hook.load_schema("plan")
        content = yaml_dump({
            "header": {"level": "full", "created": "2026-05-04", "status": "active",
                       "title": "Plan"},
            "what": "Build",
            "why": "Reasons",
            "scope": {},
            "tasks": [{"number": 1, "name": "T1", "status": "pending"}],
        })
        violations = hook.validate_yaml(content, schema, "plan")
        assert any("missing required field" in v for v in violations)


class TestValidateYamlDecisions:
    def test_valid_decisions(self, hook):
        schema = hook.load_schema("decisions")
        content = yaml_dump({
            "decisions": [
                {
                    "number": 1, "date": "2026-05-04",
                    "question": "Which format?", "context": "Need portability",
                    "choice": "YAML", "reasoning": "Widely supported",
                    "confidence": "firm",
                    "alternatives": [{"name": "YAML", "status": "chosen"}],
                }
            ]
        })
        violations = hook.validate_yaml(content, schema, "decisions")
        assert violations == []

    def test_out_of_order_numbers(self, hook):
        schema = hook.load_schema("decisions")
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
        violations = hook.validate_yaml(content, schema, "decisions")
        assert any("not in ascending order" in v for v in violations)

    def test_blank_decision_entry_fails_required_fields(self, hook):
        schema = hook.load_schema("decisions")
        content = yaml_dump({
            "decisions": [
                {
                    "number": 41,
                    "date": "2026-05-05",
                    "question": "",
                    "context": "",
                    "choice": "",
                    "reasoning": "",
                    "confidence": "",
                    "alternatives": [],
                }
            ]
        })
        violations = hook.validate_yaml(content, schema, "decisions")
        assert any("empty required field 'decisions[0].question'" in v for v in violations)
        assert any("empty required field 'decisions[0].context'" in v for v in violations)
        assert any("decisions[0].alternatives" in v for v in violations)


class TestValidateYamlVision:
    def test_valid_vision(self, hook):
        schema = hook.load_schema("vision")
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
        violations = hook.validate_yaml(content, schema, "vision")
        assert violations == []

    def test_missing_identity_field(self, hook):
        schema = hook.load_schema("vision")
        content = yaml_dump({
            "header": {"project_name": "Test"},
            "north_star": {"content": "Be the best"},
            "personas": [{"name": "Dev", "description": "A developer"}],
            "principles": [{"name": "Simplicity", "description": "Keep it simple"}],
            "direction": {"content": "Forward"},
            "identity": {"personality": "Friendly"},
            "tension": {"content": "Speed vs quality"},
        })
        violations = hook.validate_yaml(content, schema, "vision")
        assert any("missing required field" in v for v in violations)


class TestValidateYamlHealth:
    def test_valid_health(self, hook):
        schema = hook.load_schema("health")
        content = yaml_dump({
            "finding": {
                "heading": "Complex coupling",
                "location": "src/main.py:42",
                "evidence": "Circular import detected",
                "impact": "Build failures",
                "suggested_action": "Decouple modules",
                "severity": "warning",
                "confidence": 85,
            }
        })
        violations = hook.validate_yaml(content, schema, "health")
        assert violations == []

    def test_missing_required_field(self, hook):
        schema = hook.load_schema("health")
        content = yaml_dump({
            "finding": {
                "heading": "Complex coupling",
                "location": "src/main.py:42",
            }
        })
        violations = hook.validate_yaml(content, schema, "health")
        assert any("missing required field" in v for v in violations)


class TestValidateYamlSession:
    def test_valid_session(self, hook):
        schema = hook.load_schema("session")
        content = yaml_dump({
            "bookmarks": [
                {"timestamp": "2026-05-04 10:00", "artifacts": ["PROGRESS"]}
            ]
        })
        violations = hook.validate_yaml(content, schema, "session")
        assert violations == []

    def test_invalid_yaml_fails(self, hook):
        schema = hook.load_schema("session")
        violations = hook.validate_yaml("{{{\n  broken", schema, "session")
        assert any("invalid YAML" in v for v in violations)


class TestValidateYamlDocs:
    def test_valid_docs(self, hook):
        schema = hook.load_schema("docs")
        content = yaml_dump({
            "header": {"last_audit": "2026-05-04 (test)"},
            "conventions": {
                "doc_root": ".",
                "style": "technical",
                "auto_gen": ["none"],
                "version_files": ["package.json"],
                "semver_policy": {"feat": "minor", "fix": "patch"},
            },
            "coverage": {
                "documented": "1/1",
                "undocumented": "0",
                "stale": "none",
                "tests": "10 tests",
            },
        })
        violations = hook.validate_yaml(content, schema, "docs")
        assert violations == []

    def test_missing_required_field(self, hook):
        schema = hook.load_schema("docs")
        content = yaml_dump({
            "header": {"last_audit": "2026-05-04 (test)"},
            "conventions": {
                "doc_root": ".",
                "style": "technical",
            },
        })
        violations = hook.validate_yaml(content, schema, "docs")
        assert any("missing required field" in v for v in violations)


class TestValidateYamlExperiments:
    def test_valid_experiments(self, hook):
        schema = hook.load_schema("experiments")
        content = yaml_dump({
            "experiments": [
                {
                    "number": 0,
                    "date": "2026-05-04 10:00",
                    "label": "baseline",
                    "hypothesis": "Establish baseline",
                    "method": "Run default config",
                    "change": "None",
                    "metric": {"primary_value": "100", "delta_vs_baseline": "n/a"},
                    "status": "baseline",
                    "conclusion": "Baseline established",
                }
            ]
        })
        violations = hook.validate_yaml(content, schema, "experiments")
        assert violations == []

    def test_non_mapping_root(self, hook):
        schema = hook.load_schema("experiments")
        violations = hook.validate_yaml("[1, 2, 3]", schema, "experiments")
        assert any("root must be a mapping" in v for v in violations)


class TestValidateYamlObjective:
    def test_valid_objective(self, hook):
        schema = hook.load_schema("objective")
        content = yaml_dump({
            "header": {"title": "Reduce latency", "status": "open"},
            "objective": {
                "description": "Reduce p99 latency by 20%",
                "why": "Users experience slowness",
                "measurement": "Benchmark harness",
            },
            "metric": {
                "description": "p99 latency in ms",
                "direction": "lower",
                "unit": "ms",
            },
            "baseline": {"description": "Current p99 is 500ms"},
            "scope": {
                "included": ["src/api/"],
                "excluded": ["vendor/"],
            },
        })
        violations = hook.validate_yaml(content, schema, "objective")
        assert violations == []

    def test_missing_required_field(self, hook):
        schema = hook.load_schema("objective")
        content = yaml_dump({
            "header": {"title": "Reduce latency", "status": "open"},
            "objective": {
                "description": "Reduce p99 latency by 20%",
                "measurement": "Benchmark harness",
            },
        })
        violations = hook.validate_yaml(content, schema, "objective")
        assert any("missing required field" in v for v in violations)


class TestWordBudget:
    def test_within_budget(self, hook):
        schema = hook.load_schema("vision")
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
        violations = hook.validate_yaml(content, schema, "vision")
        assert not any("budget" in v for v in violations)

    def test_advisory_budget_does_not_block(self, hook):
        schema = hook.load_schema("health")
        padding = " ".join(["word"] * 3000)
        content = yaml_dump({"header": {"last_audit": "2026-05-04 (test)"},
                             "data": padding})
        violations = hook.validate_yaml(content, schema, "health")
        assert not any("budget" in v for v in violations)

    def test_error_budget_blocks(self, hook):
        schema = {
            "BUDGET": {
                1: {"scope": "full_file", "max_words": 1},
            },
            "VALIDATION": {
                1: {"rule": "word_budget", "severity": "error"},
            },
        }
        violations = hook.validate_yaml("field: too many words\n", schema, "test")
        assert any("budget" in v for v in violations)


# ── Markdown validation ────────────────────────────────────────────


class TestValidateMarkdown:
    def test_valid_md(self, hook):
        assert hook.validate_markdown("# TODO\n\n- [ ] item\n", "TODO.md") == []

    def test_empty_content(self, hook):
        assert any("empty" in v for v in hook.validate_markdown("  \n", "TODO.md"))

    def test_unclosed_fence(self, hook):
        assert any("code fence" in v for v in hook.validate_markdown("# T\n```\ncode\n", "TODO.md"))


# ── Schema loading ─────────────────────────────────────────────────


class TestSchemaLoading:
    def test_known_schema(self, hook):
        assert hook.ArtifactSchemaValidator().load_schema("progress") is not None

    def test_unknown_schema(self, hook):
        assert hook.ArtifactSchemaValidator().load_schema("nonexistent_xyz") is None


class TestHookCliAdapter:
    def test_run_reports_validation_violations(self, hook, project_dir):
        artifact = project_dir / ".agentera" / "session.yaml"
        artifact.write_text("{{{\n  broken yaml")
        payload = json.dumps({
            "tool_name": "Write",
            "tool_input": {"file_path": str(artifact)},
            "cwd": str(project_dir),
        })

        rc, violations = hook.HookCliAdapter().run(payload)

        assert rc == 2
        assert any("invalid YAML" in violation for violation in violations)


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
