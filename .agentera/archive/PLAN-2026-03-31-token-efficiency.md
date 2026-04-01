# Plan: Token Efficiency

<!-- Level: full | Created: 2026-03-31 | Status: complete -->
<!-- Reviewed: 2026-03-31 | Critic issues: 10 found, 8 addressed, 2 dismissed -->

## What

Reduce token consumption per skill invocation and per artifact read across the 11-skill
ecosystem. Three layers: constrain what skills write (tighter outputs, compaction), optimize
what skills read (selective reading, stable-first templates), and short-circuit unnecessary
work (exit-early guards, parallel reads).

## Why

The "compounding over convenience" principle means every cycle deposits understanding — and
cost. After 35 realisera cycles, PROGRESS.md is substantial and growing. Skills that orient
by reading multiple artifacts (hej reads 10+, realisera reads 4-5, planera reads 3) pay
full-file read costs every invocation. SKILL.md files averaging 400-600 lines are loaded in
full on every skill activation. Artifact entries have no size constraints — a PROGRESS.md
cycle entry and a HEALTH.md finding can be any length. No compaction protocol caps artifact
growth.

For autonomous execution (/loop), token efficiency directly determines how many useful cycles
fit before context limits hit. Every token saved in skill instructions and artifact reads
compounds across every cycle of every session.

## Constraints

- Safety rails (`<critical>` sections) are exempt from prose tightening — safety is the wrong
  place to optimize for brevity
- All artifacts must remain valid standard Markdown
- Compaction must not destroy information that downstream skills or users actively need —
  archived summaries must preserve trend-relevant data (one-line-per-entry minimum)
- The ecosystem linter must pass after all changes
- Existing cross-skill contracts (artifact formats, path resolution, profile consumption)
  must not break
- `docs/token-efficiency-tasks.md` provides detailed implementation specifications — this
  plan defines outcomes, that document provides reference values and instruction text
- **Risk**: New conventions (token budgets, output constraints, compaction thresholds) are
  enforced by prose instructions only — linter rules for automated enforcement are deferred.
  Convention drift is possible until those rules are added.

## Scope

**In**: All 11 SKILL.md files, ecosystem-spec.md Section 4, 7 artifact templates, skill
orient/write step instructions

**Out**: Linter rule additions (useful but separate work), platform-specific caching
configuration, Python script changes

**Deferred**: Automated enforcement (linter checks for anchor presence, budget compliance)
— add after conventions stabilize

## Design

The work follows the same spec-first, template-second, skills-third progression used for the
confidence scale migration and visual identity rollout.

Foundation: Define token budget conventions, content exclusion principles, and compaction
thresholds in ecosystem-spec.md Section 4. All subsequent skill changes reference these shared
conventions.

Templates: Reorder artifact templates so stable SECTIONS appear before volatile sections. This
is section-level structural ordering (e.g., dimension definitions before latest grades in
HEALTH), not re-sorting of individual entries in append-only artifacts. Consuming skills can
then read predictable prefixes and skip trailing volatile content.

Skill instructions — write side: Add explicit word/sentence limits to every step that writes
artifacts, consistent with the reference doc's per-skill anchor table. Add scratchpad
discipline to reasoning-heavy skills (reason in the response, write only conclusions to
artifacts). Add compaction instructions to skills that maintain growing artifacts.

Skill instructions — read side: Add self-extraction priming between read and act steps (key
facts survive context compaction). Add parallel read nudges for independent reads. Add
exit-early guards after orient (skip expensive steps when nothing is actionable — scoped to
plan-driven operation, not vision-driven gap reasoning). Add selective reading instructions
(section or entry filters instead of full-file reads, with fallback to full read when filtered
data is insufficient).

Write conventions: Prefer targeted edits over full-file rewrites for artifact updates.

Final pass: Tighten instruction prose across all SKILL.md files after all additions are done.
Remove padding, convert to imperative mood, eliminate redundant phrasing. Target: 15-20%
reduction in non-safety, non-template line count per skill.

## Tasks

### Task 1: Define token budget, exclusion, and compaction conventions in ecosystem-spec.md
**Depends on**: none
**Status**: ■ complete
**Acceptance**:
- GIVEN ecosystem-spec.md Section 4 WHEN read THEN it contains per-artifact budgets specifying
  word limits for both per-entry and full-file sizes
- GIVEN ecosystem-spec.md Section 4 WHEN read THEN it contains a content exclusion principle
  listing categories of derivable state that skills must not write to artifacts
- GIVEN ecosystem-spec.md Section 4 WHEN read THEN it contains compaction thresholds for
  growing artifacts — how many entries in full, when to summarize to one-line-per-entry, when
  to drop — with archived summaries preserving trend-relevant data
- GIVEN the ecosystem linter WHEN run THEN 0 errors

### Task 2: Reorder artifact templates for stable-first section layout
**Depends on**: none
**Status**: ■ complete
**Acceptance**:
- GIVEN the 7 artifact template files WHEN read THEN stable/slow-changing sections appear
  before volatile/frequently-updated sections
- GIVEN each template WHEN its section order is examined THEN the ordering follows the
  principle: stable → semi-stable → volatile
- GIVEN templates WHEN read THEN they remain valid Markdown with all existing content
  preserved and no re-sorting of individual entries in append-only formats
- GIVEN the ecosystem linter WHEN run THEN 0 errors

### Task 3: Add numeric output constraints and compaction instructions to SKILL.md write steps
**Depends on**: Task 1
**Status**: ■ complete
**Acceptance**:
- GIVEN any SKILL.md step that writes to an artifact WHEN read THEN it contains at least one
  explicit word or sentence limit as an output constraint, consistent with the per-skill
  anchor table in docs/token-efficiency-tasks.md
- GIVEN skills that maintain growing artifacts (PROGRESS.md, EXPERIMENTS.md) WHEN their
  SKILL.md is read THEN they contain compaction instructions referencing the ecosystem-spec
  thresholds
- GIVEN the output constraints WHEN compared across skills THEN limits are proportional to the
  section's purpose (summaries shorter than analyses, per-entry tighter than full-section)
- GIVEN the ecosystem linter WHEN run THEN 0 errors

### Task 4: Add scratchpad separation to reasoning-heavy skills
**Depends on**: none
**Status**: ■ complete
**Acceptance**:
- GIVEN a skill that deliberates before writing artifacts WHEN its SKILL.md is read THEN it
  instructs the model to reason in the response text and write only conclusions to the artifact
- GIVEN the scratchpad instruction WHEN read THEN it specifies what goes to the artifact
  (decision + brief rationale, grade + finding, task list + criteria) and what stays in the
  response (reasoning chains, alternatives weighed, assessment details)
- GIVEN artifact entries produced under scratchpad discipline WHEN read by consuming skills
  THEN they contain enough context to act on without needing the reasoning chain (conclusion +
  rationale, not bare labels)

### Task 5: Add extraction priming and parallel read nudges to orient steps
**Depends on**: none
**Status**: ■ complete
**Acceptance**:
- GIVEN a skill that reads multiple artifacts during orient WHEN its SKILL.md is read THEN it
  contains a self-extraction instruction between the read step and the act step
- GIVEN the extraction instruction WHEN read THEN it tells the model to list key facts in the
  response text and explains that these survive context compaction
- GIVEN a skill that issues multiple independent reads WHEN its SKILL.md is read THEN it
  contains a parallel read nudge instructing all reads in a single response

### Task 6: Add exit-early guards and selective reading to consuming skills
**Depends on**: none
**Status**: ■ complete
**Acceptance**:
- GIVEN an autonomous skill's orient step in plan-driven mode WHEN the project state shows
  nothing actionable THEN the SKILL.md instructs the skill to report a `complete` exit signal
  and stop before proceeding to expensive steps
- GIVEN realisera's exit-early guard WHEN read THEN it applies only when operating from
  PLAN.md (not vision-driven gap reasoning, which is realisera's core mode)
- GIVEN each exit-early guard WHEN read THEN it states specific conditions (enumerated state
  checks, not vague "if nothing to do")
- GIVEN a consuming skill that only needs specific artifact sections WHEN its SKILL.md is read
  THEN it contains selective reading instructions (section filter, entry filter, or line limit
  — not "read full file") with a fallback to full read when the filtered data is insufficient
- GIVEN selective reading instructions WHEN read THEN write-back steps still read full context
  (selective reading applies only to read-only consumption)

### Task 7: Add delta write conventions to artifact-updating skills
**Depends on**: none
**Status**: ■ complete
**Acceptance**:
- GIVEN a skill that updates existing artifact entries WHEN its SKILL.md is read THEN it
  instructs use of targeted edits over full file rewrites for status changes and field updates
- GIVEN the delta write convention WHEN cross-referenced with ecosystem-spec THEN it is
  consistent with the stated preference
- GIVEN skills that already append (PROGRESS.md cycle entries, EXPERIMENTS.md entries,
  DECISIONS.md entries) WHEN their SKILL.md is read THEN no change is needed (append is already
  efficient)

### Task 8: Tighten SKILL.md instruction prose across all 11 skills
**Depends on**: Tasks 3, 4, 5, 6, 7
**Status**: ■ complete
**Acceptance**:
- GIVEN any SKILL.md WHEN its non-safety, non-template line count is compared to the pre-task
  version THEN the count is 15-20% lower while conveying the same information
- GIVEN the tightened prose WHEN read THEN it uses imperative mood and avoids padding phrases
  ("it is important to note that", "you should carefully consider", "make sure to check")
- GIVEN safety rails sections WHEN compared THEN they are NOT shortened
- GIVEN the ecosystem linter WHEN run THEN 0 errors
- GIVEN cross-skill integration sections WHEN compared THEN all required references are
  preserved

## Overall Acceptance

- GIVEN the full set of changes WHEN the ecosystem linter is run THEN 0 errors
- GIVEN ecosystem-spec.md WHEN read THEN it contains token budget, content exclusion, and
  compaction conventions
- GIVEN artifact templates WHEN read THEN stable sections precede volatile sections
- GIVEN any skill's artifact-writing step WHEN read THEN it contains numeric output constraints
- GIVEN any skill's orient step WHEN the skill only needs part of an artifact THEN selective
  reading is instructed
- GIVEN SKILL.md files WHEN word-counted THEN average non-safety line count is lower after
  Task 8 than before

## Surprises

- Cycle 37: 5 of 7 artifact templates already had correct stable-first ordering. Only HEALTH (Patterns Observed below audit entries) and ISSUES (Open before Resolved) needed reordering.
- Cycle 38: Worktree agents consistently started from stale commits (cycle 33 base instead of current HEAD), producing unusable diffs with ten→eleven regressions. Applied all changes directly on main.
- Cycle 40: First prose tightening attempt via worktree agents stripped all Task 2-7 additions despite explicit "do not touch" instructions. Second attempt without worktree isolation succeeded — 16.9% reduction with all additions preserved. Planera/visionera were hardest to tighten (8.0%, 13.3%) due to high ratio of protected sections; dokumentera/resonera had most padding (28.2%, 20.9%).
