# Five-layer routing model

Origin: Decision 76 (2026-06-30) — LLM-primary routing model. Retires the
deterministic NL routing engine and repositions the trigger schema as
LLM-readable intent documentation. Builds on the original five-layer concept
from Decision 42 (2026-05-04), redefining Layers 3-4 as LLM-native.

The Agentera routing model resolves incoming requests to a capability across
five layers. Layers 1, 2, and 5 are deterministic dispatch (bare invocation,
exact alias, no match); they are implemented and unchanged. Layers 3 and 4
cover natural-language requests. Per Decision 76, the LLM host — the AI model
that receives the user's message — owns natural-language routing natively. The
trigger schema (`description`, `disambiguates_against`, `priority`, phase
context) provides LLM-readable intent documentation the host consults; there is
no scoring engine, no confidence threshold, and no borderline band. Layer 4
(formerly borderline-band disambiguation) is dissolved into Layer 3: the LLM
resolves ambiguity natively, using `disambiguates_against` hints as advisory
context. Decision 75's request-vs-state mutual exclusivity is dissolved: request
intent and state-readiness are both advisory context the LLM consults.

## Layer 1: Bare `/agentera` or bare `hej` — delegate to prime

- **Input pattern**: the request is `/agentera` with no additional text, or the
  complete user message is exactly `hej`.
- **Action**: delegate immediately to the status capability. Status performs
  state-aware routing through the `agentera prime` composite result, which
  condenses project artifacts and suggests the most useful next capability.
  This is deterministic and never wrong. Bare `hej` must not be handled as a
  generic greeting.
- **Implementation status**: implemented and unchanged.

## Layer 2: capability name or `/agentera <primary-alias>` — direct route

- **Input pattern**: the request text exactly matches a capability name
  (case-insensitive), or exactly matches one primary alias from
  `capability_schema_contract.yaml` `ROUTE_ALIASES.primary_aliases`, or begins
  with a canonical capability name followed by more text (`/agentera <capability>
  <topic>`).
- **Action**: route directly to that capability without evaluating natural-language
  trigger descriptions. Pass any remaining text as the user's topic or instruction.
  Each capability has exactly one primary alias; secondary wording stays in
  capability trigger schemas below this layer.
- **Implementation status**: implemented and unchanged.

## Layer 3: Natural language — LLM-native routing

- **Input pattern**: the request is natural language (e.g. "help me think
  through this") that does not match Layer 1 or Layer 2.
- **Action**: the LLM host routes natively. It consults the trigger schema's
  `description` fields (what each capability does), `disambiguates_against`
  hints (how to tell near-equal capabilities apart), and `priority`
  (relevance precedence) as LLM-readable intent documentation, then selects a
  capability. There are no confidence scores, no thresholds, and no
  weighted-average computation; the LLM reads the intent descriptions and
  routes.
- **Resolving ambiguity**: when two capabilities could match a request, the
  LLM host resolves the ambiguity natively, surfacing the
  `disambiguates_against.hint` strings as advisory context when it asks the
  user to confirm or clarify. The hints supply the words; the LLM supplies the
  judgment.
- **Implementation status**: implemented — the LLM host owns this layer.
  `references/cli/trigger-schema-enrichment.md` is the intent documentation
  contract the host reads.

## Layer 4: Dissolved into Layer 3

Layer 4 formerly described a borderline-band disambiguation engine that fired
when two capabilities scored within a configurable band. Decision 76 retired
that engine: ambiguity resolution is now part of Layer 3, performed natively by
the LLM host using the `disambiguates_against` hints as advisory context. There
is no separate disambiguation layer, no borderline band, and no
disambiguation-engine output schema.

## Layer 5: No match — fallback to status

- **Input pattern**: the LLM host cannot map the request to any capability from
  the trigger schema's intent descriptions.
- **Action**: route to status for orientation. Status handles greetings, status
  requests, and ambiguous inputs.
- **Implementation status**: implemented and unchanged.

## Ownership boundaries

- **This document** defines what Layers 1-5 mean: their input patterns, actions,
  and implementation status.
- **`skills/agentera/capability_schema_contract.yaml`** (`ENTRY_SCHEMA.fields.priority`
  and `FIELD_RULES.TRIGGERS.priority`) defines trigger `priority` values
  (`high`, `medium`, `low`) as an advisory relevance-precedence hint the LLM host
  reads — not a scoring weight.
- **Per-capability `schemas/triggers.yaml`** owns the trigger `description`,
  `priority`, and `disambiguates_against` intent documentation that the LLM host
  consults for Layer 3 routing. `references/cli/trigger-schema-enrichment.md` is
  the intent documentation contract; pattern matching and scoring belong to
  neither, having been retired by Decision 76.
- **`skills/agentera/SKILL.md`** is the thin bootstrap routing surface per Decision
  74; it cross-references this document rather than restating the full model.
