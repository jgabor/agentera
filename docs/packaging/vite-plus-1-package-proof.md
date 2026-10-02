# Vite+ package verification optimization proof

Task 5 only, measured 2026-10-02 in the assigned `vite-plus-1-toolchain`
checkout. No production runtime, publisher, package budget, task cache, CI
workflow, state, commit, push, or shared-hook changes.

## Result and measurement limits

The complete package owner passed **7 files / 72 assertions**, with zero
failed, pending, or todo assertions. Owner wall time fell from the recorded
baseline's **178,563 ms to 94,544 ms**, a reduction of **84,019 ms (47.05%)**.
The existing **515,000 ms** budget is unchanged.

This is a local diagnostic comparison, not GitHub runner qualification or the
final task 8 measurement campaign. Both samples used Node **24.19.0**, pnpm
**10.30.3**, and one package worker. The baseline used local Vite+ 0.3.0 and
Vitest 4.1.11; the candidate used Vite+ 1.0.0, Vite 8.3.1, and Vitest 5.0.1.
Earlier approved migration work is therefore also present in this comparison.
The candidate retained warm installed dependencies and transform caches; it
was not a cold-cache sample. No competing heavy verification owner was launched
alongside these measurements. Source checks ran separately with the unchanged
default four workers.

The candidate command used `vp exec vp -C packages/cli run verify:package`.
The outer managed execution preserves Node 24.19.0 through the nested task
launcher. The extracted-runtime evidence line confirms that version. An initial
unwrapped pre-change diagnostic selected ambient Node 24.21.0 despite the
launcher's displayed pin. Its 160,120 ms result is retained, but excluded from
the pinned comparison. No global runtime or shell configuration was changed.

| Phase                    | Baseline cold ms | Candidate ms |
| ------------------------ | ---------------: | -----------: |
| Owner wall               |           178563 |        94544 |
| Package setup            |             2958 |         2705 |
| Outside-setup residual   |           175605 |        91839 |
| First build              |              930 |          851 |
| Second independent build |              935 |          856 |
| First pack               |              501 |          436 |
| Second independent pack  |              459 |          437 |

The reduction is in the expensive test workload, not removal of construction.
Concurrent assertion durations overlap, so their sum is no longer an additive
owner-wall cost model. Scheduling reduces elapsed time, not the number of cold
CLI starts or necessarily CPU consumption.

## Changes and isolation

- Migration and Discuss package journeys now use asynchronous cold CLI children.
  At most four independent scenarios run together. Each scenario has its own
  project and home, permits only one active CLI child, and retains the original
  command order, approvals, fault injection, snapshots, and assertions.
- Package Vitest workers remain **one**. Only the two journey files opt into
  concurrent tests. Shared extracted-package authority mutations and static
  dependency-isolation tests remain serial and cannot overlap those journeys.
- The readable-reference matrix runs the constructed and extracted executables
  as two bounded, independent readers of one immutable project. It retains both
  processes for every request, including malformed selectors and pagination.
- That matrix publishes one canonical decision fixture and copies its record
  under the remaining 100 IDs instead of repeating the same writer setup 101
  times. It still has **101 decisions**, the same **20,000-character reasoning**,
  Unicode excerpts, and the same TODO fixture. This removes redundant private
  fixture construction, not a cold CLI writer scenario. The standalone writer
  remains exercised once here and in its source and journey owners.
- Shared journey helpers now return promises. Their source tests await them but
  keep the original synchronous subprocess backend and serial test scheduling.
- Each asynchronous package test binds cancellation to its own Vitest context.
  A timeout cancels active children and rejects queued work. The finish hook
  waits for child settlement and the entire journey, including its `finally`,
  before fixture teardown. This addresses an actual async failure mode: a test
  timeout alone does not stop its asynchronous work.

No mock, in-process route substitute, generic route, persistent CLI process,
cross-run result reuse, or runtime startup optimization was added. The
scheduler and fixture isolation are test-lifecycle controls, not security
boundaries or enforcement of human approval.

## Coverage mapping and file timings

All 72 baseline assertion titles match the final inventory exactly. No
scenario was removed, merged, skipped, or made count-only. Durations below are
file elapsed seconds, not sums of concurrent assertion durations.

| File under `packages/cli/test/packaging/` | Assertions before/after | Baseline s | Candidate s | Retained evidence                                                                                                                                                                                                                                 |
| ----------------------------------------- | ----------------------: | ---------: | ----------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projectMigrationJourney.test.ts`         |                 19 / 19 |      60.33 |       18.11 | Yes, decline, silence, all five drift cases, publication permissions, kill/resume, TODO checkpoints, verification failure, inter-phase drift, fresh approval, many effects, bad checkpoint, missing approval, all five inapplicable project forms |
| `discussCloseoutJourney.test.ts`          |                   9 / 9 |      39.78 |       11.82 | Bundle, decision-only, refusal, silence, changed proposal, scoped pivot, qualified gap, resume, writer failure                                                                                                                                    |
| `packageVerification.test.ts`             |                 23 / 23 |      53.32 |       42.72 | Two-root/two-pack byte proof, inventory/modes/integrity, all executable parity matrices, malformed authorities and inputs, Profile workflows, producer readiness, host install and cleanup                                                        |
| `staticDiscoveryQualification.test.ts`    |                 11 / 11 |      16.13 |       13.76 | All returned roots, details and continuations, companion-read ban and dependency mutation isolation                                                                                                                                               |
| `sharedSkillUpgradeChain.test.ts`         |                   1 / 1 |       2.80 |        2.55 | Complete extracted-package one-confirmation link-chain workflow                                                                                                                                                                                   |
| `copyBundleSafety.test.ts`                |                   7 / 7 |       0.93 |        0.86 | Missing, escaping, invalid, overlapping, symlink and duplicate inputs                                                                                                                                                                             |
| `coldProcessScheduler.test.ts`            |                   2 / 2 |       0.11 |        0.88 | Original success/order and abort/cleanup checks, expanded with observed four-active/two-queued bound, concurrent-reader failure and a real Vitest timeout/finish-hook probe                                                                       |

Static discovery retains **4,478 queries and 114 continuations**. Query counts,
roots, command hashes, detail counts, read counts and maximum output bytes
match the original baseline. All 11 complete discovery records, including
semantic hashes, match the pre-task-5 candidate. Relative to task 1, the
`check` discovery semantic hash had already changed before task 5; task 5
does not change it or any discovery authority.

The timeout probe deliberately runs one nested failing test. It requires that
failure to remain visible, checks that the child is no longer alive, verifies
that the journey's `finally` ran, and only then removes its temporary project.
Its additional coverage stays inside the existing scheduler assertion, not an
extra or missing package-owner scenario.

## Checks and retained evidence

Evidence files are under `/tmp/opencode/`. Each listed package result also has
the existing `.json.profile.json` and `.json.timings.json` companions. Logs
retain failures as well as passing retries.

| Command                                                                                                                                                                                                                                                                  | Result and evidence stem                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `AGENTERA_VERIFICATION_RESULT=/tmp/opencode/task5-package-journeys-final.json vp exec vp -C packages/cli run verify:package -- test/packaging/coldProcessScheduler.test.ts test/packaging/projectMigrationJourney.test.ts test/packaging/discussCloseoutJourney.test.ts` | Passed, 3 files / 30 assertions, `task5-package-journeys-final`                                             |
| `AGENTERA_VERIFICATION_RESULT=/tmp/opencode/task5-package-final.json vp exec vp -C packages/cli run verify:package`                                                                                                                                                      | Passed, 7 files / 72 assertions, 94544 ms owner, `task5-package-final`                                      |
| `AGENTERA_VERIFICATION_RESULT=/tmp/opencode/task5-source-targeted-final.json vp exec vp -C packages/cli run test:source -- test/cli/projectMigrationJourney.test.ts test/cli/discussCloseoutJourney.test.ts test/config/vitestShared.test.ts`                            | Passed, 3 files / 45 assertions, `task5-source-targeted-final`                                              |
| `AGENTERA_VERIFICATION_RESULT=/tmp/opencode/task5-source-full-final.json vp exec vp -C packages/cli run test:source`                                                                                                                                                     | Passed, 289 files, 4892 passed / 0 failed / 6 existing conditional skips, `task5-source-full-final`         |
| `vp exec vp run typecheck`                                                                                                                                                                                                                                               | Passed, `task5-typecheck-final.log`                                                                         |
| `vp exec vp fmt --check <task-5 code paths>`                                                                                                                                                                                                                             | Passed after applying the project formatter only to owned files                                             |
| `vp exec vp lint <task-5 code paths>`                                                                                                                                                                                                                                    | Passed                                                                                                      |
| `git diff --check`                                                                                                                                                                                                                                                       | Passed                                                                                                      |
| `vp node /tmp/opencode/task5-package-proof-analysis.mjs`                                                                                                                                                                                                                 | Passed assertion-inventory and discovery comparisons; output retained in `task5-package-proof-summary.json` |

The six source skips are one Darwin-only process-identity test on Linux and
five existing governed runtime-bootstrap integration cases. They were not
disabled by this work and are not claimed as executed coverage. All package
scenarios and both changed source journey suites executed.

Initial checks exposed and corrected a configuration assertion aimed at the
outer config instead of the package project, a Discuss callback syntax error,
and a nested timeout probe launched outside the local-tool checkout. The final
checks above supersede those failures; their original logs and reports remain
available. Formatting-only normalization followed the passing source run.
The later cancellation changes affect only package-owned helpers and tests,
and the final complete package owner covers them.

Baseline evidence remains in
`/tmp/opencode/agentera-baseline-evidence/package-cold-measured/`, with its
other two passing samples and cost model in
[`vite-plus-1-baseline.md`](vite-plus-1-baseline.md). Candidate logs, profiles,
timings, comparison script and summary remain in `/tmp/opencode/task5-*`.
No full release/development qualification, CI runner measurement, or repeated
final campaign was run for this task. Those checks and lifecycle completion
remain with their assigned owners.
