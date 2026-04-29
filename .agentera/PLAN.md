# Plan: Steelman-Informed Decision Pressure

<!-- Level: full | Created: 2026-04-29 | Status: active -->
<!-- Reviewed: 2026-04-29 | Critic issues: 10 found, 10 addressed, 0 dismissed -->

## What

Strengthen agentera's decision workflows with steelman-inspired pressure testing. Resonera should name blind spots, argue strong alternatives without sycophantic softening, reset for effort-justification bias, and capture alternatives with concrete win conditions. Planera and optimera should carry only the narrow effort-bias guard.

## Why

Agentera's north star depends on trust-legible autonomy. Decisions must resist momentum bias and agreeable drift while staying inside the existing deliberation graph.

## Constraints

- Keep resonera as the owner of structured deliberation.
- Do not add a steelman skill or lightweight skill packaging profile.
- Preserve existing `DECISIONS.md` confidence semantics.
- Keep decision entries compact and readable by current consumers.
- Limit adjacent skill changes to planera and optimera effort-bias guards.
- Do not change runtime adapters, marketplace packaging, or unrelated skill behavior.

## Scope

**In**: resonera pressure-testing rules, decision-template win conditions, effort-bias guards in planera and optimera, compatibility checks, versioning, freshness.
**Out**: new skills, lightweight skill profiles, runtime adapter changes, marketplace metadata redesign, broad anti-sycophancy rollout.
**Deferred**: anti-sycophancy hardening outside decision-producing workflows.

## Design

Add steelman patterns at the decision layer, not the suite architecture layer. Resonera gets blind-spot naming, non-softened alternatives, concrete win conditions, red-flag phrasing, and honest assessment discipline. Planera and optimera get only the reset against favoring options because they took more effort to construct. Existing artifact contracts stay the boundary; `DECISIONS.md` must remain readable by planning, building, inspection, profiling, optimization, and orchestration workflows.

## Tasks

### Task 1: Strengthen resonera pressure-testing behavior

**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN a user commits to a consequential direction WHEN resonera challenges it THEN it names context-specific blind spots before alternatives.
▸ GIVEN resonera presents alternatives WHEN it advocates them THEN each one uses project context and avoids reassurance closes or false neutrality.
▸ GIVEN uncertainty matters WHEN resonera makes its call THEN confidence stays explicit instead of hidden behind softened language.
▸ GIVEN red-flag phrasing could weaken the challenge WHEN resonera documents its discipline THEN concrete banned examples are listed.

### Task 2: Add concrete win conditions to decision capture

**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN existing decision readers consume `DECISIONS.md` WHEN template changes are considered THEN affected readers are checked before the template is changed.
▸ GIVEN resonera logs serious alternatives WHEN a decision entry is produced THEN each serious alternative includes a concrete win condition unless the user rejects it.
▸ GIVEN win conditions are present WHEN consumers read the entry THEN question, context, choice, reasoning, confidence, and feeds remain intact.
▸ GIVEN the template guides a new decision WHEN alternatives are listed THEN the win-condition shape is visible.

### Task 3: Apply narrow effort-bias guards to adjacent workflows

**Depends on**: Task 1
**Status**: □ pending
**Acceptance**:
▸ GIVEN planera evaluates options before writing a plan WHEN one option required more reasoning effort THEN effort is not treated as evidence.
▸ GIVEN optimera evaluates experiment approaches WHEN one hypothesis took more effort to construct THEN the choice is reset before selection.
▸ GIVEN these guards are added WHEN skill text is reviewed THEN they create no new modes, steps, or artifacts.
▸ GIVEN shared decision semantics are reviewed WHEN these guards land THEN `SPEC.md` is updated or explicitly left unchanged with evidence.

### Task 4: Validate contract compatibility

**Depends on**: Tasks 1-3
**Status**: □ pending
**Acceptance**:
▸ GIVEN updated skill definitions WHEN spec validation runs THEN the suite reports no new contract errors.
▸ GIVEN current decision entries exist WHEN compatibility is checked THEN current entries remain accepted by decision artifact validation.
▸ GIVEN validation behavior changes WHEN tests are added THEN use 1 pass and 1 fail per testable unit.
▸ GIVEN no validation behavior changes WHEN tests are reviewed THEN existing coverage is named as sufficient.

### Task 5: Bump release metadata

**Depends on**: Task 4
**Status**: □ pending
**Acceptance**:
▸ GIVEN the plan adds decision-workflow behavior WHEN version metadata is updated THEN the next minor release is represented consistently.
▸ GIVEN version targets are listed in `DOCS.md` WHEN the bump is complete THEN listed metadata surfaces agree.
▸ GIVEN version metadata changed WHEN validation runs THEN version consistency has no new findings.

### Task 6: Plan-level freshness checkpoint

**Depends on**: Task 5
**Status**: □ pending
**Acceptance**:
▸ GIVEN all implementation tasks are complete WHEN the checkpoint runs THEN `CHANGELOG.md` summarizes the plan-level change.
▸ GIVEN all implementation tasks are complete WHEN the checkpoint runs THEN `PROGRESS.md` records the aggregate plan outcome.
▸ GIVEN all implementation tasks are complete WHEN the checkpoint runs THEN `TODO.md` has no stale open entries for this plan.
▸ GIVEN freshness artifacts are updated WHEN final validation runs THEN the plan closes with no new validation failures.

## Overall Acceptance

▸ GIVEN a consequential decision is being deliberated WHEN resonera runs THEN it pressure-tests the committed direction without sycophantic drift.
▸ GIVEN a decision is recorded WHEN alternatives matter THEN win conditions make the tradeoff testable later.
▸ GIVEN adjacent planning or optimization flows choose among constructed options WHEN effort bias could skew judgment THEN the skill text requires a reset.
▸ GIVEN the plan completes WHEN suite validation runs THEN no new contract drift is present.

## Surprises

[Empty; populated by realisera during execution when reality diverges from plan]
