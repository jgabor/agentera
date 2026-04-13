# Plan: Pre-dispatch Commit Gate

<!-- Level: full | Created: 2026-04-13 | Status: active -->
<!-- Reviewed: 2026-04-13 | Critic issues: 8 found, 6 addressed, 2 dismissed -->

## What

Add a pre-dispatch commit gate convention to the spec and enforce it in skills that dispatch subagents to git worktrees. Before any `isolation: "worktree"` dispatch, the dispatching skill must commit pending working tree changes so the worktree branches from current state, not a stale snapshot.

## Why

Git worktrees branch from HEAD (the last commit), not the working tree. When realisera or optimera writes artifacts (PLAN.md updates, PROGRESS.md, context files) during their orient/plan steps and then dispatches a subagent to a worktree without committing, the subagent gets a stale snapshot missing those artifacts. This causes the subagent to work without current context, producing incorrect or conflicting results that require full rework. The problem is structural: it compounds across every worktree dispatch in every orkestrera-driven plan execution.

## Constraints

- Only skills that call `isolation: "worktree"` need the gate (realisera, optimera). orkestrera dispatches skills without worktree isolation; it is transitively covered because the dispatched skills gate their own worktree creation.
- Checkpoint commits must not skip pre-commit hooks. If hooks reject the commit, the dispatch is blocked until the issue is fixed. Invalid artifacts should not be dispatched.
- Staging must be scoped to artifact paths the skill wrote during the current session, not `git add -A` or `git add .`, to avoid committing editor temp files or secrets.
- The gate is a no-op when the working tree is clean (nothing to commit, nothing to block).

## Scope

**In**: SPEC.md new section, realisera SKILL.md Step 5, optimera SKILL.md dispatch step, linter check, tests, contract regeneration, version bump, freshness checkpoint
**Out**: orkestrera SKILL.md (does not create worktrees), Claude Code platform worktree primitive (not ours to change), other skills that don't dispatch to worktrees
**Deferred**: Extending the convention to non-worktree dispatch patterns if needed in the future

## Design

The convention mirrors Section 19 (Reality Verification Gate) but for the pre-dispatch boundary instead of post-implementation. Section 19 gates the exit from a cycle; this gates the entry to a worktree.

orkestrera appears in the problem statement but does not need the gate. Execution flow: orkestrera Step 2 dispatches realisera as a background subagent (no worktree isolation). Realisera runs Steps 1-4 in the same working directory (can see all files). Realisera Step 5 creates the worktree. The gate at realisera Step 5 commits everything (including orkestrera's uncommitted PLAN.md status updates) before branching. orkestrera is covered transitively.

Checkpoint commits use `chore(<skill>): checkpoint before worktree dispatch` as the conventional commit message. The `chore` type triggers no version bump per semver_policy. The `checkpoint before worktree dispatch` scope distinguishes these from work commits in git history and CHANGELOG consumers.

## Tasks

### Task 1: Define the Pre-dispatch Commit Gate convention in the spec

**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN the spec WHEN a skill author looks up the worktree dispatch convention THEN they find a section defining when the gate applies, what it requires, and how checkpoint commits are identified
▸ GIVEN a skill that dispatches to worktrees WHEN it references the convention THEN the spec provides the staging scope (artifact paths only), commit message format, hook failure handling, and clean-tree no-op behavior
▸ GIVEN the new section WHEN a reader compares it with Section 19 THEN the two gates form a coherent pair: pre-dispatch (this) and post-implementation (Section 19)

### Task 2: Add the gate to realisera before worktree dispatch

**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN realisera with uncommitted artifact changes WHEN Step 5 begins THEN pending artifact changes are committed before the worktree subagent is dispatched
▸ GIVEN realisera with a clean working tree WHEN Step 5 begins THEN no checkpoint commit is created and dispatch proceeds normally
▸ GIVEN the checkpoint commit WHEN a hook rejects it THEN dispatch does not proceed and the skill reports the failure
▸ GIVEN realisera's spec_sections frontmatter WHEN the new section exists THEN the frontmatter declares the new section number and the generated contract includes it

### Task 3: Add the gate to optimera before worktree dispatch

**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN optimera with uncommitted artifact changes WHEN its dispatch step begins THEN pending artifact changes are committed before the worktree subagent is dispatched
▸ GIVEN optimera with a clean working tree WHEN its dispatch step begins THEN no checkpoint commit is created and dispatch proceeds normally
▸ GIVEN the checkpoint commit WHEN a hook rejects it THEN dispatch does not proceed and the skill reports the failure
▸ GIVEN optimera's spec_sections frontmatter WHEN the new section exists THEN the frontmatter declares the new section number and the generated contract includes it

### Task 4: Add linter check for the pre-dispatch commit gate

**Depends on**: Task 1
**Status**: pending
**Acceptance**:
▸ GIVEN a SKILL.md that contains worktree dispatch language WHEN the linter runs THEN it verifies the pre-dispatch commit gate instruction is present
▸ GIVEN a SKILL.md that does not dispatch to worktrees WHEN the linter runs THEN no gate check is performed
▸ GIVEN realisera and optimera after Tasks 2-3 WHEN the linter runs THEN both pass the new check with 0 errors

### Task 5: Add tests for the new linter check

**Depends on**: Task 4
**Status**: pending
**Acceptance**:
▸ GIVEN the new linter check WHEN tests run THEN 1 pass + 1 fail per testable unit (proportionality target: default)
▸ GIVEN all existing tests WHEN the full suite runs THEN no regressions

### Task 6: Version bump per DOCS.md convention

**Depends on**: Task 1, Task 2, Task 3, Task 4, Task 5
**Status**: pending
**Acceptance**:
▸ GIVEN the plan includes feat-level work (new spec section, new linter check) WHEN the plan completes THEN version files listed in DOCS.md are bumped per semver_policy (feat = minor)
▸ GIVEN the CHANGELOG WHEN the bump is applied THEN [Unreleased] entries are promoted to the new version heading

### Task 7: Plan-level freshness checkpoint

**Depends on**: Task 1, Task 2, Task 3, Task 4, Task 5, Task 6
**Status**: pending
**Acceptance**:
▸ GIVEN all prior tasks complete WHEN the freshness checkpoint runs THEN CHANGELOG.md, PROGRESS.md, and TODO.md are updated to reflect the plan's aggregate work
▸ GIVEN this plan WHEN it completes THEN PLAN.md is archived to .agentera/archive/

## Overall Acceptance

▸ GIVEN any skill that dispatches to worktrees WHEN the working tree has uncommitted artifact changes THEN those changes are committed before the worktree branches, ensuring the subagent sees current state
▸ GIVEN orkestrera dispatching realisera for a plan task WHEN realisera creates a worktree THEN the worktree contains all artifacts written by both orkestrera and realisera's own orient/plan steps
▸ GIVEN the spec and linter WHEN a new skill is created that dispatches to worktrees THEN the linter catches missing gate instructions

## Surprises

