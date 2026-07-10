# Capability instruction structure

Origin: Decision 80 (2026-07-06) — Six-section spine for capability instructions.
Builds on D79 (status rewrite, direct-contract philosophy), D71 (RFC 2119 modal
vocabulary), D72 (bundle-to-app terminology), D57/D65 (instructions.ts as
canonical module served via `agentera prime --context`).

Agentera's 12 capability instruction files (`packages/cli/src/capabilities/<name>/instructions.ts`)
MUST follow a shared six-section spine. Five sections are shape-constrained; one
(Workflow phases) is mandatory-as-section but free-form in content. This document
owns the spine spec, the five workflow shapes taxonomy, and the per-capability
deviation table filled incrementally as each audit completes.

---

## The six-section spine

Every capability instructions.ts MUST contain these six sections in order:

### 1. Purpose

One paragraph stating what the capability does, plus the capability glyph
(SG1-SG12). Shape-constrained: glyph plus one-paragraph purpose. No sub-sections.

### 2. State artifacts

What the capability reads, writes, and consumes. Shape-constrained:
reads/writes/consumes declarations plus artifact path resolution. Per-capability
artifact-schema subsections allowed (e.g., vision's `vision.yaml shape`, document's
`docs.yaml shape`, design's `DESIGN.md format`).

### 3. Workflow phases (mandatory section, free-form content)

The per-capability core. The section MUST exist and MUST be named "Workflow phases"
or a per-capability equivalent that names the workflow shape (e.g., "The orchestration
loop", "The cycle", "Briefing", "Running state"). Internal structure is per-capability:
linear steps, conversational loop, cycle-based, mode-split, or multi-surface. See
the five workflow shapes taxonomy below.

### 4. Safety rails

`<critical>` block with MUST NOT / NEVER rules. Protocol-bound. Shape-constrained:
MUST start with `<critical>` tag, MUST use D71 RFC 2119 modal vocabulary for
protocol-force rules.

### 5. Exit signals

EX1-EX4 conditions with the capability's canonical glyph marker. Protocol-bound.
Shape-constrained: MUST list all four exit conditions, MUST use the
`<glyph> <capability> · <status>` marker format.

### 6. Cross-capability integration

Feeds-into, triggers, and informed-by declarations, plus getting-started use-case
examples (when to invoke this capability from other contexts). Shape-constrained:
MUST be present; depth is per-capability (status = one paragraph; orchestrate =
substantial surface descriptions). Invocation guidance ("Before a build session,
run `/agentera discuss`") folds into this section as the inverse of
feeds-into/triggers — same relationship, consumer perspective.

---

## Flex sections (per-capability optional)

Domain content sections MAY appear between spine sections when the capability has
capability-specific content that does not fit the spine (e.g., design: Colors and
Typography; profile: PROFILE.md template; research: deliverable template). These
are rare and documented in the deviation table below.

---

## Five workflow shapes taxonomy

Capabilities declare their workflow shape at the top of the Workflow phases section
so the deviation table can classify them:

| Shape | Capabilities | Structure |
|---|---|---|
| **Linear** | status, research, audit | Step N then Step N+1; one-shot progression |
| **Conversational loop** | discuss | Scratchpad plus per-turn question loop; no linear progression |
| **Cycle-based** | build, optimize | Iterative cycle with hypothesis/task/constraints; repeat until done |
| **Mode-split** | vision, document, profile, design, plan | Step 0 detect mode then mode-A / mode-B / mode-C |
| **Multi-surface** | orchestrate | Multiple surface templates with different structures per surface |

---

## Reference implementation

Status (D79) is the reference implementation. Its structure:

1. **Purpose**: header plus glyph plus one-paragraph purpose plus direct-contract rule
2. **State artifacts**: source_contract.capability_startup delegation rule (lean on
   the contract; do not re-encode machine-readable rules in prose)
3. **Workflow phases**: Dashboard rendering then Briefing then Routing suggestion
   (linear shape, three phases)
4. **Safety rails**: six MUST NOT rules in `<critical>` block
5. **Exit signals**: EX1-EX4 with `⌂ status · <status>` marker
6. **Cross-capability integration**: one paragraph (status has no
   getting-started use-case examples to fold in)

Prose length: 10,389 chars. Modal vocabulary: 5 MUST, 5 MUST NOT. No v2-era residue.

---

## Per-capability deviation table

Filled incrementally as each audit completes. "Not audited" = not yet audited
against D80 plus this reference doc.

| Capability | Shape | Length | D71 modal | D72 terms | Direct contract | Deviations | Audit |
|---|---|---|---|---|---|---|---|
| ⌂ status | Linear | 10,389 | Yes | Yes | Yes | None | Complete (D79) |
| ⛥ vision | Mode-split | 16,667 | Yes | Yes | Yes | Has vision.yaml shape subsection; shared pre-write self-audit hoist (DRY between Create and Refine modes) | Complete (D81) |
| ❈ discuss | Loop | 12,045 | Yes | Yes | Yes | Has decisions.yaml shape subsection; Getting started folded into §6; loop shape named "The deliberation loop" (§3); fog-aware readiness check at Done; steering rules (breadth-first, ask-user-to-sketch); schema files use artifact-id labels not canonical filenames | Complete (D82) |
| ⬚ research | Linear | 12,484 | Yes | Yes | Yes | Has deliverable template; has transferable concepts checkpoint between source reading and target exploration; runtime-agnostic tool references | Complete (D83) |
| ≡ plan | Mode-split | 14,515 | Yes | Yes | Yes | Has skip/light/full modes; `unknowns:` and `rejected:` full-plan fields; `How build reads PLAN.md` removed (artifact read contract declared in §2 only); fog-check at handoff; replan trigger qualitative (surprises on one task alter downstream acceptance); Getting started folded into §6; YAML formats reordered intent-first | Complete (D84) |
| ⧉ build | Cycle | 15,081 | Yes | Yes | Yes | Has Handling blocked work; vision bootstrap folded into Workflow phases; brainstorm cut to minimal fallback; subagent spawning table cut to brief pointer; self-audit folded into Log (8 steps); plan unknowns consumption; cycle boundary stated once; `/loop` replaced with explicit user request | Complete (D85) |
| ⎘ optimize | Cycle | 20,622 | Yes | Yes | Yes | Has Handling blocked experiments; self-audit folded into Log (7 steps); subagent spawning table compressed (D85 propagation); benchmark context lean seam; experiments.yaml has context block; brainstorm stripped to 4 questions | Complete (D86) |
| ⛶ audit | Linear | 31,313 | Not audited | Not audited | Not audited | Has finding taxonomy plus health.yaml write; Steps 1-7 | Not audited |
| ▤ document | Mode-split | 21,779 | Not audited | Not audited | Not audited | Has closeout context startup; has docs.yaml shape | Not audited |
| ♾ profile | Mode-split | 24,219 | Not audited | Not audited | Not audited | Has PROFILE.md template; has Notes on depth vs speed | Not audited |
| ◰ design | Mode-split | 20,596 | Not audited | Not audited | Not audited | Has Colors/Typography domain content; has DESIGN.md format | Not audited |
| ⎈ orchestrate | Multi-surface | 28,544 | Not audited | Not audited | Not audited | Has three surface templates; has Keeping the orchestrator lean | Not audited |

---

## Cross-cutting rules (apply to all 12)

These rules are inherited from prior decisions and are not re-stated per capability:

- **D71**: RFC 2119 modal vocabulary (MUST, MUST NOT, SHOULD, SHOULD NOT, MAY).
  Capitalized keywords carry protocol force; lowercase modal verbs are ordinary English.
- **D72**: `app.*` terminology (not `bundle.*`).
- **D79 direct-contract philosophy**: lean on `source_contract.capability_startup`;
  the prose MUST NOT re-encode rules the contract mechanizes (forbidden-command lists,
  fallback ladders, do-not-read-raw-yaml warnings). If `complete_for_capability_startup`
  is true, the prose trusts the contract.
- **D57/D65**: instructions.ts is the canonical module, served via
  `agentera prime --context <name> --format json`.
- **Artifact path resolution**: SKILL.md owns the host-bootstrap artifact-path
  resolution; capability prose delegates (status proved this in D79).
- **Procedural recovery content**: lives in the owning capability, not the consuming
  one (status renders `project_integration` fields; upgrade/doctor owns the repair
  procedure).
