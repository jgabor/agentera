# Plan: Artifact Consolidation (Decision 13)

<!-- Level: full | Created: 2026-04-01 | Status: active -->
<!-- Reviewed: 2026-04-01 | Critic issues: 10 found, 9 addressed, 1 dismissed -->

## What

Restructure default artifact layout from all-in-root to three conventional files at root
(TODO.md, CHANGELOG.md, VISION.md) and eight operational files in `.agentera/`. Update
ecosystem spec, all 11 SKILL.md files, the linter, and apply to agentera's own repo.

## Why

Up to 10 unfamiliar .md files at project root creates clutter and prevents one-line
gitignore. Conventional names (TODO.md, CHANGELOG.md) make output recognizable to any
developer. `.agentera/` separates operational state from project-facing documentation.
Deterministic layout replaces DOCS.md-first discovery — skills know paths by convention.

## Constraints
- DOCS.md mapping (Decision 4) remains the override mechanism for non-default paths
- PROFILE.md unchanged (global at ~/.claude/profile/PROFILE.md)
- Operational artifact content formats (PROGRESS.md, DECISIONS.md, HEALTH.md) unchanged — only locations move
- TODO.md and CHANGELOG.md adopt conventional formats, not just renamed versions
- Ecosystem-spec severity vocabulary must map cleanly to TODO.md priority convention
- Linter must pass 0 errors after completion
- .optimera/harness is a working tool directory — not consolidated (deferred)

## Scope
**In**: ecosystem-spec (Sections 2, 4, 5), all 11 SKILL.md files, linter, agentera's own
artifacts, CLAUDE.md, README.md, archive directory consolidation (.planera/, .visionera/,
.visualisera/ → .agentera/archive/)
**Out**: migration tooling for existing users, third-party skill compatibility, .optimera/ consolidation
**Deferred**: gitignore template, migration guide, .optimera/ working directory consolidation

## Design

**Deterministic layout** replaces DOCS.md-first discovery. Three root files are project-facing
(any developer recognizes TODO.md and CHANGELOG.md). Eight operational files in `.agentera/`
serve the skills. `.agentera/DOCS.md` is optional — only needed for path overrides.

**Dual-write** for realisera: CHANGELOG.md (public, keep-a-changelog, version-level summaries)
AND `.agentera/PROGRESS.md` (operational cycle detail, unchanged format). Consuming skills
that need cycle-level detail read `.agentera/PROGRESS.md`; project contributors read CHANGELOG.md.

**TODO.md** replaces ISSUES.md at root: conventional format with checkboxes and priority tags.
Ecosystem-spec severity vocabulary (critical/degraded/annoying) maps to priority prefixes in
TODO.md. Severity semantics preserved; presentation adapts to conventional expectations.

**Archive consolidation**: all skill-specific archive directories (.planera/archive/,
.visionera/, .visualisera/) merge into `.agentera/archive/`. No naming conflicts — plan, vision,
and design archives have distinct filename prefixes.

## Tasks

### Task 1: Update ecosystem-spec with new artifact convention
**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN Section 4 WHEN reading artifact table THEN paths show 3 root + 8 in .agentera/
▸ GIVEN Section 4 WHEN reading format contracts THEN TODO.md and CHANGELOG.md have definitions
▸ GIVEN Section 4 WHEN reading producer/consumer table THEN realisera produces both CHANGELOG.md and .agentera/PROGRESS.md
▸ GIVEN Section 5 WHEN reading path resolution template THEN canonical text references .agentera/DOCS.md
▸ GIVEN Section 2 WHEN reading severity vocabulary THEN it maps to TODO.md priority convention

### Task 2: Update all 11 SKILL.md path resolution and State artifacts for new layout
**Depends on**: Tasks 1, 5
**Status**: □ pending
**Acceptance**:
▸ GIVEN any SKILL.md WHEN reading path resolution THEN it uses the new canonical template from Section 5
▸ GIVEN any SKILL.md WHEN reading State artifacts THEN default paths match the new convention
▸ GIVEN any SKILL.md WHEN referencing the issues artifact THEN it says TODO.md, not ISSUES.md
▸ GIVEN the linter WHEN validating all 11 files THEN 0 errors on path resolution

### Task 3: Add dual-write and conventional formats to realisera
**Depends on**: Task 1
**Status**: □ pending
**Acceptance**:
▸ GIVEN realisera WHEN completing a cycle THEN it writes both CHANGELOG.md and .agentera/PROGRESS.md
▸ GIVEN realisera WHEN writing CHANGELOG.md THEN format follows keep-a-changelog convention
▸ GIVEN realisera WHEN filing an issue THEN it writes to TODO.md with priority and checkboxes
▸ GIVEN realisera WHEN reading existing issues THEN it reads TODO.md

### Task 4: Update planera, dokumentera, inspektera, visionera, visualisera for new convention
**Depends on**: Task 1
**Status**: □ pending
**Acceptance**:
▸ GIVEN planera WHEN archiving THEN it writes to .agentera/archive/, not .planera/archive/
▸ GIVEN dokumentera WHEN creating DOCS.md THEN it writes to .agentera/DOCS.md
▸ GIVEN inspektera WHEN filing findings THEN it writes to TODO.md with priority convention
▸ GIVEN visionera and visualisera WHEN archiving THEN they write to .agentera/archive/

### Task 5: Update linter for new discovery convention
**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN the linter WHEN checking path resolution THEN it validates against new canonical wording
▸ GIVEN ARTIFACT_CONTRACTS WHEN checking TODO.md THEN it validates new format elements
▸ GIVEN REQUIRED_REFS WHEN listing skills THEN hej is included
▸ GIVEN old-style SKILL.md WHEN running linter THEN path resolution check reports an error

### Task 6: Apply new convention to agentera's own artifacts and repo docs
**Depends on**: Tasks 2, 3, 4, 5
**Status**: □ pending
**Acceptance**:
▸ GIVEN agentera root WHEN listing THEN only TODO.md, CHANGELOG.md, VISION.md are artifact files
▸ GIVEN .agentera/ WHEN listing THEN all 8 operational artifacts plus archive/ are present
▸ GIVEN CLAUDE.md and README.md WHEN reading THEN they describe the new structure
▸ GIVEN .agentera/DOCS.md WHEN reading artifact mapping THEN paths match actual locations

### Task 7: Version bump per DOCS.md convention
**Depends on**: Task 6
**Status**: □ pending
**Acceptance**:
▸ GIVEN DOCS.md semver policy WHEN applying to this plan's changes THEN versions bump accordingly
▸ GIVEN registry.json WHEN checking versions THEN all match their plugin.json
▸ GIVEN marketplace.json WHEN checking collection version THEN it reflects the bump

## Overall Acceptance
▸ GIVEN a fresh project WHEN skills bootstrap THEN conventional files at root, operational in .agentera/
▸ GIVEN the linter WHEN validating all SKILL.md THEN 0 errors on path resolution
▸ GIVEN agentera root WHEN listing THEN only 3 skill-managed .md files present (plus README, CLAUDE.md)
▸ GIVEN DOCS.md mapping WHEN a project overrides paths THEN skills use overridden paths
▸ GIVEN .agentera/archive/ WHEN listing THEN it contains plans, visions, and designs (consolidated)

## Surprises
[Empty — populated by realisera during execution when reality diverges from plan]
