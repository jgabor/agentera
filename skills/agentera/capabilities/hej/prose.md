# HEJ

**Holistic Entry Junction. Orient, Route, Activate**

Single entry point to the agentera suite. Detects fresh vs returning, delivers a situational briefing, routes to the right capability. Same on first install and 100th session. A bare user message exactly `hej` uses this same briefing path, not generic greeting behavior.

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
uv run "$RESOLVED_AGENTERA_HOME/app/scripts/agentera" hej
```

Use that output to render the dashboard and select the concrete next action. Do
not relay raw CLI lines as the user-facing briefing. Source labels such as
`mode:`, `profile:`, `v1_migration:`, `health:`, `issues:`, `plan:`,
`objective:`, `attention:`, `next_action:`, `source_contract:`, and the
compatibility `bundle:` installed-app status object are parsing aids, not
dashboard lines. Do not run `agentera plan`, `agentera progress`, `agentera
health`, `agentera todo`, `agentera decisions`, or `agentera objective` as part
of normal hej briefing assembly. Do not read raw
`.agentera/*.yaml` files for normal hej orientation. If a normal dashboard field
is missing from `agentera hej`, fix or extend the composite CLI contract instead
of adding routine fallback reads. Use top-level fallback commands only when
`agentera hej` fails or explicitly reports fallback-only recovery.

Resolve `RESOLVED_AGENTERA_HOME` with the app-home precedence `AGENTERA_HOME`
when set, otherwise the platform data home, then run
the installed command once. Do not preflight app health with `glob`, `grep`,
`read`, `ls`, `python`, `doctor`, `--help`, `scripts/install_root.py`,
`registry.json`, or `.agentera-bundle.json`. If the command cannot execute
because `AGENTERA_HOME` is exactly the deprecated default
`$HOME/.agents/agentera` and `$AGENTERA_HOME/app/scripts/agentera` is missing,
do not require a successful stale CLI invocation and do not first ask the user to
unset `AGENTERA_HOME`. Use the exact stale-app summary phrase `installed
Agentera app is stale`, then show this platform app-home recovery preview:

```bash
uvx --from git+https://github.com/jgabor/agentera agentera upgrade --only bundle --dry-run
```

That preview writes nothing. Because no explicit `--install-root` is supplied,
upgrade can classify the exact deprecated default as recoverable, target the platform app home,
and preview old-default retirement. Ask for explicit approval before writes,
then apply the same platform app-home recovery path:

```bash
uvx --from git+https://github.com/jgabor/agentera agentera upgrade --only bundle --yes
```

After apply, retry the installed command from the platform app home reported by
the upgrade output, not from the deprecated old default. If the command exits
successfully, inspect the CLI-provided `bundle.status` installed-app status
object. Only `fresh` passes the installed Agentera app gate for normal briefing.
The object also carries `appHome`, `managedAppRoot`, `userDataRoot`,
`expectedVersionSource`, `bundle.dryRunCommand`, `bundle.applyCommand`, and
approval text. If the installed command cannot execute, is stale,
missing `hej`, fails before argparse, or reports blocked/refresh-required status,
tell the user the installed Agentera app is stale and preview the repair with the
CLI-provided dry-run command when present:

Use the exact stale-app summary phrase `installed Agentera app is stale`.

```bash
uvx --from git+https://github.com/jgabor/agentera agentera upgrade --only bundle --install-root "$RESOLVED_AGENTERA_HOME" --dry-run
```

Do not run the matching apply command until the user explicitly approves the
same app home, preferably with `approve app refresh for <resolved-app-home>`.
After apply, retry `uv run
"$RESOLVED_AGENTERA_HOME/app/scripts/agentera" hej`; do not treat local checkout
fallback as installed-app success. If `AGENTERA_HOME` is exactly the deprecated
default `$HOME/.agents/agentera`, no explicit `--install-root` was supplied, and
`$AGENTERA_HOME/app/scripts/agentera` is missing or stale, classify it as a
recoverable stale default and show the platform app-home recovery preview above
instead of first asking the user to unset `AGENTERA_HOME`; do not claim to prove
where the environment value came from. If `AGENTERA_HOME` points at any other
missing, invalid, or non-managed root, ask the user to fix it, choose a managed
app home, or explicitly request forced install guidance.

Use `agentera query <artifact-name> --format json|yaml` only for advanced or
custom artifact inspection when no top-level command serves the needed state.

### Artifact path resolution

Only if `agentera hej` fails and fallback raw artifact access is explicitly
needed, check `.agentera/docs.yaml` for path mappings before reading artifacts.
Without a mapping, use the default layout:

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

Run the resolved installed `agentera hej` and use its `mode` field. If the
installed-app status check reports stale or blocked, show the CLI-provided
refresh preview before normal mode handling.

- **No artifacts found** → Step 1a (first time on this project)
- **Artifacts found** → Step 1b (returning to known project)

Narration voice: warm, brief, unscripted.

---

## Step 0.5: CLI-owned checks

Do not run separate v1 artifact or PROFILE.md checks during normal hej
orientation. `agentera hej` owns those checks and emits the mode, profile status,
`v1_migration.detected`, `v1_migration.affected_files`,
`v1_migration.dry_run_command`, `v1_migration.apply_command`, attention items,
and next action. Render those fields; do not spend additional tool calls on
`.agentera/*.md`, `.agentera/*.yaml`, `VISION.md`, or global profile-path
discovery. Treat `v1_migration.dry_run_command` as the CLI-supplied dry-run
preview. Ask before any upgrade apply command, and only run
`v1_migration.apply_command` after confirmation.
The artifacts phase migrates supported v1 Markdown files to YAML with backups
after preview and confirmation.

If `v1_migration.detected` is false, emit no upgrade notice. Profile status is
also CLI-owned: render `profile: loaded` without warning, and render
`profile.suggested_action` or a missing-profile attention item only when
`agentera hej` supplies one.

If `npx skills update` refreshed only the visible skill and `/agentera` next
finds a stale or missing managed app, explain that managed app refresh and exact
old-default retirement happen through app-home upgrade, not through the visible
skill update alone.

---

## Step 1a: Welcome

First impression: the colleague meets a new project.

1. **Use composite state**: Build the welcome from `agentera hej` output only.
   Do not scan README files, git history, languages, framework files, or project
   size during bare orientation.

2. **Share what's available**: lead with the suggested capability from
   `next_action`. Do not enumerate the full suite unless asked.

3. **Route**: ask what they'd like to do with a free-form prompt. Do not use a
   native question menu on the initial welcome unless the user explicitly asked
   for bounded choices. Invoke a capability only after the user confirms it.

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

     suggested → [glyph] [capability] ([reason])
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
   - ⇉ (SI2) Blocked/overdue plan tasks, stale artifacts (plan-relative per contract staleness detection; fall back to PROGRESS.md recency heuristic when no plan context exists), loop stop-condition triggers
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
   - No vision, no executable follow-ups, and no active plan → suggest ⛥ (SG6) visionera to choose a direction.

   Do not let `healthy + plan complete → ⛥` override active TODO, OBJECTIVE, DECISIONS, or a newer active PLAN. A completed plan means "look for the next executable follow-up," not automatically "refresh vision."

5. **Route**: present one concrete suggestion and let the user choose. No coercion.
   - Do not list generic skill options unless the user asks for the full menu.
   - The waiting bullet should ask whether to run the named action, not ask the user to pick from skills.
   - On the initial Agentera/hej brief, use a free-form continuation prompt rather than a native question menu unless the user asked for bounded choices.
   - Mid-conversation, use the native question tool only for at least two meaningful non-terminal next actions or a consequential Proceed/Cancel decision; `Done` and free-form/custom answer affordances do not count as alternatives.

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
- **flagged** (EX2): Briefing delivered but critical attention items were found: critical issues, degrading health, loop stop-condition triggers. Each concern is listed explicitly.
- **stuck** (EX3): Cannot orient: the working directory is not a code project, no readable files exist, or permissions prevent scanning.
- **waiting** (EX4): Briefing or welcome delivered, suggestion made, awaiting user input on which direction to take.

---

## Cross-capability integration

Hej is the suite entry point. It reads other capabilities' artifacts, produces
no artifact, and outputs only a briefing plus routing suggestion.
