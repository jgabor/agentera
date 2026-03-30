# Plan: Create visualisera — visual identity skill

<!-- Level: full | Created: 2026-03-30 | Status: active -->
<!-- Reviewed: 2026-03-30 | Critic issues: 7 found, 4 addressed, 2 adjusted, 1 dismissed -->
<!-- Decision: DECISIONS.md Decision 6 (2026-03-30) -->

## What

Create visualisera as the 10th skill — the visual identity counterpart to visionera. It owns
the full DESIGN.md lifecycle: creating visual identity systems, refining them, and auditing
token usage against code. The DESIGN.md spec is bundled as a reference doc, eliminating the
external dependency.

## Why

Visionera says "read DESIGN.md" but doesn't understand the format. The spec lives externally
and is a moving target. Skills must work standalone — no external dependencies. DESIGN.md is
both a format spec AND a creative artifact that needs a dedicated creation/maintenance workflow.

## Constraints

- SKILL.md is the single source of truth for the skill's behavior
- All skills work standalone AND mesh when co-installed
- Visionera reads DESIGN.md for context; visualisera owns all writes
- The DESIGN.md spec is bundled as-is (it's already agent-readable)
- Each task must fit one realisera cycle

## Scope

**In**: SKILL.md, bundled spec reference, plugin metadata, cross-skill integration with
visionera, skill count updates, repo doc updates, DOCS.md template update

**Out**: Building the DESIGN.md CLI toolchain, creating DESIGN.md for this repo, deep
integration with realisera/inspektera/dokumentera beyond cross-skill section mentions

**Deferred**: Deep audit integration with inspektera, design token enforcement in realisera

## Tasks

### Task 1: Bundle the DESIGN.md spec, validation script, and create skill scaffold

**Depends on**: none
**Status**: complete
**Acceptance**:
- GIVEN the visualisera skill directory WHEN a reader looks in references/ THEN they find
  the complete DESIGN.md specification and an enforcement patterns reference doc
- GIVEN the skill directory WHEN checked for structure THEN it has SKILL.md (can be
  minimal/stub), references/, scripts/, and .claude-plugin/plugin.json
- GIVEN the bundled spec WHEN compared to the source THEN the content is a faithful snapshot
- GIVEN the scripts directory WHEN a reader checks it THEN they find a validate_design.py
  script (Python stdlib only) that parses `<!-- design:X -->` markers, extracts YAML blocks,
  validates structure (well-formed YAML, required sections, theme reference resolution),
  and outputs JSON
- GIVEN the enforcement patterns reference WHEN a reader checks it THEN it documents the
  three enforcement layers (validation, linting, audit) with depdevs as reference
  implementation, so users know what to build for their framework

### Task 2: Write visualisera SKILL.md — core create mode

**Depends on**: Task 1
**Status**: complete
**Acceptance**:
- GIVEN the SKILL.md WHEN a reader examines the frontmatter THEN they find name, description
  (with backronym and trigger patterns), consistent with other skills
- GIVEN the SKILL.md WHEN invoked on a project without DESIGN.md THEN it guides the user
  through creating a visual identity (brainstorm aesthetic, generate tokens, define constraints)
- GIVEN the SKILL.md WHEN the skill explores the codebase THEN it reads VISION.md Identity
  section to understand the declared personality and ensure visual coherence
- GIVEN the SKILL.md WHEN it has a state artifacts section THEN DESIGN.md is declared as
  the maintained artifact with artifact path resolution
- GIVEN the SKILL.md WHEN it has safety rails THEN they include critical guardrails
  consistent with other skills

### Task 3: Add refine mode, audit mode, cross-skill integration, and getting started

**Depends on**: Task 2
**Status**: complete
**Acceptance**:
- GIVEN the SKILL.md WHEN invoked on a project with existing DESIGN.md THEN it offers
  refine mode (evolve the design system) and audit mode (verify tokens are used in code)
- GIVEN the audit mode WHEN it validates DESIGN.md THEN it runs the bundled
  validate_design.py script for deterministic structural checks before agent-driven
  code analysis
- GIVEN the SKILL.md cross-skill section THEN it documents reading VISION.md Identity
  and relationships with visionera, realisera, dokumentera, and inspektera
- GIVEN the SKILL.md WHEN it has a getting started section THEN it provides concrete
  usage examples consistent with other skills

### Task 4: Update visionera and add bidirectional cross-skill references

**Depends on**: Task 3
**Status**: complete
**Acceptance**:
- GIVEN visionera's cross-skill integration WHEN a reader checks it THEN they find a section
  documenting that DESIGN.md is maintained by visualisera, with standalone-safe wording
  ("if visualisera is installed" / "if DESIGN.md exists")
- GIVEN visualisera's cross-skill section WHEN checked against visionera's THEN the
  references are bidirectional and consistent

### Task 5: Update all skill counts, metadata, and repo documentation

**Depends on**: Tasks 1, 2, 3, 4
**Status**: pending
**Acceptance**:
- GIVEN all 10 SKILL.md files WHEN checked for ecosystem count THEN they all say "ten-skill"
  (including dokumentera which currently uses different phrasing)
- GIVEN registry.json and marketplace.json WHEN checked THEN both contain 10 skill entries
  including visualisera
- GIVEN README.md WHEN a reader checks THEN the opening says "Ten skills", the skill table
  includes visualisera, the ecosystem diagram shows visualisera, and the state artifacts
  table includes DESIGN.md
- GIVEN CLAUDE.md WHEN checked THEN it says "ten skills"
- GIVEN DOCS.md WHEN checked THEN the artifact mapping includes DESIGN.md with visualisera
  as producer
- GIVEN the DOCS.md template in dokumentera/references/ WHEN checked THEN it includes
  DESIGN.md in the artifact mapping

## Overall Acceptance

- GIVEN the complete skill suite WHEN all 10 skills are installed THEN visualisera creates,
  maintains, and audits DESIGN.md files with no external dependency on the spec
- GIVEN visionera WHEN it reads DESIGN.md for Identity coherence THEN it understands the
  format because visualisera's bundled spec defines it
- GIVEN any of the 10 skills WHEN checked for ecosystem count THEN they all say "ten-skill"

## Surprises

<!-- Empty — populated by realisera during execution when reality diverges from plan -->
