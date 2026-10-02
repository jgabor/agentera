# Bounded reuse proof

## Decision and scope

Keep Vitest's existing `fsModuleCache: true` for transformed-module preparation.
Execute assertions and all required verification owners on every invocation.
The sole opt-in verdict cache is developer typecheck, through an always-fresh
outer known-fault guard. The installed Vite+ 1.0.0 still returns success without
child execution for one malformed-entry fault; the guard rejects that diagnostic.
This is a workaround, not an upstream repair or cold qualification.

Root recipes moved from `package.json#scripts` to `vite.config.ts#run.tasks`.
Their names, delegated pnpm commands, targets, argument forwarding, environment,
and child-failure behavior remain unchanged. Each of the 21 required tasks has
`cache: false`, which Vite+ does not let `--cache` override. The new public cached
alias also has `cache: false`; only its distinct private task has a cache object.
Workspace `cache: { scripts: false, tasks: true }` permits that exception, not
implicit caching of required owners. Task and script names cannot
overlap, so retaining duplicate root scripts is not possible. Removed root pnpm
script aliases are replaced by the existing documented `vp run` entrypoints;
package-level pnpm owners remain unchanged.

Explicit developer commands are:

```bash
vp run test:local          # Positive fast local project only, not full source assurance
vp run typecheck:fresh     # Same fresh owner as vp run typecheck
vp run typecheck:cached    # Guarded read-only feedback; may replay a successful typecheck
```

Only `typecheck:cached` replays a verdict. Hooks and CI are not redirected to a cached
diagnostic. Hosted workflow changes, package journey changes, state, commits,
pushes, and registry mutation are outside this work.

## Current guarded developer typecheck

Public `typecheck:cached` uses managed Node to start the existing guard, which
starts `vp run _typecheck:cached` from outside native lookup. The private owner
is the unchanged `pnpm -C packages/cli run typecheck`, namely
`tsc -p tsconfig.json --noEmit`. Do not call the private task directly. Its name
is a maintainer convention, not an access-control boundary.

Inputs retain `{ auto: true }` and explicitly include `packages/cli/src/**`,
`packages/cli/test/**`, the CLI tsconfig/manifest, root manifest, lockfile,
workspace configuration, `.node-version` and toolchain baseline. Tests are a
conservative invalidation input; the existing tsconfig excludes them. This does
not claim test typechecking or cached tests. `NODE_OPTIONS`, `NODE_PATH`,
`NODE_ENV`, `PATH`, `VP_HOME`, `VP_CLI_BIN`, `VP_NODE_VERSION`,
`VP_PACKAGE_MANAGER` and `VP_PNPM_VERSION` are fingerprinted. Automatic tracking
retains compiler/dependency reads. `output: []` disables artifact restoration.

`guardedTypecheckCache.test.ts` snapshots the actual CLI source, tsconfig and
owner manifests into disk-backed, scanner-excluded fixtures with declared root
pnpm. It links installed dependencies read-only and owns the native cache.
No project state or user source is modified. A Node preload counts real compiler
launches, not replayed passing text. Source and test edits, a valid lockfile
comment edit and a `NODE_OPTIONS` toggle each require a new compiler launch.
An actual TS2322 error fails twice with two launches; a source correction passes.
Malformed SQLite entry values make the actual public alias fail with no compiler
launch, even though native lookup reports exit 0. Fresh default typecheck then
executes without clearing or repairing the private cache.

The cancellation fixture invokes the same owner and native compiler. Only its
test preload selects the installed compiler launcher's existing execFileSync
fallback instead of execve, then holds Node before exit after successful real
compilation. This gives a deterministic cancellation window. Cancellation cannot
create a passing verdict: identical command/inputs/environment execute the
compiler again before a release marker exists; only the subsequent completed
run is reusable. The retained PID/group cleanup drains children before deleting
the fixture. Default execve is used in the cold/warm, invalidation and fault proof.

Unchanged warm measurements are developer-loop evidence, not CI qualification.
The follow-up comparison records exact local samples and raw paths. Full source,
development, package and hosted qualification are separately owned and were not
run for this change. No test/lint verdict, build, installation, generated output,
package, verification, release or publication task becomes cache eligible.

## Historical native contracts checked

Environment: Linux x64, Vite+ 1.0.0, Node 24.19.0, pnpm 10.30.3, Vitest 5.0.1.
Read `vp cache --help` and `vp run --help` before probing. Installed
`vite-plus/dist/define-config-*.d.ts` and the current official
[run configuration](https://viteplus.dev/config/run.md),
[automatic tracking](https://viteplus.dev/guide/automatic-data-tracking.md), and
[cache guide](https://viteplus.dev/guide/cache.md) were consulted. Current guide
snippets show flat fields; the installed 1.0.0 declarations and native proofs
own the pinned nested `cache.input`, `cache.env` and `cache.output` syntax.

The candidate used nested `cache.input`, `cache.env`, and `cache.output`, not
older flat fields. It retained automatic tracking with `{ auto: true }`, added
`.node-version`, root/package and lock/toolchain inputs, and fingerprinted
`NODE_OPTIONS`, `NODE_PATH`, `NODE_ENV`, `PATH`, and the selected Vite+ runtime and
manager variables. The typecheck command text included the selected Node version
and executable. `output: []` disabled artifact restoration. This was a local
diagnostic verdict, not fresh assurance, even when a hit replayed passing text.
The candidate and its wrapper were removed after the fault below.

## Historical rejected candidate: unguarded local typecheck verdict

A disposable profile had its own `node_modules/.vite/task-cache`. Only the tool
package and read-only CLI inputs were linked to the checkout, not the whole
`node_modules` directory. A Node preload counted actual executions of the
diagnostic child. Counts, not replayed stdout, distinguished hits from misses.

The transient candidate was measured with:

```bash
vp node /tmp/opencode/agentera-task6-measure.mjs
vp node /tmp/opencode/agentera-task6-measure.mjs --keep-cache
```

These disposable measurement scripts were used before removing the candidate.
The checked-in regression fixture retains the cache mechanics and fault probes,
not a production benchmark framework.

| First profile operation       |     Wall time | Child execution count | Observation                                        |
| ----------------------------- | ------------: | --------------------: | -------------------------------------------------- |
| Cold local typecheck          |        657 ms |                     1 | Real owner executed                                |
| Three unchanged warm runs     | 62, 65, 66 ms |                     1 | Native hits; child not executed                    |
| `--no-cache`                  |        654 ms |                     2 | Real owner executed                                |
| Disposable lockfile mutation  |        659 ms |                     3 | Miss: `pnpm-lock.yaml` modified                    |
| Unchanged mutated input       |         61 ms |                     3 | Hit                                                |
| `NODE_ENV` mutation           |        668 ms |                     4 | Miss: environment changed                          |
| Unchanged mutated environment |         61 ms |                     4 | Hit                                                |
| `typecheck:fresh --cache`     |        628 ms |                     4 | Fresh owner executed, bypassing diagnostic wrapper |
| Invalid cache database        |         65 ms |                     4 | Exit 1: `file is not a database`                   |

The median warm saving was about 592 ms (90% of this small command). This is
useful developer-loop latency, not a material package/CI improvement. Safety
ruled out that unguarded candidate. The separately recorded guarded samples do not rewrite
this historical result or imply a package/CI saving.

The second profile kept a valid SQLite database. Using Node's `DatabaseSync`,
the probe replaced actual `cache_entries.value` blobs with invalid bytes:

```sql
UPDATE cache_entries SET value = ?
```

With unchanged task inputs and environment, the local native runner reported:

```text
Cache lookup failed: Encoded sequence length exceeded preallocation limit ...
vp run: 0/0 cache hit (0%).
```

It returned **exit 0 and did not execute the child**. Reject-or-reexecute
acceptance therefore failed. Invalidating an entire database alone would have
missed this defect. The source test characterizes this behavior explicitly and
proves that a per-task `cache: false` owner still executes beside the malformed
entry. It does not invent a successful fault-handling result.

## Known-fault outer guard and recovery

The pinned Vite+ 1.0.0 native lookup can emit `Cache lookup failed`, report a
zero-task summary, and exit 0 without starting the command. A missing child is
not a passing verdict. `packages/cli/scripts/guard-native-cache.mjs` starts the
native runner from outside its cached task and rejects this exact diagnostic on
stdout or stderr. A zero exit becomes exit 1; existing nonzero exits remain
nonzero. The guard does not retry or clear caches. Cancellation remains cancelled,
including when a child handles the signal and exits zero.

The guard forwards output bytes with stream backpressure. Its fixed-size scanner
examines all output, across chunk boundaries and ANSI CSI/OSC sequences, without
retaining whole lines or imposing a capture limit. Streams are matched separately.
Replayed or ordinary child text containing the diagnostic also fails
conservatively. This is intentional, not proof of natural corruption.

For the installed selective developer alias, the public task remains
`cache: false` and invoke managed Node to run the guard around a **distinct**
private cache-eligible task. Putting the guard inside that private command does
nothing when native lookup skips the command. Vite+ can inline literal nested
`vp run` commands, so retain a real Node process boundary and prove its placement
with the malformed-entry fixture. Only the new opt-in alias uses this route;
no existing default alias or hook is redirected.
Build, package, publication, verification wrappers, and their owners stay fresh.

When this explicit diagnostic appears, use the unchanged fresh default entry,
such as `vp run typecheck:fresh` (or `vp run typecheck`). Do not infer corruption
from every workflow failure, accept a skip, or delete shared cache data as routine
recovery. The fresh entry bypasses lookup and runs the owner even beside the
damaged entry. This is a **workaround, not an upstream repair**. The related open
upstream symptom is tracked at
[vite-plus#2636](https://github.com/voidzero-dev/vite-plus/issues/2636); it does not
establish an exact fix or a committed fix date. Requalify against any replacement
native pin before removing this workaround.

Focused regressions use valid SQLite with malformed `cache_entries.value` bytes.
They prove a valid guarded hit, rejection without execution/retry, one ordinary
failed execution, fresh recovery without cache deletion, and native cancellation
without a successful cached verdict. Separate guard tests cover both streams,
every split of ANSI-interrupted diagnostic text, output above capture defaults,
exact output and argument forwarding, spawn failure, and signal propagation.
This is accidental known-fault containment, not a security boundary against
changed tools, forged valid cache records, suppressed diagnostics, or altered
configuration. Other natural-corruption behavior remains unknown.

## Accepted reuse: transformed preparation, fresh assertions

`packages/cli/test/config/taskCache.test.ts` starts real child Vitest processes
with `fsModuleCache: true` and a disposable module-cache path. A transform plugin
counts preparation of a TypeScript subject and its test. The test body separately
records assertion execution. The observer does not supply a fake cache.

A serial diagnostic measurement used:

```bash
vp node /tmp/opencode/agentera-task6-module-measure.mjs
```

| Operation                                         | Wall time | Cumulative transforms | Cumulative assertions | Result                                |
| ------------------------------------------------- | --------: | --------------------: | --------------------: | ------------------------------------- |
| Cold                                              |    302 ms |                     2 |                     1 | Pass                                  |
| Warm 1                                            |    241 ms |                     2 |                     2 | Pass                                  |
| Warm 2                                            |    248 ms |                     2 |                     3 | Pass                                  |
| Warm 3                                            |    250 ms |                     2 |                     4 | Pass                                  |
| Runtime expectation changes to 2                  |    254 ms |                     2 |                     5 | Real assertion failure, exit 1        |
| Subject changes from 1 to 2                       |    297 ms |                     3 |                     6 | Subject preparation invalidated; pass |
| Cached module bytes overwritten with invalid text |    295 ms |                     5 |                     7 | Native retransformation; pass         |

Two deterministic transforms were avoided on each unchanged warm run. Assertions
still ran, including the failure after an environment change. The serial warm
median was 248 ms, 54 ms below the cold run. These tiny local samples prove reuse
and freshness, not a representative CI speedup or a new performance budget.

Runtime environment reads in test code remain live because the code executes
again. This does not claim that arbitrary environment-sensitive custom transform
plugins are safely fingerprinted. No such plugin or new preparation cache is
introduced here.

## Focused regression evidence

The source fixture also checks:

- Automatic input mutation, explicit tool-input mutation, environment mutation,
  unchanged hits, and `--no-cache` using child-execution counts.
- All 21 required root tasks and the new public guard wrapper execute twice under
  `--cache` even beside a valid cached
  result for the same child command. Actual qualification/publication is not
  invoked by this fixture.
- Native tasks preserve the old uncached script's exact argument vector,
  inherited environment, and nonzero child result.
- Two failed children execute twice and create no successful verdict entry.
- A started child is cancelled by process-group SIGTERM. The same command,
  inputs, and environment execute on the next invocation; only its subsequent
  successful run is reusable. No input change masks the cancellation probe.
- Whole-database corruption rejects; malformed-entry corruption exposes the
  native defect and cannot suppress a hard-fresh root owner.

## Work not cached and trust limits

No build artifacts, package bytes, required-owner verdicts, release evidence, generated
overlap result, or independent determinism constructions are restored from task
cache. Existing build source identity, private construction, and qualification
owners remain unchanged. A preparation-cache framework is not justified by the
already small build/setup costs; the package bottleneck has a separate proof.

These caches are local trusted-tool storage, **not a security boundary** against
someone who can replace valid cached JavaScript, alter the checkout/config, or
invoke a different command. The invalid-byte probes show accidental-corruption
behavior, not authentication of cached code. Cold qualification and publication
must continue to use their existing independent construction and fresh owners.
No hosted cache or publication path is added.

The hard-fresh guards apply to required root native tasks and the public guarded
alias, not its private cache-eligible owner. They do not protect an operator
who explicitly runs `vp -C packages/cli run --cache <script>` instead. Do not
request caching for package-level assurance scripts; their default remains
uncached but is CLI-overridable. Direct Node/pnpm qualification owners are not
changed into cached tasks.

## Historical verification record

- `vp test run packages/cli/test/config/taskCache.test.ts --reporter=verbose`:
  9 tests passed, including real native faults and fresh assertion probes.
- `vp test run packages/cli/test/config/taskCache.test.ts packages/cli/test/config/vitestShared.test.ts packages/cli/test/validate/toolchainBaseline.test.ts packages/cli/test/release/rootReleaseScripts.test.ts packages/cli/test/release/publicationOrchestration.test.ts --reporter=dot`:
  5 files, 60 tests passed in the final formatted state.
- Targeted `vp check --fix` followed by `vp check` for the root task config,
  manifest, affected tests, baseline helper and four documentation surfaces:
  11 files formatted; no lint warnings or errors in the six code files.
- `vp run --cache test:local`: 28 files, 641 tests passed; task caching disabled.
- `vp run --cache typecheck:fresh` and `vp run --cache typecheck`: passed;
  task caching disabled.
- `vp run --cache build`: passed; task caching disabled.
- `vp node packages/cli/scripts/verify-toolchain-baseline.mjs`: passed on
  Node 24.19.0. Fresh fixture install 2.054 s, warm frozen install 0.359 s;
  argument/cwd/runtime forwarding, failures, dependency-script policy and frozen
  lock rejection passed. These are observations, not new budgets.
- `vp -C packages/cli run test:toolchain-baseline`: failed its runtime guard
  because this invocation selected ambient Node 24.21.0. The managed `vp node`
  invocation above passed. No runtime guard was weakened and no global setup
  was changed. The package `-C` launcher behavior remains outside this task.

Full source, package journeys, hosted workflow qualification and publication were
not rerun here. This work adds bounded preparation proof and freshness guards,
not a new qualification receipt. Prime owns lifecycle closeout and commits.
