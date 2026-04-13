<!-- contract: realisera -->
<!-- source: SPEC.md (sha256: b07618545cf796e75aafeecbb25ff312ce6381bcdebd16e7bb936099f78b11fd) -->
<!-- sections: 2, 3, 4, 6, 19 -->
<!-- generated: 2026-04-13T17:09:26Z -->
<!-- do not edit manually -->
<!-- regenerate: python3 scripts/generate_contracts.py -->

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
| OBJECTIVE.md | .agentera/optimera/<name>/OBJECTIVE.md | optimera | optimera | ## Metric, ## Target, ## Baseline, ## Constraints |
| EXPERIMENTS.md | .agentera/optimera/<name>/EXPERIMENTS.md | optimera | optimera | ## Experiment N · date, **Hypothesis/Method/Result/Conclusion** |
| DESIGN.md | .agentera/DESIGN.md | visualisera | realisera, visionera | Standard sections per DESIGN-spec.md |
| DOCS.md | .agentera/DOCS.md | dokumentera | all skills (path resolution) | ## Conventions, ## Artifact Mapping, ## Index |
| SESSION.md | .agentera/SESSION.md | session stop hook | session start hook, hej | ## YYYY-MM-DD HH:MM, Artifacts modified, Summary; compaction: 5 full + 20 one-line, oldest dropped |
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

Read PROFILE.md from the runtime-provided profile path (Section 20). In Claude Code, this resolves to `~/.claude/profile/PROFILE.md`. <!-- platform: profile-path --> Mentioned skills: resonera, visionera, dokumentera, visualisera.

Both patterns MUST include a fallback instruction:
"If the script or PROFILE.md is missing, proceed without persona grounding."

**Linter check**: Deterministic. Script invocation syntax, threshold values, fallback instruction presence.

## 19. Reality Verification Gate

Passing tests are necessary but not sufficient evidence that a cycle's work is real. A feature can be structurally correct (tests green, build clean, lint clean) and still be behaviorally broken against real project state: stale fixtures, mocked dependencies, or test doubles can hide regressions that only surface when the primary entrypoint runs against production-shaped inputs. The Reality Verification Gate closes this gap by requiring every cycle to observe its own behavior before declaring completion.

This gate is orthogonal to Section 18 Staleness Detection. Section 18 asks: did the dispatched skill update the artifacts it owns? Section 19 asks: did the cycle's new behavior actually run against real state? The two gates enforce different invariants and must both hold for a cycle to be considered verified.

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
| Skill repo | Dispatch the skill via the eval mechanism capability (Section 20) against a representative prompt and capture the observed skill output <!-- platform: eval-mechanism --> |
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
| orkestrera | Secondary enforcer | Task evaluation | Reads the latest PROGRESS.md cycle entry for the dispatched task, confirms the `**Verified**` field is present and non-empty (artifact read only; no source code read), and extends its inspektera dispatch prompt to include the Section 19 evidence-format snippet so inspektera audits whether the recorded content corresponds to the task's acceptance criteria |

Realisera holds the primary enforcement contract because it is the skill that actually produces cycle entries. Orkestrera holds a lighter presence-and-quality check because it reads artifacts but never touches code; the full content audit is delegated to inspektera via the dispatch prompt.

**Linter check**: Deterministic. Realisera and orkestrera SKILL.md files must reference Section 19 by name and include the `**Verified**` field in any PROGRESS.md cycle format examples they carry.
