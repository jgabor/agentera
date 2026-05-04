# Plan: Agentera 2.0 Phase 2 -- Capability Ports

<!-- Level: full | Created: 2026-05-04 | Status: active -->
<!-- Reviewed: 2026-05-04 | Critic issues: 4 found, 1 addressed, 3 dismissed | Revised: split quality loop into two tasks for size balance -->

## What

Port all 12 v1 SKILL.md files (4,521 lines) into the v2 capability model. Each capability gets `prose.md` (behavioral instructions) and `schemas/` (YAML groups with stable IDs). All ports validate against `capability_schema_contract.yaml`. Master SKILL.md routing discovers new triggers automatically.

## Why

Phase 1 built the skeleton (schema contract, protocol, artifact schemas, CLI, migration tool, hook). Phase 2 fills it with behavior. Without ported capabilities, the v2 bundle is infrastructure with no behavioral content. This is the largest single phase in the ROADMAP.

## Constraints

- D39 (firm): single bundled skill, 12 capabilities, big bang cutover from feat/v2
- D40 (firm): YAML artifacts, capabilities naming, no backward compat
- VISION.md: token efficiency is a design constraint, feedback loop is the product
- All work on feat/v2 branch; v1 system on main untouched
- Each capability must pass `uv run scripts/validate_capability.py capabilities/<name>`
- V1 scripts and references stay at their v1 locations; prose.md references them by current path
- SPEC.md references replaced with protocol.yaml primitive references during port

## Scope

**In**: Porting all 12 capabilities (prose.md + schemas/), contract validation, routing integration tests
**Out**: Cross-capability dependency resolution (Phase 3), hook integration (Phase 3), query CLI expansion (Phase 3), runtime adapter updates (Phase 3), v1 test porting (Phase 3), token benchmarking (Phase 4), v1 script migration (Phase 3), SPEC.md deletion (Phase 4)
**Deferred**: Master SKILL.md thin optimization (measure after all ports), third-party extensibility

## Design

Each port follows the same decomposition pattern:

1. Read the v1 SKILL.md, separate behavioral instructions from structural contracts
2. Write `prose.md` with workflow steps, personality, safety rails, examples. Replace SPEC.md references with protocol.yaml references. Preserve v1 script/reference paths.
3. Write `schemas/` with 4 required groups using GROUP_PREFIX convention (T/A/V/E) and stable IDs. Reference protocol.yaml primitives by stable ID.
4. Validate against capability_schema_contract.yaml
5. Test contract validation, routing pickup, and protocol reference resolution

Capabilities grouped by functional cluster. Each cluster ports together because capabilities share cross-references. hej ports first as pattern proof; subsequent tasks follow the established template.

## Tasks

### Task 1: hej Port + Pattern Proof

**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN the hej capability directory WHEN validate_capability.py runs THEN all contract checks pass (directory structure, required groups, numbered entries, stable IDs)
▸ GIVEN the hej prose.md WHEN read THEN it contains the orientation workflow (detect state, brief, route), safety rails, and exit vocabulary
▸ GIVEN the hej schemas TRIGGERS group WHEN read THEN it contains patterns matching hej's v1 trigger vocabulary
▸ GIVEN the hej schemas ARTIFACTS group WHEN read THEN it lists all artifacts hej reads and produces
▸ GIVEN the master SKILL.md routing WHEN a message matches a hej trigger THEN it routes to capabilities/hej/prose.md
▸ GIVEN the master SKILL.md routing WHEN a message matches no capability THEN it falls back to hej
▸ Test proportionality: 1 pass + 1 fail for contract validation, 1 pass for routing pickup, 1 pass for fallback

### Task 2: Core Development Loop (realisera, resonera, planera)

**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN each of the three capability directories WHEN validate_capability.py runs THEN all contract checks pass for each
▸ GIVEN each capability's prose.md WHEN read THEN it contains the full v1 workflow steps, safety rails, and cross-capability references
▸ GIVEN each capability's TRIGGERS group WHEN read THEN it contains patterns matching the v1 trigger vocabulary
▸ GIVEN each capability's ARTIFACTS group WHEN read THEN it lists all artifacts the capability reads and writes
▸ GIVEN the master SKILL.md routing WHEN a message matches any of the three capabilities' triggers THEN it routes to the correct one
▸ GIVEN each ported capability's schemas WHEN protocol.yaml primitive references are checked THEN all references resolve to valid protocol entries
▸ Test proportionality: 1 pass + 1 fail per capability for contract validation, 1 pass per capability for routing

### Task 3: Quality (inspektera, optimera)

**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN each of the two capability directories WHEN validate_capability.py runs THEN all contract checks pass for each
▸ GIVEN each capability's prose.md WHEN read THEN it contains the full v1 workflow steps, safety rails, and cross-capability references
▸ GIVEN each capability's TRIGGERS group WHEN read THEN it contains patterns matching the v1 trigger vocabulary
▸ GIVEN each capability's ARTIFACTS group WHEN read THEN it lists all artifacts the capability reads and writes
▸ GIVEN the master SKILL.md routing WHEN a message matches any of the two capabilities' triggers THEN it routes to the correct one
▸ GIVEN each ported capability's schemas WHEN protocol.yaml primitive references are checked THEN all references resolve to valid protocol entries
▸ Test proportionality: 1 pass + 1 fail per capability for contract validation, 1 pass per capability for routing

### Task 4: Orchestration (orkestrera)

**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN the orkestrera capability directory WHEN validate_capability.py runs THEN all contract checks pass
▸ GIVEN the orkestrera prose.md WHEN read THEN it contains the conductor workflow (plan dispatch, evaluation gating, retry handling), safety rails, and cross-capability references
▸ GIVEN the orkestrera TRIGGERS group WHEN read THEN it contains patterns matching the v1 trigger vocabulary
▸ GIVEN the orkestrera ARTIFACTS group WHEN read THEN it lists all artifacts orkestrera reads and writes
▸ GIVEN the master SKILL.md routing WHEN a message matches an orkestrera trigger THEN it routes to capabilities/orkestrera/prose.md
▸ GIVEN orkestrera's schemas WHEN protocol.yaml primitive references are checked THEN all references resolve to valid protocol entries
▸ Test proportionality: 1 pass + 1 fail for contract validation, 1 pass for routing

### Task 5: Creative (visionera, visualisera, dokumentera)

**Depends on**: Task 1
**Status**: □ pending
**Acceptance**:
▸ GIVEN each of the three capability directories WHEN validate_capability.py runs THEN all contract checks pass for each
▸ GIVEN each capability's prose.md WHEN read THEN it contains the full v1 workflow steps, safety rails, and cross-capability references
▸ GIVEN each capability's TRIGGERS group WHEN read THEN it contains patterns matching the v1 trigger vocabulary
▸ GIVEN each capability's ARTIFACTS group WHEN read THEN it lists all artifacts the capability reads and writes
▸ GIVEN the master SKILL.md routing WHEN a message matches any of the three capabilities' triggers THEN it routes to the correct one
▸ GIVEN each ported capability's schemas WHEN protocol.yaml primitive references are checked THEN all references resolve to valid protocol entries
▸ Test proportionality: 1 pass + 1 fail per capability for contract validation, 1 pass per capability for routing

### Task 6: Analytics (profilera, inspirera)

**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN each of the two capability directories WHEN validate_capability.py runs THEN all contract checks pass for each
▸ GIVEN each capability's prose.md WHEN read THEN it contains the full v1 workflow steps, safety rails, and cross-capability references
▸ GIVEN each capability's TRIGGERS group WHEN read THEN it contains patterns matching the v1 trigger vocabulary
▸ GIVEN each capability's ARTIFACTS group WHEN read THEN it lists all artifacts the capability reads and writes
▸ GIVEN the master SKILL.md routing WHEN a message matches any of the two capabilities' triggers THEN it routes to the correct one
▸ GIVEN each ported capability's schemas WHEN protocol.yaml primitive references are checked THEN all references resolve to valid protocol entries
▸ Test proportionality: 1 pass + 1 fail per capability for contract validation, 1 pass per capability for routing

### Task 7: Plan-level Freshness Checkpoint

**Depends on**: Task 1, Task 2, Task 3, Task 4, Task 5, Task 6
**Status**: □ pending
**Acceptance**:
▸ GIVEN all prior tasks complete WHEN CHANGELOG.md is checked THEN it has an Added entry under [Unreleased] covering Phase 2 capability ports
▸ GIVEN all prior tasks complete WHEN PROGRESS.md is checked THEN it has a cycle entry whose What field summarizes the Phase 2 plan completion
▸ GIVEN all prior tasks complete WHEN TODO.md is checked THEN any Phase 2 items have corresponding Resolved entries

## Overall Acceptance

▸ GIVEN all 12 capabilities ported WHEN validate_capability.py runs against each THEN all pass contract validation
▸ GIVEN all 12 capabilities ported WHEN the master SKILL.md routing is tested with each capability's trigger patterns THEN all route correctly
▸ GIVEN all 12 capabilities ported WHEN their schemas are checked for protocol.yaml references THEN all references resolve

## Surprises

[Populated by realisera during execution when reality diverges from plan.]
