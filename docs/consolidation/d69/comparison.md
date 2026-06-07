# D69 — surfaces and the invariant: comparison of four drafts

> Read-only comparison. None of the four drafts (`d69-a.md` through `d69-d.md`)
> is modified by this document. This comparison exists to support a single
> promotion decision: which of the four draft options becomes D69.

## Constraints (firm)

- **D67 (2026-06-05, firm).** Single brand everywhere. `@agentera/mobile` is
  the flagship product surface; `@agentera/{mobile,web,cli}` are product
  packages, not protocol layers. One product name; package READMEs carry
  surface-specific DX.
- **D68 (2026-06-05, firm).** Multi-surface product, one fixed workflow.
  "Agentera is one opinionated product delivered through multiple surfaces —
  the same twelve-capability workflow, `.agentera/` state, and built-in tools
  everywhere." No user extensions, plugins, MCP servers, or third-party skill
  loading on any surface. Skills and editor plugins are delivery surfaces for
  the same workflow, not extension hosts.

D69 is the question of what the load-bearing level is — what is shared across
surfaces and what is allowed to vary, given those two firm decisions. The four
drafts propose four different narrow waists:

- **A.** Capability schema is the invariant. Surfaces are thin I/O adapters
  around a shared agent.
- **B.** User journey (orient → plan → build → verify → close) is the
  invariant. Capability schemas and state shapes are surface-defined.
- **C.** `.agentera/` state contract is the invariant. Capability schemas are
  surface-defined; same trigger word, surface-resolved behavior.
- **D.** Brand is the only invariant. Surfaces are first-class products;
  capability rosters, schemas, workflows, and even state shape are
  surface-defined. Self-flagged as contradicting D68 by construction.

---

## Layer 1 — Axes matrix

Seven axes that matter for D69 given D67/D68. Polarity is mixed: for the
"fit" and "freedom" and "continuity" and "discoverability" rows, stronger is
better for the user; for "complexity" and "drift risk," weaker is better
(less to maintain, less to fragment). The matrix is read row by row; no
option dominates every axis, which is the point.

| Axis | A — schema | B — journey | C — state | D — brand only |
|------|------------|-------------|-----------|----------------|
| D68 "one fixed workflow" fit | strong | medium | weak | **rejects** (by construction) |
| D67 "single brand" promise | strong | strong (with effort) | medium | weak |
| Surface-native UX freedom | weak | strong | strong | strongest |
| Cross-surface continuity (state + behavior) | strongest | weak | medium | weak |
| Shared-contract complexity | high | low | medium | low |
| Capability drift risk | low | medium | high | highest |
| User discoverability | strong | strong | medium | weak |

### Read of the matrix

- **A (schema)** is the strongest fit for the D67/D68 promises and the
  weakest for surface-native UX. It pays the most in shared-contract
  complexity and accepts that "thin adapter" thins surface-specific
  flourishes.
- **B (journey)** trades capability parity for journey-level consistency.
  It is the loosest reading of D68's "same 12-capability workflow" line
  while preserving the strongest "this feels like one product" feel
  *per surface* — each surface is a real product with real affordances.
- **C (state)** is the most permissive of the four coherent drafts. It
  accepts behavioral divergence as a conscious trade for surface freedom
  and leans on the state contract as the only thing users can rely on
  across surfaces. It explicitly admits the central tension with
  D67/D68 in its own draft.
- **D (brand only)** is rejected by D68 contradiction. It is on the page
  as a pressure test and a cost benchmark, not as a live candidate while
  D68 is firm.

---

## Layer 2 — Sharpest tension per pair

For each pair, the single disagreement on which the two options would
give opposite answers. Not summaries; the question that splits them.

### A ↔ B — thin adapter vs. first-class product

When a surface wants to ship a substantively different version of a
capability (different defaults, different review cadence, different
level of autonomy), is that a **bug** (A: the capability schema is
invariant; surfaces that deviate are out of spec) or a **deliberate
product decision** (B: the surface is a first-class product and picks
its own behavior for each capability it ships)? A treats surfaces as
I/O adapters around a shared agent; B treats them as products that
share a journey.

### A ↔ C — behavior vs. shape as the contract

When a trigger word like `realisera` points to different observable
behavior across surfaces, is it **one capability with two
implementations** that must converge (A: schema enforces behavioral
parity) or **two capabilities bound to the same trigger word** with
no behavioral promise (C: state shape is the only contract; behavior
is per-surface by design)? A says behavior is the contract; C says
shape is the contract and behavior is explicitly allowed to diverge.

### A ↔ D — is the agent the product?

A: "The agent is the product. Surfaces are shells around the same
workflow." D: "The surface is the product. The agent is a feature of
the product." This is D68's "one fixed workflow" line in its sharpest
form. A honors it by construction; D rejects it by construction. The
two drafts disagree on what the user is buying.

### B ↔ C — journey vs. state as continuity substrate

When a user moves from mobile to CLI mid-build, what survives the
handoff — the **journey** (B: "I'm still in the build phase") or the
**state** (C: "I can pick up the artifact graph")? B says continuity
is the phase the user is in plus the vocabulary they're using; C says
continuity is the data on disk, regardless of which surface wrote it
or how. The two are not equivalent: B permits state re-derivation on
handoff; C permits behavior re-imagination per surface.

### B ↔ D — does the journey hold across surfaces?

Does the orient → plan → build → verify → close sequence hold across
every surface that calls itself Agentera (B: the journey is invariant;
surfaces may compress or merge but cannot drop a phase or invent
one) or is each surface free to design its own workflow (D: brand is
the only invariant; a "live pair" surface is welcome, as is a
"release calendar" surface)? B is a soft reading of D68's "one fixed
workflow"; D is a rejection of it.

### C ↔ D — does the state shape even hold?

Is the `.agentera/` artifact shape and meaning shared across surfaces
(C: state contract is the single narrow waist; capability schema is
per-surface) or can the state shape itself vary (D: only the directory
name and rough on-disk convention is shared; the schema, the field
names, the meaning are all per-surface)? C preserves a shared data
layer; D reduces the shared surface to the brand and the directory
name.

---

## Layer 3 — Recommendation

**Recommend D69-a — capability schema is the load-bearing level.**

D67/D68 force a narrow waist. D68's firm line — "the same
twelve-capability workflow, `.agentera/` state, and built-in tools
everywhere" — only fits one of the four drafts cleanly. D is
contradicted by D68 by construction; it earns its place on the page
as a pressure test and a cost benchmark, not as a live candidate. B
loosens "same workflow" to "same journey" and lets capability subsets
and behaviors vary per surface. C loosens it further to "same state
only" and explicitly admits in its own draft that "realisera does X
here but Y there" is the central tension with the firm constraints.
A is the only draft that keeps all three of D68's shared things —
workflow, state, tools — by sharing the capability schema that
produces them. A's open questions (conflict-resolution policy,
schema-location independence, in-flight run ownership) are resolvable
follow-up decisions, not contradictions with D67/D68; promote to
firm once the conflict-resolution policy and schema-location
questions are settled.

**On rejecting all four.** Rejection is not warranted. A is a clean
fit for the firm constraints; the open questions are not blocking,
and the trade-offs A accepts (thin adapters, schema coordination
cost, local-first sync) are the cost of D68 compliance, not flaws in
A itself. If the open questions in A turn out to be unresolvable
under D67/D68, the right next move is to reopen D68, not to
re-scope D69. Re-scoping D69 would only delay that decision.

### What this does not decide

Picking A does not decide:

- **Conflict-resolution policy** for `.agentera/` sync — per-artifact
  last-writer-wins, CRDT, or schema-defined merge function. This is
  A's largest unresolved cost and the most likely place the design
  will need to grow.
- **Schema location** — whether the schema stays coupled to
  `packages/cli` (its current home) or moves to a surface-neutral
  package that mobile and web can import without depending on the
  CLI. D58 forbids aliases in either direction.
- **In-flight run ownership** — what happens when a long-running
  realisera is initiated on CLI and the user closes the terminal, or
  when mobile backgrounds mid-step. The design promises continuity of
  task state, not continuity of process state; the ownership gap is
  real.
- **Cross-surface handoff UX** — explicit "continue on CLI" deep
  links from mobile vs. implicit pickup by any open surface with the
  project loaded.

These four follow-up decisions should be tracked alongside D69
promotion. None reopens the choice of invariant.

### Hybrid possibility (not a recommendation)

D69-c's "per-surface capability manifest" idea is a useful complement
to A if A's behavioral parity proves too restrictive in practice: a
manifest that declares what each trigger word means on each surface
would let A keep the schema as the contract while documenting the
small surface-specific divergences A otherwise forbids. This is not
a substitute for picking an invariant; it is a tool for the
implementation phase. Do not let it blur the choice between A, B,
and C.

---

## Source paths

- `docs/consolidation/d69/d69-a.md` — capability schema as invariant
- `docs/consolidation/d69/d69-b.md` — user journey as invariant
- `docs/consolidation/d69/d69-c.md` — state contract as invariant
- `docs/consolidation/d69/d69-d.md` — brand only, surface is primary
- `.agentera/decisions.yaml` — D67, D68 (firm); D65 (instructions.ts as
  source of truth), D58 (single-name boundary), D59 (unified prime
  control plane) all bear on the open questions above.
