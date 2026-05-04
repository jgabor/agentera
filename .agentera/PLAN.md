# Plan: Agentera v2.0.0 Remediation — Close D39 Gaps

<!-- Level: full | Created: 2026-05-04 | Status: active -->
<!-- Reviewed: 2026-05-04 | Critic issues: 11 found, 11 addressed, 0 dismissed -->

## What

Fix the structural gaps between the claimed v2.0.0 release and the actual codebase state on feat/v2. The merge to main was attempted and reverted due to severe gaps: no YAML artifacts exist, all capability prose still references Markdown, the README describes phantom slash commands, SPEC.md dissolution is incomplete, and tests/hooks/compaction logic are hardcoded to Markdown. This plan closes those gaps so the cutover can be retried safely.

## Why

The v2.0.0 cutover shipped the packaging (single bundled skill, 12 capabilities with schemas, query CLI scaffold, migration tool) but failed to ship the behavioral transition. Archived Phase 1-4 plans claim completion, but the active PLAN.md admits gaps. The codebase is in a contradictory state that blocks any merge to main.

## Constraints

- No breaking changes to the v2 capability schema contract or protocol.yaml
- All 565+ existing tests must continue to pass (no regressions); test updates to support YAML are in scope
- Registry.json top-level `"version": "1"` is the registry format version and must not change
- The merge to main is the final task and must only run after all other acceptance criteria are verified
- 4 runtime targets must be supported: Claude Code, OpenCode, Codex, Copilot
- Human-facing artifacts (TODO.md, CHANGELOG.md, DESIGN.md) remain Markdown at the project root; all other artifacts become YAML
- The git revert on main means a naive merge of feat/v2 will produce an empty diff; a revert-of-revert or explicit strategy is required

## Scope

**In**: Invocation model decision, query CLI fixes, artifact migration, test/hook/compaction updates for YAML, prose updates, AGENTS.md update, README rewrite, SPEC dissolution cleanup, stale v1 directory removal, semantic eval fixture port, archived plan correction, validation, and merge.

**Out**: New capabilities, runtime adapter feature work, cross-runtime live testing, performance optimization of master SKILL.md size, token re-benchmarking.

**Deferred**: Master SKILL.md thin optimization (measure after all fixes), third-party extensibility.

## Design

The remediation follows a dependency chain:

1. **Decision layer** (Task 1): Define how `/agentera` routes to capabilities across all 4 runtimes. This gates the README rewrite but not infrastructure work.
2. **Infrastructure layer** (Tasks 2-3): Fix the query CLI so it discovers schemas from repo root, add missing schema metadata, and run the migration tool to create YAML artifacts.
3. **Consumer layer** (Tasks 4-5): Update tests, compaction logic, and hooks to operate on YAML instead of Markdown. Retire or rewrite SPEC.md-dependent scripts.
4. **Content layer** (Tasks 6-9): Update all 12 capability prose.md files, AGENTS.md, and README to reference YAML artifacts and the single entry point.
5. **Verification layer** (Tasks 10-12): Port semantic eval fixture, correct archived plan statuses, run full validation, and merge to main using a revert-of-revert strategy.
6. **Freshness layer** (Task 13): Update CHANGELOG, PROGRESS, TODO, and ROADMAP.

Each task is sized for one realisera cycle. Tasks 2 and 3 are independent and can run in parallel. Task 4 depends on Task 3 (YAML artifacts must exist before tests reference them). Task 7 depends on Task 3 (prose references YAML paths). Task 9 depends on Task 1 (README needs invocation model). All other tasks have no inter-dependencies.

## Tasks

### Task 1: Invocation Model Decision

**Depends on**: none
**Status**: ■ complete
**Acceptance**:

- GIVEN the invocation model WHEN a user wants to trigger any of the 12 capabilities THEN the interaction path is explicitly defined (natural language pattern, slash alias, or runtime-specific command)
- GIVEN the invocation model WHEN a user types `/agentera` in Claude Code or OpenCode THEN the dispatcher loads the bundled skill and routes to the matching capability prose.md
- GIVEN the invocation model WHEN a user uses natural language (e.g., "help me think through this") THEN the trigger pattern matching routes to the correct capability
- GIVEN the decision WHEN committed to DECISIONS.md THEN it has firm confidence, covers all 4 runtime targets, and defines the natural-language-to-capability mapping table that the README will use
- No tests required (decision task producing a DECISIONS.md entry)

### Task 2: Fix Query CLI Schema Discovery and Complete Artifact Schemas

**Depends on**: none
**Status**: ■ complete
**Acceptance**:

- GIVEN the agentera CLI invoked from the repo root without AGENTERA_HOME set WHEN querying any discovered artifact THEN it discovers schemas and returns data (not "Unknown query" or "No schema found")
- GIVEN the artifact schemas in skills/agentera/schemas/artifacts/ WHEN --list-artifacts is run THEN all 12 schemas appear (including changelog, design, todo)
- GIVEN changelog.yaml, design.yaml, and todo.yaml WHEN checked THEN each has a non-empty meta.name field
- Test proportionality: 1 pass per fixed query command, 1 fail for missing schema discovery

### Task 3: Execute Artifact Migration and Validate YAML Output

**Depends on**: Task 2
**Status**: ■ complete
**Acceptance**:

- GIVEN this project directory WHEN migrate_artifacts_v1_to_v2 runs THEN it produces YAML artifacts for all agent-facing types that have source Markdown (PROGRESS, PLAN, HEALTH, DOCS, DECISIONS, VISION), creates empty/seeding YAML for types without source (session, objective root, experiments root), and preserves the existing optimera subdirectory structure
- GIVEN the migration WHEN complete THEN .agentera/backup-v1/ contains copies of all original Markdown artifacts
- GIVEN the migration WHEN run THEN PROFILE.md is excluded (global artifact, not migrated)
- GIVEN a sample of migrated artifacts WHEN spot-checked THEN key fields from the source Markdown are preserved in YAML structure
- Test proportionality: 1 pass per artifact type migrated or created, 1 fail for missing backup or data loss

### Task 4: Update Tests, Compaction Logic, and Hooks for YAML Artifacts

**Depends on**: Task 3
**Status**: ■ complete
**Acceptance**:

- GIVEN test_compaction.py WHEN checked THEN it creates and parses YAML artifacts (not Markdown) or is retired if compaction is no longer needed for YAML
- GIVEN hooks/compaction.py and scripts/compact_artifact.py WHEN checked THEN they operate on YAML artifacts (not Markdown) or are retired
- GIVEN the full test suite after test updates WHEN pytest runs THEN 0 failures and test count does not regress
- GIVEN the PostToolUse hook WHEN it validates a YAML artifact write THEN it uses the YAML schema path (skills/agentera/schemas/artifacts/*.yaml)
- Test proportionality: 1 pass per test file updated, 1 fail for remaining Markdown-only test logic

### Task 5: SPEC Dissolution and v1 Script Retirement

**Depends on**: none
**Status**: ■ complete
**Acceptance**:

- GIVEN generate_contracts.py WHEN evaluated THEN it is either (a) rewritten to generate contracts from capability schemas and protocol.yaml instead of SPEC.md, or (b) retired with its tests removed and a replacement documented in AGENTS.md
- GIVEN test_generate_contracts.py WHEN checked THEN no SPEC.md-dependent tests remain unless generate_contracts.py is rewritten
- GIVEN scripts/self_audit.py, scripts/usage_stats.py, scripts/validate_lifecycle_adapters.py WHEN checked THEN no hardcoded SPEC.md section references remain
- GIVEN scripts/smoke_opencode_bootstrap.mjs WHEN checked THEN validate_spec.py stubs are updated or removed
- Test proportionality: 1 pass per script cleaned, 1 fail for remaining SPEC reference

### Task 6: Migrate and Remove Stale v1 Skill Directories

**Depends on**: none
**Status**: ■ complete
**Acceptance**:

- GIVEN skills/optimera/, skills/profilera/, skills/realisera/, skills/visualisera/ WHEN inspected THEN they contain no needed scripts (only empty scripts/**pycache** directories)
- GIVEN the inspection WHEN complete THEN the four v1 skill directories are deleted
- GIVEN the full test suite after deletion WHEN pytest runs THEN 0 failures

### Task 7: Update All 12 Capability prose.md Files to Reference YAML Artifacts

**Depends on**: Task 3
**Status**: ■ complete
**Acceptance**:

- GIVEN all 12 capability prose files WHEN checked THEN they reference YAML artifact paths (e.g., .agentera/progress.yaml) not Markdown paths (e.g., .agentera/PROGRESS.md) for agent-facing artifacts
- GIVEN all 12 capability prose files WHEN checked THEN artifact path resolution instructions reference .agentera/*.yaml extensions for agent-facing artifacts and preserve root Markdown for TODO.md, CHANGELOG.md, DESIGN.md
- GIVEN the test suite WHEN run THEN all tests pass
- Test proportionality: 1 pass confirming all prose files use .yaml references for agent-facing artifacts, 1 fail confirming no .md references remain for agent-facing artifacts

### Task 8: Update AGENTS.md for v2 Single-Bundle Model

**Depends on**: Task 3, Task 5
**Status**: ■ complete
**Acceptance**:

- GIVEN AGENTS.md WHEN read THEN it describes the v2 bundled skill model (not v1 per-directory skills)
- GIVEN AGENTS.md WHEN read THEN it references YAML artifact paths and the query CLI (not direct Markdown reads)
- GIVEN AGENTS.md WHEN read THEN it references validate_capability.py (not validate_spec.py) and the capability directory structure
- GIVEN AGENTS.md WHEN read THEN it contains no SPEC.md references

### Task 9: Rewrite README for Single-Entry-Point /agentera Model

**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:

- GIVEN README.md WHEN read THEN /agentera is described as the only slash command
- GIVEN README.md WHEN read THEN it contains a natural-language-to-capability mapping table (e.g., "help me think through this" → resonera)
- GIVEN README.md WHEN read THEN it links to UPGRADE.md for v1 users
- GIVEN README.md WHEN read THEN no phantom slash commands (like /hej, /realisera) appear as invocation paths
- No tests required (docs-only task)

### Task 10: Port Semantic Eval Fixture to v2 Format

**Depends on**: Task 1, Task 3
**Status**: ■ complete
**Acceptance**:

- GIVEN the v1 fixture fixtures/semantic/hej-routing-task3.md WHEN ported to v2 format THEN it references /agentera and YAML artifact paths
- GIVEN the v2 fixture WHEN scripts/semantic_eval.py runs THEN it validates correctly
- Test proportionality: 1 pass for v2 fixture validation

### Task 11: Correct Archived Plan Documentation

**Depends on**: none
**Status**: □ pending
**Acceptance**:

- GIVEN the archived PLAN-2026-05-04-v200-cutover.md WHEN checked THEN Task 2 (Merge feat/v2 to Main) status reflects the revert (not marked complete)
- GIVEN archived Phase 1-4 plans WHEN audited THEN any other falsely claimed completions are corrected
- GIVEN the corrections WHEN committed THEN the archive accurately represents what was shipped vs what was reverted

### Task 12: Full Validation Suite and Merge to main

**Depends on**: Task 2, Task 3, Task 4, Task 5, Task 6, Task 7, Task 8, Task 9, Task 10, Task 11
**Status**: □ pending
**Acceptance**:

- GIVEN the full test suite WHEN pytest runs THEN 0 failures
- GIVEN all 12 capabilities WHEN validate_capability.py runs against each THEN all pass contract validation
- GIVEN all version-bearing surfaces WHEN checked THEN the nested skill versions read 2.0.0 (registry.json skill object, plugin.json, .github/plugin/plugin.json, .codex-plugin/plugin.json, .claude-plugin/marketplace.json, .opencode/plugins/agentera.js AGENTERA_VERSION); the registry.json top-level format version remains "1"
- GIVEN the agentera query CLI WHEN each artifact type is queried THEN results are correct
- GIVEN the working tree WHEN git status runs THEN it is clean (no uncommitted changes)
- GIVEN main contains a revert commit of the prior v2 merge WHEN feat/v2 is merged THEN the merge strategy (revert-of-revert or explicit cherry-pick) is documented and the changes actually land on main

### Task 13: Plan-Level Freshness Checkpoint

**Depends on**: all prior tasks
**Status**: □ pending
**Acceptance**:

- GIVEN this plan's work has shipped WHEN CHANGELOG.md is checked THEN it has an [Unreleased] entry covering the remediation tasks
- GIVEN this plan is complete WHEN .agentera/progress.yaml is checked (or .agentera/PROGRESS.md if migration not yet run) THEN it has a cycle entry summarizing the remediation work
- GIVEN this plan is complete WHEN TODO.md is checked THEN any resolved remediation items are marked complete
- GIVEN this plan is complete WHEN ROADMAP.md is checked THEN Phase 3 and Phase 4 items are marked complete

## Overall Acceptance

- GIVEN an agentera v2 installation after all tasks WHEN a user types /agentera with a natural language request THEN the dispatcher routes to the correct capability per the invocation model decision
- GIVEN a user project with YAML artifacts WHEN the agent queries state THEN it uses the query CLI, not direct reads
- GIVEN a new user WHEN they read README.md THEN it accurately describes the single-bundle invocation model with no phantom slash commands
- GIVEN all SPEC.md references WHEN searched THEN none remain in prose, contracts, hooks, or tests

## Surprises

- **Task 1 surprise**: The unified CLI (`scripts/agentera`) is an agent-internal tool, not user-facing. The user-facing interface is `/agentera` which loads the bundled SKILL.md. The agent decides when to run `agentera query` internally. This distinction was unclear during initial deliberation but was resolved: `<request>` is just message text passed to the agent, so it works natively on all 4 runtimes without special argument parsing.
