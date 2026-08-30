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
| Capability contract | Run the contract command below after build. |
| Package dry run | `pnpm -C packages/cli run pack:dry-run` |

```bash
node packages/cli/dist/bin/agentera.js check validate \
  capability-contract --format json
```

Build before invoking the local compiled CLI or the compact gate.

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
- Ordinary source changes run deterministic source-owned tests plus typecheck
  within 60 seconds, with at most two Vitest workers.
- Specialized and global owner surfaces route to `ci_owned`; the local hook
  runs source-owned route guards while required CI executes `release`
  authoritatively.
- Markdown lint and supported configuration formatting each have a 10-second
  budget. Py-TS parity runs only for its analytics inputs.

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
`3.0.0-dev.(GITHUB_RUN_NUMBER + 80)`: runs 4, 5, and 6 map to
`3.0.0-dev.84`, `3.0.0-dev.85`, and `3.0.0-dev.86`. Only copied manifest
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
Verification must include both structure and observable behavior:

1. Inspect the diff against the requested scope.
2. Run targeted tests or validation.
3. Run typecheck and build when source or package behavior can change.
4. Invoke the realistic CLI entry point against representative state.
5. Run broader package, compact, or release gates when the change crosses
   those boundaries.

Do not weaken tests to pass a gate. Report exact commands, results, and any
unverified boundary.
