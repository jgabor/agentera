"""Tests for scripts/agentera CLI (query and prime commands).

Proportionality: 1 pass + 1 fail per state command (last-phase, decisions,
health, todo) plus prime command. Edge cases for empty artifacts,
missing artifacts, and filter-no-match.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
CLI = str(REPO_ROOT / "scripts" / "agentera")
SCHEMAS_SRC = REPO_ROOT / "skills" / "agentera" / "schemas" / "artifacts"


def _run(*args: str, cwd: Path | None = None) -> subprocess.CompletedProcess:
    env = None
    if cwd is not None:
        import os
        env = {**os.environ, "AGENTERA_HOME": str(cwd)}
    return subprocess.run(
        [sys.executable, CLI, *args],
        capture_output=True,
        text=True,
        cwd=cwd,
        env=env,
    )


@pytest.fixture()
def project(tmp_path: Path):
    dst = tmp_path / "skills" / "agentera" / "schemas" / "artifacts"
    dst.mkdir(parents=True, exist_ok=True)
    for f in SCHEMAS_SRC.glob("*.yaml"):
        (dst / f.name).write_text(f.read_text())
    return tmp_path


def _write_artifact(project: Path, rel: str, data: dict) -> Path:
    p = project / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(yaml.dump(data, default_flow_style=False))
    return p


def _write_fixture_artifact(project: Path, fixture: dict) -> Path:
    rel = fixture["path"].replace("<name>", "test-objective")
    return _write_artifact(project, rel, fixture["data"])


# ---------------------------------------------------------------------------
# prime
# ---------------------------------------------------------------------------


class TestPrime:
    def test_pass_outputs_guidance(self):
        r = _run("prime")
        assert r.returncode == 0
        assert "agentera plan" in r.stdout
        assert "native" in r.stdout.lower()

    def test_prime_idempotent(self):
        assert _run("prime").stdout == _run("prime").stdout

    def test_prime_has_routing_and_recovery(self):
        r = _run("prime")
        assert "recovery" in r.stdout.lower()
        assert "stale" in r.stdout.lower()
        assert "missing" in r.stdout.lower()

    def test_prime_no_args(self):
        r = _run("prime")
        assert r.returncode == 0
        assert len(r.stdout) > 100


# ---------------------------------------------------------------------------
# last-phase
# ---------------------------------------------------------------------------


class TestLastPhase:
    def test_pass_returns_phase(self, project):
        _write_artifact(project, ".agentera/progress.yaml", {
            "cycles": [
                {"number": 1, "phase": "build", "what": "first", "commit": "a"},
                {"number": 2, "phase": "audit", "what": "second", "commit": "b"},
            ],
        })
        r = _run("query", "last-phase", cwd=project)
        assert r.returncode == 0
        assert "audit" in r.stdout

    def test_fail_missing_artifact(self, project):
        r = _run("query", "last-phase", cwd=project)
        assert r.returncode == 0
        assert r.stdout.strip() == ""

    def test_empty_artifact(self, project):
        _write_artifact(project, ".agentera/progress.yaml", {})
        r = _run("query", "last-phase", cwd=project)
        assert r.returncode == 0
        assert r.stdout.strip() == ""


# ---------------------------------------------------------------------------
# decisions
# ---------------------------------------------------------------------------


class TestDecisions:
    def test_pass_returns_decisions(self, project):
        _write_artifact(project, ".agentera/decisions.yaml", {
            "decisions": [
                {
                    "number": 1,
                    "question": "Runtime support?",
                    "choice": "Python",
                    "confidence": "firm",
                    "context": "Need runtime",
                    "reasoning": "Stdlib",
                },
            ],
        })
        r = _run("decisions", cwd=project)
        assert r.returncode == 0
        assert "number=1" in r.stdout
        assert "firm" in r.stdout

    def test_fail_missing_artifact(self, project):
        r = _run("decisions", cwd=project)
        assert r.returncode == 0
        assert r.stdout.strip() == ""

    def test_filter_topic_match(self, project):
        _write_artifact(project, ".agentera/decisions.yaml", {
            "decisions": [
                {
                    "number": 1,
                    "question": "Runtime support?",
                    "choice": "Python",
                    "confidence": "firm",
                    "context": "Need runtime support",
                    "reasoning": "Stdlib",
                },
                {
                    "number": 2,
                    "question": "Color scheme?",
                    "choice": "Blue",
                    "confidence": "provisional",
                    "context": "Design",
                    "reasoning": "Looks nice",
                },
            ],
        })
        r = _run("decisions", "--topic", "runtime", cwd=project)
        assert r.returncode == 0
        assert "number=1" in r.stdout
        assert "number=2" not in r.stdout

    def test_filter_topic_no_match(self, project):
        _write_artifact(project, ".agentera/decisions.yaml", {
            "decisions": [
                {
                    "number": 1,
                    "question": "Runtime?",
                    "choice": "Python",
                    "confidence": "firm",
                    "context": "Engine",
                    "reasoning": "Stdlib",
                },
            ],
        })
        r = _run("decisions", "--topic", "nonexistent", cwd=project)
        assert r.returncode == 0
        assert r.stdout.strip() == ""


# ---------------------------------------------------------------------------
# health
# ---------------------------------------------------------------------------


class TestHealth:
    def test_pass_returns_health(self, project):
        _write_artifact(project, ".agentera/health.yaml", {
            "audits": [
                {
                    "number": 1,
                    "date": "2026-05-01",
                    "trajectory": "stable",
                    "grades": {
                        "architecture_alignment": "B",
                        "coupling_health": "C",
                    },
                    "dimensions": ["architecture_alignment", "coupling_health"],
                },
            ],
        })
        r = _run("health", cwd=project)
        assert r.returncode == 0
        assert "stable" in r.stdout
        assert "coupling" in r.stdout

    def test_fail_missing_artifact(self, project):
        r = _run("health", cwd=project)
        assert r.returncode == 0
        assert r.stdout.strip() == ""

    def test_filter_dimension_match(self, project):
        _write_artifact(project, ".agentera/health.yaml", {
            "audits": [
                {
                    "number": 1,
                    "date": "2026-05-01",
                    "trajectory": "stable",
                    "grades": {
                        "architecture_alignment": "B",
                        "coupling_health": "C",
                    },
                    "dimensions": ["architecture_alignment", "coupling_health"],
                    "dimensions_detail": [
                        {
                            "name": "coupling_health",
                            "grade": "C",
                            "summary": "Tight coupling in hooks",
                            "findings": [
                                {
                                    "heading": "Hooks import common",
                                    "severity": "warning",
                                },
                            ],
                        },
                    ],
                },
            ],
        })
        r = _run("health", "--dimension", "coupling", cwd=project)
        assert r.returncode == 0
        assert "coupling" in r.stdout

    def test_filter_dimension_no_match(self, project):
        _write_artifact(project, ".agentera/health.yaml", {
            "audits": [
                {
                    "number": 1,
                    "grades": {"architecture_alignment": "B"},
                },
            ],
        })
        r = _run("health", "--dimension", "nonexistent", cwd=project)
        assert r.returncode == 0
        assert r.stdout.strip() == ""


# ---------------------------------------------------------------------------
# todo
# ---------------------------------------------------------------------------


class TestTodo:
    def test_pass_returns_todos(self, project):
        (project / "TODO.md").write_text(
            "# TODO\n\n"
            "## \u21f6 Critical\n\n"
            "- [ ] Fix the broken build\n\n"
            "## \u2192 Normal\n\n"
            "- [ ] Add more tests\n\n"
            "## Resolved\n\n"
            "- [x] Done\n"
        )
        r = _run("todo", cwd=project)
        assert r.returncode == 0
        assert "broken build" in r.stdout
        assert "more tests" in r.stdout

    def test_fail_missing_todo(self, project):
        r = _run("todo", cwd=project)
        assert r.returncode == 0
        assert r.stdout.strip() == ""

    def test_filter_severity_critical(self, project):
        (project / "TODO.md").write_text(
            "# TODO\n\n"
            "## \u21f6 Critical\n\n"
            "- [ ] Fix the broken build\n\n"
            "## \u2192 Normal\n\n"
            "- [ ] Add more tests\n\n"
            "## Resolved\n\n"
            "- [x] Done\n"
        )
        r = _run("todo", "--severity", "critical", cwd=project)
        assert r.returncode == 0
        assert "broken build" in r.stdout
        assert "more tests" not in r.stdout

    def test_filter_severity_no_match(self, project):
        (project / "TODO.md").write_text(
            "# TODO\n\n"
            "## \u2192 Normal\n\n"
            "- [ ] Add more tests\n\n"
            "## Resolved\n\n"
            "- [x] Done\n"
        )
        r = _run("todo", "--severity", "critical", cwd=project)
        assert r.returncode == 0
        assert r.stdout.strip() == ""


# ---------------------------------------------------------------------------
# generic query (schema auto-discovery)
# ---------------------------------------------------------------------------


class TestGenericQuery:
    def test_auto_discovered_artifact(self, project):
        _write_artifact(project, ".agentera/session.yaml", {
            "bookmarks": [
                {
                    "timestamp": "2026-05-01 10:00",
                    "artifacts": ["PROGRESS"],
                    "summary": "Updated progress",
                },
            ],
        })
        r = _run("query", "session", cwd=project)
        assert r.returncode == 0
        assert r.stdout.strip() != ""

    def test_new_schema_auto_supported(self, project):
        schemas_dir = project / "skills" / "agentera" / "schemas" / "artifacts"
        (schemas_dir / "custom_thing.yaml").write_text(yaml.dump({
            "meta": {
                "name": "custom_thing",
                "version": "1.0.0",
                "description": "A custom artifact",
                "path": ".agentera/custom_thing.yaml",
            },
            "ENTRY": {
                "1": {
                    "id": "CT1",
                    "field": "title",
                    "type": "string",
                    "required": True,
                },
                "2": {
                    "id": "CT2",
                    "field": "status",
                    "type": "string",
                    "required": True,
                },
            },
        }))
        _write_artifact(project, ".agentera/custom_thing.yaml", {
            "entries": [
                {"title": "My thing", "status": "active"},
            ],
        })
        r = _run("query", "custom_thing", cwd=project)
        assert r.returncode == 0
        assert "active" in r.stdout


# ---------------------------------------------------------------------------
# artifact-specific summaries
# ---------------------------------------------------------------------------


class TestArtifactSpecificSummaries:
    def test_plan_summary_uses_docs_mapping_override(self, project):
        _write_artifact(project, ".agentera/docs.yaml", {
            "mapping": [
                {
                    "artifact": "PLAN.md",
                    "path": "custom/state/plan.yaml",
                },
            ],
        })
        _write_artifact(project, "custom/state/plan.yaml", {
            "header": {
                "title": "Mapped plan",
                "status": "active",
                "created": "2026-05-05",
            },
            "what": "Use the mapped path.",
            "tasks": [
                {"number": 1, "name": "Done", "status": "complete"},
                {"number": 2, "name": "Next", "status": "pending"},
            ],
        })
        r = _run("plan", cwd=project)
        assert r.returncode == 0
        assert "title=Mapped plan" in r.stdout
        assert "complete=1" in r.stdout
        assert "pending=1" in r.stdout

    def test_progress_summary_surfaces_verification_and_next(self, project):
        _write_artifact(project, ".agentera/progress.yaml", {
            "cycles": [
                {
                    "number": 7,
                    "timestamp": "2026-05-05 12:00",
                    "type": "fix",
                    "phase": "verify",
                    "what": "Closed the query gap.",
                    "verified": "pytest query passed",
                    "next": "Remeasure tokens",
                },
            ],
        })
        r = _run("progress", cwd=project)
        assert r.returncode == 0
        assert "phase=verify" in r.stdout
        assert "verified: pytest query passed" in r.stdout
        assert "next: Remeasure tokens" in r.stdout

    def test_progress_summary_uses_newest_cycle_first(self, project):
        _write_artifact(project, ".agentera/progress.yaml", {
            "cycles": [
                {
                    "number": 9,
                    "timestamp": "2026-05-05 12:00",
                    "type": "feat",
                    "phase": "verify",
                    "what": "Newest work",
                },
                {
                    "number": 8,
                    "timestamp": "2026-05-05 11:00",
                    "type": "fix",
                    "phase": "build",
                    "what": "Older work",
                },
            ],
        })
        r = _run("progress", "--limit", "1", cwd=project)
        assert r.returncode == 0
        assert "number=9" in r.stdout
        assert "Newest work" in r.stdout
        assert "number=8" not in r.stdout

    def test_docs_summary_filters_status(self, project):
        _write_artifact(project, ".agentera/docs.yaml", {
            "last_audit": "2026-05-05 (test)",
            "mapping": [],
            "index": [
                {
                    "document": "README",
                    "path": "README.md",
                    "last_updated": "2026-05-05",
                    "status": "current",
                },
                {
                    "document": "Old notes",
                    "path": "docs/old.md",
                    "last_updated": "2026-01-01",
                    "status": "stale",
                },
            ],
        })
        r = _run("docs", "--status", "stale", cwd=project)
        assert r.returncode == 0
        assert "Docs: last_audit=2026-05-05 (test)" in r.stdout
        assert "document=Old notes" in r.stdout
        assert "README" not in r.stdout

    def test_objective_and_experiments_use_active_objective(self, project):
        objective_dir = project / ".agentera" / "optimera" / "token-budget"
        objective_dir.mkdir(parents=True)
        (objective_dir / "objective.yaml").write_text(yaml.dump({
            "header": {
                "title": "Token budget",
                "status": "active",
            },
            "objective": {
                "description": "Reduce fixed prompt tokens.",
                "target": "20% reduction",
                "measurement": "count_tokens",
            },
        }))
        (objective_dir / "experiments.yaml").write_text(yaml.dump({
            "experiments": [
                {
                    "number": 1,
                    "date": "2026-05-05",
                    "label": "query seam",
                    "status": "kept",
                    "metric": {
                        "primary_value": "12000",
                        "delta_vs_baseline": "-11%",
                    },
                },
            ],
        }))

        objective = _run("objective", cwd=project)
        experiments = _run("experiments", cwd=project)

        assert objective.returncode == 0
        assert "title=Token budget" in objective.stdout
        assert "target: 20% reduction" in objective.stdout
        assert experiments.returncode == 0
        assert "number=1" in experiments.stdout
        assert "metric: primary_value=12000" in experiments.stdout


# ---------------------------------------------------------------------------
# help
# ---------------------------------------------------------------------------


class TestHelp:
    def test_help_lists_commands(self):
        r = _run("--help")
        assert r.returncode == 0
        assert "prime" in r.stdout
        assert "query" in r.stdout
        assert "plan" in r.stdout
        assert "progress" in r.stdout
        assert "health" in r.stdout
        assert "decisions" in r.stdout
        assert "docs" in r.stdout
        assert "objective" in r.stdout
        assert "experiments" in r.stdout

    def test_query_help_lists_filters(self):
        r = _run("query", "--help")
        assert r.returncode == 0
        assert "topic" in r.stdout
        assert "severity" in r.stdout
        assert "dimension" in r.stdout

    @pytest.mark.parametrize("routine", ["plan", "progress"])
    def test_query_routine_commands_are_not_compatibility_forms(self, project, routine):
        _write_artifact(project, ".agentera/plan.yaml", {
            "header": {"title": "Mapped plan", "status": "active"},
            "tasks": [],
        })
        _write_artifact(project, ".agentera/progress.yaml", {
            "cycles": [{"number": 1, "phase": "build", "what": "test"}],
        })
        r = _run("query", routine, cwd=project)
        assert r.returncode == 1
        assert f"Use `agentera {routine}`" in r.stderr


# ---------------------------------------------------------------------------
# artifact type coverage (1 test per type + --list-artifacts)
# ---------------------------------------------------------------------------

STATE_COMMAND_NAMES = {
    "decisions",
    "docs",
    "experiments",
    "health",
    "objective",
    "plan",
    "progress",
    "todo",
}


ARTIFACT_FIXTURES = {
    "changelog": {
        "path": "CHANGELOG.md",
        "data": {
            "entries": [
                {"version": "2.0.0", "date": "2026-05-04", "changes": ["Release v2.0.0"]},
            ],
        },
        "expected": "version=2.0.0",
    },
    "decisions": {
        "path": ".agentera/decisions.yaml",
        "data": {
            "decisions": [
                {"number": 1, "question": "Language?", "choice": "Python", "confidence": "firm"},
            ],
        },
        "expected": "number=1",
    },
    "design": {
        "path": "DESIGN.md",
        "data": {
            "entries": [
                {"category": "palette", "name": "primary", "value": "#111827"},
            ],
        },
        "expected": "category=palette",
    },
    "docs": {
        "path": ".agentera/docs.yaml",
        "data": {
            "entries": [
                {"last_audit": "2026-05-01", "status": "current"},
            ],
        },
        "expected": "status=current",
    },
    "experiments": {
        "path": ".agentera/optimera/<name>/experiments.yaml",
        "data": {
            "experiments": [
                {"number": 1, "label": "exp1", "status": "kept"},
            ],
        },
        "expected": "number=1",
    },
    "health": {
        "path": ".agentera/health.yaml",
        "data": {
            "audits": [
                {"number": 1, "date": "2026-05-01", "trajectory": "stable"},
            ],
        },
        "expected": "stable",
    },
    "objective": {
        "path": ".agentera/optimera/<name>/objective.yaml",
        "data": {
            "entries": [
                {"title": "Test objective", "status": "active"},
            ],
        },
        "expected": "title=Test objective",
    },
    "plan": {
        "path": ".agentera/plan.yaml",
        "data": {
            "entries": [
                {"status": "active", "title": "Test plan"},
            ],
        },
        "expected": "status=active",
    },
    "progress": {
        "path": ".agentera/progress.yaml",
        "data": {
            "cycles": [
                {"number": 1, "phase": "build", "what": "test"},
            ],
        },
        "expected": "phase=build",
    },
    "session": {
        "path": ".agentera/session.yaml",
        "data": {
            "bookmarks": [
                {"timestamp": "2026-05-01", "summary": "Test session"},
            ],
        },
        "expected": "timestamp=2026-05-01",
    },
    "todo": {
        "path": "TODO.md",
        "data": {
            "entries": [
                {"severity": "critical", "description": "Fix bug", "status": "open"},
            ],
        },
        "expected": "severity=critical",
    },
    "vision": {
        "path": ".agentera/vision.yaml",
        "data": {
            "entries": [
                {"project_name": "test-project"},
            ],
        },
        "expected": "project_name=test-project",
    },
}


class TestArtifactTypeCoverage:
    @pytest.mark.parametrize(
        "artifact_name,fixture",
        [(k, v) for k, v in ARTIFACT_FIXTURES.items() if k not in STATE_COMMAND_NAMES],
        ids=[k for k in ARTIFACT_FIXTURES if k not in STATE_COMMAND_NAMES],
    )
    def test_query_by_name_returns_data(self, project, artifact_name, fixture):
        _write_fixture_artifact(project, fixture)
        r = _run("query", artifact_name, cwd=project)
        assert r.returncode == 0
        assert fixture["expected"] in r.stdout

    @pytest.mark.parametrize(
        "artifact_name,fixture",
        [(k, v) for k, v in ARTIFACT_FIXTURES.items() if k in STATE_COMMAND_NAMES],
        ids=[k for k in ARTIFACT_FIXTURES if k in STATE_COMMAND_NAMES],
    )
    def test_state_command_by_name_returns_data(self, project, artifact_name, fixture):
        _write_fixture_artifact(project, fixture)
        r = _run(artifact_name, cwd=project)
        assert r.returncode == 0
        assert fixture["expected"] in r.stdout

    def test_query_no_data_returns_clean(self, project):
        r = _run("plan", cwd=project)
        assert r.returncode == 0
        assert r.stdout.strip() == ""

    def test_list_artifacts(self, project):
        r = _run("query", "--list-artifacts", cwd=project)
        assert r.returncode == 0
        for name in ARTIFACT_FIXTURES:
            assert name in r.stdout
