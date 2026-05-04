# Plan: Agentera 2.0 Phase 4 — Validation & Cutover

<!-- Level: full | Created: 2026-05-04 | Status: active -->

## What

Merge feat/v2 to main, validate the full suite, port semantic eval, benchmark tokens, bump version to 2.0.0.

## Why

Phases 1-3 built and integrated the v2 architecture. Phase 4 proves it works on main and ships it.

## Constraints

- D39 (firm): big bang cutover from feat/v2
- D40 (firm): YAML, capabilities, no backward compat
- feat/v2 and main are linked worktrees (merge from main worktree)
- 35 commits ahead of main, 112 files changed
- Rollback: `git reset --hard ORIG_HEAD` on main if post-merge validation fails

## Scope

**In**: merge, post-merge validation, SPEC.md + validate_spec.py retirement, version bump, semantic eval port, token benchmark, freshness
**Out**: master SKILL.md thin optimization, third-party extensibility, runtime smoke testing, v1 script migration
**Deferred**: post-merge performance tuning, cross-capability dependency graph tooling

## Design

Merge feat/v2 into main via fast-forward or merge commit. Retire v1 infrastructure (SPEC.md, validate_spec.py) as part of the merge. Validate post-merge with full test suite and capability validation. Port the 1 semantic eval fixture to v2 format. Measure token consumption delta v1 vs v2. Bump version to 2.0.0.

## Tasks

### Task 1: Pre-merge Validation

**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN the feat/v2 branch WHEN pytest runs THEN 744+ tests pass with 0 failures
▸ GIVEN the feat/v2 branch WHEN all 12 capabilities are validated via validate_capability.py THEN all pass contract + primitives
▸ GIVEN the skipped test WHEN investigated THEN its skip reason is documented and understood
▸ GIVEN the working tree WHEN git status runs THEN it is clean (no uncommitted changes)

### Task 2: Merge feat/v2 to Main

**Depends on**: Task 1
**Status**: □ pending
**Acceptance**:
▸ GIVEN the main worktree WHEN feat/v2 is merged THEN the merge completes without conflicts or with documented conflict resolution
▸ GIVEN the merged main WHEN SPEC.md is checked THEN it is absent (retired as part of v2 cutover)
▸ GIVEN the merged main WHEN validate_spec.py is checked THEN it is absent (retired alongside SPEC.md)
▸ GIVEN a failed merge WHEN rollback is needed THEN `git reset --hard ORIG_HEAD` restores main to pre-merge state

### Task 3: Post-merge Validation

**Depends on**: Task 2
**Status**: □ pending
**Acceptance**:
▸ GIVEN main after merge WHEN pytest runs THEN all tests pass with 0 failures
▸ GIVEN main after merge WHEN ls capabilities/ THEN 12 capability directories exist
▸ GIVEN main after merge WHEN each capability is checked THEN each has prose.md + schemas/ with 4 YAML files
▸ GIVEN main after merge WHEN validate_capability.py runs for all 12 capabilities THEN all pass
▸ GIVEN main after merge WHEN protocol.yaml is validated THEN it parses and contains expected groups

### Task 4: Version Bump to 2.0.0

**Depends on**: Task 3
**Status**: □ pending
**Acceptance**:
▸ GIVEN registry.json WHEN read THEN version field shows 2.0.0
▸ GIVEN .claude-plugin/marketplace.json WHEN read THEN version field shows 2.0.0
▸ GIVEN skills/agentera/.claude-plugin/plugin.json WHEN read THEN version field shows 2.0.0

### Task 5: Semantic Eval Fixture Port

**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN the v1 fixture fixtures/semantic/hej-routing-task3.md WHEN ported to v2 format THEN it references v2 artifact paths and capability structure
▸ GIVEN the v2 fixture WHEN scripts/semantic_eval.py runs THEN it validates correctly

### Task 6: Token Benchmark

**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN v1 skill content (all 12 SKILL.md + SPEC.md) WHEN measured in bytes and estimated tokens THEN baseline is recorded
▸ GIVEN v2 skill content (SKILL.md + protocol.yaml + all prose.md + all schemas/) WHEN measured in bytes and estimated tokens THEN v2 measurement is recorded
▸ GIVEN v1 and v2 measurements WHEN delta is calculated THEN the percentage change is documented in DECISIONS.md with methodology

### Task 7: Plan-level Freshness Checkpoint

**Depends on**: Task 2, Task 3, Task 4, Task 5, Task 6
**Status**: □ pending
**Acceptance**:
▸ GIVEN all prior tasks complete WHEN CHANGELOG.md is checked THEN it has an Added entry under [Unreleased] covering Phase 4 validation and cutover
▸ GIVEN all prior tasks complete WHEN PROGRESS.md is checked THEN it has a cycle entry whose What field summarizes the Phase 4 plan completion
▸ GIVEN all prior tasks complete WHEN ROADMAP.md is checked THEN Phase 4 is marked complete

## Overall Acceptance

▸ GIVEN the main branch after all Phase 4 tasks WHEN the full test suite runs THEN 0 failures
▸ GIVEN the main branch after all Phase 4 tasks WHEN validate_capability.py runs for all 12 capabilities THEN all pass
▸ GIVEN the main branch after all Phase 4 tasks WHEN version files are checked THEN all show 2.0.0

## Surprises

[Populated by realisera during execution when reality diverges from plan.]
