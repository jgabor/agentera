---
name: hej
description: >
  HEJ — Holistic Entry Junction — Orient, Route, Activate. ALWAYS use this skill
  as the single point of entry to the agentera ecosystem. This skill is REQUIRED
  whenever the user starts a session, returns to a project, or needs orientation
  on what to do next. It detects whether the project is fresh (no state artifacts)
  or returning (existing artifacts), delivers a situational briefing, and routes
  to the appropriate skill. Do NOT skip this skill when the user greets you or asks
  for project status — it contains the critical workflow for ecosystem-aware
  orientation that prevents disoriented sessions. Trigger on: "hej", "hello",
  "hi", "start", "begin", "where were we", "catch me up", "what should I work on",
  "what's next", "status", "dashboard", "pulse", "brief me", "update me",
  "onboard me", "getting started", "what needs attention", any greeting at session
  start, any request for project status or orientation.
---

# HEJ

**Holistic Entry Junction — Orient, Route, Activate**

The single point of entry to the agentera ecosystem. Detects whether a project is
fresh or returning, delivers a situational briefing, and routes to the appropriate
skill. Works the same on first install and on the 100th session.

Each invocation = one orientation. No artifacts produced — hej reads everything,
writes nothing.

---

## State artifacts

Hej maintains no artifacts of its own. It reads all ecosystem artifacts to build
its briefing:

| Artifact | Read for |
|----------|----------|
| `VISION.md` | Project direction, north star |
| `DECISIONS.md` | Pending and recent decisions |
| `PLAN.md` | Active tasks, completion status |
| `PROGRESS.md` | Recent cycles, what shipped |
| `ISSUES.md` | Open problems by severity |
| `HEALTH.md` | Codebase health grades and trends |
| `OBJECTIVE.md` | Optimization target and current value |
| `EXPERIMENTS.md` | Experiment status |
| `DOCS.md` | Documentation coverage and artifact paths |
| `DESIGN.md` | Visual identity status |
| `PROFILE.md` | Decision profile (global: `~/.claude/profile/PROFILE.md`) |

### Artifact path resolution

Before reading any artifact, check if DOCS.md exists in the project root. If it
has an Artifact Mapping section, use the path specified for each canonical filename.
If DOCS.md doesn't exist or has no entry for a given artifact, default to the
project root. This applies to all artifact reads in this skill.

Note: PROFILE.md is global, not project-scoped. Its path is always
`~/.claude/profile/PROFILE.md` regardless of DOCS.md presence. Check this path
directly rather than falling back to the project root.

---

## Step 0: Detect mode

Check for the existence of ecosystem state artifacts in the project (respecting
artifact path resolution). Count how many exist.

- **Fresh** (0 artifacts found): The ecosystem has never been used here.
  Proceed to Step 1a.
- **Returning** (1+ artifacts found): The project has ecosystem history.
  Proceed to Step 1b.

---

## Step 1a: Welcome (Fresh mode)

The user is new to this project's ecosystem. Orient them.

1. **Quick project scan** — identify language(s), framework(s), README presence,
   git log (last 5 commits), approximate size (file count, line count). Keep this
   fast — no deep analysis.

2. **Present capabilities** — show the user what the ecosystem can do for them,
   grouped by intent:

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

3. **Suggest a starting point** based on what the project scan revealed:
   - No direction or vision → `/visionera`
   - Has code but quality is unknown → `/inspektera`
   - Has a specific decision to make → `/resonera`
   - Ready to start building → `/realisera`
   - Has a README but no other docs → `/dokumentera`

   Frame the suggestion as a recommendation, not a directive.

4. **Route**: ask the user what they'd like to do. When they choose, invoke the
   skill.

---

## Step 1b: Briefing (Returning mode)

The user is returning. Show them where things stand.

1. **Read all existing artifacts** — Read VISION.md, PROGRESS.md, ISSUES.md, HEALTH.md,
   PLAN.md, and DECISIONS.md in parallel — these reads are independent, issue all in a single
   response. Read first 20 lines of each artifact for orientation. Skip any that don't exist.
   Extract only the most recent entry or top-level summary from each.

2. **Build the dashboard** — a concise status display covering only what exists.
   Omit any line whose source artifact is missing. Never show empty sections.
   Show the agentera logo at the top — this is a key moment.

   ```
   ┌─┐┌─┐┌─┐┌┐┌┌┬┐┌─┐┬─┐┌─┐
   ├─┤│ ┬├┤ │││ │ ├┤ ├┬┘├─┤
   ┴ ┴└─┘└─┘┘└┘ ┴ └─┘┴└─┴ ┴

   ─── status ─────────────────────────────

     ⛶ health    [⮉|⮋] [grade] ([worst dimension: grade])
     ⇶ issues    N critical · M degraded · K annoying
     ≡ plan      [██████▓▓░░] N/M tasks
     ⎘ optim     [metric] [current] → [target]
     ♾ profile   [loaded | not found]

     [1-2 sentence narrative: what shipped recently,
     what the current trajectory looks like]

   ─── attention ──────────────────────────

     ⇶ [critical items — triple arrow for critical]
     ⇉ [degraded items — double arrow for degraded]
     ⇢ [annoying items — dashed arrow for annoying]

   ─── next ───────────────────────────────

     suggested → [glyph] /[skill] ([reason])
   ```

   Output constraint: ≤100 words total briefing, ≤15 words per routing suggestion.

   **Formatting rules**:
   - Each status line uses the skill glyph that owns that data
   - Severity arrows (⇶/⇉/⇢) mark attention items by urgency
   - Trend arrows (⮉/⮋) show health trajectory
   - Progress bars (█▓░) show plan completion visually
   - The inline separator (·) joins counts on a single line
   - The narrative summary closes the status section (not opens it)
   - Omit any line whose source artifact is missing
   - Omit any section that would be empty (e.g., no attention items = no attention section)

3. **Flag attention items** — the attention section highlights anything that needs
   action, in priority order. Use severity arrows to mark urgency:
   - ⇶ Critical issues in ISSUES.md
   - ⇶ Degrading health dimensions in HEALTH.md (grade drop between audits)
   - ⇉ Plan tasks that are blocked or overdue
   - ⇉ Stale artifacts (last modified >14 days ago — check via `git log -1` on
     each artifact file, or file modification time)
   - ⇉ Loop guard triggers (3+ consecutive failed cycles in PROGRESS.md)
   - ⇢ Unresolved decisions in DECISIONS.md marked exploratory

   If nothing needs attention, say so. A clean bill of health is useful information.

4. **Suggest next action** — based on the attention flags and overall project
   state, recommend one skill. Use the target skill's glyph in the suggestion:
   - Critical issues exist → ⧉ `/realisera` (to fix) or ⛶ `/inspektera` (to investigate)
   - Stale or missing vision → ⛥ `/visionera`
   - Has vision but no plan → ≡ `/planera`
   - Health degrading → ⛶ `/inspektera`
   - Active optimization stalled → ⎘ `/optimera`
   - Everything healthy, plan has open tasks → ⧉ `/realisera`
   - Everything healthy, plan complete → ⛥ `/visionera` to chart next direction

5. **Route**: present the suggestion and let the user choose. When they decide,
   invoke the skill. If they want to keep talking without invoking a skill, that's
   fine too — hej's job is orientation, not coercion.

---

## Step 2: Route

When the user indicates what they want to do (or accepts the suggestion):

1. Confirm: "Starting /[skill]..."
2. Invoke the skill. Hej's work is done.

If the user's request doesn't map cleanly to a single skill, ask **one** clarifying
question. Do not ask compound questions. Do not suggest multiple skills at once
unless the user explicitly asks for options.

---

## Safety rails

<critical>
- NEVER execute implementation work. Hej orients and routes — it does not build, audit, plan, or decide.
- NEVER dump full artifact contents verbatim. Summarize concisely — the user can read the files themselves.
- NEVER skip the briefing in returning mode. The user needs context before choosing a direction.
- NEVER assume what the user wants without asking. Present the suggestion, then wait for confirmation.
- NEVER modify any state artifact. Hej is strictly read-only.
- NEVER route to a skill without the user's consent. Suggest, don't force.
</critical>

---

## Exit signals

- **complete**: Briefing delivered (or welcome shown) and user successfully routed to a skill.
- **flagged**: Briefing delivered but critical attention items were found — critical issues, degrading health, loop guard triggers. Each concern is listed explicitly.
- **stuck**: Cannot orient — the working directory is not a code project, no readable files exist, or permissions prevent scanning.
- **waiting**: Briefing or welcome delivered, suggestion made, awaiting user input on which direction to take.

---

## Cross-skill integration

Hej is the entry point to an eleven-skill ecosystem. It reads artifacts from the other ten
workflow skills but produces no artifacts of its own and no downstream skill
depends on it.

**Reads from all ten skills**:
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

Hej's unique role: it is the only skill that reads from every other skill's output.
It does not feed into any downstream skill — its output is the ephemeral briefing
and the routing decision.

---

## Getting started

```
/hej                        # Start here — always
"what should I work on"     # Natural language works too
"catch me up"               # Returning to a project
"what needs attention"      # Quick status check
```
