# Plan: Complete v1.20 Feature Parity Release

<!-- Level: full | Created: 2026-04-28 | Status: active -->
<!-- Reviewed: 2026-04-28 | Critic issues: 4 found, 4 addressed, 0 dismissed -->

## What

Close the remaining closeable cross-runtime parity gaps, publish an accurate parity reference, and fold local patch-release state into one `v1.20.0` release.

The final release keeps pushed branch history intact, resets the local `v1.20.0` tag to the final verified commit, and publishes main plus the tag.

## Why

agentera's vision is a portable agent engineering protocol. v1.20 should read as one coherent feature-parity release, not as split local patch metadata and contradictory docs.

## Constraints

- Preserve pushed remote history. `origin/main` already contains earlier v1.20 work through `03caca9`.
- Use fast-forward publishing only. No force-push unless the user separately asks.
- No remote `v1.20*` tag exists, so the final tag can be created at the release commit.
- Treat this as pre-tag release consolidation. Do not apply the normal patch-bump rule.
- Do not claim OpenCode model-visible preload unless a supported injection path is proven.
- Keep Python scripts stdlib-only and extend existing validator surfaces.
- Do not submit external aggregator PRs during this plan.

## Scope

**In**: Copilot pre-write artifact gate, OpenCode pre-write artifact gate, tracked feature parity reference, release docs, version metadata, validators, smoke tests, final tag, and fast-forward publish.

**Out**: Rewriting pushed branch history, upstream runtime changes, new runtime support, and aggregator submissions.

**Deferred**: OpenCode session-start preload remains deferred if no model-visible injection path is proven.

## Design

The work separates capability closure from release hygiene.

The adapter layer closes hard-gating gaps where host hooks support pre-write blocking. Copilot and OpenCode each get a proof gate before any docs claim parity.

The documentation layer turns the ignored parity comparison into a tracked reference and reconciles README, CHANGELOG, TODO, DOCS, and adapter prose.

The release layer folds all version surfaces back to `1.20.0`, verifies the final state, retags locally, then publishes only by fast-forward.

## Tasks

### Task 1: Copilot Artifact Validation Hard Gate

**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN a Copilot pre-write hook payload for an artifact edit WHEN candidate content can be reconstructed THEN invalid artifact content is denied before mutation.
▸ GIVEN a valid artifact edit or non-artifact edit WHEN the pre-write hook runs THEN the edit is allowed.
▸ GIVEN Copilot payload evidence is insufficient WHEN docs are updated THEN no hard-gate parity claim is made.
▸ GIVEN lifecycle validation runs WHEN Copilot hooks are checked THEN the shipped pre-write gate is required.
▸ Test cap: one allow and one deny per decision boundary, plus one malformed-payload edge case if parser branches exceed two.

### Task 2: OpenCode Artifact Validation Hard Gate

**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN an OpenCode pre-write hook payload for an artifact edit WHEN candidate content can be validated THEN invalid artifact content is blocked before mutation.
▸ GIVEN a valid artifact edit or non-artifact edit WHEN the hook runs THEN the edit continues.
▸ GIVEN session idle occurs WHEN the plugin handles events THEN SESSION.md bookmark behavior still works.
▸ GIVEN session created occurs WHEN no injection path is proven THEN it remains a documented no-op.
▸ Test cap: one allow, one deny, and one no-op smoke branch for the pre-write hook.

### Task 3: Tracked Feature Parity Reference

**Depends on**: Task 1, Task 2
**Status**: □ pending
**Acceptance**:
▸ GIVEN the parity comparison is release-relevant WHEN the repo is checked THEN it lives at a tracked adapter-reference path.
▸ GIVEN README and the parity reference are read WHEN runtime behavior is compared THEN Copilot, OpenCode, Codex, and Claude claims agree.
▸ GIVEN a capability remains degraded or blocked WHEN docs describe it THEN the runtime reason is explicit.
▸ GIVEN docs claim functional artifact-validation parity WHEN checked THEN every closeable hard-gate path is implemented and verified.

### Task 4: Single 1.20.0 Release Metadata

**Depends on**: Task 3
**Status**: □ pending
**Acceptance**:
▸ GIVEN version files are inspected WHEN the fold-down is complete THEN every suite version surface reads `1.20.0`.
▸ GIVEN CHANGELOG.md is read WHEN the fold-down is complete THEN there is one `1.20.0` section and no `1.20.1` section.
▸ GIVEN TODO.md and release-facing docs are searched WHEN complete THEN stale `1.20.1`, `1.21.0`, and `1.22.0` release claims are absent.
▸ GIVEN `.agentera/DOCS.md` is read WHEN complete THEN coverage and release index rows match the final verified test count.

### Task 5: Release Verification Surface

**Depends on**: Task 4
**Status**: □ pending
**Acceptance**:
▸ GIVEN validators run WHEN release verification executes THEN spec, lifecycle, and contract checks pass.
▸ GIVEN smoke checks run WHEN release verification executes THEN OpenCode syntax and bootstrap smoke pass.
▸ GIVEN pytest runs WHEN release verification executes THEN the full suite passes.
▸ GIVEN live host smoke is unavailable WHEN verification runs THEN it reports SKIP rather than failing the release.
▸ GIVEN hard-gate docs drift later WHEN lifecycle validation runs THEN the new Copilot and OpenCode claims are caught.

### Task 6: Plan-Level Freshness And Publish

**Depends on**: Task 5
**Status**: □ pending
**Acceptance**:
▸ GIVEN plan work is complete WHEN artifacts are read THEN PROGRESS, TODO, CHANGELOG, DOCS, and PLAN summarize the plan-level result.
▸ GIVEN the final commit is checked WHEN release publishing begins THEN the worktree is clean.
▸ GIVEN remote tags are checked WHEN publishing begins THEN no remote `v1.20*` tag conflicts.
▸ GIVEN the local `v1.20.0` tag exists WHEN finalizing THEN it points at the final verified commit.
▸ GIVEN publishing completes WHEN remote state is checked THEN origin main and `v1.20.0` resolve to the final verified commit.

## Overall Acceptance

▸ GIVEN v1.20 is inspected after publish WHEN version surfaces are checked THEN `1.20.0` is the only release identifier for this work.
▸ GIVEN artifact validation is compared across runtimes WHEN release docs are read THEN all closeable hard-gate paths are implemented or explicitly blocked.
▸ GIVEN OpenCode preload is read WHEN no model-visible injection path exists THEN it is marked deferred, not shipped.
▸ GIVEN package metadata, docs, and tests are checked WHEN verification completes THEN they agree on the final runtime behavior.
▸ GIVEN origin is checked after publishing WHEN tags and main are resolved THEN `v1.20.0` points at the final verified commit.

## Surprises

[Empty; populated by realisera during execution when reality diverges from plan]
