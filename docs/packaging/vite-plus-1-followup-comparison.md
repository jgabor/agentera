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
