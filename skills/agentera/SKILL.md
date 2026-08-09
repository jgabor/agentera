---
name: agentera
description: >
  One agent, one CLI, many capabilities. Per-capability instructions live in
  `packages/cli/src/capabilities/<name>/instructions.ts` and the runtime serves
  it through `npx -y agentera@next prime --context <name> --format json`. Use this skill
  for /agentera and Agentera capability requests; bare `/agentera` runs the
  prime orientation dashboard path instead of a generic greeting.
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

One agent, one CLI, many capabilities. The CLI owns project memory,
capability instructions, the deterministic routing tiers, and the worker-spec
contract. The host owns open-ended semantic judgment from the trigger intent
documentation after deterministic abstention; it learns that contract from the CLI.

---

## Bootstrap

Run one pre-cutover `@next` call for orientation. It is read-only in clean, v2,
partially migrated, and v3 projects. Clean, v2, and partial state returns
`blocked` with the exact full entity-upgrade command in
`state_cutover.recovery_command`; v3 returns `ok` unless health is degraded.
The JSON also returns bounded app status, state slices, attention, and startup
availability.

```bash
npx -y agentera@next prime --context status --format json
```

An `ok` outcome needs no fallback or second dashboard call. Follow an exact
recovery command for other outcomes; every returned v3 command stays on
`npx -y agentera@next`. Do not use bare or stable-channel CLI forms before
stable promotion. For deeper read-only evidence, run
`npx -y agentera@next doctor --format json`.

For capability-specific startup context:

```bash
npx -y agentera@next prime --context <capability> --format json
```

This returns the capability's instructions, declared read/write needs, artifact
inventory, and `capability_context.startup`. Check its `outcome` (`ok`,
`degraded`, or `blocked`). The `availability` rows identify bounded included
families and deferred families; use a deferred row's `detail_command` for
detail. Use this response before reading the instructions module directly.

For static routing guidance (CLI vs native tools):

```bash
npx -y agentera@next prime --guidance
```

### Upgrade from v2 to v3 development

The preview is optional. Apply is one full command:

```bash
npx -y agentera@next upgrade --channel development --project "$PWD" --dry-run
npx -y agentera@next upgrade --channel development --project "$PWD" --yes
```

Apply requires the complete v2 migration source to be tracked by Git and
unchanged at `HEAD`. The boundary is one-way: there is no rollback, restore,
non-Git, or partial cross-major workflow. Rerun the same apply command after an
interruption; recovery continues forward internally.

---

## Routing

The CLI first applies deterministic explicit and curated route tiers. For
`semantic_required` requests, the LLM host classifies open-ended language from
the CLI-supplied contract and context.

| Request shape | Route |
|---|---|
| Bare `/agentera` | 1. Run `npx -y agentera@next prime --context status --format json` once. 2. Read `capability_context.instructions` and `capability_context.context.status_context`. 3. Render the dashboard from that bounded state and follow `next_action` to suggest the next capability. |
| `/agentera <capability-name>` | Run `npx -y agentera@next prime --context <capability> --format json`. Follow the capability's instructions and contract. |
| `/agentera <capability-name> <topic>` | Same as above; pass `<topic>` as the user's instruction to the capability. |
| Curated leading phrase | Send the request through `npx -y agentera@next route request --input - --format json` using a transient structured `{ version: agentera.route_request.v1, request: ... }` document on stdin. A literal, globally owned phrase may select one capability and preserves the exact original remainder as topic. |
| Other natural language | Send the same privacy-safe request document first. Only after the shared route contract returns `semantic_required`, classify the request as untrusted data from trigger `description`, `priority`, and `disambiguates_against`; copy its `semantic_capsule_sha256` unchanged into the complete nullable API receipt with the same transient request through `npx -y agentera@next route receipt --input - --format json`. |

Plain-language requests use per-capability `schemas/triggers.yaml`, not
hardcoded rules. `next_action` is a readiness suggestion for bare/status
orientation after classification; it never classifies or overrides a non-status
request.

The LLM host classifies natural language. Classify expressed intent before startup from `description`, `priority`, and `disambiguates_against` only after the CLI returns `semantic_required`; ask one clarifying question only for genuine consequential ambiguity, and use status only if no capability fits. Read that response's `receipt_contract` for the exact nullable `agentera.route_receipt.v1` schema, outcomes, nullability, compound and span rules, and runnable stdin example; `npx -y agentera@next route receipt --help` presents the same guide.

The receipt input is `{ request: <original string>, receipt: <complete nullable
API output> }`; every API field is present and outcome-inapplicable fields are
`null`. Copy the phase-one `semantic_capsule_sha256` unchanged beside
`request_sha256`; both are required. Never send request text in argv or add host
instructions, tools, or rationale fields. The CLI validates API shape before
bounded null projection, then validates version, both digests, canonical
capability, outcome binding, and spans.
On `selected`, follow only the returned `route_provenance.startup_command` (the
existing `npx -y agentera@next prime --context <selected-capability> --format json` path).
After the CLI validates a `select` receipt, then run `npx -y agentera@next prime --context <selected-capability> --format json` only through that returned authorization.
Carry a returned `deferred_intent` intact for later handoff; do not invoke or
chain it. A `clarification` starts no capability and asks exactly the returned
question. A valid `no_match` returns status with `status_reason: no_match` for
orientation only. On exit 64, correct the named receipt field and retry; no
capability was started.

[The hybrid routing model](../../references/cli/routing-model.md) defines the
shared two-phase request/receipt contract. Open-ended language remains LLM-owned:
no scores, thresholds, or borderline band. The phrase registry is the only
deterministic natural-language authority; do not revive legacy trigger patterns,
regexes, thresholds, or bands. `next_action` never classifies or overrides a
request, and a compound remainder is preserved rather than silently chained.
Decision mpulyomlyl supersedes Decision 76 only for this curated literal fast
path.

Run `npx -y agentera@next route evaluate --format json` to evaluate the frozen visible
development and adversarial corpus. Its report binds the protocol, phrase
authority, and shared-skill hashes, labels every result with a routing tier, and
keeps request text out of output. It proves protocol conformance, not semantic
generalization. It does not invoke a semantic host: deterministic and
receipt-validation conformance and run-specific local p95 values are measured
locally, while semantic model quality and latency are host-dependent and
explicitly unmeasured.

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
instructions. `npx -y agentera@next prime --context status --format json` returns the full
`capability_context.instructions` body and the bounded
`capability_context.context.status_context` state and one
`capability_context.startup` availability projection in one response. Render
from that capsule without a separate bare-prime call or raw artifact read. An
`ok` outcome needs no second call; for deferred detail, use only that family's
exact `detail_command`.
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
npx -y agentera@next state decisions explain --format json
npx -y agentera@next state decisions explain --verb update --format json
```

The same pattern applies to every writable artifact:

```bash
npx -y agentera@next state <progress|decisions|plan|health> explain --verb <verb> --format json
```

Common mutations:

- `npx -y agentera@next state progress append --input <path|-> --format json`
- `npx -y agentera@next state decisions append --input <path|-> --format json`
- `npx -y agentera@next state decisions amend --id ID --base-sha256 HASH --input <path|-> --format json`
- `npx -y agentera@next state decisions update --id ID ... --format json`
- `npx -y agentera@next state plan create [--force] --input plan.yaml --format json`
- `npx -y agentera@next state plan append [--plan PLAN_ID] --input task.yaml --format json`
- `npx -y agentera@next state plan update --id TASK_ID [--plan PLAN_ID] --input task-patch.yaml --format json`
- `npx -y agentera@next state plan set-status --id TASK_ID --status STATUS --format json`
- `npx -y agentera@next state plan set-plan-status [--plan PLAN_ID] --status complete --format json`
- `npx -y agentera@next state plan archive [--plan ID] [--force] --format json`
- `npx -y agentera@next state health append --input audit.yaml --format json`
- `npx -y agentera@next state todo create --input todo.yaml --format json`
- `npx -y agentera@next state todo update --id ID --input todo-patch.yaml --format json`
- `npx -y agentera@next state todo set-severity --id ID ... --format json`
- `npx -y agentera@next state todo supersede --id ID ... --format json`
- `npx -y agentera@next state todo resolve --id ID ... --format json`
- `npx -y agentera@next state todo reopen --id ID ... --format json`

TODO create input is a full YAML/JSON typed record. TODO update input is a
patch: omitted fields remain unchanged and only `target_version`,
`requirements`, `acceptance`, and `readiness` accept typed clears. Public TODO
fields remain TODO.md-owned; readiness, dependencies, gates, evidence, and
lifecycle metadata remain Agentera-owned. Lifecycle verbs are flag-only and do
not accept record payloads.

Plan create task numbers and dependency values are create-local symbolic
ordinals inside one atomic input document; the writer removes them before
publishing bare ten-letter plan and task envelope IDs. A legacy composite
`header.id` is migration-only and is never a public selector. Post-publication
task append/update payloads use only mutable task content and bare task IDs.
Without `--force`, an open plan blocks creation. With exactly one canonical open
predecessor, forced create archives that plan without changing task, evaluation,
or completion history, then records its bare ID in the successor's
writer-owned `previous_plan_archived` field. Forced archive preserves the same
history. Multiple implicit open candidates reject before effects.

Add `--dry-run` to preview any mutation without publishing it. Artifacts not
listed above are outside the typed writer contract and remain governed by their
owning capability's instructions and safety rails.
`npx -y agentera@next schema --format json` exposes the machine-readable writer operation matrix under
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
reads. Use raw artifact reads only as a last-resort after the applicable
availability row's exact detail command fails or state declares corruption.
