# Five-layer routing model

Origin: Decision 42 (2026-05-04) — five-layer routing model for request-to-capability
routing through the Agentera skill entry point.

The Agentera router evaluates incoming requests against the layers below in order.
Each layer defines an input pattern, the action the router takes, and its current
implementation status. Layers 1, 2, and 5 are implemented and unchanged; Layers 3
and 4 are being implemented by the Trigger Schema Enrichment and Layer 3-4 Routing
plan. `triggers.yaml` per capability owns the matching semantics for Layers 3-4;
this document defines what the layers mean, not how pattern scoring is computed.

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
  trigger patterns. Pass any remaining text as the user's topic or instruction.
  Each capability has exactly one primary alias; secondary wording stays in
  capability trigger schemas below this layer.
- **Implementation status**: implemented and unchanged.

## Layer 3: Natural language with high-confidence match

- **Input pattern**: the request is natural language (e.g. "help me think
  through this") that does not match Layer 1 or Layer 2, and the schema-owned
  matching semantics produce a single clear winner.
- **High-confidence match**: the top-scoring capability's confidence score is
  above the high-confidence threshold AND the gap between the top score and the
  next-best score is large enough that only one capability is a plausible route.
  A single clear winner with no competing match within the borderline band.
- **Action**: route to the matching capability and follow its trigger-schema
  semantics. No disambiguation prompt is shown because the match is unambiguous.
- **Implementation status**: in-progress — being implemented by the Trigger
  Schema Enrichment and Layer 3-4 Routing plan.

## Layer 4: Borderline match — disambiguation

- **Input pattern**: the request is natural language that does not match Layer 1
  or Layer 2, and the schema-owned matching semantics produce competing
  borderline matches rather than a single clear winner.
- **Borderline match**: two or more capabilities have confidence scores within
  the borderline band (scores close enough that no single capability is a
  plausible route on its own), and none of them exceeds the high-confidence
  threshold from Layer 3.
- **Action**: present a disambiguation prompt instead of silently choosing. List
  the matching capabilities with brief descriptions and ask the user to confirm
  or clarify.
- **Implementation status**: in-progress — being implemented by the Trigger
  Schema Enrichment and Layer 3-4 Routing plan.

## Layer 5: No match — fallback to status

- **Input pattern**: no capability matches with sufficient confidence.
- **Action**: route to status for orientation. Status handles greetings, status
  requests, and ambiguous inputs.
- **Implementation status**: implemented and unchanged.

## Ownership boundaries

- **This document** defines what Layers 1-5 mean: their input patterns, actions,
  and implementation status.
- **`skills/agentera/capability_schema_contract.yaml`** (`ENTRY_SCHEMA.fields.priority`
  and `FIELD_RULES.TRIGGERS.priority`) defines how trigger `priority` values
  (`high`, `medium`, `low`) feed routing confidence.
- **Per-capability `schemas/triggers.yaml`** owns the trigger patterns, priority,
  thresholds, fallback, and disambiguation metadata that the router evaluates for
  Layers 3-4. Pattern matching and scoring belong to those schemas, not here.
- **`skills/agentera/SKILL.md`** is the thin bootstrap routing surface per Decision
  74; it cross-references this document rather than restating the full model.

Implementation status for Layers 3-4 moves to `implemented` once the Trigger
Schema Enrichment and Layer 3-4 Routing plan lands the routing engine and
threshold metadata.
