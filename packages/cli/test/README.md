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
| Source Vitest | Detailed hook/CLI behavior from fixtures and tmp project trees; no package construction or checkout generated-output dependency | `pnpm -C packages/cli test` |
| Performance owner | Authority-declared production scales and cold-process budgets, including one bounded evidence record | `pnpm -C packages/cli test:performance` |
| Performance integration | Real supported owner command plus independent stdout-contract validation; scheduled/release policy surface | `pnpm -C packages/cli test:performance:integration` |
| Package boundary | Focused bundle safety plus one tarball build, generated-surface no-drift checks, authority-derived inventory, extraction, install, and minimum isolated invocation conjunctions | `pnpm -C packages/cli run verify:package` |
| Repo-state fixtures | Pinned `.agentera/` + `TODO.md` variants via `useFixtureProject(name)` | `packages/cli/test/fixtures/repo-state/` |
| Repo gate | Committed `.agentera/*` and `TODO.md` within `uniform_10_40_50` | `pnpm -C packages/cli build && node packages/cli/dist/bin/agentera.js check compact` |
| Release gate | Version-bearing surfaces and governed provenance aligned in the live checkout | `agentera check validate release-metadata --format json` |

Generated-output producers, consumers, publication, and recovery are defined
once in the [v3 packaging authority](../../../docs/packaging/v3-packaging.md).

Performance stdout is not JSON-only: normal Vitest text surrounds exactly one
whole-line `agentera.entityAuthorityPerformanceEvidence.v1` JSON record. Consumers
extract newline-delimited records by `schemaVersion`; the owner command validates
the record against the authority before returning success.
The integration surface is owned by the performance owner in
`verification-policy.yaml`; it invokes `test:performance` once, so policy proof
does not recurse or duplicate the 25-sample matrix.

## Classification key

| Class | Meaning |
| ----- | ------- |
| **mutable-state** | Reads or mutates live session artifacts (`.agentera/*`, `TODO.md`) whose content changes with capability runs — vitest must not depend on them (migrate to `fixtures/repo-state/`). |
| **static-contract** | Reads checked-in repo sources (`skills/`, `references/`, `registry.json`, install-root and package-surface contracts) — stable between sessions. |
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

## Explicit live-checkout gates

| Entry point | Live coupling | Notes |
| ----------- | ------------- | ----- |
| `agentera check validate release-metadata --format json` | Validates version surfaces and `agentera.gitRef` against governed checkout inputs | Run explicitly for release readiness; fixture-level validator tests remain in ordinary vitest |

## Static-contract REPO_ROOT couplings (documented; no migration)

These resolve `REPO_ROOT` to read checked-in contracts, bundle inputs, or repo layout — not
mutable agent session state.

| Area | Files | Typical paths under `REPO_ROOT` |
| ---- | ----- | ------------------------------- |
| Skills & schemas | `validate/capability.test.ts`, `validate/crossCapability.test.ts`, `registries/capabilityContract.test.ts`, `validate/skillAppHomeGate.test.ts` | `skills/agentera/**`, `packages/cli/src/capabilities/**` |
| References & oracles | `validate/vocabularyAuthority.test.ts`, `validate/appHomeContract.test.ts`, `cli/validateParity.test.ts`, `cli/npmParityMatrix.test.ts`, `cli/inspekteraEvaluationReport.test.ts`, `cli/sourceContractOracles.test.ts`, `registries/evaluatorHandoffContract.test.ts` (contract path only), `migrate/v2HandoffManifest.test.ts`, `upgrade/nextMajorDoctor.test.ts`, `upgrade/doctorChannels.test.ts`, `cli/coexistenceProbe.test.ts` | `references/**`, `packages/cli/test/**/fixtures/**` |
| Registry & packaging | `registries/packageRegistry.test.ts` (registry.json paths), `upgrade/appModel.test.ts`, `cli/npxBundle.test.ts` | `registry.json`, `packages/cli/**`, `scripts/**` |
| Install-root models | `state/installRoot.test.ts` | `.agentera/install_root_interface_model.yaml`, `.agentera/install_root_behavior_inventory.yaml` (checked-in contract fixtures) |
| Upgrade / doctor bootstrap | `upgrade/*.test.ts`, `cli/doctorUpgradeParity.test.ts`, `cli/primeAppWording.test.ts`, `cli/primeChannels.test.ts`, `cli/primeProjectIntegration.test.ts`, `cli/prime.test.ts`, `setup/copilot.test.ts` | `sourceRoot` / `AGENTERA_BOOTSTRAP_SOURCE_ROOT` → `references/`, `registry.json` (tests use tmp project trees for `.agentera/` writes) |
| Package-surface retirement | `cli/repositoryNativeRetirement.test.ts` | canonical `skills/` and `references/`; deleted native descriptor paths |
| Repo hygiene scans | `cli/v1LegacyCruft.test.ts` | Whole-tree scan for post-3.0 cruft (stable source contract) |
| Analytics parity | `analytics/extractCorpusParity.test.ts` | `scripts/extract_corpus.py`, `packages/cli` (one shared seeded TS probe plus an independently implemented Python oracle process); generated-surface no-drift is package-owned through its build setup |

## Deferred (plan scope)

- `process.cwd()` in prime/orientation paths when cwd is `packages/cli` — noted in plan as
  optional follow-on; not live artifact reads today.
- Optional `pnpm -C packages/cli test:repo-gates` script for explicit local hygiene runs.
