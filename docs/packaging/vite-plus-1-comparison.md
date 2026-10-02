# Vite+ 1.0 local experiment comparison

Recorded 2026-10-02 for task 8. This is the unshipped experiment dossier for a
later side-by-side adoption review, not an adoption decision, release receipt or
hosted budget acceptance. Prime owns hosted results, state and lifecycle closeout.

## Final disposition

The toolchain candidate is implemented, but the plan is **not fully complete**.
Tasks 1–7 are complete; hosted source acceptance in task 8 remains blocked.
No npm package was published, the primary checkout is unchanged, and adoption
still requires the separate branch review.

In [run 36965353815](https://github.com/jgabor/agentera/actions/runs/36965353815),
the candidate package owner passes all 72 assertions in **454,444 ms**, below
the unchanged **515,000 ms** budget. The baseline takes **810,693 ms** and fails
that budget. This is a **43.94% package-time reduction**, with the candidate's
one-source-worker concession versus the baseline's two recorded explicitly.

The candidate source gate fails: **4,892 passed, 20 failed, one skipped**.
Nineteen failures require an undeclared `/tmp/opencode` parent in formatter and
native-hook fixtures. Their final correction uses short OS temporary roots;
39 focused formatter, hook and cache assertions pass locally afterward. The
remaining hosted failure is the all-root cache-guard test: a 120,000 ms timeout
with 239,700 ms reported duration. Its cause remains unresolved. The failed
conjunction took 1,767,537 ms; later gates did not run. A package-budget pass is
not a development-qualification pass.

Hosted source acceptance after the final fixture correction is unverified.
Full historical qualification also remains failed on pre-existing archive
bindings. Do not adopt this branch as a fully qualified release source or
describe the CI feedback-loop problem as solved. Raw final hosted evidence is
retained under `/tmp/opencode/agentera-hosted-{baseline,candidate}-4ce0adbb`
and the linked workflow artifacts.

## Result

The matched package campaign passes all **7 files / 72 assertions** in each
sample. Candidate cold owner time is **95,802 ms**, against **178,563 ms** baseline
(46.35% lower). The two warm owner means differ by 46.00%. Both warm observations
are reported below; two observations do not establish a percentile or causal model.

**Cold development verification fails in both revisions.** Candidate takes
434,075 ms and fails source verification: two cache-probe timeouts and two
absent-checkout-bundle failures. The latter two also fail baseline. Candidate
package, build, stress and typecheck pass in this conjunction, but later gates
do not run. The prior task 7 development pass does not prove this cold condition.
No source correction or extra heavy rerun was made during this measurement task.
Subsequent cold corrections and hosted observations are recorded below; they
do not retroactively convert this frozen failed sample into a pass.

## Subsequent cold and hosted evidence

The table above remains the frozen local campaign, including its failed cold
development result. Later source-harness corrections remove checkout-bundle
coupling and an undeclared cache-probe temporary parent. A genuinely cleared
owning development run then passes all 11 gates in 214,336 ms, with 4,912 source
assertions and all 72 package assertions passing. See
[the corrective proof](vite-plus-1-cold-proof.md). The earlier intermittent
cache-probe delay remains unresolved; the temporary-parent fix is not claimed
to explain that delay.

[Hosted run 36961654710](https://github.com/jgabor/agentera/actions/runs/36961654710)
executes both cold controls on Ubuntu 24.04 with two source workers. Baseline
package wall time is 698,507 ms; candidate package wall time is 594,924 ms
(14.83% lower). Both exceed the unchanged 515,000 ms package limit. Candidate
package assertions pass, but its failed budget stops the conjunction and
cancels source. Neither job qualifies. Diagnostics are retained in
`/tmp/opencode/agentera-hosted-{baseline,candidate}-dfa04715` and the run artifacts.
The initial run 36959270492 starts no jobs because runner expressions were at
job scope; the step-scoped correction permits the later run to execute.

The final experimental scheduling probe retains the baseline's two source
workers and gives the candidate one, reserving CPU for its four bounded
package journeys. Runner class, memory/timeout limits, required checks and the
package budget do not change. This deliberately changes worker allocation,
so its result is not a same-worker version-upgrade comparison. It may trade
source throughput for package headroom. The normal publication workflow still
uses its unchanged configuration. Hosted acceptance for this adjusted probe
is pending; report its actual outcome before deciding whether to adopt it.

## Frozen inputs and method

| Input                      | Baseline                                   | Candidate                                          |
| -------------------------- | ------------------------------------------ | -------------------------------------------------- |
| Commit                     | `1b964ee320832100b8715503a8a7747b0d0fc591` | `b9e069e6ac931d8d0becb6afdca1cd3004ccfa75`         |
| Git tree                   | `201ec2b4bd53f966a9a152a7355685fd05c0c1c6` | `45901bbc217547795a480bdc18c9ed5cfc736e54`         |
| Standalone / local Vite+   | 1.0.0 / 0.3.0                              | 1.0.0 / 1.0.0                                      |
| Actual child Node / pnpm   | 24.19.0 / 10.30.3                          | 24.19.0 / 10.30.3                                  |
| Vitest / Vite              | 4.1.11 / 8.2.2                             | 5.0.1 / `@voidzero-dev/vite-plus-core` 1.0.0 alias |
| Source / package workers   | default 4 / configured 1                   | default 4 / configured 1                           |
| Package journey scheduling | Serial                                     | Four independent scenarios; two parity readers     |

Both campaigns ran serially on the same Linux x64 workstation, Ryzen 7 9800X3D,
16 logical CPUs, approximately 31 GiB RAM, kernel 7.2.8-cachyos. No competing
verification owner was launched, except the production development conjunction's
own overlap. Desktop/background applications and swap remained present. Hardware
is matched, but this is not an exclusive idle host or an authoritative CI runner.
The samples occurred at different times, with different private HOME/config roots.

Baseline reuse is supported by **actual runtime evidence**, not `vp --version`:
each `package-*-measured/stdout.log` records `selected-term-startup-boundary` with
`node: v24.19.0`; development's retained `package.log` records the same version.
Candidate logs independently record that version. Its environment probe records
`process.execPath` under the private managed `js_runtime/node/24.19.0/bin/node`.
The ambient 24.21.0 task 5 diagnostic is excluded.

Cold means dependencies provisioned, ignored worktree transform/task caches and
`packages/cli/{dist,bundle}` removed. Dependencies/store remain; OS page caches
were not reset. Warm retains only the same revision's caches. All assertions run
fresh; native task verdict caching is disabled. Independent two-root construction,
two builds, two packs and byte comparison still run every time. No checkout file
or document was edited until all samples settled. Measurement identities bind the
clean candidate contents before this docs-only report.

Commands, from each checkout root:

```bash
# Baseline, original retained campaign; no worker overrides
vp -C packages/cli run verify:package
vp run verify:development

# Candidate; vp is the verified task 3 private standalone executable
vp env exec --node 24.19.0 vp -C packages/cli run verify:package
vp run verify:development
```

Candidate uses the environment retained by task 3 bootstrap proof 7, with
`/usr/bin:/bin` added to its private PATH for OS prerequisites. The disposable
`/tmp/opencode/task8-measure.py` reuses the baseline observer and existing owner
reporters. Each package command has a 1,200-second external cap; development has
1,800 seconds, with `timeout --kill-after=10s`. No accepted sample hits that cap.
All owner children settled; the final owner-process search found none.

## Package observations

Times are milliseconds. Residual means owner wall minus setup, not test-only or
teardown time. Concurrent assertion durations cannot be summed as an additive wall
model. Setup includes construction; it is not another cost to add to owner wall.

| Revision / sample | Command wall | Owner wall | Setup | Outside-setup residual | Outcome |
| ----------------- | -----------: | ---------: | ----: | ---------------------: | ------- |
| Baseline cold     |       179241 |     178563 |  2958 |                 175605 | 72 pass |
| Baseline warm 1   |       186174 |     185506 |  3046 |                 182460 | 72 pass |
| Baseline warm 2   |       169414 |     168801 |  3014 |                 165787 | 72 pass |
| Candidate cold    |        96429 |      95802 |  2750 |                  93052 | 72 pass |
| Candidate warm 1  |        96363 |      95738 |  2747 |                  92991 | 72 pass |
| Candidate warm 2  |        96208 |      95589 |  2755 |                  92834 | 72 pass |

Warm owner range: baseline **168,801–185,506 ms**; candidate
**95,589–95,738 ms**. Warm command range: **169,414–186,174 ms** versus
**96,208–96,363 ms**. Candidate cold first/second builds take 858/849 ms and
first/second packs 481/439 ms. Setup changes little; expensive journeys and matrix
fixture work explain the larger workload delta. Vitest/Vite upgrades and workload
scheduling changed together. This is not an isolated version-upgrade A/B result.

| File under `packages/cli/test/packaging/` | Assertions | Baseline cold s | Candidate cold s | Candidate warm range s |
| ----------------------------------------- | ---------: | --------------: | ---------------: | ---------------------: |
| `projectMigrationJourney.test.ts`         |         19 |           60.33 |            17.82 |            17.58–17.75 |
| `packageVerification.test.ts`             |         23 |           53.32 |            42.41 |            42.39–42.46 |
| `discussCloseoutJourney.test.ts`          |          9 |           39.78 |            11.81 |            11.73–11.79 |
| `staticDiscoveryQualification.test.ts`    |         11 |           16.13 |            15.56 |            15.63–15.63 |
| `sharedSkillUpgradeChain.test.ts`         |          1 |            2.80 |             2.61 |              2.57–2.59 |
| `copyBundleSafety.test.ts`                |          7 |            0.93 |             0.85 |              0.86–0.86 |
| `coldProcessScheduler.test.ts`            |          2 |            0.11 |             0.90 |              0.88–0.89 |

All three candidate file/title inventories exactly equal baseline. The sorted
`(file, fullName)` inventory SHA-256 is
`4a627051bbcff926075458a039afa8b2164739cc1c16074dac3123a9dd8cf32e`.
Every sample completes **4,478 discovery queries / 114 continuations**. Query
counts are traversal workload, not assertions. Output semantic hashes need not
equal baseline after approved instruction changes; title/count equality alone is
not semantic equivalence. Retained tests still check returned schemas and fields,
details, continuations, malformed selectors and constructed/extracted parity.

Coverage mapping remains in [package proof](vite-plus-1-package-proof.md): approvals,
refusals, drift, kill/resume, checkpoints, many effects, closeout failures, host
installation, malformed authorities, inventory/integrity, deterministic bytes and
static discovery. The 101-record matrix retains its records, long reasoning,
Unicode and pagination; one canonical writer fixture is copied to the other IDs.
No consumer field or required journey is removed. Child-process totals were not
instrumented in this final campaign; scheduling limits are configuration and
regression-probe evidence, not newly measured maximum-active counts.

## Cold development and qualification limits

| Observation                  | Baseline                       | Candidate                                    |
| ---------------------------- | ------------------------------ | -------------------------------------------- |
| Command wall / exit          | 170679 ms / 1                  | 434075 ms / 1                                |
| Source assertions            | 4874 pass, 4 fail, 1 skip      | 4908 pass, 4 fail, 1 skip                    |
| Package                      | Cancelled after source failure | 72 pass, owner 117033 ms                     |
| Build / stress / typecheck   | See retained baseline logs     | Pass, progress 2251 / 20541 / 647 ms         |
| Full development gate result | Fail                           | Fail at generated overlap; later gates unrun |

Baseline failures are the two missing checkout-bundle cases plus startup output
32,850 > 32,768 bytes and long-HOME output 22,598 > 22,500. Candidate retains
the two missing-bundle failures (`doctorCleanupOffer`, `sharedSkillOffer`) and
adds two 30,000-ms timeouts in `taskCache.test.ts`: unchanged-input/environment
reuse and fresh root execution beside a cached verdict. Source settles failed at
432,606 ms. Timeout cause is not established by this campaign. Startup-budget
assertions pass with the old limits; selected-term package output is
31,981/31,921 bytes cold and 31,989/31,929 warm. No limit was raised.

Failed Vitest reporter suite totals include nested suites (candidate source reports
836 suites but 291 file results). Use file results and assertion statuses, not that
aggregate as a file count. Successful package normalization retains the established
7-file aggregate and existing report fields; raw failed reports remain diagnostic.

Prior task 7 evidence remains separate: development 11 gates passed; full source
4,912 pass / one Darwin skip; hermetic source 4,907 pass / six conditional skips.
Five bootstrap-evidence tests run only in the nonhermetic setting. Full qualification
failed four historical certification assertions. Baseline already had 254 changed,
one missing and 75 added binding entries and a differing formatter hash; candidate
had 438 modified bindings. Historical proofs were not rebound. These are prior
observations, not fresh task 8 passes. Hosted cold budget and adoption criteria
remain unqualified here, notwithstanding the passing local package times.

## Consolidation and concessions

- Root direct dev dependencies fall from eight to three: remove Lefthook,
  Markdownlint CLI, standalone Oxfmt/Oxlint and root Vitest; retain TypeScript6,
  Vite alias and Vite+. CLI retains explicit Vite/Vitest for package resolution
  and three restored historical upstream imports (`npmParityMatrix`, `pyTsParity`,
  `allTestTypecheckViability`) so migration does not rewrite those proof sources.
  Vitest fixture strings are not production imports. Earlier workpapers described
  315 import edits; final baseline-to-candidate inspection counts 305 modified
  files replacing literal upstream imports, and 309 files now importing
  `vite-plus/test`, including new tests. These are different inventories.
- Corepack is removed from migrated contributor/verification bootstrap. Native
  acquisition retains checksum/digest checks, frozen install, pnpm isolation and
  lifecycle restrictions. `setup-node` remains a hosted verifier. Offline first
  use still needs cached runtime/dependency artifacts; Linux x64 remains the
  verified platform, not new macOS/Windows qualification.
- Native hooks replace Lefthook configuration. The installed common-hook bridge
  remains unchanged in the shared repository. Activation still needs separate
  permission; hooks are mistake prevention, not a hostile-actor boundary.
- Markdown formatting replaces Markdownlint, **not its policy assertions**.
  [Formatting concessions](vite-plus-1-formatting-concessions.md) inventories every
  lost rule, editor/recovery policy and byte-bound exclusions. No replacement
  custom Markdown linter was added.
- Root pnpm script aliases are removed because native task names cannot overlap
  scripts. Supported `vp run` names and package pnpm owners remain. Explicit
  managed runtime wrappers retain forwarding; `-C` recipes require managed exec.
- Native verdict caching is rejected: corrupt entry data reproduced exit 0
  without a child. Every root task uses per-task `cache: false`, resistant to
  `--cache`. `fsModuleCache: true` reuses transforms only; assertions stay fresh.
  [Cache proof](vite-plus-1-cache-proof.md) retains the fault and freshness probes.
- Purpose-owned construction, qualification, lane selection, timing reporters,
  compaction/parity readers and fixed publisher scripts remain. Native tooling
  does not replace their assurance or credential boundaries. No `vp pack` switch,
  publication ref change or publisher mutation is part of this dossier.
- Tracked production `packages/cli/src` remains **413 files / 100,787 physical
  lines** (including blanks/comments) in both revisions. The full branch diff is
  367 files, 4,829 insertions / 2,833 deletions, mostly test imports, bootstrap,
  lockfile/config and workpapers. This is consolidation, not a production LOC cut.
  Served guidance tightens equivalent prose by 211 bytes; no consumer-field removal
  is accepted as a formatting concession.

## Provenance and retained evidence

Baseline evidence: `/tmp/opencode/agentera-baseline-evidence`, summarized in
[baseline](vite-plus-1-baseline.md). Accepted candidate evidence:
`/tmp/opencode/agentera-task8-matched-evidence`. Each sample retains command,
revision, cap, exit, elapsed time, stdout/stderr, reporter, profile and setup JSON.
Development's settled source/package reports are in `development-diagnostics/`.
`summary.json` and `inventory-comparison.json` preserve the bounded analysis;
`environment.log` and `context.json` bind runtime, hardware and input hashes.

| Candidate input     | SHA-256                                                            |
| ------------------- | ------------------------------------------------------------------ |
| Root manifest       | `a3ee76879b20b28def96b721c4843d2f46f6527b1603512c6c2bf864bc9ea545` |
| Lockfile            | `654493ff53df72b73eff2d85b2127117e1d22532f20de38406347e115e457345` |
| Root config         | `f4158680e13b88f6a593e7a9ed3beb1b79eda1c6b793f1a7040f4d69e2f84f26` |
| Shared test config  | `159589239aead95619026cc0f1dee9c73fcff2cdb09e8a7ee157109df519a0a0` |
| Package test config | `33fafa6cd0e8b2dd4002d8b39527e0b67e2ce315f2da389b26c70359c40e9c13` |
| Verification policy | `badfa480faa94100963d80b5c1d8a4186e2c4b97f51f2f12d531b79d087284b4` |

Baseline lock/shared-config/policy hashes remain in its `environment.log`.
Publisher Git blob `d3de653fead81657b6423360c9ffc527baf26288` matches baseline
exactly. The candidate cold tarball and construction identity are logged, not
adoption or registry approval. Disposable evidence paths require retention outside
`/tmp` if needed after this session.

Rejected first campaign remains at `/tmp/opencode/agentera-task8-evidence`:
global `VITEST_MAX_WORKERS=4` differed from baseline's unset environment. Package
commands failed at 50,008 / 48,465 / 51,626 ms with shared-module-link/missing-module
and journey-output failures; development failed at 67,964 ms and cancelled source.
Removing that harness override, without a checkout edit, produced the passing
package campaign above. Do not include rejected times in the speed comparison or
claim the configured package serialization holds under that global override.
