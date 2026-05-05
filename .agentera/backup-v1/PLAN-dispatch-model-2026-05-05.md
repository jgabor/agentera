# Plan: Implement Decision 42 Five-Layer Dispatch Model

<!-- Level: full | Created: 2026-05-05 | Status: active -->
<!-- Reviewed: 2026-05-05 | Critic issues: 4 found, 3 addressed, 1 dismissed -->

## What

Implement the five-layer dispatch model from Decision 42 in `skills/agentera/SKILL.md` and capability trigger schemas. Fix all residual v1 patterns that contradict the v2 single-entry-point model. Produce a comprehensive gap analysis against ROADMAP.md and Decisions 39-42.

## Why

Decision 42 (firm confidence, 2026-05-04) defines how `/agentera` routes requests across the 12 capabilities. The current implementation has generic pattern-matching only — no state-aware heuristics, no confidence thresholds, no disambiguation, and no capability-name bypass. This creates misrouting risk and contradicts the "one entry point, deep capabilities" principle from VISION.md.

## Constraints

- No breaking changes to the capability schema contract or protocol.yaml
- All 500+ tests must continue to pass
- The master SKILL.md should not grow into a God Object; heuristics live in hej prose, SKILL.md delegates
- Changes must work across all 4 runtime targets (Claude Code, OpenCode, Codex, Copilot)

## Scope

**In**: SKILL.md routing logic, trigger schema priority fields, disambiguation specification, hej prose cleanup, stale reference fixes, comprehensive gap analysis
**Out**: Runtime-specific implementations, query CLI changes, new capabilities, token re-benchmarking
**Deferred**: Hooks/common.py YAML artifact awareness, session_stop.py v2 migration, YAML/MD plan duality resolution

## Design

Decision 42's five layers are implemented as follows:

1. **Layer 1 (bare `/agentera`)**: SKILL.md explicitly delegates to hej. Hej's existing heuristic tree (Step 1b) becomes the canonical state-aware routing logic. No duplication in SKILL.md.
2. **Layer 2 (`/agentera <name>`)**: SKILL.md routing logic adds an explicit bypass: if the request matches a capability name (case-insensitive), route directly without evaluating NL triggers.
3. **Layer 3 (NL high-confidence)**: Trigger schemas gain a `priority` field (high/medium/low). SKILL.md sums matched priorities and requires a minimum threshold before routing to a non-hej capability.
4. **Layer 4 (borderline)**: When multiple capabilities match within one priority tier, SKILL.md specifies a disambiguation prompt instead of silent selection.
5. **Layer 5 (fallback)**: Already implemented — no match routes to hej.

## Tasks

### Task 1: Delegate Bare /agentera to Hej with Explicit State-Aware Heuristics

**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN SKILL.md WHEN read THEN the Routing Logic section explicitly states that bare `/agentera` (no additional text) is delegated to hej for state-aware routing
▸ GIVEN hej prose.md WHEN read THEN Step 1b's priority order (active PLAN → health → OBJECTIVE → TODO → DECISIONS → planera → visionera) is preserved and clarified as the Layer 1 heuristic tree
▸ GIVEN the full test suite WHEN pytest runs THEN 0 failures

### Task 2: Implement Capability-Name Direct Route Bypass

**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN SKILL.md WHEN read THEN the Routing Logic section contains an explicit rule: "If the request exactly matches a capability name (case-insensitive), route directly to that capability without evaluating trigger patterns"
▸ GIVEN the routing logic WHEN a user types `/agentera resonera` THEN the request bypasses NL matching and routes directly to resonera
▸ GIVEN the full test suite WHEN pytest runs THEN 0 failures

### Task 3: Add Confidence Scoring and Disambiguation to Trigger Schemas and Routing

**Depends on**: Task 2
**Status**: ■ complete
**Acceptance**:
▸ GIVEN all 12 triggers.yaml files WHEN read THEN each trigger entry has a `priority` field with value high, medium, or low
▸ GIVEN SKILL.md WHEN read THEN the routing logic requires a minimum priority threshold (medium or higher) before routing to a non-hej capability
▸ GIVEN SKILL.md WHEN read THEN the routing logic specifies a disambiguation prompt for cases where multiple capabilities match at the same priority tier
▸ GIVEN the validate_capability.py script WHEN run against any capability THEN it validates the priority field in triggers.yaml
▸ Test proportionality: 1 pass + 1 fail per capability for trigger schema validation; 1 pass for routing logic specification

### Task 4: Fix Stale References and v1 Contradictions

**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN hej prose.md WHEN read THEN the "Getting started" section shows `/agentera` (not `/hej`) as the primary invocation
▸ GIVEN hej prose.md WHEN read THEN the welcome capability table shows capability names without leading slashes (e.g., "visionera" not "/visionera")
▸ GIVEN SKILL.md WHEN read THEN all `.agentera/DOCS.md` references are replaced with `.agentera/docs.yaml`
▸ GIVEN hej prose.md WHEN read THEN the artifact path resolution guidance distinguishes human-facing (root .md) from agent-facing (.agentera/*.yaml) artifacts
▸ GIVEN the full test suite WHEN pytest runs THEN 0 failures

### Task 5: Comprehensive Gap Analysis Against ROADMAP.md and Decisions 39-42

**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN the gap analysis document WHEN read THEN it lists every ROADMAP.md checklist item marked complete and verifies whether it is actually implemented
▸ GIVEN the gap analysis document WHEN read THEN it maps each requirement from Decisions 39, 40, 41, and 42 to the specific file/line where it is implemented or notes the gap
▸ GIVEN the gap analysis document WHEN read THEN it identifies any contradictions between decisions (e.g., D42 says heuristics in SKILL.md but ROADMAP says thin dispatcher)
▸ GIVEN the gap analysis document WHEN read THEN it produces a prioritized backlog of remaining work with severity ratings

### Task 6: Plan-Level Freshness Checkpoint

**Depends on**: Task 1, Task 2, Task 3, Task 4, Task 5
**Status**: ■ complete
**Acceptance**:
▸ GIVEN all prior tasks complete WHEN CHANGELOG.md is checked THEN it has an [Unreleased] entry covering the Decision 42 implementation
▸ GIVEN all prior tasks complete WHEN .agentera/progress.yaml is checked THEN it has a cycle entry summarizing the plan completion
▸ GIVEN all prior tasks complete WHEN .agentera/plan.yaml is checked THEN this plan's tasks are marked complete

## Overall Acceptance

▸ GIVEN the implementation WHEN a user types `/agentera` THEN hej provides a state-aware briefing with routing suggestions
▸ GIVEN the implementation WHEN a user types `/agentera resonera` THEN the request routes directly to resonera without NL evaluation
▸ GIVEN the implementation WHEN a user types `/agentera help me think through this` THEN resonera is routed to with high confidence
▸ GIVEN the implementation WHEN a user types `/agentera help me think through how to build this` THEN a disambiguation prompt is presented (resonera vs planera)
▸ GIVEN the implementation WHEN the full test suite runs THEN 507+ tests pass with 0 failures
▸ GIVEN the implementation WHEN the gap analysis is complete THEN no unaddressed gaps remain in Decisions 39-42 or ROADMAP.md

## Surprises

[Empty; populated by realisera during execution when reality diverges from plan.]
