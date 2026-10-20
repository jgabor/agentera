# Vite+ toolchain guide

Vite+ is Agentera's contributor toolchain; [contributor setup](#contributor-setup)
names the pinned release. It manages Node.js and pnpm,
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

The supported combination is standalone Vite+ **1.3.0**, the Node.js release
pinned in `.node-version`, and pnpm **10.30.3** on Linux x64. The installed
local Vite+ must report exactly 1.3.0. macOS and Windows are not qualified by
the Linux evidence.

The standalone launcher may be any stable release in the accepted range
`>=1.3.0 <2.0.0`. Only the official 1.3.0 release asset is qualified:

- **1.3.0:** qualified. The toolchain check reports it as `qualified`.
- **A newer stable 1.x release:** accepted but unqualified. The toolchain check
  and the pre-commit hook run, report the launcher as `accepted_unqualified`,
  and list the results the repository has not qualified for it. Do not
  downgrade it to pass a check.
- **An older 1.x release, any prerelease or build-tagged version, 0.x, or 2.0.0
  and later:** rejected. The toolchain check and the hook fail before project
  commands run, with recovery naming the pin and this range.

These results depend on the launcher rather than the local Vite+, so they are
qualified only for 1.3.0:

- Managed Node.js download and selection: `vp env on`, `vp env exec --node`,
  `vp node`, and the runtime of root tasks.
- pnpm acquisition from the hash-pinned `packageManager`: `vp install` and
  `vp exec pnpm`.
- Dispatch to the local Vite+ through `VP_CLI_BIN`, including the native-cache
  guard characterization. The task cache itself is in the local Vite+, but it
  was observed only through the pinned launcher.
- Git hook dispatch: `vp exec` in `.vite-hooks/pre-commit`.

Obtain the standalone launcher from the trusted
[Vite+ v1.3.0 release](https://github.com/voidzero-dev/vite-plus/releases/tag/v1.3.0),
not the Node-dependent project shim or an unpinned installer. The verified Linux
x64 asset is `vp-x86_64-unknown-linux-gnu.tar.gz`. Verify its SHA-256 and
provenance against the [bootstrap authority](../../references/analysis/bootstrap-integrity.md)
before extraction or execution; that authority also owns credential isolation
and fresh/warm cache limits. Extract the executable into a user-owned directory
on both the ordinary shell `PATH` and Git's `PATH`. Download and extraction
tools are OS prerequisites, not provided by Vite+.

For a newer 1.x launcher, download the same `vp-x86_64-unknown-linux-gnu.tar.gz`
asset from that version's page under
[Vite+ releases](https://github.com/voidzero-dev/vite-plus/releases), and check
its SHA-256 against the digest GitHub publishes for that asset before
extraction. The repository records reviewed digests only for the pin, so such a
launcher stays unqualified. Distribution-packaged builds, such as the Arch Linux
`vite-plus` package, are not qualified at any version. The version check cannot
tell them from the official asset, so a packaged 1.3.0 also reports
`qualified`. The CI bootstrap still downloads and accepts only the pinned,
digest-verified 1.3.0 asset.

First install, also used for dependency recovery, from the repository root:

```bash
vp --version
vp env on
VP_GIT_HOOKS=0 vp install --frozen-lockfile
```

`vp run bootstrap` repeats the frozen install only after local dependencies
exist; it is not the fresh-checkout entry point. If the launcher is missing or
outside the accepted range, restore a standalone executable in that range on
`PATH` first. If the frozen lock check
fails, restore matching checked-in manifests and lockfile, then rerun the frozen
install. Do not bypass the lock check or install another package manager.

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

### Optional checkout-local runtime dependencies

Only when optional `.opencode/` runtime code or tests need its declared types,
and its npm manifest and lockfile are present, run this from the repository root
after the root install:

```bash
vp exec npm --prefix .opencode install --ignore-scripts --no-audit --no-fund
```

This uses managed npm with the nested `package.json` and `package-lock.json`. It
is not part of the root install. Keep that ignored dependency boundary outside
the pnpm workspace and the Agentera package; do not replace it with
`vp install` in the nested directory. Optional npm `--offline` also requires its
dependency artifacts locally.

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
with `env exec --node` from `.node-version`. A displayed pin is not proof of
the actual child process version; check the executable location.

The managed runtime is selected only in managed mode, which `vp env on` enables
during setup. In system-first mode, Vite+ 1.3.0 runs the system Node even for
`env exec --node` with a different requested version. Keep managed mode on.

In managed mode, native `run` and `exec` at the repository root follow
`.node-version`. Under `vp -C packages/cli`, the CLI package's `engines >=22`
range selects a managed Node that satisfies it (24.22.0 in the re-test with a
24.19.0 root pin) instead of the root's exact pin.
These managed-mode and system-first behaviors were confirmed by executable
location with the digest-verified Vite+ 1.3.0 release binary in a fresh
fixture. For package-directory recipes, use this explicit boundary rather than changing
global PATH or weakening guards:

```bash
vp env exec --node "$(cat .node-version)" vp -C packages/cli run TASK
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

Pinned Vite+ can print `Cache lookup failed` and return exit 0 without running
the child. The fault was characterized on 1.0.0 and reproduces unchanged on
1.3.0: same message, exit status, and `cache_entries` storage. Never treat that
skipped execution as a pass.
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

The recorded hosted runs in this section used Vite+ 1.0.0 and the managed Node
pin of that time. Hosted acceptance of Vite+ 1.3.0 is pending.

The recorded final [hosted candidate job](https://github.com/jgabor/agentera/actions/runs/37062016377/job/111025358674)
qualified code `bfb03785`. It passed **all 11 development gates** in
**26m 35.592s** (1,595.592 seconds).

| Check   | Final result                                       | Actual owner wall time |
| ------- | -------------------------------------------------- | ---------------------- |
| Source  | 293 files; 4,959 passed, 0 failed, 1 platform skip | 24m 35.230s            |
| Package | 7 files; 72 passed, 0 failed or skipped            | 7m 16.817s             |

Package wall time includes 21.089 seconds of setup. It is 78.183 seconds below
the then-current 515-second budget. The baseline package took 786.424 seconds and
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

The migration-only comparison workflow and its dedicated test are retired; the
linked run remains historical qualification evidence. Ordinary `publish.yml`
development verification now uses that candidate's one-source-worker profile.
Local source defaults and the package's one-worker allocation stay unchanged.
The policy now allows 600 seconds for the whole package owner, explicitly
authorized after publication run [37080534700](https://github.com/jgabor/agentera/actions/runs/37080534700)
passed package tests but exceeded the former limit at 551.062 seconds.
That run did not complete source verification, build a candidate, or publish.
The fixed OIDC publisher is unchanged. The recorded development pass is not
full historical release certification or a publication receipt; the repaired
publication profile still needs a fresh passing ordinary CI run.

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
