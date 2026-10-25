---
name: agentera-verification
description: >-
  Change or diagnose Agentera verification. Use for test lanes, typecheck and
  build gates, generated output, package construction, compaction, pre-commit
  hooks, and runtime parity.
---

# Agentera verification

Load this skill before changing or diagnosing tests, verification lanes,
hooks, generated output, package construction, compaction, or runtime parity.
Running the daily commands in `AGENTS.md#common-commands` does not require it.

Ordinary tests and verification do not require `agentera-release`; load it
only for a release-specific need covered by its trigger.

## Terms

- **Owner:** the command that runs one set of tests or checks, as assigned in
  `references/analysis/verification-policy.yaml#owners`.
- **`local` project:** an explicit allowlist of fast source tests
  (`verification-policy.yaml#local_source`). Membership, not a time budget,
  bounds it; test and hook timeouts stay in test configuration.
- **Generated overlap:** the only private owner of generated output. In
  release verification, source, package, and build evidence all run through
  it.

## Environment

Setup, dependency recovery, and the optional `.opencode` npm recipe live in
`docs/packaging/vite-plus-1-toolchain.md#contributor-setup`. OS tools and Git
history required by tests are listed in `packages/cli/test/README.md`.

Run contributor commands from the repository root. Root `vp run` tasks select
`.node-version` explicitly. Bare `vp -C` can select ambient Node, so run
package-directory recipes as:

```bash
vp env exec --node "$(cat .node-version)" vp -C packages/cli run TASK
```

Do not weaken the process-version guard or change global PATH to repair a
Node mismatch.

## Common gates

| Purpose             | Command                                                                           |
| ------------------- | --------------------------------------------------------------------------------- |
| CLI source tests    | `vp run test`                                                                     |
| Package boundary    | `vp env exec --node "$(cat .node-version)" vp -C packages/cli run verify:package` |
| Typecheck           | `vp run typecheck`                                                                |
| Build               | `vp run build`                                                                    |
| Compact gate        | `vp node packages/cli/dist/bin/agentera.js check compact`                         |
| Capability contract | `vp node packages/cli/dist/bin/agentera.js check validate capability-contract`    |
| Package dry run     | `vp env exec --node "$(cat .node-version)" vp -C packages/cli run pack:dry-run`   |

The compact and contract gates need a current local build. Build when relevant
source, build configuration, dependencies, or bundled inputs change, or the
artifact is absent; otherwise reuse it. A published CLI does not verify changed
local behavior.

## Verification lanes

`references/analysis/verification-policy.yaml` owns lane composition and
assignment. `packages/cli/scripts/verify-lane.mjs` executes the policy.

- Source tests prove CLI logic from temporary directories and pinned fixtures.
- Package verification proves the packed and extracted production boundary.
- Stress owns probabilistic repeated evidence.
- Performance owns machine-sensitive budgets. It runs alone, with one worker, on
  the policy-pinned remote runner, and records runner identity. Local runs are
  diagnostic only.
- Capacity owns large deterministic scale evidence and runs serially after
  performance.
- `vp run verify:development` is routine development safety: source,
  typecheck, build, package and generation checks, stress, capacity, compact,
  contract, and activation-conjunction readers. It runs the live CLI resource workload once per target
  at unchanged scales and limits; latency is advisory. Its evidence is not full
  qualification or a receipt.
- Development CI splits the source owner by
  `verification-policy.yaml#source_partitions`: the core job runs
  `vp run verify:development` with `AGENTERA_SOURCE_PARTITION=core` and reports
  `partial`, each shard job runs `vp run verify:development:shard`, and
  `vp run verify:development:assemble` passes only when every partition passed
  and together they cover the exact source inventory once. Receipts and
  `vp run verify` refuse a partition.
- The CI core delegates `verification-policy.yaml#isolated_owners` with
  `AGENTERA_ISOLATED_OWNERS=delegate`. It skips stress, performance, and
  capacity, and keeps the package owner and the read-only barrier B
  validators. An isolated-owner job runs `vp run verify:development:isolated`
  on its own runner with no other verification owner: stress, then performance
  alone, then capacity. Shard 3 also builds the checkout CLI and runs the
  migration scenarios after its own verification. Receipts, `vp run verify`,
  and shards refuse delegation.
- All partition jobs run in parallel. The candidate build job downloads their
  reports and runs assembly in build mode, before version allocation.
  Cross-runner barriers cannot hold, so assembly replaces them: the core and
  the isolated part must each reconcile their own timings, and no candidate is built unless the core, every
  shard, and the isolated part passed for one source identity.
- `vp run verify` is full qualification: the same eleven gates with five cold
  performance repetitions. Its failures stay visible.

After a verification failure, correct the first reported owner and rerun the
owning command. Do not run an omitted owner separately.

Vitest does not validate this checkout's live `.agentera/` or `TODO.md` budgets.
`agentera check compact` owns committed artifact budgets; a passing test suite
does not supersede a compact failure. See `packages/cli/test/README.md` for
fixture boundaries and repository-root coupling.

## Pre-commit hooks

Vite+ is the sole hook owner. `.vite-hooks/pre-commit`, `vite.config.ts#staged`,
and `packages/cli/scripts/pre-commit-checks.mjs` own the policy. After
dependencies exist, activate hooks only in an independent clone or with explicit
permission to change shared Git configuration:

```bash
vp hooks enable
vp hooks status
```

The hook needs standalone Vite+ on Git's `PATH`, in the launcher range the
toolchain check accepts; no ambient Node, pnpm, or
Corepack is required. An old installed common hook can still call
`run-lefthook.sh run pre-commit`, which only forwards to the native policy. Do
not change common hooks or shared config as dependency recovery.
`VP_GIT_HOOKS=0` during an install prevents automatic activation; it does not
skip checks at later commits. The dispatcher respects an existing foreign
`core.hooksPath` and can report success without replacing it, so inspect
`vp hooks status`. For when commit-time `VP_GIT_HOOKS=0` is allowed, see
`AGENTS.md#always-on-boundaries`.

Pre-commit runs one sequential staged task inside a snapshot that hides
unstaged hunks. `vp check --fix` runs first, then
`pre-commit-checks.mjs` selects checks from the staged paths:

- `vp check --fix` formats and lints supported TS/JS/config files and Markdown
  with Oxfmt. A missing local binary fails; recover with `vp install`.
- `.agentera/` or `TODO.md` changes run `agentera check compact` within a
  10-second budget.
- Extract-corpus changes run the Python/TypeScript parity check. It compares
  the oracle pin with `refs/remotes/origin/main`, else `refs/heads/main`, and
  needs no other history; with neither ref it fails with recovery guidance.
- Root config, scripts, tests, skills, references, workflow, or hook changes
  run the `guards` project. This is limited local feedback, not proof of those
  artifacts' behavior.
- CLI source and test changes run related tests in the `local` project with two
  workers. No related tests is a successful no-op, not a fallback to unrelated
  tests.
- TS, JS, JSON, or YAML changes run the whole-project `vp run typecheck`.

Root test discovery partitions the source owner into `local`, `source` (the
remainder), and `guards`, without duplicates. Bootstrap, upgrade, lifecycle,
integration, and other fs or subprocess contracts run only in full source
verification. Run `vp run test` for the complete source owner.

The hook never runs release verification, performance, capacity, or package
owners. Oxfmt is not a Markdown structural linter; the accepted loss of checks
and the formatting exceptions are in
`docs/packaging/vite-plus-1-toolchain.md#formatting-and-hooks`. Editors must
use the root Vite+ config and must not format excluded artifacts on save.

## Package construction

The v3 npm package publishes only `dist/` and `bundle/`, and includes runtime
data under `packages/cli/bundle/`.

`packages/cli/scripts/pack-package.mjs` constructs an isolated package tree and
runs `npm pack` with lifecycle scripts disabled. Checkout `prepack` rejects
direct `npm pack`; it is a safety guard, not a build step. Do not bypass it.
Use root `vp run cli:*` wrappers for named release tasks and keep forwarded
arguments, including a literal `--`, in their documented order. Stable wrappers
target `packages/cli/shim`, outside the pnpm workspace. These commands do not
grant release or registry-mutation permission. Version allocation and push
publication belong to `agentera-release`. CI's native Vite+ bootstrap, the
internal pnpm scripts, and the fixed OIDC publisher are separate authorities,
not alternate contributor setup recipes.

Package verification requires an executable regular `dist/bin/agentera.js`,
excludes source maps, and verifies source, generated, and extracted runtime
parity. Construction refuses to overwrite an existing artifact.

`docs/packaging/v3-packaging.md` owns generated-output construction, package
bounds, and publication interaction. Generated overlap removes its private
temporary root after success or failure; in release verification, the parent
coordinator keeps that root until all readers finish. Never force-kill
generated overlap during source verification.

For the single-file host boundary, use the package-registry-selected host
projection, not the internal skill tree. Verify exactly one regular `SKILL.md`
and CLI-only discovery from an extracted package with isolated HOME; layout
checks alone do not qualify complete workflows. The semantic and evidence map
is `docs/cli-coverage-contract.md`; consumer lifecycle and platform limits live
in `UPGRADE.md`. Never test conversion against a live home or prune symlink
targets.

## Behavioral verification

Run the narrowest relevant check first, then broaden according to impact.
Apply `skills/agentera/protocol.yaml#OPERATING_RULES`: passing evidence stays
applicable only while task, scope, inputs, environment, and coverage match. Run
checks for concrete gaps, relevant invalidation, and mandatory gates, not
merely because work crossed a handoff. Missing, stale, or unrelated evidence is
not PASS; reuse never bypasses configured hooks, CI, or trust-boundary
requirements.

For changed or unverified work:

1. Inspect the diff against the requested scope.
2. Run targeted tests or validation for uncovered or invalidated behavior.
3. Run required typecheck and ensure a current build when source or package
   behavior can change.
4. Invoke the local CLI against representative state when CLI behavior needs
   verification; prose-only work uses relevant documentation checks.
5. Run broader package, compact, or release gates when the affected boundary
   requires them. Narrower evidence is not broader qualification.

Do not weaken tests to pass a gate. Report exact commands, results, and any
unverified boundary.
