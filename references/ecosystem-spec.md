# Ecosystem Spec

<!-- Shared primitives for the agentera ecosystem. -->
<!-- All 11 skills/*/SKILL.md files must align with this spec. -->
<!-- Validated by scripts/validate-ecosystem.py (pre-commit hook). -->
<!-- See Decisions 7 and 8 in DECISIONS.md for rationale. -->

## 1. Confidence Scale

Canonical scale: **0-100 integer**.

Five tiers with shared boundaries. Each skill defines its own domain-specific labels
describing what the tier means in its context.

| Tier | Range | Semantic |
|------|-------|----------|
| 1 (highest) | 90-100 | Verified / near-certain |
| 2 | 70-89 | Strong evidence / established |
| 3 | 50-69 | Moderate evidence / emerging |
| 4 | 30-49 | Weak evidence / uncertain |
| 5 (lowest) | 0-29 | Speculative / extrapolated |

**Rules**:
- Skills producing confidence scores MUST use integer 0-100
- Skills consuming confidence scores MUST interpret them against these tier boundaries
- Temporal decay is opt-in: skills with a temporal dimension (e.g., profilera) may apply
  exponential decay; skills without one (e.g., inspektera) use static scores
- When referencing profile consumption thresholds, use 65+ for "strong constraint" and
  <45 for "suggestion" (integer equivalents of the 0.0-1.0 thresholds)

**Linter check**: Deterministic — regex for tier boundaries in SKILL.md text.

## 2. Severity Levels

Two severity vocabularies serve different purposes in the ecosystem.

### Finding severity (audit output)

Used by skills that produce audit findings (inspektera, dokumentera, visualisera).

| Level | Meaning |
|-------|---------|
| **critical** | Broken functionality, security issue, data loss risk |
| **warning** | Works but poorly — fragile, confusing, or degraded |
| **info** | Minor — cosmetic, style, low-impact improvement |

### Issue severity (TODO.md)

Used by all skills that file to TODO.md.

| Level | Glyph | Meaning |
|-------|-------|---------|
| **critical** | ⇶ | Broken functionality, blocks progress |
| **degraded** | ⇉ | Works but poorly — slow, fragile, ugly |
| **annoying** | ⇢ | Cosmetic, minor friction, style nit |

### Mapping

When filing audit findings to TODO.md, map as follows:

| Finding severity | → | Issue severity |
|-----------------|---|----------------|
| critical | → | critical |
| warning | → | degraded |
| info | → | annoying |

### TODO.md format convention

TODO.md uses a conventional checkbox format grouped by severity. Skills write items
as Markdown checkboxes under severity headings:

```markdown
# TODO

## ⇶ Critical
- [ ] description

## ⇉ Degraded
- [ ] description

## ⇢ Annoying
- [ ] description

## Resolved
- [x] ~~description~~ — resolved in commit hash
```

The severity vocabulary (critical/degraded/annoying) is preserved as section headings
with severity glyphs. Checkboxes indicate completion state. Resolved items move to
the Resolved section with strikethrough and commit reference.

**Linter check**: Deterministic — exact string matching for severity terms in context.

## 3. Decision Confidence Labels

Used in DECISIONS.md entries (produced by resonera, consumed by realisera, planera,
inspektera, profilera).

| Label | Meaning | How consuming skills treat it |
|-------|---------|-------------------------------|
| **firm** | User is committed | Treat as a hard constraint |
| **provisional** | Best current answer, open to revision | Treat as a strong default |
| **exploratory** | Direction to try, expected to be revisited | Treat as a suggestion |

**Linter check**: Deterministic — enum values in DECISIONS.md format definition.

## 4. Artifact Format Contracts

Each skill-maintained artifact has an expected structure. Producing skills define the
format; consuming skills depend on it.

### Default layout

Three project-facing files at the project root; eight operational files in `.agentera/`.

**Root (project-facing)**:

| File | Purpose |
|------|---------|
| VISION.md | Project north star |
| TODO.md | Actionable items with priority and checkboxes |
| CHANGELOG.md | Version-level change summaries (keep-a-changelog) |

**.agentera/ (operational)**:

| File | Purpose |
|------|---------|
| PROGRESS.md | Cycle-by-cycle operational log |
| DECISIONS.md | Reasoning trail |
| PLAN.md | Active work plan |
| HEALTH.md | Audit grades and findings |
| OBJECTIVE.md | Optimization target |
| EXPERIMENTS.md | Experiment log |
| DESIGN.md | Visual identity |
| DOCS.md | Documentation contract + optional artifact path overrides |
| archive/ | Completed plans, superseded visions and designs |

**PROFILE.md** is global at `~/.claude/profile/PROFILE.md` — not in the project root or
`.agentera/`. Skills read it from this path directly.

### Format contracts

| Artifact | Path | Producer | Consumers | Key structural elements |
|----------|------|----------|-----------|------------------------|
| VISION.md | VISION.md | visionera, realisera | realisera, planera, inspektera, dokumentera, visualisera | ## North Star, ## Who It's For, ## Principles, ## Direction, ## Identity |
| TODO.md | TODO.md | realisera, inspektera | realisera, planera | ## ⇶ Critical, ## ⇉ Degraded, ## ⇢ Annoying, ## Resolved |
| CHANGELOG.md | CHANGELOG.md | realisera | project contributors | ## [Unreleased], ### Added/Changed/Fixed |
| DECISIONS.md | .agentera/DECISIONS.md | resonera | planera, realisera, inspektera, profilera, optimera | ## Decision N — date, **Question/Context/Alternatives/Choice/Reasoning/Confidence/Feeds into** |
| PLAN.md | .agentera/PLAN.md | planera | realisera, inspektera | <!-- Level/Created/Status -->, ## Tasks with ### Task N, **Status/Depends on/Acceptance** |
| PROGRESS.md | .agentera/PROGRESS.md | realisera | planera, inspektera, dokumentera, visionera | ## Cycle N — date, **What/Commit/Inspiration/Discovered/Next/Context** |
| HEALTH.md | .agentera/HEALTH.md | inspektera | realisera, planera | ## Audit N — date, **Dimensions/Findings/Overall/Grades**, per-dimension sections |
| OBJECTIVE.md | .agentera/OBJECTIVE.md | optimera | optimera | ## Metric, ## Target, ## Baseline, ## Constraints |
| EXPERIMENTS.md | .agentera/EXPERIMENTS.md | optimera | optimera | ## Experiment N — date, **Hypothesis/Method/Result/Conclusion** |
| DESIGN.md | .agentera/DESIGN.md | visualisera | realisera, visionera | Standard sections per DESIGN-spec.md |
| DOCS.md | .agentera/DOCS.md | dokumentera | all skills (path resolution) | ## Conventions, ## Artifact Mapping, ## Index |
| PROFILE.md | ~/.claude/profile/PROFILE.md | profilera | all skills (via effective_profile) | ## Category, ### Decision, inline conf metadata |

**Dual-write**: realisera writes both CHANGELOG.md (public, version-level summaries for
project contributors) AND `.agentera/PROGRESS.md` (operational cycle-level detail for
consuming skills). Consuming skills that need cycle detail read `.agentera/PROGRESS.md`;
project contributors read CHANGELOG.md.

### CHANGELOG.md format convention

CHANGELOG.md follows the [Keep a Changelog](https://keepachangelog.com/) convention:

```markdown
# Changelog

## [Unreleased]

### Added
- description

### Changed
- description

### Fixed
- description

## [version] — YYYY-MM-DD

### Added
- description
```

Realisera appends entries under `## [Unreleased]` in the appropriate subsection
(Added/Changed/Fixed) based on the conventional commit type (feat → Added,
refactor → Changed, fix → Fixed). On version bumps, the Unreleased section is
promoted to a versioned heading.

**Linter check**: Advisory — flags missing structural elements as warnings, not errors.

### Token budgets

Per-artifact word limits. Producing skills check approximate word count before writing.
If a write would exceed the budget, compact first (see Compaction thresholds below).

| Artifact | Scope | Budget |
|----------|-------|--------|
| PROGRESS.md | Per-cycle entry | ≤500 words |
| PROGRESS.md | Full file | ≤3,000 words |
| EXPERIMENTS.md | Per-experiment entry | ≤300 words |
| EXPERIMENTS.md | Full file | ≤2,500 words |
| HEALTH.md | Per-dimension assessment | ≤150 words |
| HEALTH.md | Full file | ≤2,000 words |
| DECISIONS.md | Per-decision entry | ≤200 words |
| TODO.md | Per-item entry | ≤100 words |
| CHANGELOG.md | Per-version section | ≤300 words |
| PLAN.md | Per-task entry | ≤100 words |
| PLAN.md | Full file | ≤2,500 words |
| VISION.md | Full file | ≤1,500 words |
| DESIGN.md | Full file | ≤2,000 words |
| DOCS.md | Full file | ≤2,000 words |

Budgets are guidelines, not hard blockers. A 510-word cycle entry is fine; a 1,200-word
entry signals the write step lacks output constraints.

### Content exclusion

Artifacts store judgments, intent, reasoning, and context that would be lost without
them — the non-derivable residue. Do not duplicate state retrievable from the project's
files or history with a deterministic command.

| Exclude from artifacts | Retrieve from |
|------------------------|---------------|
| Files modified in a cycle | `git log --stat` |
| Function signatures from audits | `Grep` against source code |
| Dependency versions | Manifest files (package.json, go.mod, etc.) |
| Lines of code per module | `wc -l` or Glob + Read |
| Code snippets in PROGRESS.md | Commit diffs (`git show`) |
| Test names enumerated in findings | `Grep` against test files |

The test: if a reader can reconstruct the information from the project's current state
or git history, it does not belong in the artifact.

### Compaction thresholds

Growing artifacts (PROGRESS.md, EXPERIMENTS.md) are compacted to cap read cost for
consuming skills. Compaction runs when the producing skill writes a new entry.

**PROGRESS.md** — compacted by realisera when writing a new cycle entry:

| Tier | Entries | Format |
|------|---------|--------|
| Full detail | 10 most recent cycles | Standard cycle entry format |
| One-line archive | Cycles 11 through 50 | `Cycle N (YYYY-MM-DD): ≤15-word summary` |
| Dropped | Cycles older than 50 | Removed entirely |

When writing a new cycle: if >10 full-detail entries exist, collapse the oldest to
one-line format under an `## Archived Cycles` heading (below the recent cycles). If >40
one-line entries exist, drop the oldest. One-line summaries preserve cycle number, date,
and work-type — enough for trend analysis by consuming skills.

**EXPERIMENTS.md** — compacted by optimera when writing a new experiment:

| Tier | Entries | Format |
|------|---------|--------|
| Full detail | 8 most recent experiments | Standard experiment entry format |
| One-line archive | Experiments 9 through 30 | `EXP-N: ≤15-word result summary` |
| Dropped | Experiments older than 30 | Removed entirely |

Same logic: collapse oldest full-detail to one-line when >8 exist. Drop oldest one-line
when >22 one-line entries exist. Archive section sits below recent experiments under an
`## Archived Experiments` heading.

## 5. Artifact Path Resolution

The default artifact layout is deterministic (see Section 4, Default layout). Skills know
where artifacts live by convention — no discovery step required for the default case.

`.agentera/DOCS.md` is checked ONLY for path overrides. If a project needs artifacts in
non-default locations, dokumentera writes an Artifact Mapping section to `.agentera/DOCS.md`
with custom paths. Skills use those paths instead of the defaults.

Every skill that reads or writes artifacts MUST include the artifact path resolution
instruction. The canonical template:

```
### Artifact path resolution

Before reading or writing any artifact, check if .agentera/DOCS.md exists. If it has an
Artifact Mapping section, use the path specified for each canonical filename ({OWN_ARTIFACTS},
etc.). If .agentera/DOCS.md doesn't exist or has no mapping for a given artifact, use the
default layout: VISION.md, TODO.md, and CHANGELOG.md at the project root; all other artifacts
in .agentera/. This applies to all artifact references in this skill, including cross-skill
{reads_or_writes} ({CROSS_ARTIFACTS}).
```

Where:
- `{OWN_ARTIFACTS}` = the skill's own artifact filenames
- `{reads_or_writes}` = "reads", "writes", or "reads and writes" as appropriate
- `{CROSS_ARTIFACTS}` = artifacts from other skills that this skill accesses

The section MUST appear under "## State artifacts" (not under cross-skill integration or
elsewhere).

**Linter check**: Deterministic — section presence under correct parent heading, core
sentence pattern matching.

## 6. Profile Consumption

Skills that read the decision profile use one of two patterns:

### Script pattern (for skills that need confidence-weighted summaries)

```
python3 -m scripts.effective_profile
```

Run from the profilera skill directory. Mentioned skills: realisera, optimera, inspektera,
planera, inspirera.

Standard threshold language (after migration to 0-100):
- "high effective confidence entries (65+) are strong constraints"
- "low effective confidence entries (<45) are suggestions"

### Direct read pattern (for skills that need qualitative profile context)

Read `~/.claude/profile/PROFILE.md` directly. Mentioned skills: resonera, visionera,
dokumentera, visualisera.

Both patterns MUST include a fallback instruction:
"If the script or PROFILE.md is missing, proceed without persona grounding."

**Linter check**: Deterministic — script invocation syntax, threshold values, fallback
instruction presence.

## 7. Cross-Skill Integration Section

Every SKILL.md MUST contain a `## Cross-skill integration` section. Requirements:

### Ecosystem language

The section MUST open with: "[Skill name] is part of an eleven-skill ecosystem."

### Required references

The skill dependency graph defines which skills must be referenced:

| Skill | Must reference |
|-------|---------------|
| inspirera | realisera, optimera, visionera, resonera, profilera |
| profilera | realisera, optimera, inspirera, resonera, inspektera |
| realisera | visionera, optimera, inspirera, resonera, planera, inspektera, profilera |
| optimera | realisera, resonera, inspektera, profilera |
| resonera | realisera, optimera, inspirera, profilera, planera, inspektera |
| inspektera | realisera, resonera, planera, optimera, profilera |
| planera | resonera, realisera, optimera, inspektera, profilera, inspirera, dokumentera |
| visionera | realisera, resonera, profilera, inspirera, inspektera, visualisera |
| dokumentera | planera, realisera, inspektera, visionera, profilera |
| visualisera | visionera, realisera, dokumentera, inspektera, profilera, inspirera, resonera |

**Linter check**: Deterministic — section heading presence, ecosystem language match,
required skill references present.

## 8. Safety Rails Section

Every SKILL.md MUST contain a `## Safety rails` section with:

1. Opening `<critical>` tag
2. Bullet list of constraints (minimum 3)
3. Closing `</critical>` tag

Each constraint MUST begin with "NEVER" to clearly signal what the skill must not do.

**Linter check**: Deterministic — section heading, `<critical>` tag presence, minimum
constraint count, "NEVER" prefix pattern.

## 9. SKILL.md Frontmatter

Every SKILL.md MUST begin with YAML frontmatter containing:

| Field | Required | Format |
|-------|----------|--------|
| `name` | Yes | kebab-case skill name |
| `description` | Yes | Multi-line string (use `>` block scalar). Must include the skill's full acronym expansion, trigger patterns, and what the skill produces. |

The description field serves as the skill's trigger specification — it MUST contain
enough trigger phrases for Claude to activate the skill from natural language.

**Linter check**: Deterministic — frontmatter presence, required field presence, name
format (kebab-case).

## 10. Exit Signals

Every skill MUST report a completion status at the end of its workflow. This enables
downstream skills, orchestration layers, and the user to determine what happened without
parsing natural language.

### Statuses

| Status | Meaning | When to use |
|--------|---------|-------------|
| **complete** | All steps completed successfully | The skill's workflow ran to completion and all acceptance criteria (if any) were met |
| **flagged** | Completed, but with issues the user should know about | The workflow completed but discovered problems, made compromises, or has caveats worth surfacing |
| **stuck** | Cannot proceed | A hard blocker prevents completion — missing dependency, permission issue, ambiguous requirement too consequential to resolve autonomously |
| **waiting** | Missing information required to continue | The skill needs input, clarification, or a decision from the user or another skill before it can proceed |

### Rules

- Skills MUST report exactly one status at workflow completion
- The status MUST appear in a `## Exit signals` section in each SKILL.md,
  defining when the skill reports each status with skill-specific guidance
- `flagged` MUST list each concern — a bare status without details is
  not acceptable
- `stuck` and `waiting` MUST state what is blocking / what is needed and
  what was attempted
- The `## Exit signals` section is a peer to `## Safety rails` (not nested
  inside it)

### SKILL.md structural requirement

Each SKILL.md MUST contain a `## Exit signals` section with:

1. All four status terms (complete, flagged, stuck, waiting)
2. Skill-specific guidance on when each status applies in that skill's context

**Linter check**: Deterministic — `## Exit signals` heading presence, all four
status terms present in the section content (`exit-signals`).

## 11. Loop Guard

Skills that run autonomous loops (currently: realisera, optimera) MUST include an
escalation rule to prevent runaway cycles producing bad work.

### The rule

When the skill detects 3 consecutive failed cycles, it MUST:

1. **Stop** — do not attempt a 4th cycle on the same problem
2. **Log** — file the failure pattern to TODO.md with context: what was attempted,
   what failed, and what the skill thinks is wrong
3. **Surface** — tell the user what happened and recommend a course of action
   (e.g., "/resonera to deliberate on the approach", "manual investigation needed",
   "dependency missing")

### Failure detection

Consecutive failures are detected by reading the last 3 entries in PROGRESS.md. A cycle
counts as failed when:

- The commit was reverted or the verification step failed
- The cycle logged a blocker and pivoted to different work 3 times in a row
  (3 consecutive pivots = the available work surface is exhausted)
- The cycle's "Discovered" field logs the same issue that was supposed to be fixed

### Complementary mechanisms

Optimera's existing plateau detection in `analyze_experiments.py` detects experiment
stagnation (no improvement over N iterations). The loop guard is complementary:
plateau detection handles metric stagnation, escalation handles general execution failure.
Both can trigger independently.

### Applicability

The escalation rule is REQUIRED for autonomous-loop skills: `realisera`, `optimera`.

Other skills MAY include loop guard language but are not required to — their workflows
are typically single-invocation and do not risk runaway cycles.

### SKILL.md structural requirement

Autonomous-loop skills MUST include loop guard language in their
`## Exit signals` section, referencing the 3-failure threshold and
PROGRESS.md inspection.

**Linter check**: Deterministic — for skills in the autonomous-loop set (realisera,
optimera), check that the `## Exit signals` section contains both "3" (the
threshold) and a reference to PROGRESS.md or consecutive failure detection (`loop-guard`). Advisory
for all other skills.

## 12. Visual Identity

The ecosystem has a shared visual vocabulary defined in DESIGN.md (the project-level visual
identity, maintained by visualisera). This section defines the ecosystem-level conventions
that all SKILL.md files follow when formatting output and artifact content.

DESIGN.md is the source of truth for token definitions. This spec defines how skills use
those tokens — introduction patterns, semantic roles, and composition rules. Skills include
actual glyph characters inline in their output format examples (they run in target projects
without access to this repo's DESIGN.md).

### Skill glyphs

Each skill has a unique Unicode glyph used as a subtle signature in output.

| Skill | Glyph | Code | Meaning |
|-------|-------|------|---------|
| hej | 🞔 | U+1F794 | angular hub |
| realisera | ⧉ | U+29C9 | joined building blocks |
| inspektera | ⛶ | U+26F6 | viewfinder frame |
| resonera | ❈ | U+2748 | spark of insight |
| planera | ≡ | U+2261 | structured layers |
| visionera | ⛥ | U+26E5 | guiding star |
| optimera | ⎘ | U+2398 | measurement |
| dokumentera | ▤ | U+25A4 | text on page |
| profilera | ♾ | U+267E | permanent mark |
| inspirera | ⬚ | U+2B1A | frame to fill |
| visualisera | ◰ | U+25F0 | design grid |

### Semantic tokens

Six token families express status, urgency, certainty, and direction.

**Status** (task/item completion — square fill progression):

| State | Glyph | Code |
|-------|-------|------|
| complete | ■ | U+25A0 |
| in-progress | ▣ | U+25A3 |
| open | □ | U+25A1 |
| blocked | ▨ | U+25A8 |

**Severity** (issue urgency — rightward arrows, more arrows = more serious):

| Level | Glyph | Code |
|-------|-------|------|
| critical | ⇶ | U+21F6 |
| degraded | ⇉ | U+21C9 |
| annoying | ⇢ | U+21E2 |

**Confidence** (decision certainty — box-drawing line weight):

| Level | Glyph | Code |
|-------|-------|------|
| firm | ━ | U+2501 |
| provisional | ─ | U+2500 |
| exploratory | ┄ | U+2504 |

**Trends** (direction of change):

| Direction | Glyph | Code |
|-----------|-------|------|
| improving | ⮉ | U+2B89 |
| degrading | ⮋ | U+2B8B |

**Structural** (layout primitives):

| Element | Glyph/Pattern | Code |
|---------|---------------|------|
| section divider | `─── label ───────` | U+2500 |
| list item | ▸ | U+25B8 |
| inline separator | · | U+00B7 |
| flow / target | → | U+2192 |
| progress bar | █▓░ | U+2588/2593/2591 |

### Composition rules

- **Skill introduction**: every skill opens with `─── glyph skillname · context ───`
- **Logo placement**: the agentera logo (box-drawing characters) appears at key moments
  only — hej dashboard, major completions. Not every skill invocation.
- **Open structure**: no outer frames except the logo. Breathing room (blank lines) between
  sections. Section headers are clean labels — no glyphs in `##` Markdown headers.
- **Narrative position**: summaries close sections, not open them.
- **Markdown layering**: all artifacts stay valid standard Markdown. Visual tokens layer
  within sections alongside existing `##` headers, `**bold**` labels, and tables.

### Token-to-artifact mapping

| Artifact | Token families used |
|----------|---------------------|
| PLAN.md | Status (■/▣/□/▨) for task states |
| TODO.md | Severity (⇶/⇉/⇢) in section headings, Status (□/■) via checkboxes |
| DECISIONS.md | Confidence (━/─/┄) alongside confidence labels |
| HEALTH.md | Trends (⮉/⮋) for trajectory, severity for findings |
| PROGRESS.md | Status (■) for cycle completion markers |
| VISION.md | Structural (▸, ·) for principles and direction |
| DOCS.md | Structural (▸, ·) for index, status tokens for coverage |

### Rules

- Skills producing formatted output MUST use their assigned glyph in the skill
  introduction pattern
- Skills producing or consuming artifacts SHOULD use the token families specified
  in the token-to-artifact mapping
- Semantic tokens augment existing text labels — they do not replace them
  (`⇶ critical` not just `⇶`)
- New skills MUST be assigned a glyph in DESIGN.md before their SKILL.md is finalized

**Linter check**: Advisory — presence of skill glyph in SKILL.md output format sections.
Not deterministic because output format instructions vary by skill.
