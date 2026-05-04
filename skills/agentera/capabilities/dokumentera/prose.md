# DOKUMENTERA

**Documentation Origin: Knowledge Unified, Methodology Enforced, Notation Traced. Examine, Record, Articulate**

The "D" in DTC. Writes intent docs before code exists, generates docs for existing code, maintains docs as projects evolve, verifies docs against implementation.

Two modes: **create** and **update**. Context-detected: no feature yet = intent-first; code exists = explore and generate.

---

## Visual identity

Glyph: **▤** (protocol ref: SG8). Used in the mandatory exit marker.

---

## State artifacts

One index file; writes individual doc files across the project.

| Artifact | Purpose | Bootstrap |
|----------|---------|-----------|
| `DOCS.md` | Documentation contract. Conventions, artifact mapping, and documentation index. | Created on first dokumentera run. |

Template in `references/templates/` (v2 path: `skills/agentera/references/templates/`). Individual doc files written to standard locations.

### Artifact path resolution

Before reading or writing any artifact, check if `.agentera/docs.yaml` exists. If it has an Artifact Mapping section, use the path specified for each canonical filename (.agentera/docs.yaml, etc.). If `.agentera/docs.yaml` doesn't exist or has no mapping for a given artifact, use the default layout: TODO.md and CHANGELOG.md at the project root; VISION.md and all other artifacts in `.agentera/`. This applies to all artifact references in this capability, including cross-capability reads (VISION.md, .agentera/progress.yaml, .agentera/decisions.yaml, .agentera/health.yaml).

### Contract values

Contract values are inlined where referenced. Visual tokens from protocol: severity arrows VT5-VT8, trend arrows VT12-VT13, progress bar VT18, inline separator VT16 (·), list item VT15 (▸), section divider VT14, flow/target VT17 (→). Skill glyph SG8 for the exit marker. Exit signals EX1-EX4 for the exit marker. Confidence scale CS1-CS5 for decision profile consumption.

`references/contract.md` (at the v2 skill location `skills/agentera/references/contract.md`) remains available as a full-spec reference for ambiguous cases or cross-checking.

---

## DOCS.md format

```markdown
# Documentation Contract

<!-- Maintained by dokumentera. Last audit: YYYY-MM-DD -->

## Conventions

```

doc_root: docs/
style:    technical, sections with examples, no badges
auto_gen:

- TypeDoc → docs/api/

```

## Artifact Mapping

| Artifact | Path | Producers |
|----------|------|-----------|
| VISION.md | docs/VISION.md | visionera, realisera |
...

## Index

| Document | Path | Last Updated | Status |
|----------|------|-------------|--------|
| README | README.md | YYYY-MM-DD | ■ current |
...

Status tokens: `■ current`, `▣ stale`, `□ missing`
```

---

## Step 0: Detect context

Determine what kind of documentation work is needed:

1. Read DOCS.md (if exists) for current state
2. Parse user request: specific target or broad "write/update docs"?
3. Check codebase: does the feature exist in code?

| Context | Approach |
|---------|----------|
| Feature doesn't exist yet, user wants to document intent | **Intent-first** (conversational) |
| Code exists, docs don't | **Explore and generate** (autonomous) |
| Docs exist, may be stale | **Update and verify** (audit-driven) |
| Broad "audit the docs" / "are docs up to date" | **Full audit** |
| No DOCS.md exists | **First-run survey** (convention detection) |

---

## First-run survey (convention detection)

When DOCS.md doesn't exist, run a survey first. Observe the project and propose a three-layer convention map for user approval.

Step markers: display `── step N/5: verb` before each step.
Steps: explore, propose, handle, audit, write.

### Step 1: Explore structure

Detect documentation conventions:

1. **Doc root**: check docs/, doc/, documentation/, wiki/, or root. Default to root.
2. **Existing docs**: README, CLAUDE.md, AGENTS.md, CONTRIBUTING.md, API docs, guides
3. **Auto-generated docs**: TypeDoc, Storybook, OpenAPI/Swagger, GoDoc, Rustdoc, Javadoc. Record each with output path.
4. **Style**: infer tone, structure patterns, formatting conventions from existing docs
5. **Skill artifacts**: check for VISION.md, DECISIONS.md, PLAN.md, etc. at root
6. **Version files**: package.json, Cargo.toml, pyproject.toml, plugin.json, etc. Note files and current values. None found = omit versioning from DOCS.md.

### Step 2: Propose conventions

Draft three-layer DOCS.md from `references/templates/` (v1 path):

1. **Conventions**: doc_root, style, auto_gen from observations. If version files found, populate `version_files` and ask about semver policy. No version files = omit block.
2. **Artifact mapping**: paths consistent with project's doc organization
3. **Index**: all discovered docs (auto-generated = `generated`, existing = `current`)

Present for user approval.

### Step 3: Handle existing artifacts

If artifacts exist at root but mapping places them elsewhere:

1. List artifacts that would move
2. Offer to relocate via `git mv`
3. If declined, update mapping to match actual locations

### Step 4: Pre-write self-audit

Pre-write self-audit: check verbosity drift (per-artifact budget), abstraction creep (≥1 concrete anchor), and filler accumulation (banned patterns). See `scripts/self_audit.py` (v2 path: `scripts/self_audit.py`).
Max 3 revision attempts. Flag with [post-audit-flagged] if still failing.

Narration voice (riff, don't script):

- "Tightening this up..." · "Cutting the filler first..." · "One more pass..."

### Step 5: Write DOCS.md

Write the approved convention map to `.agentera/docs.yaml`. After writing, proceed to the originally requested mode, or stop if the survey was the entire request.

Artifact writing follows contract Section 24 (Artifact Writing Conventions): banned verbosity patterns, 25-word sentence cap, preferred vocabulary, and lead-with-conclusion structure.

---

## Intent-first mode (docs before code)

DTC-first: document what a feature SHOULD do before building. Docs become the spec.

Step markers: display `── step N/5: verb` before each step.
Steps: understand, write, audit, update, suggest.

### Step 1: Understand the intent

Brief conversation (2-4 questions): what, who reads it, what format, what detail level.

Read VISION.md for direction/audience and decision profile per protocol confidence scale (CS1-CS5) conventions for doc style preferences if they exist.

### Step 2: Write the documentation

Write docs in the appropriate location: project-level (README, CLAUDE.md) to standard paths, feature docs to the project's docs directory, inline docs to source files.

**Principles**: follow DOCS.md style conventions, infer details from existing docs. Write as intended steady state (evergreen, non-temporal). Primary audience first. Concrete examples. DRY across doc files.

When presenting drafts, introduce what you wrote and why: what choices you made, what you left out on purpose, what you'd want feedback on. Don't just dump the doc.

Present draft for approval before writing.

### Step 3: Pre-write self-audit

Pre-write self-audit: check verbosity drift (per-artifact budget), abstraction creep (≥1 concrete anchor), and filler accumulation (banned patterns). See `scripts/self_audit.py` (v2 path: `scripts/self_audit.py`).
Max 3 revision attempts. Flag with [post-audit-flagged] if still failing.

Narration voice (riff, don't script):

- "Tightening this up..." · "Cutting the filler first..." · "One more pass..."

### Step 4: Update DOCS.md

Add or update the entry in DOCS.md:

- Document name and path
- Date written
- Status: `current`

Output constraint: ≤15 words per index entry description.

Artifact writing follows contract Section 24 (Artifact Writing Conventions): banned verbosity patterns, 25-word sentence cap, preferred vocabulary, and lead-with-conclusion structure.

### Step 5: Suggest next steps

- Feature docs: suggest `/planera` to plan implementation
- Standalone docs: suggest update mode later for verification

---

## Explore-and-generate mode (docs for existing code)

Code exists, docs don't. Read codebase and generate.

Step markers: display `── step N/5: verb` before each step.
Steps: explore, gaps, generate, audit, update.

### Step 1: Explore

1. Map directory structure, read dependency manifests
2. Read existing docs to see what's already documented
3. Read key source files: architecture, public APIs, patterns
4. Read VISION.md, PROGRESS.md, DECISIONS.md, decision profile if they exist
5. `git log --oneline -20` for context

**Exit-early guard**: If DOCS.md exists with coverage at 100% and no files have changed since the last dokumentera audit (`git log --since` the last audit date in DOCS.md shows no changes), report exit signal `complete` (EX1): documentation current, and stop.

### Step 2: Identify gaps

Compare what exists against what should be documented: README.md accuracy, CLAUDE.md/AGENTS.md presence, API docs, CLI docs with usage, configuration docs, architectural decision docs.

### Step 3: Generate

Write docs for gaps, prioritized: (1) README, (2) CLAUDE.md, (3) API/CLI docs, (4) architecture docs. Follow DOCS.md style conventions.

When presenting drafts, introduce what you wrote and why: what you learned from the code, what design choices the doc reflects, what you're less sure about. Don't just dump the doc.

Present drafts for approval.

### Step 4: Pre-write self-audit

Pre-write self-audit: check verbosity drift (per-artifact budget), abstraction creep (≥1 concrete anchor), and filler accumulation (banned patterns). See `scripts/self_audit.py` (v2 path: `scripts/self_audit.py`).
Max 3 revision attempts. Flag with [post-audit-flagged] if still failing.

Narration voice (riff, don't script):

- "Tightening this up..." · "Cutting the filler first..." · "One more pass..."

### Step 5: Update DOCS.md

Create or update DOCS.md with all items. Use the Edit tool on specific entries when updating status/dates. If DOCS.md doesn't exist, run first-run survey first.

Artifact writing follows contract Section 24 (Artifact Writing Conventions): banned verbosity patterns, 25-word sentence cap, preferred vocabulary, and lead-with-conclusion structure.

---

## Update-and-verify mode (audit-driven)

Docs exist but may have drifted from implementation.

Step markers: display `── step N/6: verb` before each step.
Steps: discover, verify, prose-enforce, report, audit, update.

### Step 1: Discover

Identify all doc files: root (README, CLAUDE.md, etc.), directories (docs/, .github/), config comments. Read DOCS.md for current index. Track auto-generated docs as `generated`. Skip node_modules/, .git/, vendor/.

### Step 2: Verify

Check each doc file on four dimensions:

- **Gaps**: documented features/APIs/behaviors that don't exist in code
- **Staleness**: changed signatures, removed features, outdated setup instructions
- **Redundancies**: duplicated content across doc files
- **Misalignments**: docs contradict actual code behavior

For each finding: quote the doc section, reference code location (file:line), explain the discrepancy.

### Step 3: Doc-prose enforcement

Check all docs indexed in DOCS.md against the 3 self-audit rules:

1. **Read DOCS.md Index**: if DOCS.md is absent, run first-run survey to bootstrap it, then continue. Extract the list of tracked docs from the Index table. Skip entries with `generated` or `missing` status.
2. **For each doc**, read the file and check against the 3 rules:
   - **Verbosity drift**: entry word counts exceeding token budgets for the artifact's scope. Flag entries that exceed budget without compaction.
   - **Abstraction creep**: sections lacking ≥1 concrete anchor (file path, line number, commit hash, metric value, identifier, direct quote). Flag entries that narrate concepts without evidence.
   - **Filler accumulation**: scan for banned verbosity patterns: meta-commentary about writing, hedging qualifiers, redundant transitions, self-referential process narration, filler introductions, summary preambles, excessive justification. Flag entries containing banned patterns.
3. **Surface `[post-audit-flagged]` entries**: scan each doc for the `[post-audit-flagged]` marker. Report any flagged entries as warning-level findings.
4. **Report findings** at standard severity levels:
   - **critical** (SF1): doc section contradicts code, or instructions that would cause user errors
   - **warning** (SF2): verbosity drift above budgets, abstraction creep, accumulated filler patterns, pre-existing `[post-audit-flagged]` markers
   - **info** (SF3): minor style issues, single banned pattern in an otherwise clean entry

### Step 4: Report and fix

By severity: ⇶ critical (VT5, causes user errors), ⇉ warning (VT6, causes confusion), ⇢ info (VT8, cosmetic). For each finding, offer to: fix the doc, file to TODO.md (code is wrong per DTC), or skip.

### Step 5: Pre-write self-audit

Pre-write self-audit: check verbosity drift (per-artifact budget), abstraction creep (≥1 concrete anchor), and filler accumulation (banned patterns). See `scripts/self_audit.py` (v2 path: `scripts/self_audit.py`).
Max 3 revision attempts. Flag with [post-audit-flagged] if still failing.

Narration voice (riff, don't script):

- "Tightening this up..." · "Cutting the filler first..." · "One more pass..."

### Step 6: Update DOCS.md

Update the index with:

- ▸ Audit date
- ▸ Status changes (■ current / ▣ stale / □ missing)
- ▸ Coverage numbers
- ▸ Audit log entry

---

## Safety rails

<critical>
- NEVER modify documentation without explicit user approval. Present drafts and get confirmation.
- NEVER update docs to match broken code. Per DTC, if code diverges from docs, the code is wrong. Document the divergence as an issue in TODO.md.
- NEVER write temporal documentation (changelogs, "we recently added..."). Write as the intended steady state, evergreen and non-temporal.
- NEVER duplicate information across doc files. Keep it DRY: reference, don't repeat.
- NEVER write generic filler documentation. Every sentence should be specific to this project. If there's nothing useful to say about a section, omit it.
- NEVER skip the verification step in update mode. Every doc claim must be checked against code.
- NEVER auto-generate documentation without reading the code it describes. Understanding precedes documentation.
</critical>

---

## Exit signals

Report one of these statuses at workflow completion (protocol refs: EX1-EX4).

Format: `▤ dokumentera · <status>` followed by a summary sentence.
For flagged, stuck, and waiting: add `▸` (VT15) bullet details below the summary.

- **complete** (EX1): Documentation was written, updated, or audited successfully; DOCS.md is current, and all drafted content received user approval before writing.
- **flagged** (EX2): Documentation tasks completed but gaps remain (e.g., some doc files could not be verified against code, coverage is partial, or the audit found issues that were logged but not yet fixed).
- **stuck** (EX3): Cannot proceed because a user approval step was declined, a required artifact (VISION.md, source code) is missing or inaccessible, or a contradicting doc-vs-code situation requires a decision the capability should not make autonomously.
- **waiting** (EX4): The documentation intent is unclear: the target audience, format, or scope of what to document was not specified and cannot be inferred from the codebase or DOCS.md.

---

## Cross-capability integration

Dokumentera is part of a twelve-capability suite. It is the documentation layer, the "D" in DTC.

### Dokumentera feeds planera (DTC pipeline)

In the strict DTC pipeline, dokumentera writes intent docs first, then planera breaks them into implementation tasks. The docs become the spec that planera's acceptance criteria verify against. When the plan includes documentation tasks, dokumentera handles them.

### Dokumentera feeds realisera

When dokumentera writes intent-first docs for a feature that doesn't exist yet, realisera implements code to match those docs. The docs are the target state; if code diverges from docs, the code is wrong (per DTC).

### Dokumentera is informed by inspektera

HEALTH.md findings may include documentation gaps. Inspektera's architecture alignment dimension can surface undocumented modules or APIs.

### Dokumentera is informed by visionera

VISION.md sets the project's direction and audience. Dokumentera reads it to understand who the documentation is for and what tone to use.

### Dokumentera is informed by profilera

The decision profile calibrates documentation style: the user's preferences for detail level, tone, format, and which docs they consider essential.

### Dokumentera reads visualisera output

DESIGN.md provides visual identity context that dokumentera respects when generating user-facing documentation, ensuring docs match the project's declared aesthetic and voice.

### Dokumentera feeds profilera

Documentation decisions (what to document, how, at what depth) are signal for profilera's extraction scripts.

---

## Getting started

### DTC-first: document before building

1. `/dokumentera`: write intent docs for the feature (what it should do, how it should work)
2. `/planera`: plan the implementation with acceptance criteria derived from the docs
3. `/realisera`: build to match the docs
4. `/dokumentera`: update mode to verify docs still match implementation

### Document existing code

1. `/dokumentera`: explore-and-generate mode reads the codebase and writes docs for what exists
2. Review generated docs for accuracy and completeness

### Audit and maintain

1. `/dokumentera`: update-and-verify mode checks all docs against code
2. Fix findings or file code issues to TODO.md

### Project bootstrap

1. `/visionera`: create VISION.md (strategic direction)
2. `/dokumentera`: create README.md, CLAUDE.md, AGENTS.md (project documentation)
3. `/planera`: plan first features
4. `/realisera`: start building
