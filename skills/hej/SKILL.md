---
name: hej
description: >
  HEJ (Holistic Entry Junction, Orient, Route, Activate). ALWAYS use this skill as the single point of entry to the agentera suite. This skill is REQUIRED whenever the user starts a session, returns to a project, or needs orientation on what to do next. It detects whether the project is fresh (no state artifacts) or returning (existing artifacts), delivers a situational briefing, and routes to the appropriate skill. Do NOT skip this skill when the user greets you or asks for project status. It contains the critical workflow for suite-aware orientation that prevents disoriented sessions. Trigger on: "hej", "hello",
  "hi", "start", "begin", "where were we", "catch me up", "what should I work on",
  "what's next", "status", "dashboard", "pulse", "brief me", "update me",
  "onboard me", "getting started", "what needs attention", any greeting at session
  start, any request for project status or orientation.
spec_sections: [1, 2, 4, 5, 13, 19]
---

# HEJ

**Holistic Entry Junction. Orient, Route, Activate**

Single entry point to the agentera suite. Detects fresh vs returning, delivers a situational briefing, routes to the right skill. Same on first install and 100th session.

Each invocation = one orientation. Reads everything, writes nothing.

---

## State artifacts

No artifacts of its own. Reads all suite artifacts for the briefing:

| Artifact | Read for |
|----------|----------|
| `VISION.md` | Project direction, north star |
| `DECISIONS.md` | Pending and recent decisions |
| `PLAN.md` | Active tasks, completion status |
| `PROGRESS.md` | Recent cycles, what shipped |
| `TODO.md` | Open problems by severity |
| `HEALTH.md` | Codebase health grades and trends |
| `OBJECTIVE.md` | Optimization target and current value |
| `EXPERIMENTS.md` | Experiment status |
| `DOCS.md` | Documentation coverage and artifact paths |
| `DESIGN.md` | Visual identity status |
| `PROFILE.md` | Decision profile (global: `$PROFILERA_PROFILE_DIR/PROFILE.md`, default: `$XDG_DATA_HOME/agentera/PROFILE.md`) <!-- platform: profile-path --> |

### Artifact path resolution

Before reading any artifact, check if .agentera/DOCS.md exists. If it has an Artifact Mapping section, use the path specified for each canonical filename. If .agentera/DOCS.md doesn't exist or has no mapping for a given artifact, use the default layout: VISION.md, TODO.md, and CHANGELOG.md at the project root; all other artifacts in .agentera/. This applies to all artifact reads in this skill.

Note: PROFILE.md is global, not project-scoped. Its path is determined by profilera: `$PROFILERA_PROFILE_DIR/PROFILE.md` (default: `$XDG_DATA_HOME/agentera/PROFILE.md`). <!-- platform: profile-path --> Check the profilera-determined path directly rather than falling back to the project root.

### Contract

Contract values used in this skill are inlined where referenced: severity arrows `⇶/⇉/→/⇢`, trend arrows `⮉/⮋`, skill glyphs `⛥ ❈ ⬚ ≡ ⧉ ⎘ ⛶ ▤ ♾ ◰ ⎈ ⌂` (last one is hej's own glyph, used in the exit marker), and the plan-relative staleness heuristic (fall back to PROGRESS.md recency when no plan context exists). No upfront file read is required.

`references/contract.md` remains available as a full-spec reference: consult it for ambiguous cases, explicit cross-checking against SPEC.md, or when you suspect drift between these inlined values and the canonical spec.

---

## Step 0: Detect mode

Check for suite state artifacts (respecting path resolution).

- **No artifacts found** → Step 1a (first time on this project)
- **Artifacts found** → Step 1b (returning to known project)

Narration voice (riff, don't script):
✗ "Fresh mode: scanning codebase."
✓ "New project. Taking a look around..." · "First time here. Let me see what we've got..."

✗ "Returning mode: reading artifacts for your briefing."
✓ "Pulling up the latest..." · "Checking in on the project..." · "Let me see where things stand..."

---

## Step 1a: Welcome

First impression: the colleague meets a new project.

1. **Quick scan**: language(s), framework(s), README.md, last 5 commits, approximate size.
   Fast, no deep analysis.

2. **Share what's available**: lead with the 2-3 skills most relevant to what the
   scan revealed. Don't enumerate all eleven unless asked. Mention the rest exist and offer the full table on request. The table below is a reference, not a script:

   | | If you want to... | Use |
   |---|---------------------|-----|
   | ⛥ | Define project direction | `/visionera` |
   | ❈ | Think through a decision | `/resonera` |
   | ⬚ | Research an external resource | `/inspirera` |
   | ≡ | Plan work with acceptance criteria | `/planera` |
   | ⧉ | Build autonomously | `/realisera` |
   | ⎘ | Optimize a metric | `/optimera` |
   | ⛶ | Audit codebase health | `/inspektera` |
   | ▤ | Create or maintain docs | `/dokumentera` |
   | ♾ | Build a decision profile | `/profilera` |
   | ◰ | Define visual identity | `/visualisera` |
   | ⎈ | Orchestrate multi-cycle plan execution | `/orkestrera` |

3. **Give your honest take**: based on the scan, tell the user where you'd start
   and why. "If I were you, I'd start with X because Y." Use the same routing logic (no vision → `/visionera`, unknown quality → `/inspektera`, decision needed → `/resonera`, ready to build + has plan → `/orkestrera`, ready to build → `/realisera`, docs gaps → `/dokumentera`) but frame it as judgment, not a lookup table.

4. **Route**: ask what they'd like to do. Invoke the chosen skill.

---

## Step 1b: Briefing

Show where things stand.

1. **Read artifacts**: VISION.md, PROGRESS.md, TODO.md, HEALTH.md, PLAN.md, DECISIONS.md
   - Read in parallel. First 20 lines each. Skip absent ones.
   - Extract the most recent entry or summary.
   - If TODO.md, PLAN.md, OBJECTIVE.md, or DECISIONS.md hints at active work, keep reading.
   - For optimera status, inspect `.agentera/optimera/<name>/` directories directly. Classify closed objectives first when the OBJECTIVE.md status line starts with `**Status**: closed`, including legacy prose such as `**Status**: closed (date)`. Exclude closed objectives before recency checks; if every objective is closed, report no active objective and do not route to `/optimera` for completed work.
   - When multiple non-closed objectives exist, use EXPERIMENTS.md git recency only among those non-closed objectives. A closed objective with newer history must not outrank an older active objective.
   - Identify the first concrete open item or current plan task before routing.
   - Do not route from a heading or summary alone when an executable follow-up exists nearby.

2. **Brief them**: concise status, only what exists. No empty sections.
   Show the agentera logo.

   ```
   ┌─┐┌─┐┌─┐┌┐┌┌┬┐┌─┐┬─┐┌─┐
   ├─┤│ ┬├┤ │││ │ ├┤ ├┬┘├─┤
   ┴ ┴└─┘└─┘┘└┘ ┴ └─┘┴└─┴ ┴

   [1-2 sentence conversational opener: the colleague's read on
   the situation. What shipped, what's moving, what needs eyes.
   Interpretation, not metrics.]

   ─── status ─────────────────────────────

     ⛶ health    [⮉|⮋] [grade] ([worst dimension: grade])
     ⇶ issues    N critical · M degraded · K normal · J annoying
     ≡ plan      [██████▓▓░░] N/M tasks
     ⎘ optim     [metric] [current] → [target]
     ♾ profile   [loaded | not found]

   ─── attention ──────────────────────────

     ⇶ [critical items, triple arrow for critical]
     ⇉ [degraded items, double arrow for degraded]
     → [normal items, single arrow for normal]
     ⇢ [annoying items, dashed arrow for annoying]

   ─── next ───────────────────────────────

     suggested → [glyph] /[skill] ([reason])
   ```

   Output constraint: ≤120 words total briefing, ≤15 words per routing suggestion.

   **Exit marker**: after the closing code fence of the dashboard, emit `⌂ hej · <status>` on its own line, followed by a one-sentence summary of what you delivered. For `waiting`, `flagged`, or `stuck`, add a `▸` bullet below the summary identifying what the user needs to decide or act on next. The exit marker is mandatory on every invocation regardless of mode (fresh welcome or returning briefing).

   **Formatting rules**:
   - Each status line uses the skill glyph that owns that data
   - Severity arrows (⇶/⇉/⇢) mark attention items by urgency
   - Trend arrows (⮉/⮋) show health trajectory
   - Progress bars (█▓░) show plan completion visually
   - The inline separator (·) joins counts on a single line
   - The conversational opener precedes the status section. It's the colleague's interpretation; the dashboard below is the evidence
   - Omit any line whose source artifact is missing
   - Omit any section that would be empty (e.g., no attention items = no attention section)

3. **Attention items**: priority order with severity arrows:
   - ⇶ Critical issues, degrading health dimensions
   - ⇉ Blocked/overdue plan tasks, stale artifacts (plan-relative per contract staleness detection; fall back to PROGRESS.md recency heuristic when no plan context exists), loop guard triggers
   - → Standard work: features, improvements, routine tasks
   - ⇢ Unresolved exploratory decisions

   Nothing? Say so. A clean bill of health is useful.

4. **Select the concrete next action before selecting the skill**.
   - The routing suggestion MUST name the artifact item it would act on.
   - Valid objects: `PLAN Task N: <title>`, `TODO: <item>`, `DECISION N follow-up`, `OBJECTIVE: <metric>`, or `VISION refresh`.
   - A skill name without a concrete object is not a valid suggestion.

   Priority order:
   - Active PLAN with pending tasks → suggest ⎈ `/orkestrera` for the first unblocked pending task.
   - Critical or degrading health → suggest ⛶ `/inspektera` or ⧉ `/realisera` for the named finding.
   - Active non-closed OBJECTIVE with stalled or missing metric evidence → suggest ⎘ `/optimera` for that metric.
   - TODO.md open items → suggest ⧉ `/realisera` for the highest-severity open item; prefer items that unlock product evidence or future plans.
   - Pending DECISIONS.md follow-up → suggest ❈ `/resonera` for the named unresolved decision.
   - Vision exists but no plan, objective, decision follow-up, or TODO work is active → suggest ≡ `/planera`.
   - Healthy, no executable follow-ups, and the plan is complete → suggest ⛥ `/visionera` to choose a new direction.

   Do not let `healthy + plan complete → ⛥` override active TODO, OBJECTIVE, DECISIONS, or a newer active PLAN. A completed plan means "look for the next executable follow-up," not automatically "refresh vision."

5. **Route**: present one concrete suggestion and let the user choose. No coercion.
   - Do not list generic skill options unless the user asks for the full menu.
   - The waiting bullet should ask whether to run the named action, not ask the user to pick from skills.

---

## Step 2: Route

Narration voice (riff, don't script):
✗ "Starting /[skill]..."
✓ "Kicking off [skill]..." · "Handing off to [skill]..." · "Over to [skill]."

Invoke the skill. Hej's work is done.

Unclear mapping? Ask **one** clarifying question. No compound questions.

---

## Safety rails

<critical>
- NEVER execute implementation work. Hej orients and routes; it does not build, audit, plan, or decide.
- NEVER dump full artifact contents verbatim. Summarize concisely; the user can read the files themselves.
- NEVER skip the briefing in returning mode. The user needs context before choosing a direction.
- NEVER assume what the user wants without asking. Present the suggestion, then wait for confirmation.
- NEVER modify any state artifact. Hej is strictly read-only.
- NEVER route to a skill without the user's consent. Suggest, don't force.
</critical>

---

## Exit signals

Report one of these statuses at workflow completion.

Format: emit `⌂ hej · <status>` on its own line below the dashboard's closing code fence, followed by a one-sentence summary of what was delivered. For `flagged`, `stuck`, and `waiting`, add a `▸` bullet below the summary identifying what the user needs to decide or act on next. The exit marker is mandatory and uses hej's canonical glyph `⌂` (Unicode U+1F794).

- **complete**: Briefing delivered (or welcome shown) and user successfully routed to a skill.
- **flagged**: Briefing delivered but critical attention items were found: critical issues, degrading health, loop guard triggers. Each concern is listed explicitly.
- **stuck**: Cannot orient: the working directory is not a code project, no readable files exist, or permissions prevent scanning.
- **waiting**: Briefing or welcome delivered, suggestion made, awaiting user input on which direction to take.

---

## Cross-skill integration

Hej is the entry point to a twelve-skill suite. It reads artifacts from the other eleven workflow skills but produces no artifacts of its own and no downstream skill depends on it.

**Reads from all eleven skills**:

- **visionera** → VISION.md for project direction and north star
- **resonera** → DECISIONS.md for pending and recent decisions
- **planera** → PLAN.md for active task status and completion
- **realisera** → PROGRESS.md for recent cycle history and what shipped
- **inspektera** → HEALTH.md for codebase health grades and trends
- **optimera** → OBJECTIVE.md and EXPERIMENTS.md for optimization status
- **dokumentera** → DOCS.md for artifact path resolution and documentation coverage
- **visualisera** → DESIGN.md for visual identity status
- **profilera** → PROFILE.md for decision profile context
- **inspirera** → no direct artifact, but routes to it when research is needed
- **orkestrera** → no direct artifact, but hej routes to it for orchestrated multi-cycle plan execution

Hej's unique role: it is the only skill that reads from every other skill's output. It does not feed into any downstream skill. Its output is the ephemeral briefing and the routing decision.

---

## Getting started

```
/hej                        # Start here, always
"what should I work on"     # Natural language works too
"catch me up"               # Returning to a project
"what needs attention"      # Quick status check
```
