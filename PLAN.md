# Plan: Version Management Convention

<!-- Level: full | Created: 2026-03-31 | Status: active -->
<!-- Reviewed: 2026-03-31 | Critic issues: 7 found, 3 addressed, 4 dismissed -->

## What

Wire version management into the agentera ecosystem as a project-driven convention per
Decision 12. Add versioning to DOCS.md conventions, teach four skills their roles (detect,
flag, check, execute), fix registry.json's missing version field, and bump skills for the
visual identity rollout.

## Why

No skill currently detects, flags, or executes version bumps. The visual identity rollout
changed all 11 SKILL.md files with zero version bumps. registry.json has no per-skill
version field despite CLAUDE.md saying to update it. Version management is a project
convention — DOCS.md stores it, skills enforce it.

## Constraints

- No new artifacts — versioning lives in DOCS.md conventions
- No default imposed — if DOCS.md has no versioning section, no auto-bumping
- Significant changes = `feat` and `fix` conventional commit types (explicit heuristic)
- The ecosystem linter must pass after every task
- Skills must still work standalone
- Ten-skill count inconsistency is pre-existing and explicitly out of scope

## Scope

**In**: DOCS.md template, dokumentera survey, planera scope evaluation, inspektera staleness
check, realisera execution awareness, registry.json version field, agentera's own versioning
convention, skill version bumps for visual identity rollout
**Out**: Changelog generation, release automation, tag management, ten-skill count fix
**Deferred**: Automated version bump scripts, linter check for versioning consistency

## Design

DOCS.md Conventions section gains an optional `versioning` block:

```yaml
versioning:
  version_files: ["package.json", "Cargo.toml"]
  semver_policy: "feat = minor, fix = patch"
```

If absent, no skill attempts version management. If present, four skills act:
- dokumentera detects and records the convention during first-run survey
- planera includes a version bump task when planned scope includes `feat`/`fix` work
- inspektera checks for `feat`/`fix` commits since last version bump during audits
- realisera executes bumps when assigned (from plan tasks or inspektera findings)

## Tasks

### Task 1: DOCS.md template and dokumentera survey — versioning convention
**Depends on**: none
**Status**: ■ complete
**Acceptance**:
- ▸ GIVEN a DOCS.md template WHEN a user reads the Conventions section THEN there is an optional `versioning` block with `version_files` and `semver_policy` fields
- ▸ GIVEN dokumentera's first-run survey WHEN it scans a project THEN it detects version files (package.json, Cargo.toml, pyproject.toml, plugin.json, etc.) and asks about semver policy
- ▸ GIVEN a project with no version files WHEN dokumentera surveys THEN the versioning block is omitted from DOCS.md
- ▸ GIVEN the linter WHEN `python3 scripts/validate-ecosystem.py` runs THEN it exits 0

### Task 2: planera — version bump awareness in planning
**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
- ▸ GIVEN planera reading DOCS.md WHEN the versioning convention exists and the plan scope includes `feat` or `fix` work THEN planera includes a version bump task at the end of the plan
- ▸ GIVEN planera reading DOCS.md WHEN no versioning convention exists THEN planera does not mention version bumps
- ▸ GIVEN a light plan with only `docs`/`chore` scope WHEN planera evaluates THEN no version bump task is added
- ▸ GIVEN the linter WHEN `python3 scripts/validate-ecosystem.py` runs THEN it exits 0

### Task 3: inspektera — version staleness check in audits
**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
- ▸ GIVEN inspektera auditing a project WHEN DOCS.md has a versioning convention THEN inspektera checks git log for `feat`/`fix` commits since the last version bump
- ▸ GIVEN unbumped `feat`/`fix` commits WHEN inspektera detects them THEN it files a finding with severity based on count and age
- ▸ GIVEN no DOCS.md versioning convention WHEN inspektera audits THEN it skips version checking entirely
- ▸ GIVEN the linter WHEN `python3 scripts/validate-ecosystem.py` runs THEN it exits 0

### Task 4: realisera — version bump execution awareness
**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
- ▸ GIVEN realisera executing a plan task labeled as a version bump WHEN DOCS.md has version file locations THEN realisera reads those locations and performs the mechanical version update
- ▸ GIVEN realisera picking up a version-staleness finding from ISSUES.md WHEN the finding references DOCS.md versioning THEN realisera performs the bump
- ▸ GIVEN no DOCS.md versioning convention WHEN realisera commits THEN it does not attempt any version management
- ▸ GIVEN the linter WHEN `python3 scripts/validate-ecosystem.py` runs THEN it exits 0

### Task 5: agentera housekeeping — registry versions, skill bumps, own convention
**Depends on**: Task 1
**Status**: □ pending
**Acceptance**:
- ▸ GIVEN registry.json WHEN a skill entry is read THEN it includes a `version` field matching the skill's plugin.json version
- ▸ GIVEN the visual identity rollout WHEN all 11 skills were modified THEN each skill's version is bumped (patch for non-behavioral changes, minor for skills with new output format sections)
- ▸ GIVEN agentera's own DOCS.md WHEN it is read THEN it includes a versioning convention pointing to plugin.json, marketplace.json, and registry.json
- ▸ GIVEN marketplace.json WHEN all skill versions are checked THEN the marketplace collection version reflects the latest changes

## Overall Acceptance

- ▸ GIVEN any project with a DOCS.md versioning convention WHEN planera creates a plan with `feat` scope THEN the plan includes a version bump task
- ▸ GIVEN any project with a DOCS.md versioning convention WHEN inspektera audits THEN it checks for unbumped significant changes
- ▸ GIVEN agentera's own repo WHEN version fields are checked THEN registry.json, plugin.json, and marketplace.json are consistent and reflect the visual identity rollout
- ▸ GIVEN a project with no DOCS.md versioning convention WHEN any skill runs THEN no version management occurs

## Surprises

[Empty — populated by realisera during execution when reality diverges from plan]
