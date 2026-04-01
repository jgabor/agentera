# Plan: Dokumentera Audit 3 fixes

<!-- Level: light — Created: 2026-03-31 — Status: complete -->

## What

Fix all 10 findings from dokumentera Audit 3. Skill count propagation (ten→eleven), DOCS.md
index completion and visual token adoption, stale descriptions, ISSUES.md structural cleanup,
and CLAUDE.md key conventions update.

## Why

Third occurrence of the same staleness pattern on skill addition (eight→nine→ten, now
ten→eleven). Fixing the documentation keeps the ecosystem self-describing. DOCS.md index
gaps mean skills reading the index get an incomplete picture of project documentation.

## Constraints

- HEALTH.md is inspektera's artifact — dokumentera notes staleness but does not modify it
- Do not change any SKILL.md content beyond the cross-skill opening sentence (skill count)
- Preserve existing DOCS.md audit log entries (append, don't replace)

## Tasks

### Task 1: Propagate "eleven-skill" count
**Depends on**: none
**Status**: ■ complete
**Acceptance**:
- GIVEN ecosystem-spec.md WHEN read THEN it says "11 skills" and "eleven-skill ecosystem"
- GIVEN any SKILL.md cross-skill section WHEN read THEN it says "eleven-skill ecosystem"
- GIVEN the ecosystem linter WHEN run THEN it passes with 0 errors

### Task 2: Complete DOCS.md
**Depends on**: none
**Status**: ■ complete
**Acceptance**:
- GIVEN DOCS.md Index WHEN read THEN it includes VISION.md, PROGRESS.md, ISSUES.md, HEALTH.md, DESIGN.md, and references/ecosystem-spec.md with correct statuses
- GIVEN DOCS.md Conventions version_files WHEN read THEN the path has no erroneous space
- GIVEN DOCS.md Index status column WHEN read THEN it uses visual tokens (■/▣) per template
- GIVEN DOCS.md audit date WHEN read THEN it says 2026-03-31

### Task 3: Fix stale descriptions
**Depends on**: none
**Status**: ■ complete
**Acceptance**:
- GIVEN marketplace.json description WHEN read THEN it mentions entry-point and visual identity
- GIVEN registry.json inspirera description WHEN read THEN it says "external links" (plural)

### Task 4: Restructure ISSUES.md
**Depends on**: none
**Status**: ■ complete
**Acceptance**:
- GIVEN ISSUES.md WHEN read THEN all resolved items appear before the "## Open" heading
- GIVEN ISSUES.md "## Open" section WHEN read THEN it contains no resolved items after it

### Task 5: Update CLAUDE.md key conventions
**Depends on**: none
**Status**: ■ complete
**Acceptance**:
- GIVEN CLAUDE.md Key conventions WHEN read THEN it mentions the visual identity system
- GIVEN CLAUDE.md Key conventions WHEN read THEN it mentions the versioning convention

## Overall Acceptance

- GIVEN all 10 audit findings WHEN each is verified against the codebase THEN all are resolved
- GIVEN the ecosystem linter WHEN run THEN 0 errors
- GIVEN DOCS.md audit log WHEN read THEN it contains an Audit 3 entry dated 2026-03-31 with all 10 findings logged

## Surprises

Ecosystem linter had "ten-skill" hardcoded — needed updating alongside ecosystem-spec.md. Also needed to add "ten" to the stale-count detection list. Not in original plan but a natural part of Finding 1.
