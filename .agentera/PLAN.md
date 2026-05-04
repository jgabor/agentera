# Plan: Agentera 2.0 Phase 1 -- Infrastructure

<!-- Level: full | Created: 2026-05-04 | Status: active -->
<!-- Reviewed: 2026-05-04 | Critic issues: 12 found, 10 addressed, 2 dismissed | Revised: adopted self-referential schemas, grouped schema structure, stable IDs, agentera prime -->

## What

Build the foundational infrastructure for Agentera 2.0: capability schema contract, shared protocol schema, agent-facing artifact schemas in YAML, query CLI scaffold, migration tool, and hook rewrite. Creates the skeleton that Phase 2 (capability ports) depends on.

## Why

Decision 39 committed to a single bundled skill with schema-backed capabilities. Decision 40 resolved YAML artifacts, capabilities naming, and no backward compat. Phase 1 builds the contract layer and tooling that makes the 2.0 architecture operational. Without schemas and the query CLI, capabilities have no validation contract and no interface to project state.

## Constraints

- D39 (firm): single bundled skill, 12 capabilities, big bang cutover from feat/v2
- D40 (firm): YAML for all agent-facing artifacts, "capabilities" naming, no backward compat
- VISION.md: token efficiency is a design constraint, feedback loop is the product
- Must not break the existing v1 system on main (all work on feat/v2)
- Scripts use Python stdlib + pyyaml via uv inline script metadata (`uv run`)
- 4 runtime targets: Claude Code, OpenCode, Codex, Copilot
- SPEC.md stays in repo during Phase 1; deleted on feat/v2 merge to main
- Cutover plan and merge criteria deferred to Phase 4

## Scope

**In**: Schema definitions, query CLI scaffold, migration tool, hook rewrite, master SKILL.md stub
**Out**: Capability prose ports (Phase 2), runtime adapter updates (Phase 3), test porting (Phase 3), token benchmarking (Phase 4), SPEC.md deletion
**Deferred**: Master SKILL.md size optimization, third-party extensibility, rollback tooling beyond backup-by-default

## Design

Schema-first approach. Define the contract (what a capability schema looks like), then derive everything else from it. The shared protocol schema defines primitives (confidence, severity, visual tokens, phases) that all capability schemas reference. Artifact schemas define the YAML shape for each agent-facing file type. The query CLI reads these schemas to know how to parse and query artifacts. The migration tool converts v1 Markdown to v2 YAML using the artifact schemas. The hook validates writes against the matching artifact schema.

Three structural patterns adopted for all schemas:

1. **Self-referential schema**: The capability schema contract is itself a valid capability schema. The schema that defines "what a valid capability looks like" validates against its own rules. Single source of truth that proves its own correctness.

2. **Component/constraint grouping with stable IDs**: Schema fields are organized into UPPER_CASE groups (TRIGGERS, ARTIFACTS, VALIDATION, EXIT_CONDITIONS) with numbered entries. Each entry has a stable ID that survives renames. Cross-capability references use these IDs (e.g., realisera's ARTIFACTS_PRODUCED.1 references hej's ARTIFACTS_CONSUMED.3).

3. **Deprecation over deletion**: When a schema field changes, the old ID gets `deprecated: true` and `replaced_by: [new-id]` instead of being removed. This preserves referential integrity for the hook and query CLI across schema evolution.

The hook reuses existing adapter JSON parsing logic from v1's validate_artifact.py (it already handles all 4 runtime formats). The rewrite replaces the validation backend (schemas instead of hardcoded contracts), not the adapter parsing.

The query CLI includes an `agentera prime` command that prints a static guidance blob teaching the agent when to use agentera commands vs native read/grep. Takes no arguments, identical output every invocation. Pattern borrowed from the `leda prime` command in the leda dependency-graph CLI.

Migration tool creates backups by default (copies v1 artifacts to .agentera/backup-v1/ before conversion).

## Tasks

### Task 1: Capability Schema Contract + Master SKILL.md Stub

**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN a capability directory with prose.md and schemas/ WHEN a validator checks the directory THEN it confirms all required groups are present (TRIGGERS, ARTIFACTS, VALIDATION, EXIT_CONDITIONS) ✓ verified: /tmp/test-capability passes, /tmp/test-bad-groups fails with group-specific errors
▸ GIVEN a capability schema YAML file WHEN parsed THEN each group contains numbered entries with stable IDs, and entries can carry `deprecated` and `replaced_by` flags for schema evolution ✓ verified: contract YAML has numbered entries with IDs (T1-T4, A1-A4, V1-V6, E1-E5), deprecation + replaced_by tested
▸ GIVEN the capability schema contract file itself WHEN validated against its own rules THEN it passes (self-referential: the schema is a valid instance of itself) ✓ verified: `uv run scripts/validate_capability.py --self-validate` exits 0
▸ GIVEN the ROADMAP target architecture diagram WHEN the schema contract is defined THEN the directory structure (skills/agentera/capabilities/<name>/schemas/) matches exactly ✓ verified: skills/agentera/{SKILL.md, capability_schema_contract.yaml, capabilities/} exist
▸ GIVEN each of the 12 v1 SKILL.md files WHEN compared against the schema contract via a mapping table THEN every behavioral section (triggers, workflow, cross-skill, safety rails, exit signals) maps to a schema group with no unmappable content ✓ verified: references/v1-section-mapping.md covers all sections across all 12 skills
▸ GIVEN the bundled skill directory WHEN created THEN skills/agentera/SKILL.md exists as a stub with routing logic placeholder, trigger pattern discovery instruction, and shared protocol reference ✓ verified: SKILL.md contains routing logic section, trigger pattern discovery section, shared protocol section

### Task 2: Shared Protocol Schema

**Depends on**: Task 1
**Status**: □ pending
**Acceptance**:
▸ GIVEN protocol.yaml WHEN parsed THEN it defines confidence scale (0-100, 5 tiers with boundaries), severity levels (finding and issue vocabularies), visual tokens (status, severity, confidence, trend glyphs), and phase model (5 phases with valid transitions)
▸ GIVEN SPEC.md Sections 1, 2, 3, 11, 13, 18 WHEN compared against protocol.yaml via field-by-field mapping table THEN every primitive (confidence tiers, severity values, decision labels, exit statuses, visual glyphs, phases) has a corresponding protocol.yaml entry
▸ GIVEN a capability schema referencing a shared primitive (e.g. severity: critical) WHEN validated THEN it confirms the reference resolves to a value defined in protocol.yaml

### Task 3a: Core Artifact Schemas (PROGRESS, DECISIONS, HEALTH, SESSION)

**Depends on**: Task 1, Task 2
**Status**: □ pending
**Acceptance**:
▸ GIVEN each core artifact type WHEN an artifact schema is defined THEN it specifies YAML structure with UPPER_CASE groups, numbered entries with stable IDs, field types, and validation rules
▸ GIVEN a v1 Markdown artifact for each core type WHEN compared against the v2 YAML schema via field mapping table THEN every v1 field has a corresponding v2 schema entry with a stable ID
▸ GIVEN SPEC.md Section 4 token budgets and compaction thresholds for these artifacts WHEN artifact schemas are defined THEN budget and compaction rules appear as schema metadata fields with stable IDs

### Task 3b: Secondary Artifact Schemas (PLAN, OBJECTIVE, EXPERIMENTS, DOCS, VISION)

**Depends on**: Task 3a
**Status**: □ pending
**Acceptance**:
▸ GIVEN each secondary artifact type WHEN an artifact schema is defined THEN it specifies YAML structure with UPPER_CASE groups, numbered entries with stable IDs, field types, and validation rules
▸ GIVEN a v1 Markdown artifact for each secondary type WHEN compared against the v2 YAML schema via field mapping table THEN every v1 field has a corresponding v2 schema entry with a stable ID
▸ GIVEN SPEC.md Section 4 token budgets for these artifacts WHEN artifact schemas are defined THEN budget rules appear as schema metadata fields with stable IDs

### Task 4: Query CLI Scaffold

**Depends on**: Task 3a
**Status**: □ pending
**Acceptance**:
▸ GIVEN the CLI invoked with "agentera query <query>" WHEN the query matches a supported pattern (last-phase, decisions, health, open-todos) THEN it reads the relevant YAML artifact and returns a compact text answer to stdout
▸ GIVEN an artifact file that doesn't exist WHEN queried THEN the CLI returns an empty result with exit code 0
▸ GIVEN the CLI invoked with --help THEN it lists all supported query patterns with examples matching the ROADMAP specification
▸ GIVEN a YAML artifact with multiple entries WHEN queried with a filter (--topic, --severity, --dimension) THEN the CLI returns only matching entries
▸ GIVEN a new artifact schema added to the schemas directory WHEN the CLI is re-run with no code changes THEN it automatically supports queries against the new artifact type
▸ GIVEN the CLI invoked with "agentera prime" THEN it prints a static guidance blob to stdout with no arguments, no file reads, and identical output every invocation
▸ GIVEN the prime output WHEN read THEN it contains routing rules for when to use agentera commands vs native tools, and recovery instructions for stale or missing artifacts
▸ Test proportionality: 1 pass + 1 fail per query command plus prime command, edge cases for empty/missing/filter-no-match

### Task 5: Migration Tool

**Depends on**: Task 3b
**Status**: □ pending
**Acceptance**:
▸ GIVEN a v1 .agentera/ directory with Markdown artifacts WHEN the migration tool runs THEN it produces a v2 .agentera/ directory with YAML artifacts preserving all data fields from the mapping tables in Tasks 3a/3b
▸ GIVEN a v1 Markdown PROGRESS.md with N entries WHEN migrated THEN the resulting YAML file has N entries with all fields populated per the mapping table
▸ GIVEN a v1 artifact field with no v2 equivalent WHEN migrated THEN the tool logs a warning and continues (does not fail)
▸ GIVEN the migration tool invoked on a project with no v1 artifacts WHEN run THEN it exits 0 with "nothing to migrate" message
▸ GIVEN the migration tool invoked on a project with v1 artifacts WHEN run THEN it creates .agentera/backup-v1/ containing copies of all original Markdown artifacts before conversion
▸ Test proportionality: 1 pass + 1 fail per artifact type migration, edge cases for empty artifacts and missing fields

### Task 6: Hook Rewrite

**Depends on**: Task 2, Task 3a
**Status**: □ pending
**Acceptance**:
▸ GIVEN a file write to an agent-facing artifact path WHEN the hook runs THEN it validates the content against the matching artifact schema from the schemas directory
▸ GIVEN a file write that violates an artifact schema (missing required field, wrong type) WHEN the hook runs THEN it reports the violation to stderr and exits non-zero
▸ GIVEN a file write to a human-facing artifact (TODO.md, CHANGELOG.md, DESIGN.md) WHEN the hook runs THEN it applies markdown well-formedness checks without schema enforcement
▸ GIVEN a file write to a non-artifact path WHEN the hook runs THEN it exits 0 immediately
▸ GIVEN the existing adapter JSON parsing from v1 validate_artifact.py WHEN the hook is invoked from any of the 4 runtime formats (Claude Code, OpenCode, Codex, Copilot) THEN it correctly extracts the file path and content from stdin JSON
▸ GIVEN the rewritten hook WHEN measured by line count THEN it is under 300 lines total (down from 908)
▸ Test proportionality: 1 pass + 1 fail per artifact type validation, edge cases for each runtime adapter JSON format

### Task 7: Plan-level freshness checkpoint

**Depends on**: Task 1, Task 2, Task 3a, Task 3b, Task 4, Task 5, Task 6
**Status**: □ pending
**Acceptance**:
▸ GIVEN all prior tasks complete WHEN CHANGELOG.md is checked THEN it has an Added/Changed/Fixed entry under [Unreleased] covering Phase 1 infrastructure work
▸ GIVEN all prior tasks complete WHEN PROGRESS.md is checked THEN it has a cycle entry whose What field summarizes the Phase 1 plan completion
▸ GIVEN all prior tasks complete WHEN TODO.md is checked THEN every Phase 1 item has a corresponding Resolved entry

## Overall Acceptance

▸ GIVEN all tasks complete WHEN a new capability is added to skills/agentera/capabilities/ THEN the existing schema contract validates it without modifying the hook or CLI
▸ GIVEN all tasks complete WHEN the query CLI is invoked against a migrated project THEN all artifact data is queryable
▸ GIVEN all tasks complete WHEN the hook validates a write THEN it uses artifact schemas from the schemas directory, not a central contracts.json

## Surprises

[Populated by realisera during execution when reality diverges from plan.]
