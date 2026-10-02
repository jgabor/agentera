# Vite+ 1.0 qualification

Recorded 2026-10-02 for approved task 7 in
`/home/jgabor/.local/share/orca/workspaces/agentera/vite-plus-1-toolchain`, branch
`vite-plus-1-toolchain`. This is local diagnostic evidence, not an npm source
receipt, hosted performance acceptance, publication approval, or lifecycle closeout.
Prime owns state, decisions, commits, push approval and hosted measurement.

## Result

The nonpublishing experimental workflow and its regression contracts are in place.
Root runtime-bearing tasks now select the pinned managed Node explicitly without
changing their public `vp run` names, package owners or forwarded arguments.
The final escalation rerun passes development qualification, all 11 gates,
hermetic source and fresh native bootstrap. Full qualification still fails
historical certification. Its source, package, build and invocation overlap passes.
Raw budgets, fixture paths, historical evidence and expectations remain unchanged.
The only served-output change is equivalent tightening of shared instruction prose;
no customer command, field, outcome rule or substantive obligation changed.

## Changes and boundaries

- `.github/workflows/vite-plus-toolchain.yml` accepts only pushes to
  `vite-plus-1-toolchain`. It has only `contents: read`, no OIDC, secrets,
  credential-bearing npm configuration, publication, deployment or release-candidate commands.
  Its independent `vite-plus-toolchain-experiment` concurrency group uses
  `queue: max` and `cancel-in-progress: false`.
- Baseline checks out exactly `1b964ee320832100b8715503a8a7747b0d0fc591`.
  Candidate checks out `${{ github.sha }}` after baseline, with
  `if: always() && !cancelled()`. A failed baseline does not suppress the candidate.
  The control is not migrated or patched. Both checkouts fetch complete history
  and do not persist checkout credentials.
- Both jobs use fresh Ubuntu 24.04 Linux x64 runners, Node 24.19.0 host verifiers,
  each revision's own verified bootstrap, pnpm 10.30.3, two source workers,
  120000 ms test timeouts, the existing hosted runner-class/identity bindings,
  a 30-minute production `verify:development` step and 45-minute job limits.
  Each verifies absent checkout generated output and absent transform/task caches.
  Bootstrap creates new private runtime, config, package-store and npm-cache roots.
  No dependency or verdict-cache action runs.
- Both jobs run `vp exec vp run verify:development`, not a subset of its owners.
  Diagnostics upload after failure as well as success, unless cancelled.
  Artifacts bind job name, run ID and attempt and expire after 14 days.
  They are logs and reports, not release receipts or package candidates.
- Candidate qualification exports settled source/package reporter JSON, logs,
  assertion timing profiles and package timing JSON before deleting its private
  overlap root. It never exports private builds, package snapshots, receipts or
  tarballs. Export failure emits a warning and cannot replace a gate result.
  The immutable baseline predates this export hook: its workflow retains context,
  bootstrap, runtime and production verification logs, including the baseline's
  existing failure/timing diagnostics. It does not gain candidate-only profiles.
- Root tasks use `"$VP_CLI_BIN" env exec --node <.node-version> ...`.
  The invoking standalone launcher supplies `VP_CLI_BIN`; this avoids a nested
  `vp` resolving to the npm shim, which cannot execute `env` commands.
  Native `run` and `exec` alone selected ambient v24.21.0 in a real child probe.
  The regression now verifies actual v24.19.0 with ambient Node first on PATH,
  plus exact argument forwarding. This is a version/drift check, not a security
  boundary against a trusted local actor who can replace executables.
- Advanced package-directory recipes require
  `vp env exec --node 24.19.0 vp -C packages/cli run TASK`. The root public recipes
  remain `vp run test`, `vp run build`, `vp run typecheck`, `vp run verify:development`
  and `vp run verify`. Runtime selection does not change global PATH, host
  profiles, shared Git hooks or project runtime guards.
- Native cached-task probes now give each fixture its own short `TMPDIR`.
  The private qualification owner's nested path exceeded Linux's Unix-socket
  `SUN_LEN`. This includes the cancellation probe, and does not change production
  cache policy, startup paths or customer output. All task verdict caching remains
  disabled, even under `--cache`; deterministic transformed preparation alone can
  be reused.
- No runtime dependency, version, package-publication authority or typed state
  change was added by task 7. Tasks 2 through 6 own the earlier Vite+ 1.0.0,
  Vite core 1.0.0 alias, Vitest 5.0.1, native hooks and dependency removals.
  Node 24.19.0 and pnpm 10.30.3 remain pinned. The hosted cold package budget
  remains 515000 ms. There is no verdict-cache acceptance.

## Action and publisher provenance

The new workflow pins every action to an immutable commit:

| Action          | Commit                                     | Review source                                                                                                            |
| --------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| checkout        | `fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09` | GitHub API `actions/checkout` v5 ref and commit, queried 2026-10-02; v5 backport-fixes commit.                           |
| setup-node      | `53b83947a5a98c8d113130e565377fae1a50d02f` | Existing reviewed v6.3.0 host-verifier pin in `publish.yml`.                                                             |
| upload-artifact | `ea165f8d65b6e75b540449e92b4886f43607fa02` | GitHub API `actions/upload-artifact` v4 ref and commit, queried 2026-10-02; artifact 2.3.2 package update/release merge. |

`git hash-object .github/workflows/publish.yml` and
`git rev-parse 1b964ee320832100b8715503a8a7747b0d0fc591:.github/workflows/publish.yml`
both returned `d3de653fead81657b6423360c9ffc527baf26288`.
The **entire** publisher is byte-identical, not only the OIDC job.
No workflow was dispatched and no push, commit, tag or registry mutation occurred.
Prime must still recheck default-branch publication-ref authority before an
authorized experimental push; this checkout does not redefine that authority.

## Prior attempt commands and observed evidence

Commands below used the previously verified standalone archive and private managed
environment from task 3. The disposable built-ins-only launcher
`node /tmp/opencode/task7-vp.mjs ARGS...` invokes its absolute native `vp`, adds
`/usr/bin:/bin` behind private tools and logs child exit status. It does not change
global PATH or install a global tool. Project Node was v24.19.0; ambient host Node
was v24.21.0. The package/runtime bootstrap authority and archive checksum are
unchanged from the task 3 proof; those unchanged provenance checks were reused.

| Command                                                                                                                                                                                                                                                                                                                                                                                                        | Observed result                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vp test run packages/cli/test/ci/vitePlusToolchain.test.ts packages/cli/test/config/taskCache.test.ts packages/cli/test/release/publicationOrchestration.test.ts packages/cli/test/verification/verificationTiming.test.ts packages/cli/test/release/releaseConjunction.test.ts packages/cli/test/release/rootReleaseScripts.test.ts --reporter=json --outputFile=/tmp/opencode/task7-focused-qualified.json` | Pass: 74 assertions, six files, zero failures or pending assertions. Includes four workflow-safety contracts, real managed-child runtime/argv, diagnostic inventory, cancellation and root release routing.                                                                                                                                                                                        |
| `vp fmt` with the task's changed code, tests and guidance, followed by `vp check`                                                                                                                                                                                                                                                                                                                              | Pass: 836 formatted files; lint reports zero errors and six existing warnings within the unchanged allowance. No new lint suppression.                                                                                                                                                                                                                                                             |
| `vp run typecheck`                                                                                                                                                                                                                                                                                                                                                                                             | Pass, exit 0: `tsc -p tsconfig.json --noEmit`.                                                                                                                                                                                                                                                                                                                                                     |
| `vp run build`                                                                                                                                                                                                                                                                                                                                                                                                 | Pass, exit 0: extraction parity synchronized and nine data surfaces staged into the current checkout build.                                                                                                                                                                                                                                                                                        |
| `vp exec vp run verify:development` with `AGENTERA_QUALIFICATION_DIAGNOSTICS=/tmp/opencode/task7-development-report-diagnostics`                                                                                                                                                                                                                                                                               | Fail, exit 1, 167690 ms. All 11 gates remain selected. Build, package, stress and typecheck complete; source fails and correctly stops the DAG. Source: 291 files, 4913 assertions, 4910 passed, two failed, one expected Darwin-only skip. Package: seven files, all 72 assertions pass, owner 121160 ms, below the unchanged cold hosted limit. Local timings are diagnostic only.               |
| `vp exec vp run verify` with `AGENTERA_QUALIFICATION_DIAGNOSTICS=/tmp/opencode/task7-full-final-diagnostics`                                                                                                                                                                                                                                                                                                   | Fail, exit 1, 145288 ms. All 12 full gates remain selected. First failure is historical certification; stress is cancelled, not passed. Generated overlap settles and also reports startup-budget failures. The later performance, capacity and barrier readers are not reached. No full-qualification success or source receipt exists.                                                           |
| `vp env exec --node 24.19.0 vp -C packages/cli run test:source:hermetic` with reporter output `/tmp/opencode/task7-hermetic-final.json`                                                                                                                                                                                                                                                                        | Fail, exit 1. Isolated source reports `Disk quota exceeded`, including Git fixture writes; 3497 passed, 1406 failed, ten pending/skipped. This contaminated local result is not source acceptance. An earlier run ended without a usable aggregate and left a 411 MB fixture, which was removed only after confirming it had no live process. Logs and reports were retained outside that fixture. |
| `vp env exec --node 24.19.0 vp -C packages/cli run test:toolchain-baseline`                                                                                                                                                                                                                                                                                                                                    | Blocked by fresh native provisioning/unpack failure. The integration process is v24.19.0, but the standalone's first-use/version probe tries to provision default v24.21.0 in its new private home and cannot unpack it. The actual Node guard was not weakened. Earlier probe also failed unpacking v24.19.0. This is not a passing bootstrap proof.                                              |
| `vp exec env REPO_ROOT=/home/jgabor/.local/share/orca/workspaces/agentera/vite-plus-1-toolchain AGENTERA_SANDBOX_TIER=L1 bash -c 'for scenario in happy-path-clean stable-safety noisy-app-home codex-plugin-vs-copied partial-only-runtime; do bash scripts/sandbox/v2v3-upgrade-harness.sh "$scenario"                                                                                                       |                                                                                                                                                                                                                                                                                                                                                                                                    | exit; done'` | Pass, exit 0: all five expected scenario outcomes using `repo-dist`. All migration writes are disposable scenario fixtures, not project state or real host configuration. |
| `git diff --check` and `git diff --exit-code -- .github/workflows/publish.yml`                                                                                                                                                                                                                                                                                                                                 | Pass.                                                                                                                                                                                                                                                                                                                                                                                              |

After the final guidance changes, the owning development command was rerun with
`AGENTERA_QUALIFICATION_DIAGNOSTICS=/tmp/opencode/task7-development-last-diagnostics`.
It again exited 1, in 145855 ms, with exactly 4910 passed, two failed and one
Darwin-only skipped source assertion. All 72 package assertions passed; the
package owner completed in 120627 ms. The retained raw source report confirms
only the two budget failures below, with all activation-observer tests passing.
The final static check covered 837 formatted files with the same six warnings.
The toolchain-baseline, unchanged routine-CI and experimental-workflow guidance
guards also passed: 21 assertions in three files, zero pending assertions.
Evidence: `/tmp/opencode/task7-development-last.log`, the corresponding diagnostic
directory, `/tmp/opencode/task7-check-last.log` and
`/tmp/opencode/task7-guidance-guards.json`.

An interim overlap run also failed copying a private activation-observer fixture.
After removing the abandoned temporary fixture, the production rerun's observer
tests all passed, leaving only the two known raw startup-budget failures below.
The source reports and profiles distinguish the transient local failure from the
final observed source result. No assertion or owner was omitted to get that result.

## Escalation corrections and final evidence

The escalation used this same checkout and the retained proof-7 launcher, without
commits, state writes, pushes, ref changes, shared-hook activation or global setup.
The prior attempt's budget diagnosis was incomplete: equivalent prose tightening
is allowed and does not require a customer feature or contract change.

- `packages/cli/src/capabilities/index.ts` consolidates duplicated complete-read
  and worker-handoff wording in the shared `Current contract access` footer.
  It saves **211 raw JSON UTF-8 bytes per served instruction body**. All six exact
  discovery/recovery commands, complete applicable sections and multipart reads,
  typed-writer precedence, authorization/readiness limits, delegation/evaluator
  contracts, evidence rejection and scoped verification, structured error recovery,
  stop conditions and installation/history permission boundaries remain present.
  There is no field removal, path normalization, budget increase or fixture shortcut.
- The first 123-byte tightening passed ordinary qualification source, but hermetic
  source still measured plan at 32853 bytes and status at 22547 bytes. The final
  211-byte tightening passes both suites, including the unchanged deliberate long HOME.
- Three live tests retain baseline bytes and direct `vitest` imports:
  `test/validate/allTestTypecheckViability.test.ts`,
  `test/scripts/pyTsParity.test.ts`, and `test/cli/npmParityMatrix.test.ts`, all under
  `packages/cli/`. The CLI's existing Vitest 5.0.1 dependency remains; no dependency
  or native formatting exclusion was added. `git diff --exit-code` confirms all
  three files equal baseline. Uniform native imports are subordinate to byte-bound
  historical contracts, not grounds to rebind historical evidence.
- Import migration was not the whole historical failure. Compiler replay compares
  all 731 archived source/test/script bindings with the live inventory. Immutable
  baseline `1b964ee320832100b8715503a8a7747b0d0fc591` already has 254 changed bindings,
  one missing file and 75 added files. The final candidate has 438 changed bindings,
  one missing file and 79 added files. Restoring all of those would undo accepted
  product/toolchain work. The formatter archive expects `npmParityMatrix.test.ts`
  SHA-256 `2169522eae674bb89d534e4fe1e2f4c79f29a346e22110f163be5ef6161159c6`;
  both baseline and restored candidate have
  `8381b6b88654f7cbe32490edb03e6d37f56c1b8968334b4b04d24749f41c1b2b`.
  These pre-existing mismatches remain failures, not new hashes or exclusions.
- The first escalation development run failed two native task-cache probe timeouts
  in 449081 ms. All startup assertions passed and all 72 package assertions passed.
  Focused cache repro passed 10/10; later full-source and owning development runs
  passed unchanged cache assertions. The timeout cause is unconfirmed, not a proven
  product regression or quota error. No timeout or assertion was relaxed.

### Disposable cache cleanup

Inspected superseded task-3 proof directories 1 through 6 and their reports first.
The scoped process check found no live owner. Removed only the explicitly listed
`vp-home`, `store`, `cache` and `node-compile-cache` subdirectories of their private
bootstrap homes. Those old disposable environments can no longer execute.
Retained their reports, source fixtures, config and archives; retained all raw logs,
profiles, baseline checkout, provenance documents and the entire active proof-7
environment. Free `/tmp` space rose from 3.5 GiB to 8.6 GiB and remained 8.6 GiB
after the final checks. No worktree or user directory was deleted. No scratch
relocation or production temporary-path change was needed.

Exact deletion inventory, sizes and the empty live-owner check are retained in
`/tmp/opencode/task7-escalation-cleanup.log`. The previously failed fresh bootstrap
passes after cleanup; the rerun hermetic report contains no quota-contaminated
failure. The old contaminated reports remain failed evidence.

### Final commands and results

Commands use `node /tmp/opencode/task7-vp.mjs` as the private launcher prefix
described above. These results apply to the final 211-byte prose tightening.

| Command                                                                                                                                                                      | Observed result                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vp test run` for `capabilityDetail`, `statusContextStartup`, `planStartupBudget`, `oneFileSkill`, `routeWorkerDetail` and `state/write/capabilityProse`, with JSON reporter | Pass: six files, 126 assertions, zero failed or pending. Full instruction reconstruction, bounded details, long HOME, one-file recovery and handoff obligations remain covered.                                                                                                                                                                                                        |
| `vp exec vp run verify:development`                                                                                                                                          | Pass, exit 0, **190472 ms**. All 11 selected gates pass through their owning DAG, including stress, one-sample resource workload, capacity, compact, capability-contract and activation-conjunction. Source: 4912 passed, zero failed, one expected Darwin-only skip. Package: all 72 assertions pass, owner 120230 ms. Reconciled execution has zero remaining leases.                |
| `vp exec vp run verify`                                                                                                                                                      | Fail, exit 1, **150522 ms**, first failure historical certification. Source: 4912 passed, zero failed, one expected Darwin-only skip. All 72 package assertions pass, owner 119160 ms. Build, complete generated overlap and invocation pass. Stress is cancelled, not passed; later full performance/capacity/barrier readers are blocked. No full pass or source receipt is claimed. |
| `vp env exec --node 24.19.0 vp -C packages/cli run test:source:hermetic` with `AGENTERA_VERIFICATION_RESULT=/tmp/opencode/task7-escalation-hermetic-final.json`              | Pass, exit 0: 4907 passed, zero failed, six environment/platform skips accepted by the source owner. Includes both unchanged raw startup-budget assertions. This is separate hermetic evidence, not merged into the ordinary source aggregate.                                                                                                                                         |
| `vp env exec --node 24.19.0 vp -C packages/cli run test:toolchain-baseline`                                                                                                  | Pass, exit 0, `agentera.toolchainBaselineIntegration.v1`. Fresh private native provisioning, Node 24.19.0/pnpm 10.30.3, stale ambient-tool rejection, allowed/blocked dependency scripts, frozen-lock rejection, repeat wrapper argv forwarding and child-failure propagation pass.                                                                                                    |
| `vp env exec --node 24.19.0 vp -C packages/cli run test:certification`                                                                                                       | Fail, exit 1: 18 passed, four failed in 22 assertions. Three compiler tests stop at whole-tree source binding; formatter replay stops at the pre-existing npm parity-owner digest. Assertions and historical archives remain unchanged. The final full owning command confirms certification still fails.                                                                              |

Final raw evidence is under `/tmp/opencode/task7-escalation-`: `startup-final-state.json`,
`development-final-state.log`, `development-final-state-diagnostics/`,
`full-final-state.log`, `full-final-state-diagnostics/`, `hermetic-final.log`,
`hermetic-final.json`, `toolchain.log`, `certification-byte-restored.log`,
`final-state-binding-analysis.json` and the corresponding summaries.
The diagnostic directories retain source/package JSON, profiles, timings and logs.
All superseded and failed escalation reports are also retained.

Final `vp check` passes: all 837 files are correctly formatted; lint reports zero
errors and the same six existing warnings. `git diff --check` passes. The entire
publisher still has baseline Git blob `d3de653fead81657b6423360c9ffc527baf26288`;
the three restored tests remain byte-identical to baseline. Evidence:
`/tmp/opencode/task7-escalation-check-final.log` and the explicit Git equality checks.
Hermetic's six skips are one Darwin-only check and five full-evidence-only runtime
bootstrap assertions; all five execute and pass in both final owning overlap runs.

## Remaining qualification gaps

1. Full historical certification remains blocked by the confirmed pre-existing
   archive/live-tree mismatches above. Resolving it needs separate authority;
   historical evidence, assertions, bindings, exclusions and budgets were not changed.
2. The local native-cache timeout cause remains unconfirmed. Final complete source
   and development owners pass unchanged probes, but one failed run remains evidence
   of a local timing risk. It is not erased or treated as a pass.
3. Hosted cold CI has not run. The workflow's production acceptance, runner limits,
   baseline/candidate timings and 515-second package budget remain unverified on
   the authoritative host. Local timing does not substitute for hosted evidence.
4. Full five-repetition performance/capacity/barrier readers were not reached after
   certification failed. Development's passing owners do not qualify those full
   requirements, and no omitted owner was run separately to fabricate a full pass.

## Decision wording for Prime

Suggested replacement, not a state write: “Use Vite+ 1.0 native root tasks with
explicit managed runtime selection and per-task verdict caching disabled. Reuse
only deterministic transformed preparation, with fresh assertions. Keep the
fixed publisher unchanged. Use the branch-only, read-only baseline/candidate
workflow for hosted diagnosis. Local development qualification, complete source and
package assertions, hermetic source, fresh first-use baseline and migration pass.
Equivalent instruction tightening fits unchanged raw startup budgets. Full
historical qualification remains failed with confirmed pre-existing bindings;
do not rebind its evidence or present development success as full qualification.
Hosted measurement, timeout diagnosis if it recurs, and final acceptance remain
outstanding.”
