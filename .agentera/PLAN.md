# Plan: Unified "sharp colleague" voice across all skills (ISS-26)

<!-- Level: full | Created: 2026-04-02 | Status: active -->
<!-- Reviewed: 2026-04-02 | Critic issues: 8 found, 7 addressed, 1 dismissed -->

## What

Refine all 11 SKILL.md output templates, personality sections, and conversational
framing to match the "sharp colleague" voice standard defined in VISION.md and
Decision 16.

## Why

A tone audit revealed a systemic split: 3 skills sound like teammates, 8 read like
monitoring dashboards. The vision promises "a sharp colleague at your back" — the
skills should deliver that. Hej's returning-mode dashboard is the first thing users
see and it reads like Prometheus output.

## Constraints

- Voice emerges from vision alignment, not per-skill personality sections
- Structured data (glyphs, grades, progress bars) stays for scannability
- Each skill remains standalone — no cross-skill dependencies introduced
- Only SKILL.md files change — artifact formats (HEALTH.md, PLAN.md, etc.) are untouched
- Safety rails content unchanged — only tone of presentation
- Word limits in output constraints may be adjusted to accommodate human framing

## Scope

**In**: Output templates, personality sections, conversational framing instructions,
output word constraints in all 11 SKILL.md files

**Out**: Artifact template changes in `references/templates/`, ecosystem-spec.md
updates, linter modifications, README changes

**Deferred**: Updating artifact templates to reflect the voice standard — those are
consumed by skills, the SKILL.md instructions are what shape the output

## Design

Apply the "dashboard + human frame" pattern: structured data stays for scannability,
bookended by conversational opening and summary. For skills with existing personality
sections (resonera, visionera, visualisera), converge distinct voices to the unified
sharp colleague with domain expertise — techniques stay as expertise instructions,
not personality definitions. For skills without, rewrite output-facing instructions
so the agent speaks like a colleague, not a report generator.

Task 1 (hej) establishes the reference implementation of "dashboard + human frame."
Tasks 3-5 follow this reference when applying the pattern to other skills.

## Tasks

### Task 1: Rewrite hej with human frame (reference implementation)
**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN returning mode WHEN briefing is displayed THEN every data-dense section has interpretive framing before and after structured data
▸ GIVEN fresh mode WHEN welcome is displayed THEN the greeting sounds like a colleague orienting someone, not a feature matrix
▸ GIVEN the dashboard template WHEN read THEN no output section begins with raw structured data without a conversational opener

### Task 2: Converge resonera/visionera/visualisera to unified voice
**Depends on**: none
**Status**: □ pending
**Acceptance**:
▸ GIVEN the three personality sections WHEN read sequentially THEN they reference the same base voice with domain-specific expertise layered on
▸ GIVEN skill-specific techniques (Socratic, aspirational, exacting) WHEN preserved THEN they are framed as expertise instructions, not personality definitions
▸ GIVEN the updated personality text WHEN compared to VISION.md voice section THEN the descriptions use consistent language for the base voice

### Task 3: Warm up inspektera and optimera output framing
**Depends on**: Tasks 1, 2
**Status**: □ pending
**Acceptance**:
▸ GIVEN inspektera audit findings WHEN output template is read THEN every data-dense section has interpretive framing before structured data (per Task 1 reference)
▸ GIVEN optimera experiment results WHEN output template is read THEN results sections have interpretive framing, not raw metric tables
▸ GIVEN both skills' output sections WHEN compared to hej's updated template THEN the framing pattern is consistent

### Task 4: Warm up planera and realisera step instructions
**Depends on**: Tasks 1, 2
**Status**: □ pending
**Acceptance**:
▸ GIVEN planera's step instructions WHEN read THEN steps describe a colleague's reasoning process, not a form-filling procedure
▸ GIVEN realisera's cycle steps WHEN read THEN all steps maintain the same voice, not just the brainstorm phase
▸ GIVEN both skills' conversation sections WHEN compared THEN they use the unified voice, not distinct personality definitions

### Task 5: Warm up profilera, dokumentera, inspirera output
**Depends on**: Tasks 1, 2
**Status**: □ pending
**Acceptance**:
▸ GIVEN profilera's profile output instructions WHEN read THEN output framing describes a colleague reflecting, not an algorithm reporting
▸ GIVEN dokumentera's step instructions WHEN read THEN doc work is framed as a colleague's process, not a procedure engine
▸ GIVEN inspirera's analysis output template WHEN read THEN analysis sections have interpretive framing before structured data

### Task 6: Validate voice alignment across all 11 skills
**Depends on**: Tasks 1-5
**Status**: □ pending
**Acceptance**:
▸ GIVEN all 11 SKILL.md files WHEN ecosystem linter runs THEN 0 errors (structural integrity preserved after changes)
▸ GIVEN all 11 skills' output sections WHEN manually reviewed THEN every data-dense section has interpretive framing — no section opens with raw structured data
▸ GIVEN personality/voice sections across all skills WHEN compared THEN the base voice is described consistently, differing only in domain expertise

## Overall Acceptance

▸ GIVEN any skill's output instructions WHEN read THEN they direct the agent to frame data conversationally, not to dump structured output
▸ GIVEN all 11 skills WHEN personality/voice sections are compared THEN the same base voice is recognizable, differing only in expertise
▸ GIVEN the ecosystem linter WHEN run against all SKILL.md files THEN 0 errors, 0 new warnings

## Surprises

[Empty — populated by realisera during execution when reality diverges from plan]
