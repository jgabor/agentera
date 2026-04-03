# Ecosystem Spec

<!-- Shared primitives for the agentera ecosystem. -->
<!-- All 12 skills/*/SKILL.md files must align with this spec. -->
<!-- Validated by scripts/validate_ecosystem.py (pre-commit hook). -->
<!-- See Decisions 7 and 8 in DECISIONS.md for rationale. -->

## 1. Confidence Scale

Canonical scale: **0-100 integer**.

Five tiers with shared boundaries. Each skill defines its own domain-specific labels describing what the tier means in its context.

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
- Temporal decay is opt-in: skills with a temporal dimension (e.g., profilera) may apply exponential decay; skills without one (e.g., inspektera) use static scores
- When referencing profile consumption thresholds, use 65+ for "strong constraint" and <45 for "suggestion" (integer equivalents of the 0.0-1.0 thresholds)

**Linter check**: Deterministic. Regex for tier boundaries in SKILL.md text.

## 2. Severity Levels

Two severity vocabularies serve different purposes in the ecosystem.

### Finding severity (audit output)

Used by skills that produce audit findings (inspektera, dokumentera, visualisera).

| Level | Meaning |
|-------|---------|
| **critical** | Broken functionality, security issue, data loss risk |
| **warning** | Works but poorly: fragile, confusing, or degraded |
| **info** | Minor: cosmetic, style, low-impact improvement |

### Issue severity (TODO.md)

Used by all skills that file to TODO.md.

| Level | Glyph | Meaning |
|-------|-------|---------|
| **critical** | ⇶ | Broken functionality, blocks progress |
| **degraded** | ⇉ | Works but poorly: slow, fragile, ugly |
| **normal** | → | Standard work: features, improvements, routine tasks |
| **annoying** | ⇢ | Cosmetic, minor friction, style nit |

### Mapping

When filing audit findings to TODO.md, map as follows:

| Finding severity | → | Issue severity |
|-----------------|---|----------------|
| critical | → | critical |
| warning | → | degraded or normal |
| info | → | annoying |

### TODO.md format convention

TODO.md uses a conventional checkbox format grouped by severity. Skills write items as Markdown checkboxes under severity headings:

```markdown
# TODO

## ⇶ Critical
- [ ] ISS-N: [type] Description

## ⇉ Degraded
- [ ] ISS-N: [type] Description

## → Normal
- [ ] ISS-N: [type] Description

## ⇢ Annoying
- [ ] ISS-N: [type] Description

## Resolved
- [x] ~~ISS-N: [type] Description~~ · resolved in commit hash
```

Type tags use the conventional commit vocabulary: feat, fix, docs, refactor, chore, test, perf.

The severity vocabulary (critical/degraded/annoying) is preserved as section headings with severity glyphs. Checkboxes indicate completion state. Resolved items move to the Resolved section with strikethrough and commit reference.

**Linter check**: Deterministic. Exact string matching for severity terms in context.

## 3. Decision Confidence Labels

Used in DECISIONS.md entries (produced by resonera, consumed by realisera, planera, inspektera, profilera).

| Label | Meaning | How consuming skills treat it |
|-------|---------|-------------------------------|
| **firm** | User is committed | Treat as a hard constraint |
| **provisional** | Best current answer, open to revision | Treat as a strong default |
| **exploratory** | Direction to try, expected to be revisited | Treat as a suggestion |

**Linter check**: Deterministic. Enum values in DECISIONS.md format definition.

## 4. Artifact Format Contracts

Each skill-maintained artifact has an expected structure. Producing skills define the format; consuming skills depend on it.

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

**PROFILE.md** is global at `~/.claude/profile/PROFILE.md`, not in the project root or `.agentera/`. Skills read it from this path directly.

### Format contracts

| Artifact | Path | Producer | Consumers | Key structural elements |
|----------|------|----------|-----------|------------------------|
| VISION.md | VISION.md | visionera, realisera | realisera, planera, inspektera, dokumentera, visualisera, orkestrera | ## North Star, ## Who It's For, ## Principles, ## Direction, ## Identity |
| TODO.md | TODO.md | realisera, inspektera | realisera, planera, orkestrera | ## ⇶ Critical, ## ⇉ Degraded, ## → Normal, ## ⇢ Annoying, ## Resolved |
| CHANGELOG.md | CHANGELOG.md | realisera | project contributors | ## [Unreleased], ### Added/Changed/Fixed |
| DECISIONS.md | .agentera/DECISIONS.md | resonera | planera, realisera, inspektera, profilera, optimera, orkestrera | ## Decision N · date, **Question/Context/Alternatives/Choice/Reasoning/Confidence/Feeds into** |
| PLAN.md | .agentera/PLAN.md | planera | realisera, inspektera, orkestrera | <!-- Level/Created/Status -->, ## Tasks with ### Task N, **Status/Depends on/Acceptance** |
| PROGRESS.md | .agentera/PROGRESS.md | realisera | planera, inspektera, dokumentera, visionera, orkestrera | ## Cycle N · date, **Phase/What/Commit/Inspiration/Discovered/Next/Context** |
| HEALTH.md | .agentera/HEALTH.md | inspektera | realisera, planera, orkestrera | ## Audit N · date, **Dimensions/Findings/Overall/Grades**, per-dimension sections |
| OBJECTIVE.md | .agentera/OBJECTIVE.md | optimera | optimera | ## Metric, ## Target, ## Baseline, ## Constraints |
| EXPERIMENTS.md | .agentera/EXPERIMENTS.md | optimera | optimera | ## Experiment N · date, **Hypothesis/Method/Result/Conclusion** |
| DESIGN.md | .agentera/DESIGN.md | visualisera | realisera, visionera | Standard sections per DESIGN-spec.md |
| DOCS.md | .agentera/DOCS.md | dokumentera | all skills (path resolution) | ## Conventions, ## Artifact Mapping, ## Index |
| PROFILE.md | ~/.claude/profile/PROFILE.md | profilera | all skills (via effective_profile) | ## Category, ### Decision, inline conf metadata |

**Dual-write**: realisera writes both CHANGELOG.md (public, version-level summaries for project contributors) AND `.agentera/PROGRESS.md` (operational cycle-level detail for consuming skills). Consuming skills that need cycle detail read `.agentera/PROGRESS.md`; project contributors read CHANGELOG.md.

### HEALTH.md audit dimensions

Inspektera assesses codebases across these dimensions, selecting applicable ones per audit. Each dimension produces an A-F grade, confidence-scored findings, and trend tracking.

| Dimension | What it evaluates |
|-----------|-------------------|
| Architecture alignment | Code vs stated architecture: pattern drift, boundary violations, layering breaks |
| Pattern consistency | Naming, error handling, structure, abstractions used consistently |
| Coupling health | Hidden dependencies, circular imports, god modules, inappropriate intimacy |
| Complexity hotspots | Long functions, deep nesting, high fan-out, accumulated conditionals |
| Test health | Coverage gaps, test quality, test-to-code ratio, behavior vs implementation testing |
| Dependency health | Outdated deps, security advisories, unused deps, pinning discipline |
| Version health | Unreleased feat/fix commits since last version bump |
| Artifact freshness | State artifacts current relative to plan activity or recent development |
| Security hygiene | Hardcoded secrets, dangerous function calls, basic injection patterns (lightweight regex scan; recommends dedicated tools for comprehensive analysis) |

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

## [version] · YYYY-MM-DD

### Added
- description
```

Realisera appends entries under `## [Unreleased]` in the appropriate subsection (Added/Changed/Fixed) based on the conventional commit type (feat → Added, refactor → Changed, fix → Fixed). On version bumps, the Unreleased section is promoted to a versioned heading.

**Linter check**: Advisory. Flags missing structural elements as warnings, not errors.

### Token budgets

Per-artifact word limits. Producing skills check approximate word count before writing. If a write would exceed the budget, compact first (see Compaction thresholds below).

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

Budgets are guidelines, not hard blockers. A 510-word cycle entry is fine; a 1,200-word entry signals the write step lacks output constraints.

### Content exclusion

Artifacts store judgments, intent, reasoning, and context that would be lost without them: the non-derivable residue. Do not duplicate state retrievable from the project's files or history with a deterministic command.

| Exclude from artifacts | Retrieve from |
|------------------------|---------------|
| Files modified in a cycle | `git log --stat` |
| Function signatures from audits | `Grep` against source code |
| Dependency versions | Manifest files (package.json, go.mod, etc.) |
| Lines of code per module | `wc -l` or Glob + Read |
| Code snippets in PROGRESS.md | Commit diffs (`git show`) |
| Test names enumerated in findings | `Grep` against test files |

The test: if a reader can reconstruct the information from the project's current state or git history, it does not belong in the artifact.

### Compaction thresholds

Growing artifacts (PROGRESS.md, EXPERIMENTS.md) are compacted to cap read cost for consuming skills. Compaction runs when the producing skill writes a new entry.

**PROGRESS.md**, compacted by realisera when writing a new cycle entry:

| Tier | Entries | Format |
|------|---------|--------|
| Full detail | 10 most recent cycles | Standard cycle entry format |
| One-line archive | Cycles 11 through 50 | `Cycle N (YYYY-MM-DD): ≤15-word summary` |
| Dropped | Cycles older than 50 | Removed entirely |

When writing a new cycle: if >10 full-detail entries exist, collapse the oldest to one-line format under an `## Archived Cycles` heading (below the recent cycles). If >40 one-line entries exist, drop the oldest. One-line summaries preserve cycle number, date, and work-type, enough for trend analysis by consuming skills.

**EXPERIMENTS.md**, compacted by optimera when writing a new experiment:

| Tier | Entries | Format |
|------|---------|--------|
| Full detail | 8 most recent experiments | Standard experiment entry format |
| One-line archive | Experiments 9 through 30 | `EXP-N: ≤15-word result summary` |
| Dropped | Experiments older than 30 | Removed entirely |

Same logic: collapse oldest full-detail to one-line when >8 exist. Drop oldest one-line when >22 one-line entries exist. Archive section sits below recent experiments under an `## Archived Experiments` heading.

## 5. Artifact Path Resolution

The default artifact layout is deterministic (see Section 4, Default layout). Skills know where artifacts live by convention, so no discovery step is required for the default case.

`.agentera/DOCS.md` is checked ONLY for path overrides. If a project needs artifacts in non-default locations, dokumentera writes an Artifact Mapping section to `.agentera/DOCS.md` with custom paths. Skills use those paths instead of the defaults.

Every skill that reads or writes artifacts MUST include the artifact path resolution instruction. The canonical template:

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

The section MUST appear under "## State artifacts" (not under cross-skill integration or elsewhere).

**Linter check**: Deterministic. Section presence under correct parent heading, core sentence pattern matching.

## 6. Profile Consumption

Skills that read the decision profile use one of two patterns:

### Script pattern (for skills that need confidence-weighted summaries)

```
python3 -m scripts.effective_profile
```

Run from the profilera skill directory. Mentioned skills: realisera, optimera, inspektera, planera, inspirera.

Standard threshold language (after migration to 0-100):
- "high effective confidence entries (65+) are strong constraints"
- "low effective confidence entries (<45) are suggestions"

### Direct read pattern (for skills that need qualitative profile context)

Read `~/.claude/profile/PROFILE.md` directly. Mentioned skills: resonera, visionera, dokumentera, visualisera.

Both patterns MUST include a fallback instruction:
"If the script or PROFILE.md is missing, proceed without persona grounding."

**Linter check**: Deterministic. Script invocation syntax, threshold values, fallback instruction presence.

## 7. Cross-Skill Integration Section

Every SKILL.md MUST contain a `## Cross-skill integration` section. Requirements:

### Ecosystem language

The section MUST open with: "[Skill name] is part of a twelve-skill ecosystem."

### Required references

The skill dependency graph defines which skills must be referenced:

| Skill | Must reference |
|-------|---------------|
| hej | visionera, resonera, planera, realisera, inspektera, optimera, dokumentera, visualisera, profilera, inspirera, orkestrera |
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
| orkestrera | planera, realisera, inspektera, inspirera, dokumentera, profilera, visionera, resonera, optimera, visualisera |

**Linter check**: Deterministic. Section heading presence, ecosystem language match, required skill references present.

## 8. Safety Rails Section

Every SKILL.md MUST contain a `## Safety rails` section with:

1. Opening `<critical>` tag
2. Bullet list of constraints (minimum 3)
3. Closing `</critical>` tag

Each constraint MUST begin with "NEVER" to clearly signal what the skill must not do.

**Linter check**: Deterministic. Section heading, `<critical>` tag presence, minimum constraint count, "NEVER" prefix pattern.

## 9. SKILL.md Frontmatter

Every SKILL.md MUST begin with YAML frontmatter containing:

| Field | Required | Format |
|-------|----------|--------|
| `name` | Yes | kebab-case skill name |
| `description` | Yes | Multi-line string (use `>` block scalar). Must include the skill's full acronym expansion, trigger patterns, and what the skill produces. |

The description field serves as the skill's trigger specification. It MUST contain enough trigger phrases for Claude to activate the skill from natural language.

**Linter check**: Deterministic. Frontmatter presence, required field presence, name format (kebab-case).

## 10. Exit Signals

Every skill MUST report a completion status at the end of its workflow. This enables downstream skills, orchestration layers, and the user to determine what happened without parsing natural language.

### Statuses

| Status | Meaning | When to use |
|--------|---------|-------------|
| **complete** | All steps completed successfully | The skill's workflow ran to completion and all acceptance criteria (if any) were met |
| **flagged** | Completed, but with issues the user should know about | The workflow completed but discovered problems, made compromises, or has caveats worth surfacing |
| **stuck** | Cannot proceed | A hard blocker prevents completion: missing dependency, permission issue, ambiguous requirement too consequential to resolve autonomously |
| **waiting** | Missing information required to continue | The skill needs input, clarification, or a decision from the user or another skill before it can proceed |

### Rules

- Skills MUST report exactly one status at workflow completion
- The status MUST appear in a `## Exit signals` section in each SKILL.md, defining when the skill reports each status with skill-specific guidance
- `flagged` MUST list each concern. A bare status without details is not acceptable
- `stuck` and `waiting` MUST state what is blocking / what is needed and what was attempted
- The `## Exit signals` section is a peer to `## Safety rails` (not nested inside it)

### SKILL.md structural requirement

Each SKILL.md MUST contain a `## Exit signals` section with:

1. All four status terms (complete, flagged, stuck, waiting)
2. Skill-specific guidance on when each status applies in that skill's context

**Linter check**: Deterministic. `## Exit signals` heading presence, all four status terms present in the section content (`exit-signals`).

## 11. Loop Guard

Skills that run autonomous loops (currently: realisera, optimera, orkestrera) MUST include an escalation rule to prevent runaway cycles producing bad work.

### The rule

When the skill detects 3 consecutive failed cycles, it MUST:

1. **Stop**: do not attempt a 4th cycle on the same problem
2. **Log**: file the failure pattern to TODO.md with context: what was attempted, what failed, and what the skill thinks is wrong
3. **Surface**: tell the user what happened and recommend a course of action
   (e.g., "/resonera to deliberate on the approach", "manual investigation needed", "dependency missing")

### Failure detection

Consecutive failures are detected by reading the last 3 entries in PROGRESS.md. A cycle counts as failed when:

- The commit was reverted or the verification step failed
- The cycle logged a blocker and pivoted to different work 3 times in a row
  (3 consecutive pivots = the available work surface is exhausted)
- The cycle's "Discovered" field logs the same issue that was supposed to be fixed

### Complementary mechanisms

Optimera's existing plateau detection in `analyze_experiments.py` detects experiment stagnation (no improvement over N iterations). The loop guard is complementary: plateau detection handles metric stagnation, escalation handles general execution failure. Both can trigger independently.

### Applicability

The escalation rule is REQUIRED for autonomous-loop skills: `realisera`, `optimera`, `orkestrera`.

Orkestrera uses retry-based failure detection (max 2 retries per task, escalation after 3 consecutive task failures) rather than PROGRESS.md consecutive-failure inspection.

Other skills MAY include loop guard language but are not required to. Their workflows are typically single-invocation and do not risk runaway cycles.

### SKILL.md structural requirement

Autonomous-loop skills MUST include loop guard language in their `## Exit signals` section, referencing the 3-failure threshold and either PROGRESS.md inspection (realisera, optimera) or retry-based task failure detection (orkestrera).

**Linter check**: Deterministic. For skills in the autonomous-loop set (realisera, optimera, orkestrera), check that the `## Exit signals` section contains both "3" (the threshold) and a reference to PROGRESS.md, consecutive failure detection, or retry-based task failure patterns (`loop-guard`). Orkestrera uses retry/task-based patterns instead of PROGRESS.md. Advisory for all other skills.

## 12. Visual Identity

The ecosystem has a shared visual vocabulary defined in DESIGN.md (the project-level visual identity, maintained by visualisera). This section defines the ecosystem-level conventions that all SKILL.md files follow when formatting output and artifact content.

DESIGN.md is the source of truth for token definitions. This spec defines how skills use those tokens: introduction patterns, semantic roles, and composition rules. Skills include actual glyph characters inline in their output format examples (they run in target projects without access to this repo's DESIGN.md).

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
| orkestrera | ⎈ | U+2388 | helm, steering |

### Semantic tokens

Six token families express status, urgency, certainty, and direction.

**Status** (task/item completion, square fill progression):

| State | Glyph | Code |
|-------|-------|------|
| complete | ■ | U+25A0 |
| in-progress | ▣ | U+25A3 |
| open | □ | U+25A1 |
| blocked | ▨ | U+25A8 |

**Severity** (issue priority, rightward arrows, more arrows = higher priority):

| Level | Glyph | Code |
|-------|-------|------|
| critical | ⇶ | U+21F6 |
| degraded | ⇉ | U+21C9 |
| normal | → | U+2192 |
| annoying | ⇢ | U+21E2 |

**Confidence** (decision certainty, box-drawing line weight):

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

- **Skill introduction**: every skill opens with `─── glyph skillname · context ───`.
  SKILL.md files reference this with the canonical instruction: `Skill introduction:` followed by the pattern with the skill's glyph and context word. Exception: hej uses the agentera logo instead of the standard opener.
- **Skill exit**: every skill closes with the same divider pattern, replacing the context word with the exit status: `─── glyph skillname · status ───`. See Exit signal format below.
- **Step progress**: skills with 4+ workflow steps show `── step N/M: verb` markers between steps. See Step markers below.
- **Logo placement**: the agentera logo (box-drawing characters) appears at key moments only: hej dashboard, major completions. Not every skill invocation.
- **Open structure**: no outer frames except the logo. Breathing room (blank lines) between sections. Section headers are clean labels: no glyphs in `##` Markdown headers.
- **Narrative position**: summaries close sections, not open them.
- **Markdown layering**: all artifacts stay valid standard Markdown. Visual tokens layer within sections alongside existing `##` headers, `**bold**` labels, and tables.

### Divider hierarchy

Three levels of visual dividers create a consistent hierarchy across skill output.

| Level | Pattern | Use |
|-------|---------|-----|
| Skill boundary | `─── glyph skillname · context ───` | Session opener, exit signal |
| Step boundary | `── step N/M: verb` | Workflow progress between steps |
| Container | `── label` | Mid-session blocks (scratchpad, etc.) |

Step and container dividers share the same visual weight (2-dash), differentiated by label content: step boundaries use `step N/M: verb`, containers use a descriptive label.

### Exit signal format

The exit signal's visual output matches the status reported. All four statuses use the skill boundary divider, followed by a summary and (for non-complete statuses) bullet details.

**complete**:
```
─── glyph skillname · complete ───

Summary sentence.
```

**flagged**:
```
─── glyph skillname · flagged ───

Summary sentence.

▸ concern one
▸ concern two
```

**stuck**:
```
─── glyph skillname · stuck ───

Summary sentence.

▸ blocked: what is blocking
▸ tried: what was attempted
```

**waiting**:
```
─── glyph skillname · waiting ───

Summary sentence.

▸ needs: what is required to proceed
```

### Step markers

Skills with 4+ workflow steps display progress markers between steps:

```
── step N/M: verb
```

N is the current step number, M is the total step count for the current mode, and verb is the step's bare-verb name (lowercase).

Rules:
- Step 0 (mode detection/gates) is excluded from the count: markers start at Step 1
- Skills with multiple modes use per-mode N/M counts (e.g., Create mode 1/4, Refine mode 1/4)
- Excluded skills: hej (uses dashboard format), resonera (interactive Q&A with scratchpad)

### Token-to-artifact mapping

| Artifact | Token families used |
|----------|---------------------|
| PLAN.md | Status (■/▣/□/▨) for task states |
| TODO.md | Severity (⇶/⇉/→/⇢) in section headings, Status (□/■) via checkboxes |
| DECISIONS.md | Confidence (━/─/┄) alongside confidence labels |
| HEALTH.md | Trends (⮉/⮋) for trajectory, severity for findings |
| PROGRESS.md | Status (■) for cycle completion markers |
| VISION.md | Structural (▸, ·) for principles and direction |
| DOCS.md | Structural (▸, ·) for index, status tokens for coverage |

### Rules

- Skills producing formatted output MUST use their assigned glyph in the skill introduction pattern
- Skills producing or consuming artifacts SHOULD use the token families specified in the token-to-artifact mapping
- Semantic tokens augment existing text labels, they do not replace them
  (`⇶ critical` not just `⇶`)
- New skills MUST be assigned a glyph in DESIGN.md before their SKILL.md is finalized

**Linter check**: Advisory. Presence of skill glyph in SKILL.md output format sections.

## 13. Narration Voice

Skills communicate with the user between structural markers, announcing modes, describing transitions, and narrating progress. This narration carries the ecosystem's voice: the sharp colleague (VISION.md), not a system log.

### The principle

Action narration. Brief, casual, tells the user what's happening without explaining internals. The colleague doesn't announce subroutines. She tells you what she's doing.

### Scope

| Element | Treatment |
|---------|-----------|
| Skill introduction (`─── glyph skill · word ───`) | Structural, unchanged |
| Step markers (`── step N/M: verb`) | Structural, unchanged |
| Exit signals (`─── glyph skill · status ───`) | Structural, unchanged |
| Mode announcements | Warm narration |
| Routing transitions | Warm narration |
| Ad-hoc process narration | Warm narration |

Structural elements are scannable markers: the user's eye finds them by shape, not by reading. Narration is conversational: the user reads it. Different jobs, different voice.

### Categories

**Mode announcements**: when a skill detects which path to take (fresh vs. returning, create vs. refine, full vs. validate). Say what you see and what you're about to do, not which branch of the flowchart you're entering.

**Routing transitions**: when one skill hands off to another. Say where you're going, not which function you're calling.

**Ad-hoc process narration**: what the agent says between structural markers while working. Brief status updates. Not internal monologue.

### Riffable examples format

SKILL.md files embed narration guidance as contrast pairs: a mechanical version (what not to say) and 2-3 warm alternatives (the register to riff on). The agent varies naturally; the examples set the register, not the script.

Format in SKILL.md:

```
Narration voice (riff, don't script):
✗ "Returning mode: reading artifacts for your briefing."
✓ "Pulling up the latest..." · "Checking in on the project..." · "Let me see where things stand..."
```

The `✗`/`✓` contrast pairs make the register learnable: the `✗` line shows what the default sounds like; the `✓` line shows what the colleague sounds like. Three alternatives per point give enough variance to avoid tics.

### Register

- **Tone**: casual, brief, action-oriented
- **Length**: ≤15 words per narration line
- **Content**: what you're doing, not what state you're in
- **Avoid**: system labels ("Returning mode"), internal jargon ("Proceed to Step 1b"), file-level narration ("Reading PROGRESS.md..."), compound announcements

### SKILL.md structural requirement

Skills with Step 0 mode detection (hej, visionera, profilera, visualisera, planera) MUST include contrast-pair narration examples at each mode announcement and routing transition point. Skills without mode detection inherit the principle for any ad-hoc narration; no SKILL.md changes required.
Not deterministic because output format instructions vary by skill.

## 14. Punctuation Conventions

All ecosystem text (SKILL.md files, this spec, templates, reference docs, agent output) follows a shared punctuation standard to keep prose scannable and consistent.

| Rule | Detail |
|------|--------|
| No em-dash (U+2014) | The `—` character is prohibited in all ecosystem text |
| No double dash (`--`) as prose punctuation | Double dashes used as word separators or parenthetical markers are prohibited. CLI flags in code blocks and inline code are exempt (they are syntax, not prose) |
| Replacement hierarchy | First restructure the sentence so no dash is needed. Fall back to commas, periods, or colons only when restructuring reads worse |
| Colon for label:value | Use colons as label-to-value separators (per Decision 14) |

**Linter check**: Deterministic. Regex for the em-dash character (U+2014) in SKILL.md files.

## 15. Line-Break Conventions

Prose paragraphs in ecosystem text are single lines. The terminal handles wrapping; hard wraps at arbitrary column widths create noisy diffs and complicate search.

| Rule | Detail |
|------|--------|
| One paragraph = one line | Do not manually wrap prose at 80 or 100 columns |
| Structured content keeps its line breaks | Code blocks, bullet lists, numbered lists, tables, headings, YAML frontmatter, and HTML comments retain their inherent structure |

**Linter check**: Advisory. Consecutive non-blank prose lines outside structured content (code blocks, lists, tables, frontmatter, headings).

## 16. Test Proportionality

Plans that include test tasks must specify a proportionality target so that test volume stays aligned with the complexity of the code under test. Without a constraint, autonomous agents tend to over-produce tests (3-7 per function) when fewer would cover the critical paths.

### Default rule

One pass test + one fail test per testable unit. A testable unit is a function, method, endpoint, or discrete behavior boundary. Two tests per unit is sufficient to verify the happy path and one meaningful failure mode.

### Edge case expansion

Additional edge case tests are warranted only for units with:

- Complex parsing logic (multiple input formats, escape sequences, nested structures)
- Regex patterns (boundary conditions, catastrophic backtracking potential)
- Multi-branch logic (3+ conditional paths, state machines, mode switches)

When expanding, the plan must state which units qualify and why.

### Override

Plans can specify a different proportionality target by including an explicit rationale. Valid reasons include: safety-critical code paths, high-fanout utility functions, or user-specified coverage requirements. The override appears in the task's acceptance criteria alongside the adjusted target.

### Skill integration

| Skill | Role |
|-------|------|
| planera | Encodes the proportionality target as an acceptance criteria constraint on test tasks. Uses the default rule unless the plan's context justifies an override |
| inspektera | Evaluates test volume against the proportionality target during audits. Flags both under-testing (0 tests for a testable unit) and over-testing (significantly exceeding the target without justification) |
| orkestrera | Includes anti-bias constraint in dispatch prompts for implementation tasks. Proportionality targets reach subagents through the plan's acceptance criteria, not through a separate orkestrera-level mechanism |

**Linter check**: None. This convention governs plan content and audit evaluation, not SKILL.md structure.

## 17. Phase Tracking

Every realisera cycle operates in one of five phases. Phases map the ecosystem's skills to a lifecycle model, making it possible for consuming skills to reason about what kind of work a cycle performed and whether phase transitions follow a coherent sequence.

### Phases

| Phase | Skills | Purpose |
|-------|--------|---------|
| **envision** | visionera | Define or refine the project's north star |
| **deliberate** | resonera | Reason through decisions before committing to a direction |
| **plan** | planera | Structure work into tasks with dependencies and acceptance criteria |
| **build** | realisera, optimera, dokumentera, visualisera | Implement, optimize, document, or design |
| **audit** | inspektera | Evaluate structural health and alignment |

### Transitions

Phases have valid successors. A cycle's phase is determined by the primary skill performing work, not by the phase of the previous cycle (phases are not a strict pipeline).

| From | Valid successors |
|------|-----------------|
| envision | deliberate, plan, build |
| deliberate | plan, build, envision |
| plan | build, deliberate |
| build | build, audit, plan |
| audit | build, plan, deliberate, envision |

**Terminal states**: audit and build are terminal in the sense that a project can remain in either phase indefinitely (continuous building, periodic auditing). envision, deliberate, and plan are transitional: they produce artifacts consumed by downstream phases.

**Self-transitions**: only build allows self-transition (consecutive build cycles are the normal case). Other phases produce a discrete output (a vision, a decision, a plan) and transition out.

### PROGRESS.md phase field

Each cycle entry in PROGRESS.md includes a **Phase** field immediately after the cycle heading. The value is one of the five phase names: `envision`, `deliberate`, `plan`, `build`, `audit`.

```markdown
■ ## Cycle N · YYYY-MM-DD HH:MM

**Phase**: build
**What**: one-line summary of what shipped
```

Consuming skills use the phase field for trend analysis (e.g., ratio of build to audit cycles, whether deliberation precedes major architectural changes).

**Linter check**: None. Phase tracking is defined here for producing and consuming skills. SKILL.md integration is handled per-skill, not by the ecosystem linter.

## 18. Staleness Detection

Stale artifacts mislead routing decisions and cause skills to act on outdated context. This section defines how staleness is detected and which artifacts each skill is expected to update.

### Skill-to-expected-artifact mapping

Each skill produces specific artifacts as part of its workflow. When a skill is dispatched (directly or via orkestrera), the artifacts listed here are the ones it is expected to have updated upon completion. This table is the authoritative lookup for staleness checks.

| Skill | Expected artifact outputs |
|-------|--------------------------|
| visionera | VISION.md |
| resonera | .agentera/DECISIONS.md |
| planera | .agentera/PLAN.md |
| realisera | .agentera/PROGRESS.md, TODO.md, CHANGELOG.md |
| optimera | .agentera/EXPERIMENTS.md, .agentera/OBJECTIVE.md |
| inspektera | .agentera/HEALTH.md, TODO.md |
| dokumentera | .agentera/DOCS.md |
| visualisera | .agentera/DESIGN.md |
| profilera | ~/.claude/profile/PROFILE.md |
| inspirera | (no owned artifact; findings are filed to TODO.md or fed into other skills) |
| orkestrera | (conductor; updates .agentera/PLAN.md task statuses and dispatches other skills) |
| hej | (router; reads artifacts but produces none) |

Skills that share an artifact (e.g., realisera and inspektera both write to TODO.md) are each expected to update it independently when dispatched. Staleness is checked per-skill, not per-artifact.

### Plan-relative staleness convention

When a plan exists (.agentera/PLAN.md with an active status), staleness is measured relative to the plan's creation date (the `Created` field in the plan's HTML comment metadata).

**Detection rule**: after a plan completes (all tasks `■ complete` or `skipped`), compare each dispatched skill against its expected artifacts. An artifact is **stale** if its last modification date (via `git log -1 --format=%aI -- <path>`) predates the plan's creation date AND the skill was dispatched at least once during the plan.

**What counts as dispatched**: a skill appears in at least one task's execution history during the plan. For orkestrera-driven plans, the dispatch log in PROGRESS.md cycle entries identifies which skills ran.

**Scope**: only artifacts listed in the mapping above are checked. Artifacts that a skill reads but does not produce (e.g., realisera reads VISION.md) are not staleness candidates for that skill.

**Handling stale findings**: stale artifacts are surfaced as context for the next plan cycle, not as errors. The consuming skill (orkestrera, inspektera) reports which artifacts are stale and which dispatched skills were expected to update them. This informs the next plan's task selection without blocking execution.

### Fallback: no plan context

When no active or recently completed plan exists (standalone skill invocation, ad-hoc inspektera audit, or hej session orientation), plan-relative detection is unavailable. The fallback heuristic applies:

**Fallback rule**: an artifact is considered potentially stale if it was not modified since the most recent PROGRESS.md cycle entry. If PROGRESS.md has no entries (fresh project), no staleness check applies.

The fallback is advisory, not authoritative. It surfaces artifacts that may need attention but does not carry the same signal strength as plan-relative detection (where the dispatched-skill relationship provides causal evidence of staleness).

**Linter check**: None. Staleness detection is a runtime convention consumed by orkestrera and inspektera, not a SKILL.md structural requirement.
