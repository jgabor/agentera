# Plan: Formatting Standard (Decision 14)

<!-- Level: full | Created: 2026-04-02 | Status: active -->
<!-- Reviewed: 2026-04-02 | Critic issues: 8 found, 6 addressed, 2 dismissed -->

## What

Implement the three-tier divider hierarchy, templated exit signals, step markers, and style rules across the ecosystem. All 11 SKILL.md files and ecosystem-spec.md Section 12 updated to a consistent formatting standard.

## Why

Eleven skills should feel like one system. Consistent formatting creates cohesion: users see the same opener pattern, exit signal structure, and progress markers regardless of which skill is active.

## Constraints

- Decision 14 design is firm: no re-deliberation on format choices
- ecosystem-spec.md must be updated before SKILL.md files (source of truth first)
- Formatting only: no behavioral or workflow changes
- Hej keeps its logo (no standard opener); hej and resonera excluded from step markers
- Step 0 (detect/mode gates) excluded from step markers: markers start at Step 1
- Optimera hypothesize rename dropped: "hypothesis" is load-bearing across SKILL.md, templates, and scripts

## Scope

**In**: exit signal format, opener phrasing, step markers (9 skills), synthesize-to-distill rename (inspektera only), scratchpad revision (resonera), style rules (colons, labeled metadata, generous newlines), ecosystem-spec update

**Out**: hej dashboard redesign, optimera verb rename, behavioral changes, linter extensions for new standards

**Deferred**: hej dashboard review (flagged in resonera session), linter checks for new formatting standards

## Design

Three-tier divider hierarchy:

- Skill boundary: `--- glyph skill . context ---` (3-dash, opener and exit)
- Step boundary: `-- step N/M: verb` (2-dash, workflow progress)
- Container: `-- label` (2-dash, mid-session blocks like scratchpad)

Step and container dividers are intentionally the same visual weight, differentiated by label content.

Exit signal visual format per status:

- complete: divider + one summary sentence
- flagged: divider + summary + bullet concern list
- stuck: divider + summary + bullet blocker list
- waiting: divider + summary + bullet need list

Style rules applied inline with each change: colons over em-dashes, labeled metadata, generous newlines.

## Tasks

### Task 1: Update ecosystem-spec.md Section 12

**Depends on**: none
**Status**: ■ complete
**Acceptance**:
▸ GIVEN ecosystem-spec.md Section 12 WHEN read THEN contains divider hierarchy table with all three levels and their use cases
▸ GIVEN ecosystem-spec.md Section 12 WHEN read THEN contains exit signal visual format template showing all four statuses with their output structure
▸ GIVEN ecosystem-spec.md Section 12 WHEN read THEN contains step marker specification with N/M format
▸ GIVEN ecosystem-spec.md composition rules WHEN read THEN defines "Skill introduction:" as the canonical instruction term for openers

### Task 2: Standardize exit signal sections across all 11 SKILL.md

**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
▸ GIVEN any SKILL.md exit signal section WHEN read THEN status descriptions use colon separators, not em-dashes
▸ GIVEN any SKILL.md exit signal section WHEN read THEN includes instruction referencing the visual exit format (divider + summary + bullets)
▸ GIVEN all 11 exit signal sections WHEN compared THEN structural format is consistent while per-skill context descriptions remain detailed

### Task 3: Opener phrasing, inspektera rename, resonera scratchpad

**Depends on**: Task 1
**Status**: □ pending
**Acceptance**:
▸ GIVEN any SKILL.md except hej WHEN opener instruction is read THEN uses "Skill introduction:" phrasing
▸ GIVEN inspektera SKILL.md WHEN step headings are read THEN Step 4 heading says "Distill" not "Synthesize" (prose "synthesized" in exit signal unchanged)
▸ GIVEN resonera SKILL.md WHEN scratchpad section is read THEN uses "-- scratchpad" container with shorter labels and no blockquote formatting

### Task 4: Step markers for single-mode skills

**Depends on**: Task 1
**Status**: □ pending
**Acceptance**:
▸ GIVEN realisera SKILL.md WHEN workflow section is read THEN contains step marker instruction with 8-step count (orient, select, research, plan, dispatch, verify, commit, log)
▸ GIVEN inspektera SKILL.md WHEN workflow section is read THEN contains step marker instruction with 6-step count (orient, select, assess, distill, report, connect)
▸ GIVEN planera SKILL.md WHEN workflow section is read THEN contains step marker instruction with 5-step count (orient, specify, review, write, handoff) excluding Step 0
▸ GIVEN optimera SKILL.md WHEN workflow section is read THEN contains step marker instruction with 7-step count (orient, analyze, hypothesize, implement, measure, decide, log)
▸ GIVEN inspirera SKILL.md WHEN workflow section is read THEN contains step marker instruction with 5-step count (identify, read, explore, map, deliver)

### Task 5: Step markers for multi-mode skills

**Depends on**: Task 1
**Status**: □ pending
**Acceptance**:
▸ GIVEN profilera SKILL.md WHEN workflow section is read THEN Full mode has 5-step markers and Validate mode has 4-step markers with per-mode N/M counts
▸ GIVEN visionera SKILL.md WHEN workflow section is read THEN Create mode has 4-step markers and Refine mode has 4-step markers
▸ GIVEN visualisera SKILL.md WHEN workflow section is read THEN Create (6 steps), Refine (3 steps), and Audit (3 steps) modes each have markers
▸ GIVEN dokumentera SKILL.md WHEN workflow section is read THEN First-run survey (4 steps) and all four execution modes each have per-mode markers

### Task 6: Validate

**Depends on**: Tasks 1, 2, 3, 4, 5
**Status**: □ pending
**Acceptance**:
▸ GIVEN the ecosystem linter WHEN run THEN passes with no regressions from current state
▸ GIVEN a manual checklist of all 11 files WHEN each is inspected THEN exit signals, opener phrasing, step markers, and style rules all conform to Decision 14

## Overall Acceptance

▸ GIVEN all 11 SKILL.md exit signal sections WHEN compared THEN all use colon separators and reference the visual format
▸ GIVEN all SKILL.md files except hej WHEN opener instruction is read THEN all use "Skill introduction:" phrasing
▸ GIVEN the 9 skills with step markers WHEN workflow sections are read THEN all contain step N/M marker instructions matching their step counts
▸ GIVEN ecosystem-spec.md Section 12 WHEN read THEN contains the complete formatting standard (divider hierarchy, exit format, step markers, instruction terms)
▸ GIVEN the ecosystem linter WHEN run THEN no regressions

## Surprises
