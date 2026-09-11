---
name: agentera-verification
description: >-
  Run or change Agentera tests, builds, package checks, generated output,
  pre-commit hooks, and release gates. Use when diagnosing verification lanes,
  package construction, compaction, or runtime parity.
---

# Agentera verification

Load this skill before changing verification policy, diagnosing a gate, or
working on generated output and package construction.

Ordinary tests and verification mentions do not require `agentera-release`;
load it only for a release-specific need covered by its trigger.

## Environment

- Use the Node.js 24 LTS version pinned in `.node-version`.
- Use pnpm 10.30.3 through Corepack.
- `.opencode/` may keep an ignored, checkout-local npm dependency boundary when
  its runtime code or tests require `@opencode-ai/plugin` types. Its manifest
  and lockfile stay outside the root pnpm workspace and Agentera npm package.
- Run contributor commands from the repository root unless noted.

## Common gates

| Purpose | Command |
| --- | --- |
| CLI source tests | `pnpm -C packages/cli test` |
| Package boundary | `pnpm -C packages/cli run verify:package` |
| Typecheck | `pnpm -C packages/cli run typecheck` |
| Build | `pnpm -C packages/cli build` |
| Compact gate | `node packages/cli/dist/bin/agentera.js check compact` |
| Capability contract | Run the contract command below with a current build. |
| Package dry run | `pnpm -C packages/cli run pack:dry-run` |

```bash
node packages/cli/dist/bin/agentera.js check validate \
  capability-contract
```

Use a current local build for the compiled CLI and compact gate. Build when
relevant source, build configuration, dependencies or bundled inputs change, or
the artifact is absent; otherwise reuse it across invocations. A published CLI
does not verify changed local behavior.

## Verification lanes

`references/analysis/verification-policy.yaml` owns lane composition and
assignment. `packages/cli/scripts/verify-lane.mjs` executes the policy.

- Source tests prove CLI logic from temporary directories and pinned fixtures.
- Package verification proves the packed and extracted production boundary.
- Stress owns probabilistic repeated evidence.
- Performance owns machine-sensitive budgets, runs without competing owners,
  uses one worker on the policy-pinned remote runner, and records runner
  identity in its structured evidence. Local runs are diagnostic, not
  authoritative package verification evidence.
- Capacity owns large deterministic scale evidence and runs serially after
  performance before source verification readers.
- Generated overlap is the sole source, package, and build execution origin in
  release source verification.
- Routine `vp run verify:development` retains source, typecheck, private
  build/package/generation checks, stress, capacity, compact and contract readers.
  It runs the existing live CLI resource workload once per target at unchanged
  scales and heap/output limits, not five repetitions; latency stays advisory.
  Its distinct development evidence is not full qualification or a receipt.
- Explicit `vp run verify` remains full qualification: five cold repetitions and
   historical certification as well as all development safety guards. The three
  historical suites belong to `test:certification`, not source. See the packaging
  guide for the archived-history prerequisite. Certification failures stay visible.

Do not run an omitted owner separately after verification failure. Correct the
first reported owner and rerun the owning command.

Vitest does not validate this checkout's live `.agentera/` or `TODO.md` budgets.
`agentera check compact` owns committed artifact budgets. A passing test suite
does not supersede a compact failure.

See `packages/cli/test/README.md` for fixture boundaries and repository-root
coupling.

## Pre-commit hooks

`.lefthook.yml` is authoritative. Install once with:

```bash
lefthook install
```

Pre-commit runs:

- State and TODO changes run `agentera check compact` within a 10-second budget.
- Project-local `vp staged --hide-partially-staged` formats/lints supported
  TS/JS/config files and runs pinned local Markdown lint. Rules and byte-stable
  exclusions live in native config. No `stage_fixed`: unstaged hunks must stay
  unstaged. Native priority runs fixes before all validation readers. A missing
  local binary fails; recover with `vp install`.
- Native `related --run --project local` selects only the positive fast suite in
  `verification-policy.yaml#local_source`, with two workers: core utilities,
  registry contracts, argument parsing and capability-schema validation.
  No related tests is a successful no-op, not an unrelated smoke fallback.
- Root discovery partitions the source owner into `local`, `source` (remainder)
  and `guards`, without duplicates. Run `vp run test` or
  `corepack pnpm -C packages/cli run test:source` for the complete source owner.
  Bootstrap, upgrade, lifecycle, integration and other fs/subprocess contracts
  stay in full source CI; they are not automatic local-related coverage.
- fs/script/config-only changes run the configured `guards` project. This is
  deliberately limited local feedback, not proof of those artifacts' behavior.
  Whole-project typecheck is separate. Py-TS parity retains its narrow inputs.
- Routine CI executes development safety; explicit full qualification retains
  every `release` owner. Native test/hook timeouts stay in test configuration;
  the fast subset is bounded by membership, not a fixed runtime SLA.

The staged hook never invokes release verification, performance, capacity, or
package owners. Do not rely on summaries when `.lefthook.yml` has changed.

Use `LEFTHOOK=0` only when the hook configuration itself is broken or a failure
is already tracked for CI. Never use it for routine commits, TODO changes, or
fixtures.

## Package construction

The v3 npm package publishes only `dist/` and `bundle/`. The package is
self-contained and includes runtime data under `packages/cli/bundle/`.

`packages/cli/scripts/pack-package.mjs` constructs an isolated package tree and
runs `npm pack` with lifecycle scripts disabled. Checkout `prepack` rejects
direct `npm pack`; it is a safety guard, not a build step. Do not bypass it.
For a normal development push, CI allocates
`3.0.0-dev.(GITHUB_RUN_NUMBER + 89)`: runs 1, 2, and 3 map to
`3.0.0-dev.90`, `3.0.0-dev.91`, and `3.0.0-dev.92`. This fixed offset preserves
allocation after the workflow rename. Only copied manifest
`version` and `agentera.gitRef` change. Ordinary pushes require no pre-push
development version bump or metadata-only release commit. Failed runs can
leave gaps; a rerun reuses the same run number, `GITHUB_SHA`, and candidate
version. Manual readiness remains based on the committed manifest version and
explicit source commit. Source and receipt checks remain bound to the clean
pushed checkout.

Package verification requires an executable regular
`dist/bin/agentera.js`, excludes source maps, and verifies source, generated,
and extracted runtime parity. Construction refuses to overwrite an existing
artifact.

`docs/packaging/v3-packaging.md` owns generated-output construction, package
bounds, and publication interaction. Standalone generated-overlap removes its
private temporary root after success or failure. Release verification retains
its parent-owned root through barrier B and removes it in the DAG-level
`finally`. Never force-kill generated overlap during source verification.

## Behavioral verification

Run the narrowest relevant check first, then broaden according to impact.
Apply `skills/agentera/protocol.yaml#OPERATING_RULES`: passing evidence remains
applicable only while task/scope, inputs, environment and coverage match. Run
checks for concrete gaps, relevant invalidation and mandatory gates, not merely
because work crossed a handoff. Missing, stale or unrelated evidence is not PASS;
reuse never bypasses configured hooks, CI or trust-boundary requirements.

For changed or unverified work, cover relevant structure and observable behavior:

1. Inspect the diff against the requested scope.
2. Run targeted tests or validation for uncovered or invalidated behavior.
3. Run required typecheck and ensure a current build when source or package
   behavior can change.
4. Invoke the realistic local CLI against representative state when CLI behavior
   needs verification; prose-only work uses relevant documentation checks.
5. Run broader package, compact, or release gates when required by the affected
   boundary, without treating narrower evidence as broader qualification.

Do not weaken tests to pass a gate. Report exact commands, results, and any
unverified boundary.
