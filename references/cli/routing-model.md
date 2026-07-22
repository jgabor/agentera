# Hybrid routing model

The portable shared skill and CLI use one hybrid cascade. Curated, globally
unique literal phrases provide a small deterministic fast path; open-ended
language remains LLM-owned. The normative protocol is
[`hybrid-route-contract.yaml`](./hybrid-route-contract.yaml); this page is a
reader-oriented model, not a second contract.

Decision 76 remains in force for natural-language judgment. Decision mpulyomlyl supersedes it only for the curated literal fast path: there is still no scoring engine, no confidence threshold, and no borderline band. Legacy trigger patterns, regexes, thresholds, and bands do not route requests.

## Cascade and precedence

1. **Bare `/agentera`.** With no added text, select status deterministically.
2. **Explicit direct route.** A canonical capability name or primary alias uses
   the established direct-route grammar and passes its remaining text as topic.
3. **Curated leading phrase.** Match one active phrase from
   [`skills/agentera/route-phrases.yaml`](../../skills/agentera/route-phrases.yaml)
   only when it is the exact normalized leading phrase. It selects that phrase's
   sole owner and preserves the original remainder as topic.
4. **Deterministic abstention.** Every other request returns
   `semantic_required`. This tier never guesses from trigger prose, substrings,
   regexes, scores, thresholds, bands, state, or `next_action`.
5. **Validated semantic receipt.** The host makes an LLM-native semantic
   judgment and submits `select`, `clarify`, or `no_match`; the CLI validates it
   before capability startup. `select` starts one selected capability, `clarify` starts none, and `no_match` must route to status for orientation only after no capability matches.

The direct grammar has precedence over phrase matching. A phrase collision is a
registry validation error, not a tie to resolve at runtime.

## Phase one: route request

`agentera.route_request.v1` takes the transient original request. Its response
is exactly one of:

- `deterministic_selection`: a `bare`, `direct`, or `phrase` selection with
  capability, provenance, recognized span, and topic span.
- `semantic_required`: a request digest and semantic intent capsule. It does
  not start a capability.

The request itself is not persisted. The semantic capsule contains active
trigger `description`, `priority`, and `disambiguates_against` documentation,
not executable matcher inputs.

## Phase two: semantic receipt

For `semantic_required`, the host sends `agentera.route_receipt.v1` together
with the same transient original request. The receipt binds to the request's
SHA-256 digest. The CLI recomputes that digest and validates shape and outcome:

| Receipt | Required result | Startup |
| --- | --- | --- |
| `select` | one canonical capability and compound disposition | selected capability only |
| `clarify` | one non-empty question | none |
| `no_match` | no capability or question | status only |
| invalid | bounded field-level correction, exit 64 | none |

This is intentionally a shared CLI contract, not a runtime-specific adapter.
The portable shared skill is the sole host integration surface.

## Phrase, span, and topic behavior

The phrase registry owns stable IDs, capability ownership, literal phrases,
global collision detection, and deprecation. Per-capability trigger schemas
never create phrase ownership. Matching uses the contract's normalized token
view (Unicode NFKC, case folding, whitespace normalization) while returning
source UTF-16 offsets and slices from the original request.

For example, `HELP\tME decide: migrate the store` recognizes only
`HELP\tME decide`; its topic is the exact original `: migrate the store`.
The separator is deliberately preserved. Quoted, negated, later-in-sentence,
partial, and unregistered wording abstains; it belongs to the semantic phase.

## Selection, ambiguity, and compounds

The LLM host owns semantic selection and genuine consequential ambiguity. It
consults trigger intent documentation, then chooses one of `select`, `clarify`,
or `no_match`. A compound request never authorizes implicit chaining:

- A direct or phrase selection preserves its entire original remainder as one
  topic without interpreting it as follow-on work.
- A semantic `select` may mark one original remainder span `preserve`; it is
  deferred intent, not a second startup.
- Independent or consequential compound intent uses `clarify` when one primary
  capability cannot be named safely.

`next_action` informs readiness only after classification and cannot override the message intent. It never classifies a request.

## Evaluation and privacy

The frozen development, locked holdout, and adversarial partitions live in
[`fixtures/routing/hybrid-corpus.yaml`](../../fixtures/routing/hybrid-corpus.yaml).
They use synthetic or explicitly consented text only. Retained evaluation
evidence contains IDs, partition, outcome, tier, capability, timing, model
profile, and aggregate metrics; private raw request text, topic text, receipt
questions, and semantic rationale are absent by default.

The contract declares a reference-host profile, latency boundary, harmful
misroute taxonomy, and Task 5 acceptance targets. Those targets are not a claim
that the benchmark has run.

## Ownership boundaries

- `references/cli/hybrid-route-contract.yaml` owns protocol, outcome vocabulary,
  precedence, span rules, privacy, evaluation gates, and deprecations.
- `skills/agentera/route-phrases.yaml` owns the deterministic phrase inventory.
- `references/cli/trigger-schema-enrichment.md` owns semantic trigger intent
  documentation only.
- `packages/cli/test/registries/hybridRouteContract.test.ts` is the
  host-independent structural conformance owner until Tasks 3–5 add executable
  resolution and benchmark evidence.
- `skills/agentera/SKILL.md` remains the thin portable host integration surface.
