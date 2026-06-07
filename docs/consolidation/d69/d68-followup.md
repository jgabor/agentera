# D68 Follow-up: What does "one fixed workflow" mean?

> Open question surfaced by the D69 deliberation (2026-06-06). Four
> drafts (d69-a, d69-b, d69-c, d69-d) reached different verdicts because
> they interpreted D68's "one fixed workflow" claim differently. The
> choice between {a, b, c} cannot be made until this is resolved; d69-d
> is reachable only by revisiting D68 explicitly. Future resonera
> deliberations should start here.

## The question

D68 (2026-06-05, firm) committed Agentera to "one fixed workflow"
across all surfaces. D68 did not specify what "one fixed workflow"
means at the implementation level. Four interpretations are live.

## The four interpretations

### A — Behavioral identity

The same capability binary runs on every surface. Same `realisera`
produces the same artifact graph, same decision log, same exit signals.
The surface is a thin I/O adapter. **→ D69-a is the only valid choice.**

### B — Mental journey

The same 5-phase process (orient → plan → build → verify → close) is
expressed on every surface, but each surface may use different
capability subsets and surface-specific affordances. Behavioral
parity is not required. **→ D69-b is the cleanest fit.**

### C — State continuity

The same `.agentera/` YAML schema is shared across all surfaces, but
capability schemas and behaviors can differ per surface. The state is
the source of truth, not the workflow. **→ D69-c is the cleanest fit.**

### D — Brand only

"Workflow" was the wrong invariant. Agentera is a brand that ships
through multiple surfaces; each surface is a first-class product with
its own workflow, capability set, and behavior. **→ D69-d is the only
valid choice.** But this requires revising D68.

## What each interpretation implies

| If D68 means... | Then D69 must be... | And the conflict-resolution policy must be... |
| --- | --- | --- |
| A — behavioral identity | a | per-artifact last-writer-wins (or stronger) |
| B — mental journey | b | loose; design review catches drift |
| C — state continuity | c | strict on state schema; loose on capability behavior |
| D — brand only | (D68 is revised; D69-d follows) | per-surface local; no cross-surface continuity required |

## What the four D69 drafts said

- **d69-a** strictly reads D68 as A. Rejects the other interpretations.
- **d69-b** reinterprets D68 as B. Argues that "one workflow" can mean
  "one mental path" without forcing binary parity.
- **d69-c** reinterprets D68 as C. Argues that the state contract is
  the only true invariant.
- **d69-d** rejects D68's "one fixed workflow" claim outright. Argues
  the strictest reading of "same Agentera" actually weakens the product.

## Why the next deliberation starts here

The four D69 drafts cannot converge because the question they answer
depends on which interpretation of D68 is correct. Picking a D69
without first clarifying D68 is choosing the interpretation implicitly.

The next resonera deliberation should:

1. Decide which interpretation of D68 the user actually meant.
2. If interpretation A, B, or C: pick the matching D69 and refine it
   into a final D69 entry.
3. If interpretation D: revisit D68 explicitly, then promote d69-d.

## Cross-cutting follow-up (regardless of interpretation)

The conflict-resolution policy for parallel edits to shared state is
unresolved across {a, b, c} and must be decided alongside D69:

- Last-writer-wins (simple, lossy)
- CRDT (complex, lossless)
- Schema-defined merge function (per-artifact)

## Open sub-questions

- Is the answer to D68 a "yes, A", "no, I meant B", "no, I meant C",
  or "no, the question is wrong (D)"?
- Or is D68 correct as written, and the D69 work was the wrong
  question to ask?

## Confidence

open — the question is not yet decided.

## Status

This is a follow-up question, not a decision. No D69 promoted. The
D69 work and the four-way verdict are preserved in:

- `d69-a.md`, `d69-b.md`, `d69-c.md`, `d69-d.md` — refined drafts
- `comparison.md` — agentera subagent's side-by-side (recommends a)
- `deliberation-summary.md` — three-model agora verdict (no convergence)
- `agora-config*.yaml` — agora cast configs for replay
- agora transcripts at `~/.local/share/agora/transcripts/`, slug
  `which-d69-option-should-agentera-adopt-as-the-load`, disambiguated
  by timestamp.
