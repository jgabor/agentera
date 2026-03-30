# Plan: Add Identity section to VISION.md and visionera

<!-- Level: light | Created: 2026-03-30 | Status: active -->
<!-- Decision: DECISIONS.md Decision 5 (2026-03-30) -->

## What

Add a four-dimension Identity section (personality, voice, emotional register, naming) to
VISION.md's template and visionera's conversation flow. Explicitly link to DESIGN.md as
the visual implementation of the declared identity.

## Why

VISION.md captures what a project does and why, but not who it is as an entity. A product's
personality, voice, and naming are as foundational as its north star — they constrain every
implementation decision from error messages to module names. Without an Identity section,
agents building UI or writing user-facing text have no guidance on tone and character.

## Constraints

- Identity section is aspirational, not prescriptive (consistent with VISION.md's nature)
- Four dimensions only: personality, voice, emotional register, naming
- Visionera must read DESIGN.md during exploration to ensure coherence with any existing
  visual system
- Skills are for public release — identity exploration works for any user, with profilera
  as optional defaults

## Acceptance Criteria

- GIVEN visionera's VISION.md template WHEN a user reads it THEN they find an Identity
  section with four subsections: personality, voice, emotional register, naming
- GIVEN visionera's create-mode conversation WHEN the dream/people/principles/direction
  arcs complete THEN a fifth arc explores the product's personality, voice, and naming
- GIVEN a project with a DESIGN.md file WHEN visionera explores the codebase THEN it
  reads DESIGN.md and references the visual identity when exploring the Identity arc
- GIVEN the realisera VISION.md template WHEN it bootstraps a vision via quick brainstorm
  THEN the Identity section is included in the template structure
