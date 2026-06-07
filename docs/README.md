# Local drafts

This directory is for **non-authoritative** notes only: field triage (`notes.md`),
one-off reviews, and scratch material.

Authoritative Agentera documentation lives elsewhere:

| Topic | Location |
| --- | --- |
| Terminology index | [`references/cli/vocabulary.md`](../references/cli/vocabulary.md) |
| CLI vocabulary authorities | [`references/cli/`](../references/cli/) |
| Benchmark runbook | [`references/analysis/benchmark.md`](../references/analysis/benchmark.md) |
| Benchmark contract | [`references/analysis/startup-measurement-contract.yaml`](../references/analysis/startup-measurement-contract.yaml) |
| Doc inventory / cleanup tiers | [`references/meta/documentation-inventory.md`](../references/meta/documentation-inventory.md) |
| User guides | [`README.md`](../README.md), [`UPGRADE.md`](../UPGRADE.md), [`AGENTS.md`](../AGENTS.md) |
| Monorepo consolidation | [`docs/consolidation/monorepo-plan.md`](./consolidation/monorepo-plan.md) |
| Mobile product README | [`packages/mobile/README.md`](../packages/mobile/README.md) |

Authoritative exception: `docs/packaging/` is the design-doc home for the
v3 packaging contract (T1 of `.agentera/plan.yaml`). See
[`docs/packaging/v3-packaging.md`](./packaging/v3-packaging.md) for the v3
distribution surface contract (Bun single-binary, npm tarball, app-home
migration). The packaging design doc is referenced by the v3 cutover plan
and the T1 acceptance criteria.

Authoritative exception: `docs/consolidation/` is the design-doc home for the
product pivot and monorepo consolidation. See
[`docs/consolidation/monorepo-plan.md`](./consolidation/monorepo-plan.md) for
package layout, identity rules, capability aliases, completed docs pass, and
remaining application work (Decision 67).

Nothing else under `docs/` is packaged in the Agentera app bundle.
