<!-- contract: optimera -->
<!-- source: SPEC.md (sha256: 5da2ae456b2bd3a81de6f59372931e18cb1cc6bac24289b72d052a3dc3807030) -->
<!-- sections: 1, 3, 4, 5, 6, 23 -->
<!-- generated: 2026-04-29T06:43:49Z -->
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
| OBJECTIVE.md | .agentera/optimera/<name>/OBJECTIVE.md | optimera | optimera | ## Metric, ## Target, ## Baseline, ## Constraints |
| EXPERIMENTS.md | .agentera/optimera/<name>/EXPERIMENTS.md | optimera | optimera | ## Experiment N · date, **Hypothesis/Method/Result/Conclusion** |
| DESIGN.md | .agentera/DESIGN.md | visualisera | realisera, visionera | Standard sections per DESIGN-spec.md |
| DOCS.md | .agentera/DOCS.md | dokumentera | all skills (path resolution) | ## Conventions, ## Artifact Mapping, ## Index |
| SESSION.md | .agentera/SESSION.md | session stop hook | session start hook, hej | ## YYYY-MM-DD HH:MM, Artifacts modified, Summary; compaction: 10 full + 40 one-line, oldest dropped |
| PROFILE.md | (profile-path capability) <!-- platform: profile-path --> | profilera | all skills (via effective_profile) | ## Category, ### Decision, inline conf metadata |

**Dual-write**: realisera writes both CHANGELOG.md (public, version-level summaries for project contributors) AND `.agentera/PROGRESS.md` (operational cycle-level detail for consuming skills). Consuming skills that need cycle detail read `.agentera/PROGRESS.md`; project contributors read CHANGELOG.md.

**Per-objective layout (optimera)**: OBJECTIVE.md and EXPERIMENTS.md are not placed at fixed paths. Each named optimization objective gets its own subdirectory under `.agentera/optimera/<name>/`, where `<name>` is the slugified objective name. Optimera manages this layout; other skills do not read or write these artifacts directly.

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
