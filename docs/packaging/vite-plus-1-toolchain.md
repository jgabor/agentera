# Vite+ 1.0 toolchain guide

Vite+ 1.0.0 is Agentera's contributor toolchain. It manages Node.js and pnpm,
supplies the test and formatting tools, and owns local Git hooks.
The consolidation is merged into `feat/v3`. Consumer use remains
`npx -y agentera@next`; the toolchain does not change the published CLI contract.

## What changed

- Vite+ replaces separate Corepack setup in contributor and build/verification
  paths. The fixed OIDC publisher and its publication permissions are unchanged.
- Native Vite+ hooks replace Lefthook. The old installed `run pre-commit` entry
  point has a small forwarding bridge, not a second hook manager.
- Oxfmt formats Markdown instead of Markdownlint. This accepts a real loss of
  structural checks, described under [formatting and hooks](#formatting-and-hooks).
- Root pnpm script aliases move to native tasks in `vite.config.ts`.
  Use `vp run TASK`; package-level pnpm scripts remain the internal owners.
- Tests use the bundled Vitest. Preparation can be reused, but required checks
  still execute. Only developer typecheck has an explicit guarded cache option.
- Package journeys run independent scenarios concurrently, with bounded cleanup.
  They retain the same assertions and independent package constructions.

## Contributor setup

The supported combination is standalone Vite+ **1.0.0**, Node.js **24.19.0**,
and pnpm **10.30.3** on Linux x64. Both the launcher and installed local Vite+
must report 1.0.0. macOS and Windows are not qualified by the Linux evidence.

Follow [AGENTS.md](../../AGENTS.md#common-commands) for launcher installation
and recovery. The [bootstrap authority](../../references/analysis/bootstrap-integrity.md)
owns archive verification, provenance, and credential isolation. Use the trusted
standalone launcher, not the Node-dependent project shim or an unpinned installer.

From the repository root:

```bash
vp --version
vp env on
VP_GIT_HOOKS=0 vp install --frozen-lockfile
```

Installation does not authorize hook activation. In an independent clone,
enable hooks after installation and inspect their status:

```bash
vp hooks enable
vp hooks status
```

A linked worktree shares Git configuration. Do not activate hooks there without
permission. Each worktree still needs its own dependencies and launcher discovery.
Vite+ does not supply OS utilities or Git history; see the
[test prerequisites](../../packages/cli/test/README.md#contributor-prerequisites).
Warm cached offline use works, but an empty offline cache cannot provision Node.

## Daily commands

Run these from the repository root after setup:

| Command                     | Purpose                                                  |
| --------------------------- | -------------------------------------------------------- |
| `vp check`                  | Formatting and lint checks                               |
| `vp run typecheck`          | Fresh compiler check                                     |
| `vp run test`               | Complete source test owner                               |
| `vp run build`              | Build the Agentera CLI                                   |
| `vp run verify:development` | Routine development safety gates                         |
| `vp run verify`             | Full qualification, including historical certification   |
| `vp run test:local`         | Fast local-project diagnostic, not full source assurance |
| `vp run typecheck:fresh`    | Explicit alias for fresh typecheck                       |
| `vp run typecheck:cached`   | Opt-in guarded developer compiler feedback               |

Native `vp test` and `vp build` are **not** aliases for `vp run test` and
`vp run build`. Full verification includes repeated measurements and historical
certification; development verification is a smaller, distinct qualification.
Neither a local test pass nor development qualification is a release receipt.

### Keep the Node boundary explicit

Root runtime-bearing tasks use the invoking standalone launcher's `VP_CLI_BIN`
with `env exec --node` from `.node-version`. Native `run` or `exec` alone can
select ambient Node, even after managed setup. A displayed pin is not proof of
the actual child process version.

The CLI package's `engines >=22` range can influence native runtime resolution
instead of selecting the root's exact Node pin. For package-directory recipes,
use this explicit boundary rather than changing global PATH or weakening guards:

```bash
vp env exec --node 24.19.0 vp -C packages/cli run TASK
```

For release and package recipes, follow the
[packaging authority](v3-packaging.md#contributor-command-entrypoints).
These commands grant no publication permission.

## Fresh checks and optional caching

Required root tasks have `cache: false`, including under `vp run --cache`.
Default typecheck, hooks, tests, lint, mandatory verification, builds, package
checks, and publication do not reuse passing verdicts.

Vitest's `fsModuleCache` reuses transformed-module preparation. Assertions still
run on each invocation. This is separate from replaying a successful task result.

`typecheck:cached` is the sole opt-in verdict cache. Its public task always runs
an outer guard before invoking private `_typecheck:cached`. The compiler remains
read-only (`tsc --noEmit`), and the cache restores no output artifacts.
Do not invoke the private task as an assurance entry.

Source, test, manifest, lockfile, toolchain, and relevant environment changes
invalidate the compiler verdict. Test files are invalidation inputs, not a claim
that typecheck checks tests or that tests themselves are cached.
Qualification covers real compiler launches, invalidation, compiler errors,
cancellation, and malformed cache entries. All three hosted cache-qualification
assertions passed in the final development run.

### Known cache fault and recovery

Pinned Vite+ 1.0.0 can print `Cache lookup failed` and return exit 0 without
running the child. Never treat that skipped execution as a pass.
`packages/cli/scripts/guard-native-cache.mjs` rejects the known diagnostic from
outside the native cache lookup. It is a workaround, not an upstream repair
or a security boundary against someone who controls the checkout.

If the guard reports that fault, use `vp run typecheck:fresh` for a fresh check.
There is no automatic cache clearing or retry. Ordinary compiler or task failures
remain failures and need their own diagnosis. The frequency of natural cache
corruption is unknown; related upstream
[issue 2636](https://github.com/voidzero-dev/vite-plus/issues/2636) is not a promised fix.

## Formatting and hooks

Oxfmt owns eligible Markdown formatting, **not structural Markdown policy**.
It does not replace checks for heading order, link targets and fragments,
image alt text, or descriptive link text. No custom replacement linter was added.
Passing formatting therefore does not prove those properties.

Root, package, and editor formatting share `vite.config.ts#fmt`, width 320,
and its exclusions. Keep prose readable rather than filling that width.
Typed state, TODO/changelog artifacts, runtime contracts, retained evidence,
fixtures, and generated output keep their existing byte and ownership boundaries.
Excluded files still need their applicable validation; exclusion is not approval.

The native staged policy formats and lints first, then runs scoped readers in
the same snapshot that hides unstaged portions of partially staged files.
It retains compact-state and Python/TypeScript parity checks, import-related
tests in the fast `local` project, authority guards, and fresh typecheck.
The `local`, remaining `source`, and `guards` projects partition source discovery
without duplication. Specialized CI owners remain separate.

Hooks prevent ordinary mistakes, not deliberate bypass. Inspect `vp hooks status`:
disable flags, a foreign `core.hooksPath`, or missing OS utilities such as
`basename` can prevent execution despite a successful setup command.
Do not add package, performance, capacity, or release work to pre-commit.

## Qualification and performance

The final [hosted candidate job](https://github.com/jgabor/agentera/actions/runs/37062016377/job/111025358674)
qualified code `bfb03785`. It passed **all 11 development gates** in
**26m 35.592s** (1,595.592 seconds).

| Check   | Final result                                       | Actual owner wall time |
| ------- | -------------------------------------------------- | ---------------------- |
| Source  | 293 files; 4,959 passed, 0 failed, 1 platform skip | 24m 35.230s            |
| Package | 7 files; 72 passed, 0 failed or skipped            | 7m 16.817s             |

Package wall time includes 21.089 seconds of setup. It is 78.183 seconds below
the unchanged 515-second budget. The baseline package took 786.424 seconds and
failed that budget, which made the overall comparison workflow red. That baseline
failure does not negate the candidate's complete development pass.

This is not a version-only causal benchmark. Baseline and candidate used separate
host instances, and source allocation changed from two workers to one.
Source and package ran together, so their durations are not additive.

Package verification keeps one Vitest worker while allowing at most four
independent journey scenarios together. This is distinct from source-worker
allocation. Each journey owns its project/home and keeps command order and
assertions. Cancellation drains children and settles the test body before
fixture deletion; asynchronous cleanup must not race still-running work.

The experiment performed no publication and did not alter the fixed OIDC
publisher. Its development pass is not full historical release certification
or a publication receipt. Earlier failed attempts are not the current verdict.

## Remaining limits

- The source owner still takes about 25 minutes on the measured host.
  Reducing development-gate and source wall time is future optimization work,
  not a blocker to the completed consolidation.
- Full historical certification has pre-existing archive-binding failures.
  CLI long-path budget fragility also remains unresolved. Development success
  does not claim those issues are fixed.
- Guarded compiler caching contains one known native failure mode, not every
  possible upstream fault. Keep mandatory checks fresh.
- Linux x64 qualification does not establish support for other platforms,
  actual editor integrations, or first-use offline provisioning.
