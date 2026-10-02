# Vite+ cold-source corrective proof

Recorded 2026-10-02 in the assigned `vite-plus-1-toolchain` checkout at HEAD
`dfa04715`. This report covers uncommitted test-harness corrections and local
qualification. Prime owns state, commits, pushes, CI and comparison reports.
This is not hosted acceptance, full historical qualification or a source receipt.

## Result

The final cleared owning `vp exec vp run verify:development` passes all **11 gates**
in **214336 ms**. Source reports **4912 passed, zero failed, one Darwin-only skip**.
Package reports **72 passed, zero failed or skipped**. There was no checkout build
before verification: checkout `dist`, `bundle` and generated-publication output
were absent, and module/task caches were cleared immediately before the command.
Earlier warm passes do not constitute this cold evidence.

## Confirmed causes and corrections

The matched task-8 failure report contains four failures in 4913 source assertions:
two missing checkout-bundle assets and two native-cache probe timeouts. All 72
package assertions passed in that failed qualification. These are source-harness
failures, not permission to change customer behavior or package budgets.

- `doctorCleanupOffer.test.ts` passed checkout `packages/cli/bundle` to
  `loadHostSkillSource`, although source setup compiles JavaScript into a temporary
  root and does not stage checkout bundle assets.
- `sharedSkillOffer.test.ts` likewise selected checkout `packages/cli/bundle`,
  causing state-authority loading to fail when that directory was absent.
- Both now use a disposable source-owned bundle-shaped fixture under their existing
  test root. `helpers/npxBundleFixture.ts` copies canonical `references`, `skills`
  and `registry.json`, selects the host projection through `loadHostSkillSource`
  and its registry-owned path, and writes the runtime's named npx sentinel.
  It does not build or manufacture checkout output, guess host asset names or
  consume a compiled-only source setup root as if it contained data assets.
- The doctor test still asserts distinct runtime and durable data roots, shared-skill
  health, repair status and no cleanup offer. The offer test retains private-path
  non-disclosure, exact approval binding, changed-profile rejection, read-only
  failure and successful unchanged approval. Only fixture paths changed.
- The source fixture is explicitly **not extracted-package evidence**. The existing
  package owner, its real construction/extraction, all 72 assertions and complete
  activation conjunction remain unchanged and pass in the same owning command.
- `taskCache.test.ts` no longer requires the agent-specific `/tmp/opencode` parent.
  Its native Linux IPC fixture uses a unique short `/tmp/agentera-task-cache-*`
  root instead. That prevents a clean CI runner from needing an undeclared parent
  directory. Each probe still owns its cache and TMPDIR and retains all ten safety
  tests, including unchanged-input hits, invalidation, fresh root tasks under
  `--cache`, child failure, corrupt/malformed entries, argv forwarding and cancellation.

No production source, capability prose, customer HOME fixture, raw budget, timeout,
historical binding, workflow, CI regression test or existing comparison document
was changed by this correction. All production tasks remain `cache: false`.

## Native-cache timing uncertainty

The matched failure durations are 35245.687 ms for the seven-step invalidation test
and 232092.422 ms for the all-root-owner freshness test, against the existing
30000 ms per-test timeout. The entire cache suite took 353221.358 ms. This is
cumulative test execution, not proof that an individual child reached its 15000 ms
deadline. The cause of that delay remains **unresolved**.

Temporary per-child instrumentation in a cleared owning run recorded ordinary
probe calls at roughly 95–163 ms; the run passed all 11 gates in 224573 ms.
Controlled parent-command metadata and long HOME/XDG-root probes did not reproduce
the delay, so neither hypothesis justifies a product or environment workaround.
Instrumentation was removed before the final focused and owning reruns. The
portable-parent correction is not claimed to fix the timing cause. No retries,
conditional skips, timeout increases, dropped assertions or verdict-cache acceptance
were added. A recurring timing failure remains a failure requiring diagnosis.

## Cold boundary and commands

The retained proof-7 standalone launcher reports Vite+ 1.0.0 and manages Node
24.19.0/pnpm 10.30.3. Commands below used the existing private wrapper
`node /tmp/opencode/task7-vp.mjs`; it changes neither global setup nor shared hooks.
`VITEST_MAX_WORKERS` is unset. The owning source allocation is four workers;
the package owner retains one worker and four bounded concurrent journeys.

`node /tmp/opencode/task8-cold-reset.mjs --apply` removes only explicitly inventoried
ignored paths: checkout `dist`, `bundle`, generated storage/publication output,
and root/package `node_modules/.vite/{vitest,task-cache}`. Generated output was
already absent. Dependencies, managed runtime/manager caches and all raw evidence
were retained. No OS page-cache reset is claimed. The final reset at
`2026-10-02T04:14:11.295Z` records all eight paths absent before qualification.

| Check                                                                                                                 | Observed result                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Cleared focused `vp test run` for `doctorCleanupOffer`, `sharedSkillOffer` and `config/taskCache`, before corrections | 51 passed, two missing-asset failures, no skips. The cache failures did not reproduce in this focused run.                              |
| Cleared focused command after final corrections                                                                       | **53 passed**, zero failed or skipped, with checkout dist/bundle absent.                                                                |
| Cleared owning diagnostic `vp exec vp run verify:development`, before removing timing instrumentation                 | **Pass**, all 11 gates, 224573 ms. Source 4912 passed/one Darwin skip; package all 72 passed.                                           |
| Cleared final owning `vp exec vp run verify:development`                                                              | **Pass**, all 11 gates, 214336 ms. Source owner 169102 ms; package owner 120087 ms. Reconciled execution and zero leases after barrier. |

The final owning command includes source, stress, one-sample development resource
workload, capacity, package, generated overlap, typecheck, build, compact,
capability-contract and activation-conjunction. No separately run omitted owner
was used to manufacture a conjunction pass. Full historical qualification was
not repeated, as requested; its four known failures remain outside this proof.

Raw evidence is retained under `/tmp/opencode/task8-cold-*`, including
`focused-before.json`, `focused-final.json`, `owner-diagnostic.log`,
`owner-diagnostic-diagnostics/`, `owner-final-reset.json`, `owner-final.log`,
`owner-final-diagnostics/` and `final-summary.json`. Diagnostic directories retain
source/package JSON, profiles, package timings and logs. Native probe evidence is
`task8-cache-timing.jsonl`, `task8-parent-*-env.log`, `task8-probe-variables.log`
and `task8-probe-long-roots.log` in the same disposable evidence directory.
The original matched task-8 evidence was not altered or deleted.

## Boundaries and remaining risk

- The original timeout cause is unconfirmed. Two cleared owning runs pass, but
  they do not prove the native probe timing failure cannot recur.
- Hosted acceptance and authoritative cold performance belong to Prime's CI
  measurement. These local timings do not replace those results or establish
  another package improvement percentage.
- No further disk cleanup was needed: `/tmp` remains at 8.6 GiB free. Only the
  inspected checkout-local transform/task caches were removed for cold checks.
- No state, commit, push, ref, registry, workflow, global setup or shared-hook
  mutation occurred. Existing qualification, package-proof and comparison documents
  were left to Prime. This new report was written only after the final run, so
  source inputs remained stable throughout that qualification.
