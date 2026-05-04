"""Tests for hooks/validate_artifact.py v2 (schema-based validation).

1 pass + 1 fail per artifact type, edge cases for each adapter format.
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
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load {mod_path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["validate_artifact"] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def project_dir(tmp_path):
    (tmp_path / ".agentera").mkdir()
    return tmp_path


def _run_hook(hook, monkeypatch, hook_input: dict) -> tuple[int, str]:
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(hook_input)))
    out = io.StringIO()
    monkeypatch.setattr("sys.stdout", out)
    rc = hook.main()
    return rc, out.getvalue()


# ---------------------------------------------------------------------------
# Schema loading
# ---------------------------------------------------------------------------


class TestSchemaLoading:
    def test_schemas_loaded(self, hook):
        schemas = hook.load_schemas()
        assert "HEALTH.md" in schemas
        assert "DECISIONS.md" in schemas
        assert "PLAN.md" in schemas
        assert "TODO.md" in schemas

    def test_schema_has_required_keys(self, hook):
        schemas = hook.load_schemas()
        for name, schema in schemas.items():
            assert "artifact" in schema
            assert schema["artifact"] == name


# ---------------------------------------------------------------------------
# _identify_artifact
# ---------------------------------------------------------------------------


class TestIdentifyArtifact:
    def test_agent_facing(self, hook, project_dir):
        health = project_dir / ".agentera" / "HEALTH.md"
        result = hook._identify_artifact(str(health), str(project_dir))
        assert result == "HEALTH.md"

    def test_human_facing(self, hook, project_dir):
        todo = project_dir / "TODO.md"
        result = hook._identify_artifact(str(todo), str(project_dir))
        assert result == "TODO.md"

    def test_per_objective(self, hook, project_dir):
        obj = project_dir / ".agentera" / "optimera" / "latency" / "OBJECTIVE.md"
        result = hook._identify_artifact(str(obj), str(project_dir))
        assert result == "OBJECTIVE.md"

    def test_unknown_file(self, hook, project_dir):
        readme = project_dir / "README.md"
        result = hook._identify_artifact(str(readme), str(project_dir))
        assert result is None


# ---------------------------------------------------------------------------
# Agent-facing artifacts: pass + fail per type
# ---------------------------------------------------------------------------


class TestHealthValidation:
    def test_pass(self, hook):
        content = "# Health\n\n## Audit 1\n\nAll clear.\n"
        violations = hook.validate_content(content, "HEALTH.md")
        assert violations == []

    def test_fail_missing_audit(self, hook):
        content = "# Health\n\nNo audits here.\n"
        violations = hook.validate_content(content, "HEALTH.md")
        assert any("Audit" in v for v in violations)


class TestProgressValidation:
    def test_pass(self, hook):
        content = "# Progress\n\n## Cycle 1\n\nDid work.\n"
        violations = hook.validate_content(content, "PROGRESS.md")
        assert violations == []

    def test_fail_missing_cycle(self, hook):
        content = "# Progress\n\nNo cycles.\n"
        violations = hook.validate_content(content, "PROGRESS.md")
        assert any("Cycle" in v for v in violations)


class TestPlanValidation:
    def test_pass(self, hook):
        content = "# Plan\n\n## Tasks\n\n### Task 1\n**Status**: open\n"
        violations = hook.validate_content(content, "PLAN.md")
        assert violations == []

    def test_fail_missing_tasks(self, hook):
        content = "# Plan\n\nNo tasks.\n"
        violations = hook.validate_content(content, "PLAN.md")
        assert any("Task" in v for v in violations)


class TestDecisionsValidation:
    def test_pass(self, hook):
        content = "# Decisions\n\n## Decision 1\n\nChoice A.\n"
        violations = hook.validate_content(content, "DECISIONS.md")
        assert violations == []

    def test_fail_missing_heading(self, hook):
        content = "# Notes\n\nNot decisions.\n"
        violations = hook.validate_content(content, "DECISIONS.md")
        assert any("Decisions" in v for v in violations)

    def test_fail_out_of_order(self, hook):
        content = "# Decisions\n\n## Decision 2\n\nB.\n\n## Decision 1\n\nA.\n"
        violations = hook.validate_content(content, "DECISIONS.md")
        assert any("ascending" in v for v in violations)

    def test_fail_duplicate(self, hook):
        content = "# Decisions\n\n## Decision 1\n\nA.\n\n## Decision 1\n\nB.\n"
        violations = hook.validate_content(content, "DECISIONS.md")
        assert any("duplicate" in v for v in violations)


class TestObjectiveValidation:
    def test_pass(self, hook):
        content = (
            "# Objective\n\n**Status**: active\n\n"
            "## Metric\nLatency.\n\n## Target\n< 100ms.\n\n"
            "## Baseline\n200ms.\n\n## Constraints\nNone.\n"
        )
        violations = hook.validate_content(content, "OBJECTIVE.md")
        assert violations == []

    def test_fail_missing_target(self, hook):
        content = "# Objective\n\n**Status**: active\n\n## Metric\nLatency.\n"
        violations = hook.validate_content(content, "OBJECTIVE.md")
        assert any("Target" in v for v in violations)


class TestExperimentsValidation:
    def test_pass(self, hook):
        content = "# Experiments\n\n## Experiment 1\n\nResult.\n"
        violations = hook.validate_content(content, "EXPERIMENTS.md")
        assert violations == []

    def test_fail_missing_experiment(self, hook):
        content = "# Experiments\n\nNone yet.\n"
        violations = hook.validate_content(content, "EXPERIMENTS.md")
        assert any("Experiment" in v for v in violations)


# ---------------------------------------------------------------------------
# Human-facing artifacts: pass + fail
# ---------------------------------------------------------------------------


class TestTodoValidation:
    def test_pass(self, hook):
        content = (
            "# TODO\n\n"
            "## \u21f6 Critical\n- [ ] ISS-1\n\n"
            "## \u21c9 Degraded\n- [ ] ISS-2\n\n"
            "## \u2192 Normal\n- [ ] ISS-3\n\n"
            "## \u21e2 Annoying\n- [ ] ISS-4\n"
        )
        violations = hook.validate_content(content, "TODO.md")
        assert violations == []

    def test_fail_missing_severity(self, hook):
        content = "# TODO\n\n## \u21f6 Critical\n- [ ] ISS-1\n"
        violations = hook.validate_content(content, "TODO.md")
        assert any("severity" in v for v in violations)


class TestChangelogValidation:
    def test_pass(self, hook):
        content = "# Changelog\n\n## v1.0\n\n- Feature.\n"
        violations = hook.validate_content(content, "CHANGELOG.md")
        assert violations == []

    def test_fail_unclosed_fence(self, hook):
        content = "# Changelog\n\n```\nunclosed\n"
        violations = hook.validate_content(content, "CHANGELOG.md")
        assert any("code fence" in v for v in violations)


class TestDesignValidation:
    def test_pass(self, hook):
        content = "# Design\n\nSome design tokens.\n"
        violations = hook.validate_content(content, "DESIGN.md")
        assert violations == []

    def test_fail_unclosed_fence(self, hook):
        content = "# Design\n\n```\nunclosed\n"
        violations = hook.validate_content(content, "DESIGN.md")
        assert any("code fence" in v for v in violations)


# ---------------------------------------------------------------------------
# Markdown well-formedness (shared)
# ---------------------------------------------------------------------------


class TestMarkdownWellFormedness:
    def test_balanced_fences_pass(self, hook):
        content = "# Health\n\n## Audit 1\n\n```\ncode\n```\n"
        violations = hook.validate_content(content, "HEALTH.md")
        assert not any("code fence" in v for v in violations)

    def test_unclosed_fence_fail(self, hook):
        content = "# Health\n\n## Audit 1\n\n```\ncode\n"
        violations = hook.validate_content(content, "HEALTH.md")
        assert any("code fence" in v for v in violations)


# ---------------------------------------------------------------------------
# Token budget
# ---------------------------------------------------------------------------


class TestTokenBudget:
    def test_within_budget(self, hook):
        content = "# Health\n\n## Audit 1\n\n" + "word " * 100 + "\n"
        violations = hook.validate_content(content, "HEALTH.md")
        assert not any("budget" in v for v in violations)

    def test_exceeds_budget(self, hook):
        content = "# Health\n\n## Audit 1\n\n" + "word " * 3000 + "\n"
        violations = hook.validate_content(content, "HEALTH.md")
        assert any("budget" in v for v in violations)


# ---------------------------------------------------------------------------
# Adapter formats: Claude Code
# ---------------------------------------------------------------------------


class TestClaudeCodeAdapter:
    def test_artifact_violation(self, hook, project_dir, monkeypatch):
        health = project_dir / ".agentera" / "HEALTH.md"
        health.write_text("# Health\n\nNo audits.\n", encoding="utf-8")
        rc, out = _run_hook(hook, monkeypatch, {
            "cwd": str(project_dir),
            "tool_name": "Write",
            "tool_input": {"file_path": str(health)},
        })
        assert rc == 0
        assert "validation warnings" in out.lower()

    def test_non_artifact_clean(self, hook, project_dir, monkeypatch):
        readme = project_dir / "README.md"
        readme.write_text("# Hello\n", encoding="utf-8")
        rc, out = _run_hook(hook, monkeypatch, {
            "cwd": str(project_dir),
            "tool_name": "Write",
            "tool_input": {"file_path": str(readme)},
        })
        assert rc == 0
        assert out == ""


# ---------------------------------------------------------------------------
# Adapter formats: OpenCode
# ---------------------------------------------------------------------------


class TestOpenCodeAdapter:
    def test_valid_artifact(self, hook, project_dir, monkeypatch):
        content = "# Health\n\n## Audit 1\n\nClear.\n"
        rc, out = _run_hook(hook, monkeypatch, {
            "cwd": str(project_dir),
            "tool": {"name": "Write"},
            "input": {"path": str(project_dir / ".agentera" / "HEALTH.md"), "content": content},
        })
        assert rc == 0
        assert out == ""

    def test_invalid_artifact(self, hook, project_dir, monkeypatch):
        content = "# Health\n\nNo audits.\n"
        rc, out = _run_hook(hook, monkeypatch, {
            "cwd": str(project_dir),
            "tool": {"name": "Write"},
            "input": {"path": str(project_dir / ".agentera" / "HEALTH.md"), "content": content},
        })
        assert rc == 0
        assert "Audit" in out


# ---------------------------------------------------------------------------
# Adapter formats: Codex apply_patch
# ---------------------------------------------------------------------------


class TestCodexAdapter:
    def test_patch_with_artifact(self, hook, project_dir, monkeypatch):
        health = project_dir / ".agentera" / "HEALTH.md"
        health.write_text("# Health\n\nNo audits.\n", encoding="utf-8")
        patch = "*** Update File: .agentera/HEALTH.md\n@@\n-old\n+new\n"
        rc, out = _run_hook(hook, monkeypatch, {
            "cwd": str(project_dir),
            "tool_name": "apply_patch",
            "tool_input": {"command": patch},
        })
        assert rc == 0
        assert "HEALTH.md" in out

    def test_patch_no_artifact_paths(self, hook, project_dir, monkeypatch):
        rc, out = _run_hook(hook, monkeypatch, {
            "cwd": str(project_dir),
            "tool_name": "apply_patch",
            "tool_input": {"command": "not a valid patch"},
        })
        assert rc == 0
        assert out == ""


# ---------------------------------------------------------------------------
# Adapter formats: Copilot
# ---------------------------------------------------------------------------


class TestCopilotAdapter:
    def test_artifact_violation(self, hook, project_dir, monkeypatch):
        content = "# Health\n\nNo audits.\n"
        rc, out = _run_hook(hook, monkeypatch, {
            "cwd": str(project_dir),
            "tool_name": "create",
            "input": {
                "filePath": str(project_dir / ".agentera" / "HEALTH.md"),
                "content": content,
            },
        })
        assert rc == 0
        assert "Audit" in out

    def test_non_artifact_clean(self, hook, project_dir, monkeypatch):
        rc, out = _run_hook(hook, monkeypatch, {
            "cwd": str(project_dir),
            "tool_name": "create",
            "input": {"filePath": str(project_dir / "src/app.py"), "content": "pass"},
        })
        assert rc == 0
        assert out == ""


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


class TestEdgeCases:
    def test_empty_stdin(self, hook, monkeypatch):
        monkeypatch.setattr("sys.stdin", io.StringIO(""))
        rc = hook.main()
        assert rc == 0

    def test_malformed_json(self, hook, monkeypatch):
        monkeypatch.setattr("sys.stdin", io.StringIO("{bad"))
        rc = hook.main()
        assert rc == 0

    def test_json_array(self, hook, monkeypatch):
        monkeypatch.setattr("sys.stdin", io.StringIO("[]"))
        rc = hook.main()
        assert rc == 0

    def test_fail_open_guard(self, tmp_path):
        hook_script = str(REPO_ROOT / "hooks" / "validate_artifact.py")
        result = subprocess.run(
            [sys.executable, hook_script],
            input="[]",
            capture_output=True,
            text=True,
            cwd=str(tmp_path),
        )
        assert result.returncode == 0

    def test_unknown_artifact_no_schema(self, hook):
        violations = hook.validate_content("some content\n", "UNKNOWN.md")
        assert any("code fence" not in v for v in violations) or violations == []

    def test_file_read_fallback(self, hook, project_dir, monkeypatch):
        health = project_dir / ".agentera" / "HEALTH.md"
        health.write_text("# Health\n\nNo audits.\n", encoding="utf-8")
        rc, out = _run_hook(hook, monkeypatch, {
            "cwd": str(project_dir),
            "tool_name": "Edit",
            "tool_input": {"file_path": str(health)},
        })
        assert rc == 0
        assert "validation warnings" in out.lower()
