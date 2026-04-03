<!-- ecosystem-context: resonera -->
<!-- source: references/ecosystem-spec.md (sha256: 945f7e7589d7ad9fb59662629753e29a5672ccae5670b0f4802925c700783310) -->
<!-- sections: 3, 4, 5, 6 -->
<!-- generated: 2026-04-03T15:37:43Z -->
<!-- do not edit manually -->
<!-- regenerate: python3 scripts/generate_ecosystem_context.py -->

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
| OBJECTIVE.md | Optimization target |
| EXPERIMENTS.md | Experiment log |
| DESIGN.md | Visual identity |
| DOCS.md | Documentation contract + optional artifact path overrides |
| SESSION.md | Timestamped session bookmarks with artifact change tracking |
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
| SESSION.md | .agentera/SESSION.md | session stop hook | session start hook, hej | ## YYYY-MM-DD HH:MM, Artifacts modified, Summary; compaction: 5 full + 20 one-line, oldest dropped |
| PROFILE.md | ~/.claude/profile/PROFILE.md | profilera | all skills (via effective_profile) | ## Category, ### Decision, inline conf metadata |

**Dual-write**: realisera writes both CHANGELOG.md (public, version-level summaries for project contributors) AND `.agentera/PROGRESS.md` (operational cycle-level detail for consuming skills). Consuming skills that need cycle detail read `.agentera/PROGRESS.md`; project contributors read CHANGELOG.md.

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
