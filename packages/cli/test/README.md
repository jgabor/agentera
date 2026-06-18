# CLI test layer policy

**Migration complete (2026-06-18):** tasks 2–5 moved all mutable-state vitest couplings to
`fixtures/repo-state/` via `useFixtureProject`. Vitest no longer reads or mutates live
`.agentera/*` or `TODO.md` from `REPO_ROOT`.

Vitest proves **logic** with temp dirs and pinned fixtures. **Live-repo artifact hygiene**
(compaction budgets, committed artifact shape) is owned by `agentera check compact` in CI
and lefthook — not duplicated as vitest assertions against this checkout's `.agentera/` or
`TODO.md`.

| Layer | Proves | Entry point |
| ----- | ------ | ----------- |
| Vitest | Hook/CLI behavior from fixtures and tmp project trees | `pnpm -C packages/cli test` |
| Repo-state fixtures | Pinned `.agentera/` + `TODO.md` variants via `useFixtureProject(name)` | `packages/cli/test/fixtures/repo-state/` |
| Repo gate | Committed `.agentera/*` and `TODO.md` within `uniform_10_40_50` | `pnpm -C packages/cli build && node packages/cli/dist/bin/agentera.js check compact` |
| Release gate | Version-bearing surfaces aligned (registry, package.json, bundle sentinel) | `releaseMetadata.test.ts` live-repo describe (gate-deferred) |

## Classification key

| Class | Meaning |
| ----- | ------- |
| **mutable-state** | Reads or mutates live session artifacts (`.agentera/*`, `TODO.md`) whose content changes with capability runs — vitest must not depend on them (migrate to `fixtures/repo-state/`). |
| **static-contract** | Reads checked-in repo sources (`skills/`, `references/`, `registry.json`, install-root model YAML, plugin manifests) — stable between sessions. |
| **gate-deferred** | Intentionally validates the live checkout as a CI-style gate; keep out of vitest unit paths or accept as explicit repo gate. |

## Mutable-state couplings (migrated — tasks 2–5 complete)

| File | Live coupling | Planned task |
| ---- | ------------- | ------------ |
| ~~`hooks/compaction.test.ts`~~ | Migrated to `useFixtureProject` + `fixtures/repo-state/` (task **2** complete) | — |
| ~~`hooks/validateArtifact.test.ts`~~ | Migrated to `useFixtureProject` + `fixtures/repo-state/` (task **4** complete) | — |
| ~~`cli/validate.test.ts`~~ | Migrated to `useFixtureProject` + pinned `PLAN.md`/`PROGRESS.md` (task **4** complete) | — |
| ~~`cli/validateVerifyOracles.test.ts`~~ | Artifact family uses `useFixtureProject("ok")`; no plan.yaml branching (task **4** complete) | — |
| ~~`registries/evaluatorHandoffContract.test.ts`~~ | Migrated ledger-shift test to `useFixtureProject("ok")`; no live `TODO.md` mutation (task **5** complete) | — |
| ~~`registries/packageRegistry.test.ts`~~ | Reads fixture `repo-state/ok/.agentera/docs.yaml` for `docs_targets` alignment (task **5** complete) | — |
| ~~`registries/artifactRegistry.test.ts`~~ | `DOCS_PATH` points at fixture docs.yaml (task **5** complete) | — |

No other vitest file reads live `.agentera/*` or `TODO.md` from `REPO_ROOT` (grep baseline
2026-06-18). Tests that mention artifact paths only inside tmp dirs, inline strings, or
oracle JSON are not couplings.

## Gate-deferred couplings (keep; not tasks 2–5)

| File | Live coupling | Notes |
| ---- | ------------- | ----- |
| `release/releaseMetadata.test.ts` | `validateReleaseMetadata(REPO_ROOT)` in "live repo" describe | Static version-surface alignment, not session ledger churn |

## Static-contract REPO_ROOT couplings (documented; no migration)

These resolve `REPO_ROOT` to read checked-in contracts, bundle inputs, or repo layout — not
mutable agent session state.

| Area | Files | Typical paths under `REPO_ROOT` |
| ---- | ----- | ------------------------------- |
| Skills & schemas | `validate/capability.test.ts`, `validate/crossCapability.test.ts`, `registries/capabilityContract.test.ts`, `validate/skillAppHomeGate.test.ts` | `skills/agentera/**`, `packages/cli/src/capabilities/**` |
| References & oracles | `validate/lifecycleAdapters.test.ts`, `validate/vocabularyAuthority.test.ts`, `validate/appHomeContract.test.ts`, `cli/runtimeAdapterHooksParity.test.ts`, `cli/validateParity.test.ts`, `cli/npmParityMatrix.test.ts`, `cli/inspekteraEvaluationReport.test.ts`, `cli/sourceContractOracles.test.ts`, `registries/runtimeAdapterRegistry.test.ts`, `registries/evaluatorHandoffContract.test.ts` (contract path only), `migrate/v2HandoffManifest.test.ts`, `upgrade/nextMajorDoctor.test.ts`, `upgrade/doctorChannels.test.ts`, `cli/coexistenceProbe.test.ts` | `references/**`, `packages/cli/test/**/fixtures/**` |
| Registry & packaging | `registries/packageRegistry.test.ts` (registry.json paths), `upgrade/appModel.test.ts`, `packaging/prepack.test.ts`, `cli/npxBundle.test.ts` | `registry.json`, `packages/cli/**`, `scripts/**` |
| Install-root models | `state/installRoot.test.ts` | `.agentera/install_root_interface_model.yaml`, `.agentera/install_root_behavior_inventory.yaml` (checked-in contract fixtures) |
| Upgrade / doctor bootstrap | `upgrade/*.test.ts`, `cli/doctorUpgradeParity.test.ts`, `cli/primeAppWording.test.ts`, `cli/primeChannels.test.ts`, `cli/primeProjectIntegration.test.ts`, `cli/prime.test.ts`, `setup/copilot.test.ts` | `sourceRoot` / `AGENTERA_BOOTSTRAP_SOURCE_ROOT` → `references/`, `registry.json` (tests use tmp project trees for `.agentera/` writes) |
| Runtime plugin layout | `cli/runtimeAdapterHooksParity.test.ts`, `upgrade/cursorAgentSurface.test.ts` | `.cursor-plugin/`, `.codex-plugin/`, `plugin.json`, `.cursor/agents/` |
| Repo hygiene scans | `cli/v1LegacyCruft.test.ts` | Whole-tree scan for post-3.0 cruft (stable source contract) |
| Analytics parity | `analytics/extractCorpusParity.test.ts` | `scripts/extract_corpus.py`, `packages/cli` (maintainer parity probe) |

## Deferred (plan scope)

- `process.cwd()` in prime/orientation paths when cwd is `packages/cli` — noted in plan as
  optional follow-on; not live artifact reads today.
- Optional `pnpm -C packages/cli test:repo-gates` script for explicit local hygiene runs.
