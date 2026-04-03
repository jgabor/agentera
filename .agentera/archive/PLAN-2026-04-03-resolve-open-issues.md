# Plan: Resolve Open Issues and Apply Test Proportionality

<!-- Level: full | Created: 2026-04-03 | Status: active -->
<!-- Reviewed: 2026-04-03 | Critic issues: 4 found, 4 addressed, 0 dismissed -->

## What

Close the three open TODO.md issues (ISS-25, ISS-19, ISS-31) and apply Decision 21 test proportionality to trim the over-generated test suite from 171 tests to a proportional baseline.

## Why

The TODO.md has three open issues blocking ecosystem maturity. ISS-25 implements a firm decision (Decision 15) that has been pending since 2026-04-02. ISS-31 leaves the only untested Python script as a silent regression risk. ISS-19 formalizes a phase model that skills already follow implicitly. The test suite was generated before Decision 21 established proportionality constraints, making it a good candidate for trimming.

## Constraints

- CI gating for ISS-31 is deferred; do not include CI pipeline work
- No version bump needed (all changes are test/chore/docs per semver_policy)
- Linter must pass after every task that touches SKILL.md or ecosystem-spec.md
- Test proportionality per Decision 21: one pass + one fail per unit, edge cases only for complex parsing/regex/branching

## Scope

**In**: ecosystem-spec.md severity section, TODO-template.md, TODO.md retroactive tagging, linter severity validation, extract_all.py tests, existing test suite trimming, ecosystem-spec.md phase tracking section, PROGRESS.md format contract update
**Out**: CI pipeline setup, SKILL.md changes for phase checking, version bumps
**Deferred**: SKILL.md phase-checking integration (each skill reading phase and flagging out-of-order runs)

## Design

ISS-25 is a single coherent change: the ecosystem-spec severity section gains a Normal tier, the TODO template and live TODO.md adopt the new format with type tags, and the linter's severity validation accepts the new tier. ISS-31 adds tests for extract_all.py's pure functions under proportionality constraints. Test simplification then trims the pre-existing 171 tests using Decision 21's one-pass-one-fail rule. ISS-19 adds a phase tracking section to the ecosystem spec and updates the PROGRESS.md format contract, without touching individual SKILL.md files.

## Tasks

### Task 1: Implement four-tier priority system (ISS-25)
**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN ecosystem-spec.md Section 2 WHEN reading the issue severity table THEN four tiers appear: Critical (⇶), Degraded (⇉), Normal (→), Annoying (⇢)
▸ GIVEN ecosystem-spec.md WHEN reading the TODO.md format convention THEN issue format shows `- [ ] ISS-N: [type] Description` with type tags (feat, fix, docs, refactor, chore, test, perf)
▸ GIVEN TODO-template.md WHEN reading the template THEN it includes all four severity headings and the type-tagged issue format
▸ GIVEN TODO.md WHEN reading open and resolved issues THEN each has a type tag and issues are filed under the correct four-tier headings
▸ GIVEN the linter WHEN validating severity terms THEN "normal" is recognized alongside critical, degraded, and annoying

### Task 2: Add extract_all.py tests (ISS-31)
**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN test_extract_all.py WHEN running pytest THEN all tests pass
▸ GIVEN extract_all.py's pure functions WHEN counting tests THEN proportionality holds: one pass + one fail per unit, edge cases only for functions with regex or branching (is_decision_rich, parse_frontmatter, project_name_from_dir, config extractors). Budget: 30-45 tests
▸ GIVEN the full test suite WHEN running pytest THEN no existing tests break

### Task 3: Trim over-generated tests per Decision 21
**Depends on**: Task 1, Task 2
**Status**: ■ complete
**Acceptance**:
▸ GIVEN any test class for a simple unit (no regex, no branching) WHEN counting its tests THEN it has at most one pass + one fail test
▸ GIVEN any test class for a complex unit (regex, branching, parsing) WHEN counting its tests THEN edge cases are retained but redundant variants are removed
▸ GIVEN the trimmed test suite WHEN running pytest THEN all remaining tests pass
▸ GIVEN the test count WHEN compared to the pre-trim count THEN the total is lower while covering every unit with at least one pass and one fail

### Task 4: Define phase tracking in ecosystem-spec.md (ISS-19)
**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN ecosystem-spec.md WHEN reading the new phase tracking section THEN five phases are defined: envision, deliberate, plan, build, audit
▸ GIVEN the phase definitions WHEN reading transitions THEN valid successors and terminal states are specified for each phase
▸ GIVEN the PROGRESS.md format contract WHEN reading a cycle entry format THEN a phase field is present
▸ GIVEN the linter WHEN checking ecosystem-spec.md THEN no new errors or warnings appear

## Overall Acceptance

▸ GIVEN TODO.md WHEN reading open issues THEN ISS-25, ISS-19, and ISS-31 are marked resolved with commit references
▸ GIVEN the test suite WHEN running pytest THEN all tests pass and the total count reflects proportionality (lower than 171 for old tests, plus proportional new tests for extract_all.py)
▸ GIVEN the ecosystem linter WHEN running against all skills THEN 0 errors, 0 warnings

## Surprises
