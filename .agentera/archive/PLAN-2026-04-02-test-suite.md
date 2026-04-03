# Plan: Test suite foundation + README accuracy

<!-- Level: full | Created: 2026-04-02 | Status: active -->
<!-- Reviewed: 2026-04-02 | Critic issues: 10 found, 6 addressed, 4 dismissed -->

## What

Extend the existing pytest test suite to cover the linter's 13 check functions and the eval runner's pure functions. Fix README accuracy gaps for profilera and inspirera.

## Why

Test health is the last D-grade dimension across 5 audits. The linter (`validate_ecosystem.py`) has tests for parsing helpers only (8 tests); its 13 check functions and Results class are untested. The eval runner (`eval_skills.py`) has no tests and is missing orkestrera's trigger prompt. Two degraded README issues (ISS-30, ISS-32) understate profilera's and inspirera's ecosystem roles.

## Constraints

- Scripts remain stdlib-only; tests use pytest
- No CI pipeline changes (deferred)
- Linter tests use inline synthetic SKILL.md strings, no filesystem reads
- Eval runner tests monkeypatch `REPO_ROOT` for `discover_skills`; mock subprocess for invocation tests
- README changes must pass the existing linter

## Scope

**In**: Linter check function tests, Results class tests, eval runner unit tests, eval runner orkestrera fix, README profilera + inspirera improvements
**Out**: CI/CD pipeline, artifact format contract tests
**Deferred**: Pre-commit test integration, CI gating, contract tests for inter-skill artifact formats

## Design

Extends existing `tests/` directory (48 tests across 5 files, conftest.py with importlib fixtures). New tests added to `tests/test_validate_ecosystem.py` and new `tests/test_eval_skills.py`. Shared synthetic SKILL.md fixtures in test_validate_ecosystem.py for check function tests. Eval runner fixture added to conftest.py.

## Tasks

### Task 1: Linter Results class, extract_subsection, and shared fixtures
**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN a Results instance with mixed pass/error/warn entries WHEN counts are accessed THEN `error_count` and `warn_count` return correct values
▸ GIVEN a markdown doc with ### subsections WHEN `extract_subsection` is called THEN it returns the nested content
▸ GIVEN reusable synthetic SKILL.md content WHEN used by check function tests THEN it provides valid and invalid variants as fixtures
▸ GIVEN `pytest tests/test_validate_ecosystem.py` WHEN run THEN all existing and new tests pass

### Task 2: Linter text-level check function tests
**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN valid synthetic content WHEN check_frontmatter, check_confidence_scale, check_severity_levels, check_decision_labels, check_em_dashes, and check_hard_wraps are run THEN each returns PASS
▸ GIVEN content with known violations WHEN those six checks are run THEN they return ERROR or WARN with descriptive details
▸ GIVEN edge cases (empty content, missing sections) WHEN checks are run THEN they handle gracefully without exceptions

### Task 3: Linter structural check function tests
**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN valid synthetic content WHEN check_artifact_path_resolution, check_profile_consumption, check_cross_skill_integration, check_safety_rails, check_artifact_format, check_exit_signals, and check_loop_guard are run THEN each returns PASS
▸ GIVEN content with known violations WHEN those seven checks are run THEN they return ERROR with descriptive details
▸ GIVEN edge cases (empty content, missing sections) WHEN checks are run THEN they handle gracefully without exceptions

### Task 4: Eval runner tests and orkestrera trigger prompt
**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN TRIGGER_PROMPTS in eval_skills.py WHEN inspected THEN it contains entries for all 12 skills including orkestrera
▸ GIVEN a monkeypatched REPO_ROOT pointing to a temp directory with SKILL.md files WHEN `discover_skills` is called THEN it returns sorted entries with correct names and prompts
▸ GIVEN eval results WHEN `build_report` is called THEN output contains timestamp, pass/fail counts, and per-skill entries
▸ GIVEN command-line arguments WHEN `parse_args` is called THEN it correctly parses --skill, --dry-run, --parallel, and --timeout
▸ GIVEN conftest.py WHEN eval_skills fixture is added THEN it loads the module via the importlib pattern

### Task 5: README profilera and inspirera overhaul
**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN the README skill table WHEN profilera's entry is read THEN it conveys that profilera is the compounding memory layer consumed by every skill
▸ GIVEN the README ecosystem diagram WHEN inspirera is examined THEN it either shows edges to realisera, optimera, visionera, resonera, profilera or carries a "(simplified)" annotation
▸ GIVEN the README consumer tables WHEN checked THEN VISION.md lists orkestrera as consumer, PROGRESS.md lists orkestrera, and all entries match ecosystem spec Section 7

## Overall Acceptance

▸ GIVEN `pytest tests/` WHEN run from the repo root THEN all test files pass with zero failures
▸ GIVEN `python3 scripts/validate_ecosystem.py` WHEN run THEN it reports 0 errors, 0 warnings
▸ GIVEN TODO.md WHEN ISS-30 and ISS-32 are checked THEN they can be marked resolved
▸ GIVEN TODO.md WHEN ISS-31 is checked THEN it is updated to note test coverage added, CI gating deferred

## Surprises

