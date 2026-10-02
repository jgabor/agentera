# Vite+ 1.0 corrective comparison evidence

## Result and boundary

Recorded 2026-10-02 for comparison-evidence task `bmcqliehzj`. This is comparison-ready local evidence, **not development qualification, full release qualification, or adoption approval**. Prime owns state, commits, pushes, and hosted CI. This measurement task changed no executable source, test, root configuration, workflow, shared hook configuration, or typed entity.

The complete source owner passes. The cold owning development command fails on **one unchanged 30,000 ms cache-test budget**, with no non-budget assertion failures. Package passes all 72 assertions within its unchanged 515,000 ms budget. The failing conjunction stops at generated overlap; its omitted owners remain unverified. No limits were changed, no assertions were weakened, and the valid budget failure was not retried to obtain green.

## Fresh hosted observation

[Run 36988627683](https://github.com/jgabor/agentera/actions/runs/36988627683)
tested corrective commit `ff4ae9a7e9d648c39608e78c141514b34076de2d`.
The baseline failed its package budget: measured package wall time was
803,172 ms against 515,000 ms. The candidate package participant passed after
467,785 ms of coordinator elapsed time. That observation includes participant
startup and is **not** a recovered package-owner timing profile; the prior
measured 468,062 ms owner result remains separately recorded.

Candidate build, stress and typecheck passed. Source remained running when
the unchanged 30-minute workflow limit terminated verification. The artifact
contains no complete source JSON/profile, package timing JSON, or final
conjunction result. Thus it establishes a workflow **BUDGET** timeout, not a
count of remaining assertion failures and not an 11-gate pass. No tmpfs quota
or one-hour cleanup error appears in this hosted record.

Both jobs used the same hosted runner class; baseline source allocation was
two workers and candidate allocation one. The changed allocation is a
concession, not a version-only performance comparison. Raw hosted artifacts
are retained on disk at `.vitest/followup/hosted-ff4ae9a7/`. The deployment and
publication workflow remains unchanged, and no npm package was published.

The current user-authorized milestone is **comparison readiness**. Complete
local source and all corrected hook/freshness/cancellation assertions pass in
the valid disk-backed environment. Valid test/workflow budgets still fail and
are explicitly retained. The original strict qualification task remains
blocked; this milestone does not replace it with a false green release result.

| Check                                                                   |  Exit | Actual result                                                      |                                  Wall time |
| ----------------------------------------------------------------------- | ----: | ------------------------------------------------------------------ | -----------------------------------------: |
| Three corrected files, root native configuration, one worker            |     0 | 60 passed: hooks 26, formatter 4, cache 30                         |                                  38,127 ms |
| Environment boundary probe, two source files, root native configuration |     0 | 15 passed                                                          |                                   3,218 ms |
| Complete `vp run test` source owner                                     |     0 | 291 files; 4,928 passed, 0 failed, 6 skipped; 4,934 titles         |       129,642 ms wrapper; 128,831 ms owner |
| Cold `vp run verify:development`                                        |     1 | Generated-overlap failure, not an 11-gate pass                     | 442,294 ms wrapper; 441,688 ms conjunction |
| Source inside cold generated overlap                                    |     1 | 291 files; 4,932 passed, 1 budget failure, 1 skipped; 4,934 titles |                           440,028 ms owner |
| Package inside cold generated overlap                                   |     0 | 7 files; 72 passed, 0 failed, 0 skipped                            |                           126,610 ms owner |
| Private build inside cold generated overlap                             |     0 | Passed                                                             |          13,979 ms coordinator observation |
| Development batch stress / typecheck                                    | 0 / 0 | Passed before generated-overlap failure                            |   28,313 / 654 ms coordinator observations |
| `vp check` / `vp run typecheck`                                         | 0 / 0 | Passed on the unchanged corrective code                            |                       724 / 743 ms wrapper |

The six standalone-source skips are existing conditions: one Darwin process-identity case and five runtime-bootstrap evidence cases enabled only when the owning conjunction supplies `AGENTERA_ACTIVATION_SOURCE_EVIDENCE_OUTPUT`. Those five cases execute in the cold conjunction. Its only skip is Darwin-only. No source titles are lost: the previous 4,913-title inventory gains 20 titles by splitting the root-cache aggregate into 21 sequential cases, plus one disabled-parent hook regression, giving **4,934**. The package workload remains **72 titles**.

The passing `vp check` reports zero errors and six warnings in unchanged files, within the existing warning policy. Static results remain applicable because executable inputs did not change during measurement. After writing both comparison documents, targeted `vp fmt`, `vp fmt --check`, and `git diff --check` passed. The documentation checks do not qualify omitted runtime owners.

## Source cancellation diagnostics and isolation probe

Task `xtbezclowi`, checkout HEAD `c1e677ed`, measured 2026-10-02. The hosted
30-minute cause remains **unknown**. Source diagnostics now distinguish
barrier/compilation, file collection/execution, numeric cases and native fixture
invocations. Task-cache fixture child starts append synchronously to the
diagnostic file even while the parent blocks in `spawnSync`. Records omit titles, child
content, argv, absolute paths and environment values. These are observations,
not gate results or a hostile-child security boundary. Reporter event arrival
can lag a blocked worker; native events bypass that buffering. Missing child
markers mean “not observed,” not a cache hit.

Both coordinator layers forward records to the existing hosted
`verification.log`; originating events also append synchronously to
`AGENTERA_QUALIFICATION_DIAGNOSTICS/source.progress.log`. Neither requires final
JSON or cleanup. The native-runner path did not relay the extra fixture child
descriptor, although helper start/end records reached both coordinators. A
bounded 500 ms file relay now forwards only inventory-allowed child starts,
without duplicating helper records. The experimental upload step now uses
`always()` alone to attempt artifact retention on cancellation too. No publisher
workflow changed. Unit tests prove
blocked-subprocess interruption and real two-coordinator cancellation retain
records without inventing a pass. Hosted artifact proof remains pending push.

One serial, one-worker taskCache-only sample per profile held Vite+ 1.0.0,
actual Node 24.19.0, checkout inputs, disk-backed fixture parent/TMPDIR and
budgets constant. Native verdict-cache fixtures were fresh in each sample;
existing filesystem preparation reuse stayed enabled. The second sample used
fresh owner-like HOME/XDG/npm-cache directories, not a full cold conjunction.

| Diagnostic                              |        Caller |      Isolated |
| --------------------------------------- | ------------: | ------------: |
| Wrapper wall                            |      8,100 ms |     10,403 ms |
| Tests passed / failed                   |        30 / 0 |        30 / 0 |
| Transient compilation / file collection |   560 / 99 ms |   550 / 84 ms |
| File execution, reporter-observed       |      7,117 ms |      8,137 ms |
| Native calls / summed time              | 71 / 6,857 ms | 71 / 7,879 ms |
| Observed fixture child starts           |            46 |            46 |
| Parent-to-child, median / maximum       |   72 / 102 ms |    72 / 98 ms |
| Child-to-exit, median / maximum         |      5 / 8 ms |      6 / 8 ms |
| 21 fresh-owner cases, minimum / maximum |  153 / 160 ms |  153 / 162 ms |

Neither valid sample reproduces the earlier 9–12.7 second fresh-owner cases or
supports a production correction for `vjvtdpngqi`. CPU/RSS/I/O were not sampled;
resource pressure and conjunction effects remain possible. No failed sample
was retried into green. A harness preflight stopped before samples because
`VP_CLI_BIN` was absent outside native tasks; it then used verified `/bin/vp`.

Raw evidence: `.vitest/source-xtbezclowi-XteMru/node_modules/evidence/` contains
`experiment.mjs`, `results.json`, `summary.json`, and `caller/`, `isolated/`
with `run.log`, `result.json`, `observation.json`, `source.progress.log`.
`fixtures/cache/run-yKThVb/` and `run-NK4KxH/` retain per-invocation pre-child
and child-execution timing records. Input hashes stayed identical across both
samples. Preparation reuse assertions and their existing records stay separate
from verdict caching.

The earlier 145 targeted checks passed. Corrected nativeHooks placement outside
`node_modules` passes all 26 tests in 25,107 ms, with disposable fixtures cleaned.
The first `vp run test` invocation used checkout-nested bulk TMPDIR and failed
70 tests (4,863 passed, six skipped), in 134,623 ms. It is **environment-invalid**:
fixtures discovered the enclosing workspace compiler and placed host publication
paths inside internal runtime authority. It was preserved, not rerun.

The single subsequent `vp run verify:development` used a fresh child of the
established external disk temp root, separate XDG data, unchanged four source
workers, one package worker and budgets. Preparation caches stayed enabled and
untouched; this was not a deliberately cold conjunction. It failed generated
overlap in 478,743 ms wrapper time. Source: 476,398 ms, 4,935 passed, three
failed, one skipped. Package: 129,282 ms, all 72 passed. Stress, typecheck and
private build passed; owners after the failed overlap remain unverified. The
failures were a 30,000 ms taskCache timeout and two startup-output bounds
(32,919 > 32,768 bytes; 22,547 > 22,500 bytes). No failing owner was retried.

This conjunction reproduces the **local pre-child delay**: 71 synchronous native
calls total 354,899 ms. Across 46 fixture child starts, parent-to-child median /
maximum was 5,257 / 6,652 ms; child-to-exit was 6 / 8 ms. Fresh-owner case median
was 10,561 ms. TaskCache occupied 365,349 ms and nativeHooks 148,639 ms. Compiler
setup took 729 ms, so it is not the dominant observed delay. The underlying
native-launch cause, CPU/RSS/I/O attribution and hosted 30-minute cause remain
unknown. This identifies where to investigate for `vjvtdpngqi`, not a justified
production correction or native-build approval.

Continuation evidence: `.vitest/source-hooks-xtbezclowi-ZcAztV/node_modules/evidence/`
contains per-stage `hooks/`, `source/`, `development/` logs, reports, profiles and
observations, plus `summary.json` and `native-summary.json`. Fixture timing
records are under that run's `cache/run-Cb4nxo/`; the earlier invalid source
records are in `cache/run-2LU09Q/`. Development retained 11,803 closed-grammar
diagnostic lines (1,816,461 bytes), including all 46 child starts. The final
JSON-only narrow transport check retains evidence in `transport-final/` and
proves two starts, two child starts and two ends, without replay. Broad runs
precede the child-start relay correction; they are not final-code qualification.
Final affected tests and typecheck pass. Hosted cancellation/upload proof and
all three valid source failures remain unresolved; no merge readiness is claimed.

## Fixture correction under the isolated owner

Task `vjvtdpngqi`, HEAD `c1e677ed`: taskCache and nativeHooks fixtures now copy
the root `packageManager` value verbatim, including any integrity suffix. Hook
manifest replacements retain it too. One regression checks the declaration,
fresh execution and absence of latest-resolution/setup errors. Required cache,
failure, cancellation, guard, hook and preparation-reuse assertions are unchanged.

The real `startChild` isolation route, followed by provisioned `pnpm run`, proved
that bootstrap's shared `VP_HOME` survives fresh HOME/XDG/npm state. The probe
used existing Node/pnpm bytes through a disposable shared SDK, not extra
per-fixture manager links or installation. Actual pnpm exported the offline
file registry. Latest metadata stayed absent; each comparison fixture was fresh.

| Native invocation       | Pre-child before / after | Child-to-exit before / after |
| ----------------------- | -----------------------: | ---------------------------: |
| taskCache-like task     |           5,716 / 104 ms |                     7 / 8 ms |
| nativeHooks-like script |            4,793 / 97 ms |                     5 / 6 ms |

Both unpinned invocations logged `pnpm/latest` and `BadScheme`; neither corrected
invocation performed a latest lookup, setup failure or download. The canonical
manager was `pnpm@10.30.3`, with Vite+ 1.0.0 and actual Node 24.19.0. Adding the
field added 32 bytes to each probe manifest, not to CLI startup output.

Serial isolated offline checks passed: taskCache 33 tests (10,057 ms wrapper),
guard 11 (1,860 ms), hooks 26 (26,638 ms). Corrected cache timing records show
81 ms median pre-child and 7 ms median child-to-exit across 48 observed starts;
all 21 hard-fresh owners still execute twice under `--cache`. Preparation reuse
remains enabled and separately proved. All 82 retained native result records
contain no latest lookup, package-manager setup error or download trace, across
fresh/hit/failure/cancellation and guarded fault cases. Typecheck, targeted formatting/lint and
diff checks pass. An unreleased harness barrier and a harness `VP_LOG` setting
that polluted nested JSON were preserved, corrected only in the disposable
driver, and are not passing samples or production fixes.

Raw evidence: `.vitest/source-fix-vjvtdpngqi-rzLo14/node_modules/evidence/`,
including `owner-before/`, `owner-after/`, `cache-checks-v2/`, `guard-checks-v2/`,
`hooks-checks-v3/`, `cache/run-NHJSu7/` and `summary.json`. Full source/development
runs are deferred until the separate cached-alias work finishes. The next local
routine diagnostic must retain the shared provisioned SDK and external disk
TMPDIR, and use the checked-in hosted candidate's one-source-worker allocation.
The first cold hosted source pass within 30 minutes, cancellation/upload proof,
and final readiness remain pending. Existing CLI startup byte-bound failures
are unchanged, not waived, and outside this fixture correction.

## Identity and environment

- Assigned checkout: `/home/jgabor/.local/share/orca/workspaces/agentera/vite-plus-1-toolchain`, branch `vite-plus-1-toolchain`.
- HEAD: `544163f621c523c6c9bbdff9ef1470b81bd66e07` throughout measurement.
- SHA-256 of `git diff --binary` before and after all runtime checks: `be00892d1bba545b12b6bd9cfc14d080cfd7d414616cdce1b91db4545ef9ead3`. This covers tracked dirty inputs, including Prime-owned state, but does not include untracked proof documents. `detail.json` separately hashes the three corrective test files.
- Standalone and local Vite+: 1.0.0. Actual managed Node: `v24.19.0`, executable `/home/jgabor/.vite-plus/js_runtime/node/24.19.0/bin/node`. Managed pnpm: 10.30.3. Vitest: 5.0.1. The actual Node and manager probes are retained, not inferred from `.node-version`.
- Outer hook flags: `VP_GIT_HOOKS=0`, `VITE_GIT_HOOKS=0`, `HUSKY=0`. The corrected fixture children enable their own hooks; checkout commands retain the disabled parent policy. This isolation is not a security boundary.
- No worker or timeout environment override. Focused root discovery uses one worker explicitly. Complete source and generated-overlap source use the existing unmeasured four-worker default. Package retains one worker with its four-scenario internal concurrency. Heavy owning commands run serially outside their own unchanged overlap DAG; there was no competing local runtime owner. The concurrent audit was read-only. Desktop/background workloads and swap remain present, so these are local diagnostic times, not hosted acceptance.
- Final broad `TMPDIR`: `/home/jgabor/.local/share/orca/workspaces/agentera/.verification-bmcqliehzj-tmp`, one disposable disk-backed sibling directory explicitly authorized after the initial placement failure. `XDG_DATA_HOME` is its separate `isolated-xdg-data/` child, not an ancestor of fixtures. Caller `HOME` is unchanged. The development owner retains its deliberate isolated HOME/XDG profiles and long fixture paths. No path shortening or per-test timing normalization was used. Only cache fixtures' existing small `/tmp/atc-*` roots hold short Unix-socket/release-marker paths.

Final-environment resource snapshots, before the environment probe and after development settlement:

| Resource                                    |                Before |                 After |
| ------------------------------------------- | --------------------: | --------------------: |
| Worktree disk available                     | 236,605,284,352 bytes | 236,481,003,520 bytes |
| `/tmp` available, 16,335,880,192-byte tmpfs |   8,767,856,640 bytes |   8,780,759,040 bytes |
| RAM available                               |  12,624,986,112 bytes |  11,729,207,296 bytes |
| Swap used                                   |  13,877,354,496 bytes |  13,881,991,168 bytes |

These are boundary snapshots, not peak measurements. After settlement, ignored verification evidence and archived caches occupy approximately 23 MiB; the external disposable root occupies approximately 37 MiB. Bulk fixtures, caches, profiles, and logs are disk-backed. No bulk acquisition or provisioning used RAM-backed `/tmp/opencode`. The shared Git config hash remains `9cdfae3b8c7e3a3c19ee88be8cbe7510d2426b25ab017c3ec790f52bf72912b0`, matching the prior hook proof.

## Commands and cold condition

All commands ran from the assigned checkout. `E` below names the final retained evidence directory. The first affected-file run used disk-backed checkout `TMPDIR`; the final broad runs use the external root and isolated XDG data root described above. Full PATH and environment selection are retained in the identity JSON records.

The affected-file command originally wrote `.vitest/followup/verification/affected-standalone.json`, before diagnostic relocation. Its reporting destination is shown at the retained location below for replay; `results-final.json` preserves the exact original invocation. Later probe/source/development commands use the displayed final destinations.

```sh
E="$PWD/.vitest/followup/verification/node_modules/evidence"
vp env exec --node 24.19.0 node -p 'JSON.stringify({version:process.version,execPath:process.execPath})'
vp env exec --node 24.19.0 pnpm --version

vp env exec --node 24.19.0 vp test run \
  packages/cli/test/scripts/nativeHooks.test.ts \
  packages/cli/test/config/formatterSurface.test.ts \
  packages/cli/test/config/taskCache.test.ts \
  --maxWorkers 1 --reporter default --reporter json \
  --outputFile "$E/affected-standalone.json"

vp env exec --node 24.19.0 vp test run \
  packages/cli/test/state/planLifecycleContract.test.ts \
  packages/cli/test/upgrade/managedAppScriptIntegrity.test.ts \
  --maxWorkers 1 --reporter default --reporter json \
  --outputFile "$E/environment-probe.json"

AGENTERA_VERIFICATION_RESULT="$E/source-final.json" \
  vp env exec --node 24.19.0 vp run test
AGENTERA_QUALIFICATION_DIAGNOSTICS="$E/development-final-diagnostics" \
  vp env exec --node 24.19.0 vp run verify:development

vp env exec --node 24.19.0 vp check
vp env exec --node 24.19.0 vp run typecheck
vp env exec --node 24.19.0 vp fmt docs/packaging/vite-plus-1-followup-comparison.md docs/packaging/vite-plus-1-comparison.md
vp env exec --node 24.19.0 vp fmt --check docs/packaging/vite-plus-1-followup-comparison.md docs/packaging/vite-plus-1-comparison.md
git diff --check
```

Before the final development invocation, both checkout `packages/cli/dist` and `packages/cli/bundle` were absent. Existing `node_modules/.vite` and `packages/cli/node_modules/.vite` were moved into `E/pre-cold-final/`, preserving their bytes. Root/package `.cache`, `.vite-plus`, and checkout `.vite-plus` were also absent. `cold-inputs-final.json` records each path and its absence. The generated owner constructed private output and isolated profiles itself. This is cold checkout generation/module/task-cache evidence, **not an empty managed-runtime or package-manager acquisition cache claim**. Unchanged acquisition proofs were reused, not rerun.

## Remaining valid failure

`taskCache.test.ts`, `hits only unchanged inputs and environment, and --no-cache executes`, reports `Test timed out in 30000ms`, with raw assertion duration **35,700.438 ms**. The complete cache file takes **356,513.614 ms** inside the isolated source owner, against **7,810.808 ms** in the passing standalone full-source run. No non-budget failure is reported by the final source or package JSON.

This is **BUDGET**, not ENVINVALID and not a pass. The final environment has adequate disk/tmp capacity, and no quota exhaustion or temporary cleanup error was observed. Its cause is not established. Long disk paths and isolated-profile startup are measurement conditions, not proof of a Vite+ version regression. They were not shortened, normalized, or given larger limits. The test timed out, so it does not establish a passing complete cache-input/environment scenario in that cold conjunction.

The 21 sequential fresh-root cases all pass inside both final source runs. Each still proves two executions under `--cache`; there are **42 fresh executions plus two diagnostic cached-verdict calls, 44 native calls unchanged**. The cancellation case passes: cancel after READY, require fresh retry before release with unchanged command/environment, then require a warm hit. The final cache fixture retains **73 direct subprocess records**, including 68 native task calls and five nested preparation-test calls. Malformed-entry false-success characterization remains visible; production verdict caching stays disabled.

The conjunction stops at its first failing owner, generated overlap. Development live CLI resource measurements, capacity, compact, capability-contract, activation-conjunction, and the final generated-runtime reader were **not run**. They were not invoked separately to manufacture an 11-gate pass. Full historical certification was not rerun or rebound; the known four baseline-binding failures remain outside this task.

## Invalid samples retained and excluded

Invalid samples are kept for diagnosis, not candidate judgment or speed comparison:

| Sample                                                | Observed result                                             | Classification and reason                                                                                                                                                                          |
| ----------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial direct local-binary affected run              | 59 passed, 1 failed                                         | **ENVINVALID (invocation)**: direct local binary left `VP_CLI_BIN` unset. Standalone `vp test` corrected dispatch without changing code; 60/60 then passed.                                        |
| Global TMPDIR inside checkout, full source            | 4,856 passed, 72 failed, 6 skipped                          | **ENVINVALID (placement)**: transient compilation/fixtures became checkout runtime/repository surfaces. Host publication and external-artifact checks rejected nested targets.                     |
| Same placement, cold development                      | Package 54 passed / 18 failed; source cancelled             | **ENVINVALID (placement)**: extracted runtime/host fixtures reached checkout authority. Build, stress, typecheck completion does not make this conjunction valid.                                  |
| External TMPDIR before isolated XDG/evidence boundary | Standalone source 4,925 passed, 3 failed, 6 skipped         | **ENVINVALID (placement)**: two isolation assertions saw fixtures under the real default XDG data path; lifecycle scanning found raw retained failure JSON.                                        |
| Same intermediate environment, cold development       | Package 72 passed; source 4,931 passed, 2 failed, 1 skipped | Mixed diagnostics: one lifecycle **ENVINVALID** failure and one **BUDGET** timeout. The whole sample is excluded from comparison; the final valid sample independently retains the budget failure. |

Raw diagnostics originally sat directly under `.vitest/followup/verification`. They were moved, not deleted, into `node_modules/evidence/` beneath that ignored directory. The lifecycle scanner deliberately includes ignored files but already excludes directory names `node_modules` at any depth. Raw reports are non-source diagnostic data; using that existing data boundary prevents report contents from becoming authority candidates. No scanner exclusion, test, root config, or ignore policy was changed. The 15-case environment probe verified the two corrected boundaries before the final broad runs.

Earlier user-reported tmpfs quota exhaustion and the confirmed one-hour tmpfiles cleanup of `/tmp/opencode` are **ENVINVALID**. Preserve those records and exclude them from candidate judgment. They do not explain the supplied latest hosted ten failures: eight inherited-disabled-hook fixture failures, one aggregate-cache test timeout (44 calls, 233 seconds against 120 seconds), and one pre-cancellation readiness failure. The corrective hook/cache proofs document those source-only fixes separately. No historical temporary proof scripts or deleted profiles were assumed to survive.

## Comparison and retained evidence

The prior comparison campaign remains frozen; this follow-up does not relabel its failed samples. No baseline campaign was rerun: package workload is unchanged by these three source-harness corrections, and existing valid baseline/package records suffice. The supplied latest hosted record at `544163f6` reports candidate package **468,062 ms, 72 passed**, baseline **575,281 ms, budget failed**, and candidate source **4,902 passed, 10 failed, 1 skipped**. That candidate uses one source worker versus baseline two. These are supplied hosted observations, not re-fetched or reverified by this local task. Earlier **810,693 / 454,444 ms** package observations and other runs show variability. Do not attribute the difference to Vite+ version alone or treat local four-worker times as the hosted one-worker result. Corrective hosted acceptance remains Prime's next check.

All local raw artifacts remain in `E`:

- `identity*.json`, `results*.json`, `complete*.json`: commit/diff identity, actual tools/environment, commands, exits, wall times, and resource snapshots for every placement.
- `affected*.{json,log}`, `environment-probe.{json,log}`, `source-final.{json,log}`, `source-final.json.profile.json`.
- `development-final.log` and `development-final-diagnostics/{source,package}.json`, their `.profile.json` files, package timing JSON, and build/source/package logs.
- Earlier `source*.json`, `development*-diagnostics/`, and logs retain invalid outcomes. `pre-cold*/` retains displaced module caches.
- `summary.json` / `summary.log` preserve exact assertion counters, all failed titles/messages, skipped titles, and title-inventory digests; `detail.json` preserves corrective-file raw timing profiles and input hashes. Source inventory digest: `18b2166a66bddad0843749a356edb872ca2ac30aaa66384bc602a59169814938`. Package inventory digest: `4a627051bbcff926075458a039afa8b2164739cc1c16074dac3123a9dd8cf32e`. These are local sorted basename/full-title digests, not release receipts.

Fixture subprocess evidence remains under `.vitest/followup/cache/run-qSaN4B/` (final cold run) and `.vitest/followup/cache/run-TOvxlH/` (passing full source). Original focused hook/cache proofs remain in their own ignored directories. No evidence was published, no checkout commit or push was made, and no global environment, shared hook, tmpfiles setting, or remote workflow was changed.

## Guarded developer typecheck qualification

Task `naxoqdtpur`, checkout HEAD `c1e677ed`, measured 2026-10-02. The sole selected
verdict cache is opt-in `vp run typecheck:cached`. Its public task always runs the
known-fault guard around distinct private `_typecheck:cached`, using the same
read-only `pnpm -C packages/cli run typecheck` owner. Default typecheck, hooks,
tests/lint, build, installation, package, verification and publication remain
fresh. This does not replace any historical cold/hosted evidence above.

The real-owner fixture snapshots actual CLI source, tsconfig and manifests with
the canonical declared pnpm manager. Its dependencies are read-only links and
its native cache is private. A Node preload counts compiler launches, not replayed
stdout. The unchanged baseline compiler uses its normal execve route. Only the
separate deterministic cancellation probe selects its existing execFileSync
fallback and pauses before Node exit after actual compilation.

| Operation                                   |      Local wall time | Cumulative compiler launches | Result                                                  |
| ------------------------------------------- | -------------------: | ---------------------------: | ------------------------------------------------------- |
| Cold guarded real typecheck                 |             1,055 ms |                            1 | Passing compiler execution                              |
| Three unchanged warm public alias calls     |     235, 211, 207 ms |                            1 | Private verdict hits, outer guard fresh                 |
| Actual copied source edit                   |               868 ms |                            2 | Miss, compiler executes                                 |
| Actual copied test edit                     |               854 ms |                            3 | Conservative invalidation, not cached tests             |
| Valid lockfile comment edit                 |               878 ms |                            4 | Miss, compiler executes                                 |
| `NODE_OPTIONS` toggle                       |               876 ms |                            5 | Environment miss, compiler executes                     |
| Genuine TS2322 failure, repeated            | recorded in raw JSON |                     6 then 7 | Both exit 1; no passing verdict                         |
| Compiler correction and warm repeat         | recorded in raw JSON |                     8 then 8 | Pass, then hit                                          |
| Malformed entry through actual public alias | recorded in raw JSON |                            8 | Guard rejects exit-zero native skip with exit 1         |
| Fresh default recovery                      | recorded in raw JSON |                            9 | Owner executes without cache deletion                   |
| Public alias after recovery                 | recorded in raw JSON |                            9 | Still rejects damaged private entry; no automatic retry |

The guarded warm median is 211 ms, about 844 ms (80%) below this cold sample.
These are local developer-loop samples, not a CI speedup, performance budget or
hosted qualification. The separate cancellation probe has launch counts
`1 -> 2 -> 2`: cancelled completed compilation, identical-input execution, then
successful warm replay. No command deadline, fixture cleanup assertion, native
pin, hook call or publisher byte-identity contract changed.

Serial focused checks passed 48 assertions across `taskCache.test.ts` (35),
`nativeCacheGuard.test.ts` (11) and `guardedTypecheckCache.test.ts` (2), in
22.15 seconds. This includes the original 21 fresh-root proofs under `--cache`,
the new public-wrapper freshness proof, and the explicit private exception.
Full source/development/package/performance and hosted owners were not run here.

Raw real-owner evidence is retained at
`node_modules/agentera-native-guard-proof/typecheck/run-I6Vr06/{real-owner,real-owner-cancellation}.json`.
The first exploratory run assumed compiler exit 2, but this pinned owner returns
exit 1 for TS2322. Initial cancellation probes also established that execve
bypasses Node's exit events. Those failed probe records remain in adjacent run
directories; they are not counted as qualification passes. The corrected
assertion retains the actual nonzero contract and the cancellation preload uses
the compiler launcher's existing fallback. The runtime guard was not changed.

Recovery remains the unchanged fresh default `vp run typecheck` or
`vp run typecheck:fresh`. Match the explicit `Cache lookup failed` diagnostic;
do not infer corruption from arbitrary workflow failures. The guard is a
workaround, not an upstream repair or a security boundary. Related upstream
issue [2636](https://github.com/voidzero-dev/vite-plus/issues/2636) supplies no
committed exact fix or ETA. See the cache proof for policy and environment inputs.

## Hosted dependency-layout correction

[Run 37051026069](https://github.com/jgabor/agentera/actions/runs/37051026069)
at `a591403afbefd8c75d60a2a23db53eda2999de84` completed candidate source in
1,467.816 seconds: 293 files, 4,956 passed, two failed and one platform skip.
Package passed 72 assertions in 452.716 seconds, including 23.133 seconds setup,
within its unchanged 515-second budget. Both source failures were the real-owner
typecheck fixture's missing root `.pnpm` virtual store, not a production guard
or compiler failure. Cold/warm, invalidation and cancellation qualification were
not reached there. Raw hosted records remain under
`.vitest/hosted-a591403a/vite-plus-candidate-37051026069-1/`.

The fixture now links only the existing root `node_modules/.pnpm` for dependency
reads. Its owned root `node_modules` and sibling `.vite/task-cache` stay private.
A new regression replaces only the fixture's package dependency link with an
owned minimal fresh-pnpm-style relative shim. It loads the actual installed
compiler, reproduces `MODULE_NOT_FOUND` when the fixture store link is removed,
then loads again when restored. Cache realpath and a private marker prove no
checkout-cache sharing. The original package dependency directory is not edited.
Local compiler output is TypeScript 7.0.2; the hosted missing path also targets
7.0.2, but hosted compiler execution remains unverified. Root package-manager,
SDK visibility, actual owner, guard, cache policy, pins and budgets are unchanged.

The final serial three-file check passed **49 assertions** in **20.87 seconds**:
35 cache contracts, 11 guard contracts and three real-owner/layout contracts.
Real compiler counts remain cold/warm `1 -> 1`, source/test/lock/environment
misses `2 -> 3 -> 4 -> 5`, two TS2322 failures `6 -> 7`, correction/warm
`8 -> 8`, malformed-entry rejection `8`, fresh recovery `9`, and repeated
rejection `9`. Cancellation/retry/warm counts are `1 -> 2 -> 2`. Cold was
825 ms; warm calls were 204, 186 and 187 ms. These are local diagnostics only.
Focused test typecheck (ESNext/Bundler), lint, formatting and diff checks passed.
The pre-fix relative-shim regression failed with the same missing-module path.

Final JSON is `node_modules/agentera-native-guard-proof/relative-layout-qualification-final.json`.
Layout, snapshot SHA-256 values and real-owner records are retained under
`node_modules/agentera-native-guard-proof/typecheck/run-NWPiMx/` as
`relative-shim.json`, `real-owner.json` and `real-owner-cancellation.json`.
The failing reproduction remains under `typecheck/run-6i2FxN/`. Snapshot
manifest/lock/tsconfig hashes equal the checkout inputs. No full source,
development, package or performance owner was rerun for this test-only repair.
Previous local evidence and failure history remain intact; coordinator review,
evaluation and a fresh hosted qualification remain pending.
