# D69 Deliberation Summary

> Four automated deliberations, four different winners. No decision
> promoted to DECISIONS.md. The choice between d69-a, d69-b, d69-c, and
> d69-d is genuinely contested and the human decision-maker must pick.

## Artifacts in this folder

- `d69-a.md` — capability schema as invariant (refined)
- `d69-b.md` — user journey as invariant (refined)
- `d69-c.md` — state contract as invariant (refined)
- `d69-d.md` — brand only, surface primary (refined)
- `d68-followup.md` — explicit D68 clarification question for the next
  resonera deliberation (start here)
- `comparison.md` — agentera subagent's side-by-side comparison
- `agora-config.yaml` — agora cast config (local/small baseline)
- `agora-config-large.yaml` — agora cast config (local/large variant)
- `agora-config-medium.yaml` — agora cast config (local/medium variant)

## Agora transcripts (managed by `agora` CLI)

Stored at `~/.local/share/agora/transcripts/`. The slug is the same
across all three (`which-d69-option-should-agentera-adopt-as-the-load`)
because the topic was identical; the timestamp disambiguates.

| Run | Timestamp         | Config                     | Model                           | Winner             | Confidence |
| --- | ----------------- | -------------------------- | ------------------------------- | ------------------ | ---------- |
| 1   | `20260606-073159` | `agora-config.yaml`        | `opencode-go/deepseek-v4-flash` | failed             | n/a        |
| 2   | `20260606-074032` | `agora-config.yaml`        | `local/small` (qwen3.5:2b)      | **d69-d**          | high       |
| 3   | `20260606-074736` | `agora-config-large.yaml`  | `local/large` (qwen3.6:35b)     | **d69-b**          | medium     |
| 4   | `20260606-080846` | `agora-config-medium.yaml` | `local/medium` (gemma4:12b)     | **d69-a OR d69-c** | medium     |

Run 1 failed because the original `opencode-go/deepseek-v4-flash` model
had insufficient balance. The user redirected to local models; runs 2,
3, and 4 used `local/small`, `local/large`, and `local/medium`
respectively. Run 1 is preserved for the failure trail.

Inspect with `agora list` or `agora show <slug>`.

## The four-way verdict

| Source                                  | Winner             | Confidence   | Why                                                                                                                                            |
| --------------------------------------- | ------------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Agentera subagent (`deepseek-v4-flash`) | **d69-a**          | (comparison) | Only option that honors D68's "one fixed workflow" without reinterpreting it.                                                                  |
| Agora `local/small` (qwen3.5:2b)        | **d69-d**          | high         | The 4 cast members converged on 5 points; the synthesis elevated d69-d as the only "coherent" brand-first path.                                |
| Agora `local/large` (qwen3.6:35b)       | **d69-b**          | medium       | The middle path: invariant 5-phase journey, per-surface capability subsets, no shared capability schema to maintain. d69-c was a close second. |
| Agora `local/medium` (gemma4:12b)       | **d69-a OR d69-c** | medium       | Refused to pick; the choice depends on whether D68 means behavioral identity (a) or state continuity (c).                                      |

The cast of 4 advocates (a, b, c, d) reached different consensus points
in each run. The small model found 5 points of agreement and elevated
d69-d. The large model found 5 different points of agreement and elevated
d69-b. The medium model found 2 points of agreement and refused to pick.

## What the deliberations agreed on (across all three)

- d69-d is the most divergent and requires revisiting D68; only the
  small model elevated it, and only by arguing that D68 itself is
  revisable.
- d69-b and d69-c are the middle ground; they relax "same workflow" to
  "same mental phase" or "same state" respectively.
- d69-a is the strictest read of D68; the comparison and the medium
  model preferred it, the small model rejected it, the large model
  noted its high coordination cost.
- The `.agentera/` directory convention should be shared across all
  surfaces — every deliberation surfaced this.
- The conflict-resolution policy for parallel edits to shared state
  remains unresolved across all options that require state sync — a
  real follow-up regardless of which D69 is chosen.

## What this means for the human decision-maker

- No automated deliberation has converged on a single winner.
- The strongest signal: d69-a OR d69-c if D68 is taken strictly, d69-b
  if D68 is reinterpreted, d69-d only if D68 is revisited.
- The cross-cutting open question (per all four sources): the
  conflict-resolution policy for parallel edits to shared state must
  be decided before any of {a, b, c} can ship.
- Recommend: pick between {a, b, c} and add a follow-up decision for
  the conflict-resolution policy. d69-d is reachable only by revisiting
  D68 first; if D68 is firm, d69-d is rejected by construction.

## D68 follow-up

The four-way disagreement is not noise — it points at a real
ambiguity in D68. The next resonera deliberation should start with
`d68-followup.md`, not the four D69 drafts. Specifically:

- D69 cannot be picked without first clarifying D68.
- D68 is firm on "one fixed workflow" but does not specify at what
  level (binary behavior, mental journey, state shape, or brand).
- The four D69 drafts each interpret "one fixed workflow" differently,
  which is why they reach different verdicts.
- The follow-up also names the conflict-resolution policy for
  parallel state edits as a cross-cutting open question that must be
  decided alongside D69.

`d68-followup.md` is structured for a future resonera deliberation to
pick up: it states the question, lists the four interpretations, shows
what each implies, and lays out the decision path (pick the
interpretation, then pick the matching D69, or revise D68 first if
interpretation D).

## Status

**Decision 69 promoted firm** (2026-06-07, resonera). Chosen invariant:
`packages/cli` narrow waist (D69-a/E); D68 interpretation A; OpenCode-like
Layer A+B; editor-runtime composite surface; presentation-only mobile tiering.
See `.agentera/decisions.yaml` number 69. This folder preserves pre-promotion
drafts and agora transcripts.
