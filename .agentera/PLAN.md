# Plan: Plan-Relative Staleness Detection (ISS-34)

<!-- Level: full | Created: 2026-04-03 | Status: active -->
<!-- Reviewed: 2026-04-03 | Critic issues: 1 found, 1 addressed, 0 dismissed -->

## What

After each plan cycle, orkestrera flags plan-relevant artifacts that dispatched skills should have updated but didn't since the plan started. This replaces the fixed 14-day threshold with plan-scoped detection tied to meaningful project milestones.

## Why

Stale artifacts mislead routing decisions. A fixed time threshold (14 days) is too coarse for high-velocity projects (77 cycles in 5 days in this repo). Plan-relative detection ties the clock to what actually happened: which skills ran and what they should have produced. If realisera was dispatched 3 times but PROGRESS.md is untouched since the plan started, that's a real signal worth surfacing.

## Constraints

- No phase enforcement in SKILL.md files (Decision 22 is firm on this)
- Linter must pass after every task touching SKILL.md or ecosystem-spec.md
- Test proportionality per Decision 21 applies to any test tasks
- No version bump (feat work under development)
- Standalone skill operation must not be impaired

## Scope

**In**: ecosystem-spec.md skill-to-artifact mapping and staleness convention, orkestrera SKILL.md staleness check step, inspektera SKILL.md plan-context staleness capability, hej SKILL.md threshold update
**Out**: phase enforcement in SKILL.md files, new audit dimensions, test tasks, version bumps, template changes (no templates reference 14-day threshold)
**Deferred**: inspektera standalone staleness dimension (when no plan context exists)

## Design

The ecosystem-spec gains a skill-to-expected-artifact mapping (derivable from Section 4 format contracts but made explicit for staleness checks) and a staleness convention defining plan-relative detection. Orkestrera adds a step between plan completion and new plan cycle that checks which dispatched skills failed to update their expected artifacts since the plan's creation date. Inspektera gains the ability to receive plan context during health checks and evaluate artifact freshness relative to plan start. Hej drops the hardcoded 14-day threshold in favor of referencing plan-relative staleness when plan context exists.

## Tasks

### Task 1: Define staleness convention and skill-to-artifact mapping in ecosystem-spec
**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN ecosystem-spec.md WHEN reading Section 18 THEN a staleness convention defines plan-relative detection with skill-to-expected-artifact mapping
▸ GIVEN the mapping WHEN looking up any dispatched skill THEN expected artifact outputs are listed
▸ GIVEN the convention WHEN reading fallback behavior THEN a sensible default exists for when no plan context is available
▸ GIVEN the ecosystem linter WHEN run THEN 0 errors, 0 warnings

### Task 2: Add staleness check step to orkestrera
**Depends on**: Task 1
**Status**: □ pending
**Acceptance**:
▸ GIVEN orkestrera SKILL.md WHEN a plan completes (all tasks done) THEN a staleness check runs before the new plan cycle
▸ GIVEN the staleness check WHEN comparing dispatched skills against their expected artifacts THEN artifacts not updated since plan start are flagged
▸ GIVEN flagged stale artifacts WHEN proceeding to the next plan THEN the staleness findings are included as context for the new plan
▸ GIVEN the ecosystem linter WHEN run THEN 0 errors, 0 warnings

### Task 3: Add plan-context staleness to inspektera
**Depends on**: Task 1
**Status**: □ pending
**Acceptance**:
▸ GIVEN inspektera dispatched with plan context WHEN evaluating artifact freshness THEN staleness is measured relative to plan start date
▸ GIVEN inspektera without plan context WHEN evaluating artifact freshness THEN a sensible fallback applies
▸ GIVEN the ecosystem linter WHEN run THEN 0 errors, 0 warnings

### Task 4: Update hej stale artifact reference
**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN hej SKILL.md attention items WHEN referencing stale artifacts THEN no hardcoded 14-day threshold appears
▸ GIVEN hej with plan context available WHEN surfacing staleness THEN it references plan-relative staleness
▸ GIVEN the ecosystem linter WHEN run THEN 0 errors, 0 warnings

## Overall Acceptance

▸ GIVEN orkestrera completing a plan WHEN dispatched skills didn't update expected artifacts THEN staleness is flagged before the next plan cycle
▸ GIVEN the ecosystem WHEN searching for "14 days" or ">14" THEN no hardcoded staleness threshold remains in active skill files
▸ GIVEN the ecosystem linter WHEN run against all skills THEN 0 errors, 0 warnings
▸ GIVEN all skill files WHEN reading staleness references THEN they point to the ecosystem-spec convention

## Surprises
