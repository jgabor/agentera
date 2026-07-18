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
| Bare `/agentera` | 1. Run `agentera prime --context status --format json` once. 2. Read `capability_context.instructions` and `capability_context.context.status_context`. 3. Render the dashboard from that bounded state and follow `next_action` to suggest the next capability. |
| `/agentera <capability-name>` | Run `agentera prime --context <capability> --format json`. Follow the capability's instructions and contract. |
| `/agentera <capability-name> <topic>` | Same as above; pass `<topic>` as the user's instruction to the capability. |
| Natural language | Run `agentera prime --context status --format json` once. Read `capability_context.instructions` and `capability_context.context.status_context`; use `next_action.capability` to suggest the matching capability. If no high-confidence match, present a disambiguation prompt. |

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
instructions. `agentera prime --context status --format json` returns the full
`capability_context.instructions` body and the bounded
`capability_context.context.status_context` state in one response. Render from
that capsule without a separate bare-prime call or raw artifact read; use the
named recovery command when the capsule marks detail as omitted.
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
- For supported mutations, use the state writer; it resolves `.agentera/docs.yaml` path overrides and validates the published bytes
- For direct access to other agent-facing artifacts, respect `.agentera/docs.yaml` path overrides
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

## Artifact writes

The CLI state writer is the canonical mutation path for entity-backed state.
Every public record has `id` and `artifact`, lives in one writer-owned entity
file, and is retrieved through bounded `list` or exact `get --id` commands. Do
not edit `.agentera/entities/` directly. The writer assigns bare IDs, validates
records, publishes atomically, and supports filesystem-safe previews.

Discover the live contract before constructing a write:

```bash
agentera state decisions explain --format json
agentera state decisions explain --verb update --format json
```

The same pattern applies to every writable artifact:

```bash
agentera state <progress|decisions|plan|health> explain --verb <verb> --format json
```

Common mutations:

- `agentera state progress append ... --format json`
- `agentera state decisions append ... --format json`
- `agentera state decisions update --id ID ... --format json`
- `agentera state plan create --input plan.yaml --format json`
- `agentera state plan update|set-status --id ID ... --format json`
- `agentera state plan set-plan-status --id ID ... --format json`
- `agentera state plan archive --format json`
- `agentera state health append --input audit.yaml --format json`

Add `--dry-run` to preview any mutation without publishing it. Artifacts not
listed above are outside the typed writer contract and remain governed by their
owning capability's instructions and safety rails. `agentera schema --format
json` exposes the machine-readable writer operation matrix under
`state_writer` and on each writable `artifact_schemas[*].write_interface`.

---

## Artifact path resolution

The state writer resolves entity storage itself. Before directly reading or
writing an intentional singleton outside the writer contract, check whether
`.agentera/docs.yaml` maps it to another path. If no mapping exists, use the
default singleton layout:

- Human-facing artifacts at the project root: `TODO.md`, `CHANGELOG.md`, `DESIGN.md`
- Agent-facing singletons: `.agentera/docs.yaml` and `.agentera/vision.yaml`

Do not silently bypass the CLI and read raw entity files first. If
CLI state declares complete coverage, do not perform defensive raw artifact
reads. Use raw artifact reads only as a last-resort fallback after CLI
fallback commands fail or declare incomplete state.
