# Vite+ 1.0.0 toolchain redesign: approval draft

Status: approved experiment. Canonical plan `xcxdsrlvym` was published through
the typed writer. This document records its scope and review criteria, not npm
release approval or the final adoption decision.

## Objective and approval boundary

Build a simpler development and non-publishing CI toolchain around Vite+ 1.0.0.
Remove tools Vite+ can replace, accept explicit policy concessions where useful,
and address the actual CI bottleneck rather than treating a version bump as a
performance fix.

The user approved local and hosted execution, feature-branch repair pushes
without a fixed count, a retain-exception fallback, and an eight-hour limit.
Execution began at 2026-10-01T21:40:26Z and ends no later than
2026-10-02T05:40:26Z. Approval did not approve an npm release or integration.

Execution approval covers implementation, dependency installation, bounded
checks, local commits, a candidate-only verification workflow, ordinary pushes
to `origin` at `refs/heads/vite-plus-1-toolchain`, and read-only monitoring of
those runs. This is a specific exception to the standing single-push and
post-push stop rules for this experimental ref only. It does not authorize
pushes to `feat/v3` or `main`, force-pushes, PR creation, integration, deployment,
npm mutation, global tool changes, or shared-hook activation.

After execution, stop for the requested proper side-by-side branch comparison.
The user decides whether the measured benefits justify the concessions before
integration or development publication. No attempt to repair or republish the
failed workflow is included in this planning session.

## Frozen comparison points

| Item                  | Value                                                         |
| --------------------- | ------------------------------------------------------------- |
| Baseline branch       | `feat/v3`                                                     |
| Baseline commit       | `1b964ee320832100b8715503a8a7747b0d0fc591`                    |
| Candidate branch      | `vite-plus-1-toolchain`                                       |
| Candidate worktree    | Isolated Orca checkout of `vite-plus-1-toolchain`             |
| Reported workflow     | <https://github.com/jgabor/agentera/actions/runs/36920660152> |
| Approved source input | `docs/packaging/vite-plus-1-toolchain-plan.draft.yaml`        |

The candidate starts at the exact baseline commit. Record the eventual candidate
commit separately. Do not use a moving branch tip as the before revision.
Setup hooks were skipped when creating the worktree; dependencies are not yet
installed there. The primary checkout remains unchanged.

The workstation already has standalone `vp` 1.0.0 while the baseline local
package is 0.3.0. Measure the actual launcher/local combination explicitly. Where
a baseline proof requires standalone 0.3.0, use a provenance-checked isolated
launcher, not a host downgrade. Do not treat this pre-existing mismatch as a
redesign failure or quietly omit the proof.

## Verified failure evidence

The GitHub run selected the baseline commit and failed in development source
verification. Candidate construction and publication jobs were skipped. The
failure envelope reports no receipt, candidate, registry, activation, or
publication effects. The run exposes no downloadable artifacts, so per-file
timings cannot be recovered from an artifact for this attempt.

| Observation                                   |    Time |
| --------------------------------------------- | ------: |
| Development verification                      | 787.9 s |
| Package owner                                 | 780.9 s |
| Package wall-time budget                      | 515.0 s |
| Package setup                                 |  24.6 s |
| Outside-setup residual                        | 756.3 s |
| Build owner, passed                           |  21.5 s |
| Stress owner, passed                          | 110.7 s |
| Typecheck owner, passed                       |   3.4 s |
| Source owner, cancelled after package failure | 783.2 s |

The setup timing already includes two builds, two packs, extraction, scanning,
and evidence preparation. These are not additional time outside the table.
About 96.9% of package wall time was outside recorded setup. That residual
includes runner startup, tests, and teardown; it is not a measured test-only
duration. Even removing all setup time would not meet the existing budget.

Working hypotheses are expensive serial command journeys, runtime startup,
source/package contention, repeated fixture work, or teardown. None is yet a
proven root cause. The first task obtains file and assertion timings before
selecting changes.

## Proposed consolidation

| Surface                 | Candidate direction                                                                                       | Required boundary or concession                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Runtime/bootstrap       | Vite+ manages Node and package managers; remove Corepack from contributor and build/verification CI paths | Preserve exact pins, verified acquisition, frozen installs, lifecycle restrictions, and credential isolation                       |
| Tool dependencies       | Use bundled Vite+ APIs and commands; prune direct dependencies that become unnecessary                    | Keep aliases, overrides, and explicit packages where upstream compatibility requires them                                          |
| Tests                   | Vitest 5 compatibility and stable filesystem module caching                                               | Preserve effective setup, owner selection, report destinations, and assertion intent                                               |
| Formatting              | Oxfmt owns eligible code and Markdown formatting                                                          | Markdownlint policy checks have no general formatter equivalent; list what is lost                                                 |
| Hooks                   | Prefer native Vite+ hooks and staged checks; retire Lefthook                                              | Preserve related tests, authority guards, typecheck, compact checks, parity checks, partial hunks, and worktree-correct resolution |
| Verification scheduling | Revisit custom orchestration and expensive package journeys based on measured costs                       | Retain required outcomes, independent byte/fixture proofs, failure propagation, and safe cleanup                                   |
| Caching                 | Reuse deterministic preparation and transformed modules where identity is complete                        | Do not cache a successful authoritative verification verdict or skip fresh runtime assertions                                      |
| Build/package           | Reconsider only where profiling shows a benefit                                                           | Do not adopt `vp pack` just because it exists; current production construction uses TypeScript compilation                         |

Vite+ 1.0.0 bundles Vite 8.3.1, Vitest 5.0.1, Oxlint 1.85.0, and Oxfmt 0.70.0.
Keep this alignment, including the core Vite alias and exact Vitest override.
The existing Node 24.19.0 and pnpm 10.30.3 pins remain initially, so unrelated
runtime upgrades do not confound the experiment.

Run the target migrator before updating old project dependencies. Resolve all
BLOCK findings and review all REVIEW findings. Default upgrade mode should not
repeat agent/editor setup. Existing Lefthook preservation by the migrator is
expected; native hook adoption is a separate deliberate task.

The old provisional consolidation decision `udusuvfkcj` preferred non-cached
orchestration and preserved custom owners. The current user request explicitly
opens that design for reconsideration. Update the decision with the accepted
candidate, rather than silently treating the historical choice as firm approval
or silently changing it during planning.

The current repository instructions still require Corepack-controlled CI and
Lefthook ownership. The experiment must update applicable authorities together
with their proven replacements. It must not bypass them before that change is
accepted. Installed Git hooks are shared across linked worktrees; first prove
native hook behavior in disposable repositories. Activation that can affect
the primary checkout is outside overnight scope. Keep shared hooks unchanged.
Retain a small compatible entry point if necessary so candidate commits still
execute the required checks. Never bypass hooks to complete the experiment.

## Unattended execution and hosted route

Start the eight-hour elapsed-time limit when approved execution begins. There
is no fixed count of ordinary feature-branch repair pushes within that window.
Continue without question prompts using the fallbacks below. A failed command
does not establish a pass, and the deadline never authorizes weaker criteria.

No existing hosted route verifies this candidate. Current `publish.yml` runs
only on push; its default-branch authority selects `feat/v3`. A push to the
candidate currently runs routing and skips development verification and npm
publication. Existing default-branch CI does not provide this v3 comparison.

Add one separate workflow triggered only by pushes to `vite-plus-1-toolchain`.
Use read-only repository permissions, no OIDC or npm credentials, no deploy,
and no publication job. It runs a cold baseline job pinned to
`1b964ee320832100b8715503a8a7747b0d0fc591`, followed by a cold candidate job pinned
to the pushed commit. Both use the contracted runner class and resource limits.
Run the candidate even if baseline verification fails, unless cancelled. Each
revision uses its own verified bootstrap and recorded scheduling policy.
Serialize experimental workflow runs so their measurements do not compete.

Retain logs and timings on failure. Reuse valid hosted baseline evidence after
candidate-only repairs when its inputs, runner class, limits, and cold state
remain applicable. Otherwise rerun the baseline. Never treat a historical
candidate pass as evidence for changed candidate inputs.

Before each push, read the default-branch publication authority and confirm the
candidate ref is not selected. Review the candidate workflow and diff to ensure
the push cannot publish or deploy. If routing changes or that guarantee cannot
be established, do not push; continue safe local work and report hosted
qualification pending rather than asking for expanded permission.

After a failed hosted run, make a concrete correction and rerun affected local
checks before an ordinary repair push. Rerun the same unchanged commit only
for an evidenced transient infrastructure failure. Do not loop on unchanged
product failures, push empty repair commits, cancel remote runs, or change the
publisher. Read-only monitoring and evidence collection may continue after
these feature pushes. Stop remote work at the deadline and report any still
running workflow as running, not passed.

The experimental verification step has a 30-minute limit within a 45-minute job
limit to allow provisioning and evidence retention. Package samples remain
bounded to 20 minutes. The eight-hour overall limit takes precedence. Timeout
is failed or incomplete evidence; do not automatically extend these limits.

## Small before/after measurement

This is a diagnostic comparison, not a statistical certification campaign.

1. Run both revisions serially on the same idle machine and record CPU, memory,
   OS, exact Node/pnpm/launcher/local-tool versions, worker limits, revisions,
   commands, environment, test inventory, and outcomes.
2. Measure the package owner with **one cold and two warm samples per revision**.
   Cold means empty worktree-specific transform/task/generated caches, with
   dependencies already provisioned. Warm means reuse only that revision's
   valid caches. Never share mutable generated fixtures across revisions.
3. Measure **one cold development-verification run per revision** under matched
   worker limits. This preserves the source/package contention context that
   package-only timings cannot reveal. Record failed or cancelled owners too.
4. Compare package wall/setup/residual time, slow files/assertions, child-process
   counts, maximum concurrency, and total development-verification time. Report
   both warm samples and their range, rather than presenting two samples as a
   reliable percentile or confidence interval.
5. Bound each package sample to 20 minutes and each development run to 30
   minutes. On timeout, settle child processes and retain the failure evidence;
   do not restart repeatedly or increase budgets to make the comparison pass.

Baseline measurements must happen before task 2. A source failure or inability
to complete a cold run is evidence, not permission to weaken tests. Keep logs
and structured reports even on failure. Compare required scenarios, assertions,
discovery results, and matrix rows; counts may change only with an explicit
coverage mapping for merged or replaced checks.

Use existing timing and report facilities before creating a new benchmark
framework. Measurements and caches live in isolated disposable locations; only
the bounded summary and retained evidence references belong in the review.

The proposed adoption target is a material package-time improvement, provisionally
20% or more in the warm comparison, with no unexplained cold end-to-end
regression. Report the actual result if that target is not met. Do not claim
the version upgrade caused all gains when workload changes also contribute.

Hosted CI is the acceptance authority for the 515-second package budget. Require
one cold, non-publishing development-verification run per revision on the same
contracted runner class, with matched resource limits and each revision's
recorded scheduling policy. Hosted cold means provisioned dependencies and
empty transform/task/generated caches, as above. Use the production package-owner
wall-time measurement, including setup, and retain source/package concurrency
and cancellation evidence. The candidate must pass required development
verification and keep package wall time at or below 515,000 ms.

Local, warm, and standalone-package timings are diagnostic; they cannot satisfy
this hosted gate. If final execution approval, a safe workflow route, or runner
availability is missing, mark the gate blocked, not passed. The approved
feature-push route is the only remote execution route in this experiment.

## Caching and failure probes

Cache dependencies and deterministic preparation only after identifying the
expensive work and its complete inputs. Include relevant source, contracts,
lockfile, configuration, tool versions, platform, and environment in identity.
Restore caches without restoring trust in a prior successful test verdict.

Use bounded disposable probes: unchanged-input hit, changed-input miss, corrupt
entry rejection, cancelled child, and failed child. Verify fresh assertions
still run, errors propagate, and cleanup waits for children. Independent
deterministic-byte constructions must not both be replaced by the same cached
artifact, which would make their agreement meaningless.

The OIDC publication job remains outside task execution and caching. Do not
place it behind `vp run`, run candidate code there, rebuild its tarball, or
broaden credential inheritance. Preserve fixed reviewed logic, exact-byte
publication, queue/history/replay behavior, and credential-free guard children.

## Concessions to record during execution

Maintain one concise inventory in the review dossier:

- Tool/dependency before and after, with reasons for retained exceptions.
- Each Markdownlint rule no longer enforced, any replacement, and the effect.
- Changed formatting, exclusions, hook setup, editor commands, and recovery.
- Tests merged, replaced, removed as redundant, or retained despite high cost,
  with mappings to the required scenarios they cover.
- Cache assumptions, invalidation limits, cold-start behavior, and offline limits.
- Supported-platform evidence and any narrowed contributor compatibility.
- Custom scripts/authorities retained because Vite+ does not replace their role.

Formatting-policy concessions are within the requested experiment. Do not
accept lost consumer behavior, required defect detection, security guarantees,
or narrowed supported-platform scope. If a native tool cannot meet a required
boundary, retain a minimal existing tool or check, document the exception, and
continue. Do not rebuild the removed tool under another name or stop to ask
about a concession that this fallback already resolves.

If package profiling contradicts the proposed optimization, choose the
simplest measured alternative within the approved toolchain/verification scope
and record it. If a budget or safety criterion cannot be met after useful
bounded corrections, leave that task failed or blocked, continue independent
safe work, and deliver the actual state. Never silently redefine completion to
obtain a successful report.

## Completion and later review

Run the relevant bootstrap, hook, invalidation, static, typecheck, complete
source, hermetic, package, migration, development, and full-qualification checks.
Keep development results distinct from full release assurance. Reuse unchanged
passing evidence, but rerun checks affected by each correction.

Finish with the candidate revision, verification results, small performance
summary, coverage mapping, dependency delta, and concession inventory. Then
pause for the proper side-by-side review of the frozen baseline and candidate.
That review determines adopt, revise, or abandon and whether benefits justify
the concessions. Integration and any publishing push need fresh explicit
authorization. Approved non-publishing feature-branch repair pushes remain
within the eight-hour scope. Do not bump Agentera suite/release metadata as part
of this internal experiment.

## Evidence sources

- GitHub run metadata, failed-step logs, and artifact inventory for run
  `36920660152`, inspected read-only on 2026-10-01.
- `references/analysis/verification-policy.yaml` and
  `references/adapters/package-publication.json`.
- `packages/cli/scripts/verify-generated-overlap.mjs`, package timing and
  verification owners, package setup, and package/runtime journey tests.
- Current typed decision `udusuvfkcj` and CLI-served Plan contracts.
- [Vite+ 1.0.0 release](https://github.com/voidzero-dev/vite-plus/releases/tag/v1.0.0)
  and [migration guidance](https://viteplus.dev/guide/migrate).

No benchmark, migration, install, hook change, or publication has been performed
in this planning session. Missing profile grounding and unavailable glossary
advice were not used to infer requirements.

An independent adversarial planning review found one acceptance gap: warm or
standalone hosted timings could otherwise satisfy the budget wording without
fixing the failed development-verification context. The draft now requires cold
hosted development verification, including setup and scheduling evidence. One
finding was addressed; none was dismissed.
