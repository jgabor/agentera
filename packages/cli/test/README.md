# CLI test layer policy

**Migration complete (2026-06-18):** tasks 2–5 moved all mutable-state vitest couplings to
`fixtures/repo-state/` via `useFixtureProject`. Vitest no longer reads or mutates live
`.agentera/*` or `TODO.md` from `REPO_ROOT`.

Vitest proves **logic** with temp dirs and pinned fixtures. **Live-repo artifact hygiene**
(compaction budgets, committed artifact shape) is owned by `agentera check compact` in CI
and lefthook — not duplicated as vitest assertions against this checkout's `.agentera/` or
`TODO.md`.

| Layer                   | Proves                                                                                                                                                                                                                                                                | Entry point                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Source Vitest           | Detailed hook/CLI behavior from fixtures and tmp project trees; runtime bootstrap uses one accepted and one rejected smoke per source/package representation. No checkout generated-output writes. A source test may compare the direct checkout bundle when present. | `pnpm -C packages/cli test`                                                          |
| Performance owner       | Machine-sensitive cold-process budgets on one worker, including one bounded evidence record with runner authority                                                                                                                                                     | `pnpm -C packages/cli test:performance`                                              |
| Capacity owner          | Large deterministic scale coverage that is too heavy for source correctness or performance timing                                                                                                                                                                     | `pnpm -C packages/cli test:capacity`                                                 |
| Performance integration | Real supported owner command plus independent stdout-contract validation; scheduled/release policy surface                                                                                                                                                            | `pnpm -C packages/cli test:performance:integration`                                  |
| Package boundary        | Distribution-only checks from the canonical two-construction fixture, focused bundle safety, exact package inventory and integrity, path independence, and one extracted smoke                                                                                        | `pnpm -C packages/cli run verify:package`                                            |
| Repo-state fixtures     | Pinned `.agentera/` + `TODO.md` variants via `useFixtureProject(name)`                                                                                                                                                                                                | `packages/cli/test/fixtures/repo-state/`                                             |
| Repo gate               | Committed `.agentera/*` and `TODO.md` within `uniform_10_40_50`                                                                                                                                                                                                       | `pnpm -C packages/cli build && node packages/cli/dist/bin/agentera.js check compact` |
| Release gate            | Version-bearing surfaces and governed provenance aligned in the live checkout                                                                                                                                                                                         | `agentera check validate release-metadata`                                           |

Generated-output construction, consumers, package publication, and temporary-root
lifecycle are defined once in the
[v3 packaging authority](../../../docs/packaging/v3-packaging.md).

Performance stdout is not JSON-only: normal Vitest text surrounds exactly one
whole-line `agentera.entityAuthorityPerformanceEvidence.v1` JSON record. Consumers
extract newline-delimited records by `schemaVersion`; the owner command validates
the record and its runner authority against the policy before returning success.
The integration surface is owned by the performance owner in
`verification-policy.yaml`; it invokes `test:performance` once, so policy proof
does not recurse or duplicate the 25-sample matrix.
Forwarded owner arguments are normalized once: `--` delimiters are discarded,
only reviewed observability flags and exact owner-inventory files reach Vitest,
and every performance selection must retain the marked evidence producer.
Result-file channels are consumed by the parent owner and removed from its test
environment, so nested owner checks cannot inherit or overwrite that artifact.
Full-overlap proof also validates every non-passing assertion from the structured
reporter. On Darwin no source test may be pending; elsewhere exactly the named
Darwin process-identity test may be `skipped`. Its path, full name, and status
must match the overlap contract, while package proof permits no pending tests.
The governed `verification-policy.yaml` byte stream and the parent-owned JSON
result-file bytes are the only overlap evidence authorities. YAML/JSON parsing
and structural validation finish before normalization or consumption; direct
JavaScript objects, including proxies and accessors, are outside this runtime
boundary.

Release source verification uses the policy-owned DAG. One generated-overlap
process is the sole origin for source, package, build, and overlap evidence. It
runs the exhaustive governed runtime-bootstrap matrix, every missing surface,
and the adversarial activation-evidence cases instead of repeating them in
ordinary source verification. It
runs beside isolated stress and typecheck owners. After those three batch owners
pass and the private build settles, performance runs alone
with one worker in fresh state on the pinned remote runner, and records runner
identity so CPU contention cannot invalidate its machine-sensitive evidence.
Local performance runs are diagnostic, not authoritative package verification evidence.
Capacity then runs alone with one worker for large deterministic scale evidence.
Compact and capability-contract then run together as readers. Every child has a
separate HOME, cache, npm configs, and report. A peer failure cancels only
cancellable groups; generated-overlap settles without forced termination, and no
reader barrier or receipt follows a batch, performance, or capacity failure.

Pre-commit is a local feedback lane, not release verification. It runs exact
source-owned tests and typecheck with at most two workers. Specialized and
global surfaces are labeled `ci_owned`; required CI runs their authoritative
owners through the unchanged release verification. The hook accepts no receipt
or environment bypass.

## Classification key

| Class               | Meaning                                                                                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **mutable-state**   | Reads or mutates live session artifacts (`.agentera/*`, `TODO.md`) whose content changes with capability runs — vitest must not depend on them (migrate to `fixtures/repo-state/`). |
| **static-contract** | Reads checked-in repo sources (`skills/`, `references/`, `registry.json`, install-root and package-surface contracts) — stable between sessions.                                    |
| **gate-deferred**   | Intentionally validates the live checkout as a CI-style gate; keep out of vitest unit paths or accept as explicit repo gate.                                                        |

## Mutable-state couplings (migrated — tasks 2–5 complete)

| File                                              | Live coupling                                                                                             | Planned task |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------ |
| ~~`hooks/compaction.test.ts`~~                    | Migrated to `useFixtureProject` + `fixtures/repo-state/` (task **2** complete)                            | —            |
| ~~`hooks/validateArtifact.test.ts`~~              | Migrated to `useFixtureProject` + `fixtures/repo-state/` (task **4** complete)                            | —            |
| ~~`cli/validate.test.ts`~~                        | Migrated to `useFixtureProject` + pinned `PLAN.md`/`PROGRESS.md` (task **4** complete)                    | —            |
| ~~`cli/validateVerifyOracles.test.ts`~~           | Artifact family uses `useFixtureProject("ok")`; no plan.yaml branching (task **4** complete)              | —            |
| ~~`registries/evaluatorHandoffContract.test.ts`~~ | Migrated ledger-shift test to `useFixtureProject("ok")`; no live `TODO.md` mutation (task **5** complete) | —            |
| ~~`registries/packageRegistry.test.ts`~~          | Reads fixture `repo-state/ok/.agentera/docs.yaml` for `docs_targets` alignment (task **5** complete)      | —            |
| ~~`registries/artifactRegistry.test.ts`~~         | `DOCS_PATH` points at fixture docs.yaml (task **5** complete)                                             | —            |

No other vitest file reads live `.agentera/*` or `TODO.md` from `REPO_ROOT` (grep baseline
2026-06-18). Tests that mention artifact paths only inside tmp dirs, inline strings, or
oracle JSON are not couplings.

## Explicit live-checkout gates

| Entry point                                | Live coupling                                                                     | Notes                                                                                         |
| ------------------------------------------ | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `agentera check validate release-metadata` | Validates version surfaces and `agentera.gitRef` against governed checkout inputs | Run explicitly for release readiness; fixture-level validator tests remain in ordinary vitest |

## Static-contract REPO_ROOT couplings (documented; no migration)

These resolve `REPO_ROOT` to read checked-in contracts, bundle inputs, or repo layout — not
mutable agent session state.

| Area                       | Files                                                                                                                                                                                                                                                                                                                                                      | Typical paths under `REPO_ROOT`                                                                                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Skills & schemas           | `validate/capability.test.ts`, `validate/crossCapability.test.ts`, `registries/capabilityContract.test.ts`, `validate/skillAppHomeGate.test.ts`                                                                                                                                                                                                            | `skills/agentera/**`, `packages/cli/src/capabilities/**`                                                                                                                                              |
| References & oracles       | `validate/vocabularyAuthority.test.ts`, `validate/appHomeContract.test.ts`, `cli/validateParity.test.ts`, `cli/npmParityMatrix.test.ts`, `cli/sourceContractOracles.test.ts`, `registries/evaluatorHandoffContract.test.ts` (contract path only), `migrate/v2HandoffManifest.test.ts`, `upgrade/nextMajorDoctor.test.ts`, `upgrade/doctorChannels.test.ts` | `references/**`, `packages/cli/test/**/fixtures/**`                                                                                                                                                   |
| Registry & packaging       | `registries/packageRegistry.test.ts` (registry.json paths), `upgrade/appModel.test.ts`, `cli/npxBundle.test.ts`                                                                                                                                                                                                                                            | `registry.json`, `packages/cli/**`, `scripts/**`                                                                                                                                                      |
| Install-root models        | `state/installRoot.test.ts`                                                                                                                                                                                                                                                                                                                                | `.agentera/install_root_interface_model.yaml`, `.agentera/install_root_behavior_inventory.yaml` (checked-in contract fixtures)                                                                        |
| Upgrade / doctor bootstrap | `upgrade/*.test.ts`, `cli/doctorUpgradeParity.test.ts`, `cli/primeAppWording.test.ts`, `cli/primeChannels.test.ts`, `cli/primeProjectIntegration.test.ts`, `cli/prime.test.ts`, `setup/copilot.test.ts`                                                                                                                                                    | `sourceRoot` / `AGENTERA_BOOTSTRAP_SOURCE_ROOT` → `references/`, `registry.json` (tests use tmp project trees for `.agentera/` writes)                                                                |
| Source-compiled CLI gate   | `cli/compactTodoReferenceGate.test.ts`                                                                                                                                                                                                                                                                                                                     | `AGENTERA_BOOTSTRAP_SOURCE_ROOT` → checked-in source contracts; compact runs only against tmp project state                                                                                           |
| Package-surface retirement | `cli/repositoryNativeRetirement.test.ts`                                                                                                                                                                                                                                                                                                                   | canonical `skills/` and `references/`; deleted native descriptor paths                                                                                                                                |
| Glossary variant guard     | `cli/glossaryVariantGuard.test.ts`                                                                                                                                                                                                                                                                                                                         | Validated confirmed glossary variants; generated, vendor/cache, and historical Agentera state remain excluded                                                                                         |
| Analytics parity           | `analytics/extractCorpusParity.test.ts`                                                                                                                                                                                                                                                                                                                    | `scripts/extract_corpus.py`, `packages/cli` (one shared seeded TS probe plus an independently implemented Python oracle process); generated-surface no-drift is package-owned through its build setup |

## Deferred (plan scope)

- `process.cwd()` in prime/orientation paths when cwd is `packages/cli` — noted in plan as
  optional follow-on; not live artifact reads today.
- Optional `pnpm -C packages/cli test:repo-gates` script for explicit local hygiene runs.
