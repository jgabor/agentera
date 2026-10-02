# Vite+ 1.0 cache comparison follow-up

## Scope and result

This follow-up makes cache evidence comparison-ready, not release-qualified.
Only `packages/cli/test/config/taskCache.test.ts` changes executable behavior.
Production root tasks remain `cache: false`. Root configuration, pipeline
commands, task coverage and test/child budgets remain unchanged.

The previous aggregate ran 44 native calls inside one test. The supplied hosted
run 36969918102 reported 233 seconds against a 120-second test bound. The new
suite reports each of 21 root-owner pairs separately with `concurrency: false`.
It creates one suite-owned fixture, seeds its valid diagnostic verdict once
with two calls, and cleans up in `afterAll`, not the parent's `afterEach`.
Each pair checks the execution counter before and after two real `vp run
--cache` calls. Total: 42 fresh executions plus two diagnostic calls, still 44
native calls. Splitting one test into 21 adds 20 reported source tests.

These calls exercise each owner's cache policy with the same probe command,
not the production owner workload. Many subprocesses are test overhead; their
elapsed time is not a Vite+ version-speed comparison.

## Root-owner coverage

Every row passed both calls and its counter increment of two in the focused run.

| Root owner                     | Fresh calls under `--cache` |
| ------------------------------ | --------------------------: |
| `bootstrap`                    |                           2 |
| `test`                         |                           2 |
| `test:local`                   |                           2 |
| `build`                        |                           2 |
| `verify`                       |                           2 |
| `verify:development`           |                           2 |
| `typecheck`                    |                           2 |
| `typecheck:fresh`              |                           2 |
| `cli:prepare:dev`              |                           2 |
| `cli:prepare:stable`           |                           2 |
| `cli:qualify:source`           |                           2 |
| `cli:ready:dev`                |                           2 |
| `cli:qualify:dev`              |                           2 |
| `cli:benchmark:qualification`  |                           2 |
| `cli:publish:qualified:dev`    |                           2 |
| `cli:publish:qualified:stable` |                           2 |
| `cli:approve:dev`              |                           2 |
| `cli:stage:dev`                |                           2 |
| `cli:promote:dev`              |                           2 |
| `cli:stage:stable`             |                           2 |
| `cli:promote:stable`           |                           2 |
| **Total**                      |                      **42** |

## Cancellation protocol and evidence

The old probe discarded stdout/stderr, polled a ready file for five seconds,
and let the child finish automatically 1.5 seconds after readiness. The supplied
hosted failure occurred before intended cancellation. Its exact startup cause
cannot be recovered from that discarded output. Slow startup and automatic
completion were independent fixture risks, not proven Vite defects.

The new child emits `READY` and waits for an explicit release marker outside
the fixture's bulk-data root. The parent captures stdout/stderr and rejects
startup errors, exits before READY, or a startup deadline with exit/output
context. The deadline is the existing 15-second task-child bound, replacing
the unrelated five-second poll. No test timeout or child execution budget was
increased. This aligns readiness with the established child budget and does
not permit automatic successful completion.

After READY the parent verifies one execution and a still-running child,
signals its detached process group, requires a non-successful exit, and awaits
`close` (including drained pipes). The finally block kills any remaining group
before cleanup. The retry starts with the same command and environment while
the release marker is still absent. Before creating that marker, the parent
requires READY, an execution counter of two, and a still-running retry child
(no exit code or signal). Only then does it release the retry and require a
successful close. The final warm call leaves the marker unchanged and must hit
without increasing the counter beyond two. These are still exactly three calls:
cancel, fresh retry, warm hit. The two waiting calls share a test-local helper
with output/error diagnostics, group cleanup and the existing 15-second bound
covering readiness and completion of each call.

The proof does not assume an external file is untracked: a marker absent-to-present
change could invalidate a cached cancelled verdict. Requiring the counter
increment and live child before that change rules out such a false proof. A
cached replay of READY cannot satisfy the execution-counter assertion. The
marker path is declared in the diagnostic cache environment
contract because native cached tasks filter undeclared environment variables.

Initial development checks found that native task execution did not deliver
the proposed stdin release to the probe. The final protocol therefore uses a
marker rather than stdin. This was observed fixture integration behavior, not
a claim about version performance or hosted failure causation.

## Storage and retained evidence

Fixtures, module/task caches and subprocess result JSON are on worktree disk
under ignored `.vitest/followup/cache/run-*`. Each fixture owns its cache and
symlinks only the read-only Vite+ package, never the complete `node_modules`.
A fixture-local workspace manifest prevents discovery of the enclosing
production workspace. Without this boundary the first development run selected
production tasks instead of fixture tasks.

Only sockets and the small release marker use an owned short `/tmp/atc-*`
directory, avoiding Linux's 108-byte Unix socket path limit. Fixtures and IPC
directories are removed by their owners; result JSON and top-level run logs
remain on disk. No bulk provisioning, profiles or evidence use `/tmp/opencode`.
No user evidence or global temporary-storage policy was changed.

Local tmpfs quota exhaustion or temporary-file cleanup invalidates the
environment: classify it as **ENVINVALID**, not evidence against Vite+.
Keep the failed outcome and diagnostics; do not turn it into a pass or remove
assertions. No such failure occurred in these focused runs.

## Verification

Actual process selection, not just the launcher display, was checked with:

```sh
vp env exec --node 24.19.0 node -p 'JSON.stringify({version:process.version,execPath:process.execPath})'
```

It returned `v24.19.0` and
`/home/jgabor/.vite-plus/js_runtime/node/24.19.0/bin/node`.
The retained runtime test also executes the unchanged root managed-pnpm command
with a constrained ambient PATH and asserts the real child's Node version and
forwarded arguments. Installed tools report Vite+ 1.0.0 and pnpm 10.30.3.

The ignored `.vitest/followup/cache/focused.config.ts` imports
`sharedTestConfig`, includes only this test file, and uses one worker. It does
not run source compilation/global setup or alter the shared timeout.

```sh
set -o pipefail && VP_GIT_HOOKS=0 vp env exec --node 24.19.0 vp test run --config .vitest/followup/cache/focused.config.ts --reporter=verbose 2>&1 | tee .vitest/followup/cache/focused-same-input-retry.log
vp check --fix packages/cli/test/config/taskCache.test.ts docs/packaging/vite-plus-1-followup-cache.md
vp check packages/cli/test/config/taskCache.test.ts docs/packaging/vite-plus-1-followup-cache.md
git diff --check
```

The final same-input retry run passed **30/30 tests in 7.13 seconds**, with the
CI outer `VP_GIT_HOOKS=0` context. This includes preparation
reuse with fresh assertions and warm failure, input/environment invalidation,
`--no-cache`, failed children, argument forwarding, malformed-entry false-success
characterization, wholly corrupt database rejection and cancellation.
Formatting/lint correction passed with no warnings or lint errors;
`git diff --check` passed. A narrow process check found no remaining `node
child.mjs` probes.

Development outcomes are retained, not suppressed:

- `focused-first.log`: 2 passed, 7 failed, 21 skipped. Missing fixture workspace
  boundary caused production task discovery.
- `focused-second.log`: 29 passed, 1 failed. Stdin release was not delivered.
- `focused-final.log`: 29 passed, 1 failed. Undeclared marker environment was
  filtered; the existing 15-second child timeout remained effective.
- `focused-fourth.log`: 30 passed after those fixture corrections.
- `focused-formatted.log`: 30 passed after test formatting (7.08 seconds).
- `focused-same-input-retry.log`: 30 passed with the stronger pre-release retry
  proof and CI outer hook context (7.13 seconds).

The complete file makes 73 direct subprocess invocations: 68 native task calls
(including the 44-call shared suite) and five nested preparation-test calls.
Malformed native cache entries still return zero without executing the child;
this defect remains explicitly characterized and production verdict caching
remains disabled. This is not a security boundary.

Full source, package, performance and release qualification were deliberately
not run. Hosted verification of the revised protocol remains the owner's next
comparison step; local passing evidence does not establish hosted timing.
