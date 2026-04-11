<!-- contract: profilera -->
<!-- source: SPEC.md (sha256: 8c5a8cabb5c14b0ce90c1265babfcc0039a14032de2c0a39fba806f421fb2f0b) -->
<!-- sections: 1, 4, 6, 21 -->
<!-- generated: 2026-04-11T11:37:00Z -->
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

## 21. Session Corpus Contract

Profilera mines decision patterns from host session data to produce PROFILE.md. The extraction currently depends on Claude Code's internal storage layout (JSONL files, memory directories, project-scoped configs). This section defines the normalized data model that any host adapter can produce, decoupling profilera's behavioral contract from a specific runtime's file layout.

The contract is a data model, not a path model. It specifies what profilera needs to observe, not where the host stores it. Claude Code continues to derive this corpus from its native paths; other runtimes produce the same normalized records from their own storage.

### Record types

Four canonical record families capture the decision-relevant signals profilera consumes. Each record is a JSON object with domain fields (varying per type) and provenance metadata (shared across all types). Adapters MAY define additional runtime-specific record types (see Runtime extensions below).

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

The `source_id` field enables idempotent re-extraction: the same logical record produces the same `source_id` regardless of when extraction runs. The `runtime` and `adapter_version` fields enable profilera to handle schema variations across runtimes.

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

The `records` array contains all extracted records in no guaranteed order. Each element is a JSON object that conforms to one of the four portable record types (or a runtime extension type) defined earlier in this section. Every record carries the full provenance metadata fields from the Provenance metadata table above.

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
      "doc_type": "claude_md",
      "name": "CLAUDE.md (global)",
      "content": "...",
      "scope": "global"
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

### Relation to Section 20

Section 20 defines the six host adapter capabilities for the portable core. Section 21 defines the data contract that lifts profilera from a host-specific extension to a capability-gated skill. Once a host adapter implements corpus extraction that produces the normalized record types above, profilera can run on that runtime without depending on Claude Code's internal storage layout.

Profilera's portability status in the Section 20 table moves from "Host-specific extension" to "Capability-gated" when the adapter provides the corpus. The contract itself (this section) is what enables that transition; the adapter is what implements it.

**Linter check**: None. This section defines a runtime data contract for adapters, not a SKILL.md structural requirement. The existing linter checks for profilera's SKILL.md continue to apply independently.
