# HEJ

**Holistic Entry Junction. Orient, Route, Activate**

Single entry point to the agentera suite. Detects fresh vs returning, delivers a situational briefing, routes to the right capability. Same on first install and 100th session.

Each invocation = one orientation. Reads everything, writes nothing.

---

## Visual identity

Glyph: **⌂** (protocol ref: SG1). Used in the mandatory exit marker.

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
| `PROFILE.md` | Decision profile (global: `$PROFILERA_PROFILE_DIR/PROFILE.md`, default: `$XDG_DATA_HOME/agentera/PROFILE.md`) |

### Artifact path resolution

Before reading any artifact, check if `.agentera/docs.yaml` exists. If it has an Artifact Mapping section, use the path specified for each canonical filename. If `.agentera/docs.yaml` doesn't exist or has no mapping for a given artifact, use the default layout:

- Human-facing artifacts at the project root (Markdown): `TODO.md`, `CHANGELOG.md`, `DESIGN.md`
- Agent-facing artifacts in `.agentera/` (YAML): `progress.yaml`, `decisions.yaml`, `health.yaml`, `plan.yaml`, `docs.yaml`, `vision.yaml`, `session.yaml`, and per-objective `objective.yaml` / `experiments.yaml`

The canonical names in the State Artifacts table below are identifiers, not literal paths. The resolved path for an agent-facing artifact is its `.yaml` file in `.agentera/` unless docs.yaml specifies otherwise.

PROFILE.md is global, not project-scoped. Its path is determined by profilera: `$PROFILERA_PROFILE_DIR/PROFILE.md` (default: `$XDG_DATA_HOME/agentera/PROFILE.md`). Check the profilera-determined path directly rather than falling back to the project root.

### Contract values

Contract values are inlined where referenced. Visual tokens from protocol: severity arrows VT5-VT8 (⇶/⇉/→/⇢), trend arrows VT12-VT13 (⮉/⮋), progress bar VT18 (█▓░), inline separator VT16 (·), list item VT15 (▸), section divider VT14, flow/target VT17 (→). Skill glyphs SG1-SG12 for the routing table and status lines. Exit signals EX1-EX4 for the exit marker. Severity issue levels SI1-SI4 for attention items.

`references/contract.md` (at the v2 skill location `skills/agentera/references/contract.md`) remains available as a full-spec reference for ambiguous cases or cross-checking.

---

## Step 0: Detect mode

Check for suite state artifacts (respecting path resolution).

- **No artifacts found** → Step 1a (first time on this project)
- **Artifacts found** → Step 1b (returning to known project)

Narration voice (riff, don't script):

- "New project. Taking a look around..." · "First time here. Let me see what we've got..."
- "Pulling up the latest..." · "Checking in on the project..." · "Let me see where things stand..."

---

## Step 0.5: Upgrade guard

After mode detection (Step 0) and before the welcome (Step 1a) or briefing (Step 1b), run two checks. Detection is passive by default; hej only runs an upgrade apply command after explicit user confirmation.

### V1 artifact detection

Check `.agentera/` for v1 Markdown artifacts that lack a corresponding v2 YAML counterpart. The v1→v2 mapping is:

| v1 (Markdown) | v2 (YAML) |
|----------------|-----------|
| `.agentera/PROGRESS.md` | `.agentera/progress.yaml` |
| `.agentera/PLAN.md` | `.agentera/plan.yaml` |
| `.agentera/DECISIONS.md` | `.agentera/decisions.yaml` |
| `.agentera/HEALTH.md` | `.agentera/health.yaml` |
| `.agentera/SESSION.md` | `.agentera/session.yaml` |
| `.agentera/DOCS.md` | `.agentera/docs.yaml` |
| `VISION.md` (project root) | `.agentera/vision.yaml` |

For each v1 file that exists where the corresponding v2 file does **not**:

- Add to the briefing's attention section as a degraded (SI2, ⇉) item:
  `⇉ v1 artifacts detected · preview \`uvx --from git+<https://github.com/jgabor/agentera> agentera upgrade --project "$PWD" --dry-run\``
- If the current project is a local Agentera checkout with `scripts/agentera`, the local equivalent is
  `uv run scripts/agentera upgrade --project "$PWD" --dry-run`.
- Include the notice once (not per-file); list the affected files after the command.
- Ask before applying. After confirmation, run the same command with `--yes`.
- This applies to both Step 1a (welcome) and Step 1b (briefing) flows.

If no v1 artifacts exist (fresh install or already migrated), emit no upgrade notice.

### PROFILE.md detection

Check `$PROFILERA_PROFILE_DIR/PROFILE.md` (default: `$XDG_DATA_HOME/agentera/PROFILE.md`) for the global decision profile.

- **PROFILE.md exists** → report `♾ profile   loaded` in the status line. No warning.
- **PROFILE.md absent** → report `♾ profile   not found` in the status line **and** add a degraded (SI2, ⇉) attention item:
  `⇉ PROFILE.md not found at global path · use profilera to generate your decision profile`

---

## Step 1a: Welcome

First impression: the colleague meets a new project.

1. **Quick scan**: language(s), framework(s), README.md, last 5 commits, approximate size.
   Fast, no deep analysis.

2. **Share what's available**: lead with the 2-3 skills most relevant to what the
   scan revealed. Don't enumerate all eleven unless asked. Mention the rest exist and offer the full table on request. The table below is a reference, not a script:

   | | If you want to... | Say |
   |---|---------------------|-----|
   | ⛥ (SG6) | Define project direction | "define the direction" |
   | ❈ (SG4) | Think through a decision | "help me decide" |
   | ⬚ (SG10) | Research an external resource | "research this pattern" |
   | ≡ (SG5) | Plan work with acceptance criteria | "plan this" |
   | ⧉ (SG2) | Build autonomously | "build the next feature" |
   | ⎘ (SG7) | Optimize a metric | "improve test coverage" |
   | ⛶ (SG3) | Audit codebase health | "audit the codebase" |
   | ▤ (SG8) | Create or maintain docs | "update docs" |
   | ♾ (SG9) | Build a decision profile | "build decision profile" |
   | ◰ (SG11) | Define visual identity | "design the visual identity" |
   | ⎈ (SG12) | Orchestrate multi-cycle plan execution | "run the plan" |

3. **Give your honest take**: based on the scan, tell the user where you'd start
    and why. "If I were you, I'd start with X because Y." Use the routing logic (no vision → visionera, unknown quality → inspektera, decision needed → resonera, ready to build + has plan → orkestrera, ready to build → realisera, docs gaps → dokumentera) but frame it as judgment, not a lookup table.

4. **Route**: ask what they'd like to do. Invoke the chosen capability.

---

## Step 1b: Briefing

Show where things stand.

1. **Read artifacts**: VISION.md, PROGRESS.md, TODO.md, HEALTH.md, PLAN.md, DECISIONS.md
   - Read in parallel. First 20 lines each. Skip absent ones.
   - Extract the most recent entry or summary.
   - If TODO.md, PLAN.md, OBJECTIVE.md, or DECISIONS.md hints at active work, keep reading.
   - For optimera status, inspect `.agentera/optimera/<name>/` directories directly. Classify closed objectives first when objective.yaml has `status: closed`; tolerate legacy prose such as `**Status**: closed (date)` only when reading migrated history. Exclude closed objectives before recency checks; if every objective is closed, report no active objective and do not route to optimera for completed work.
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
   - Severity arrows (VT5-VT8) mark attention items by urgency
   - Trend arrows (VT12/VT13) show health trajectory
   - Progress bars (VT18) show plan completion visually
   - The inline separator (VT16) joins counts on a single line
   - The conversational opener precedes the status section. It's the colleague's interpretation; the dashboard below is the evidence
   - Omit any line whose source artifact is missing
   - Omit any section that would be empty (e.g., no attention items = no attention section)

3. **Attention items**: priority order with severity arrows (SI1-SI4):
   - ⇶ (SI1) Critical issues, degrading health dimensions
   - ⇉ (SI2) Blocked/overdue plan tasks, stale artifacts (plan-relative per contract staleness detection; fall back to PROGRESS.md recency heuristic when no plan context exists), loop guard triggers
   - → (SI3) Standard work: features, improvements, routine tasks
   - ⇢ (SI4) Unresolved exploratory decisions

   Nothing? Say so. A clean bill of health is useful.

4. **Select the concrete next action before selecting the skill**.
   - The routing suggestion MUST name the artifact item it would act on.
   - Valid objects: `PLAN Task N: <title>`, `TODO: <item>`, `DECISION N follow-up`, `OBJECTIVE: <metric>`, or `VISION refresh`.
   - A skill name without a concrete object is not a valid suggestion.

    Priority order:
   - Active PLAN with pending tasks → suggest ⎈ (SG12) orkestrera for the first unblocked pending task.
   - Critical or degrading health → suggest ⛶ (SG3) inspektera or ⧉ (SG2) realisera for the named finding.
   - Active non-closed OBJECTIVE with stalled or missing metric evidence → suggest ⎘ (SG7) optimera for that metric.
   - TODO.md open items → suggest ⧉ (SG2) realisera for the highest-severity open item; prefer items that unlock product evidence or future plans.
   - Pending DECISIONS.md follow-up → suggest ❈ (SG4) resonera for the named unresolved decision.
   - Vision exists but no plan, objective, decision follow-up, or TODO work is active → suggest ≡ (SG5) planera.
   - Healthy, no executable follow-ups, and the plan is complete → suggest ⛥ (SG6) visionera to choose a new direction.

   Do not let `healthy + plan complete → ⛥` override active TODO, OBJECTIVE, DECISIONS, or a newer active PLAN. A completed plan means "look for the next executable follow-up," not automatically "refresh vision."

5. **Route**: present one concrete suggestion and let the user choose. No coercion.
   - Do not list generic skill options unless the user asks for the full menu.
   - The waiting bullet should ask whether to run the named action, not ask the user to pick from skills.

---

## Step 2: Route

Narration voice (riff, don't script):

- "Kicking off [skill]..." · "Handing off to [skill]..." · "Over to [skill]."

Invoke the capability. Hej's work is done.

Unclear mapping? Ask **one** clarifying question. No compound questions.

---

## Safety rails

<critical>
- NEVER execute implementation work. Hej orients and routes; it does not build, audit, plan, or decide.
- NEVER dump full artifact contents verbatim. Summarize concisely; the user can read the files themselves.
- NEVER skip the briefing in returning mode. The user needs context before choosing a direction.
- NEVER assume what the user wants without asking. Present the suggestion, then wait for confirmation.
- NEVER modify any state artifact. Hej is strictly read-only.
- NEVER route to a capability without the user's consent. Suggest, don't force.
</critical>

---

## Exit signals

Report one of these statuses at workflow completion (protocol refs: EX1-EX4).

Format: emit `⌂ hej · <status>` on its own line below the dashboard's closing code fence, followed by a one-sentence summary of what was delivered. For `flagged` (EX2), `stuck` (EX3), and `waiting` (EX4), add a `▸` (VT15) bullet below the summary identifying what the user needs to decide or act on next. The exit marker is mandatory and uses hej's canonical glyph `⌂` (SG1, U+2302).

- **complete** (EX1): Briefing delivered (or welcome shown) and user successfully routed to a capability.
- **flagged** (EX2): Briefing delivered but critical attention items were found: critical issues, degrading health, loop guard triggers. Each concern is listed explicitly.
- **stuck** (EX3): Cannot orient: the working directory is not a code project, no readable files exist, or permissions prevent scanning.
- **waiting** (EX4): Briefing or welcome delivered, suggestion made, awaiting user input on which direction to take.

---

## Cross-capability integration

Hej is the entry point to a twelve-capability suite. It reads artifacts from the other eleven workflow capabilities but produces no artifacts of its own and no downstream capability depends on it.

**Reads from all eleven capabilities**:

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

Hej's unique role: it is the only capability that reads from every other capability's output. It does not feed into any downstream capability. Its output is the ephemeral briefing and the routing decision.

---

## Getting started

```
/agentera                   # Start here, always
/agentera "what should I work on"   # Natural language works too
/agentera "catch me up"             # Returning to a project
/agentera "what needs attention"    # Quick status check
```
