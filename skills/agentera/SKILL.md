---
name: agentera
description: >
  The open protocol for turning AI agents into engineering teams.
  One Agentera skill with twelve capabilities, each defined by human-readable
  prose and machine-readable schemas. The agent reads this file to route
  incoming requests to the right capability. Use this skill for /agentera,
  Agentera capability requests, and a complete user message exactly `hej`;
  bare `hej` runs the agentera hej dashboard path instead of a generic greeting.
version: "2.3.12"
spec_sections: [1, 2, 3, 4, 5, 6, 11, 13, 18, 19, 20, 22, 23]
---

# agentera

One install, one entry point, one query interface to all project state. Twelve capabilities live inside one Agentera skill.

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
`userDataRoot`, repair commands, and approval text.

### User-facing repair wording

Recovery and troubleshooting prompts must be plain enough for a non-technical
user. Never ask the user to choose between technical install concepts, internal
directory states, command-mode flags, or package-layout terms. Keep those as
internal facts.
User-facing copy must answer four questions in this order:

1. What happened: `Agentera found an old or broken local copy of itself.`
2. What the preview did: `Nothing was changed.`
3. What the recommended fix will do: `Install a fresh Agentera app copy in the normal Agentera directory.`
4. What it will not do: `It will not edit your project files, shell startup files, or unknown directories.`

Use recommendation-first choices only when a choice is unavoidable. Put the safe
default first and name it as the recommendation. Good labels: `Use the safe fix
(Recommended)`, `Choose a different directory`, `Stop`. Bad labels: `Use platform
home`, `Force old directory`, or labels that expose internal flags and app-file
packaging terms.
Only mention commands and paths after the plain explanation, as technical detail.

If the command cannot execute because `AGENTERA_HOME` names the old default
`$HOME/.agents/agentera` and `$AGENTERA_HOME/app/scripts/agentera` is missing,
do not require a successful failed CLI invocation and do not first ask the user to
unset `AGENTERA_HOME`. Tell the user: `Agentera found an old or broken local copy
of itself. The safe fix is to install a fresh copy in the normal Agentera directory.`
Then show this preview command and say it changes nothing:

```bash
uvx --from git+https://github.com/jgabor/agentera agentera upgrade --dry-run
```

This preview writes nothing. Because no explicit `--install-root` is supplied,
upgrade can choose the normal platform app directory and preview repair for app
files, managed runtime surfaces, and cleanup of the old directory. Ask for
explicit approval before writes, using plain wording such as
`Approve the safe Agentera repair at <directory>`. After approval, apply the same
safe repair path:

```bash
uvx --from git+https://github.com/jgabor/agentera agentera upgrade --yes
```

After apply, retry the installed command from the platform app home reported by
the upgrade output, not from the old default directory. If the command executes but
fails before argparse, reports `invalid choice` for `hej`, or reports a status of
`stale`, `blocked`, missing-command, or refresh-required:

- Say `Agentera found an old or broken local copy of itself.`
- Say whether the preview changed anything; preview commands change nothing.
- State the safe recommendation in plain language before paths or commands.
- Show the clone-free preview command from `bundle.dryRunCommand` when present:

```bash
uvx --from git+https://github.com/jgabor/agentera agentera upgrade --install-root "$RESOLVED_AGENTERA_HOME" --dry-run
```

Ask for explicit approval before writes. A normal affirmative response is
acceptable only when it clearly authorizes the same Agentera repair and directory.
If approved, apply:

```bash
uvx --from git+https://github.com/jgabor/agentera agentera upgrade --install-root "$RESOLVED_AGENTERA_HOME" --yes
```

After apply, retry:

```bash
uv run "$RESOLVED_AGENTERA_HOME/app/scripts/agentera" hej
```

If `AGENTERA_HOME` names the old default `$HOME/.agents/agentera`, no explicit
`--install-root` was supplied, and `$AGENTERA_HOME/app/scripts/agentera` is
missing or out of date, treat this as safe to preview with the normal Agentera
directory above. Do not first ask the user to unset `AGENTERA_HOME`; do not claim to
prove where the environment value came from. If `AGENTERA_HOME` names any other
missing path, file, or directory with unknown files and the single command cannot
run, do not overwrite it silently or fall back to a local checkout. Say:
`Agentera was told to use a directory it cannot safely use. Choose a different
Agentera directory, or approve --force only after checking that directory is safe to
replace.`

If stale Agentera lines are found in shell startup files such as `~/.bashrc`,
`~/.zshrc`, `.profile`, or fish config, say plainly that Agentera will not edit
those files. Cleanup of those lines is user-owned manual cleanup, not a repair
write.

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
inspection remain available through `agentera describe --format json`,
`query --list-artifacts`, and `query <artifact-name> --format json|yaml`.
Structured discovery includes an artifact-location contract with mapped paths,
normal read commands, and raw-access boundaries; use that contract before
reading `.agentera/docs.yaml` or probing `.agentera/` for path discovery.

Do not silently bypass the CLI and read raw `.agentera/*.yaml` files first. If
CLI state declares complete startup coverage, do not perform defensive raw
artifact reads for normal startup. If CLI state is unavailable or incomplete,
try the CLI-provided fallback commands first; use raw artifact reads only as a
last-resort fallback after those paths fail or still declare incomplete state.
When `agentera plan --format json` returns
`source_contract.complete_for_plan_artifact=true`, treat its `summary`,
`entries`, and `source_contract` as complete for normal `PLAN.md` startup and
evaluation context; do not read `.agentera/plan.yaml` merely to re-check task
dependencies, acceptance criteria, evidence, overall acceptance, surprises,
prior-plan archive references, or plan metadata. This no-raw-read rule is for
normal read-only startup/evaluation. Raw mapped plan artifact access remains valid
for writes, archives, validation, corruption diagnostics, or unavailable or
incomplete CLI state after CLI fallbacks.

When artifact paths are the only missing fact, prefer the CLI discovery contract:
`agentera describe --format json` exposes `artifact_locations`, and
`agentera query --list-artifacts --format json` exposes the same compact records
with a `names` compatibility list. Plain `query --list-artifacts` remains the
human names list. These discovery surfaces do not replace routine state commands
for normal artifact content reads.

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
the CLI. When capability-specific startup context is needed, request it through
the existing state seam with
`agentera hej --format json --capability-context <capability>`. Use returned
`capability_context.included_state_families` directly, and for
`missing_state_families`, run the listed `cli_fallback` commands before raw file
access.
For normal ≡ planera execution, use `capability_context.startup_contract` from
`agentera hej --format json --capability-context planera` before reading
`skills/agentera/capabilities/planera/prose.md`. Read Planera prose only when
editing Planera, resolving contradiction or ambiguity, validating detailed
behavior not covered by the compact contract, or investigating benchmark/read-trigger
evidence. This preserves Planera prose as detailed authority and does not add
`agentera planera`; `/agentera plan` remains routing while `agentera plan`
remains plan state.
For normal DECISIONS.md context, use `agentera decisions --format json` and its
source_contract. When `complete_for_normal_deliberation_context=true`, preserve
returned `missing_fields`, `compacted`, `caveats`, and `satisfaction.review_needed`
instead of raw-reading `.agentera/decisions.yaml` to reconstruct missing history.
Raw decision artifact access is reserved for Resonera-owned writes/repairs,
artifact corruption diagnostics, or CLI defect investigation.
Reading a capability's `prose.md` file is not itself a capability invocation;
invocation means routing to the capability, following its prose, and using the
CLI state layer first for artifact-backed state.

Capability handoffs use glyph plus canonical capability name, for example
`⧉ realisera` or `≡ planera`. Reserve `/agentera <alias>` wording for explicit
slash-route documentation and do not use standalone slash-capability names such
as `/realisera` or `/planera` as handoff labels. SG priority codes such as `SG2`
are internal protocol references; do not render them in user-facing handoff
labels.

Handoff verbs are normative:

- `route`: the user directly invoked a capability by canonical name, primary
  alias, or slash route. This is consent to invoke that capability; do not ask
  for extra handoff confirmation.
- `suggest`: recommend a downstream capability and wait for user confirmation.
- `handoff prompt`: ask whether to run the suggested capability. Use the native
  question tool for multi-choice prompts and for a single state-changing
  Proceed/Cancel handoff. State-changing means the proposed next step may write
  artifacts, edit code, run optimization or orchestration cycles, apply
  migrations, refresh app/runtime state, or otherwise mutate project/runtime
  state. Use the behavior rule first, with common examples such as ⧉ realisera,
  ≡ planera when creating or updating plans, ▤ dokumentera when writing docs,
  ⎘ optimera when running or applying optimization cycles, and ⎈ orkestrera
  when dispatching cycles. A single non-mutating suggestion may use a free-form
  prompt; clear replies such as `yes`, `start`, `do it`, or `run <capability>`
  confirm the named suggestion. Ambiguous replies get one clarifying question.
- `dispatch`: invoke another capability autonomously only when the current
  capability explicitly owns that orchestration flow.
- `chain`: dispatch multiple capabilities autonomously only inside an explicitly
  orchestrated flow; otherwise suggest the next capability and wait.

The first Agentera/hej response in a fresh interaction should deliver the brief
and a free-form continuation prompt, not a native question menu, unless the user
explicitly asks for bounded choices or the suggested next step is a
state-changing Proceed/Cancel handoff. Mid-conversation, use the runtime's
native question tool only when there are at least two meaningful non-terminal
next actions or a consequential Proceed/Cancel decision; state-changing
capability handoffs are consequential Proceed/Cancel decisions even when there
is only one suggested action. Do not count `Done` or free-form/custom answer
affordances as alternatives. Current host examples are Claude Code
`AskUserQuestion`, Copilot `ask_user`, Codex `request_user_input`, and OpenCode
`question`. Put the recommended choice first with `(Recommended)` in its label
and include `Done`. Selecting a downstream capability option is confirmation to
invoke that capability; selecting `Done` stops without routing. This generic
question-tool gating applies to hej and capability handoff prompts. Once a
capability is invoked, that capability's own interaction rules control whether
the runtime-native question tool is required.

### Step 0: V1 migration handling

Do not perform separate v1 Markdown/YAML discovery before a normal hej briefing.
The top-level CLI owns v1 detection. For bare `/agentera` or bare `hej`, render
any `v1 artifacts detected` attention item and affected-file list from
`agentera hej`; do not spend extra tool calls on `.agentera/*.md`,
`.agentera/*.yaml`, or `VISION.md` globs.

If the CLI reports v1 state, use the `v1_migration.dry_run_command` preview it
supplies. A no-write preview is mandatory before any apply command. Tell the
user the preview changes nothing, then ask before applying. Only after
confirmation, run `v1_migration.apply_command`.
Never infer consent from the presence of v1 artifacts.
The preview command shape is
`uvx --from git+https://github.com/jgabor/agentera agentera upgrade --project "$PWD" --dry-run`
or the local-checkout equivalent `uv run scripts/agentera upgrade --project "$PWD" --dry-run`
when supplied by the CLI.
Do not replace the CLI-owned preview with manual artifact inspection,
hand-written migration steps, or raw YAML reads. Only the apply step requires confirmation.

The upgrade command is idempotent. It installs or refreshes Agentera app files
when invoked through `uvx`, migrates v1 artifacts, wires runtime config to that
app home, and removes fixable outdated v1 runtime artifacts.
The artifacts phase migrates supported v1 Markdown files to YAML with backups
after preview and confirmation. Package refreshes that run `npx skills remove`
for v1 skill entries and `npx skills add` for `/agentera` remain explicit opt-in
via `--update-packages`. `npx skills update` by itself updates only the visible
skill; if `/agentera` then finds missing or out-of-date app files, run the
plain-language repair preview above so upgrade refreshes the app and cleans up
the old default directory when it is recoverable.

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

The twelve-skill suite is collapsed into one Agentera skill. Each capability's schemas define cross-capability artifact references using stable IDs. Cross-capability routing is handled through capability trigger schemas described in the Routing Logic section. Capabilities read from and write to the same artifact store (`.agentera/` for agent-facing, project root for human-facing), so inter-capability data flows through shared artifacts, not direct invocation.

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
