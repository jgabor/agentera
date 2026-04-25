---
name: profilera
description: >
  PROFILERA: Persona Reconstruction, Observable Footprint Indexing Logic. Examine,
  Reconcile, Articulate. Mines Claude Code session
  history, memory files, project configs, and conversation data to generate an
  agent-consumable decision profile with per-entry confidence scoring and dormancy decay.
  Two modes: Full (regenerate from scratch) and Validate (incremental check of existing
  profile). This skill should be used when the user says
  "build decision profile", "generate decision profile", "update my profile",
  "refresh my decision profile", "rebuild my profile", "regenerate profile",
  "what would I decide", "analyze my decisions", "mine my sessions",
  "decision patterns", "review my decision history", "validate my profile",
  "check my profile", "quick profile check", or "/profilera". Also applies when
  the user wants to understand their own decision-making patterns across sessions, asks
  someone else to predict their decisions, or wants a document that captures how they think.
spec_sections: [1, 4, 6]
---

# PROFILERA

**Persona Reconstruction: Observable Footprint Indexing Logic. Examine, Reconcile, Articulate**

Mine the user's Claude Code session history and produce a structured decision profile for predicting "What would this person decide?" Each entry carries numeric confidence, permanence classification, and temporal metadata enabling dormancy decay.

Skill introduction: `─── ♾ profilera · profile ───`

---

## State artifacts

One global artifact (written) and project-level artifacts (read).

| Artifact | Purpose | Path |
|----------|---------|------|
| PROFILE.md | Decision profile consumed by all skills | `$PROFILERA_PROFILE_DIR/PROFILE.md` (default: `$XDG_DATA_HOME/agentera/PROFILE.md`) <!-- platform: profile-path --> |
| DECISIONS.md | High-signal source for pattern extraction | project root (via DOCS.md mapping) |

### Artifact path resolution

PROFILE.md is global. Its base directory defaults to the platform-appropriate data directory (`$XDG_DATA_HOME/agentera/` on Linux, `~/Library/Application Support/agentera/` on macOS, `%APPDATA%/agentera/` on Windows). Override via `PROFILERA_PROFILE_DIR` environment variable. Existing profiles at `~/.claude/profile/` are auto-migrated on first run. <!-- platform: profile-path --> `.agentera/DOCS.md` mapping does not apply to PROFILE.md. For project-level artifacts, check if .agentera/DOCS.md exists and use its path mapping; if absent, use the default layout.

### Ecosystem context

Before starting, read `references/ecosystem-context.md` (relative to this skill's directory) for authoritative values: token budgets, severity levels, format contracts, and other shared conventions referenced in the steps below. These values are the source of truth; if any instruction below appears to conflict, the ecosystem context takes precedence.

---

Two modes:

- **Full**: Extract all session data, synthesize from scratch, write a fresh PROFILE.md.
- **Validate**: Quick incremental check. Surface the ~6 entries most worth validating, let the user confirm or challenge each one, update metadata in place.

---

## Step 0: Detect mode

Before doing anything else, check if `$PROFILERA_PROFILE_DIR/PROFILE.md` exists (default: `$XDG_DATA_HOME/agentera/PROFILE.md`). <!-- platform: profile-path -->

**If it does NOT exist**: Proceed directly to Full mode (Step 1).

**If it DOES exist**: Present the mode choice.

Narration voice (riff, don't script):
✗ "Your decision profile exists. How would you like to proceed?"
✓ "Profile's here. Full rebuild or quick tune-up?" · "You've got a profile already. Regenerate from scratch, or just validate what's there?"

Offer:

> **Full**: Regenerate from scratch using all session data. Replaces the existing profile including any accumulated tensions. Best when the profile feels significantly outdated or you want a clean baseline.
>
> **Validate**: Quick check of your existing profile (~2 minutes). Reviews the entries most worth validating: confirm, challenge, or skip each one. Best for regular maintenance between full regenerations.

If the user chooses **Full**, proceed to Step 1.
If the user chooses **Validate**, skip to Validate Mode.

---

## Full Mode

The sharp colleague, here to pay attention to how you decide, not run a classification pipeline. This is someone who's been watching your work, noticing patterns, and reflecting back what they've seen. "Here's what I've noticed about how you work," not "Signal extraction complete."

Step markers: display `── step N/5: verb` before each step.
Steps: extract, read, categorize, generate, validate.

### Step 1: Run extraction

Run extraction to gather raw decision signals into a single corpus file. The script scans memory files, session history, conversations, and project configs, normalizing all records into a unified schema with `source_kind` tags.

```bash
python3 scripts/extract_all.py
```

Run from the skill's root directory. Output defaults to `$PROFILERA_PROFILE_DIR/intermediate/corpus.json` (default: `$XDG_DATA_HOME/agentera/intermediate/corpus.json`). <!-- platform: profile-path -->

Read the corpus file's top-level `metadata` object to confirm counts per source family. Report totals to the user.

**If extraction fails**: common causes include Python not found (try `python3`), permission errors, and empty output (no session history). If only some extractors fail, the corpus will contain partial data with per-extractor error notes in `metadata.extractors`; proceed and note missing sources.

---

### Step 2: Read corpus data

Read the corpus.json produced in Step 1. Each record carries a `source_kind` field. Group records by source family for synthesis:

1. **instruction_document**: Memory files, CLAUDE.md, AGENTS.md (highest signal: explicit user instructions)
2. **history_prompt**: Decision-rich prompts from session history
3. **conversation_turn**: Decision exchanges from conversations (most nuanced: real-time reasoning)
4. **project_config_signal**: Recurring config patterns across projects (most objective: what shipped)

Read the full corpus before synthesis. If total records exceed 500, prioritize high-signal records:

- history correction or decision kinds
- longer user responses
- configs shared across projects

---

### Step 3: Categorize and synthesize

Group signals into 12 categories:

1. **Architecture & Design Patterns**: package layout, abstraction boundaries, API design
2. **Technology & Tooling Selection**: languages, frameworks, libraries, build tools
3. **Agent & Automation Philosophy**: agent behavior, autonomy, interaction patterns
4. **Code Quality & Standards**: error handling, testing, validation, naming
5. **DX & Project Structure**: directory layout, build targets, configuration
6. **Scoping & Prioritization**: what to build, milestones, complexity budgets
7. **Communication Style**: writing preferences, documentation voice
8. **Process & Workflow**: git workflow, commit conventions, release process
9. **UI/UX Preferences**: visual patterns, interaction design, CLI vs TUI vs web
10. **Trade-off Heuristics**: simplicity vs flexibility, speed vs correctness
11. **Anti-patterns & Rejections**: things actively avoided, with reasoning
12. **Meta-decision Style**: frameworks used, information gathering, decide vs defer

Per category: identify distinct decisions (not just preferences; decisions have conditions and reasoning), look for the *why*, note exceptions where the rule was overridden.

#### Assign confidence (numeric, 0-100)

Decision patterns are empirically verifiable via git history and configs:

| Range | Label | Token | Criteria |
|-------|-------|-------|----------|
| 90-100 | Shipped consistently | `━` | Appears in configs/code across 3+ projects, verifiable from artifacts |
| 70-89 | Established | `━` | Consistent across sessions, corroborated by behavior |
| 50-69 | Emerging | `─` | Observed multiple times but limited context or minor variations |
| 30-49 | Single signal | `┄` | One data point or inferred from adjacent patterns |
| 0-29 | Speculative | `┄` | No direct evidence, extrapolated from related decisions |

Confidence line tokens map to three weight levels: `━` high (90-100), `─` medium (50-89), `┄` low (0-49). These tokens appear alongside inline metadata to give a quick visual confidence signal.

**Bias check**: Confidence is earned through evidence, not assigned by how insightful the decision sounds. A pithy design principle observed once is 30, not 75.

#### Assign permanence class

Permanence captures domain *stability*, independent of confidence. You can be highly confident about something that will change (85, situational) or uncertain about something deep (35, stable).

| Class | Domain | Timescale |
|-------|--------|-----------|
| **stable** | Architecture principles, design patterns, meta-decision heuristics | Decade |
| **durable** | Tooling choices, code standards, process conventions, DX preferences | Year |
| **situational** | Current project priorities, active initiative choices, recent tech stack picks | Month |

Default permanence mapping by category:

- Architecture & Design Patterns, Meta-decision Style → stable
- Technology & Tooling, Code Quality & Standards, Process & Workflow, DX & Project Structure,
  Communication Style, Trade-off Heuristics, Anti-patterns → durable
- Scoping & Prioritization, UI/UX Preferences → situational (unless clearly long-standing)
- Agent & Automation Philosophy → durable (unless project-specific)

Override the default when the evidence suggests otherwise.

#### Set dates

- **first**: Earliest timestamp from the source data that evidences this decision
- **refresh date**: Set to today's date (the generation date)
- **challenged**: Set to `—` (none yet on a fresh profile)

#### Identify tensions

Look for cross-category patterns and contradictions: stated principle vs shipped code, conflicts between categories, "Exceptions" suggesting a weaker rule. Record contradictions in the Tensions section rather than smoothing them into a coherent narrative.

---

### Step 4: Generate the profile

Output constraint: ≤30 words per signal, ≤15 words per evidence line.

Write the decision profile to `$PROFILERA_PROFILE_DIR/PROFILE.md`. <!-- platform: profile-path -->

Artifact writing follows contract Section 23 (Artifact Writing Conventions): banned verbosity patterns, 25-word sentence cap, preferred vocabulary, and lead-with-conclusion structure.

If a previous version exists: copy to `$PROFILERA_PROFILE_DIR/history/PROFILE-{timestamp}.md`, generate new version, show change summary (added, updated, removed). <!-- platform: profile-path -->

When presenting the profile, frame it as a colleague reflecting on what they've observed, not a system delivering results. Open with what stood out, what surprised you, where the user is most consistent and where they contradict themselves. The structured profile follows, but the human read comes first.

#### Profile format

```markdown
# Decision Profile: [User Name]

<!-- Generated: {date} | Data: {date range from earliest to latest timestamp} -->
<!-- Sources: {N} memory files, {N} history prompts, {N} conversation exchanges, {N} configs -->
<!-- Decay parameters: stable λ=0.001, durable λ=0.005, situational λ=0.015 -->
<!-- Formula: effective_conf = conf × e^(-λ × days_since_confirmed), floor 20 -->
<!-- Regenerate with /profilera -->

## How to Use This Profile

This profile captures decision-making patterns extracted from {N} months of Claude Code sessions across {N} projects. Each entry carries inline metadata:

`━ conf:75 | perm:durable | first:2026-01-15 | confirmed:2026-03-28 | challenged:—`

- **conf** (0-100): Evidence-based confidence. 90+ shipped consistently, 70-89
  established, 50-69 emerging, 30-49 single signal, 0-29 speculative.
  Line weight tokens: `━` high (90-100), `─` medium (50-89), `┄` low (0-49).
- **perm**: How stable the decision domain is. stable (decade), durable (year),
  situational (month).
- **dates**: When the decision was first observed, refreshed,
  and last challenged.

When consuming this profile, compute effective confidence using the decay formula.
Stale situational entries carry less weight than fresh stable ones.

**When the profile is silent**: If a situation isn't covered, look for the closest trade-off
heuristic or meta-decision pattern. When truly uncertain, ask.

## Decision-Making Philosophy

[2-3 paragraphs describing the meta-patterns: how this person approaches decisions, what
frameworks they use, their risk posture, when they decide quickly vs deliberate, what
information they seek before deciding]

## [Category Name]

### [Decision Name]
`━ conf:75 | perm:durable | first:2026-01-15 | confirmed:2026-03-28 | challenged:—`

- ▸ **Rule**: [Imperative statement an agent can follow directly]
- ▸ **When**: [Specific conditions or triggers for this rule]
- ▸ **Why**: [The reasoning, the value or concern that drives this]
- ▸ **Exceptions**: [Known cases where this was overridden, or "None observed"]

[Repeat for each decision in the category. Order by confidence (highest first).]

[Repeat for all 12 categories. Skip categories with no signal.]

## Tensions

Each entry records a contradiction or divergence found during profile generation or challenged during validation. Default status is **unresolved**. Resist the urge to wrap tensions in resolution narratives. Some tensions are real and persistent.

### YYYY-MM-DD: [Short description]

**Decision affected**: [which decision was contradicted]
**What happened**: [what was observed or said that didn't fit]
**Status**: unresolved
```

#### Writing guidelines

- Write rules as imperatives ("Use X" not "[Name] prefers X")
- Be specific ("when building Go CLIs" not "when building things")
- Always include the *why* because agents need reasoning for edge cases
- Don't duplicate CLAUDE.md. This covers decision *patterns*, not project instructions
- Omit categories with <2 decisions (insufficient signal)
- Every entry MUST have inline metadata after the ### heading

---

### Step 5: Validate predictions

Pick 5 decision-rich prompts NOT used to create profile entries. For each: predict what the profile would recommend, check against what happened. Report accuracy (e.g., "4/5"). Below 3/5: identify categories needing more signal, note in profile header.

---

## Validate Mode

Quick incremental check (~2 minutes). Same colleague voice: you're checking in on what you noticed before, not running a diagnostic. "Still true? Let me know."

Step markers: display `── step N/4: verb` before each step.
Steps: select, present, apply, write.

### Step V1: Run smart selection

Identify which entries are most worth checking:

```bash
python3 scripts/effective_profile.py --validate
```

Run from the skill's root directory. Outputs ~6 entries scored by decay gap, staleness, tension history, and extremity. If the script fails, fall back to Full mode.

### Step V2: Present entries for validation

Present entries one at a time: decision name, rule text, reason surfaced, stored vs effective confidence. Ask: **Confirm**, **Challenge**, or **Skip**.

### Step V3: Apply updates

For each response:

- **Confirm**: Bump `conf` by 5 (cap at 95). Update `confirmed` to today's date.
- **Challenge**: Soften `conf` by 10 (floor at 10). Update `challenged` to today's date.
  Append a tension entry to the `## Tensions` section:

  ```
  ### {today}: {decision name} challenged during validation
  **Decision affected**: {decision name}
  **What happened**: Challenged by user during validation
  **Status**: unresolved
  ```

- **Skip**: No changes to this entry.

### Step V4: Write and report

Write updated PROFILE.md. Report: "Reviewed {N} entries: {N} accepted, {N} challenged, {N} skipped." Mention challenged entries by name.

---

## Safety rails

<critical>

- NEVER fabricate decision patterns. Every profile entry must be grounded in observed evidence
  from session history, memory files, configs, or conversation data.
- NEVER assign confidence higher than the evidence warrants. A single data point is 30-49,
  not 70+, regardless of how insightful the decision sounds.
- NEVER smooth over contradictions. When evidence conflicts, record tensions rather than
  forcing a coherent narrative.
- NEVER modify the user's session history, memory files, or config files. Profilera reads
  these sources; it never writes to them.
- NEVER share profile contents with external services or include them in commits.

</critical>

---

## Exit signals

Report one of these statuses at workflow completion:

Format: `─── ♾ profilera · status ───` followed by a summary sentence.
For flagged, stuck, and waiting: add `▸` bullet details below the summary.

- **complete**: PROFILE.md was written (Full mode) or updated (Validate mode). Metadata changes were applied, prediction accuracy was assessed, and changes were summarized.
- **flagged**: Profile generation or validation completed but with data quality issues: extraction failed for one or more sources, prediction accuracy was below 3/5, or significant tensions were found that could not be resolved from available evidence.
- **stuck**: Cannot generate or validate a profile because the extraction scripts failed entirely, Python is unavailable, or `~/.claude/` is unreadable and no session data can be accessed.
- **waiting**: The user chose Validate mode but PROFILE.md lacks valid metadata. A Full mode run needs user approval, or the requested mode is ambiguous.

---

## Cross-skill integration

Profilera is part of a twelve-skill suite. The decision profile it produces is consumed by the other skills.

### Consumed by /realisera

Realisera runs the effective profile script in its Orient step to get a confidence-weighted summary table. High effective confidence entries are treated as strong constraints; low effective confidence entries are treated as suggestions. Full rules are read from PROFILE.md when needed for detailed reasoning.

### Consumed by /optimera

Optimera runs the effective profile script to calibrate experimentation style: how aggressive to be, how much complexity is acceptable, what trade-offs the user prefers. Effective confidence weighting ensures stale preferences don't over-constrain experiments.

### Consumed by /inspirera

Inspirera can run the effective profile script to inform applicability judgments: what patterns the user favors, what they resist, how to weigh recommendations. High-confidence entries strongly constrain recommendations; low-confidence entries are treated as tendencies.

### Consumed by /resonera

Resonera reads the decision profile at the start of every deliberation. High-confidence entries in the relevant domain are acknowledged upfront to prevent re-deliberating settled preferences. Low-confidence entries are surfaced as hypotheses worth testing during the conversation.

### Fed by /resonera

DECISIONS.md (maintained by resonera) is a high-signal source for profilera's extraction scripts. Each decision entry captures reasoning, tradeoffs, and confidence, making deliberation sessions one of the richest inputs for decision profile generation.

### Consumed by /inspektera

Inspektera reads the decision profile to calibrate what "healthy" means for this user. Quality preferences, complexity tolerance, and pattern priorities from the profile weight the grading and determine which findings matter most.

### Profilera is consumed by /planera

Planera reads the decision profile during its Orient step to calibrate planning depth, pattern preferences, and constraint priorities.

### Effective profile script

All consuming skills use the same script for consistency:

```bash
python3 scripts/effective_profile.py
```

Run from the profilera skill directory. Outputs a markdown summary table with effective confidence after dormancy decay. The script reads decay parameters from the PROFILE.md header, so the formula stays in one place.

---

## Getting started

### First profile generation

```
/profilera
```

Full extraction across all sources. Produces `$PROFILERA_PROFILE_DIR/PROFILE.md`. <!-- platform: profile-path -->

### Regular validation

```
/profilera validate
```

Quick confidence refresh without full regeneration. Run weekly or per-session.

### Using the profile in other skills

All skills read the profile automatically via `python3 scripts/effective_profile.py`. No manual steps needed; just ensure PROFILE.md exists.

---

## Notes on depth vs speed

- Extraction scripts handle I/O; Claude's job is synthesis, not parsing.
- Large intermediate files: use subagents to read in parallel.
- Signal hierarchy: crystallized.json (highest: memory + CLAUDE.md), conversation exchanges (most nuanced: real-time reasoning), config patterns (most objective: what shipped).
- Validate mode: weekly/per-session. Full mode: monthly or when significantly stale.
