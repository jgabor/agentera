# Plan: Optimera Multi-Objective Support (ISS-39, Decision 30)

<!-- Level: full | Created: 2026-04-12 | Status: active -->
<!-- Reviewed: 2026-04-12 | Critic issues: 8 found, 6 addressed, 2 dismissed -->

## What

Consolidate optimera state under `.agentera/optimera/` with named subdirectories per objective. Migrate existing hej-token and realisera-token data. Update all references across SPEC.md, optimera SKILL.md, DOCS.md, hooks, .gitignore, and regenerate contracts.

## Why

Today optimera pins a single OBJECTIVE.md / EXPERIMENTS.md / .optimera/harness, requiring hand-written archive moves to rotate targets. .optimera/ lives outside .agentera/, splitting artifact roots. Decision 30 (firm) prescribes named subdirs, self-contained per objective, with active-objective inference. This unblocks concurrent and sequential optimization work on different skills.

## Constraints

- Decision 30 is firm: named subdirs, self-contained, infer active, drop from DOCS.md
- SPEC.md Section 4 format contracts and Section 18 staleness detection must update
- Linter must pass 0/0 after all changes
- All 260 tests must continue passing
- No em-dashes, no hard wraps
- hej-token data must be recovered from git history (overwritten by realisera-token bootstrap)
- runs/ directories (488MB) stay gitignored
- Hooks that reference OBJECTIVE.md/EXPERIMENTS.md must not silently break

## Scope

**In**: .optimera/ -> .agentera/optimera/ migration, SPEC.md Section 4 and 18 updates, optimera SKILL.md (paths, inference, references/ guide files), resonera SKILL.md (OBJECTIVE.md write path), hooks that hardcode optimera artifact paths, DOCS.md mapping removal, .gitignore path updates, contract regeneration, version bump
**Out**: analyze_experiments.py script code changes, harness script code changes, optimera brainstorm UX for new-objective creation, other skills' SKILL.md files (except resonera)
**Deferred**: full "create a new objective" brainstorm flow refinement for the new layout

## Design

The migration creates `.agentera/optimera/` as a skill-scoped operational directory. Each objective gets a named subdirectory containing its full state: OBJECTIVE.md, EXPERIMENTS.md, harness, helper scripts, vehicle/, and runs/. The flat `.agentera/OBJECTIVE.md` and `.agentera/EXPERIMENTS.md` are removed after migration. SPEC.md Section 4's format contracts table changes OBJECTIVE.md and EXPERIMENTS.md to note they are managed per-objective by optimera. Optimera SKILL.md gains active-objective inference: single objective dir = use it, multiple = most recent EXPERIMENTS.md modification, ambiguous = ask. Hooks update their tracked-artifact sets to match the new paths (or remove the entries if the hook can't resolve per-objective paths without optimera's context).

## Tasks

### Task 1: Migrate existing data to per-objective subdirectories
**Depends on**: none
**Status**: ■ complete
**Acceptance**:
- GIVEN the migration has run WHEN `.agentera/optimera/realisera-token/` is listed THEN it contains OBJECTIVE.md, EXPERIMENTS.md, harness, helper scripts, and vehicle/
- GIVEN the migration has run WHEN `.agentera/optimera/hej-token/` is listed THEN it contains OBJECTIVE.md, EXPERIMENTS.md, harness, helper scripts, and vehicle/ recovered from git history
- GIVEN the migration has run WHEN `.optimera/` is checked THEN the directory no longer exists at the repo root
- GIVEN the migration has run WHEN `.agentera/OBJECTIVE.md` and `.agentera/EXPERIMENTS.md` are checked THEN they no longer exist (moved into realisera-token/)

### Task 2: Update SPEC.md Section 4 and Section 18
**Depends on**: none
**Status**: ■ complete
**Acceptance**:
- GIVEN SPEC.md Section 4 format contracts table WHEN OBJECTIVE.md and EXPERIMENTS.md rows are read THEN the path column reflects per-objective layout managed by optimera (not fixed .agentera/ paths)
- GIVEN SPEC.md Section 18 staleness detection WHEN the optimera row is read THEN expected artifact outputs reference the per-objective convention
- GIVEN all changes are made WHEN `python3 scripts/generate_contracts.py` is run THEN all 12 contract files regenerate cleanly

### Task 3: Update optimera SKILL.md, references, and resonera SKILL.md
**Depends on**: Task 1
**Status**: □ pending
**Acceptance**:
- GIVEN optimera SKILL.md state artifacts section WHEN path references are read THEN OBJECTIVE.md, EXPERIMENTS.md, and harness all reference `.agentera/optimera/<objective-name>/` layout
- GIVEN optimera SKILL.md orient step WHEN active-objective inference is described THEN it specifies: single objective dir = use it, multiple = most recent EXPERIMENTS.md modification, ambiguous = ask user
- GIVEN optimera SKILL.md WHEN artifact path resolution section is read THEN it retains the canonical DOCS.md check sentence and adds that OBJECTIVE.md/EXPERIMENTS.md are resolved per-objective
- GIVEN optimera reference files (harness-guide.md, agent-session-harness.md) WHEN harness path references are checked THEN they use `.agentera/optimera/<objective-name>/harness` not `.optimera/harness`
- GIVEN resonera SKILL.md WHEN "Feed into OBJECTIVE.md" path is checked THEN it directs the write to the active objective's OBJECTIVE.md under `.agentera/optimera/`

### Task 4: Update DOCS.md, .gitignore, and hooks
**Depends on**: Task 1
**Status**: □ pending
**Acceptance**:
- GIVEN .agentera/DOCS.md artifact mapping table WHEN OBJECTIVE.md and EXPERIMENTS.md rows are checked THEN they have been removed
- GIVEN .gitignore WHEN optimera-related patterns are read THEN runs/ and vehicle/ patterns use `.agentera/optimera/*/runs/` and `.agentera/optimera/*/vehicle/` glob paths
- GIVEN hooks that reference OBJECTIVE.md or EXPERIMENTS.md WHEN their tracked-artifact sets are checked THEN they reference the new per-objective paths or gracefully handle the path change

### Task 5: Tests, linter, and version bump
**Depends on**: Tasks 1, 2, 3, 4
**Status**: □ pending
**Acceptance**:
- GIVEN all prior tasks are complete WHEN `python3 -m pytest tests/ -q` is run THEN 260+ tests pass
- GIVEN all prior tasks are complete WHEN `python3 scripts/validate_spec.py` is run THEN 0 errors, 0 warnings
- GIVEN all prior tasks are complete WHEN `python3 scripts/eval_skills.py --skill optimera --dry-run` is run THEN the skill resolves
- GIVEN DOCS.md versioning convention WHEN version files are checked THEN version has been bumped (feat = minor)

### Task 6: Plan-level freshness checkpoint
**Depends on**: Tasks 1, 2, 3, 4, 5
**Status**: □ pending
**Acceptance**:
- GIVEN this plan's user-facing work has shipped WHEN CHANGELOG.md is checked THEN it has entries covering each task's user-visible impact
- GIVEN this plan is otherwise complete WHEN PROGRESS.md is checked THEN it has at least one cycle entry whose **What** field summarizes the plan and whose **Commits** field lists the commits this plan produced
- GIVEN this plan is otherwise complete WHEN TODO.md is checked THEN ISS-39 has a corresponding Resolved entry

## Overall Acceptance

- GIVEN the migration is complete WHEN `.agentera/optimera/` is listed THEN it contains exactly two subdirectories: `hej-token/` and `realisera-token/`
- GIVEN the migration is complete WHEN the old `.optimera/` path is checked THEN it does not exist
- GIVEN the full suite WHEN the spec linter, test suite, and eval dry-run all execute THEN all pass cleanly

## Surprises
