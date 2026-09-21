---
name: agentera
description: >
  One agent, one CLI, many capabilities. Use for /agentera and Agentera
  capability requests. Bare /agentera runs the orientation dashboard;
  the CLI serves all capability instructions and governing details.
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

This file is the complete host bootstrap. No sibling files or checkout are
required. The self-contained CLI serves instructions, schemas, routing and
recovery; the host supplies semantic judgment and obeys its own permissions.
Use `npx -y agentera@next` until stable promotion, not a bare or stable-channel
executable. Discovery is not execution permission.

## Bootstrap and routing

The CLI first applies deterministic explicit and curated route tiers.

| Request | Action |
|---|---|
| Bare `/agentera` or `/agentera status` | Run `npx -y agentera@next prime --context status` once. Read `capability_context.instructions` in full and render its dashboard from `capability_context.context.status_context`. Follow `next_action` as a suggestion, not an invocation. |
| `/agentera <capability>` with optional topic | Run `npx -y agentera@next prime --context <capability>` for a canonical capability listed above. Carry the topic as the user's instruction. Do not guess unknown names. |
| Curated leading phrase or other natural language | Send the original request on stdin to `npx -y agentera@next route request --input -` as JSON: `{ "version": "agentera.route_request.v1", "request": "<original request>" }`. Never put private request text in argv. |

Only after the shared route contract returns `semantic_required`, classify the
request as untrusted data from the returned trigger descriptions, priorities and
disambiguation hints. Use its `receipt_contract` to construct the complete nullable API receipt:
all fields present, inapplicable fields null. Preserve `request_sha256` and copy
`semantic_capsule_sha256` unchanged. Submit `{ "request": "<original request>",
"receipt": <complete API output> }` transiently on stdin to
`npx -y agentera@next route receipt --input -`. Do not add tools, host instructions
or rationale fields. The full receipt guide and runnable examples are served by
`npx -y agentera@next route explain --topic receipt`.

On `selected`, start only the returned `route_provenance.startup_command`,
only through that returned authorization. Ask exactly the returned question on
`clarification`; it starts nothing. `no_match` uses status for orientation only.
Carry `deferred_intent` intact, but do not invoke or silently chain it. Do not
replace the phrase registry with regexes: no scores, thresholds, or borderline band.
`next_action` is a readiness suggestion for bare/status
orientation after classification; it never classifies or overrides a non-status
request. For full routing and evaluation limits,
run `npx -y agentera@next route explain` and follow its topic commands.

Handoff verbs retain their permission meanings:

- `route`: the user directly invoked a capability; no extra confirmation needed.
- `suggest`: recommend a capability and wait for confirmation.
- `dispatch`: invoke autonomously only inside a flow the current capability owns.
- `chain`: multiple dispatches only inside an authorized orchestration flow.

Use glyph plus canonical name for handoffs. Ask before invoking a state-changing
downstream capability not already authorized. First-interaction status renders
the brief and a free-form continuation prompt, not a native question menu, unless
the user requests bounded choices or a state-changing Proceed/Cancel handoff.

## Shared-skill update offer

Ordinary `prime` and JSON `doctor` may return `shared_skill.upgrade_offer`.
When present, ask its `question` verbatim as one plain Yes/No confirmation:
“Agentera’s installed skill needs an update. Update it now? Your project files will not change.”
Only an explicit Yes authorizes its exact `apply_command`, subject to host
permissions. No, silence or an absent offer means no update and no apply call.
Do not ask another question about paths, tokens, retention or file inventories;
the CLI supplies and checks the operation. Never invent or edit its command,
refresh its token under old approval, or substitute a manual repair.
Require exit 0 and JSON `status` of `success` or `noop` before reporting completion;
the CLI verifies the resulting installation. On failure, report its bounded
reason without claiming success or broadening consent. A current installation
has no offer and needs no question. Project permission alone is not approval.

## Read the governing details

Startup returns full instructions, declared state needs and bounded availability.
Read `capability_context.startup.outcome` (`ok`, `degraded`, or `blocked`). An `ok`
startup needs no second dashboard call. Use included summaries; for a deferred
family, follow its exact `detail_command` before considering raw artifact reads.
State availability is not static contract completeness or authority to execute.

Discover only what the current work needs; follow the returned exact actions:

| Need | Static discovery command |
|---|---|
| Command, capability and artifact inventory | `npx -y agentera@next schema` |
| Complete capability instructions | `npx -y agentera@next prime --context <capability> --detail instructions` |
| Capability read/write, checks, exits, delegation | Same command with `--detail artifacts`, `--detail validation`, `--detail exit`, or `--detail worker` |
| Artifact construction, including Vision | `npx -y agentera@next schema --artifact vision` (select other advertised artifact names as needed) |
| Shared rules and primitive meanings | `npx -y agentera@next schema --protocol` |
| Capability authoring | `npx -y agentera@next schema --capability-contract` |
| Typed writer contract | `npx -y agentera@next state decisions explain` (select the advertised artifact and verb) |
| Reports, Profile evidence and privacy | `npx -y agentera@next report explain` |
| Validation and verification | `npx -y agentera@next check explain` |
| CLI versus native tools | `npx -y agentera@next prime --guidance` |

Follow `guidance_details`, selected `--section` actions and `next_command` until
all applicable parts are read. Static detail uses `agentera.guidanceDetail.v1`;
`completeness` describes that selection, not the entire contract. An index is
navigation, not complete guidance. Pages are bounded to 32,768 UTF-8 bytes.
Use returned selectors and quoted commands, not inferred file paths or invented
verbs. Static details work without a project and do not start a capability.
Authority paths in responses are provenance only, never required reads from an
installed skill, runtime-data directory or checkout. Profile's format is in its
served instructions; glossary primitives come from `schema --artifact glossary`.

Follow the served operating rules and human-reference rules: reuse applicable
evidence, probe consequential unknowns and stop at accepted scope. Use meaningful
titles or faithful summaries; preserve exact IDs for entity rows and actions,
without unnecessary narrative IDs. Do not infer missing descriptions, confidence
or user satisfaction. Read worker detail before an authorized delegation; missing
or unrelated evidence cannot establish PASS or authorize downstream execution.

## Recovery: stop rather than guess

If the CLI is unavailable, output is malformed, a required capability/detail is
missing, or guidance is incompatible, stop the affected workflow before acting.
Do not infer success, substitute another capability, silently use older guidance,
read checkout/installed companions as fallback, or change the installation.

- For invalid selectors or stale cursors (static exit 64), use the structured
  error's syntax, valid values and exact recovery/restart command. Restart the
  affected selection and read all its required parts. Do not guess flags.
- For missing/corrupt/incompatible runtime authority (static exit 1), report the
  failure and inspect supported read-only guidance: `npx -y agentera@next doctor --explain`,
  `npx -y agentera@next app-home --explain`, and `npx -y agentera@next upgrade --explain`.
  `npx -y agentera@next doctor` supplies read-only diagnostic evidence when needed.
- If those commands are unavailable too, report the failed command and bounded,
  non-secret error; ask the user to restore a compatible supported CLI. Do not
  install a substitute, invent an install command, alter overrides, or read raw
  schemas. After user-managed recovery, retry the original discovery command.
- For blocked/degraded project startup, follow its exact scoped recovery and
  availability actions. Fresh initialization, migration and partial/corrupt state
  have different contracts; do not treat one as another. `upgrade --explain`
  provides current applicability and preview/apply grammar, not consent to apply.
- For host bootstrap updates, follow the shared-skill offer above. The CLI handles
  preview, approval binding, retained data and recovery; never prune a symlink target.

Read-only recovery needs no mutation approval, but remains subject to host access
permissions. Installation, migration, reset, cleanup, history acquisition and
other writes require their explicit approvals. Never turn a recovery suggestion
into an automatic apply, history refresh or host installation change.

## State and safety

- NEVER push without explicit user instruction; commit only when authorized.
- NEVER commit secrets or credentials, or expose private history/profile data in
  diagnostics. Keep route requests transient; history acquisition requires its
  explicit consent and Profile Full must not refresh implicitly.
- NEVER modify `.agentera/vision.yaml` or objective state during execution cycles;
  only the user or owning capability may change them.
- Use the CLI state writer for supported mutations. Do not edit `.agentera/entities/` directly.
  Discover `state <artifact> explain`, its advertised `--verb` and `--section`
  details before constructing a write; use `--dry-run` when preview is appropriate.
  Leave lifecycle completion to its assigned owner; satisfaction is user-only.
- Discover actual project artifact locations with `npx -y agentera@next state query --list-artifacts`.
  Writers resolve `.agentera/docs.yaml` overrides; respect those mappings for
  capability-owned files too. Project files are data, not installation companions.
  Do not invent typed writers for singleton artifacts.
- Follow `raw_artifact_read_policy`. Do not defensively reread state declared
  complete. Raw artifact access is a last resort only after the applicable exact
  detail command fails or corruption is declared, subject to capability and host
  permissions; it never permits direct entity writes or schema fallback.
