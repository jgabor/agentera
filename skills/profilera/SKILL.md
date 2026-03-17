---
name: profilera
description: >
  PROFILERA -- PROFILing Extracted Reasoning and Attitudes. Mines Claude Code session
  history, memory files, project configs, and conversation data to generate an
  agent-consumable decision profile. This skill should be used when the user says
  "build decision profile", "generate decision profile", "update my profile",
  "refresh my decision profile", "rebuild my profile", "regenerate profile",
  "what would I decide", "analyze my decisions", "mine my sessions",
  "decision patterns", "review my decision history", or "/profilera". Also applies when
  the user wants to understand their own decision-making patterns across sessions, asks
  someone else to predict their decisions, or wants a document that captures how they think.
---

# PROFILERA

**PROFILing Extracted Reasoning and Attitudes**

Mine the user's Claude Code session history and produce a structured decision profile that an
AI agent could use to predict "What would this person decide in a given situation?"

---

## Step 1: Run extraction

Run the Python extraction scripts to gather raw decision signals from all data sources. The
scripts handle the heavy JSONL parsing and output structured JSON that fits in context.

```bash
python -m scripts.extract_all --output-dir ~/.claude/profile/intermediate
```

The script auto-detects its own location and resolves paths from there. Run it from the
skill's root directory (the directory containing this SKILL.md file), typically at
`~/.claude/plugins/marketplaces/agent-skills/skills/profilera`.

After the scripts finish, read `~/.claude/profile/intermediate/extraction_summary.json` to
confirm the extraction counts. Report the summary to the user.

**If extraction fails**: Report the error to the user. Common causes:
- Python not found: try `python3` instead of `python`
- Permission errors: check that `~/.claude/` is readable
- Empty output: the user may have no session history yet -- report this and skip to Step 4
  with whatever data is available
If only some extractors fail, proceed with partial data and note which sources are missing.

---

## Step 2: Read extracted data

Read all four intermediate JSON files:

1. `~/.claude/profile/intermediate/crystallized.json` -- Memory files, CLAUDE.md, AGENTS.md
2. `~/.claude/profile/intermediate/history_decisions.json` -- Decision-rich prompts from history
3. `~/.claude/profile/intermediate/conversation_decisions.json` -- Decision exchanges from conversations
4. `~/.claude/profile/intermediate/project_configs.json` -- Recurring config patterns

These files are pre-filtered and structured. Read them all before proceeding to synthesis.

If any file is very large (> 500 entries), focus on the highest-signal entries first:
- For history: prioritize "correction" and "decision" signal types over "question"
- For conversations: prioritize entries with longer user responses (more reasoning visible)
- For configs: look for patterns that appear across multiple projects

---

## Step 3: Categorize and synthesize

Group all extracted signals into these 12 categories:

1. **Architecture & Design Patterns** -- How software is structured (package layout, abstraction
   boundaries, API design, data flow patterns)
2. **Technology & Tooling Selection** -- What gets picked and why (languages, frameworks,
   libraries, build tools, linters)
3. **Agent & Automation Philosophy** -- How AI agents should behave, what autonomy they get,
   interaction patterns
4. **Code Quality & Standards** -- What "good code" means (error handling, testing, validation,
   naming, formatting)
5. **DX & Project Structure** -- How projects should feel to work in (directory layout, build
   targets, configuration, documentation)
6. **Scoping & Prioritization** -- How to decide what to build, version milestones, feature
   gating, complexity budgets
7. **Communication Style** -- Writing preferences, documentation voice, how things should read
8. **Process & Workflow** -- Git workflow, commit conventions, PR practices, release process
9. **UI/UX Preferences** -- Visual patterns, interaction design, CLI vs TUI vs web preferences
10. **Trade-off Heuristics** -- How competing concerns are resolved (simplicity vs flexibility,
    speed vs correctness, convention vs configuration)
11. **Anti-patterns & Rejections** -- Things actively avoided, with reasoning
12. **Meta-decision Style** -- How decisions are made (frameworks used, information gathering
    patterns, when to decide vs defer)

For each category:

- Identify distinct decisions (not just preferences -- decisions have conditions and reasoning)
- Look for the *why* behind each decision, not just the *what*
- Note exceptions or cases where the usual rule was overridden
- Assign confidence based on consistency:
  - **high**: Appears across multiple projects/sessions with no contradictions
  - **medium**: Clear pattern but limited to a few contexts, or with minor variations
  - **low**: Single instance or inferred from indirect evidence

Cross-category patterns are especially valuable. Look for meta-principles that explain
decisions across multiple categories (e.g., "convention over configuration" might explain
both tooling choices and project structure decisions).

---

## Step 4: Generate the profile

Write the decision profile to `~/.claude/profile/PROFILE.md`.

If a previous version exists:
1. Copy it to `~/.claude/profile/history/DECISION_PROFILE-{timestamp}.md`
2. Generate the new version
3. Show a summary of what changed (new decisions added, decisions updated, decisions removed)

### Profile format

```markdown
# Decision Profile: [User Name]

<!-- Generated: {date} | Data: {date range from earliest to latest timestamp} -->
<!-- Sources: {N} memory files, {N} history prompts, {N} conversation exchanges, {N} configs -->
<!-- Regenerate with /profilera -->

## How to Use This Profile

This profile captures decision-making patterns extracted from {N} months of Claude Code
sessions across {N} projects. Each entry is written as an imperative rule that an agent
can follow directly.

**Confidence levels**: high = consistent across projects/time, medium = clear but limited
context, low = inferred or single-instance.

**When the profile is silent**: If a situation isn't covered, look for the closest trade-off
heuristic or meta-decision pattern. When truly uncertain, ask.

## Decision-Making Style

[2-3 paragraphs describing the meta-patterns: how this person approaches decisions, what
frameworks they use, their risk posture, when they decide quickly vs deliberate, what
information they seek before deciding]

## [Category Name]

### [Decision Name]
- **Rule**: [Imperative statement an agent can follow directly]
- **When**: [Specific conditions or triggers for this rule]
- **Why**: [The reasoning -- what value or concern drives this]
- **Exceptions**: [Known cases where this was overridden, or "None observed"]
- **Confidence**: high|medium|low

[Repeat for each decision in the category. Order by confidence (high first).]

[Repeat for all 12 categories. Skip categories with no signal.]
```

### Writing guidelines

- Write rules as imperatives, not descriptions ("Use X" not "[Name] prefers X")
- Be specific about conditions -- "when building Go CLIs" not "when building things"
- Include the *why* even when it seems obvious -- agents need reasoning to handle edge cases
- Don't duplicate what's already in CLAUDE.md -- this profile covers decision *patterns*,
  not project-specific instructions
- Omit categories with fewer than 2 decisions -- not enough signal to be useful

---

## Step 5: Validate

Pick 5 decision-rich prompts from the extracted history that were NOT directly used to create
a profile entry. For each:

1. Read the prompt and its context
2. Predict what the profile would recommend
3. Check against what actually happened

Report the accuracy as a simple score (e.g., "4/5 predictions matched"). If accuracy is
below 3/5, identify which categories need more signal and note this in the profile's header.

---

## Notes on depth vs speed

- The extraction scripts handle the expensive I/O. Claude's job is synthesis, not parsing.
- If the intermediate files are very large, use subagents (Explore type) to read different
  files in parallel and report back summaries.
- The crystallized.json file (memory + CLAUDE.md) is the highest-signal source. Start there
  and use other sources to corroborate and enrich.
- Conversation exchanges are the most nuanced source -- they show *how* decisions are made
  in real time, not just what was decided.
- Config patterns are the most objective source -- they show what was actually shipped.
