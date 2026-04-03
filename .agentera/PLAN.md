# Plan: Selective Ecosystem Context Loading (ISS-35)

<!-- Level: full | Created: 2026-04-03 | Status: active -->
<!-- Reviewed: 2026-04-03 | Critic issues: 3 found, 3 addressed, 0 dismissed -->

## What

Eliminate spec-to-skill semantic drift by replacing embedded authoritative values in SKILL.md files with per-skill generated context files. Each skill declares which ecosystem-spec sections it depends on (frontmatter), a generation script extracts those sections verbatim into `references/ecosystem-context.md`, and SKILL.md references that file instead of embedding values. The 12 existing drifts from ISS-35 are fixed as part of the migration.

## Why

The ecosystem has ~70 duplication points across 12 skills embedding values from the ecosystem spec. An audit found 12 confirmed drifts: wrong token budgets, script syntax mismatches, missing profile consumption, missing phase tracking, missing content exclusion rules, and missing severity classification in TODO.md writes. The linter catches structural violations but not semantic drift in embedded values. This mechanism makes drift impossible by construction: context files are generated verbatim from the spec, and the toolchain enforces they stay current.

## Constraints

- Linter must pass (0 errors, 0 warnings) after every task touching SKILL.md or ecosystem-spec.md
- Skills must work standalone (each carries its own `references/ecosystem-context.md`) AND mesh when co-installed
- No phase enforcement in SKILL.md files (Decision 22, firm)
- Test proportionality per Decision 21: 1 pass + 1 fail per testable unit; edge cases only for complex parsing/regex/branching
- Python scripts: stdlib only, no pip dependencies
- Verbatim section extraction (no summarization, no compression)
- Pre-commit hook must continue gating on both the context check and the linter

## Scope

**In**: frontmatter `spec_sections` in all 12 SKILL.md files, generation script, SKILL.md ecosystem-context read instruction and embedded value removal, 3 new linter checks, pre-commit hook update, tests for the generation script, fix of all 12 ISS-35 drifts as part of migration

**Out**: Section 4 sub-filtering (future enhancement), advisory hardcoded-value grep check (future), version bumps (feat work under development), CI gating

**Deferred**: Section 4 sub-filtering per `spec_artifacts` frontmatter (design doc mentions as future v2)

## Design

Follows the 4-component architecture from `docs/selective-ecosystem-context.md`:

1. **Frontmatter declaration**: each SKILL.md gains `spec_sections: [N, ...]` listing its runtime dependencies on ecosystem-spec sections. The dependency map is defined in the design doc.

2. **Generation script**: `scripts/generate_ecosystem_context.py` parses ecosystem-spec.md by `## N.` heading boundaries, reads each SKILL.md's `spec_sections`, and writes `skills/<name>/references/ecosystem-context.md` with a metadata header (skill name, source hash, section list, timestamp, regeneration command) followed by verbatim section content. Modes: default (regenerate all), `--check` (verify freshness, exit 1 if stale), `--skill <name>` (single skill).

3. **SKILL.md reference pattern**: each SKILL.md gains an `### Ecosystem context` subsection (under State artifacts or as a top-level workflow preamble, per design doc) with a read instruction pointing to `references/ecosystem-context.md`. Embedded authoritative values (token budgets, compaction thresholds, severity vocabulary, confidence tiers, profile consumption syntax, phase tracking, staleness rules, content exclusion) are replaced with references to the ecosystem context.

4. **Toolchain integration**: pre-commit hook runs `--check` before the linter. Linter gains 3 new checks per skill: `spec-sections-declared` (frontmatter field), `context-file-exists` (file present), `context-file-current` (hash matches).

The 12 ISS-35 drifts are fixed as part of migration (Task 4): generating correct context files from the spec and updating SKILL.md files to reference them.

## Tasks

### Task 1: Write the generation script
**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN `scripts/generate_ecosystem_context.py` WHEN run with no arguments THEN 12 `ecosystem-context.md` files are generated under `skills/*/references/`
▸ GIVEN the script WHEN run with `--check` THEN exit 0 if all files are current, exit 1 if any are stale, with a message naming the stale files
▸ GIVEN the script WHEN run with `--skill realisera` THEN only `skills/realisera/references/ecosystem-context.md` is regenerated
▸ GIVEN a generated file WHEN reading its header THEN it contains the skill name, source sha256, section list, generation timestamp, and "do not edit" + "regenerate" instructions
▸ GIVEN a generated file WHEN comparing section content to ecosystem-spec.md THEN the content is byte-identical (verbatim extraction)
▸ GIVEN ecosystem-spec.md with 18 sections WHEN parsing THEN all sections are correctly identified by `## N.` heading boundaries
▸ GIVEN a SKILL.md with `spec_sections: [1, 2, 4]` WHEN generating THEN only sections 1, 2, and 4 appear in the output, in order

### Task 2: Add `spec_sections` frontmatter to all 12 SKILL.md files
**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN any SKILL.md WHEN reading frontmatter THEN a `spec_sections` field is present with a list of integers
▸ GIVEN the section lists WHEN compared to the design doc's dependency map THEN they match exactly
▸ GIVEN the frontmatter parser in the linter WHEN parsing `spec_sections` THEN it correctly extracts the list
▸ GIVEN the ecosystem linter WHEN run THEN 0 errors, 0 warnings

### Task 3: Add 3 new linter checks and update pre-commit hook
**Depends on**: Task 1 (for `--check` mode), Task 2 (for frontmatter to validate)
**Status**: ■ complete
**Acceptance**:
▸ GIVEN the linter WHEN run on a SKILL.md with `spec_sections` THEN check `spec-sections-declared` passes
▸ GIVEN the linter WHEN run on a SKILL.md without `spec_sections` THEN check `spec-sections-declared` fails with error
▸ GIVEN the linter WHEN `references/ecosystem-context.md` exists for a skill THEN check `context-file-exists` passes
▸ GIVEN the linter WHEN `references/ecosystem-context.md` is missing for a skill THEN check `context-file-exists` fails with error
▸ GIVEN the linter WHEN the context file's source hash matches current ecosystem-spec.md THEN check `context-file-current` passes
▸ GIVEN the linter WHEN the context file's source hash is outdated THEN check `context-file-current` fails with error
▸ GIVEN `.githooks/pre-commit` WHEN a commit touches skills or spec files THEN the context freshness check runs before the linter
▸ GIVEN the linter WHEN run against all 12 skills THEN 0 errors, 0 warnings (existing 13 checks + 3 new)
▸ Tests: 1 pass + 1 fail per check function (6 tests). Edge cases for the hash computation (complex parsing).

### Task 4: Migrate all 12 SKILL.md files (reference pattern + drift fixes)
**Depends on**: Task 1 (generation script must exist to produce context files), Task 2 (frontmatter already in place)
**Status**: ■ complete
**Acceptance**:
▸ GIVEN any SKILL.md WHEN reading its workflow preamble THEN an `### Ecosystem context` section instructs reading `references/ecosystem-context.md`
▸ GIVEN any SKILL.md WHEN searching for hardcoded token budgets (≤50 words, ≤30 words, ≤500 words, etc.) used as authoritative limits THEN none remain for values that belong in the ecosystem context (output constraints for individual write operations are skill-behavioral and stay)
▸ GIVEN realisera SKILL.md WHEN checking cycle summary token budget THEN it references ecosystem context instead of embedding "≤50 words" (drift #1 fix)
▸ GIVEN inspektera SKILL.md WHEN checking dimension budget THEN it references ecosystem context instead of embedding "≤30 words" (drift #1 fix)
▸ GIVEN realisera and inspektera SKILL.md WHEN checking profile script invocation THEN it matches spec syntax `python3 scripts/effective_profile.py` (drift #2 already correct, confirmed in audit)
▸ GIVEN visionera, visualisera, resonera SKILL.md WHEN checking profile consumption THEN the direct-read pattern is referenced via ecosystem context (drift #3 fix)
▸ GIVEN inspirera SKILL.md WHEN checking TODO.md write THEN severity classification is referenced via ecosystem context (drift #6 fix)
▸ GIVEN the ecosystem linter WHEN run THEN 0 errors, 0 warnings
▸ GIVEN `scripts/generate_ecosystem_context.py --check` WHEN run THEN exit 0 (all context files current)

### Task 5: Write tests for the generation script
**Depends on**: Task 1 (script must exist to test)
**Status**: ■ complete
**Acceptance**:
▸ Tests in `tests/test_generate_ecosystem_context.py` covering the generation script's public functions
▸ Proportionality: 1 pass + 1 fail per testable unit
▸ Edge cases for: section parsing (regex, heading boundary detection), frontmatter `spec_sections` extraction (parsing logic), hash computation
▸ GIVEN the test suite WHEN run with pytest THEN all tests pass
▸ GIVEN `python3 -m pytest tests/` WHEN run THEN all existing tests continue to pass (no regressions)

### Task 6: Final validation and ISS-35 resolution
**Depends on**: Tasks 1-5 (all prior work complete)
**Status**: □ open
**Acceptance**:
▸ GIVEN `scripts/generate_ecosystem_context.py --check` WHEN run THEN exit 0
▸ GIVEN `scripts/validate_ecosystem.py` WHEN run THEN 0 errors, 0 warnings across 12 skills with all 16 checks
▸ GIVEN `python3 -m pytest tests/` WHEN run THEN all tests pass (existing + new)
▸ GIVEN TODO.md WHEN reading ISS-35 THEN it is moved to Resolved with commit references
▸ GIVEN the 12 ISS-35 drifts WHEN checking each one THEN all are resolved (token budgets reference context, profile consumption present in all consumers, severity classification available to inspirera via context)

## Overall Acceptance

▸ GIVEN any SKILL.md WHEN operating standalone THEN `references/ecosystem-context.md` ships with the skill and provides all authoritative values at runtime
▸ GIVEN the full suite WHEN co-installed THEN all 12 context files are generated from the same spec, values consistent by construction
▸ GIVEN ecosystem-spec.md WHEN modified THEN `python3 scripts/generate_ecosystem_context.py` regenerates all context files, and `--check` mode catches stale files before commit
▸ GIVEN the toolchain WHEN a commit touches skills or spec THEN pre-commit runs context freshness check then linter, blocking stale or misaligned commits
▸ GIVEN the 12 ISS-35 drifts WHEN auditing post-migration THEN zero remain

## Adversarial Critic Review

### Issue 1: Task 4 scope is enormous (12 SKILL.md files, each with multiple edits)
**Risk**: a single task touching all 12 SKILL.md files is the largest unit of work in the plan. If it fails partway, partial migration leaves some skills with the reference pattern and others without.
**Addressed**: Task 4 is intentionally monolithic because the migration must be atomic from the linter's perspective: you cannot have some skills declaring `spec_sections` and referencing ecosystem-context while others do not, since the linter (Task 3) will enforce all three new checks on all 12 skills. The executing agent should process skills in a systematic order (alphabetical or by dependency count) and verify the linter passes after each batch. If worktree agents are used, they can process 3-4 skills in parallel with a linter check after each batch merge.

### Issue 2: Distinguishing "authoritative values that move" from "skill-behavioral values that stay"
**Risk**: the boundary between "this token budget belongs in ecosystem-context.md" and "this output constraint is skill-behavioral" is judgment-dependent. An overly aggressive migration strips skill-specific write constraints, making SKILL.md files unreadable. An overly conservative one leaves duplicated values.
**Addressed**: the design doc provides explicit criteria. What moves: token budgets (exact word counts per artifact), compaction thresholds, severity vocabulary with glyphs, confidence tier boundaries, profile consumption syntax and thresholds, phase names, staleness rules, content exclusion rules. What stays: workflow steps, decision logic, safety rails, cross-skill integration, exit signal definitions, output constraints for individual write operations (these are behavioral instructions, not shared values). The executing agent should use a simple test: if the value appears in ecosystem-spec.md as a shared convention, it moves; if it is a skill's own instruction about how to format a specific output step, it stays.

### Issue 3: Test file for the generation script duplicates section-parsing logic tested by linter tests
**Risk**: `test_generate_ecosystem_context.py` and `test_validate_ecosystem.py` both test frontmatter parsing and section extraction. Overlap wastes test budget.
**Addressed**: the generation script has its own parsing functions (section extraction by `## N.` heading boundaries, which differs from the linter's `## Heading` extraction). The frontmatter parser is shared. Tests for the generation script focus on: (a) section-by-number extraction (unique to this script), (b) `spec_sections` list parsing from frontmatter (new field), (c) hash computation and freshness check, (d) multi-skill generation and `--skill` filtering. The shared `parse_frontmatter` function is already tested in linter tests; generation script tests should import it, not retest it.

## Surprises
