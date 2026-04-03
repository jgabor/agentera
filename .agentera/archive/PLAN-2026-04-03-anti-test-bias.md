# Plan: Anti-test-bias hardening

<!-- Level: light | Created: 2026-04-03 | Status: active -->

## What

Address three test-generation bias gaps identified by inspirera analysis of the test-generation-bias report: dispatch prompt anti-bias, negative AC framing, and verify step reordering.

## Why

Decision 21 and ecosystem-spec Section 16 address test proportionality at the plan/audit layer. The bias report reveals the subagent dispatch, AC framing, and completion signal layers are still unmitigated. The model's test-centric priors (9 independent causes) need counterweights at each intervention point.

## Constraints

- Changes must pass the ecosystem linter (0 errors, 0 warnings)
- Minimal additions: one sentence per skill, not restructuring
- No em-dashes, no hard wraps

## Tasks

### Task 1: Add anti-bias constraint to orkestrera dispatch template
**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN orkestrera's dispatch template Constraints block WHEN an implementation task is dispatched THEN it includes a constraint telling the subagent not to write tests unless ACs require them
▸ GIVEN the ecosystem linter WHEN run THEN it reports 0 errors, 0 warnings

### Task 2: Add negative framing to planera proportionality guidance
**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN planera's test proportionality bullet WHEN read THEN it includes a negative constraint ("do NOT exceed" or equivalent) alongside the positive default rule
▸ GIVEN the ecosystem linter WHEN run THEN it reports 0 errors, 0 warnings

### Task 3: Reorder realisera verify step and rephrase dispatch constraint
**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN realisera's Step 6 verification list WHEN read THEN functional check appears before regression/test check
▸ GIVEN realisera's dispatch template WHEN read THEN the verify constraint emphasizes feature verification over test passage
▸ GIVEN the ecosystem linter WHEN run THEN it reports 0 errors, 0 warnings

## Surprises

