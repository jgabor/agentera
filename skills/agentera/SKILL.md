---
name: agentera
description: >
  The open protocol for turning AI agents into engineering teams.
  One bundled skill with twelve capabilities, each defined by human-readable
  prose and machine-readable schemas. The agent reads this file to route
  incoming requests to the right capability. Use this skill for /agentera,
  Agentera capability requests, and a complete user message exactly `hej`;
  bare `hej` runs the agentera hej dashboard path instead of a generic greeting.
version: "2.3.1"
spec_sections: [1, 2, 3, 4, 5, 6, 11, 13, 18, 19, 20, 22, 23]
---

# agentera

One install, one entry point, one query interface to all project state. Twelve capabilities bundled into a single skill.

---

## Shared Protocol

All capabilities reference shared primitives defined in `protocol.yaml`:

- **Confidence scale**: 0-100, five tiers with explicit boundaries
- **Severity levels**: finding vocabulary and issue vocabulary
- **Visual tokens**: status, severity, confidence, and trend glyphs
- **Phase model**: five phases with valid transitions

Capabilities import these by name. The schema contract ensures consistent usage.

---

## Capabilities

| | Capability | Primary route | Purpose |
|---|---|---|---|
| ⌂ | hej | `/agentera status` | Orientation and routing |
| ⛥ | visionera | `/agentera vision` | Define project direction |
| ❈ | resonera | `/agentera discuss` | Structured deliberation |
| ⬚ | inspirera | `/agentera research` | External pattern analysis |
| ≡ | planera | `/agentera plan` | Planning with acceptance criteria |
| ⧉ | realisera | `/agentera build` | Autonomous development |
| ⎘ | optimera | `/agentera optimize` | Metric-driven optimization |
| ⛶ | inspektera | `/agentera audit` | Codebase health audit |
| ▤ | dokumentera | `/agentera document` | Documentation |
| ♾ | profilera | `/agentera profile` | Decision profiling |
| ◰ | visualisera | `/agentera design` | Visual identity system |
| ⎈ | orkestrera | `/agentera orchestrate` | Multi-cycle orchestration |

---

## Routing Logic

When a request arrives, route to the matching capability using the five-layer dispatch model from Decision 42.

### Prerequisite: Single-call installed CLI gate

This gate is mandatory, but the gate and the hej dashboard source are the same
installed CLI invocation. For bare `/agentera` or bare `hej`, the first normal
state-access tool call is:

```bash
uv run "$RESOLVED_AGENTERA_HOME/app/scripts/agentera" hej
```

Resolve `RESOLVED_AGENTERA_HOME` with the app-home precedence `AGENTERA_HOME`
when set, otherwise the platform data home. Do not run `glob`, `grep`, `read`,
`ls`, `python`, `doctor`, `--help`, `scripts/install_root.py`, `registry.json`,
or `.agentera-bundle.json` preflight checks before this call. The CLI owns app
validation, v1 detection, profile detection, artifact condensation, and the
`source_contract` that tells the caller how to render the dashboard.

If the command exits successfully, inspect the CLI-provided `bundle.status`
installed-app status object. If its value is `fresh`, treat the installed app gate as passed
for that briefing and render from the output. The object includes
`expectedVersion`, `expectedVersionSource`, `appHome`, `managedAppRoot`,
`userDataRoot`, repair commands, and approval text. If the command cannot
execute because `AGENTERA_HOME` is exactly the deprecated default
`$HOME/.agents/agentera` and `$AGENTERA_HOME/app/scripts/agentera` is missing,
do not require a successful stale CLI invocation and do not first ask the user to
unset `AGENTERA_HOME`. Tell the user the installed Agentera app is stale and show
the platform app-home recovery preview:

```bash
uvx --from git+https://github.com/jgabor/agentera agentera upgrade --only bundle --dry-run
```

This preview writes nothing. Because no explicit `--install-root` is supplied,
upgrade can classify the exact deprecated default as recoverable, target the platform app home,
and preview old-default retirement. Ask for explicit approval before writes,
then apply the same platform app-home recovery path:

```bash
uvx --from git+https://github.com/jgabor/agentera agentera upgrade --only bundle --yes
```

After apply, retry the installed command from the platform app home reported by
the upgrade output, not from the deprecated old default. If the command executes
but fails before argparse, reports `invalid choice` for `hej`, or reports a
status of `stale`, `blocked`, missing-command, or refresh-required:

- Tell the user the installed app is stale
- Report the resolved app home and resolution source from the `bundle` object
- Show the clone-free dry-run preview from `bundle.dryRunCommand` when present:

```bash
uvx --from git+https://github.com/jgabor/agentera agentera upgrade --only bundle --install-root "$RESOLVED_AGENTERA_HOME" --dry-run
```

Ask for explicit approval before writes. The canonical approval phrase is
`approve app refresh for <resolved-app-home>`; a normal affirmative response is
acceptable only when it clearly authorizes the same app refresh and home. If
approved, apply:

```bash
uvx --from git+https://github.com/jgabor/agentera agentera upgrade --only bundle --install-root "$RESOLVED_AGENTERA_HOME" --yes
```

After apply, retry:

```bash
uv run "$RESOLVED_AGENTERA_HOME/app/scripts/agentera" hej
```

If `AGENTERA_HOME` is exactly the deprecated default
`$HOME/.agents/agentera`, no explicit `--install-root` was supplied, and
`$AGENTERA_HOME/app/scripts/agentera` is missing or stale, classify this as a
recoverable stale default. Present the platform app-home dry-run above instead
of first asking the user to unset `AGENTERA_HOME`; do not claim to prove where
the environment value came from. If `AGENTERA_HOME` is any other missing path,
file, or unmanaged directory and the single command cannot run, do not overwrite
it silently or fall back to a local checkout. Ask the user to fix
`AGENTERA_HOME`, choose a managed `--install-root`, or explicitly request a
forced app install.

Only after the installed CLI succeeds, proceed to Step -1 and the routing layers
below. Do not fall through to a local checkout as a workaround; the uvx commands
above are portable and require no local checkout.

### Step -1: Top-level CLI-first state access

The `agentera` CLI is the authoritative interface to project state. Use
top-level state commands for routine access. `agentera query` is reserved for
advanced/custom artifact inspection when no normal command serves the needed
state.

Before any artifact-backed briefing, route decision, or capability state read,
run the top-level command that owns the needed state. The app health gate
above must have already confirmed the installed CLI is usable.

Routine commands are: `hej`, `plan`, `progress`, `health`, `todo`,
`decisions`, `docs`, `objective`, and `experiments`. Discovery and custom
inspection remain available through `query --list-artifacts` and
`query <artifact-name> --format json|yaml`.

Do not silently bypass the CLI and read raw `.agentera/*.yaml` files first. If
all CLI paths fail, report that the CLI was unavailable, then use raw artifact
reads only as a fallback.

For bare `/agentera` or a bare user message exactly `hej`, run `agentera hej`
first and render the README-style hej dashboard from that single composite
result. The CLI output is source data, not the user-facing dashboard; do not
relay raw `agentera hej` lines as the final briefing. Do not run individual `plan`, `progress`, `health`,
`todo`, or `decisions` commands unless `agentera hej` fails or explicitly asks
for fallback. The final response must
transform source labels such as `mode:`, `profile:`, `health:`, `issues:`,
`plan:`, `objective:`, `attention:`, `next_action:`, `app_home:`,
`v1_migration:`, and `source_contract:` into the dashboard below; never paste
those labels as the briefing.

Bare `/agentera` returning-project output must include these visible markers:

```text
┌─┐┌─┐┌─┐┌┐┌┌┬┐┌─┐┬─┐┌─┐
├─┤│ ┬├┤ │││ │ ├┤ ├┬┘├─┤
┴ ┴└─┘└─┘┘└┘ ┴ └─┘┴└─┴ ┴

─── status ─────────────────────────────
─── attention ──────────────────────────
─── next ───────────────────────────────
```

Omit `attention` only when the source has no attention items. Always include the
mandatory `⌂ hej · <status>` marker below the dashboard code fence, and ask for
confirmation before invoking the suggested downstream capability. For
`/agentera <capability-name>` or `/agentera <alias>`, do not assume the route
word is a CLI command. The CLI command surface is state-oriented, not
capability-oriented:
use the supported routine state command or commands that own the capability's
needed artifacts, as declared by that capability's artifact schema. For example,
`resonera` reads decisions through `agentera decisions`, not through the
unsupported capability-name command `agentera resonera`. Never run unsupported
capability-name commands such as `agentera resonera`, `agentera planera`, or
`agentera realisera` as a bootstrap step. Shared words stay split by interface:
`/agentera plan` routes to planera, while `agentera plan` reads plan state from
the CLI.
Reading a capability's `prose.md` file is not itself a capability invocation;
invocation means routing to the capability, following its prose, and using the
CLI state layer first for artifact-backed state.

Capability handoffs use glyph plus canonical capability name, for example
`⧉ realisera` or `≡ planera`. Reserve `/agentera <alias>` wording for explicit
slash-route documentation and do not use standalone slash-capability names such
as `/realisera` or `/planera` as handoff labels. The first Agentera/hej response
in a fresh interaction should deliver the brief and a free-form continuation
prompt, not a native question menu, unless the user explicitly asks for bounded
choices. Mid-conversation, use the runtime's native question tool only when
there are at least two meaningful non-terminal next actions or a consequential
Proceed/Cancel decision; do not count `Done` or free-form/custom answer affordances
as alternatives. Current host examples are Claude Code `AskUserQuestion`, Copilot
`ask_user`, Codex `request_user_input`, and OpenCode `question`. Put the
recommended choice first with `(Recommended)` in its label and include `Done`.
Selecting a downstream capability option is confirmation to invoke that
capability; selecting `Done` stops without routing.

### Step 0: V1 migration handling

Do not perform separate v1 Markdown/YAML discovery before a normal hej briefing.
The top-level CLI owns v1 detection. For bare `/agentera` or bare `hej`, render
any `v1 artifacts detected` attention item and affected-file list from
`agentera hej`; do not spend extra tool calls on `.agentera/*.md`,
`.agentera/*.yaml`, or `VISION.md` globs.

If the CLI reports v1 state, use the `v1_migration.dry_run_command` preview it
supplies. The dry-run preview is mandatory before any apply command. Ask the
user before applying. Only after confirmation, run `v1_migration.apply_command`.
Never infer consent from the presence of v1 artifacts.
The preview command shape is
`uvx --from git+https://github.com/jgabor/agentera agentera upgrade --project "$PWD" --dry-run`
or the local-checkout equivalent `uv run scripts/agentera upgrade --project "$PWD" --dry-run`
when supplied by the CLI.
Do not replace the CLI-owned preview with manual artifact inspection,
hand-written migration steps, or raw YAML reads. Only the apply step requires confirmation.

The upgrade command is idempotent. It installs or refreshes the managed app under
the Agentera app home when invoked through `uvx`, migrates v1 artifacts, wires
runtime config to that app home, and removes fixable stale v1 runtime artifacts.
The artifacts phase migrates supported v1 Markdown files to YAML with backups
after preview and confirmation. Package refreshes that run `npx skills remove`
for v1 skill entries and `npx skills add` for `/agentera` remain explicit opt-in
via `--update-packages`. `npx skills update` by itself updates only the visible
skill; if `/agentera` then finds a stale or missing managed app, run the
app-home upgrade preview above so upgrade refreshes the managed app and retires
the exact old default when it is recoverable.

### Layer 1: Bare `/agentera` or bare `hej` — delegate to hej

If the request is `/agentera` with no additional text, or the complete user
message is exactly `hej`, delegate immediately to hej. Hej performs state-aware
routing through the `agentera hej` composite result, which condenses project
artifacts and suggests the most useful next capability. This is deterministic
and never wrong. Bare `hej` must not be handled as a generic greeting.

### Layer 2: `/agentera <capability-name-or-primary-alias>` — direct route

If the request text exactly matches a capability name (case-insensitive, e.g.,
"resonera", "planera", "hej"), route directly to that capability without
evaluating natural-language trigger patterns. Canonical Swedish names remain the
protocol identity and bypass natural-language matching.

If the request text exactly matches one primary alias from
`capability_schema_contract.yaml` `ROUTE_ALIASES.primary_aliases`, route directly
to that alias's capability without evaluating natural-language trigger patterns.
Each capability has exactly one primary alias. Secondary user wording stays in
capability trigger schemas below this layer. Examples: `deliberate`,
`brainstorm`, and `rubber duck` remain resonera trigger wording; `brief` and
`what's next` remain hej trigger wording. These are not primary aliases.

### Layer 3: Natural language with high-confidence match

If the request is natural language (e.g., "help me think through this"), evaluate capability trigger schemas and route when the schema-owned semantics produce a high-confidence match.

### Layer 4: Borderline match — disambiguation

If the schema-owned routing semantics produce competing borderline matches, present a disambiguation prompt instead of silently choosing. List the matching capabilities with brief descriptions and ask the user to confirm or clarify.

### Layer 5: No match — fallback to hej

If no capability matches with sufficient confidence, route to hej for orientation. Hej handles greetings, status requests, and ambiguous inputs.

### Trigger Pattern Discovery

The trigger-to-capability map for Layers 3-4 is derived from each capability's `schemas/triggers.yaml`, not hardcoded here. Pattern matching, priority, thresholds, fallback, and disambiguation metadata belong to those trigger schemas and the capability schema contract. This keeps `SKILL.md` a dispatcher; capability directories and schemas remain the detailed Interface sources.

---

## Safety rails

<critical>
- NEVER push to remote repos without explicit user instruction
- NEVER modify `.agentera/vision.yaml` or objective state during execution cycles (only the user or the owning capability may change these)
- NEVER commit secrets or credentials to any artifact or file
- Respect artifact path resolution: check `.agentera/docs.yaml` for path overrides before accessing any agent-facing artifact
</critical>

---

## Exit signals

All capabilities use the exit vocabulary defined by `protocol.yaml` `EXIT_SIGNALS`. Capability `schemas/exit.yaml` files reference that protocol authority; `SKILL.md` does not maintain a separate exit-signal table.

---

## Cross-skill integration

The twelve-skill suite is collapsed into a single bundled skill. Each capability's schemas define cross-capability artifact references using stable IDs. Cross-capability routing is handled through capability trigger schemas described in the Routing Logic section. Capabilities read from and write to the same artifact store (`.agentera/` for agent-facing, project root for human-facing), so inter-capability data flows through shared artifacts, not direct invocation.

### Artifact path resolution

Before reading or writing any artifact, check if `.agentera/docs.yaml` exists. If it has an Artifact Mapping section, use the path specified for each canonical filename. If `.agentera/docs.yaml` doesn't exist or has no mapping for a given artifact, use the default layout:

- Human-facing artifacts at the project root: `TODO.md`, `CHANGELOG.md`, `DESIGN.md`
- Agent-facing artifacts in `.agentera/` as YAML: `progress.yaml`, `decisions.yaml`, `health.yaml`, `plan.yaml`, `docs.yaml`, `vision.yaml`, `session.yaml`, `objective.yaml`, `experiments.yaml`

---

## Directory Structure

```
skills/agentera/
  SKILL.md                          # This file
  protocol.yaml                     # Shared primitives
  capability_schema_contract.yaml   # Self-referential schema contract
  capabilities/
    hej/
      prose.md
      schemas/
        triggers.yaml
        artifacts.yaml
        validation.yaml
        exit.yaml
    resonera/
      prose.md
      schemas/
        triggers.yaml
        artifacts.yaml
        validation.yaml
        exit.yaml
    ... (12 capabilities total)
```

Validate any capability against the contract:

```bash
uv run scripts/validate_capability.py skills/agentera/capabilities/<name>
```

Self-validate the contract:

```bash
uv run scripts/validate_capability.py --self-validate
```
