---
name: agentera
description: >
  The open protocol for turning AI agents into engineering teams.
  One bundled skill with twelve capabilities, each defined by human-readable
  prose and machine-readable schemas. The agent reads this file to route
  incoming requests to the right capability.
version: "2.0.3"
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

| | Capability | Purpose |
|---|---|---|
| ⌂ | hej | Orientation and routing |
| ⛥ | visionera | Define project direction |
| ❈ | resonera | Structured deliberation |
| ⬚ | inspirera | External pattern analysis |
| ≡ | planera | Planning with acceptance criteria |
| ⧉ | realisera | Autonomous development |
| ⎘ | optimera | Metric-driven optimization |
| ⛶ | inspektera | Codebase health audit |
| ▤ | dokumentera | Documentation |
| ♾ | profilera | Decision profiling |
| ◰ | visualisera | Visual identity system |
| ⎈ | orkestrera | Multi-cycle orchestration |

---

## Routing Logic

When a request arrives, route to the matching capability using the five-layer dispatch model from Decision 42.

### Step -1: Top-level CLI-first state access

The `agentera` CLI is the authoritative interface to project state. Use
top-level state commands for routine access. `agentera query` is reserved for
advanced/custom artifact inspection when no normal command serves the needed
state.

Before any artifact-backed briefing, route decision, or capability state read,
run the top-level command that owns the needed state:

1. Installed bundle:
   `uv run "$AGENTERA_HOME/scripts/agentera" <command>`
2. Default durable bundle:
   `uv run "$HOME/.agents/agentera/scripts/agentera" <command>`
3. Local Agentera checkout:
   `uv run scripts/agentera <command>`

Routine commands are: `hej`, `plan`, `progress`, `health`, `todo`,
`decisions`, `docs`, `objective`, and `experiments`. Discovery and custom
inspection remain available through `query --list-artifacts` and
`query <artifact-name> --format json|yaml`.

Do not silently bypass the CLI and read raw `.agentera/*.yaml` files first. If
all CLI paths fail, report that the CLI was unavailable, then use raw artifact
reads only as a fallback.

For bare `/agentera`, run `agentera hej` first and render the hej dashboard from
that single composite result. The CLI output is the data source, not the
user-facing dashboard; do not relay raw `agentera hej` lines as the final
briefing. Do not run individual `plan`, `progress`, `health`, `todo`, or
`decisions` commands unless `agentera hej` fails or explicitly asks for
fallback. For `/agentera <capability-name>`, run the top-level command or
commands named by that capability before opening raw artifacts. Reading a
capability's `prose.md` file is not itself a capability invocation; invocation
means routing to the capability, following its prose, and using the CLI state
layer first.

### Step 0: Upgrade guard

Before routing, check for an Agentera v1 install state. This is detection and
orchestration only; do not mutate anything without explicit user confirmation.

V1 state is present when any v1 Markdown artifact exists without its v2 YAML
counterpart, for example `.agentera/PROGRESS.md` without
`.agentera/progress.yaml`, `.agentera/PLAN.md` without `.agentera/plan.yaml`,
`.agentera/DECISIONS.md` without `.agentera/decisions.yaml`,
`.agentera/HEALTH.md` without `.agentera/health.yaml`,
`.agentera/SESSION.md` without `.agentera/session.yaml`, `.agentera/DOCS.md`
without `.agentera/docs.yaml`, or root `VISION.md` without
`.agentera/vision.yaml`.

If v1 state is found:

1. Report the affected files once in the briefing or response.
2. Run the dry-run preview through the no-clone CLI whenever shell access is
   available:
   `uvx --from git+https://github.com/jgabor/agentera agentera upgrade --project "$PWD" --dry-run`
3. If running inside a local Agentera checkout that has `scripts/agentera`, the
   equivalent local preview is:
   `uv run scripts/agentera upgrade --project "$PWD" --dry-run`
4. Ask the user before applying. Only after confirmation, run the same command
   with `--yes`. Never infer consent from the presence of v1 artifacts.

The dry-run preview is mandatory for v1 state detection. Do not replace it with
manual artifact inspection, hand-written migration steps, or raw YAML reads.
Only the apply step requires confirmation.

The upgrade command is idempotent. It installs or refreshes a durable bundle at
`~/.agents/agentera` when invoked through `uvx`, migrates v1 artifacts, wires
runtime config to that durable install root, and removes fixable stale v1
runtime artifacts. Package refreshes that run `npx skills remove` for v1 skill
entries and `npx skills add` for `/agentera` remain explicit opt-in via
`--update-packages`.

### Layer 1: Bare `/agentera` — delegate to hej

If the request is `/agentera` with no additional text, delegate immediately to hej. Hej performs state-aware routing by reading project artifacts (PLAN.md, TODO.md, HEALTH.md, etc.) and suggesting the most useful next capability. This is deterministic and never wrong.

### Layer 2: `/agentera <capability-name>` — direct route

If the request text exactly matches a capability name (case-insensitive, e.g., "resonera", "planera", "hej"), route directly to that capability without evaluating natural-language trigger patterns. This gives power users direct access and bypasses all NL matching.

### Layer 3: Natural language with high-confidence match

If the request is natural language (e.g., "help me think through this"), evaluate trigger patterns from capability schemas. Each trigger entry has a `priority` field (high, medium, low). Sum the priorities of all matched patterns per capability. If the highest-scoring capability meets the minimum threshold (medium or higher), route to it.

### Layer 4: Borderline match — disambiguation

If multiple capabilities score within the same priority tier (e.g., two capabilities both have high-priority matches), present a disambiguation prompt instead of silently choosing. List the matching capabilities with brief descriptions and ask the user to confirm or clarify.

### Layer 5: No match — fallback to hej

If no capability matches with sufficient confidence, route to hej for orientation. Hej handles greetings, status requests, and ambiguous inputs.

### Trigger Pattern Discovery

The trigger-to-capability map for Layers 3-4 is derived from schema files, not hardcoded here. To discover triggers:

```
For each capability directory in capabilities/:
  Read all YAML files in schemas/
  Extract the TRIGGERS group
  Collect all pattern strings and their priority from trigger entries
  Map each pattern to the capability name
```

This keeps the master SKILL.md thin: a dispatcher, not an encyclopedia. Adding a new capability means adding a directory with schemas; the routing logic adapts automatically.

### Trigger Pattern Discovery

The trigger-to-capability map is derived from schema files, not hardcoded here. To discover triggers:

```
For each capability directory in capabilities/:
  Read all YAML files in schemas/
  Extract the TRIGGERS group
  Collect all pattern strings from trigger entries
  Map each pattern to the capability name
```

This keeps the master SKILL.md thin: a dispatcher, not an encyclopedia. Adding a new capability means adding a directory with schemas; the routing logic adapts automatically.

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

All capabilities use a consistent exit vocabulary:

| Signal | Meaning | Exit code |
|--------|---------|-----------|
| complete | Task finished successfully | 0 |
| blocked | Cannot proceed, needs human input -- stuck | 0 |
| escalated | Issue exceeds capability scope, handoff needed -- flagged | 0 |
| partial | Task partially done, more cycles needed -- waiting | 0 |

---

## Cross-skill integration

The twelve-skill suite is collapsed into a single bundled skill. Each capability's schemas define cross-capability artifact references using stable IDs. Cross-capability routing is handled by the trigger pattern discovery mechanism described in the Routing Logic section. Capabilities read from and write to the same artifact store (`.agentera/` for agent-facing, project root for human-facing), so inter-capability data flows through shared artifacts, not direct invocation.

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
