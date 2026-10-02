# Vite+ toolchain baseline and cost model

Task 1 only, measured 2026-10-01 before candidate migration. No production,
toolchain, CI, assertion, budget, state, commit, push, or hook changes.

This record was first authored at `references/analysis/vite-plus-1-baseline.md`,
the location cited by task 1's original evaluation. It moved here unchanged in
meaning so internal measurements are not bundled as consumer runtime references.

## Revision, environment, and retained evidence

- Exact baseline: `1b964ee320832100b8715503a8a7747b0d0fc591`.
- Independent disposable clone: `/tmp/opencode/agentera-baseline-1b964ee3`.
  Created with `git clone --no-hardlinks --no-checkout "$BASELINE_SOURCE"
/tmp/opencode/agentera-baseline-1b964ee3`, then detached checkout of the exact
  baseline. The required historical plugin object `aa33870d...` is present.
- Evidence root (abbreviated **E** below):
  `/tmp/opencode/agentera-baseline-evidence`.
- Isolated `VP_HOME`: `/tmp/opencode/agentera-baseline-vp-home`.
  Independent checkout `node_modules`; managed pnpm store: `/tmp/.pnpm-store/v10`.
  Provisioned with `VP_HOME=... vp env on` and
  `VP_HOME=... vp install --frozen-lockfile`. Frozen install passed, 169 packages,
  managed pnpm reported 1.3 s. Provisioning was not an owner timing sample.
- Host: Linux x64, kernel `7.2.8-1-cachyos`, Ryzen 7 9800X3D, 16 logical CPUs,
  about 31 GiB RAM. Desktop applications remained running; this is not an
  exclusive or authoritative GitHub runner. Memory/swap state is in
  `E/environment.log`.
- Global standalone launcher **1.0.0**, baseline local Vite+ **0.3.0**,
  Node **24.19.0**, pnpm **10.30.3**, Vitest **4.1.11**, Vite **8.2.2**.
  This measures the pinned local baseline with the user's existing launcher,
  not strict standalone-0.3.0 binary equivalence. No global downgrade.
- Worker overrides were unset (`E/worker-environment.json`): package is one
  worker by configuration; source uses the default four. Original test,
  resource, heap/output, and package wall-time limits remain unchanged.
- `E/environment.log` retains versions, revision, lock/policy/config hashes;
  `E/inventory.json` retains the complete owner file inventory.
- Every sample directory retains `meta.json`, `stdout.log`, and `stderr.log`.
  Package samples also retain normalized `result.json`, diagnostic
  `result.json.profile.json`, and `result.json.timings.json`.
  `E/summary.json` joins profile assertion indices to reporter titles, retaining
  every measured assertion, status, duration, and static-discovery observation.
  Profiles are diagnostic only and do not replace gate results.

## Serial package measurements

Command: `vp -C packages/cli run verify:package`, external cap 1,200 s per run.
No other heavy owner was launched alongside these samples. Cold means dependencies
provisioned, disposable transform/task/generated caches removed, not cold OS page
cache or an empty dependency store. Warm samples retain caches at the same revision.
Each command still constructs and packs twice in independent roots.

All three samples passed **7 files / 72 assertions**, with no failed, pending,
or todo assertions. The existing 515,000 ms package budget remains unchanged.

| Sample directory under E | Command wall ms | Owner wall ms | Setup ms | Outside-setup residual ms | Assertion sum ms | Other owner time ms |
| ------------------------ | --------------: | ------------: | -------: | ------------------------: | ---------------: | ------------------: |
| package-cold-measured    |          179241 |        178563 |     2958 |                    175605 |        173392.75 |             2212.25 |
| package-warm-1-measured  |          186174 |        185506 |     3046 |                    182460 |        180117.06 |             2342.94 |
| package-warm-2-measured  |          169414 |        168801 |     3014 |                    165787 |        163687.49 |             2099.51 |

Cost model for this single-worker owner:
`owner wall = setup + assertion-duration sum + unattributed remainder`.
The outside-setup residual is **not** all test time. The last column includes
runner/transform overhead, unmeasured hooks and teardown; it is not a teardown
measurement. Command dispatch adds another 613–678 ms outside owner wall.
Cold attribution is approximately 1.7% setup, 97.1% assertions, 1.2% remainder.

Setup phase ms, cold / warm 1 / warm 2:
prepare `87 / 93 / 92`; first build `930 / 972 / 934`; second build
`935 / 958 / 967`; first pack `501 / 507 / 514`; second pack `459 / 469 / 462`;
extract `16 / 15 / 14`; scan `28 / 28 / 29`; compare `2 / 2 / 2`.
Other measured setup phases are 0–1 ms. Setup totals include the phases,
not an additional cost to add to them.

### Actual file inventory and costs

All files are under `packages/cli/test/packaging/`. Durations are seconds,
rounded to two decimals. File time is reporter elapsed time, not owner wall.

| File                                 | Assertions |  Cold | Warm 1 | Warm 2 | Coverage                                                                   |
| ------------------------------------ | ---------: | ----: | -----: | -----: | -------------------------------------------------------------------------- |
| projectMigrationJourney.test.ts      |         19 | 60.33 |  61.22 |  58.01 | Approval, refusal, drift, kill/resume and checkpoint journeys              |
| packageVerification.test.ts          |         23 | 53.32 |  56.02 |  49.69 | Inventory/integrity, two-root determinism, executable parity and workflows |
| discussCloseoutJourney.test.ts       |          9 | 39.78 |  41.82 |  36.74 | Closeout approval, refusal, changed proposal, resume and writer failure    |
| staticDiscoveryQualification.test.ts |         11 | 16.13 |  16.95 |  15.61 | Every returned static detail/continuation, without companion reads         |
| sharedSkillUpgradeChain.test.ts      |          1 |  2.80 |   3.03 |   2.67 | Complete one-confirmation legacy link-chain workflow                       |
| copyBundleSafety.test.ts             |          7 |  0.93 |   0.98 |   0.87 | Missing/escaping/invalid/overlapping/symlink/duplicate inputs              |
| coldProcessScheduler.test.ts         |          2 |  0.11 |   0.11 |   0.11 | Bounded success and failure/abort/settlement before root removal           |

The first three files account for about **88.5%** of cold file time. Cold
file-duration sum is 173399.47 ms, close to the 173392.75 ms assertion sum.

Largest cold assertions (seconds):

| File / assertion                                                                                 |  Cold | Warm 1 | Warm 2 |
| ------------------------------------------------------------------------------------------------ | ----: | -----: | -----: |
| packageVerification / ordinary harness review, current-date retries, superseded-approval refusal | 10.91 |  11.62 |  10.17 |
| packageVerification / readable references, selectors and minimum rows across executables         |  9.96 |  10.45 |   9.38 |
| packageVerification / producer readiness publication and replay                                  |  8.19 |   8.49 |   7.58 |
| projectMigrationJourney / inapplicable                                                           |  7.06 |   7.03 |   6.21 |
| projectMigrationJourney / publication-permission                                                 |  7.00 |   7.00 |   6.99 |
| discussCloseoutJourney / writer-failure                                                          |  6.65 |   7.15 |   6.20 |
| discussCloseoutJourney / resume                                                                  |  6.24 |   6.45 |   5.67 |

Migration inventory: yes, decline, silence, source-drift, project-drift,
scope-drift, effect-drift, permission-drift, publication-permission,
sigkill-resume, todo-checkpoint-resume, bad-todo-checkpoint,
verification-failure, inter-phase-drift, fresh-approval-after-stale,
many-effects, bad-checkpoint, missing-approval, inapplicable.
Discuss inventory: bundle, decision-only, refusal, silence, changed-proposal,
scoped-pivot, qualified-gap, resume, writer-failure.
Static partitions: schema, prime, state, route, report:0, report:1, report:2,
check, upgrade, doctor, app-home. Every sample traversed **4,478 queries**:
respectively `1392, 333, 103, 94, 384, 459, 79, 143, 1235, 254, 2`.
Full exact assertion titles, statuses, static roots and semantic/command hashes
are retained in `E/summary.json` and the individual reports.

## Cold development verification and contention

Command: `vp run verify:development`, external cap 1,800 s. Caches were cleared
again after package measurements. No separate heavy owner competed with this
command; its governed DAG intentionally overlaps source/package/build with
stress/typecheck. **Failed, exit 1**, command wall 170679 ms, conjunction 170079 ms.

Progress durations: typecheck passed 672 ms; private build passed 2268 ms;
stress passed 21640 ms; source failed 169163 ms; package cancelled 169184 ms.
Overlapping package setup was 4397 ms (versus isolated 2958 ms); first/second
build 1256/1100 ms, first/second pack 614/561 ms, evidence 645 ms. These include
activation evidence absent from standalone setup, so the difference is not a
pure contention estimate. Package did not finish; no full package assertion
profile or owner wall result exists for this run.

Retained source profile wall is 168464 ms; 289 whole files, 4,879 assertions:
4,874 passed, **4 failed**, one expected Darwin-only skip. The failed raw reporter
has nested suite aggregates (832), not 832 whole files. Source assertion sum
469206 ms overlaps across workers and **must not be subtracted from wall time**.
Slowest source files: migration journey 59.56 s; runtime bootstrap matrix 54.33 s;
Discuss journey 48.86 s; release qualification 26.29 s; retired-runtime policy
25.51 s. Largest assertion is coordinated multi-root artifact attacks, 20.29 s.

All four baseline failures remain visible:

- `cli/capabilityDetail.test.ts:89`: startup output 32850 bytes exceeds 32768.
- `cli/doctorCleanupOffer.test.ts:238`: reads missing checkout
  `packages/cli/bundle/references/adapters/package-registry.yaml`.
- `cli/sharedSkillOffer.test.ts:235`: reads missing checkout
  `packages/cli/bundle/references/artifacts/state-storage-authority.yaml`.
- `cli/statusContextStartup.test.ts:447`: long-HOME output 22598 bytes exceeds
  the 22500-byte startup budget.

The two missing-bundle failures expose a mismatch with the declared cold,
private-generation contract. The output failures may be path-length sensitive;
this experiment does not prove their behavior at another checkout path. They
are not evidence of a candidate toolchain regression. No baseline repair or
budget raise was attempted. Development-resource, capacity and final readers
were **not run** after batch failure, as required by the existing DAG.

Retained development diagnostics:
`E/development-cold/retained/agentera-release-overlap-cyhl6C/` contains source
report/profile, source/package/build logs and partial package timing JSON.
Sibling `agentera-release-{typecheck,stress,generated-overlap}-*/owner-report.log`
files retain owner stdout/stderr before mandatory temporary-root cleanup.

## Diagnostic reporting checks

- Successful owner: `vp node packages/cli/scripts/verify-lane.mjs source
test/verification/verificationTiming.test.ts`, exit 0, 1404 ms, 17 tests passed,
  valid report/profile in `E/diagnostic-success/`.
- Rejected owner option: same dispatcher with `package --reporter=json`, exit 2,
  502 ms, rejection/correction retained in `E/diagnostic-rejected/`.
- Deliberate cancellation: success command capped at one second, exit 124,
  1103 ms, `timedOut: true` in `E/diagnostic-cancelled/meta.json`. No completed
  profile exists, and none is invented. This is a diagnostic, not qualification.
- Initial wrapper preflight failed before any owner ran because `/usr/bin/time`
  is absent. Three exit-127 records remain in the non-`measured` package
  directories. The corrected wrapper uses Python child resource accounting.
- `python3 E/check_evidence.py` passed checks for all completed package reports,
  diagnostic outcomes, the four source failures and package cancellation.
  `python3 -m py_compile E/measure.py E/summarize.py E/check_evidence.py` passed.

## Evidence-based recommendations, not implemented

1. Focus on the serial journey/parity assertions, not package fixture reuse.
   Even eliminating all setup saves only about 3 s here. Preserve both independent
   construction roots, two packs, integrity checks and extracted execution.
2. Investigate cold CLI/bootstrap CPU inside the three dominant files before
   choosing a change. Their helpers use repeated synchronous child invocations;
   timings identify those workflows, but do not separate bootstrap CPU from
   command work. Child user/system CPU was 239.07/31.08 s for the cold package
   tree, including all setup and tests, not bootstrap alone.
3. If later work considers concurrent journeys, prove per-scenario root/environment
   independence and bounded child settlement first. The shared package fixture
   and the dependency relinking in static discovery prohibit naive file-wide
   parallelization. No concurrency change is approved by this report.
4. Do not target teardown first: only 2.10–2.34 s remains after setup and assertion
   attribution. Warm samples show no reliable cache win (one slower, one faster).
5. Treat the supplied CI run `36920660152` as separate, artifact-free evidence:
   package 780869 ms / budget 515000, setup 24564, residual 756305; build 21482,
   stress 110676, typecheck 3407, source cancelled 783242. The local run does not
   reproduce that overrun or prove its cause. Cross-run hardware, contention,
   cache and path differences prevent a causal claim.

## Exact reusable candidate measurement recipe

The disposable wrapper `E/measure.py` supports `MEASURE_CHECKOUT`,
`MEASURE_EVIDENCE`, `MEASURE_VP_HOME` and modes `package`, `development`,
`diagnostics`. Existing owner reporters are the timing authority. It runs
serially, retains separate stdout/stderr and metadata, and wraps each command
with GNU `timeout --kill-after=10s`. Package snapshots poll every 100 ms using
the same recursive patterns used for the baseline; development snapshots use
bounded top-level parent-owned report paths. Observer overhead is not separately
measured. Reuse this observer for comparison, rather than silently changing it.

For the next owner, after the approved candidate changes and frozen provisioning,
from that candidate's repository root (do not execute as part of task 1):

```bash
export MEASURE_CHECKOUT="$(git rev-parse --show-toplevel)"
export MEASURE_EVIDENCE=/tmp/opencode/agentera-candidate-evidence
export MEASURE_VP_HOME=/tmp/opencode/agentera-candidate-vp-home
# First verify these new parent directories and provision an independent cache.
mkdir "$MEASURE_EVIDENCE" "$MEASURE_VP_HOME"
VP_HOME="$MEASURE_VP_HOME" vp env on
VP_HOME="$MEASURE_VP_HOME" vp install --frozen-lockfile
python3 /tmp/opencode/agentera-baseline-evidence/measure.py package
python3 /tmp/opencode/agentera-baseline-evidence/measure.py development
python3 /tmp/opencode/agentera-baseline-evidence/measure.py diagnostics
```

Do not overlap these commands with other heavy owners. Package mode clears only
`node_modules/.vite`, `node_modules/.cache`, `.vite`, `.vp`, the CLI equivalents,
and CLI `dist`/`bundle` before cold; then runs two warm samples without clearing.
Development mode clears these again and runs once. Preserve default worker policy,
caps and unchanged runtime assertions, and record the candidate revision and
versions. New sample directories are required; the wrapper refuses existing ones.
Recheck the supported command/report paths if candidate interfaces change.
Retain E before disposable cleanup if these raw diagnostics are needed later.

The baseline clone is clean after measurement. No owner processes remained at
closeout. The primary checkout was left unchanged. Task lifecycle and final
commits remain with Prime.
