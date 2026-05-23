# Documentation and file inventory

Maintainer inventory of repository documentation, workpapers, and legacy surfaces.
Authoritative Agentera docs live under `references/`, `skills/agentera/`, and root
guides — not under `docs/`.

**Last reviewed:** 2026-05-23

## Authority stack

| Layer | Location |
| --- | --- |
| Protocol | `skills/agentera/protocol.yaml` |
| CLI vocabulary authorities | `references/cli/*.yaml` |
| Vocabulary index (normalization, Decision 44) | `references/cli/vocabulary-index.yaml` |
| Human vocabulary index | `references/cli/vocabulary.md` |
| Benchmark contract | `references/analysis/startup-measurement-contract.yaml` |
| Benchmark runbook | `references/analysis/benchmark.md` |
| JSON surface budgets | `scripts/json_output_surface_manifest.yaml` |
| Project drafts | `docs/` (gitignored except `docs/README.md`) |

## `docs/` policy

`docs/` is for **non-authoritative** local notes only. Nothing under `docs/` ships
in the Agentera app bundle.

## Archived workpapers

| Archive path | Former location |
| --- | --- |
| `.agentera/archive/d47-app-home-vocabulary-inventory.md` | `docs/d47-app-home-vocabulary-inventory.md` |
| `.agentera/archive/d58-json-output-surface-inventory.md` | `docs/d58-json-output-surface-inventory.md` |
| `.agentera/archive/d59-json-output-budget-proposal.md` | `docs/d59-json-output-budget-proposal.md` |
| `.agentera/archive/d59-json-output-closeout-measurements.md` | `docs/d59-json-output-closeout-measurements.md` |
| `.agentera/archive/gap-analysis-2026-05-05.md` | `.agentera/gap-analysis-2026-05-05.md` |

Live JSON enforcement uses `scripts/json_output_surface_manifest.yaml` only.

## Remaining cleanup (see TODO.md)

- Replace live `SPEC.md` references in `UPGRADE.md`, hooks, adapter docs, `contract.md`
- Refresh or drop assertions against pre-migration characterization snapshots
- Agentera 3.0: remove `skills/hej/` bridge and `references/v1-section-mapping.md`
