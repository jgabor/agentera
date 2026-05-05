# HEJ

**Holistic Entry Junction. Orient, Route, Activate**

Single entry point to the agentera suite. Detects fresh vs returning, delivers a situational briefing, routes to the right capability. Same on first install and 100th session.

Each invocation = one orientation. Uses the CLI composite briefing first,
writes nothing.

---

## State artifacts

Glyph: **⌂** (SG1). Hej reads suite state through `agentera hej` and writes
nothing. It may fall back to direct reads only when the composite command fails
or explicitly asks for fallback.

### CLI-first access

For returning projects, run one composite command before any individual state
access:

```bash
uv run ${AGENTERA_HOME:-.}/scripts/agentera hej
```

Use that output to render the dashboard and select the concrete next action. Do
not relay raw CLI lines as the user-facing briefing. Do not run `agentera plan`,
`agentera progress`, `agentera health`, `agentera todo`, `agentera decisions`,
or `agentera objective` as part of normal hej briefing assembly. Do not read raw
`.agentera/*.yaml` files for normal hej orientation. If a normal dashboard field
is missing from `agentera hej`, fix or extend the composite CLI contract instead
of adding routine fallback reads. Use top-level fallback commands only when
`agentera hej` fails or explicitly reports fallback-only recovery.

Use `agentera query <artifact-name> --format json|yaml` only for advanced or
custom artifact inspection when no top-level command serves the needed state.

### Artifact path resolution

Before reading artifacts, check `.agentera/docs.yaml` for path mappings. Without
a mapping, use the default layout:

- Human-facing artifacts at the project root (Markdown): `TODO.md`, `CHANGELOG.md`, `DESIGN.md`
- Agent-facing artifacts in `.agentera/` (YAML): `progress.yaml`, `decisions.yaml`, `health.yaml`, `plan.yaml`, `docs.yaml`, `vision.yaml`, `session.yaml`, and per-objective `objective.yaml` / `experiments.yaml`

Canonical names are identifiers, not literal paths. PROFILE.md is global:
`$PROFILERA_PROFILE_DIR/PROFILE.md`, default `$XDG_DATA_HOME/agentera/PROFILE.md`.

### Contract values

Use protocol tokens by ID where needed: severity arrows VT5-VT8, trend arrows
VT12-VT13, progress bar VT18, separator VT16, list item VT15, section divider
VT14, flow arrow VT17, skill glyphs SG1-SG12, exits EX1-EX4, issues SI1-SI4.

---

## Step 0: Detect mode

Run `agentera hej` and use its `mode` field.

- **No artifacts found** → Step 1a (first time on this project)
- **Artifacts found** → Step 1b (returning to known project)

Narration voice: warm, brief, unscripted.

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

<!-- markdownlint-disable MD034 -->

- Add to the briefing's attention section as a degraded (SI2, ⇉) item:
  `⇉ v1 artifacts detected · preview \`uvx --from git+https://github.com/jgabor/agentera agentera upgrade --project "$PWD" --dry-run\``

<!-- markdownlint-enable MD034 -->

- If the current project is a local Agentera checkout with `scripts/agentera`, the local equivalent is
  `uv run scripts/agentera upgrade --project "$PWD" --dry-run`.
- Include the notice once (not per-file); list the affected files after the command.
- Ask before applying. After confirmation, run the same command with `--yes`.
  If the user reached this flow from a legacy `/hej` install or stale runtime
  package state, include `--update-packages` so `/agentera` is installed too.
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

2. **Share what's available**: lead with the 2-3 capabilities most relevant to
   the scan. Do not enumerate the full suite unless asked. Common phrases:
   define direction, help me decide, research this pattern, plan this, build the
   next feature, improve test coverage, audit the codebase, update docs, build
   decision profile, design visual identity, run the plan.

3. **Give your honest take**: based on the scan, tell the user where you'd start
    and why. "If I were you, I'd start with X because Y." Use the routing logic (no vision → visionera, unknown quality → inspektera, decision needed → resonera, ready to build + has plan → orkestrera, ready to build → realisera, docs gaps → dokumentera) but frame it as judgment, not a lookup table.

4. **Route**: ask what they'd like to do. Invoke the chosen capability.

---

## Step 1b: Briefing

Show where things stand.

1. **Use composite state**: Build the briefing from `agentera hej` output.
   - Use its mode, profile, health, issue counts, plan progress, objective,
     attention, and next_action fields.
   - Do not issue individual artifact queries during normal returning-project
     orientation.
   - Do not open raw `.agentera/*.yaml` files unless the composite command fails
     or names a fallback need.
   - If exceptional fallback is required, prefer top-level commands such as
     `agentera plan`, `agentera progress`, `agentera health`, `agentera todo`,
     `agentera decisions`, `agentera objective`, and `agentera experiments`.
     Missing normal dashboard fields should be repaired in `agentera hej`
     instead of weakening the one-command path.
   - Keep `agentera query` for advanced/custom inspection only.

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

Narration voice: "Kicking off [skill]..." or similarly brief.

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

Hej is the suite entry point. It reads other capabilities' artifacts, produces
no artifact, and outputs only a briefing plus routing suggestion.
