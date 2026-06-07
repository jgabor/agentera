# Decision 69 — Multi-surface invariant (deliberation archive)

> **Promoted firm** to `.agentera/decisions.yaml` on 2026-06-07 (resonera).
> This folder preserves the pre-promotion deliberation artifacts.

Decision 69 records which load-bearing invariant connects Agentera's surfaces
(CLI, mobile, web, editor runtimes) under D68's "one fixed workflow" claim.
**Chosen:** `packages/cli` as narrow waist (capability schema + `.agentera/`
state contract + execution routing); all surfaces are clients; editor-runtime
is one composite surface (skills + hooks + CLI). See decision 69 in
`.agentera/decisions.yaml` for the firm entry.

**Historical context:** [`d68-followup.md`](./d68-followup.md) — D68 interpretation
question resolved by D69 (behavioral identity / D69-a).

**Artifacts:**

- [`deliberation-summary.md`](./deliberation-summary.md) — four-way agora
  verdicts and folder index
- `d69-a.md` … `d69-d.md` — refined draft options
- [`comparison.md`](./comparison.md) — side-by-side comparison
- `agora-config*.yaml` — agora cast configs for replay

CLI ↔ mobile **connection tactic** (subprocess vs embedded vs serve) remains open
in [`mobile-open-decisions.md`](../mobile-open-decisions.md); D69 fixed the invariant.
