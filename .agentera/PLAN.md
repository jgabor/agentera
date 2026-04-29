# Plan: Completed Optimera Objective Archival

<!-- Level: full | Created: 2026-04-29 | Status: active -->
<!-- Reviewed: 2026-04-29 | Critic issues: 15 found, 15 addressed, 0 dismissed -->

## What

Define and ship a completed-objective lifecycle for optimera. Closed objectives must stop looking active, while their measurement history remains readable and self-contained.

## Why

Hej and optimera can route back to objectives whose target is already met. That weakens the artifact graph because completed work keeps presenting itself as live work.

## Constraints

- Preserve self-contained objective directories under `.agentera/optimera/<name>/`.
- Do not add a registry, symlink, or fixed root objective mapping.
- Keep objective artifacts outside DOCS.md fixed artifact mapping.
- Do not change harness command execution, result parsing, or keep/discard semantics.
- Keep generated contracts aligned after SPEC.md changes.
- Apply DOCS.md versioning: fix work requires a patch release.
- Do not support reopening closed objectives in this plan.

## Scope

**In**: completed objective state, closure logging, active-objective inference, routing consumers, per-objective validation, regression coverage, docs, release metadata, freshness artifacts.
**Out**: new metrics, harness redesign, registry files, symlinks, root objective artifacts, closed-objective reopening, new skills.
**Deferred**: objective dashboard commands and richer cross-objective reporting.

## Design

Closed state lives inside each objective's own artifacts. `OBJECTIVE.md` carries a canonical closed status. `EXPERIMENTS.md` records closure with timestamp, final value, target, and reason. Optimera and routing consumers exclude closed objectives before recency-based active selection.

## Tasks

### Task 1: Define The Objective Closure Contract

**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN an objective reaches its target WHEN completion is evaluated THEN `OBJECTIVE.md` has canonical closed state.
▸ GIVEN an objective is closed WHEN history is inspected THEN `EXPERIMENTS.md` records timestamp, final value, target, and reason.
▸ GIVEN the contract is recorded WHEN artifact paths are described THEN no registry, symlink, or fixed root objective mapping appears.
▸ GIVEN SPEC.md changes WHEN contracts are checked THEN generated contracts are current.

### Task 2: Apply Closure In Optimera Workflow

**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN an already-met objective WHEN optimera starts THEN it records closure once and reports completion without another experiment.
▸ GIVEN an experiment meets the target WHEN optimera logs the result THEN it also records objective closure.
▸ GIVEN one or more objectives exist and all are closed WHEN optimera starts THEN it asks for a successor objective.
▸ GIVEN no objective directories exist WHEN optimera starts THEN it keeps the existing new-objective path.

### Task 3: Align Objective Routing Consumers

**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN closed and active objectives coexist WHEN a skill infers active optimization work THEN closed objectives are excluded first.
▸ GIVEN the existing `realisera-token` objective is closed WHEN routing runs THEN it is not selected as active.
▸ GIVEN a user explicitly names a closed objective WHEN optimera starts THEN it loads read-only and asks before successor work.
▸ GIVEN a closed objective has the newest history WHEN routing runs THEN an older active objective still wins.

### Task 4: Validate Per-Objective Artifacts

**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN a valid per-objective artifact changes WHEN artifact validation runs THEN structural checks pass without DOCS.md fixed mappings.
▸ GIVEN a malformed per-objective artifact changes WHEN artifact validation runs THEN required-heading failure is reported.
▸ GIVEN validator coverage is added WHEN the task completes THEN use 1 pass + 1 fail per validation unit.
▸ GIVEN compaction checks run WHEN `EXPERIMENTS.md` grows THEN variable objective paths are handled.

### Task 5: Cover Objective Inference Branches

**Depends on**: Task 2, Task 3
**Status**: ■ complete
**Acceptance**:
▸ GIVEN active, closed-newer, all-closed, no-objective, and ambiguous objective sets WHEN regression coverage runs THEN each branch matches the contract.
▸ GIVEN an objective is already closed WHEN optimera starts again THEN duplicate closure records are not appended.
▸ GIVEN inference tests are added WHEN scope is set THEN edge expansion is limited to the 3+ branch inference behavior.
▸ GIVEN existing validation runs WHEN tests finish THEN the suite reports no lifecycle regression.

### Task 6: Refresh Optimera Documentation

**Depends on**: Task 5
**Status**: □ pending
**Acceptance**:
▸ GIVEN docs mention optimera state WHEN refreshed THEN they describe `.agentera/optimera/<name>/OBJECTIVE.md`.
▸ GIVEN docs mention experiment history WHEN refreshed THEN they describe `.agentera/optimera/<name>/EXPERIMENTS.md`.
▸ GIVEN docs are refreshed WHEN reviewed THEN they do not imply root objective artifacts, registries, symlinks, or DOCS fixed mappings.
▸ GIVEN DOCS.md is updated WHEN coverage is inspected THEN test and artifact rows stay current.

### Task 7: Bump Patch Release Metadata

**Depends on**: Task 6
**Status**: □ pending
**Acceptance**:
▸ GIVEN the fix is complete WHEN version-bearing surfaces are inspected THEN DOCS.md version targets report the next patch version.
▸ GIVEN the changelog is updated WHEN readers inspect release notes THEN the completed-objective fix appears under Fixed.
▸ GIVEN a DOCS-listed target has no version field WHEN release metadata is checked THEN the omission is recorded.
▸ GIVEN release validation runs WHEN the task completes THEN version metadata is aligned.

### Task 8: Plan-Level Freshness Checkpoint

**Depends on**: Task 7
**Status**: □ pending
**Acceptance**:
▸ GIVEN all implementation tasks are complete WHEN freshness is checked THEN CHANGELOG.md, PROGRESS.md, and TODO.md summarize the plan outcome.
▸ GIVEN TODO.md is refreshed WHEN the completed-objective item is resolved THEN it moves to Resolved with commit evidence.
▸ GIVEN all tasks are complete WHEN normal plan completion runs THEN active plan is archived and removed.
▸ GIVEN validation runs WHEN the checkpoint completes THEN spec validation, contract freshness, artifact self-audit, and pytest pass.

## Overall Acceptance

▸ GIVEN a closed optimera objective exists WHEN hej or optimera looks for active work THEN completed work is not selected as active.
▸ GIVEN objective completion happens during an optimera cycle WHEN the cycle exits THEN closure is recorded in objective state and experiment history.
▸ GIVEN suite validators run WHEN the plan is finished THEN SPEC, generated contracts, docs, and tests agree on the lifecycle.

## Surprises

Empty; populated by realisera during execution when reality diverges from plan.
