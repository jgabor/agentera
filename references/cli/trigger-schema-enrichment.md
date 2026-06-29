# Trigger schema enrichment contract

Authority for Layer 3-4 request-derived capability routing. This document
defines the optional fields a `triggers.yaml` entry MAY carry beyond the
existing `id`, `description`, `priority`, and `patterns` shape, the scoring
algorithm that combines pattern and regex matches into a confidence score, the
borderline-band disambiguation behavior, and the `prime --route` output schema
that is mutually exclusive with the state-derived `next_action`.

- **Authority path:** `references/cli/trigger-schema-enrichment.md`
- **Schema contract:** `skills/agentera/capability_schema_contract.yaml` (the
  contract loader at `packages/cli/src/registries/capabilityContract.ts` consumes it)
- **Trigger files:** `skills/agentera/capabilities/<name>/schemas/triggers.yaml`
- **Scope:** Layer 3 (trigger matching) and Layer 4 (disambiguation) of the
  five-layer routing model. Layers 1, 2, and 5 are unchanged.

The engine backing `prime --route` is a pure function:
`(input_text, trigger_schemas) -> routed_capability | disambiguation_candidates | fallback`.
No session state, no project state, no embedding model. Decision 75 records the
design choices and rejected alternatives.

## 1. Field shape

All fields in this section are OPTIONAL. A `triggers.yaml` file that omits every
new field remains valid (see §6 Backward compatibility) and the routing engine
applies the documented defaults for the absent fields.

### 1.1 `confidence_threshold`

- **Type:** integer, inclusive range `0` to `100`.
- **Meaning:** minimum confidence score required for this trigger entry to be
  considered a route match. A trigger whose computed confidence is below its
  threshold is not selected.
- **Contract default:** `50`, applied when the field is absent. The contract
  default is owned in `capability_schema_contract.yaml` so it is read through
  the loader rather than re-declared in source or tests.
- **Validation failure:** a value outside `0..100`, a non-integer, or a
  non-numeric value fails validation with an error message naming the valid
  range and the offending entry ID.

```
TRIGGERS:
  1:
    id: T2
    description: >-
      Audit and codebase health requests.
    priority: medium
    patterns:
      - "check code health"
      - "architecture review"
    confidence_threshold: 55
```

### 1.2 `disambiguates_against`

- **Type:** list of mappings. Each entry MUST contain:
  - `capability` — string referencing a valid capability ID (one of the twelve
    English canonical IDs enumerated by `ROUTE_ALIASES.primary_aliases` in
    `capability_schema_contract.yaml`: `status`, `vision`, `discuss`, `research`,
    `plan`, `build`, `optimize`, `audit`, `document`, `profile`, `design`,
    `orchestrate`).
  - `hint` — non-empty string distinguishing this trigger's intent from the
    named capability on near-equal scores.
- **Meaning:** declares which other capabilities this trigger's pattern set
  could collide with, with a hint the agent surfaces when disambiguation fires
  (see §4 Disambiguation). The list is advisory: the engine ALSO triggers
  disambiguation automatically when two capabilities score within the borderline
  band, whether or not this entry lists them.
- **Validation failure:** a `capability` value that is not one of the twelve
  canonical IDs, a missing `hint`, an empty `hint`, or an entry that is not a
  mapping fails validation with the offending entry ID and the constraint.

```
disambiguates_against:
  - capability: build
    hint: "vision refines existing project direction; build implements code"
  - capability: optimize
    hint: "vision is about what to build, not tuning existing code"
```

### 1.3 `patterns_regex`

- **Type:** list of strings. Each entry MUST be a valid regex (the loader
  compiles it; a compile failure is a validation error naming the entry and the
  offending pattern).
- **Meaning:** regex patterns for more precise matching than substring. The
  engine evaluates both `patterns` (substring) and `patterns_regex` (regex) on
  the same input; see §3 Scoring for how the two combine.
- **Anchoring:** patterns are matched with case-insensitive `find` semantics
  (substring-equivalent, no implicit anchoring). An author who wants anchoring
  writes it explicitly (e.g. `^audit\b`).

```
patterns_regex:
  - "\\brefine\\s+the\\s+vision\\b"
  - "update\\s+vision\\.yaml"
```

### 1.4 `borderline_band`

- **Type:** integer, inclusive range `0` to `100`.
- **Meaning:** per-trigger override for the disambiguation band. When the top
  two candidate capabilities score within `borderline_band` points of each
  other, the engine returns disambiguation candidates instead of a single match
  (see §4).
- **Contract default:** `15`, applied when the field is absent. Owned in
  `capability_schema_contract.yaml`.
- **Validation failure:** a value outside `0..100` or a non-integer fails
  validation.

## 2. Defaults summary

| Field | Required | Contract default when absent |
| --- | --- | --- |
| `confidence_threshold` | optional | `50` |
| `disambiguates_against` | optional | empty list (no explicit collisions declared) |
| `patterns_regex` | optional | empty list (substring-only matching) |
| `borderline_band` | optional | `15` |

The defaults live in `capability_schema_contract.yaml` so any test or source
that needs them reads through the loader rather than re-declaring the constants
(per the AGENTS.md rule against duplicating contract-owned values in tests).

## 3. Scoring algorithm

Confidence is computed per capability by aggregating the contributions of every
trigger entry in that capability whose threshold is met. The algorithm is a pure
function of `(input_text, trigger_schemas)`; it does not read project state.

### 3.1 Weights

- Priority weight (`W_PRIORITY`): `high = 1.0`, `medium = 0.7`, `low = 0.4`.
  These map the existing `priority` field onto a multiplier.
- Substrate weight: regex matches (`W_REGEX`) contribute more than substring
  matches (`W_SUBSTRING`). Concretely, `W_REGEX = 1.0` and `W_SUBSTRING = 0.6`.
  The asymmetry reflects that a regex hit is a stronger intent signal than a
  bare keyword substring.

### 3.2 Per-entry contribution

For a single trigger entry `T`:

```
substring_hits = count of T.patterns that appear as a case-insensitive substring
                of input_text (each pattern counted at most once)
regex_hits     = count of T.patterns_regex that match input_text
                (each pattern compiled once, matched with case-insensitive find)

W_T = W_PRIORITY[T.priority]
contribution_T = clamp01(
    (substring_hits * W_SUBSTRING + regex_hits * W_REGEX) /
    max(substring_hits + regex_hits, 1)
) * W_T * 100
```

- The weighted average inside `clamp01` keeps a single entry's contribution in
  `[0, 1]`: a trigger with only regex hits scores `1.0 * W_T * 100`, a trigger
  with only substring hits scores `0.6 * W_T * 100`, and a mix interpolates.
- `clamp01(x) = max(0.0, min(1.0, x))`.

### 3.3 Capability confidence

```
capability_confidence(C) =
    max over T in C.TRIGGERS where capability_confidence_T >= T.confidence_threshold
        of contribution_T
```

The capability's confidence is the maximum contribution among its qualifying
trigger entries (those whose entry contribution reaches their own threshold).
Taking the max, not the sum, keeps one strong pattern from being drowned by
many weak ones and keeps the score numerically comparable across capabilities
with different trigger counts.

### 3.4 `patterns` and `patterns_regex` combination

Both lists are evaluated independently on the same input. They combine
additively inside the weighted-average above (not via replacement): a trigger
that has both an `patterns` hit and a `patterns_regex` hit on the same input
scores between the substring-only and regex-only contributions, weighted toward
regex because `W_REGEX > W_SUBSTRING`.

### 3.5 No enriched fields

When a trigger entry has no `patterns_regex` and no `confidence_threshold`, the
algorithm reduces to the substring-only path with the contract default
threshold of `50`:

```
contribution_T = clamp01((substring_hits * 0.6) / max(substring_hits, 1)) * W_PRIORITY[T.priority] * 100
qualifies_T    = contribution_T >= 50   # contract default threshold
```

A single substring hit on a `high`-priority trigger yields `0.6 * 1.0 * 100 = 60`,
which clears the default threshold; the same hit on a `low`-priority trigger
yields `0.6 * 0.4 * 100 = 24`, which does not. This keeps the enriched engine
backwards-compatible with the bare keyword behavior the twelve schemas ship
today.

## 4. Disambiguation

### 4.1 When disambiguation fires

Given the per-capability confidence scores from §3, let `C_top` be the
highest-scoring capability and `C_second` be the next. Disambiguation fires
when BOTH:

1. `confidence(C_top) >= C_top.confidence_threshold` (the lead cleared its
   threshold — otherwise the result is fallback, see §5), and
2. `confidence(C_top) - confidence(C_second) <= borderline_band`, where
   `borderline_band` is `C_top`'s entry-level override if present, else the
   contract default `15`.

The band is read off the LEAD trigger entry of the top capability (the entry
that produced `C_top`'s score). A per-trigger `borderline_band` override lets an
author widen the band for a deliberately ambiguous trigger (e.g. `optimize`'s
high and medium triggers that share the word "optimize") or narrow it for a
trigger that should win decisively.

### 4.2 Disambiguation output

When disambiguation fires the engine returns the top two (or more, up to those
within the band) candidate capabilities with their scores and the
`disambiguates_against.hint` string for each, when the leading trigger declared
one:

```
candidates:
  - capability: vision
    confidence: 72
    hint: "vision refines existing project direction; build implements code"
  - capability: build
    confidence: 64
```

When no `disambiguates_against` hint exists for a candidate, the `hint` field is
omitted (not an empty string). Hints are surfaced to let the agent ask a
clarifying question rather than guess.

### 4.3 Per-trigger override interaction

The per-trigger `borderline_band` overrides the contract default only for the
lead trigger of the lead capability. It does not propagate to other
capabilities' triggers; each capability uses its own lead trigger's band (or
the contract default). This keeps the override local and predictable.

## 5. Fallback

When NO capability clears its own `confidence_threshold`, the engine returns
fallback to `status` (the holistic entry junction / orientation capability).
Fallback is the documented behavior for inputs that match no trigger; it is not
an error and the engine never returns an empty response or throws.

## 6. Backward compatibility

A `triggers.yaml` file that omits every enriched field MUST remain valid and
the routing engine MUST apply the documented defaults:

- `confidence_threshold` absent → contract default `50`.
- `disambiguates_against` absent → empty list (disambiguation still fires
  automatically when capabilities score within the band; the hints are simply
  omitted from the candidate output).
- `patterns_regex` absent → empty list (substring-only matching per §3.5).
- `borderline_band` absent → contract default `15`.

The existing validator (`agentera check validate capability <name>`) MUST pass
on every triggers.yaml that was valid before enrichment, with no schema change
required by the capability author. Enrichment is opt-in per trigger entry.

## 7. `prime --route` output schema

`agentera prime --route "<text>" [--format json]` invokes the Layer 3-4 engine
and returns request-derived routing output.

### 7.1 Output shape

```json
{
  "command": "prime --route",
  "status": "ok",
  "route": {
    "capability": "discuss",
    "confidence": 78,
    "fallback": false,
    "candidates": []
  },
  "input": "help me decide",
  "source_contract": {
    "engine": "layer-3-4",
    "spec": "references/cli/trigger-schema-enrichment.md"
  }
}
```

### 7.2 Field contract

| Field | Type | Meaning |
| --- | --- | --- |
| `command` | string | The command that produced the output (`prime --route`). |
| `status` | string | `"ok"` on any successful route — including fallback. |
| `route.capability` | string | Selected capability ID, or the top candidate when disambiguation fires, or `status` on fallback. |
| `route.confidence` | integer | The selected capability's confidence (0-100). On disambiguation this is the lead candidate's score. |
| `route.fallback` | boolean | `true` when no capability cleared its threshold and the engine fell back to `status`. Otherwise `false`. |
| `route.candidates` | array | Empty on a clean match or fallback. On disambiguation, the top two-or-more candidates with their `confidence` and optional `hint` (see §4.2). |
| `input` | string | The input text the engine scored. |
| `source_contract.engine` | string | `"layer-3-4"`. |
| `source_contract.spec` | string | Path to this document. |

### 7.3 Mutual exclusivity with `next_action`

`prime --route` output MUST NOT include the state-derived `next_action` field.
`--route` is a mutually exclusive mode:

- Without `--route`: `prime` returns the orientation dashboard including
  `next_action` (the state-derived recommendation cascade defined in
  `packages/cli/src/cli/orientation.ts:628-684` — PLAN pending → degrading
  health → active objective → TODO → stale health → decision follow-up → vision
  refresh).
- With `--route`: `prime` returns the request-derived `route` object above and
  suppresses the entire orientation dashboard, including `next_action`.

A consumer reading the `route` object never sees a `next_action` field in the
same payload; the two are never merged. This keeps request-derived routing
(what the user asked for) and state-derived routing (what the project needs)
as distinct modes with distinct output contracts.

### 7.4 Disambiguation example

`prime --route "refine the vision"` (the audit's flagged cross-capability
collision between `vision` T3 and `build` T4):

```json
{
  "command": "prime --route",
  "status": "ok",
  "route": {
    "capability": "vision",
    "confidence": 74,
    "fallback": false,
    "candidates": [
      { "capability": "vision", "confidence": 74, "hint": "vision refines existing project direction; build implements code" },
      { "capability": "build", "confidence": 69 }
    ]
  },
  "input": "refine the vision",
  "source_contract": { "engine": "layer-3-4", "spec": "references/cli/trigger-schema-enrichment.md" }
}
```

### 7.5 Fallback example

`prime --route "xyzzy nonsense"`:

```json
{
  "command": "prime --route",
  "status": "ok",
  "route": {
    "capability": "status",
    "confidence": 0,
    "fallback": true,
    "candidates": []
  },
  "input": "xyzzy nonsense",
  "source_contract": { "engine": "layer-3-4", "spec": "references/cli/trigger-schema-enrichment.md" }
}
```

## 8. Acceptance criteria mapping

| Criterion | Section |
| --- | --- |
| `confidence_threshold` is a 0-100 integer with documented contract default | §1.1, §2 |
| `disambiguates_against` entries reference a valid capability ID and include a hint string | §1.2 |
| `patterns_regex` entries are valid regex strings | §1.3 |
| `patterns` + `patterns_regex` combination with regex weighted higher than substring | §3.2, §3.4 |
| Borderline-band disambiguation with contract default and per-trigger override | §1.4, §4.1, §4.3 |
| `--route` output schema mutually exclusive with `next_action` (no `next_action` field) | §7.2, §7.3 |
| Triggers omitting all new fields still valid; engine applies defaults | §6, §3.5 |
| Decision artifact lists each choice, ≥1 alternative, and rationale | Decision 75 in `.agentera/decisions.yaml` |
