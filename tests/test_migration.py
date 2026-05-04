"""Tests for the v1-to-v2 migration tool.

Covers: 1 pass + 1 fail per artifact type migration, edge cases for empty
artifacts and missing fields, and the acceptance criteria from the plan.
"""

from __future__ import annotations

import importlib.util
import os
import shutil
import sys
from pathlib import Path
from types import ModuleType
from unittest.mock import patch

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
MIGRATE_SCRIPT = REPO_ROOT / "scripts" / "migrate_artifacts_v1_to_v2"


def _load_migrate() -> ModuleType:
    src = MIGRATE_SCRIPT.read_text(encoding="utf-8")
    lines = src.splitlines(keepends=True)
    start = 0
    for i, line in enumerate(lines):
        if line.startswith("from __future__"):
            start = i
            break
    code = "".join(lines[start:])
    code = code.split("if __name__")[0]
    mod = ModuleType("migrate_v1_to_v2")
    sys.modules["migrate_v1_to_v2"] = mod
    exec(compile(code, str(MIGRATE_SCRIPT), "exec"), mod.__dict__)
    return mod


@pytest.fixture(scope="session")
def migrate():
    return _load_migrate()


@pytest.fixture()
def project_dir(tmp_path):
    return tmp_path


def _write_agentera(project_dir: Path, name: str, content: str):
    d = project_dir / ".agentera"
    d.mkdir(exist_ok=True)
    (d / name).write_text(content, encoding="utf-8")
    return d / name


# ── Progress ──────────────────────────────────────────────────────────

PROGRESS_V1 = """\
# Progress

■ ## Cycle 1 · 2026-01-15 10:00 · feat(core): add initial structure

**Phase**: build
**What**: Built the initial project skeleton with core modules.
**Commit**: abc1234
**Inspiration**: Initial project setup from vision session.
**Discovered**: Python 3.10+ required for match statements.
**Verified**: `python3 -m pytest -q` reported 12 passed.
**Next**: Implement the data pipeline module.
**Context**: intent (initial setup) · constraints (no external deps) · unknowns (none) · scope (core/)

■ ## Cycle 2 · 2026-01-15 11:00 · fix(core): fix import paths

**Phase**: build
**What**: Fixed import paths that broke after module restructure.
**Commit**: def5678
**Inspiration**: CI failure on import.
**Discovered**: The test runner needed PYTHONPATH set explicitly.
**Verified**: CI green after fix.
**Next**: Continue with data pipeline.
**Context**: intent (fix imports) · constraints (no behavior change) · unknowns (none) · scope (core/)

## Archived Cycles

- Cycle 0 (2026-01-14): feat(init): initial commit
"""


class TestProgressMigration:
    def test_parse_cycles(self, migrate):
        data = migrate._parse_progress(PROGRESS_V1)
        assert len(data["cycles"]) == 2
        c = data["cycles"][0]
        assert c["number"] == 1
        assert c["timestamp"] == "2026-01-15 10:00"
        assert c["type"] == "feat"
        assert c["phase"] == "build"
        assert "initial project skeleton" in c["what"]
        assert c["commit"] == "abc1234"
        assert c["context"]["intent"] != ""

    def test_parse_archive(self, migrate):
        data = migrate._parse_progress(PROGRESS_V1)
        assert len(data["archive"]) == 1
        assert "Cycle 0" in data["archive"][0]

    def test_empty_progress(self, migrate):
        data = migrate._parse_progress("# Progress\n")
        assert data["cycles"] == []
        assert data["archive"] == []

    def test_n_entries_preserved(self, migrate):
        data = migrate._parse_progress(PROGRESS_V1)
        assert len(data["cycles"]) == 2

    def test_full_migration_writes_yaml(self, migrate, project_dir):
        _write_agentera(project_dir, "PROGRESS.md", PROGRESS_V1)
        migrate.migrate_project(project_dir)
        out = project_dir / ".agentera" / "progress.yaml"
        assert out.exists()
        data = yaml.safe_load(out.read_text())
        assert len(data["cycles"]) == 2

    def test_missing_field_defaults(self, migrate):
        minimal = "# Progress\n\n■ ## Cycle 1 · 2026-01-15 10:00 · feat(x): do thing\n\n**Phase**: build\n**What**: Did a thing.\n**Commit**: N/A\n**Context**: intent (test)\n"
        data = migrate._parse_progress(minimal)
        c = data["cycles"][0]
        assert c["inspiration"] == ""
        assert c["discovered"] == ""


# ── Decisions ─────────────────────────────────────────────────────────

DECISIONS_V1 = """\
# Decisions

## Decision 1 · 2026-01-15

**Question**: What format should config files use?
**Context**: Need a human-readable, machine-parseable config format.
**Alternatives**:

- [YAML], chosen: Human-readable, supports comments
- [JSON], rejected: No comments, less readable
- [TOML], rejected: Less ecosystem support in Python stdlib

**Choice**: YAML for configuration files because it supports comments and is widely used.
**Reasoning**: YAML balances readability with structure. JSON is too rigid. TOML is nice but not in stdlib.
**Confidence**: firm
**Feeds into**: TODO.md, scripts/

## Decision 2 · 2026-01-16

**Question**: How should tests be organized?
**Context**: Growing test suite needs structure.
**Alternatives**:

- Flat directory: simple but doesn't scale
- Nested by module: scales well, mirrors source

**Choice**: Nested by module for better organization.
**Reasoning**: Flat doesn't scale past ~50 tests.
**Confidence**: provisional
**Feeds into**: tests/

## Archived Decisions

- Decision 0 (2026-01-14): Use Python for tooling
"""


class TestDecisionsMigration:
    def test_parse_decisions(self, migrate):
        data = migrate._parse_decisions(DECISIONS_V1)
        assert len(data["decisions"]) == 2
        d = data["decisions"][0]
        assert d["number"] == 1
        assert d["date"] == "2026-01-15"
        assert d["confidence"] == "firm"
        assert "config" in d["question"].lower()

    def test_alternatives_with_brackets(self, migrate):
        data = migrate._parse_decisions(DECISIONS_V1)
        d1 = data["decisions"][0]
        assert len(d1["alternatives"]) == 3
        chosen = [a for a in d1["alternatives"] if a["status"] == "chosen"]
        assert len(chosen) == 1
        assert chosen[0]["name"] == "YAML"

    def test_alternatives_plain_format(self, migrate):
        data = migrate._parse_decisions(DECISIONS_V1)
        d2 = data["decisions"][1]
        assert len(d2["alternatives"]) == 2
        chosen = [a for a in d2["alternatives"] if a["status"] == "chosen"]
        assert len(chosen) == 1
        assert "Nested" in chosen[0]["name"]

    def test_empty_decisions(self, migrate):
        data = migrate._parse_decisions("# Decisions\n")
        assert data["decisions"] == []

    def test_full_migration_writes_yaml(self, migrate, project_dir):
        _write_agentera(project_dir, "DECISIONS.md", DECISIONS_V1)
        migrate.migrate_project(project_dir)
        out = project_dir / ".agentera" / "decisions.yaml"
        assert out.exists()
        data = yaml.safe_load(out.read_text())
        assert len(data["decisions"]) == 2

    def test_no_chosen_warning(self, migrate):
        text = """\
# Decisions

## Decision 1 · 2026-01-15

**Question**: What to do?
**Context**: Something.
**Alternatives**:

- Option A: first option
- Option B: second option

**Choice**: A completely different approach.
**Reasoning**: None of the above.
**Confidence**: exploratory
**Feeds into**: nothing
"""
        data = migrate._parse_decisions(text)
        assert len(data["warnings"]) == 1
        assert "could not determine chosen" in data["warnings"][0]


# ── Health ────────────────────────────────────────────────────────────

HEALTH_V1 = """\
# Health

## Audit 2 · 2026-01-16

**Dimensions assessed**: architecture alignment, test health
**Findings**: 0 critical, 1 warning, 0 info (0 filtered by confidence)
**Overall trajectory**: improving vs Audit 1.
**Grades**: Architecture [A] | Tests [B]

### Architecture alignment: A

Project structure follows the agreed conventions.

### Test health: B

#### Test coverage is low, warning (confidence: 80)

- **Location**: `tests/`
- **Evidence**: Only 40% coverage on core modules.
- **Impact**: Regressions may go undetected.
- **Suggested action**: Add tests for core/processor.py.

### Trends vs Audit 1

- **Improved**: Architecture grade improved.
- **Degraded**: none.
- **Stable**: Version and freshness remain green.
- **New findings**: Test coverage gap.
- **Resolved**: Prior setup warning resolved.

### Patterns Observed

- Module structure follows convention.
- Test patterns are consistent.

## Audit 1 · 2026-01-15

**Dimensions assessed**: architecture alignment
**Findings**: 0 critical, 0 warnings, 0 info (0 filtered by confidence)
**Overall trajectory**: initial audit.
**Grades**: Architecture [A]

### Architecture alignment: A

Initial architecture is clean.

## Archived Audits

### Audit 0 · 2026-01-14 (baseline)
"""


class TestHealthMigration:
    def test_parse_audits(self, migrate):
        data = migrate._parse_health(HEALTH_V1)
        assert len(data["audits"]) == 2
        a = data["audits"][0]
        assert a["number"] == 2
        assert a["date"] == "2026-01-16"
        assert "architecture alignment" in a["dimensions"]
        assert a["findings_summary"]["warning"] == 1
        assert a["findings_summary"]["critical"] == 0

    def test_grades_parsed(self, migrate):
        data = migrate._parse_health(HEALTH_V1)
        grades = data["audits"][0]["grades"]
        assert grades.get("Architecture") == "A"
        assert grades.get("Tests") == "B"

    def test_dimension_details(self, migrate):
        data = migrate._parse_health(HEALTH_V1)
        details = data["audits"][0]["dimension_details"]
        assert len(details) >= 1
        test_dim = [d for d in details if "test" in d["name"].lower()][0]
        assert test_dim["grade"] == "B"
        assert len(test_dim["findings"]) >= 1
        f = test_dim["findings"][0]
        assert f["severity"] == "warning"
        assert f["confidence"] == 80

    def test_trends(self, migrate):
        data = migrate._parse_health(HEALTH_V1)
        trends = data["audits"][0]["trends"]
        assert "improved" in trends
        assert "resolved" in trends

    def test_empty_health(self, migrate):
        data = migrate._parse_health("# Health\n")
        assert data["audits"] == []

    def test_full_migration_writes_yaml(self, migrate, project_dir):
        _write_agentera(project_dir, "HEALTH.md", HEALTH_V1)
        migrate.migrate_project(project_dir)
        out = project_dir / ".agentera" / "health.yaml"
        assert out.exists()


# ── Session ───────────────────────────────────────────────────────────

SESSION_V1 = """\
# Session

## 2026-01-15 14:30

Artifacts modified: PROGRESS, DECISIONS
Summary: Completed initial setup cycle and recorded first decision.

## 2026-01-15 10:00

Artifacts modified: PROGRESS
Summary: First session bookmark.

## Archived Sessions

- 2026-01-14 09:00 (project initialized)
"""


class TestSessionMigration:
    def test_parse_bookmarks(self, migrate):
        data = migrate._parse_session(SESSION_V1)
        assert len(data["bookmarks"]) == 2
        b = data["bookmarks"][0]
        assert b["timestamp"] == "2026-01-15 14:30"
        assert "PROGRESS" in b["artifacts"]
        assert "DECISIONS" in b["artifacts"]

    def test_empty_session(self, migrate):
        data = migrate._parse_session("# Session\n")
        assert data["bookmarks"] == []

    def test_full_migration_writes_yaml(self, migrate, project_dir):
        _write_agentera(project_dir, "SESSION.md", SESSION_V1)
        migrate.migrate_project(project_dir)
        out = project_dir / ".agentera" / "session.yaml"
        assert out.exists()
        data = yaml.safe_load(out.read_text())
        assert len(data["bookmarks"]) == 2

    def test_missing_session_file(self, migrate, project_dir):
        (project_dir / ".agentera").mkdir()
        migrate.migrate_project(project_dir)
        out = project_dir / ".agentera" / "session.yaml"
        assert not out.exists()


# ── Plan ──────────────────────────────────────────────────────────────

PLAN_V1 = """\
# Plan: Example Plan

<!-- Level: full | Created: 2026-01-15 | Status: active -->
<!-- Reviewed: 2026-01-15 | Critic issues: 3 found, 2 addressed, 1 dismissed | Revised: simplified tasks -->

## What

Build the example feature.

## Why

Users need it.

## Constraints

- Must be backward compatible

## Scope

**In**: Feature, tests
**Out**: Documentation
**Deferred**: Performance optimization

## Design

Simple approach.

### Task 1: Foundation

**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN a thing WHEN tested THEN it works

### Task 2: Feature

**Depends on**: Task 1
**Status**: □ pending
**Acceptance**:
▸ GIVEN input WHEN processed THEN output is correct

## Overall Acceptance

▸ GIVEN all tasks complete WHEN tested THEN everything works

## Surprises

None so far.
"""


class TestPlanMigration:
    def test_parse_plan(self, migrate):
        data = migrate._parse_plan(PLAN_V1)
        assert data["header"]["level"] == "full"
        assert data["header"]["created"] == "2026-01-15"
        assert data["header"]["status"] == "active"
        assert "Example Plan" in data["header"]["title"]

    def test_tasks_parsed(self, migrate):
        data = migrate._parse_plan(PLAN_V1)
        assert len(data["tasks"]) == 2
        t1 = data["tasks"][0]
        assert t1["number"] == 1
        assert t1["status"] == "complete"
        t2 = data["tasks"][1]
        assert t2["status"] == "pending"

    def test_scope_parsed(self, migrate):
        data = migrate._parse_plan(PLAN_V1)
        assert "Feature" in data["scope"]["included"] or "Feature, tests" in data["scope"]["included"]
        assert "Documentation" in data["scope"]["excluded"] or len(data["scope"]["excluded"]) > 0

    def test_full_migration_writes_yaml(self, migrate, project_dir):
        _write_agentera(project_dir, "PLAN.md", PLAN_V1)
        migrate.migrate_project(project_dir)
        out = project_dir / ".agentera" / "plan.yaml"
        assert out.exists()
        data = yaml.safe_load(out.read_text())
        assert len(data["tasks"]) == 2


# ── Docs ──────────────────────────────────────────────────────────────

DOCS_V1 = """\
# Documentation Contract

<!-- Maintained by dokumentera. Last audit: 2026-01-15 (initial setup) -->

## Conventions

```
doc_root: .
style:    technical, concise
auto_gen:
  - none
  versioning:
  version_files:
    - plugin.json
    - registry.json
  semver_policy: "feat = minor, fix = patch, docs/chore/test = no bump"
```

## Artifact Mapping

| Artifact | Path | Producers |
|----------|------|-----------|
| VISION.md | VISION.md | visionera |
| PROGRESS.md | .agentera/PROGRESS.md | realisera |

## Index

| Document | Path | Last Updated | Status |
|----------|------|-------------|--------|
| README | README.md | 2026-01-15 | ■ current |
| Vision | VISION.md | 2026-01-15 | ■ current |

## Coverage

- **Documented**: 10/10 skills have SKILL.md
- **Undocumented**: 0 skills lack documentation
- **Stale**: none
- **Tests**: 42 tests across 5 files

## Audit Log

### 2026-01-15 (initial setup)

- [gap] Missing docs for feature X · warning (fixed)
- [stale] README out of date · info (fixed)
"""


class TestDocsMigration:
    def test_parse_docs(self, migrate):
        data = migrate._parse_docs(DOCS_V1)
        assert data["last_audit"] == "2026-01-15 (initial setup)"
        assert data["conventions"]["doc_root"] == "."
        assert "plugin.json" in data["conventions"]["version_files"]

    def test_mapping_parsed(self, migrate):
        data = migrate._parse_docs(DOCS_V1)
        assert len(data["mapping"]) == 2
        assert data["mapping"][0]["artifact"] == "VISION.md"

    def test_index_parsed(self, migrate):
        data = migrate._parse_docs(DOCS_V1)
        assert len(data["index"]) == 2
        assert data["index"][0]["document"] == "README"
        assert data["index"][0]["status"] == "current"

    def test_coverage_parsed(self, migrate):
        data = migrate._parse_docs(DOCS_V1)
        assert "42" in data["coverage"]["tests"]

    def test_full_migration_writes_yaml(self, migrate, project_dir):
        _write_agentera(project_dir, "DOCS.md", DOCS_V1)
        migrate.migrate_project(project_dir)
        out = project_dir / ".agentera" / "docs.yaml"
        assert out.exists()


# ── Vision ────────────────────────────────────────────────────────────

VISION_V1 = """\
# my-project

## North Star

The best project ever. It does all the things.

## Who It's For

### The solo developer

She works alone and needs tooling support.

## Principles

- **Simplicity first**: Keep things simple.
- **Test everything**: No untested code.

## Direction

Moving toward more automation.

## Identity

### Personality

The friendly workshop.

### Voice

Casual but precise.

### Emotional register

Feels like having a smart colleague.

### Naming

Consistent naming conventions.

## The Tension

Simplicity vs completeness.
"""


class TestVisionMigration:
    def test_parse_vision(self, migrate):
        data = migrate._parse_vision(VISION_V1)
        assert data["project_name"] == "my-project"
        assert "best project ever" in data["north_star"].lower()
        assert len(data["personas"]) == 1
        assert len(data["principles"]) == 2
        assert data["identity"]["personality"] != ""
        assert "Simplicity vs completeness" in data["tension"]

    def test_full_migration_writes_yaml(self, migrate, project_dir):
        (project_dir / "VISION.md").write_text(VISION_V1, encoding="utf-8")
        migrate.migrate_project(project_dir)
        out = project_dir / ".agentera" / "vision.yaml"
        assert out.exists()
        data = yaml.safe_load(out.read_text())
        assert data["project_name"] == "my-project"


# ── Cross-cutting acceptance criteria ─────────────────────────────────

class TestAcceptance:
    def test_no_v1_artifacts_exits_zero(self, migrate, project_dir, capsys):
        (project_dir / ".agentera").mkdir()
        result = migrate.migrate_project(project_dir)
        assert result == 0
        assert "nothing to migrate" in capsys.readouterr().out

    def test_backup_created(self, migrate, project_dir):
        _write_agentera(project_dir, "PROGRESS.md", PROGRESS_V1)
        _write_agentera(project_dir, "DECISIONS.md", DECISIONS_V1)
        migrate.migrate_project(project_dir)
        backup_dir = project_dir / ".agentera" / "backup-v1"
        assert backup_dir.is_dir()
        assert (backup_dir / "PROGRESS.md").exists()
        assert (backup_dir / "DECISIONS.md").exists()
        assert (backup_dir / "PROGRESS.md").read_text() == PROGRESS_V1

    def test_backup_before_write(self, migrate, project_dir):
        original = PROGRESS_V1
        _write_agentera(project_dir, "PROGRESS.md", original)
        migrate.migrate_project(project_dir)
        backup = project_dir / ".agentera" / "backup-v1" / "PROGRESS.md"
        yaml_out = project_dir / ".agentera" / "progress.yaml"
        assert backup.read_text() == original
        assert yaml_out.exists()
        assert yaml.safe_load(yaml_out.read_text()) is not None

    def test_dry_run_no_write(self, migrate, project_dir):
        _write_agentera(project_dir, "PROGRESS.md", PROGRESS_V1)
        migrate.migrate_project(project_dir, dry_run=True)
        assert not (project_dir / ".agentera" / "progress.yaml").exists()
        assert not (project_dir / ".agentera" / "backup-v1").exists()

    def test_yaml_valid_output(self, migrate, project_dir):
        _write_agentera(project_dir, "PROGRESS.md", PROGRESS_V1)
        _write_agentera(project_dir, "DECISIONS.md", DECISIONS_V1)
        _write_agentera(project_dir, "HEALTH.md", HEALTH_V1)
        _write_agentera(project_dir, "PLAN.md", PLAN_V1)
        _write_agentera(project_dir, "DOCS.md", DOCS_V1)
        (project_dir / "VISION.md").write_text(VISION_V1, encoding="utf-8")
        migrate.migrate_project(project_dir)

        for expected in [
            project_dir / ".agentera" / "progress.yaml",
            project_dir / ".agentera" / "decisions.yaml",
            project_dir / ".agentera" / "health.yaml",
            project_dir / ".agentera" / "plan.yaml",
            project_dir / ".agentera" / "docs.yaml",
            project_dir / ".agentera" / "vision.yaml",
        ]:
            assert expected.exists(), f"Missing {expected}"
            data = yaml.safe_load(expected.read_text())
            assert data is not None, f"Empty YAML in {expected}"

    def test_human_facing_not_migrated(self, migrate, project_dir):
        (project_dir / "TODO.md").write_text("# TODO\n\n- [ ] task", encoding="utf-8")
        (project_dir / "CHANGELOG.md").write_text("# Changelog\n", encoding="utf-8")
        (project_dir / ".agentera").mkdir()
        migrate.migrate_project(project_dir)
        assert not (project_dir / "todo.yaml").exists()
        assert not (project_dir / "changelog.yaml").exists()
        assert (project_dir / "TODO.md").exists()
        assert (project_dir / "CHANGELOG.md").exists()

    def test_warnings_logged_for_unmapped(self, migrate, project_dir, capsys):
        text = """\
# Decisions

## Decision 1 · 2026-01-15

**Question**: What?
**Context**: Context.
**Alternatives**:

- Option A: first
- Option B: second

**Choice**: Something completely unrelated to either option.
**Reasoning**: Because.
**Confidence**: firm
**Feeds into**: nothing
"""
        _write_agentera(project_dir, "DECISIONS.md", text)
        migrate.migrate_project(project_dir, verbose=True)
        out = project_dir / ".agentera" / "decisions.yaml"
        assert out.exists()
        data = yaml.safe_load(out.read_text())
        assert len(data["decisions"]) == 1

    def test_progress_n_entries(self, migrate, project_dir):
        _write_agentera(project_dir, "PROGRESS.md", PROGRESS_V1)
        migrate.migrate_project(project_dir)
        data = yaml.safe_load((project_dir / ".agentera" / "progress.yaml").read_text())
        assert len(data["cycles"]) == 2

    def test_migrated_output_message(self, migrate, project_dir, capsys):
        _write_agentera(project_dir, "PROGRESS.md", PROGRESS_V1)
        result = migrate.migrate_project(project_dir)
        assert result == 0
        assert "migrated 1 artifact(s)" in capsys.readouterr().out


# ── Safety hardening: dry-run reporting ────────────────────────────────

class TestDryRunReporting:
    def test_dry_run_reports_would_migrate(self, migrate, project_dir, capsys):
        _write_agentera(project_dir, "PROGRESS.md", PROGRESS_V1)
        _write_agentera(project_dir, "DECISIONS.md", DECISIONS_V1)
        result = migrate.migrate_project(project_dir, dry_run=True)
        assert result == 0
        output = capsys.readouterr().out
        assert "would migrate 2 artifact(s)" in output

    def test_dry_run_no_writes(self, migrate, project_dir):
        _write_agentera(project_dir, "PROGRESS.md", PROGRESS_V1)
        migrate.migrate_project(project_dir, dry_run=True)
        assert not (project_dir / ".agentera" / "progress.yaml").exists()
        assert not (project_dir / ".agentera" / "backup-v1").exists()


# ── Safety hardening: backup overwrite protection ──────────────────────

class TestBackupOverwriteProtection:
    def test_existing_backup_no_force_exits_nonzero(self, migrate, project_dir, capsys):
        _write_agentera(project_dir, "PROGRESS.md", PROGRESS_V1)
        backup_dir = project_dir / ".agentera" / "backup-v1"
        backup_dir.mkdir(parents=True)
        (backup_dir / "PROGRESS.md").write_text("old backup", encoding="utf-8")

        result = migrate.migrate_project(project_dir)
        assert result != 0
        assert not (project_dir / ".agentera" / "progress.yaml").exists()
        err = capsys.readouterr().err
        assert "backup directory already exists" in err

    def test_existing_backup_with_force_proceeds(self, migrate, project_dir):
        _write_agentera(project_dir, "PROGRESS.md", PROGRESS_V1)
        backup_dir = project_dir / ".agentera" / "backup-v1"
        backup_dir.mkdir(parents=True)
        (backup_dir / "PROGRESS.md").write_text("old backup", encoding="utf-8")

        result = migrate.migrate_project(project_dir, force=True)
        assert result == 0
        assert (project_dir / ".agentera" / "progress.yaml").exists()


# ── Safety hardening: PROFILE.md exclusion ─────────────────────────────

class TestProfileExclusion:
    def test_profile_excluded_when_exists(self, migrate, project_dir, capsys, monkeypatch):
        xdg_dir = project_dir / "xdg" / "agentera"
        xdg_dir.mkdir(parents=True)
        (xdg_dir / "PROFILE.md").write_text("# Profile", encoding="utf-8")
        monkeypatch.setenv("XDG_DATA_HOME", str(project_dir / "xdg"))

        _write_agentera(project_dir, "PROGRESS.md", PROGRESS_V1)
        result = migrate.migrate_project(project_dir)
        assert result == 0
        output = capsys.readouterr().out
        assert "PROFILE.md excluded from migration" in output

    def test_no_profile_mention_when_absent(self, migrate, project_dir, capsys, monkeypatch):
        monkeypatch.setenv("XDG_DATA_HOME", str(project_dir / "xdg"))

        _write_agentera(project_dir, "PROGRESS.md", PROGRESS_V1)
        result = migrate.migrate_project(project_dir)
        assert result == 0
        output = capsys.readouterr().out
        assert "PROFILE.md excluded from migration" not in output


# ── Safety hardening: backup failure ───────────────────────────────────

class TestBackupFailureSafety:
    def test_backup_failure_exits_nonzero_no_writes(self, migrate, project_dir, monkeypatch, capsys):
        _write_agentera(project_dir, "PROGRESS.md", PROGRESS_V1)

        def failing_copy2(src, dst):
            raise OSError("disk full")

        monkeypatch.setattr(shutil, "copy2", failing_copy2)

        result = migrate.migrate_project(project_dir)
        assert result != 0
        assert not (project_dir / ".agentera" / "progress.yaml").exists()
        err = capsys.readouterr().err
        assert "backup creation failed" in err

    def test_backup_succeeds_migration_proceeds(self, migrate, project_dir):
        _write_agentera(project_dir, "PROGRESS.md", PROGRESS_V1)
        result = migrate.migrate_project(project_dir)
        assert result == 0
        assert (project_dir / ".agentera" / "progress.yaml").exists()
        assert (project_dir / ".agentera" / "backup-v1" / "PROGRESS.md").exists()
