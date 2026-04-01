# Plan: uvx Script Uplift and Test Infrastructure

<!-- Level: full | Created: 2026-04-01 | Status: active -->
<!-- Reviewed: 2026-04-01 | Critic issues: 9 found, 7 addressed, 2 dismissed -->

## What
Convert all Python scripts to PEP 723 single-file scripts with inline metadata.
Consolidate profilera extract pipeline (6 files → 1). Rename hyphenated repo scripts
for importability. Add unit tests for critical parsing and analysis functions. Fix
eval-skills.py hej gap (Audit 4 finding).

## Why
Inspektera Audit 4 graded Test health at D (3 critical findings: zero unit tests, no
artifact format contract tests, eval runner gaps). The uvx uplift modernizes script
infrastructure for public release — scripts become self-documenting, independently
executable, and testable.

## Constraints
- Scripts must remain stdlib-only at runtime (no pip dependencies)
- pytest is acceptable as a dev/test-only dependency
- All SKILL.md invocation references must be updated to match new patterns
- Existing script behavior must not change (output format, exit codes, CLI args)
- Linter must still pass after all changes (0 errors currently)

## Scope
**In**: PEP 723 metadata on all scripts, profilera extract pipeline consolidation,
hyphen→underscore renames for repo scripts, invocation reference updates across 11
SKILL.md + CLAUDE.md + pre-commit hook, unit tests for parsing/analysis functions,
hej addition to eval-skills TRIGGER_PROMPTS
**Out**: Artifact format contract tests (future plan), comprehensive eval runner
improvements beyond hej addition, cross-skill integration tests, top-level repo
directory restructuring

## Design
Seven standalone scripts get PEP 723 headers declaring `requires-python = ">=3.10"`
and empty `dependencies = []`. The profilera extract pipeline (utils.py + 4 extractors
+ extract_all.py) consolidates into one file with all functions inlined — effective_profile.py
is already standalone (no relative imports) and stays separate. Repo-level scripts rename
from hyphens to underscores for Python importability in tests. All SKILL.md
`cd dir && python3 -m module` invocations change to direct `python3 path/to/script.py`.
Tests use pytest in a repo-root `tests/` directory with a conftest.py that adds script
directories to sys.path.

## Tasks

### Task 1: Add PEP 723 metadata to 4 standalone skill scripts
Add PEP 723 inline script metadata headers to effective_profile.py,
analyze_experiments.py, analyze_progress.py, validate_design.py. Fix unused
`import os` in analyze_experiments.py. No renames, no file deletions — additive only.
**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN any of the 4 scripts WHEN inspected THEN it has a PEP 723 `# /// script` header with `requires-python = ">=3.10"`
▸ GIVEN each script WHEN run with existing args THEN output is identical to pre-change

### Task 2: Consolidate profilera extract pipeline into single-file script
Merge utils.py, extract_configs.py, extract_conversations.py, extract_history.py,
extract_memory.py, and extract_all.py into a single extract_all.py with PEP 723
header. Remove __init__.py and individual module files. Update profilera SKILL.md
invocation atomically in the same commit.
**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN the consolidated extract_all.py WHEN run with same args as before THEN output is identical
▸ GIVEN skills/profilera/scripts/ WHEN listed THEN it contains exactly effective_profile.py and extract_all.py
▸ GIVEN profilera SKILL.md WHEN searched for `python3 -m` THEN no matches found

### Task 3: Rename repo scripts and update all invocation references
Rename validate-ecosystem.py → validate_ecosystem.py and eval-skills.py →
eval_skills.py. Add PEP 723 headers to both. Add hej to eval_skills.py
TRIGGER_PROMPTS with a prompt that exercises orient-and-route behavior. Remove
visualisera/scripts/__init__.py. Update pre-commit hook, CLAUDE.md, and all
11 SKILL.md invocation references to use direct script paths. All renames, removals,
and reference updates in one atomic commit.
**Depends on**: Task 1, Task 2
**Status**: ■ complete
**Acceptance**:
▸ GIVEN any SKILL.md WHEN searched for `python3 -m scripts.` THEN no matches found
▸ GIVEN the pre-commit hook WHEN triggered THEN it invokes validate_ecosystem.py successfully
▸ GIVEN the ecosystem linter WHEN run THEN 0 errors, 0 warnings
▸ GIVEN eval_skills.py WHEN listing skills THEN hej appears with a prompt exercising orient-and-route

### Task 4: Add unit tests for critical parsing functions
Create tests/ directory with pytest conftest.py that adds script directories to
sys.path. Write tests covering parse_frontmatter and extract_section (linter),
parse_cycles and analyze (analyze_progress), parse_experiments and analyze
(analyze_experiments), parse_entries and compute_effective (effective_profile),
parse_yaml_subset and validate (validate_design). Weight coverage toward the
highest-complexity functions: parse_yaml_subset (custom parser) and
compute_effective (exponential decay math) each need 3+ test cases.
**Depends on**: Task 1, Task 2
**Status**: ■ complete
**Acceptance**:
▸ GIVEN the test suite WHEN run with pytest THEN all tests pass
▸ GIVEN parse_yaml_subset THEN at least 3 tests cover nested structures, edge cases, and malformed input
▸ GIVEN compute_effective THEN at least 3 tests cover fresh entries, decayed entries, and boundary conditions
▸ GIVEN all other parsing functions THEN each has at least one happy-path and one edge-case test

### Task 5: Version bump per DOCS.md convention
Bump all 11 skills minor version. Update registry.json, marketplace.json, all
plugin.json files per semver policy (feat = minor).
**Depends on**: Task 1, Task 2, Task 3, Task 4
**Status**: ■ complete
**Acceptance**:
▸ GIVEN all version files WHEN inspected THEN versions are bumped by one minor increment
▸ GIVEN the ecosystem linter WHEN run THEN 0 errors

## Overall Acceptance
▸ GIVEN the complete uplift WHEN all scripts are run THEN behavior is identical to pre-uplift
▸ GIVEN the test suite WHEN run with pytest THEN 0 failures
▸ GIVEN the ecosystem linter WHEN run THEN 0 errors, 0 warnings
▸ GIVEN any Python script in the repo WHEN inspected THEN it has PEP 723 inline metadata

## Surprises
