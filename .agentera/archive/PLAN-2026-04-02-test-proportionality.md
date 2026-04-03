# Plan: Test proportionality convention

<!-- Level: light | Created: 2026-04-02 | Status: active -->

## What

Encode Decision 21 (test proportionality for autonomous plans) into the ecosystem spec and the two skills it affects: planera and inspektera.

## Why

The first orkestrera test plan produced 123 new tests without a volume constraint. Decision 21 established the rule: one pass + one fail per unit by default, edge cases only for complex logic. This needs to land in the spec (authority), planera (where ACs are written), and inspektera (where proportionality is evaluated).

## Constraints

- Changes must pass the ecosystem linter (0 errors, 0 warnings)
- Spec update defines the convention; skill updates reference it
- No behavioral changes to existing tests

## Tasks

### Task 1: Add test proportionality convention to ecosystem-spec.md
**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN ecosystem-spec.md WHEN the test proportionality section is read THEN it defines the default rule (one pass + one fail per unit, edge cases only for complex logic) and explains when to override
▸ GIVEN the ecosystem linter WHEN run THEN it reports 0 errors, 0 warnings

### Task 2: Update planera to encode test budgets in acceptance criteria
**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN planera's SKILL.md WHEN a plan includes test tasks THEN the planning guidance instructs including a proportionality target in acceptance criteria
▸ GIVEN the ecosystem linter WHEN run THEN it reports 0 errors, 0 warnings

### Task 3: Update inspektera to evaluate test proportionality
**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN inspektera's SKILL.md WHEN test health is assessed THEN the audit guidance includes checking test proportionality against the ecosystem-spec convention
▸ GIVEN the ecosystem linter WHEN run THEN it reports 0 errors, 0 warnings

## Surprises

