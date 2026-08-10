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

- Use Node.js 22 or newer.
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
  authoritative qualification evidence.
- Capacity owns large deterministic scale evidence and runs serially after
  performance before source-qualification readers.
- Generated overlap is the sole source, package, and build execution origin in
  release source qualification.

Do not run an omitted owner separately after qualification failure. Correct the
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

- `agentera check compact` for the `uniform_10_40_50` artifact budget.
- `scripts/precommit-vitest.sh {staged_files}` for staged-aware Vitest routing.
- Markdown lint for repository docs.
- `vp fmt` for supported configuration files.

Broad CLI, schema, skill, reference, registry, protocol, and workflow changes
route to the full source suite. Do not rely on summaries when `.lefthook.yml`
has changed.

Use `LEFTHOOK=0` only when the hook configuration itself is broken or a failure
is already tracked for CI. Never use it for routine commits, TODO changes, or
fixtures.

## Package construction

The v3 npm package publishes only `dist/` and `bundle/`. The package is
self-contained and includes runtime data under `packages/cli/bundle/`.

`packages/cli/scripts/pack-package.mjs` constructs an isolated package tree and
runs `npm pack` with lifecycle scripts disabled. Checkout `prepack` rejects
direct `npm pack`; it is a safety guard, not a build step. Do not bypass it.

Package verification requires an executable regular
`dist/bin/agentera.js`, excludes source maps, and verifies source, generated,
and extracted runtime parity. Construction refuses to overwrite an existing
artifact.

`docs/packaging/v3-packaging.md` owns generated-output construction, leases,
retention, recovery, package bounds, and publication interaction. Use its
cleanup commands rather than deleting generated state manually:

```bash
pnpm -C packages/cli run generated:cleanup -- --dry-run --json
pnpm -C packages/cli run generated:cleanup -- --force --json
```

Cleanup requires either `--dry-run` or `--force`. Inspect preserved or
uncertain ownership before removal. Never force-kill generated overlap during
source qualification.

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
