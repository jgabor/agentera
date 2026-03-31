---
name: profilera
description: >
  PROFILERA — Persona Reconstruction: Observable Footprint Indexing Logic — Examine,
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
---

# PROFILERA

**Persona Reconstruction: Observable Footprint Indexing Logic — Examine, Reconcile, Articulate**

Mine the user's Claude Code session history and produce a structured decision profile that an
AI agent could use to predict "What would this person decide in a given situation?" Each profile
entry carries numeric confidence, permanence classification, and temporal metadata — enabling
dormancy decay so stale entries are automatically discounted by consuming skills.

Profile generation output opens with: `─── ♾ profilera · profile ───`

Two modes:

- **Full**: Extract all session data, synthesize from scratch, write a fresh PROFILE.md.
- **Validate**: Quick incremental check — surface the ~6 entries most worth validating, let the
  user confirm or challenge each one, update metadata in place.

---

## Step 0: Detect mode

Before doing anything else, check if `~/.claude/profile/PROFILE.md` exists.

**If it does NOT exist**: Proceed directly to Full mode (Step 1).

**If it DOES exist**: Present the mode choice to the user:

> Your decision profile exists. How would you like to proceed?
>
> **Full** — Regenerate from scratch using all session data. Replaces the existing profile
> including any accumulated tensions. Best when the profile feels significantly outdated or
> you want a clean baseline.
>
> **Validate** — Quick check of your existing profile (~2 minutes). Reviews the entries most
> worth validating — confirm, challenge, or skip each one. Best for regular maintenance
> between full regenerations.

If the user chooses **Full**, proceed to Step 1.
If the user chooses **Validate**, skip to Validate Mode.

---

## Full Mode

### Step 1: Run extraction

Run the Python extraction scripts to gather raw decision signals from all data sources. The
scripts handle the heavy JSONL parsing and output structured JSON that fits in context.

```bash
python3 -m scripts.extract_all --output-dir ~/.claude/profile/intermediate
```

The script auto-detects its own location and resolves paths from there. Run it from the
skill's root directory (the directory containing this SKILL.md file), typically at
`~/.claude/plugins/marketplaces/agentera/skills/profilera`.

After the scripts finish, read `~/.claude/profile/intermediate/extraction_summary.json` to
confirm the extraction counts. Report the summary to the user.

**If extraction fails**: Report the error to the user. Common causes:
- Python not found: try `python3` instead of `python`
- Permission errors: check that `~/.claude/` is readable
- Empty output: the user may have no session history yet — report this and skip to Step 4
  with whatever data is available
If only some extractors fail, proceed with partial data and note which sources are missing.

---

### Step 2: Read extracted data

Read all four intermediate JSON files:

1. `~/.claude/profile/intermediate/crystallized.json` — Memory files, CLAUDE.md, AGENTS.md
2. `~/.claude/profile/intermediate/history_decisions.json` — Decision-rich prompts from history
3. `~/.claude/profile/intermediate/conversation_decisions.json` — Decision exchanges from conversations
4. `~/.claude/profile/intermediate/project_configs.json` — Recurring config patterns

These files are pre-filtered and structured. Read them all before proceeding to synthesis.

If any file is very large (> 500 entries), focus on the highest-signal entries first:
- For history: prioritize "correction" and "decision" signal types over "question"
- For conversations: prioritize entries with longer user responses (more reasoning visible)
- For configs: look for patterns that appear across multiple projects

---

### Step 3: Categorize and synthesize

Group all extracted signals into these 12 categories:

1. **Architecture & Design Patterns** — How software is structured (package layout, abstraction
   boundaries, API design, data flow patterns)
2. **Technology & Tooling Selection** — What gets picked and why (languages, frameworks,
   libraries, build tools, linters)
3. **Agent & Automation Philosophy** — How AI agents should behave, what autonomy they get,
   interaction patterns
4. **Code Quality & Standards** — What "good code" means (error handling, testing, validation,
   naming, formatting)
5. **DX & Project Structure** — How projects should feel to work in (directory layout, build
   targets, configuration, documentation)
6. **Scoping & Prioritization** — How to decide what to build, version milestones, feature
   gating, complexity budgets
7. **Communication Style** — Writing preferences, documentation voice, how things should read
8. **Process & Workflow** — Git workflow, commit conventions, PR practices, release process
9. **UI/UX Preferences** — Visual patterns, interaction design, CLI vs TUI vs web preferences
10. **Trade-off Heuristics** — How competing concerns are resolved (simplicity vs flexibility,
    speed vs correctness, convention vs configuration)
11. **Anti-patterns & Rejections** — Things actively avoided, with reasoning
12. **Meta-decision Style** — How decisions are made (frameworks used, information gathering
    patterns, when to decide vs defer)

For each category:

- Identify distinct decisions (not just preferences — decisions have conditions and reasoning)
- Look for the *why* behind each decision, not just the *what*
- Note exceptions or cases where the usual rule was overridden

#### Assign confidence (numeric, 0-100)

Decision patterns are empirically verifiable — you can check git history and configs to see
if someone actually follows their stated convention. The confidence scale reflects this:

| Range | Label | Token | Criteria |
|-------|-------|-------|----------|
| 90-100 | Shipped consistently | `━` | Appears in configs/code across 3+ projects, verifiable from artifacts |
| 70-89 | Established | `━` | Consistent across sessions, corroborated by behavior |
| 50-69 | Emerging | `─` | Observed multiple times but limited context or minor variations |
| 30-49 | Single signal | `┄` | One data point or inferred from adjacent patterns |
| 0-29 | Speculative | `┄` | No direct evidence, extrapolated from related decisions |

Confidence line tokens map to three weight levels: `━` high (90-100), `─` medium (50-89), `┄` low (0-49). These tokens appear alongside inline metadata to give a quick visual confidence signal.

**Bias check**: Confidence is earned through evidence, not assigned by how insightful the
decision sounds. A pithy design principle observed once is 30, not 75.

#### Assign permanence class

Permanence captures how *stable* a decision domain is — independent of how *confident* you
are about it. You can be highly confident about something that will change (85, situational)
or uncertain about something deep (35, stable).

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
- **confirmed**: Set to today's date (the generation date)
- **challenged**: Set to `—` (no challenges yet on a fresh profile)

#### Identify tensions

Cross-category patterns are especially valuable. But also look for contradictions:
- Does the user state one principle but ship code that violates it?
- Do decisions in one category conflict with decisions in another?
- Are there "Exceptions" that suggest the rule is weaker than it appears?

When contradictions are found during synthesis, record them in the Tensions section of
PROFILE.md rather than smoothing them into a coherent narrative.

---

### Step 4: Generate the profile

Write the decision profile to `~/.claude/profile/PROFILE.md`.

If a previous version exists:
1. Copy it to `~/.claude/profile/history/PROFILE-{timestamp}.md`
2. Generate the new version
3. Show a summary of what changed (new decisions added, decisions updated, decisions removed)

#### Profile format

```markdown
# Decision Profile: [User Name]

<!-- Generated: {date} | Data: {date range from earliest to latest timestamp} -->
<!-- Sources: {N} memory files, {N} history prompts, {N} conversation exchanges, {N} configs -->
<!-- Decay parameters: stable λ=0.001, durable λ=0.005, situational λ=0.015 -->
<!-- Formula: effective_conf = conf × e^(-λ × days_since_confirmed), floor 20 -->
<!-- Regenerate with /profilera -->

## How to Use This Profile

This profile captures decision-making patterns extracted from {N} months of Claude Code
sessions across {N} projects. Each entry carries inline metadata:

`━ conf:75 | perm:durable | first:2026-01-15 | confirmed:2026-03-28 | challenged:—`

- **conf** (0-100): Evidence-based confidence. 90+ shipped consistently, 70-89
  established, 50-69 emerging, 30-49 single signal, 0-29 speculative.
  Line weight tokens: `━` high (90-100), `─` medium (50-89), `┄` low (0-49).
- **perm**: How stable the decision domain is. stable (decade), durable (year),
  situational (month).
- **first/confirmed/challenged**: When the decision was first observed, last confirmed,
  and last challenged.

When consuming this profile, compute effective confidence using the decay formula in the
header. Stale situational entries should carry less weight than fresh stable ones.

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
- ▸ **Why**: [The reasoning — what value or concern drives this]
- ▸ **Exceptions**: [Known cases where this was overridden, or "None observed"]

[Repeat for each decision in the category. Order by confidence (highest first).]

[Repeat for all 12 categories. Skip categories with no signal.]

## Tensions

Each entry records a contradiction or divergence found during profile generation or
challenged during validation. Default status is **unresolved** — resist the urge to
wrap tensions in resolution narratives. Some tensions are real and persistent.

### YYYY-MM-DD — [Short description]

**Decision affected**: [which decision was contradicted]
**What happened**: [what was observed or said that didn't fit]
**Status**: unresolved
```

#### Writing guidelines

- Write rules as imperatives, not descriptions ("Use X" not "[Name] prefers X")
- Be specific about conditions — "when building Go CLIs" not "when building things"
- Include the *why* even when it seems obvious — agents need reasoning to handle edge cases
- Don't duplicate what's already in CLAUDE.md — this profile covers decision *patterns*,
  not project-specific instructions
- Omit categories with fewer than 2 decisions — not enough signal to be useful
- Every entry MUST have the inline metadata line immediately after the ### heading

---

### Step 5: Validate predictions

Pick 5 decision-rich prompts from the extracted history that were NOT directly used to create
a profile entry. For each:

1. Read the prompt and its context
2. Predict what the profile would recommend
3. Check against what actually happened

Report the accuracy as a simple score (e.g., "4/5 predictions matched"). If accuracy is
below 3/5, identify which categories need more signal and note this in the profile's header.

---

## Validate Mode

A quick incremental check of the existing profile. Designed to take ~2 minutes.

### Step V1: Run smart selection

Run the effective profile script in validate mode to identify which entries are most worth
checking:

```bash
python3 -m scripts.effective_profile --validate
```

Run from the skill's root directory. The script outputs JSON with ~6 entries scored by:
- **Decay gap**: how much confidence was lost to dormancy decay
- **Staleness**: days since confirmation relative to permanence half-life
- **Tension history**: whether the entry has been challenged before
- **Extremity**: how far from center (very high or very low confidence)

Read the output. If the script fails (PROFILE.md missing or has no metadata), fall back to
Full mode and inform the user.

### Step V2: Present entries for validation

Present entries one at a time to the user. For each entry, show:
- The decision name
- The current rule text
- The reason this entry was surfaced (from the script's `reason` field)
- The stored confidence and effective confidence after decay

Ask the user to: **Confirm**, **Challenge**, or **Skip**.

### Step V3: Apply updates

For each response:

- **Confirm**: Bump `conf` by 5 (cap at 95). Update `confirmed` to today's date.
- **Challenge**: Soften `conf` by 10 (floor at 10). Update `challenged` to today's date.
  Append a tension entry to the `## Tensions` section:
  ```
  ### {today} — {decision name} challenged during validation
  **Decision affected**: {decision name}
  **What happened**: Challenged by user during validation
  **Status**: unresolved
  ```
- **Skip**: No changes to this entry.

### Step V4: Write and report

Write the updated PROFILE.md with all metadata changes applied. Report a summary:

> Validated {N} entries: {N} confirmed, {N} challenged, {N} skipped.

If any entries were challenged, mention them by name so the user knows what shifted.

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

- **complete** — PROFILE.md was written (Full mode) or updated (Validate mode) with all metadata changes applied, prediction accuracy was verified (Full mode), and a summary of what changed was reported.
- **flagged** — Profile generation or validation completed but with data quality issues: extraction failed for one or more sources, prediction accuracy was below 3/5, or significant tensions were found that could not be resolved from available evidence.
- **stuck** — Cannot generate or validate a profile because the extraction scripts failed entirely, Python is unavailable, or `~/.claude/` is unreadable and no session data can be accessed.
- **waiting** — The user chose Validate mode but PROFILE.md does not exist or has no valid metadata, requiring a Full mode run that the user has not confirmed; or the user's intent between Full and Validate is genuinely ambiguous.

---

## Cross-skill integration

Profilera is part of a ten-skill ecosystem. The decision profile it produces is consumed by
the other skills.

### Consumed by /realisera
Realisera runs the effective profile script in its Orient step to get a confidence-weighted
summary table. High effective confidence entries are treated as strong constraints; low
effective confidence entries are treated as suggestions. Full rules are read from PROFILE.md
when needed for detailed reasoning.

### Consumed by /optimera
Optimera runs the effective profile script to calibrate experimentation style — how aggressive
to be, how much complexity is acceptable, what trade-offs the user prefers. Effective
confidence weighting ensures stale preferences don't over-constrain experiments.

### Consumed by /inspirera
Inspirera can run the effective profile script to inform applicability judgments — what
patterns the user favors, what they resist, how to weigh recommendations. High-confidence
entries strongly constrain recommendations; low-confidence entries are treated as tendencies.

### Consumed by /resonera
Resonera reads the decision profile at the start of every deliberation. High-confidence entries
in the relevant domain are acknowledged upfront to prevent re-deliberating settled preferences.
Low-confidence entries are surfaced as hypotheses worth testing during the conversation.

### Fed by /resonera
DECISIONS.md (maintained by resonera) is a high-signal source for profilera's extraction
scripts. Each decision entry captures reasoning, tradeoffs, and confidence — making deliberation
sessions one of the richest inputs for decision profile generation.

### Consumed by /inspektera
Inspektera reads the decision profile to calibrate what "healthy" means for this user.
Quality preferences, complexity tolerance, and pattern priorities from the profile weight
the grading and determine which findings matter most.

### Profilera is consumed by /planera
Planera reads the decision profile during its Orient step to calibrate planning depth,
pattern preferences, and constraint priorities.

### Effective profile script

All consuming skills use the same script for consistency:

```bash
python3 -m scripts.effective_profile
```

Run from the profilera skill directory. Outputs a markdown summary table with effective
confidence after dormancy decay. The script reads decay parameters from the PROFILE.md
header, so the formula stays in one place.

---

## Getting started

### First profile generation
```
/profilera
```
Runs full extraction across session history, memory, configs, and conversations. Takes a few
minutes. Produces `~/.claude/profile/PROFILE.md`.

### Regular validation
```
/profilera validate
```
Quick refresh that checks for new evidence and updates confidence scores without full
regeneration. Run weekly or per-session.

### Using the profile in other skills
All skills read the profile automatically via `python3 -m scripts.effective_profile`. No
manual steps needed — just ensure PROFILE.md exists.

---

## Notes on depth vs speed

- The extraction scripts handle the expensive I/O. Claude's job is synthesis, not parsing.
- If the intermediate files are very large, use subagents (Explore type) to read different
  files in parallel and report back summaries.
- The crystallized.json file (memory + CLAUDE.md) is the highest-signal source. Start there
  and use other sources to corroborate and enrich.
- Conversation exchanges are the most nuanced source — they show *how* decisions are made
  in real time, not just what was decided.
- Config patterns are the most objective source — they show what was actually shipped.
- Validate mode is designed for regular use (weekly or per-session). Full mode is for
  periodic regeneration (monthly or when the profile feels significantly stale).
