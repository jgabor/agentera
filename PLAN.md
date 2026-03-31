# Plan: Visual Identity Rollout

<!-- Level: full | Created: 2026-03-31 | Status: active -->
<!-- Reviewed: 2026-03-31 | Critic issues: 8 found, 4 addressed, 4 dismissed -->

## What

Integrate agentera's visual identity system (Decision 11, DESIGN.md) across the ecosystem:
skill output instructions, artifact templates, and the ecosystem spec. Every skill's output
and every artifact template should reflect the visual vocabulary defined in DESIGN.md.

## Why

Decision 11 defined a complete visual token vocabulary — skill glyphs, status/severity/
confidence tokens, structural tokens, composition rules — but it only lives in DESIGN.md.
The 11 SKILL.md files still instruct plain Markdown output, and the 7 artifact templates
have no visual formatting. Until propagated, the visual identity only exists in theory.

## Constraints

- Artifacts must remain valid standard Markdown (visual tokens layered, not format replacement)
- Existing Markdown structure (`##` headers, `**bold**` labels, tables) stays intact
- The ecosystem linter (`scripts/validate-ecosystem.py`) must exit 0 after every task
- Each skill's individual personality is preserved — visual tokens add identity, not homogeneity
- SKILL.md output format sections include actual glyph characters inline in format examples
  (skills run in target projects without access to agentera's DESIGN.md)
- The ecosystem spec contains the canonical token definitions (the reference for skill authors)
- DESIGN.md is agentera's own visual identity — not a runtime dependency for skills

## Scope

**In**: ecosystem spec, 11 SKILL.md files, 7 artifact templates
**Out**: linter rule changes, existing artifact instances in this repo (DECISIONS.md etc.),
README updates, "ten-skill" → "eleven-skill" count fix (pre-existing, file separately)
**Deferred**: verbal register codification (discussed in resonera session, not decided)

## Design

Rollout follows a **spec → reference → propagation** pattern:

1. The ecosystem spec gets a new shared primitive section defining visual tokens as
   ecosystem-level conventions, with canonical glyph values
2. Hej's SKILL.md gets the full dashboard composition as the reference implementation
3. Artifact templates get visual tokens layered within existing Markdown structure
4. Each remaining skill's SKILL.md gets updated output format instructions

**Dependency structure**: Tasks 3-6 depend on Task 1 only (the spec). Task 2 (hej) is the
reference implementation but not a blocking dependency — all propagation tasks can begin
once the spec is written.

**Token-to-template mapping**:

| Template | Tokens used |
|----------|-------------|
| PLAN-template.md | Status (■/▣/□/▨) for task states |
| ISSUES-template.md | Severity (⇶/⇉/⇢) in issue headings |
| DECISIONS-template.md | Confidence (━/─/┄) alongside confidence labels |
| HEALTH-template.md | Trend (⮉/⮋) for trajectory, severity for findings |
| PROGRESS-template.md | Status (■) for cycle completion markers |
| VISION-template.md | Structural (▸, ·) for principles and direction |
| DOCS-template.md | Structural (▸, ·) for index entries, status tokens for coverage |

**Per-skill update checklist** (applies to every skill in Tasks 4-6):

- [ ] Skill introduction line uses pattern: `─── glyph skillname · context ───`
- [ ] Appropriate semantic tokens used in output format sections
- [ ] No glyphs added to `##` Markdown headers (layered within, not replacing)
- [ ] Skill's own glyph used consistently (not another skill's)
- [ ] `python3 scripts/validate-ecosystem.py` exits 0

## Tasks

### Task 1: Ecosystem spec — visual identity primitives
**Depends on**: none
**Status**: complete
**Acceptance**:
- GIVEN the ecosystem spec WHEN a skill author looks up visual tokens THEN section 12 defines all skill glyphs, status tokens, severity tokens, confidence tokens, trend tokens, and structural tokens with their Unicode code points and semantic meanings
- GIVEN the ecosystem spec WHEN it references DESIGN.md THEN it establishes DESIGN.md as the project-level visual identity and the spec as the ecosystem-level convention that all SKILL.md files follow
- GIVEN the ecosystem spec WHEN `python3 scripts/validate-ecosystem.py` runs THEN it exits 0 with no new errors

### Task 2: Hej — reference dashboard composition
**Depends on**: Task 1
**Status**: complete
**Acceptance**:
- GIVEN hej's Step 1b (returning mode) WHEN the dashboard format is described THEN the output uses skill glyphs as pulse line markers, severity arrows for attention items, `─── status ───` section dividers, the agentera logo at the top, and a narrative summary closing the status section
- GIVEN hej's Step 1a (fresh mode) WHEN the capability table is described THEN skill glyphs appear alongside skill names
- GIVEN hej's SKILL.md WHEN compared to Decision 11's reference composition THEN the format instructions match
- GIVEN hej's SKILL.md WHEN `python3 scripts/validate-ecosystem.py` runs THEN it exits 0

### Task 3: Artifact templates — visual token integration
**Depends on**: Task 1
**Status**: pending
**Acceptance**:
- GIVEN the PLAN template WHEN a task entry is written THEN status tokens (■/▣/□/▨) appear alongside the Status field
- GIVEN the ISSUES template WHEN an issue heading is written THEN severity arrows (⇶/⇉/⇢) appear alongside severity text
- GIVEN the DECISIONS template WHEN a confidence field is written THEN confidence line tokens (━/─/┄) appear alongside the text label
- GIVEN the HEALTH template WHEN a trend is shown THEN trend arrows (⮉/⮋) appear alongside trajectory description
- GIVEN any artifact template WHEN rendered as Markdown THEN all `##` headers, `**bold**` labels, and tables remain intact and valid

### Task 4: Execution skills — realisera, optimera
**Depends on**: Task 1
**Status**: pending
**Acceptance**:
- GIVEN realisera's output format instructions WHEN describing cycle introduction THEN it specifies `─── ⧉ realisera · cycle N ───`
- GIVEN optimera's output format instructions WHEN describing experiment results THEN it specifies trend arrows (⮉/⮋) alongside metric values
- GIVEN both skills' SKILL.md WHEN the per-skill checklist is applied THEN all items pass
- GIVEN both skills' SKILL.md WHEN `python3 scripts/validate-ecosystem.py` runs THEN it exits 0

### Task 5: Audit/analysis skills — inspektera, profilera, dokumentera
**Depends on**: Task 1
**Status**: pending
**Acceptance**:
- GIVEN inspektera's output format instructions WHEN describing findings THEN severity arrows (⇶/⇉/⇢) appear alongside severity text and confidence scores
- GIVEN profilera's output format instructions WHEN describing confidence levels THEN confidence line tokens (━/─/┄) appear
- GIVEN dokumentera's output format instructions WHEN describing coverage THEN status tokens appear for document status
- GIVEN all three skills' SKILL.md WHEN the per-skill checklist is applied THEN all items pass
- GIVEN all three skills' SKILL.md WHEN `python3 scripts/validate-ecosystem.py` runs THEN it exits 0

### Task 6: Deliberation/vision skills — resonera, planera, visionera, inspirera, visualisera
**Depends on**: Task 1
**Status**: pending
**Acceptance**:
- GIVEN any of these skills starting work WHEN introducing themselves THEN they use `─── glyph skillname · context ───`
- GIVEN resonera's running scratchpad WHEN displayed THEN it uses structural tokens (▸ for list items, · for separators)
- GIVEN planera's task display WHEN showing task status THEN it uses status tokens (■/▣/□/▨)
- GIVEN all five skills' SKILL.md WHEN the per-skill checklist is applied THEN all items pass
- GIVEN all five skills' SKILL.md WHEN `python3 scripts/validate-ecosystem.py` runs THEN it exits 0

## Overall Acceptance

- GIVEN a fresh agentera installation WHEN /hej is invoked in returning mode THEN the dashboard uses the full visual vocabulary from DESIGN.md — skill glyphs, severity arrows, progress bars, section dividers
- GIVEN any skill invocation WHEN the skill introduces itself THEN it uses the `─── glyph skillname · context ───` pattern
- GIVEN all SKILL.md files and templates WHEN `python3 scripts/validate-ecosystem.py` runs THEN no new validation errors are introduced
- GIVEN DESIGN.md and the ecosystem spec WHEN a contributor adds a new skill THEN they can find all visual tokens and composition rules in the ecosystem spec without reading every existing SKILL.md

## Surprises

[Empty — populated by realisera during execution when reality diverges from plan]
