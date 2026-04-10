<!-- contract: hej -->
<!-- source: SPEC.md (sha256: ded2c38c3ebf04a2bd4f7491cf25a7c9365d10a52c8a546b93a8ce1cb9b0b37f) -->
<!-- sections: 1, 2, 4, 5, 12, 18 -->
<!-- generated: 2026-04-10T17:46:52Z -->
<!-- do not edit manually -->
<!-- regenerate: python3 scripts/generate_contracts.py -->

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
| OBJECTIVE.md | Optimization target |
| EXPERIMENTS.md | Experiment log |
| DESIGN.md | Visual identity |
| DOCS.md | Documentation contract + optional artifact path overrides |
| SESSION.md | Timestamped session bookmarks with artifact change tracking |
| archive/ | Completed plans, superseded visions and designs |

**PROFILE.md** is global. The host runtime provides the path via the profile-path capability (Section 20). In Claude Code, this resolves to `~/.claude/profile/PROFILE.md`. <!-- platform: profile-path --> Skills read it from the runtime-provided path directly.

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
| SESSION.md | .agentera/SESSION.md | session stop hook | session start hook, hej | ## YYYY-MM-DD HH:MM, Artifacts modified, Summary; compaction: 5 full + 20 one-line, oldest dropped |
| PROFILE.md | (profile-path capability) <!-- platform: profile-path --> | profilera | all skills (via effective_profile) | ## Category, ### Decision, inline conf metadata |

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

## 12. Visual Identity

The suite has a shared visual vocabulary defined in DESIGN.md (the project-level visual identity, maintained by visualisera). This section defines the conventions that all SKILL.md files follow when formatting output and artifact content.

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
| profilera | (profile-path capability) <!-- platform: profile-path --> |
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
