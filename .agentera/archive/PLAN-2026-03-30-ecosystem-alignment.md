# Plan: Ecosystem Alignment Spec + Unified Confidence Model

<!-- Level: full | Created: 2026-03-30 | Status: active -->
<!-- Reviewed: 2026-03-30 | Critic issues: 9 found, 5 addressed, 4 acknowledged -->
<!-- Decisions: 7 (alignment enforcement), 8 (unified confidence) -->

## What

Formalize the 9 shared primitives identified in Decision 7 into a single ecosystem spec,
build a Python linter to enforce alignment, migrate profilera to the unified 0-100 confidence
scale (Decision 8), fix all existing violations across the 10 skills, update the documented
repo layout, and wire the linter as a pre-commit hook.

## Why

Two skills independently invented incompatible confidence scales — convention-based alignment
fails silently. The ecosystem needs a single source of truth for shared primitives and a
deterministic check that prevents drift as skills are added or modified. This is foundational
infrastructure for ecosystem integrity.

## Constraints

- Python stdlib only (no pip dependencies) — consistent with existing scripts
- Skills must remain standalone at runtime — the spec and linter are dev-time only
- Deterministic checks block commits; fuzzy checks warn but don't block
- The linter must be fast enough to not annoy on pre-commit (< 2s)
- Profilera's decay formula semantics must be preserved (only the scale changes)
- Confidence tier boundaries: adopt inspektera's gapless 0-100 ranges (90-100, 70-89, 50-69,
  30-49, 0-29) as canonical — profilera's narrower ranges were artifacts of the 0.0-1.0 scale

## Scope

**In**: ecosystem-spec.md, validate-ecosystem.py, profilera migration, aligning all 10
SKILL.md files, pre-commit hook, CLAUDE.md layout update

**Out**: Runtime cross-skill validation, changes to how skills behave in target projects,
new skills

**Deferred**: Expanding deterministic linter coverage to artifact template schemas, CI
integration

## Design

A shared `references/ecosystem-spec.md` at the repo root defines all 9 primitives. This is a
new root-level directory, extending the repo layout beyond per-skill directories — CLAUDE.md
must be updated to document this. A Python linter at `scripts/validate-ecosystem.py` parses
the spec and all `skills/*/SKILL.md` files, comparing them for alignment. The linter outputs
clean pass/fail for deterministic checks and advisory warnings for fuzzy checks. It's wired as
a git pre-commit hook so violations can't be committed. Profilera's 0.0-1.0 scale migrates to
0-100 by scaling all values — existing PROFILE.md files are regenerated via `/profilera`
rather than auto-converted.

## Tasks

### Task 1: Author the ecosystem spec
**Depends on**: none
**Status**: complete
**Acceptance**:
- GIVEN the spec exists WHEN a skill author reads it THEN they can determine the correct
  values for every shared primitive without consulting another SKILL.md
- GIVEN the spec defines confidence tiers WHEN comparing to inspektera's current boundaries
  and profilera's current semantics THEN both systems' meanings are preserved in the unified
  0-100 ranges
- GIVEN the spec defines all 9 primitives WHEN cross-referencing with Decision 7's primitive
  table THEN every listed primitive has a corresponding section
- GIVEN the spec defines the severity vocabulary WHEN an author needs to file to ISSUES.md
  THEN the canonical severity levels and their meanings are unambiguous

### Task 2: Build the ecosystem linter
**Depends on**: Task 1
**Status**: complete
**Acceptance**:
- GIVEN the linter runs on the repo WHEN all SKILL.md files are aligned with the spec THEN
  it exits 0 with no errors
- GIVEN a SKILL.md has a wrong confidence tier boundary WHEN the linter runs THEN the author
  knows exactly what to fix without reading the full spec
- GIVEN a SKILL.md has a fuzzy-check concern WHEN the linter runs THEN it reports it as a
  warning that does not cause a nonzero exit code
- GIVEN the linter runs WHEN execution completes THEN it finishes in under 2 seconds

### Task 3: Migrate profilera to 0-100 confidence
**Depends on**: Task 1
**Status**: complete
**Acceptance**:
- GIVEN profilera's SKILL.md WHEN reading the confidence scale definition THEN all tiers,
  thresholds, deltas, and floors use integer 0-100 values
- GIVEN the decay formula WHEN applied at the new scale THEN it produces the same proportional
  results as the old formula (e.g., 85 decays the same way 0.85 did)
- GIVEN the effective_profile script WHEN run against a 0-100 format PROFILE.md THEN all
  output values (effective confidence, decay gaps, validation priorities, extremity scores)
  are correct at the 0-100 scale
- GIVEN the validate mode of the effective_profile script WHEN surfacing entries for review
  THEN stale/extreme/challenged thresholds correctly identify the same entries they would
  have at the 0.0-1.0 scale

### Task 4: Align all SKILL.md files with the spec
**Depends on**: Task 1, Task 2, Task 3
**Status**: complete
**Acceptance**:
- GIVEN the linter runs after all fixes WHEN checking all 10 SKILL.md files THEN it reports
  zero errors
- GIVEN the severity vocabulary WHEN checking inspektera's filing instructions and the ISSUES
  template THEN both use the same canonical terms from the spec
- GIVEN any skill that consumes profilera's confidence values WHEN reading its SKILL.md THEN
  all embedded thresholds use the 0-100 scale
- GIVEN any skill's cross-skill integration section WHEN compared to the spec's requirements
  THEN all required references are present

### Task 5: Wire pre-commit hook and update repo layout
**Depends on**: Task 2
**Status**: complete
**Acceptance**:
- GIVEN a commit modifying any file under skills/ or references/ecosystem-spec.md WHEN the
  commit is attempted THEN the linter runs automatically before the commit completes
- GIVEN the linter reports errors WHEN the pre-commit hook fires THEN the commit is blocked
  with actionable output
- GIVEN a commit not touching skills/ or the ecosystem spec WHEN committed THEN the hook
  does not run
- GIVEN the CLAUDE.md repo layout section WHEN a contributor reads it THEN it documents the
  root-level references/ and scripts/ directories and their purpose

## Overall Acceptance

- GIVEN the full implementation WHEN running the linter THEN all 10 skills pass with zero
  errors
- GIVEN a new skill is being authored WHEN the author references the ecosystem spec THEN
  they adopt all shared primitives correctly without copying from another SKILL.md
- GIVEN any SKILL.md is modified to violate a shared primitive WHEN attempting to commit THEN
  the pre-commit hook blocks the commit with actionable output

## Surprises

<!-- Populated by realisera during execution when reality diverges from plan -->
