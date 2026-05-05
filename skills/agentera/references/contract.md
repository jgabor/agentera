<!-- contract: agentera -->
<!-- source: SPEC.md (sha256: 4e1b7d31ab585371fb404917d800dc68e9e98b7deb218a9852bfebbc724968d7) -->
<!-- sections: 1, 2, 3, 4, 5, 6, 11, 13, 18, 19, 20, 22, 23 -->
<!-- generated: 2026-05-04T10:26:45Z -->
<!-- do not edit manually -->
<!-- validate: uv run scripts/validate_capability.py --self-validate -->

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

Two severity vocabularies serve different purposes in the suite.

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

Three project-facing files at the project root; nine operational files in `.agentera/`.

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
| OBJECTIVE.md | Optimization target (per-objective, under `.agentera/optimera/<name>/`) |
| EXPERIMENTS.md | Experiment log (per-objective, under `.agentera/optimera/<name>/`) |
| DESIGN.md | Visual identity |
| DOCS.md | Documentation contract + optional artifact path overrides |
| SESSION.md | Timestamped session bookmarks with artifact change tracking |
| archive/ | Completed plans, superseded visions and designs |

**PROFILE.md** is global. Profilera determines the platform-appropriate data directory: `$PROFILERA_PROFILE_DIR/PROFILE.md` (defaulting to `$XDG_DATA_HOME/agentera/PROFILE.md` on Linux, `~/Library/Application Support/agentera/PROFILE.md` on macOS, `%APPDATA%/agentera/PROFILE.md` on Windows). <!-- platform: profile-path --> Skills read it from the profilera-determined path directly. PROFILERA_PROFILE_DIR is the sibling of AGENTERA_HOME (Section 7): both are adapter-injected env vars. PROFILERA_PROFILE_DIR scopes to profile data; AGENTERA_HOME scopes to the install root that hosts the helper scripts skill prose invokes.

### Format contracts

| Artifact | Path | Producer | Consumers | Key structural elements |
|----------|------|----------|-----------|------------------------|
| VISION.md | .agentera/vision.yaml | visionera, realisera | realisera, planera, inspektera, dokumentera, visualisera, orkestrera | north_star, personas, principles, direction, identity |
| TODO.md | TODO.md | realisera, inspektera | realisera, planera, orkestrera | ## ⇶ Critical, ## ⇉ Degraded, ## → Normal, ## ⇢ Annoying, ## Resolved |
| CHANGELOG.md | CHANGELOG.md | realisera | project contributors | ## [Unreleased], ### Added/Changed/Fixed |
| DECISIONS.md | .agentera/decisions.yaml | resonera | planera, realisera, inspektera, profilera, optimera, orkestrera | ## Decision N · date, **Question/Context/Alternatives/Choice/Reasoning/Confidence/Feeds into** |
| PLAN.md | .agentera/plan.yaml | planera | realisera, inspektera, orkestrera | <!-- Level/Created/Status -->, ## Tasks with ### Task N, **Status/Depends on/Acceptance** |
| PROGRESS.md | .agentera/progress.yaml | realisera | planera, inspektera, dokumentera, visionera, orkestrera | ## Cycle N · date, **Phase/What/Commit/Inspiration/Discovered/Next/Context** |
| HEALTH.md | .agentera/health.yaml | inspektera | realisera, planera, orkestrera | ## Audit N · date, **Dimensions/Findings/Overall/Grades**, per-dimension sections |
| OBJECTIVE.md | .agentera/optimera/<name>/objective.yaml | optimera | optimera | ## Metric, ## Target, ## Baseline, ## Constraints, **Status** |
| EXPERIMENTS.md | .agentera/optimera/<name>/experiments.yaml | optimera | optimera | ## Experiment N · date, **Hypothesis/Method/Result/Conclusion**; ## Closure · date, **Final value/Target/Reason** |
| DESIGN.md | DESIGN.md | visualisera | realisera, visionera | Standard design sections with embedded `design:` YAML blocks |
| DOCS.md | .agentera/docs.yaml | dokumentera | all skills (path resolution) | conventions, mapping, index |
| SESSION.md | .agentera/session.yaml | session stop hook | session start hook, hej | sessions entries; compaction: 10 full + 40 one-line, oldest dropped |
| PROFILE.md | (profile-path capability) <!-- platform: profile-path --> | profilera | all skills (directly when present) | ## Category, ### Decision, inline conf metadata |

**Dual-write**: realisera writes both CHANGELOG.md (public, version-level summaries for project contributors) AND `.agentera/progress.yaml` (operational cycle-level detail for consuming skills). Consuming skills that need cycle detail read `.agentera/progress.yaml`; project contributors read CHANGELOG.md.

**Per-objective layout (optimera)**: OBJECTIVE.md and EXPERIMENTS.md are canonical artifact names, not fixed filenames. Each named optimization objective gets its own subdirectory under `.agentera/optimera/<name>/`, where `<name>` is the slugified objective name, with `objective.yaml` and `experiments.yaml` inside it. Optimera manages this layout; other skills do not read or write these artifacts directly.

**Objective closure contract (optimera)**: When an objective reaches its target, optimera closes that objective inside its own directory. `objective.yaml` records canonical closed state with `status: closed`, `closed_at`, `final_value`, `target`, and `reason`. `experiments.yaml` appends one `closure` entry with the same final evidence. Closure never creates a registry, symlink, root-level objective artifact, or DOCS.md fixed mapping.

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

Growing artifacts are compacted to cap read cost for consuming skills. Compaction runs when the producing skill writes a new entry. All growing artifacts follow a uniform 10/40/50 rule: 10 full-detail entries, 40 one-line archive entries, drop beyond 50 total.

**CHANGELOG.md is exempt**: it is the public version-level history and is not compacted.

**PROGRESS.md**, compacted by realisera when writing a new cycle entry:

| Tier | Entries | Format |
|------|---------|--------|
| Full detail | 10 most recent cycles | Standard cycle entry format |
| One-line archive | Cycles 11 through 50 | `Cycle N (YYYY-MM-DD): ≤15-word summary` |
| Dropped | Cycles older than 50 | Removed entirely |

When writing a new cycle: if >10 full-detail entries exist, collapse the oldest to one-line format under an `## Archived Cycles` heading (below the recent cycles). If >40 one-line entries exist, drop the oldest. One-line summaries preserve cycle number, date, and work-type, enough for trend analysis by consuming skills.

Active cycle entries are stored newest-first: descending by cycle number. Insert the newest full-detail cycle before older active cycles so `agentera progress --limit 1` reads the current cycle without scanning the full file.

**EXPERIMENTS.md**, compacted by optimera when writing a new experiment:

| Tier | Entries | Format |
|------|---------|--------|
| Full detail | 10 most recent experiments | Standard experiment entry format |
| One-line archive | Experiments 11 through 50 | `EXP-N: ≤15-word result summary` |
| Dropped | Experiments older than 50 | Removed entirely |

Same logic: collapse oldest full-detail to one-line when >10 exist. Drop oldest one-line when >40 one-line entries exist. Archive section sits below recent experiments under an `## Archived Experiments` heading.

**DECISIONS.md**, compacted by resonera when writing a new decision:

| Tier | Entries | Format |
|------|---------|--------|
| Full detail | 10 most recent decisions | Standard decision entry format |
| One-line archive | Decisions 11 through 50 | `Decision N (YYYY-MM-DD): [Choice] — ≤15-word summary` |
| Dropped | Decisions older than 50 | Removed entirely |

Same logic: collapse oldest full-detail to one-line when >10 exist. Drop oldest one-line when >40 one-line entries exist. Archive section sits below recent decisions under an `## Archived Decisions` heading. One-line summaries preserve decision number, date, and the chosen alternative.

When writing a new decision, choose `N` as one greater than the highest decision number in active and archived entries. Insert the new full entry in the active section immediately before `## Archived Decisions`; if no archive exists, append it at the end of the file. Active decision entries must have unique numbers and remain ascending by decision number. Do not reuse or renumber decisions except when repairing artifact corruption.

**Linter check**: Deterministic. Artifact validation rejects duplicate decision numbers and descending active decision order.

**HEALTH.md**, compacted by inspektera when writing a new audit:

| Tier | Entries | Format |
|------|---------|--------|
| Full detail | 10 most recent audits | Standard audit entry format |
| One-line archive | Audits 11 through 50 | `Audit N (YYYY-MM-DD): [grade] — ≤15-word summary` |
| Dropped | Audits older than 50 | Removed entirely |

Same logic: collapse oldest full-detail to one-line when >10 exist. Drop oldest one-line when >40 one-line entries exist. Archive section sits below recent audits under an `## Archived Audits` heading. One-line summaries preserve audit number, date, overall grade, and trajectory.

**TODO.md Resolved section**, compacted by realisera when marking an item resolved:

| Tier | Entries | Format |
|------|---------|--------|
| Full detail | 10 most recent resolved items | Standard resolved entry format |
| One-line archive | Items 11 through 50 | `- [x] ~~[ISS-NN]: ≤15-word resolution summary~~` |
| Dropped | Items older than 50 | Removed entirely |

Same logic: collapse oldest full-detail to one-line when >10 exist. Drop oldest one-line when >40 one-line entries exist. Compaction applies only within the `## Resolved` section; active severity sections are not affected.

**SESSION.md**, compacted by the session stop hook when writing a new bookmark:

| Tier | Entries | Format |
|------|---------|--------|
| Full detail | 10 most recent bookmarks | Standard bookmark format |
| One-line archive | Bookmarks 11 through 50 | `## YYYY-MM-DD HH:MM (≤15-word summary)` |
| Dropped | Bookmarks older than 50 | Removed entirely |

Same logic: collapse oldest full-detail to one-line when >10 exist. Drop oldest one-line when >40 one-line entries exist. Compaction is implemented in `hooks/session_stop.py` (constants `MAX_FULL_ENTRIES`, `MAX_ONELINE_ENTRIES`).

## 5. Artifact Path Resolution

The default artifact layout is deterministic (see Section 4, Default layout). Skills know where artifacts live by convention, so no discovery step is required for the default case.

`.agentera/docs.yaml` is checked ONLY for path overrides. If a project needs artifacts in non-default locations, dokumentera writes an Artifact Mapping section to `.agentera/docs.yaml` with custom paths. Skills use those paths instead of the defaults.

Every skill that reads or writes artifacts MUST include the artifact path resolution instruction. The canonical template:

```
### Artifact path resolution

Before reading or writing any artifact, check if .agentera/docs.yaml exists. If it has an
Artifact Mapping section, use the path specified for each canonical filename ({OWN_ARTIFACTS},
etc.). If .agentera/docs.yaml doesn't exist or has no mapping for a given artifact, use the
default layout: TODO.md, CHANGELOG.md, and DESIGN.md at the project root; canonical VISION.md
resolves to .agentera/vision.yaml; other agent-facing artifacts resolve to YAML files in .agentera/.
This applies to all artifact references in this skill, including cross-skill
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
Read `$PROFILERA_PROFILE_DIR/PROFILE.md` directly
```

Run from the profilera skill directory. Mentioned skills: realisera, optimera, inspektera, planera, inspirera.

Standard threshold language (after migration to 0-100):

- "high effective confidence entries (65+) are strong constraints"
- "low effective confidence entries (<45) are suggestions"

### Direct read pattern (for skills that need qualitative profile context)

Read PROFILE.md from the profilera-determined profile path (`$PROFILERA_PROFILE_DIR/PROFILE.md`, defaulting to `$XDG_DATA_HOME/agentera/PROFILE.md` on Linux). <!-- platform: profile-path --> Mentioned skills: resonera, visionera, dokumentera, visualisera.

Both patterns MUST include a fallback instruction:
"If the script or PROFILE.md is missing, proceed without persona grounding."

**Linter check**: Deterministic. Script invocation syntax, threshold values, fallback instruction presence.

PROFILERA_PROFILE_DIR is the sibling of AGENTERA_HOME (Section 7): both are adapter-injected env vars, but they scope to different surfaces. PROFILERA_PROFILE_DIR names the profile data directory (where PROFILE.md lives); AGENTERA_HOME names the agentera install root (where helper scripts referenced by skill prose live).

## 11. Exit Signals

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

## 13. Visual Identity

The suite has a shared visual vocabulary defined in DESIGN.md (the project-level visual identity, maintained by visualisera). This section defines the conventions that all SKILL.md files follow when formatting output and artifact content.

DESIGN.md is the source of truth for token definitions. This spec defines how skills use those tokens: introduction patterns, semantic roles, and composition rules. Skills include actual glyph characters inline in their output format examples (they run in target projects without access to this repo's DESIGN.md).

### Skill glyphs

Each skill has a unique Unicode glyph used as a subtle signature in output.

| Skill | Glyph | Code | Meaning |
|-------|-------|------|---------|
| hej | ⌂ | U+2302 | home base |
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

## 18. Phase Tracking

Every realisera cycle operates in one of five phases. Phases map the suite's skills to a lifecycle model, making it possible for consuming skills to reason about what kind of work a cycle performed and whether phase transitions follow a coherent sequence.

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

Each cycle entry in PROGRESS.md includes a `phase` field. The value is one of the five phase names: `envision`, `deliberate`, `plan`, `build`, `audit`.

```yaml
cycles:
  - number: N
    timestamp: YYYY-MM-DD HH:MM
    phase: build
    what: one-line summary of what shipped
```

Consuming skills use the phase field for trend analysis (e.g., ratio of build to audit cycles, whether deliberation precedes major architectural changes).

**Linter check**: None. Phase tracking is defined here for producing and consuming skills. SKILL.md integration is handled per-skill, not by the spec linter.

## 19. Staleness Detection

Stale artifacts mislead routing decisions and cause skills to act on outdated context. This section defines how staleness is detected and which artifacts each skill is expected to update.

### Skill-to-expected-artifact mapping

Each skill produces specific artifacts as part of its workflow. When a skill is dispatched (directly or via orkestrera), the artifacts listed here are the ones it is expected to have updated upon completion. This table is the authoritative lookup for staleness checks.

| Skill | Expected artifact outputs |
|-------|--------------------------|
| visionera | .agentera/vision.yaml |
| resonera | .agentera/decisions.yaml |
| planera | .agentera/plan.yaml |
| realisera | .agentera/progress.yaml, TODO.md, CHANGELOG.md |
| optimera | .agentera/optimera/<name>/experiments.yaml, .agentera/optimera/<name>/objective.yaml (paths are per-objective; staleness check uses glob `.agentera/optimera/*/experiments.yaml` and `.agentera/optimera/*/objective.yaml`) |
| inspektera | .agentera/health.yaml, TODO.md |
| dokumentera | .agentera/docs.yaml |
| visualisera | DESIGN.md |
| profilera | (profile-path capability) <!-- platform: profile-path --> |
| inspirera | (no owned artifact; findings are filed to TODO.md or fed into other skills) |
| orkestrera | (conductor; updates .agentera/plan.yaml task statuses and dispatches other skills) |
| hej | (router; reads artifacts but produces none) |

Skills that share an artifact (e.g., realisera and inspektera both write to TODO.md) are each expected to update it independently when dispatched. Staleness is checked per-skill, not per-artifact.

### Plan-relative staleness convention

When a plan exists (.agentera/plan.yaml with an active status), staleness is measured relative to the plan's creation date (the `Created` field in the plan's HTML comment metadata).

**Detection rule**: after a plan completes (all tasks `■ complete` or `skipped`), compare each dispatched skill against its expected artifacts. An artifact is **stale** if its last modification date (via `git log -1 --format=%aI -- <path>`) predates the plan's creation date AND the skill was dispatched at least once during the plan.

**What counts as dispatched**: a skill appears in at least one task's execution history during the plan. For orkestrera-driven plans, the dispatch log in PROGRESS.md cycle entries identifies which skills ran.

**Scope**: only artifacts listed in the mapping above are checked. Artifacts that a skill reads but does not produce (e.g., realisera reads VISION.md) are not staleness candidates for that skill.

**Handling stale findings**: stale artifacts are surfaced as context for the next plan cycle, not as errors. The consuming skill (orkestrera, inspektera) reports which artifacts are stale and which dispatched skills were expected to update them. This informs the next plan's task selection without blocking execution.

### Fallback: no plan context

When no active or recently completed plan exists (standalone skill invocation, ad-hoc inspektera audit, or hej session orientation), plan-relative detection is unavailable. The fallback heuristic applies:

**Fallback rule**: an artifact is considered potentially stale if it was not modified since the most recent PROGRESS.md cycle entry. If PROGRESS.md has no entries (fresh project), no staleness check applies.

The fallback is advisory, not authoritative. It surfaces artifacts that may need attention but does not carry the same signal strength as plan-relative detection (where the dispatched-skill relationship provides causal evidence of staleness).

**Linter check**: None. Staleness detection is a runtime convention consumed by orkestrera and inspektera, not a SKILL.md structural requirement.

## 20. Reality Verification Gate

Passing tests are necessary but not sufficient evidence that a cycle's work is real. A feature can be structurally correct (tests green, build clean, lint clean) and still be behaviorally broken against real project state: stale fixtures, mocked dependencies, or test doubles can hide regressions that only surface when the primary entrypoint runs against production-shaped inputs. The Reality Verification Gate closes this gap by requiring every cycle to observe its own behavior before declaring completion.

This gate is orthogonal to Section 19 Staleness Detection. Section 19 asks: did the dispatched skill update the artifacts it owns? Section 20 asks: did the cycle's new behavior actually run against real state? The two gates enforce different invariants and must both hold for a cycle to be considered verified.

### Evidence format

Every cycle entry in PROGRESS.md carries a `verified` field alongside phase, what, commit, inspiration, discovered, next, and context fields. The field is mandatory: no cycle is considered closed without it. The field accepts exactly one of three shapes:

| Shape | Content |
|-------|---------|
| Observed output | A short transcript (or summary) of the primary entrypoint running against real project state, with the observable result recorded verbatim. The transcript should be concrete enough that a reader can tell whether the behavior actually happened |
| Allowlisted N/A tag | `N/A: <tag>` where `<tag>` is drawn from the enumerated allowlist below |
| Free-form N/A rationale | A prose sentence of at least 8 words explaining specifically why the change has no observable behavior. Shorter rationales fail the gate |

Observed output is always preferred when the change is runnable. The N/A paths exist only for genuinely unrunnable work; they are not an escape hatch for "I didn't feel like running it."

### N/A allowlist

Exactly five tags are recognized. Any other shorthand must fall through to the free-form rationale path.

| Tag | Meaning |
|-----|---------|
| `docs-only` | The change touched only documentation files (README, spec, skill instructions, templates) with no code path affected |
| `refactor-no-behavior-change` | The change restructured code but preserved observable behavior exactly; the existing test suite is the verification surface |
| `chore-dep-bump` | The change updated a dependency version without modifying any project code that calls that dependency differently |
| `chore-build-config` | The change modified build tooling, linter configuration, or packaging metadata without altering runtime behavior |
| `test-only` | The change added or adjusted tests without modifying the code under test |

A cycle that bundles runnable work with an N/A-tagged change still requires observed output for the runnable portion. The tag covers only the non-runnable slice.

### Project-archetype taxonomy

"Primary entrypoint" is defined per project archetype, not asserted per cycle. When a cycle touches multiple subsystems, the primary entrypoint is the one most closely tied to the change under verification.

| Archetype | Canonical entrypoint form |
|-----------|---------------------------|
| CLI tool | Invoke the binary with realistic arguments that exercise the changed path, capturing stdout/stderr and exit code |
| Library / SDK | Run a smoke driver (a short script or REPL session) that exercises the public API surface touched by the change |
| Web service | Send a request to a production-shaped endpoint (local server with production configuration or a staging instance) and record the response |
| Skill repo | Dispatch the skill via the eval mechanism capability (Section 21) against a representative prompt and capture the observed skill output <!-- platform: eval-mechanism --> |
| Design system | Render a representative component against the real design tokens and visually inspect (screenshot or DOM snapshot) against the expected output |
| Data pipeline | Run the pipeline against a real input sample (not synthetic fixtures) and record the observed output or side effects |

Projects with an archetype not listed here document their canonical entrypoint form in `.agentera/docs.yaml` under a `verification_entrypoint` key. The taxonomy is extensible; the table above is the minimum coverage.

### Optional verification budget

Some cycles touch slow subsystems (full data pipeline runs, long-running integration scenarios) where a complete reality check exceeds a reasonable per-cycle time budget. Projects that need a cap set a `verification_budget` key in `.agentera/docs.yaml` specifying the maximum wall-clock time per cycle. When a cycle's verification step exceeds the configured budget, the cycle MAY downgrade to a partial verification rather than blocking indefinitely.

Partial verifications record `verified: "partial (budget hit): ..."` with a short note capturing what was attempted, what was observed before the budget was hit, and which portions of the behavior remain unverified. Partial verifications are valid cycle closures but are visible to consuming skills as weaker signal: inspektera audits treat a string of partial verifications as a health finding requiring attention.

Projects without a `verification_budget` key have no time cap. The default is: take as long as verification honestly requires.

### Skill-to-gate mapping

The gate is enforced independently by two skills; each holds a different phase and a different slice of the enforcement contract.

| Skill | Role | Phase | What it enforces |
|-------|------|-------|------------------|
| realisera | Primary enforcer | Cycle close | Runs the primary entrypoint against real project state and writes the observed output into the cycle's `verified` field. Blocks cycle completion if the field cannot be populated with observed output, an allowlisted tag, or a qualifying free-form rationale |
| orkestrera | Secondary enforcer | Task evaluation | Reads the latest PROGRESS.md cycle entry for the dispatched task, confirms the `verified` field is present and non-empty (artifact read only; no source code read), and extends its inspektera dispatch prompt to include the Section 20 evidence-format snippet so inspektera audits whether the recorded content corresponds to the task's acceptance criteria |

Realisera holds the primary enforcement contract because it is the skill that actually produces cycle entries. Orkestrera holds a lighter presence-and-quality check because it reads artifacts but never touches code; the full content audit is delegated to inspektera via the dispatch prompt.

**Linter check**: Deterministic. Realisera and orkestrera SKILL.md files must reference Section 20 by name and include the `verified` field in any PROGRESS.md cycle format examples they carry.

## 22. Session Corpus Contract

Profilera mines decision patterns from host session data to produce PROFILE.md. The extraction currently depends on Claude Code's internal storage layout (JSONL files, memory directories, project-scoped configs). This section defines the normalized data model that any host adapter can produce, decoupling profilera's behavioral contract from a specific runtime's file layout.

The contract is a data model, not a path model. It specifies what profilera needs to observe, not where the host stores it. Claude Code continues to derive this corpus from its native paths; other runtimes produce the same normalized records from their own storage.

### Record types

Four canonical record families capture the decision-relevant signals profilera consumes. Each record is a JSON object with provenance metadata at top level and domain fields nested under `data`. Adapters MAY define additional runtime-specific record types (see Runtime extensions below).

#### Provenance metadata

Every record includes these fields regardless of type:

| Field | Required | Type | Purpose |
|-------|----------|------|---------|
| `source_id` | Yes | string | Stable identifier for deduplication across extractions |
| `timestamp` | Yes | string (ISO 8601) | When the record was created or observed |
| `project_id` | Yes | string | Project this record belongs to; `"global"` for non-project-scoped data |
| `project_path` | No | string | Filesystem path to the project, when available |
| `session_id` | No | string | Host session identifier, when applicable |
| `source_kind` | Yes | string | Which record family this record belongs to (one of the four portable names below, or a runtime extension name) |
| `runtime` | Yes | string | Host runtime that produced this record (e.g., `"claude-code"`, `"opencode"`) |
| `adapter_version` | Yes | string | Version of the adapter that extracted this record |
| `data` | Yes | object | Type-specific payload for this record |

The `source_id` field enables idempotent re-extraction: the same logical record produces the same `source_id` regardless of when extraction runs. The `runtime` and `adapter_version` fields enable profilera to handle schema variations across runtimes.

All fields listed in the record family tables below live inside `data`, not beside provenance fields. This keeps provenance stable across runtimes while allowing each source family to carry its own payload shape.

#### instruction_document

Global or project-scoped instruction files the host exposes to agents. These encode recurring preferences, constraints, and standards.

| Field | Required | Type | Purpose |
|-------|----------|------|---------|
| `doc_type` | Yes | string | Kind of instruction document (e.g., `"claude_md"`, `"agents_md"`) |
| `name` | Yes | string | Canonical name for this document |
| `description` | No | string | Human-readable summary |
| `content` | Yes | string | Full text content |
| `scope` | Yes | string | `"global"` or `"project"` |

Claude Code source: `~/.claude/CLAUDE.md`, `~/git/*/CLAUDE.md`, `~/git/*/AGENTS.md` <!-- platform: artifact-resolution -->

#### history_prompt

Decision-rich prompts from the host's command history. These capture what the user asked, when, and in what project context.

| Field | Required | Type | Purpose |
|-------|----------|------|---------|
| `prompt` | Yes | string | The user's prompt text |
| `signal_type` | Yes | string | Classification: `"decision"`, `"correction"`, or `"question"` |

Claude Code source: `~/.claude/history.jsonl`, filtered by decision-pattern regex <!-- platform: artifact-resolution -->

#### conversation_turn

Normalized user or assistant turns from host conversation sessions. Profilera uses paired user-assistant exchanges to identify how decisions were made and corrected in context.

| Field | Required | Type | Purpose |
|-------|----------|------|---------|
| `actor` | Yes | string | `"user"` or `"assistant"` |
| `content` | Yes | string | Turn text content |
| `preceding_context` | No | string | Prior assistant proposal (for user turns that respond to a proposal) |
| `signal_type` | No | string | Classification of the user's response: `"decision"`, `"correction"`, or `"question"` |

Claude Code source: `~/.claude/projects/**/*.jsonl`, filtered for decision-rich exchanges <!-- platform: artifact-resolution -->

#### project_config_signal

Recurring configuration or toolchain patterns associated with a project. These are objective evidence of technology choices, linting standards, and build conventions.

| Field | Required | Type | Purpose |
|-------|----------|------|---------|
| `config_type` | Yes | string | Kind of configuration file (e.g., `"gomod"`, `"golangci"`, `"package_json"`) |
| `file_path` | No | string | Path to the config file within the project |
| `signals` | Yes | array of string | Extracted key-value signals (dependencies, linters, targets, etc.) |

Claude Code source: `~/git/*/` config files scanned per known config type list <!-- platform: artifact-resolution -->

### Source families

The four portable record types group into four source families for profilera's consumption. The "Crystallized decisions" family is powered by instruction_document alone (durable, explicitly authored decisions). Runtime extensions may contribute additional record types to this family.

| Family | Record types | Signal character |
|--------|-------------|-----------------|
| Crystallized decisions | instruction_document | Highest signal: explicitly authored preferences and standards |
| Decision history | history_prompt | Broad coverage: what the user asked across all sessions |
| Conversation exchanges | conversation_turn | Most nuanced: how decisions were made and corrected in context |
| Config patterns | project_config_signal | Most objective: what technology and standards actually shipped |

### Degradation

Profilera operates in two modes: full (all four source families) and partial (one or more families missing). The degradation rules specify what profilera can produce given incomplete corpus availability.

| Available families | Profilera mode | Profile quality |
|--------------------|---------------|-----------------|
| All four | Full | Complete profile: all 12 categories, cross-validated confidence scores |
| Crystallized only | Partial | Instruction-heavy profile: strong in architecture/tooling standards, weak in process/workflow and meta-decision patterns |
| Crystallized + one other | Partial | Substantially complete: most categories populated, confidence scores may be lower for categories that depend on the missing family |
| History or conversations only (no crystallized) | Partial | Behavior-only profile: can infer patterns from actions but lacks explicit preferences. Confidence scores capped at 60 |
| Config patterns only | Minimal | Technology fingerprint only: tooling and dependency patterns, no behavioral decisions. Profilera should warn the user this is not a full profile |

**Degradation surface rule**: when a source family is missing, profilera MUST note which families were absent in the profile's source metadata comment. This lets consuming skills weight profile entries appropriately: a profile built from config patterns only should not be treated as authoritative for workflow decisions.

**Adapter responsibility**: the host adapter documents which source families it can produce. A minimal adapter that only provides instruction_document (reading a global config file) is valid; profilera produces the best profile it can with what is available. The adapter does not need to implement all four portable record types.

### Runtime extensions

Adapters MAY define additional record types beyond the four portable ones to capture runtime-specific data that enriches profilera's output. These extensions are documented in the adapter's design and are not required for profilera to operate.

**Claude Code extension: memory_entry**

Claude Code provides a built-in memory system that persists user and project memory as Markdown files with optional frontmatter at `~/.claude/projects/*/memory/*.md`. The Claude Code adapter extracts these as instruction_document records with `doc_type: "claude_memory"` rather than as a separate record type, keeping the portable corpus contract clean.

| Field | Required | Type | Purpose |
|-------|----------|------|---------|
| `name` | Yes | string | Entry name or title |
| `description` | No | string | Summary from frontmatter |
| `memory_type` | No | string | Host-specific categorization |
| `content` | Yes | string | Full text content (body after frontmatter) |

When the Claude Code adapter encounters memory files, it emits them as instruction_document records with these additional conventions:

- `doc_type`: `"claude_memory"`
- `scope`: `"project"` (memory files are project-scoped)
- `name`: derived from the memory file's frontmatter or filename

### Corpus envelope format

The extraction pipeline produces a single `corpus.json` file containing all extracted records and their metadata. This is the canonical output of any adapter's corpus extraction, replacing any prior multi-file output layout.

#### Top-level structure

```json
{
  "metadata": { ... },
  "records": [ ... ]
}
```

Both fields are required. A valid corpus file always contains exactly these two top-level keys.

#### Metadata object

The metadata object describes the extraction run, not the records themselves. It provides enough context for consumers to understand what runtimes contributed, how many records were produced, and whether any errors occurred.

| Field | Required | Type | Purpose |
|-------|----------|------|---------|
| `extracted_at` | Yes | string (ISO 8601) | When the extraction ran |
| `runtimes` | Yes | array of string | Runtime identifiers that were probed and found available (e.g., `["claude-code"]`) |
| `adapter_version` | Yes | string | Version of the corpus builder that produced this file |
| `families` | Yes | object | Per-source-family extraction summary (see below) |
| `total_records` | Yes | integer | Total number of records in the `records` array |
| `errors` | No | array of string | Human-readable error messages from extraction failures; omitted when empty |

The `families` object has one key per source family name (matching the four portable family names from the Source families table: `instruction_document`, `history_prompt`, `conversation_turn`, `project_config_signal`). Each value is an object:

| Field | Required | Type | Purpose |
|-------|----------|------|---------|
| `count` | Yes | integer | Number of records extracted for this family |
| `status` | Yes | string | `"ok"`, `"partial"`, or `"missing"` |
| `error` | No | string | Explanation when status is `"partial"` or `"missing"`; omitted when `"ok"` |

A family with status `"ok"` extracted all records successfully. `"partial"` means some records were extracted but errors occurred during extraction. `"missing"` means the family could not be extracted at all (e.g., the runtime data directory was not found).

#### Records array

The `records` array contains all extracted records in no guaranteed order. Each element is a JSON object with the provenance fields from the table above plus a `data` object. The `data` object conforms to one of the four portable record payloads, or to a documented runtime extension payload.

Consumers filter and group records by `source_kind` to access specific families. The `runtime` field on each record identifies which adapter produced it, enabling cross-runtime corpus aggregation.

#### Envelope example

```json
{
  "metadata": {
    "extracted_at": "2026-04-11T14:30:00Z",
    "runtimes": ["claude-code"],
    "adapter_version": "2.7.0",
    "families": {
      "instruction_document": {"count": 12, "status": "ok"},
      "history_prompt": {"count": 87, "status": "ok"},
      "conversation_turn": {"count": 234, "status": "ok"},
      "project_config_signal": {"count": 5, "status": "ok"}
    },
    "total_records": 338,
    "errors": []
  },
  "records": [
    {
      "source_id": "claude-md-global-abc123",
      "timestamp": "2026-04-10T09:00:00Z",
      "project_id": "global",
      "source_kind": "instruction_document",
      "runtime": "claude-code",
      "adapter_version": "2.7.0",
      "data": {
        "doc_type": "claude_md",
        "name": "CLAUDE.md (global)",
        "content": "...",
        "scope": "global"
      }
    }
  ]
}
```

### Runtime probing convention

Before extracting records, the corpus builder probes for available runtimes by checking known filesystem paths. This probe-then-extract pattern decouples runtime detection from record extraction: the prober identifies which runtimes have data on the current system, then the builder dispatches the appropriate adapter for each detected runtime.

#### Probe mechanism

Each runtime registers a probe function that checks for the existence of its data directory. The probe returns a boolean indicating whether that runtime's data is available on the current system.

| Runtime | Probe path | What it checks |
|---------|-----------|----------------|
| Claude Code | `~/.claude/` | Directory exists and contains session data (e.g., `projects/` subdirectory or `history.jsonl`) |

Future runtimes add their own probe entries. The corpus builder iterates all registered probes, collects the list of available runtimes, and runs their extractors. Runtimes that are not detected are skipped without error.

#### Multi-runtime aggregation

When multiple runtimes are detected, the corpus builder runs each runtime's extractor independently and merges all records into a single `records` array. The `runtime` field on each record identifies its origin. The `metadata.runtimes` array lists all runtimes that contributed records.

This aggregation is additive: records from different runtimes coexist in the same corpus without deduplication across runtimes. The `source_id` field ensures idempotent re-extraction within a single runtime; cross-runtime deduplication is not performed because the same logical signal (e.g., a user preference) may appear in different forms across runtimes and both forms carry signal value.

#### No-runtime behavior

When no registered runtime is detected (all probes return false), the corpus builder produces no output and exits with an informative message. It does not produce an empty corpus file: an empty corpus has no consumers and would mask a configuration problem.

### Relation to Section 21

Section 21 defines the six host adapter capabilities for the portable core. Section 22 defines the data contract that lifts profilera from a host-specific extension to a capability-gated skill. Once a host adapter implements corpus extraction that produces the normalized record types above, profilera can run on that runtime without depending on Claude Code's internal storage layout.

Profilera's portability status in the Section 21 table moves from "Host-specific extension" to "Capability-gated" when the adapter provides the corpus. The contract itself (this section) is what enables that transition; the adapter is what implements it.

**Linter check**: None. This section defines a runtime data contract for adapters, not a SKILL.md structural requirement. The existing linter checks for profilera's SKILL.md continue to apply independently.

## 23. Pre-dispatch Commit Gate

Git worktrees branch from HEAD (the last commit), not the working tree. When a dispatching skill writes artifacts during its orient or plan steps and then spawns a subagent in a worktree without committing, the subagent receives a stale snapshot missing those artifacts. The Pre-dispatch Commit Gate closes this gap by requiring a checkpoint commit before any `isolation: "worktree"` dispatch.

This gate is the entry-side complement to Section 20 (Reality Verification Gate). Section 20 gates the exit from a cycle: did the work actually run against real state? Section 23 gates the entry to a worktree: does the subagent start from current state? The two gates enforce different invariants at different boundaries and must both hold for worktree-dispatched cycles.

### Applicability

The gate applies to any skill that dispatches a subagent with `isolation: "worktree"`. Currently two skills do this:

| Skill | Dispatch point | What it writes before dispatch |
|-------|----------------|-------------------------------|
| realisera | Step 5 (implementation dispatch) | PLAN.md status updates, PROGRESS.md cycle start, context files from orient/plan steps |
| optimera | Experiment dispatch step | EXPERIMENTS.md updates, OBJECTIVE.md refinements, harness configuration changes |

orkestrera dispatches skills without worktree isolation (it runs realisera or other skills as background subagents in the same working directory). orkestrera is covered transitively: when realisera creates a worktree at its Step 5, the gate commits everything in the working tree, including any uncommitted changes orkestrera wrote before dispatching realisera.

Skills that do not dispatch to worktrees are unaffected. The gate is invisible to them.

### Gate procedure

Before executing the `isolation: "worktree"` dispatch, the dispatching skill runs this procedure:

1. **Check working tree status.** If `git status --porcelain` returns empty output, the working tree is clean. The gate is a no-op: skip to dispatch.

2. **Stage artifact paths only.** Add only the files the skill wrote or modified during the current session. Use explicit paths (e.g., `git add .agentera/plan.yaml .agentera/progress.yaml`), not `git add -A` or `git add .`. This scoping prevents committing editor temp files, secrets, or unrelated changes.

3. **Commit with checkpoint message.** Use the conventional commit format:

   ```
   chore(<skill>): checkpoint before worktree dispatch
   ```

   Where `<skill>` is the dispatching skill's name (e.g., `chore(realisera): checkpoint before worktree dispatch`). The `chore` type triggers no version bump per the semver_policy convention.

4. **Respect hook results.** Do not pass `--no-verify`. If pre-commit hooks reject the commit, the dispatch is blocked. Fix the issue (typically an artifact validation error) and retry the commit. Invalid artifacts must not be dispatched to a worktree where they would mislead the subagent.

5. **Proceed with dispatch.** After the checkpoint commit succeeds (or was skipped as a no-op), the worktree branches from a HEAD that includes all current artifacts.

### Failure handling

When a hook rejects the checkpoint commit, the dispatching skill must:

1. Report the hook failure in its output (the specific error from the hook).
2. Attempt to fix the issue (correct the artifact that failed validation).
3. Re-stage and retry the checkpoint commit.
4. If the retry also fails, abort the dispatch and report the failure. Do not proceed with a worktree that would branch from stale state.

The skill does not silently skip the commit or bypass hooks. A blocked dispatch is preferable to a worktree operating on incorrect context.

### Identifying checkpoint commits

Checkpoint commits are identifiable in git history by their message format: `chore(<skill>): checkpoint before worktree dispatch`. Consuming tools (CHANGELOG generators, version bump scripts, inspektera audits) can filter these commits by the `chore` type and `checkpoint before worktree dispatch` description. They carry no behavioral change and should not appear in user-facing changelogs.

### General commit message rules

Commit messages must describe *what* changed and *why*, without referencing internal planning artifacts. A commit message is a permanent public record: it should make sense to someone who has never seen PLAN.md, TODO.md, or the current sprint's task list.

**Prohibited patterns** (each with examples from real commit history):

| Pattern | Example | Why |
|---------|---------|-----|
| `Task N` / `PLAN Task N` | `feat(resolve): add Rust import resolver (PLAN Task 5)` | Requires PLAN.md to interpret |
| `Cycle N` | `feat(cli): default --max-files=8 for docs corpus (Cycle 114, B38 ship)` | Requires PROGRESS.md to interpret |
| `Decision N` | `chore(bench): recall audit + calibration drift HALT (Decision 21)` | Requires DECISIONS.md to interpret |
| `Surprise #N` | `chore(benchmarks): remove non-b*-* historical stragglers (Surprise #2)` | Requires PROGRESS.md to interpret |
| `close Task N` / `mark PLAN Task N` / `record Task N` | `docs(plan): close Task 4 (B37 FAIL) + Cycle 112 PROGRESS` | Planning bookkeeping, not change description |
| `PLAN.md` / `TODO.md` file references | `chore(plan): close PreToolUse interception plan — archive PLAN.md` | Internal artifact names |
| `PROGRESS` / `DECISIONS` as commit focus | `docs: cycle 22 log, TODO resolved, changelog entry for edge weights` | Bookkeeping noise |

**Permitted**: conventional commit prefixes (`feat`, `fix`, `docs`, `refactor`, `chore`, `test`), scope annotations (`feat(ui):`), imperative-mood summaries, explanatory bodies that describe the change in domain terms. Benchmark run identifiers like `B24` are permitted: they reference objective measurements, not planning state.

This rule applies to all commits produced by any skill: checkpoint commits, realisera cycle commits, optimera experiment commits, and any other git operation the suite performs.

**Linter check**: Deterministic. Regex for internal-reference patterns in commit message templates and guidance within SKILL.md files: `Task \d+`, `Cycle \d+`, `Decision \d+`, `Surprise #\d+`, `PLAN\.md`, `TODO\.md`, `PROGRESS` (as commit focus), `DECISIONS` (as commit focus).

### Relation to Section 20

The two gates form a coherent pair bracketing the worktree lifecycle:

| Gate | Section | Boundary | Question it answers |
|------|---------|----------|---------------------|
| Pre-dispatch Commit Gate | 23 | Entry: before worktree creation | Does the subagent start from current state? |
| Reality Verification Gate | 20 | Exit: after implementation | Did the work actually run against real state? |

Both gates are mandatory for worktree-dispatched cycles. A cycle that passes Section 20 verification but skipped the Section 23 gate may have verified behavior built on stale context. A cycle that passes the Section 23 gate but skips Section 20 verification has current context but unverified output.

**Linter check**: None. This section defines a runtime convention for dispatching skills. Enforcement is per-skill: each dispatching skill's SKILL.md must include the gate procedure at its worktree dispatch point. The linter validates this through skill-specific checks, not a spec-level structural check.
