# Plan: [Short Title]

<!-- Level: light | full · Created: YYYY-MM-DD · Status: active | complete | discarded -->
<!-- Reviewed: YYYY-MM-DD | Critic issues: N found, N addressed, N dismissed -->

## What
[Description of the change: what is being built or changed]

## Why
[Motivation: what value it delivers, what problem it solves, how it relates to the vision]

## Constraints
- [What must NOT break]
- [What's out of scope]
- [Non-functional requirements]

## Scope
**In**: [what's included in this plan]
**Out**: [what's explicitly excluded]
**Deferred**: [what's saved for a future plan]

## Design
[High-level approach: which modules are affected, how they interact, key architectural decisions. NOT implementation details: no function names, no line numbers, no pseudocode.]

## Tasks

### Task 1: [Title]
**Depends on**: none
**Status**: □ pending | ■ complete | skipped
**Acceptance**:
- GIVEN [context] WHEN [action] THEN [expected outcome]
- GIVEN [context] WHEN [action] THEN [expected outcome]

### Task 2: [Title]
**Depends on**: Task 1
**Status**: □ pending | ■ complete | skipped
**Acceptance**:
- GIVEN [context] WHEN [action] THEN [expected outcome]
- GIVEN [context] WHEN [action] THEN [expected outcome]

## Overall Acceptance
- GIVEN [context] WHEN [action] THEN [expected outcome]
- GIVEN [context] WHEN [action] THEN [expected outcome]

## Surprises
[Populated by realisera during execution when reality diverges from plan.
Each entry: cycle number, what was expected, what actually happened, impact on plan.]

<!--
Level guide:
  light : Omit: Scope, Design, Tasks (use only top-level acceptance criteria for one cycle)
  full  : Include all sections. 3-8 tasks, each sized for one realisera cycle.

Task status:
  □ pending   : not started, dependencies may or may not be met
  ■ complete  : acceptance criteria verified, committed
  ▨ blocked   : dependencies unmet or external blocker
  ▣ in-progress : active in current cycle
  skipped     : no longer viable given current codebase state (note why)

Acceptance criteria format:
  GIVEN [precondition/context]
  WHEN [action or event]
  THEN [observable outcome in domain language]

  Good: GIVEN a user with no saved addresses WHEN they complete checkout THEN they are prompted to save the address
  Bad:  GIVEN UserService.getAddresses() returns [] WHEN POST /api/checkout is called THEN response includes saveAddressPrompt: true

Archival:
  When all tasks are complete or the plan is discarded, move this file to
  .agentera/archive/PLAN-{date}.md.
-->
