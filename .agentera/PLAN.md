# Plan: v2.0.0 Cutover — Complete Big Bang

<!-- Level: full | Created: 2026-05-04 | Status: active -->
<!-- Reviewed: 2026-05-04 | Critic issues: 9 found, 4 addressed, 5 dismissed -->

## What

Complete the v2.0.0 cutover: remove 12 v1 skill directories, collapse all runtime adapter configs to the single bundled `skills/agentera/`, update tests, write an upgrade guide, and bump version.

## Why

D39 (firm) committed to big bang cutover with "one install, one entry point." The merge brought v2 in alongside v1, leaving 13 coexisting skill directories. `npx skills update` installs all 13, producing duplicate routing and confused agents. The cutover was planned but never executed.

## Constraints

- D39 (firm): single bundled skill, big bang cutover
- D40 (firm): YAML artifacts, "capabilities" naming, no backward compat
- ROADMAP: "One install, one entry point, one query interface"
- 4 runtime targets: Claude Code, OpenCode, Codex, Copilot
- Copilot is env-var based (no plugin.json); config collapse is a no-op for it
- Scripts use Python stdlib + pyyaml via uv inline script metadata
- Current state: 659 tests pass, 0 fail, 1 skip

## Scope

**In**: Delete 12 v1 skill dirs, collapse marketplace/Codex/OpenCode configs to single bundle, update runtime adapter tests, write UPGRADE.md, rename migration script, version bump 2.0.0, update ROADMAP
**Out**: Artifact format migration (done), new capabilities, token benchmarking, query CLI expansion, eval script updates (none reference v1 paths)
**Deferred**: Semantic eval fixture updates (already ported in prior phase)

## Design

Atomic cutover: v1 deletion and config collapse happen in one commit so no intermediate state references missing directories. Tests come next because they validate the new structure. UPGRADE.md documents the user-facing migration path. Version bump is last before freshness.

## Tasks

### Task 1: Cutover — Delete v1 Skill Dirs + Collapse Configs

**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN the skills/ directory WHEN ls runs THEN only skills/agentera/ exists (12 v1 dirs deleted)
▸ GIVEN marketplace.json WHEN read THEN it lists 1 plugin pointing at ./skills/agentera with v2-appropriate description
▸ GIVEN Codex plugin.json WHEN read THEN it has 1 skillMetadata entry for skills/agentera/SKILL.md
▸ GIVEN OpenCode agentera.js WHEN read THEN its COMMAND_TEMPLATES reference the bundled agentera skill path
▸ GIVEN registry.json WHEN read THEN it reflects single-bundle structure (1 skill entry or 12 capability entries under agentera)
▸ GIVEN AGENTS.md WHEN read THEN it describes only the v2 bundled model with no v1 references
▸ GIVEN the agentera/capabilities directory WHEN checked THEN all 12 capabilities still pass validate_capability.py contract + primitives

### Task 2: Update Runtime Adapter Tests

**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN the test suite WHEN pytest runs THEN 0 failures
▸ GIVEN test_runtime_adapters.py WHEN read THEN it validates the single-bundle model: 1 marketplace plugin, no per-skill plugin.json checks for deleted dirs, version alignment for remaining surfaces
▸ GIVEN the version alignment test WHEN run THEN it passes (all surfaces match)
▸ Test proportionality: 1 pass + 1 fail for marketplace validation, 1 pass + 1 fail for registry validation, 1 pass + 1 fail for version alignment

### Task 3: Write UPGRADE.md + Rename Migration Script

**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN UPGRADE.md WHEN read THEN it documents upgrade steps for all 4 runtimes (Claude Code, OpenCode, Codex, Copilot)
▸ GIVEN UPGRADE.md WHEN read THEN it documents project artifact migration using the renamed script
▸ GIVEN the migration script WHEN invoked as scripts/migrate_artifacts_v1_to_v2 THEN it runs identically to the old name
▸ GIVEN the migration script WHEN invoked as scripts/migrate_v1_to_v2 THEN it prints a deprecation warning and delegates to the new name

### Task 4: Version Bump 2.0.0

**Depends on**: Task 1, Task 2
**Status**: □ pending
**Acceptance**:
▸ GIVEN all version surfaces WHEN checked THEN they show 2.0.0 (registry.json, marketplace.json metadata, Codex plugin.json, GitHub plugin.json, root plugin.json, OpenCode agentera.js)
▸ GIVEN the version alignment test WHEN run THEN it passes with 0 errors

### Task 5: Freshness Checkpoint

**Depends on**: Task 1, Task 2, Task 3, Task 4
**Status**: ■ complete
**Acceptance**:
▸ GIVEN ROADMAP.md WHEN read THEN Phase 3 and Phase 4 are marked complete
▸ GIVEN CHANGELOG.md WHEN read THEN it has a v2.0.0 release entry covering the cutover
▸ GIVEN PROGRESS.md WHEN read THEN it has a cycle entry for the cutover completion

## Overall Acceptance

▸ GIVEN the skills/ directory WHEN ls runs THEN only skills/agentera/ exists
▸ GIVEN npx skills WHEN it reads marketplace.json THEN it discovers 1 plugin, not 12
▸ GIVEN the test suite WHEN pytest runs THEN 0 failures
▸ GIVEN all version surfaces WHEN checked THEN they show 2.0.0
▸ GIVEN UPGRADE.md WHEN read THEN it provides actionable upgrade steps for all 4 runtimes

## Surprises

[Populated during execution.]
