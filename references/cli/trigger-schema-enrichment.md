# Trigger intent documentation contract

Authority for Layer 3 LLM-native capability routing. This document defines the
trigger-schema fields the LLM host consults to understand what each capability
does and how to disambiguate near-equal requests. The fields are documentation
the host reads, not inputs to a scoring engine.

- **Authority path:** `references/cli/trigger-schema-enrichment.md`
- **Schema contract:** `skills/agentera/capability_schema_contract.yaml` (the
  contract loader at `packages/cli/src/registries/capabilityContract.ts` consumes it)
- **Trigger files:** `skills/agentera/capabilities/<name>/schemas/triggers.yaml`
- **Scope:** Layer 3 (LLM-native natural-language routing) of the five-layer
  routing model. Layer 4 (formerly borderline-band disambiguation) is dissolved
  into Layer 3. Layers 1, 2, and 5 are unchanged.

## Decision 76 — repositioning

Decision 76 (2026-06-30) retires the deterministic NL routing engine. The LLM
host — the AI model that receives the user's message — owns natural-language
routing natively. This document is repositioned from a scoring-enrichment
contract to the **trigger intent documentation contract**: it defines the
`triggers.yaml` fields that help the LLM host understand what each capability
does and how to disambiguate near-equal requests.

The fields stay as documentation, not as scoring inputs. The LLM host reads the
descriptions and disambiguates natively; `priority` and `disambiguates_against`
are advisory hints, not scoring weights. There is no scoring algorithm, no
confidence threshold, no borderline band, and no `prime --route` output schema.
Decision 75's request-vs-state mutual exclusivity is dissolved: request intent
and state-readiness are both advisory context the LLM consults. Decision 76
supersedes Decision 75 design choices 2 (request-derived scoring as router), 4
(mutual exclusivity), and 5 (pure request-derived).

Decision 76 records the design choices and rejected alternatives (including the
tuning-the-engine and reposition-`--route` alternatives that were rejected).

## 1. Field shape

The fields below are the LLM-readable intent documentation the host consults.
`description` and `priority` are base trigger fields required on every
`TRIGGERS` entry; `disambiguates_against` is an optional enrichment that gives
the host disambiguation words to surface when a request could match more than
one capability.

### 1.1 `description`

- **Type:** non-empty string (required on every `TRIGGERS` entry).
- **Meaning:** the LLM-readable explanation of what this trigger entry routes to.
  The LLM host reads this to decide whether a natural-language request matches
  the capability's intent. Prose that names the capability's purpose and the
  request shapes it owns reads better than keyword lists; write it for a reader
  who has never seen the capability before.
- **Validation failure:** a missing, empty, or non-string `description` fails
  validation with an error message naming the offending entry ID.

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
```

### 1.2 `disambiguates_against`

- **Type:** list of mappings. Each entry MUST contain:
  - `capability` — string referencing a valid capability ID (one of the twelve
    English canonical IDs enumerated by `ROUTE_ALIASES.primary_aliases` in
    `capability_schema_contract.yaml`: `status`, `vision`, `discuss`, `research`,
    `plan`, `build`, `optimize`, `audit`, `document`, `profile`, `design`,
    `orchestrate`).
  - `hint` — non-empty string distinguishing this trigger's intent from the
    named capability on near-equal requests.
- **Meaning:** declares which other capabilities this trigger's intent could be
  confused with, with a hint the LLM host consults when it sees a request that
  could match more than one capability. The list is advisory: the LLM host
  resolves ambiguity natively and MAY surface the hint when asking the user to
  confirm or clarify. The hint supplies the words; the LLM supplies the
  judgment.
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

### 1.3 `priority`

- **Type:** string enum `high` | `medium` | `low` (required on every `TRIGGERS`
  entry).
- **Meaning:** advisory relevance-precedence hint the LLM host reads alongside
  `description` when deciding which capability best fits a request. `high`
  marks a capability that owns the request strongly; `low` marks a capability
  that is a plausible but weaker fit. It is not a scoring weight and feeds no
  weighted-average calculation; the LLM host uses it as one signal among the
  intent documentation.
- **Validation failure:** a missing `priority` or a value outside `high`,
  `medium`, `low` fails validation with the offending entry ID.

```
priority: high
```

## 2. Defaults summary

| Field | Required | Default when absent |
| --- | --- | --- |
| `description` | required | — |
| `disambiguates_against` | optional | empty list (no explicit collisions declared) |
| `priority` | required (`TRIGGERS`) | — |

`description` and `priority` are required on every `TRIGGERS` entry and have no
default. `disambiguates_against` is optional and defaults to an empty list. The
loader at `packages/cli/src/registries/capabilityContract.ts` is the consumer of
these shapes; tests and source that need them read through the loader rather than
re-declaring the values (per the AGENTS.md rule against duplicating
contract-owned values).

## 3. Acceptance criteria mapping

| Criterion | Section |
| --- | --- |
| `description` is a non-empty string on every `TRIGGERS` entry | §1.1 |
| `disambiguates_against` entries reference a valid capability ID and include a non-empty hint | §1.2 |
| `priority` is one of `high` / `medium` / `low` on every `TRIGGERS` entry | §1.3 |
| Document reframed as LLM-readable intent documentation; no scoring algorithm, thresholds, borderline band, or `--route` output schema | Decision 76, §1 |
| Decision artifact lists each choice, ≥1 alternative, and rationale | Decision 76 in `.agentera/decisions.yaml` |
