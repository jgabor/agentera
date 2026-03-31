---
name: dokumentera
description: >
  DOKUMENTERA — Documentation Origin: Knowledge Unified, Methodology Enforced, Notation
  Traced — Examine, Record, Articulate. ALWAYS use this skill for creating, updating, or
  auditing project documentation. This skill is REQUIRED whenever the user wants to write
  documentation before building a feature (DTC-first), generate docs for existing code,
  update stale documentation, audit docs against implementation, create README/CLAUDE.md/
  AGENTS.md, write API documentation, or maintain any project-level documentation. Do NOT
  create or significantly modify project documentation without this skill — it contains the
  critical workflow for intent-first documentation, context-detected approach, doc-vs-code
  verification, and DOCS.md coverage tracking. Trigger on: "dokumentera", "write docs",
  "document this", "update the docs", "create README", "write CLAUDE.md", "write AGENTS.md",
  "docs first", "document before building", "audit docs", "check documentation", "are the
  docs up to date", "docs out of sync", any request to create or maintain documentation, any
  request to verify docs against code, or when planera's plan includes documentation tasks.
---

# DOKUMENTERA

**Documentation Origin: Knowledge Unified, Methodology Enforced, Notation Traced — Examine, Record, Articulate**

The "D" in DTC. Writes documentation that defines intent before code exists, generates docs for
existing code, maintains docs as projects evolve, and verifies docs against implementation. One
skill for the full documentation lifecycle.

Two modes: **create** (new documentation) and **update** (revise and verify existing docs).
Context-detected approach: if the feature doesn't exist yet, write intent-first docs. If the
code exists but docs don't, explore and generate.

---

## State artifacts

Dokumentera maintains one index file and writes to individual doc files across the project.

| Artifact | Purpose | Bootstrap |
|----------|---------|-----------|
| `DOCS.md` | Documentation contract. Conventions, artifact mapping, and documentation index. | Created on first dokumentera run. |

The template lives in `references/templates/`. Individual doc files (README.md, CLAUDE.md, etc.)
are written directly to their standard locations.

### Artifact path resolution

Before reading or writing any artifact, check if DOCS.md exists in the project root. If it
has an Artifact Mapping section, use the path specified for each canonical filename (DOCS.md,
etc.). If DOCS.md doesn't exist or has no entry for a given artifact, default to the project
root. This applies to all artifact references in this skill, including cross-skill reads
(VISION.md, PROGRESS.md, DECISIONS.md, HEALTH.md).

### DOCS.md

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
| README | README.md | YYYY-MM-DD | current |
...
```

---

## Step 0: Detect context

Determine what kind of documentation work is needed.

1. **Read DOCS.md** if it exists — understand current documentation state
2. **Read the user's request** — are they asking to document something specific, or a broad
   "write docs" / "update docs"?
3. **Check the codebase** — does the feature or module they're asking about exist in code?

| Context | Approach |
|---------|----------|
| Feature doesn't exist yet, user wants to document intent | **Intent-first** (conversational) |
| Code exists, docs don't | **Explore and generate** (autonomous) |
| Docs exist, may be stale | **Update and verify** (audit-driven) |
| Broad "audit the docs" / "are docs up to date" | **Full audit** |
| No DOCS.md exists | **First-run survey** (convention detection) |

---

## First-run survey (convention detection)

When DOCS.md doesn't exist, dokumentera runs a survey before any other mode. The survey
observes the project and proposes a three-layer convention map for user approval.

### Step 1: Explore structure

Read the codebase to detect documentation conventions:

1. **Doc root** -- where do documentation files live? Check for docs/, doc/, documentation/,
   wiki/, or docs scattered at root. If no doc directory exists, default to root.
2. **Existing docs** -- what documentation already exists? README, CLAUDE.md, AGENTS.md,
   CONTRIBUTING.md, API docs, guides, tutorials.
3. **Auto-generated docs** -- detect tooling output: TypeDoc (typedoc.json, docs/api/),
   Storybook (.storybook/), OpenAPI/Swagger (openapi.yaml, swagger.json), GoDoc, Rustdoc,
   Javadoc. Record each with its output path.
4. **Style** -- read existing docs to infer tone (technical/casual), structure patterns
   (sections with examples, flat descriptions), formatting conventions (badges, TOC, etc.).
5. **Existing skill artifacts** -- check for VISION.md, DECISIONS.md, PLAN.md, PROGRESS.md,
   ISSUES.md, HEALTH.md, OBJECTIVE.md, EXPERIMENTS.md at root. Note which already exist.

### Step 2: Propose conventions

Draft a three-layer DOCS.md using the template from `references/templates/`:

1. **Conventions** -- populate doc_root, style, and auto_gen from what was observed
2. **Artifact mapping** -- propose paths for all skill artifacts, consistent with the
   project's doc organization. If the project keeps docs at root, map to root. If docs
   live in docs/, propose docs/ paths for artifacts.
3. **Index** -- populate with all discovered documentation files. Auto-generated docs get
   `generated` status. Existing docs get `current` status.

Present the proposed DOCS.md to the user for approval. The user can modify any section
before it's written.

### Step 3: Handle existing artifacts

If skill artifacts already exist at root but the proposed mapping places them elsewhere:

1. List the artifacts that would need to move (e.g., "VISION.md is at root but the mapping
   says docs/VISION.md")
2. Offer to relocate them: `git mv` each artifact to its new path
3. If the user declines relocation, update the mapping to match where artifacts actually are

### Step 4: Write DOCS.md

Write the approved convention map. All other dokumentera modes and all other skills now
read this file for artifact paths and documentation conventions.

After writing DOCS.md, proceed to whatever mode the user originally requested (create,
generate, audit) -- or stop if the survey was the entire request.

---

## Intent-first mode (docs before code)

This is the DTC-first path. The user wants to document what a feature SHOULD do before anyone
builds it. The documentation becomes the spec that realisera implements against.

### Step 1: Understand the intent

A brief conversation (2-4 questions) to capture:

- **What** is being documented? (feature, API, CLI command, module, project)
- **Who** reads this documentation? (end users, developers, agents, contributors)
- **What format** fits? (README section, dedicated doc file, CLAUDE.md entry, API reference)
- **What level of detail?** (overview, tutorial, reference, all three)

If VISION.md exists, read it to understand the project's direction and audience.
If the decision profile exists (`~/.claude/profile/PROFILE.md`), read it for documentation
style preferences — detail level, tone, format, and which docs the user considers essential.

### Step 2: Write the documentation

Write the documentation in the appropriate location and format:

- **Project-level docs** (README.md, CLAUDE.md, AGENTS.md, CONTRIBUTING.md): write directly
  to the standard location
- **Feature docs** (docs/*.md, API references): create in the project's docs directory
- **Inline docs** (help text, CLI descriptions): write to the source file or config

**Documentation principles** (from the decision profile):
- If DOCS.md has a Conventions section with style defaults, follow them. Infer fine details (voice, formatting quirks) from existing docs in the project.
- Write as the intended steady state, not a changelog
- Evergreen and non-temporal — what WILL be, not what currently is
- Write for the primary audience (agents first if agent-consumed, humans first otherwise)
- Include concrete examples, not just descriptions
- Keep it DRY — don't duplicate information across doc files

Present the draft to the user for approval before writing.

### Step 3: Update DOCS.md

Add or update the entry in DOCS.md:
- Document name and path
- Date written
- Status: `current`

### Step 4: Suggest next steps

In the strict DTC pipeline:
- If the docs define a feature to build: suggest `/planera` to plan the implementation
- If the docs are standalone (README, CONTRIBUTING): suggest running `/doc-audit` patterns
  to verify accuracy (or dokumentera's own update mode later)

---

## Explore-and-generate mode (docs for existing code)

Code exists but documentation doesn't. Dokumentera reads the codebase and generates docs.

### Step 1: Explore

Read the codebase deeply — same depth as visionera's exploration:

1. Map directory structure
2. Read dependency manifests
3. Read existing docs (README, CLAUDE.md, etc.) — understand what's already documented
4. Read key source files — understand architecture, public APIs, patterns
5. Read VISION.md, PROGRESS.md, DECISIONS.md if they exist
6. Read the decision profile (`~/.claude/profile/PROFILE.md`) if it exists — calibrate doc
   style, detail level, and format preferences
7. `git log --oneline -20` for recent context

### Step 2: Identify gaps

Compare what exists against what should be documented:

- Does README exist and describe the project accurately?
- Does CLAUDE.md exist with development instructions?
- Are public APIs documented?
- Are CLI commands documented with usage examples?
- Are configuration options documented?
- Are key architectural decisions documented?

### Step 3: Generate

Write documentation for the identified gaps. Prioritize by impact:

1. **README** — if missing or severely outdated, this is always first
2. **CLAUDE.md** — if missing, critical for agent-assisted development
3. **API / CLI docs** — public interfaces need documentation
4. **Architecture docs** — if the codebase is complex enough to warrant them

When writing docs, follow the style conventions declared in DOCS.md. Infer fine details from existing project docs.

Present each doc draft to the user for approval before writing.

### Step 4: Update DOCS.md

Create or update DOCS.md with all documented and undocumented items.
If DOCS.md doesn't exist yet, run the first-run survey first to establish conventions before populating the index.

---

## Update-and-verify mode (audit-driven)

Docs exist but may have drifted from implementation.

### Step 1: Discover

Identify all documentation files:

- Root: README.md, CLAUDE.md, AGENTS.md, CONTRIBUTING.md, CHANGELOG.md
- Directories: docs/, .github/
- Config docs: comments in config files that make claims about behavior
- Read DOCS.md if it exists for the current index

Track auto-generated docs (typedoc, godoc, etc.) in the index with `generated` status -- don't verify their content, but record their existence. Skip files in node_modules/, .git/, vendor/.

### Step 2: Verify

For each documentation file, check four dimensions:

**Gaps** — documented but not implemented:
- Features, APIs, or behaviors described in docs that don't exist in code
- CLI flags or config options mentioned but not handled
- Examples referencing functions or modules that don't exist

**Staleness** — code changed but docs not updated:
- Function signatures that changed
- Removed features still documented
- Changed default values or behaviors
- Outdated setup instructions

**Redundancies** — same information in multiple places:
- Identical or near-identical content across doc files
- Instructions that could diverge over time

**Misalignments** — docs contradict implementation:
- Documented behavior differs from actual code behavior
- Stated constraints not enforced in code

For each finding, gather concrete evidence:
- Quote the relevant doc section
- Reference the relevant code location (file:line)
- Explain the discrepancy

### Step 3: Report and fix

Categorize findings by severity:

- **Critical** — will cause user errors (documented APIs that don't exist, wrong setup steps)
- **Warning** — may cause confusion (stale content, redundancies)
- **Info** — cosmetic, low-impact (slightly outdated examples, wording inconsistencies)

Present findings to the user with suggested fixes. For each finding, offer to:
- **Fix it** — update the documentation to match reality
- **File it** — add to ISSUES.md if it's a code problem (docs are right, code is wrong — per DTC)
- **Skip it** — intentional or not worth fixing

### Step 4: Update DOCS.md

Update the index with:
- Audit date
- Status changes (current / stale / missing)
- Coverage numbers
- Audit log entry

---

## Safety rails

<critical>

- NEVER modify documentation without explicit user approval. Present drafts and get confirmation.
- NEVER update docs to match broken code. Per DTC, if code diverges from docs, the code is
  wrong. Document the divergence as an issue in ISSUES.md.
- NEVER write temporal documentation (changelogs, "we recently added..."). Write as the
  intended steady state — evergreen and non-temporal.
- NEVER duplicate information across doc files. Keep it DRY — reference, don't repeat.
- NEVER write generic filler documentation. Every sentence should be specific to this project.
  If there's nothing useful to say about a section, omit it.
- NEVER skip the verification step in update mode. Every doc claim must be checked against code.
- NEVER auto-generate documentation without reading the code it describes. Understanding
  precedes documentation.

</critical>

---

## Exit signals

Report one of these statuses at workflow completion:

- **complete** — Documentation was written, updated, or audited successfully; DOCS.md is current, and all drafted content received user approval before writing.
- **flagged** — Documentation tasks completed but gaps remain (e.g., some doc files could not be verified against code, coverage is partial, or the audit found issues that were logged but not yet fixed).
- **stuck** — Cannot proceed because a user approval step was declined, a required artifact (VISION.md, source code) is missing or inaccessible, or a contradicting doc-vs-code situation requires a decision the skill should not make autonomously.
- **waiting** — The documentation intent is unclear: the target audience, format, or scope of what to document was not specified and cannot be inferred from the codebase or DOCS.md.

---

## Cross-skill integration

Dokumentera is part of a ten-skill ecosystem. It is the documentation layer — the "D" in DTC.

### Dokumentera feeds /planera (DTC pipeline)
In the strict DTC pipeline, dokumentera writes intent docs first, then planera breaks them
into implementation tasks. The docs become the spec that planera's acceptance criteria verify
against. When the plan includes documentation tasks, dokumentera handles them.

### Dokumentera feeds /realisera
When dokumentera writes intent-first docs for a feature that doesn't exist yet, realisera
implements code to match those docs. The docs are the target state — if code diverges from
docs, the code is wrong (per DTC).

### Dokumentera is informed by /inspektera
HEALTH.md findings may include documentation gaps. Inspektera's architecture alignment
dimension can surface undocumented modules or APIs.

### Dokumentera is informed by /visionera
VISION.md sets the project's direction and audience. Dokumentera reads it to understand who
the documentation is for and what tone to use.

### Dokumentera is informed by /profilera
The decision profile calibrates documentation style — the user's preferences for detail level,
tone, format, and which docs they consider essential.

### Dokumentera feeds /profilera
Documentation decisions (what to document, how, at what depth) are signal for profilera's
extraction scripts.

---

## Getting started

### DTC-first: document before building

1. `/dokumentera` — write intent docs for the feature (what it should do, how it should work)
2. `/planera` — plan the implementation with acceptance criteria derived from the docs
3. `/realisera` — build to match the docs
4. `/dokumentera` — update mode to verify docs still match implementation

### Document existing code

1. `/dokumentera` — explore-and-generate mode reads the codebase and writes docs for what exists
2. Review generated docs for accuracy and completeness

### Audit and maintain

1. `/dokumentera` — update-and-verify mode checks all docs against code
2. Fix findings or file code issues to ISSUES.md

### Project bootstrap

1. `/visionera` — create VISION.md (strategic direction)
2. `/dokumentera` — create README.md, CLAUDE.md, AGENTS.md (project documentation)
3. `/planera` — plan first features
4. `/realisera` — start building
