# Plan: Phase 3 — Integration

<!-- Level: full | Created: 2026-05-04 | Status: active -->
<!-- Reviewed: 2026-05-04 | Critic issues: 10 found, 4 addressed, 6 dismissed -->

## What

Wire Phase 1 infrastructure and Phase 2 capabilities together. Clean up stale v1 tests, verify cross-capability references resolve, expand the query CLI, configure runtime adapters, and update developer-facing docs.

## Why

Phases 1-2 built the parts but never connected them. The hook validates artifacts but has no tests for 5 of 9 schemas. 62 v1 tests fail. The query CLI doesn't cover all artifact types. Runtime adapters aren't configured. AGENTS.md still describes v1.

## Constraints

- No new capabilities or schemas
- Scripts use Python stdlib + pyyaml via uv inline script metadata
- v1 hook tests are removed, not rewritten (v2 has its own test file)
- All 688 currently passing tests must stay green
- 4 runtime targets: Claude Code, OpenCode, Codex, Copilot

## Scope

**In**: v1 test cleanup, cross-cap reference verification, CLI expansion, runtime adapters, hook test coverage, SKILL.md directory listing fix, AGENTS.md update
**Out**: Token benchmarking (Phase 4), semantic eval port (Phase 4), merge to main (Phase 4), new capabilities, schema changes
**Deferred**: Master SKILL.md thin optimization, v1 script migration, SPEC.md deletion

## Design

Integration work: no new architectural decisions. Each task connects existing pieces or removes dead v1 code. Tasks are mostly independent (T1, T2, T3, T4, T6 have no dependencies) to maximize parallelism during orchestration.

## Tasks

### Task 1: Stale v1 Test Cleanup

**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN the full test suite WHEN pytest runs THEN 0 tests fail (currently 62 fail in test_validate_artifact.py)
▸ GIVEN test_validate_artifact.py is removed or replaced WHEN the test suite runs THEN no v1-format hook tests remain
▸ GIVEN the test suite WHEN measured by test count THEN 688+ tests pass (no regression from cleanup)

### Task 2: Cross-Capability Reference Verification

**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN each of the 12 capability schemas WHEN their protocol.yaml stable ID references are extracted THEN all resolve to valid entries in protocol.yaml
▸ GIVEN the master SKILL.md routing WHEN each capability's trigger patterns are tested THEN each routes to the correct capability (not hej fallback)
▸ GIVEN inter-capability references in prose.md files (e.g., orkestrera references realisera, inspektera) WHEN checked THEN each referenced capability exists in capabilities/
▸ Test proportionality: 1 test per capability for routing, 1 test for protocol reference resolution

### Task 3: Query CLI Expansion

**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN the agentera query CLI WHEN invoked with each of the 9 artifact schema names THEN it returns valid data or a clear "no data" message
▸ GIVEN the agentera query CLI WHEN invoked with --list-artifacts THEN it lists all 9 artifact types from schema discovery
▸ GIVEN the existing 23 CLI tests WHEN re-run THEN all still pass
▸ Test proportionality: 1 test per artifact type for named query, 1 test for --list-artifacts

### Task 4: Runtime Adapter Configuration

**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN skills/agentera/.claude-plugin/plugin.json WHEN read THEN it contains valid Claude Code plugin metadata for the bundled skill
▸ GIVEN hooks/hooks.json WHEN read THEN it references the v2 hook at hooks/validate_artifact.py with correct event type
▸ GIVEN hooks/codex-hooks.json WHEN read THEN it references the v2 hook with correct Codex event format
▸ GIVEN the OpenCode plugin manifest WHEN read THEN it exists and references the bundled skill

### Task 5: Hook Verification Against v2 Artifact Schemas

**Depends on**: Task 1
**Status**: □ pending
**Acceptance**:
▸ GIVEN a valid YAML artifact matching each of the 9 artifact schemas WHEN the hook validates it THEN it exits 0
▸ GIVEN an invalid YAML artifact (missing required field) for each of the 9 schemas WHEN the hook validates it THEN it exits 2 with details on stderr
▸ GIVEN a non-artifact file path WHEN the hook validates it THEN it exits 0 immediately
▸ Test proportionality: 1 pass + 1 fail per artifact schema (18 tests), 1 test for non-artifact passthrough

### Task 6: SKILL.md and AGENTS.md Update

**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN the master SKILL.md directory structure example WHEN compared to actual capability schemas THEN it lists the correct file names (triggers.yaml, artifacts.yaml, validation.yaml, exit.yaml)
▸ GIVEN AGENTS.md WHEN read THEN it describes the v2 bundled skill model (not v1 per-directory skills)
▸ GIVEN AGENTS.md WHEN read THEN it references validate_capability.py (not validate_spec.py) and the capability directory structure

### Task 7: Plan-level Freshness Checkpoint

**Depends on**: Task 1, Task 2, Task 3, Task 4, Task 5, Task 6
**Status**: □ pending
**Acceptance**:
▸ GIVEN all prior tasks complete WHEN CHANGELOG.md is checked THEN it has an Added entry under [Unreleased] covering Phase 3 integration work
▸ GIVEN all prior tasks complete WHEN PROGRESS.md is checked THEN it has a cycle entry whose What field summarizes the Phase 3 plan completion
▸ GIVEN all prior tasks complete WHEN TODO.md is checked THEN any Phase 3 items have corresponding Resolved entries

## Overall Acceptance

▸ GIVEN the full test suite WHEN pytest runs THEN 0 failures
▸ GIVEN all 12 capabilities WHEN validate_capability.py runs against each THEN all pass
▸ GIVEN the query CLI WHEN each artifact type is queried THEN results are correct
▸ GIVEN the hook WHEN each artifact schema is tested THEN validation works for all 9 types

## Surprises

[Populated by realisera during execution when reality diverges from plan.]
