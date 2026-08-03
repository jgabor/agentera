# Trigger intent documentation contract

Authority for semantic-phase trigger intent documentation. This document
defines the trigger-schema fields a host consults only after the CLI
deterministically abstains, so it can make a semantic judgment and submit a
receipt. The fields are documentation, not inputs to a routing engine.

- **Authority path:** `references/cli/trigger-schema-enrichment.md`
- **Schema contract:** `skills/agentera/capability_schema_contract.yaml` (the
  contract loader at `packages/cli/src/registries/capabilityContract.ts` consumes it)
- **Trigger files:** `skills/agentera/capabilities/<name>/schemas/triggers.yaml`
- **Scope:** The semantic phase of the two-phase route contract. See
  `references/cli/hybrid-route-contract.yaml` for the authoritative precedence,
  abstention, receipt validation, and startup authorization rules.

## Current boundary and obsolete layer numbering

Earlier Decision 76 material described open-ended routing as Layer 3 and folded
the former Layer 4 into it. That layer numbering is obsolete; it is not another
routing model. The hybrid route contract now has one deterministic request phase
(bare, direct, and curated phrase selection) and one semantic receipt phase.

Only a `semantic_required` response may expose these fields to a host. The host
uses them to choose `select`, `clarify`, or `no_match`, then submits the complete
receipt. The CLI validates that receipt before authorizing capability startup.
`priority` and `disambiguates_against` are advisory semantic-judgment context,
not scoring weights. There is no scoring algorithm, confidence threshold,
borderline band, or `prime --route` output schema.

## 1. Field shape

The fields below are the LLM-readable intent documentation the host consults.
`description` and `priority` are base trigger fields required on every
`TRIGGERS` entry; `disambiguates_against` is an optional enrichment that gives
the host disambiguation words to surface when a request could match more than
one capability.

### 1.1 `description`

- **Type:** non-empty string (required on every `TRIGGERS` entry).
- **Meaning:** the semantic-judgment explanation of this capability's intent.
  After `semantic_required`, the host reads it to decide whether a request fits
  the capability. Prose that names the capability's purpose and request shapes
  reads better than keyword lists; write it for a reader who has never seen the
  capability before.
- **Validation failure:** a missing, empty, or non-string `description` fails
  validation with an error message naming the offending entry ID.

```
TRIGGERS:
  1:
    id: T2
    description: >-
      Audit local codebase health, architecture, quality, or technical debt.
    priority: high
    disambiguates_against:
      - capability: document
        hint: "audit owns code and architecture health; document owns documentation maintenance"
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
  confused with, with a hint the host consults after `semantic_required`. The
  list is advisory: the host resolves ambiguity and MAY surface the hint when
  asking the user to clarify. The hint supplies the words; the host supplies the
  judgment in a receipt the CLI validates.
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
  `description` when deciding which capability best fits a semantically
  abstained request. `high`
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
| Trigger fields are semantic-phase documentation; no scoring algorithm, thresholds, borderline band, or `--route` output schema | Current boundary, §1 |
| Deterministic precedence and validated receipt authorization remain singular | `hybrid-route-contract.yaml` |

## 4. Legacy enriched fields

`patterns`, `patterns_regex`, `confidence_threshold`, and `borderline_band`
remain accepted only so inherited enriched trigger files validate and load. They
are discarded by the loader: the active trigger model does not expose strings,
`RegExp` objects, scores, thresholds, or bands from them. The capability
validator validates their compatibility shapes; specifically, it validates the
numeric fields' integer 0..100 range, while the loader accepts and discards
their values. Do not add them to new active trigger entries. Their presence
cannot change a natural-language classification.

## Maintenance

- Maintainer: Agentera CLI maintainers
- Source checkout root: `.`
- Working directory: `.`
- Command: `node packages/cli/dist/bin/agentera.js check validate capability-contract --format json`
