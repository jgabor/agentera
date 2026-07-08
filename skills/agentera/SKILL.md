---
name: agentera
description: >
  One agent, one CLI, many capabilities. Per-capability instructions live in
  `packages/cli/src/capabilities/<name>/instructions.ts` and the runtime serves
  it through `agentera prime --context <name> --format json`. Use this skill
  for /agentera and Agentera capability requests; bare `/agentera` runs the
  agentera prime orientation dashboard path instead of a generic greeting.
version: "3.0.0"
spec_sections: [1, 2, 3, 4, 5, 6, 11, 13, 18, 19, 20, 22, 23]
capabilities:
  - status
  - vision
  - discuss
  - research
  - plan
  - build
  - optimize
  - audit
  - document
  - profile
  - design
  - orchestrate
---

# agentera

One agent, one CLI, many capabilities. The CLI is the routing brain — it owns
project memory, capability instructions, routing judgment, and the worker-spec contract.
The host agent learns one contract: the CLI.

---

## Bootstrap

Run `agentera prime` for orientation. The JSON it returns is the complete
contract — app status, state slices, attention items, next action, and the
source contract that declares what's complete and what requires fallback.

```bash
npx -y agentera prime
```

For capability-specific startup context:

```bash
npx -y agentera prime --context <capability> --format json
```

This returns the capability's instructions, declared read/write needs, artifact
inventory, included/missing state, and fallback commands. Use it before
reading the instructions module directly.

For static routing guidance (agentera vs native tools):

```bash
npx -y agentera prime --guidance
```

---

## Routing

The CLI routes. The host agent follows.

| Request shape | Route |
|---|---|
| Bare `/agentera` | 1. Run `agentera prime --format json` for state data. 2. Run the `fetch_command` from `source_contract.capability_context` to get rendering instructions. 3. Follow `capability_context.instructions` for dashboard template, field rules, and exit marker. 4. Render the dashboard from the state data per the instructions. 5. Follow `next_action` to suggest the next capability. |
| `/agentera <capability-name>` | Run `agentera prime --context <capability> --format json`. Follow the capability's instructions and contract. |
| `/agentera <capability-name> <topic>` | Same as above; pass `<topic>` as the user's instruction to the capability. |
| Natural language | Run `agentera prime --format json`. Run the `fetch_command` from `source_contract.capability_context` for rendering instructions. Use `next_action.capability` to suggest the matching capability. If no high-confidence match, present a disambiguation prompt. |

Capability names are the routing identity: `status`, `vision`, `discuss`,
`research`, `plan`, `build`, `optimize`, `audit`, `document`, `profile`,
`design`, `orchestrate`. Plain-language triggers (`help me decide`, `what's
next`, `plan this`) match against each capability's `schemas/triggers.yaml`,
not hardcoded here.

The full five-layer routing model (Decision 42) — Layer 1 bare `/agentera`,
Layer 2 capability/alias direct route, Layer 3 high-confidence natural-language
match, Layer 4 borderline disambiguation, Layer 5 no-match fallback to status —
is defined in [`references/cli/routing-model.md`](../../references/cli/routing-model.md).
Layers 1, 2, and 5 are implemented; Layers 3 and 4 are being built by the Trigger
Schema Enrichment and Layer 3-4 Routing plan.

Handoff verbs:

- `route`: user directly invoked a capability. Consent to invoke; no extra confirmation.
- `suggest`: recommend a downstream capability and wait for confirmation.
- `dispatch`: invoke another capability autonomously only when the current capability owns that orchestration flow.
- `chain`: dispatch multiple capabilities only inside an orchestrated flow.

Capability handoffs use glyph plus canonical name (e.g. `⧉ build`, `≡ plan`).

---

## Dashboard rendering

The prime dashboard rendering contract — template, field-by-field rules, output
budget, attention-item ordering, exit marker — is owned by the status capability
instructions. Bare `agentera prime --format json` returns a pointer at
`source_contract.capability_context` with a `fetch_command` to retrieve them;
run it, then follow `capability_context.instructions` for layout,
inclusion/exclusion rules, and the mandatory `⌂ status · <status>` exit marker.
Ask for confirmation before invoking a state-changing downstream capability.

The first response in a fresh interaction delivers the brief and a free-form
continuation prompt, not a native question menu — unless the user explicitly
asks for bounded choices or the suggested next step is a state-changing
Proceed/Cancel handoff.

---

## Safety rails

<critical>
- NEVER push to remote repos without explicit user instruction
- NEVER modify `.agentera/vision.yaml` or objective state during execution cycles (only the user or the owning capability may change these)
- NEVER commit secrets or credentials to any artifact or file
- Respect artifact path resolution: check `.agentera/docs.yaml` for path overrides before accessing any agent-facing artifact
</critical>

---

## Capabilities

| | Capability | Primary route | Purpose |
|---|---|---|---|
| ⌂ | status | `/agentera status` | Orientation and routing |
| ⛥ | vision | `/agentera vision` | Define project direction |
| ❈ | discuss | `/agentera discuss` | Structured deliberation |
| ⬚ | research | `/agentera research` | External pattern analysis |
| ≡ | plan | `/agentera plan` | Planning with acceptance criteria |
| ⧉ | build | `/agentera build` | Autonomous development |
| ⎘ | optimize | `/agentera optimize` | Metric-driven optimization |
| ⛶ | audit | `/agentera audit` | Codebase health audit |
| ▤ | document | `/agentera document` | Documentation |
| ♾ | profile | `/agentera profile` | Decision profiling |
| ◰ | design | `/agentera design` | Visual identity system |
| ⎈ | orchestrate | `/agentera orchestrate` | Multi-cycle orchestration |

---

## Artifact path resolution

Before reading or writing any artifact, check if `.agentera/docs.yaml` exists.
If it has an Artifact Mapping section, use the path specified for each canonical
filename. If `.agentera/docs.yaml` doesn't exist or has no mapping for a given
artifact, use the default layout:

- Human-facing artifacts at the project root: `TODO.md`, `CHANGELOG.md`, `DESIGN.md`
- Agent-facing artifacts in `.agentera/` as YAML: `progress.yaml`, `decisions.yaml`, `health.yaml`, `plan.yaml`, `docs.yaml`, `vision.yaml`, `objective.yaml`, `experiments.yaml`

Do not silently bypass the CLI and read raw `.agentera/*.yaml` files first. If
CLI state declares complete coverage, do not perform defensive raw artifact
reads. Use raw artifact reads only as a last-resort fallback after CLI
fallback commands fail or declare incomplete state.
