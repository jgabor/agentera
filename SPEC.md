# Spec

<!-- Shared primitives for agentera. -->
<!-- All 12 skills/*/SKILL.md files must align with this spec. -->
<!-- Validated by scripts/validate_spec.py (pre-commit hook). -->
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
| VISION.md | VISION.md | visionera, realisera | realisera, planera, inspektera, dokumentera, visualisera, orkestrera | ## North Star, ## Who It's For, ## Principles, ## Direction, ## Identity |
| TODO.md | TODO.md | realisera, inspektera | realisera, planera, orkestrera | ## ⇶ Critical, ## ⇉ Degraded, ## → Normal, ## ⇢ Annoying, ## Resolved |
| CHANGELOG.md | CHANGELOG.md | realisera | project contributors | ## [Unreleased], ### Added/Changed/Fixed |
| DECISIONS.md | .agentera/DECISIONS.md | resonera | planera, realisera, inspektera, profilera, optimera, orkestrera | ## Decision N · date, **Question/Context/Alternatives/Choice/Reasoning/Confidence/Feeds into** |
| PLAN.md | .agentera/PLAN.md | planera | realisera, inspektera, orkestrera | <!-- Level/Created/Status -->, ## Tasks with ### Task N, **Status/Depends on/Acceptance** |
| PROGRESS.md | .agentera/PROGRESS.md | realisera | planera, inspektera, dokumentera, visionera, orkestrera | ## Cycle N · date, **Phase/What/Commit/Inspiration/Discovered/Next/Context** |
| HEALTH.md | .agentera/HEALTH.md | inspektera | realisera, planera, orkestrera | ## Audit N · date, **Dimensions/Findings/Overall/Grades**, per-dimension sections |
| OBJECTIVE.md | .agentera/optimera/<name>/OBJECTIVE.md | optimera | optimera | ## Metric, ## Target, ## Baseline, ## Constraints, **Status** |
| EXPERIMENTS.md | .agentera/optimera/<name>/EXPERIMENTS.md | optimera | optimera | ## Experiment N · date, **Hypothesis/Method/Result/Conclusion**; ## Closure · date, **Final value/Target/Reason** |
| DESIGN.md | .agentera/DESIGN.md | visualisera | realisera, visionera | Standard sections per DESIGN-spec.md |
| DOCS.md | .agentera/DOCS.md | dokumentera | all skills (path resolution) | ## Conventions, ## Artifact Mapping, ## Index |
| SESSION.md | .agentera/SESSION.md | session stop hook | session start hook, hej | ## YYYY-MM-DD HH:MM, Artifacts modified, Summary; compaction: 10 full + 40 one-line, oldest dropped |
| PROFILE.md | (profile-path capability) <!-- platform: profile-path --> | profilera | all skills (via effective_profile) | ## Category, ### Decision, inline conf metadata |

**Dual-write**: realisera writes both CHANGELOG.md (public, version-level summaries for project contributors) AND `.agentera/PROGRESS.md` (operational cycle-level detail for consuming skills). Consuming skills that need cycle detail read `.agentera/PROGRESS.md`; project contributors read CHANGELOG.md.

**Per-objective layout (optimera)**: OBJECTIVE.md and EXPERIMENTS.md are not placed at fixed paths. Each named optimization objective gets its own subdirectory under `.agentera/optimera/<name>/`, where `<name>` is the slugified objective name. Optimera manages this layout; other skills do not read or write these artifacts directly.

**Objective closure contract (optimera)**: When an objective reaches its target, optimera closes that objective inside its own directory. `OBJECTIVE.md` records canonical closed state with `**Status**: closed`, `**Closed at**: <ISO-8601 UTC timestamp>`, `**Final value**: <value>`, `**Target**: <target>`, and `**Reason**: <reason>`. `EXPERIMENTS.md` appends one closure entry headed `## Closure · <ISO-8601 UTC timestamp>` with `**Final value**`, `**Target**`, and `**Reason**`. Closure never creates a registry, symlink, root-level objective artifact, or DOCS.md fixed mapping.

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

Read PROFILE.md from the profilera-determined profile path (`$PROFILERA_PROFILE_DIR/PROFILE.md`, defaulting to `$XDG_DATA_HOME/agentera/PROFILE.md` on Linux). <!-- platform: profile-path --> Mentioned skills: resonera, visionera, dokumentera, visualisera.

Both patterns MUST include a fallback instruction:
"If the script or PROFILE.md is missing, proceed without persona grounding."

**Linter check**: Deterministic. Script invocation syntax, threshold values, fallback instruction presence.

PROFILERA_PROFILE_DIR is the sibling of AGENTERA_HOME (Section 7): both are adapter-injected env vars, but they scope to different surfaces. PROFILERA_PROFILE_DIR names the profile data directory (where PROFILE.md lives); AGENTERA_HOME names the agentera install root (where helper scripts referenced by skill prose live).

## 7. Install Root (AGENTERA_HOME)

Skill prose carries cross-runtime helper script invocations (e.g., compaction scripts under `scripts/`). Those invocations must resolve identically across hosts. AGENTERA_HOME is the shared primitive that names the agentera install root: the directory containing `scripts/`, `hooks/`, `skills/`, and `SPEC.md`. With AGENTERA_HOME defined, a skill instruction like `python3 ${AGENTERA_HOME:-$CLAUDE_PLUGIN_ROOT}/scripts/compact_artifact.py <spec> <path>` resolves the same way on every supported runtime.

AGENTERA_HOME is the sibling of PROFILERA_PROFILE_DIR (Section 6, Profile Consumption; Section 4, Artifact Format Contracts): both are adapter-injected env vars. PROFILERA_PROFILE_DIR scopes to profile data; AGENTERA_HOME scopes to install-root helper scripts. Together they cover the two cross-runtime path surfaces the suite needs.

The injection asymmetry between PROFILERA_PROFILE_DIR and AGENTERA_HOME is principled, not accidental: profile data is global and adapter-owned (one writer, many readers across projects), so adapters set PROFILERA_PROFILE_DIR directly per host conventions; install-root path resolution is per-invocation and skill-owned via the bash-fallback form, so AGENTERA_HOME flows through whichever per-runtime env-injection mechanism each host already provides.

### Scope

The contract governs SKILL.md prose that references the install root from a shell-tool invocation. It does not govern adapter-internal config files (`hooks/hooks.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, root `plugin.json`). Those files are loaded by their host runtime directly and use whichever path token that runtime expects; they are per-runtime by design.

### Adapter responsibility

The host adapter sets AGENTERA_HOME in the agent's shell-tool environment so any `python3 ${AGENTERA_HOME:-...}/scripts/<name>.py` invocation resolves to the install root. Each runtime uses its native, documented mechanism for shell-tool environment injection; the adapter does not invent a custom layer. When the install root cannot be discovered, the adapter leaves AGENTERA_HOME unset rather than assigning an empty string, and pre-set user values are preserved.

### Skill responsibility

Skill prose references AGENTERA_HOME via the bash-fallback form `${AGENTERA_HOME:-$CLAUDE_PLUGIN_ROOT}` for any helper script under the install root. The fallback to `$CLAUDE_PLUGIN_ROOT` keeps Claude Code working without a Claude-side env-injection mechanism (Claude Code already sets `CLAUDE_PLUGIN_ROOT` to the plugin root). Skills do not embed bare `${CLAUDE_PLUGIN_ROOT}` references in prose: that form is host-specific and breaks on every other runtime.

### Per-runtime mechanism

Each supported runtime has one official, documented mechanism for injecting AGENTERA_HOME into the agent's shell-tool environment. Adapters use that mechanism; users may need to apply a host-level setup step where the runtime has no plugin-level env-injection API.

| Runtime | Mechanism | Source |
|---------|-----------|--------|
| Claude Code | Bash fallback to `CLAUDE_PLUGIN_ROOT` (the env var Claude Code already sets at the plugin root). The form `${AGENTERA_HOME:-$CLAUDE_PLUGIN_ROOT}` resolves to AGENTERA_HOME when set and falls back to the existing Claude Code variable otherwise; no Claude-side adapter change is required. | Claude Code plugin reference: `${CLAUDE_PLUGIN_ROOT}` token (`https://docs.claude.com/en/docs/claude-code/plugins-reference#hooks-and-mcp-servers`) |
| OpenCode | `shell.env` plugin hook from `@opencode-ai/plugin`. The hook returns an environment fragment that OpenCode merges into every shell-tool subprocess; the adapter sets AGENTERA_HOME there at plugin load. | `@opencode-ai/plugin` Hooks interface (`dist/index.d.ts`, `shell.env` member) |
| Codex | `~/.codex/config.toml` `[shell_environment_policy]` `set` table. Codex applies the policy to every shell-tool process; the user adds `set = { AGENTERA_HOME = "<install root>" }`. This is the runtime's native, non-experimental mechanism for shell-tool env propagation. | Codex config schema: `ShellEnvironmentPolicyToml` (`https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json`) and Codex config reference (`https://developers.openai.com/codex/config-reference`) |
| Copilot | Shell rc export (`export AGENTERA_HOME=<install root>` in `~/.bashrc`, `~/.zshrc`, etc.). Copilot has no plugin-level env-injection API, so user-shell setup is the documented best practice; Copilot inherits the parent shell environment. | Copilot CLI plugin reference (`https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference`) and Copilot hooks reference (`https://docs.github.com/en/copilot/reference/hooks-configuration`) |

The rows double as install guidance for adapter authors: each names the official mechanism and the source that documents it.

**Linter check**: None at this revision. A future spec validator rule will warn on bare `${CLAUDE_PLUGIN_ROOT}` in SKILL.md prose; that rule is owned by a separate task and is not active in this revision.

## 8. Cross-Skill Integration Section

Every SKILL.md MUST contain a `## Cross-skill integration` section. Requirements:

### Ecosystem language

The section MUST open with: "[Skill name] is part of a twelve-skill suite."

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

**Linter check**: Deterministic. Section heading presence, suite language match, required skill references present.

## 9. Safety Rails Section

Every SKILL.md MUST contain a `## Safety rails` section with:

1. Opening `<critical>` tag
2. Bullet list of constraints (minimum 3)
3. Closing `</critical>` tag

Each constraint MUST begin with "NEVER" to clearly signal what the skill must not do.

**Linter check**: Deterministic. Section heading, `<critical>` tag presence, minimum constraint count, "NEVER" prefix pattern.

## 10. SKILL.md Frontmatter

Every SKILL.md MUST begin with YAML frontmatter containing:

| Field | Required | Format |
|-------|----------|--------|
| `name` | Yes | kebab-case skill name |
| `description` | Yes | Multi-line string (use `>` block scalar). Must include the skill's full acronym expansion, trigger patterns, and what the skill produces. |

The description field serves as the skill's trigger specification. It MUST contain enough trigger phrases for Claude to activate the skill from natural language.

**Linter check**: Deterministic. Frontmatter presence, required field presence, name format (kebab-case).

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

## 12. Loop Guard

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

## 14. Narration Voice

Skills communicate with the user between structural markers, announcing modes, describing transitions, and narrating progress. This narration carries the suite's voice: the sharp colleague (VISION.md), not a system log.

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

## 15. Punctuation Conventions

All spec text (SKILL.md files, this document, templates, reference docs, agent output) follows a shared punctuation standard to keep prose scannable and consistent.

| Rule | Detail |
|------|--------|
| No em-dash (U+2014) | The `—` character is prohibited in all spec and skill text |
| No double dash (`--`) as prose punctuation | Double dashes used as word separators or parenthetical markers are prohibited. CLI flags in code blocks and inline code are exempt (they are syntax, not prose) |
| Replacement hierarchy | First restructure the sentence so no dash is needed. Fall back to commas, periods, or colons only when restructuring reads worse |
| Colon for label:value | Use colons as label-to-value separators (per Decision 14) |

**Linter check**: Deterministic. Regex for the em-dash character (U+2014) in SKILL.md files.

## 16. Line-Break Conventions

Prose paragraphs in spec and skill text are single lines. The terminal handles wrapping; hard wraps at arbitrary column widths create noisy diffs and complicate search.

| Rule | Detail |
|------|--------|
| One paragraph = one line | Do not manually wrap prose at 80 or 100 columns |
| Structured content keeps its line breaks | Code blocks, bullet lists, numbered lists, tables, headings, YAML frontmatter, and HTML comments retain their inherent structure |

**Linter check**: Advisory. Consecutive non-blank prose lines outside structured content (code blocks, lists, tables, frontmatter, headings).

## 17. Test Proportionality

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

Each cycle entry in PROGRESS.md includes a **Phase** field immediately after the cycle heading. The value is one of the five phase names: `envision`, `deliberate`, `plan`, `build`, `audit`.

```markdown
■ ## Cycle N · YYYY-MM-DD HH:MM

**Phase**: build
**What**: one-line summary of what shipped
```

Consuming skills use the phase field for trend analysis (e.g., ratio of build to audit cycles, whether deliberation precedes major architectural changes).

**Linter check**: None. Phase tracking is defined here for producing and consuming skills. SKILL.md integration is handled per-skill, not by the spec linter.

## 19. Staleness Detection

Stale artifacts mislead routing decisions and cause skills to act on outdated context. This section defines how staleness is detected and which artifacts each skill is expected to update.

### Skill-to-expected-artifact mapping

Each skill produces specific artifacts as part of its workflow. When a skill is dispatched (directly or via orkestrera), the artifacts listed here are the ones it is expected to have updated upon completion. This table is the authoritative lookup for staleness checks.

| Skill | Expected artifact outputs |
|-------|--------------------------|
| visionera | VISION.md |
| resonera | .agentera/DECISIONS.md |
| planera | .agentera/PLAN.md |
| realisera | .agentera/PROGRESS.md, TODO.md, CHANGELOG.md |
| optimera | .agentera/optimera/<name>/EXPERIMENTS.md, .agentera/optimera/<name>/OBJECTIVE.md (paths are per-objective; staleness check uses glob `.agentera/optimera/*/EXPERIMENTS.md` and `.agentera/optimera/*/OBJECTIVE.md`) |
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

## 20. Reality Verification Gate

Passing tests are necessary but not sufficient evidence that a cycle's work is real. A feature can be structurally correct (tests green, build clean, lint clean) and still be behaviorally broken against real project state: stale fixtures, mocked dependencies, or test doubles can hide regressions that only surface when the primary entrypoint runs against production-shaped inputs. The Reality Verification Gate closes this gap by requiring every cycle to observe its own behavior before declaring completion.

This gate is orthogonal to Section 19 Staleness Detection. Section 19 asks: did the dispatched skill update the artifacts it owns? Section 20 asks: did the cycle's new behavior actually run against real state? The two gates enforce different invariants and must both hold for a cycle to be considered verified.

### Evidence format

Every cycle entry in PROGRESS.md carries a `**Verified**` field alongside the existing Phase/What/Commit/Inspiration/Discovered/Next/Context fields. The field is mandatory: no cycle is considered closed without it. The field accepts exactly one of three shapes:

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

Projects with an archetype not listed here document their canonical entrypoint form in `.agentera/DOCS.md` under a `verification_entrypoint` key. The taxonomy is extensible; the table above is the minimum coverage.

### Optional verification budget

Some cycles touch slow subsystems (full data pipeline runs, long-running integration scenarios) where a complete reality check exceeds a reasonable per-cycle time budget. Projects that need a cap set a `verification_budget` key in `.agentera/DOCS.md` specifying the maximum wall-clock time per cycle. When a cycle's verification step exceeds the configured budget, the cycle MAY downgrade to a partial verification rather than blocking indefinitely.

Partial verifications record as `**Verified**: partial (budget hit)` followed by a short note capturing what was attempted, what was observed before the budget was hit, and which portions of the behavior remain unverified. Partial verifications are valid cycle closures but are visible to consuming skills as weaker signal: inspektera audits treat a string of partial verifications as a health finding requiring attention.

Projects without a `verification_budget` key have no time cap. The default is: take as long as verification honestly requires.

### Skill-to-gate mapping

The gate is enforced independently by two skills; each holds a different phase and a different slice of the enforcement contract.

| Skill | Role | Phase | What it enforces |
|-------|------|-------|------------------|
| realisera | Primary enforcer | Cycle close | Runs the primary entrypoint against real project state and writes the observed output into the cycle's `**Verified**` field. Blocks cycle completion if the field cannot be populated with observed output, an allowlisted tag, or a qualifying free-form rationale |
| orkestrera | Secondary enforcer | Task evaluation | Reads the latest PROGRESS.md cycle entry for the dispatched task, confirms the `**Verified**` field is present and non-empty (artifact read only; no source code read), and extends its inspektera dispatch prompt to include the Section 20 evidence-format snippet so inspektera audits whether the recorded content corresponds to the task's acceptance criteria |

Realisera holds the primary enforcement contract because it is the skill that actually produces cycle entries. Orkestrera holds a lighter presence-and-quality check because it reads artifacts but never touches code; the full content audit is delegated to inspektera via the dispatch prompt.

**Linter check**: Deterministic. Realisera and orkestrera SKILL.md files must reference Section 20 by name and include the `**Verified**` field in any PROGRESS.md cycle format examples they carry.

## 21. Host Adapter Contract

This spec defines what the portable core of agentera expects from its runtime environment. The reference implementation is Claude Code; other runtimes implement the same contract in their own way. The contract below is the minimum host surface for portable skills and shared artifacts. It is not a blanket claim that every current skill is fully portable today.

### Capabilities

Each capability specifies what the skill requires, not how the runtime provides it. Runtimes implement these capabilities using their own mechanisms.

| Capability | Requirement level | What the skill requires | Claude Code implementation |
|------------|-------------------|------------------------|---------------------------|
| Skill discovery | Required | A mechanism to find and load SKILL.md files so the runtime can present available skills to the user | `.claude-plugin/plugin.json` manifests and `settings.json` skillPaths |
| Artifact resolution | Required | Ability to read and write files at paths specified by DOCS.md or the default layout (project root + `.agentera/`) | Direct filesystem access per artifact path resolution rules |
| Profile path | Required | A global configuration directory where PROFILE.md lives, readable by all skills that consume the generated profile artifact | `$PROFILERA_PROFILE_DIR/PROFILE.md` (profilera determines platform-appropriate data dir; override via `PROFILERA_PROFILE_DIR` env var) <!-- platform: profile-path --> |
| Sub-agent dispatch | Capability-gated | Ability to spawn subordinate agents with workspace isolation for parallel implementation tasks | Git worktrees via the `isolation: "worktree"` primitive <!-- platform: sub-agent-dispatch --> |
| Eval mechanism | Capability-gated | Ability to invoke a skill against a prompt and capture the output for behavioral verification | `claude -p --output-format json` pipe mode <!-- platform: eval-mechanism --> |
| Hook lifecycle | Optional but recommended | Callbacks at session start, session stop, and after tool use for artifact validation and context preload | `hooks.json` with SessionStart, Stop, and PostToolUse event types |

Required capabilities are the minimum for artifact-centric interoperability. Capability-gated features preserve the full behavior of the skills that rely on them. Optional capabilities improve continuity and safety rails but are not prerequisites for the portable core.

### Portability status by skill

The current suite does not sit at one portability level. Skills fall into three buckets:

| Status | Meaning | Skills |
|--------|---------|--------|
| Portable core | Depends only on shared artifacts plus the required host capabilities above | visionera, resonera, planera, dokumentera, visualisera, inspirera, inspektera |
| Capability-gated | Portable when the host adapter also implements the capability-gated runtime features those skills depend on | hej, realisera, optimera, orkestrera |
| Host-specific extension | Depends on a host-specific data source not yet standardized by this spec | profilera |

Portable core means the skill's behavioral contract travels with the artifact protocol. Capability-gated means the skill remains portable, but only if the target runtime exposes the extra host primitives it depends on. Host-specific extension means the skill is intentionally outside the current portability claim until a new contract layer is defined.

### Host-specific extensions

Some skills need host data that is not part of the core runtime surface. The clearest example is profilera: it does not just read PROFILE.md, it mines host session history, memories, and conversation traces to produce that artifact. The extraction corpus is Claude-specific in the reference implementation.

Section 22 (Session Corpus Contract) defines the normalized data model for this corpus. Once a host adapter implements corpus extraction producing the Section 22 record types, profilera's portability status moves from host-specific extension to capability-gated. Until the adapter provides the corpus, profilera remains host-specific on that runtime.

### Annotation convention

Platform-specific references in SKILL.md files are annotated with HTML comments that map them to the capability they depend on. This lets other runtimes identify every coupling point without rewriting the skills.

Format: `<!-- platform: capability-name -->`

Placed immediately after or adjacent to the platform-specific reference. The six recognized capability names correspond to the table above: `skill-discovery`, `artifact-resolution`, `profile-path`, `sub-agent-dispatch`, `eval-mechanism`, `hook-lifecycle`.

Example:

```markdown
Read `$PROFILERA_PROFILE_DIR/PROFILE.md` (default: `$XDG_DATA_HOME/agentera/PROFILE.md`) directly per contract profile consumption conventions. <!-- platform: profile-path -->
```

Runtimes that are not Claude Code replace the annotated reference with their own equivalent. Skills describe what they need; the runtime provides how.

### Profile.md path

The global profile path is the most deeply coupled reference in the suite. Section 4 references `$PROFILERA_PROFILE_DIR/PROFILE.md` with platform-appropriate defaults. With the host adapter contract, this path is a capability: profilera determines the platform directory, overridable via `PROFILERA_PROFILE_DIR`. The annotation `<!-- platform: profile-path -->` marks substitution points for runtimes that override the default. Other runtimes substitute their own global config path.

### Linter check

Deterministic. The linter validates two properties:

1. Every `<!-- platform: -->` annotation in a SKILL.md references a recognized capability name from the capability table above.
2. The capability names in the annotation must exactly match one of: `skill-discovery`, `artifact-resolution`, `profile-path`, `sub-agent-dispatch`, `eval-mechanism`, `hook-lifecycle`.

Annotations on references that have no corresponding capability (e.g., a comment referencing a nonexistent capability) produce a linter error.

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

2. **Stage artifact paths only.** Add only the files the skill wrote or modified during the current session. Use explicit paths (e.g., `git add .agentera/PLAN.md .agentera/PROGRESS.md`), not `git add -A` or `git add .`. This scoping prevents committing editor temp files, secrets, or unrelated changes.

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

## 24. Artifact Writing Conventions

Artifacts are read by skills, not just humans. Every word costs tokens on every read. This section defines the shared vocabulary, tone, and structural rules that all skills follow when writing artifacts and SKILL.md content.

### The principle

Write like a sharp colleague who respects your time. Say what happened, why it matters, what's next. No padding, no hedging, no meta-commentary about the writing process itself.

### Banned verbosity patterns

These patterns waste tokens and must not appear in artifact content. SKILL.md instruction text is exempt (it teaches the agent how to write, it is not artifact content itself).

| Pattern | Example | Replacement |
|---------|---------|-------------|
| Meta-commentary about writing | "Here is the updated plan" | Omit; just write the plan |
| Hedging qualifiers | "It seems like", "It appears that", "Possibly" | State directly or omit |
| Redundant transitions | "Moving on to the next step", "Now let's look at" | Omit; structural markers handle transitions |
| Self-referential process narration | "I am now analyzing", "The agent is checking" | Omit; the action speaks for itself |
| Filler introductions | "Based on my analysis", "After careful consideration" | Omit; lead with the finding |
| Summary preambles | "In summary", "To recap", "Overall" | Omit; the content is the summary |
| Excessive justification | "I chose this approach because..." (when obvious) | One-line rationale only when non-obvious |

### Sentence length limits

Artifact prose follows a 25-word cap per sentence. This covers finding descriptions, cycle summaries, decision rationales, and all prose outside code blocks, tables, and lists. SKILL.md instruction text and examples are exempt.

**Linter check**: Advisory. Counts words per sentence in artifact format examples within SKILL.md files (inside code blocks showing artifact structure). Flags sentences exceeding 25 words.

### Preferred vocabulary

Canonical terms replace synonyms across all artifacts and SKILL.md files.

| Use | Avoid |
|-----|-------|
| finding | issue, problem, concern, observation |
| cycle | iteration, run, pass, loop |
| artifact | file, document, output |
| dispatch | spawn, launch, create, start |
| verified | checked, confirmed, validated, tested |
| grade | score, rating, assessment |
| dimension | category, area, section |
| confidence | certainty, belief, likelihood |
| severity | priority, level, importance |
| trajectory | trend, direction, movement |
| stale | outdated, old, expired |
| checkpoint | save, snapshot, backup |

**Linter check**: Advisory. Scans SKILL.md prose (outside code blocks and frontmatter) for the "avoid" column terms when used in artifact-writing context (near words like "write", "append", "entry", "format", "structure").

### Structural rules

All artifacts follow these composition rules:

1. **Lead with the conclusion**: the first sentence of any entry states the outcome. Evidence follows. "Architecture: C. Circular dependency between auth/ and db/ modules." Not "After examining the module structure, I noticed that..."
2. **One fact per sentence**: do not compound findings. Two short sentences beat one long one with "and" or "but".
3. **Evidence is concrete**: file paths, line numbers, quoted code. No "some files" or "certain modules".
4. **No empty severity**: every finding includes a suggested action. "Investigate X" is better than no action.
5. **Numbers are digits**: use "3" not "three" in artifact content. Spell out only when the number begins a sentence (which should be rare given the length limits).

### SKILL.md structural requirement

Every SKILL.md MUST include a reference to this section in its workflow instructions when the skill produces artifacts. The canonical instruction:

```
Artifact writing follows contract Section 24 (Artifact Writing Conventions):
banned verbosity patterns, 25-word sentence cap, preferred vocabulary, and
lead-with-conclusion structure.
```

This instruction appears in the skill's artifact-writing step (the step where the skill writes to PROGRESS.md, HEALTH.md, DECISIONS.md, or any other artifact).

**Linter check**: Deterministic. All skills that produce artifacts (per the artifact format contracts table in Section 4) must contain a reference to "Section 24" or "Artifact Writing Conventions" in their SKILL.md.

### Tone register

The suite's voice is consistent across all artifacts:

- **Direct**: state facts, not feelings. "Tests fail on auth/" not "It looks like there might be an issue with auth".
- **Brief**: ≤15 words for cycle summaries, ≤25 words for finding descriptions, ≤50 words for decision rationales.
- **Concrete**: "circular import in auth/models.py:12" not "there seems to be a coupling issue".
- **Forward-looking**: every entry ends with what to do next, not a recap of what was done.

This register complements Section 14 (Narration Voice): Section 14 governs how skills talk to the user between structural markers; Section 24 governs what goes inside the artifacts themselves.

### Self-Audit Protocol

Producing skills run these 3 checks on every artifact entry before writing. The checks are a mandatory pre-write gate. Run them in order: check 1 first, then 2, then 3.

**Check 1 — Verbosity drift**

What: Entry word count against the §4 token budget for the target artifact.
How: Approximate the word count of the entry being written. Compare against the per-entry budget in the §4 Token budgets table.
Pass: Word count ≤ budget.
Fail: Compact the entry. Remove redundant words, merge sentences, cut filler. Re-check from check 1.

**Check 2 — Abstraction creep**

What: Entry must contain ≥1 concrete anchor from {file path, line number, commit hash, metric value, identifier, direct quote}.
How: Scan the entry for at least one of: a file path (e.g. `src/auth.py`), a line number (e.g. `:42`), a commit hash (7+ hex chars), a metric value (number with unit), an identifier (function/class/variable name), or a direct quote (text in quotes attributed to a source).
Pass: ≥1 concrete anchor present.
Fail: Add a concrete anchor, then re-check from check 1.

**Check 3 — Filler accumulation**

What: Scan for banned verbosity patterns from the §24 Banned verbosity patterns table.
How: Read the entry. Cross-reference each sentence against the patterns and replacements in the §24 Banned verbosity patterns table: meta-commentary about writing, hedging qualifiers, redundant transitions, self-referential process narration, filler introductions, summary preambles, excessive justification.
Pass: No banned patterns found.
Fail: Remove banned patterns using the recommended alternatives from the table, then re-check from check 1.

#### Producing skill instruction template

Copy this step into a SKILL.md artifact-write workflow, immediately before the write instruction:

```
Pre-write self-audit (SPEC §24 Self-Audit Protocol):
1. Verbosity drift: approximate word count. Exceeds §4 budget → compact. Re-check.
2. Abstraction creep: missing concrete anchor → add one. Re-check.
3. Filler accumulation: scan against §24 Banned verbosity patterns table. Found → remove. Re-check.
Max 3 revision attempts per entry. After 3 failures, write the entry with [post-audit-flagged] marker.
```

This is distinct from the existing §24 SKILL.md structural requirement instruction. That instruction reminds skills which writing conventions to follow *during* the write. This template gates entry quality *before* the write.

#### Max-3-retry loop guard

Each entry gets ≤3 revision attempts. After each failed check, revise the entry and re-run all checks starting from check 1. If any check still fails after the 3rd revision:

1. Write the entry anyway.
2. Prepend `[post-audit-flagged]` to the entry text.
3. Include a brief reason: which check failed and why revision was impossible without losing substance.

The `[post-audit-flagged]` marker signals inspektera to evaluate the entry during its next prose health audit. Dokumentera also flags flagged entries during doc-prose enforcement.

Bail-out example:

```
[post-audit-flagged: abstraction creep — architecture concept has no file path, line number, or commit yet]
Architecture decision: adopt event-driven communication between auth/ and billing/ modules.
```

#### Linter check

Advisory. All producing skills (per §4 artifact format contracts table) must reference "Self-Audit Protocol" or "pre-write self-audit" in their SKILL.md. Skills that only read artifacts (hej, inspirera) are exempt.
