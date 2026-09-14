# Verification performance

`verify:development` includes `verify:generated-overlap`. Their durations are
nested, not additive. Overlap runs source, package and a private build together.
Development also runs stress and typecheck in that first batch, then serial
resource and capacity owners, followed by concurrent validation readers.

## Cache boundaries

- `references/analysis/toolchain-baseline.yaml#project_contract.no_task_result_cache` requires fresh
  task execution. Root package-script wrappers are uncached; the Vite config has
  no cached task definitions.
- `references/analysis/bootstrap-integrity.md` requires fresh CI dependency state because Corepack's
  warm-cache path skips its download-integrity check. Each overlap participant
  also gets isolated npm and XDG state.
- Vitest's filesystem module cache is enabled in `packages/cli/vitest.shared.ts`.
- Static report/check/recovery commands share immutable YAML mappings within one
  synchronous request. A new request reads current authorities again, including
  after failure. Comment-preserving parsing, validation, cursor binding, and
  independent package construction remain in place.

Do not cache the whole overlap result or reuse one construction as both inputs
to the package determinism check. Those changes would skip the behavior under
test. Dependency caching cannot address time spent inside an already installed
test runner.

## Progress and diagnostics

Both coordinators emit `AGENTERA_VERIFICATION_PROGRESS` records to stderr at
start, completion and every 30 seconds while a child runs. Fixed owner/status
labels and elapsed milliseconds pass through the development wrapper; arbitrary
child output does not. Stdout retains its existing JSON evidence contract.
Progress reports process activity, not qualification evidence.

Failure diagnostics preserve the first failing repository-relative test file,
bounded assertion detail, and complete bounded package-timing JSON. Package
setup timings and test-runner wall time remain distinct: the residual includes
runner startup, tests and teardown, not just measured test execution.

The package's `wall_time_budget_ms` remains a post-success acceptance budget.
It is not a subprocess timeout. The coordinator's governed absolute deadline
and cooperative cleanup remain the hard stop; neither limit is increased here.

With `AGENTERA_VERIFICATION_RESULT` set, source and package owners also write
`<result>.profile.json` before evidence normalization removes timing fields.
This separate file is diagnostic only. It contains inventory-approved relative
suite paths, numeric durations, and assertion indexes/statuses. It contains no
assertion messages or output. Missing or malformed timing data does not change
the verification result.

For standalone overlap, a fresh `AGENTERA_GENERATED_OVERLAP_ROOT` retains owner
reports, timing profiles, logs and private output. Without it, standalone overlap
cleans its private directory. Development owns and cleans its own directory;
setting this variable on the development wrapper does not retain its children.

## Compare source worker allocations

Use the root-managed runtime for the package owner. Package remains at one
worker; this override changes only the source participant. Keep inputs and
dependencies fixed, wait for other verification jobs to settle, and run cases
serially. Use a fresh result root each time.

```bash
benchmark_root=$(mktemp -d /tmp/agentera-overlap-benchmark.XXXXXX)
vp exec node --input-type=module -e '
import os from "node:os";
console.log(JSON.stringify({
  classification: "local-diagnostic",
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  cpu: os.cpus()[0]?.model,
  logicalCpus: os.cpus().length,
  availableParallelism: os.availableParallelism()
}));
' > "$benchmark_root/runner.json"
git rev-parse HEAD > "$benchmark_root/commit.txt"
git diff --binary HEAD > "$benchmark_root/changes.diff"

benchmark_status=0
for benchmark_case in r1-w4 r1-w2 r2-w2 r2-w4 r3-w4 r3-w2; do
  benchmark_workers=${benchmark_case##*-w}
  benchmark_run="$benchmark_root/$benchmark_case"
  mkdir -m 700 "$benchmark_run"
  benchmark_started_ms=$(date +%s%3N)
  env AGENTERA_GENERATED_OVERLAP_SOURCE_WORKERS="$benchmark_workers" \
    AGENTERA_GENERATED_OVERLAP_ROOT="$benchmark_run/retained" \
    AGENTERA_VITEST_RUNNER_POLICY=unmeasured \
    VITEST_TEST_TIMEOUT_MS=120000 \
    vp exec pnpm -C packages/cli run verify:generated-overlap \
    > "$benchmark_run/stdout.log" 2> "$benchmark_run/stderr.log" || benchmark_status=$?
  printf '%s\n' "$(( $(date +%s%3N) - benchmark_started_ms ))" > "$benchmark_run/elapsed-ms.txt"
  printf '%s\n' "$benchmark_status" > "$benchmark_run/exit-code.txt"
  if [ "$benchmark_status" -ne 0 ]; then break; fi
done
test "$benchmark_status" -eq 0
```

The emitted source identity covers tracked and untracked inputs. The optional
patch above does not archive untracked files; retain those separately if the
checkout is dirty and the source snapshot must be reproducible elsewhere.

Compare total and participant wall times, median and range, with identical test
counts. Keep failures visible; a failed short run is not an improvement. Use
`source.json.profile.json` to identify slow suites and join assertion indexes
with the corresponding normalized report. Suite times overlap across workers
and must not be added to calculate owner wall time.

Confirm any selected allocation with `vp run verify:development`, because its
first batch has additional competing owners. Local results cannot select a
hosted-runner default. The existing publishing workflow is push-only; rerunning
an old job measures its old commit, not local changes. Hosted measurements need
an explicitly authorized workflow run of the changed bytes.

## Investigation baseline

The September 14, 2026 investigation used commit
`6423092a6107a81e9ca23b9979d45ab1fa4086ef` and
[CI run 34838706758](https://github.com/jgabor/agentera/actions/runs/34838706758).
Bootstrap took four seconds. Development failed after 1,138,604 ms; package wall
time was 1,132,062 ms, including only 34,761 ms setup. The reported failure was
the report partition's 110-second static-discovery subprocess timeout.

A local five-query report-detail probe took 1,004–1,076 ms without request
reuse and 219–225 ms with it, with byte-identical output. File reads fell from
85 to 35. This is a microbenchmark, not a whole-suite or hosted speedup claim.

The first local overlap run with the cache change passed 4,676 source tests
(plus one declared platform skip) and all 41 package tests. Participant
times were source 342,953 ms, package 267,812 ms, and build 2,455 ms. Package
setup took 4,679 ms. Source had become the limiting owner in that run. This
initial run predates the diagnostic changes and is not final-change evidence.

## Local worker comparison

Two serial runs on September 14 used Linux x64, Node 24.19.0 and an AMD Ryzen 7
9800X3D with 16 available logical CPUs. Both used source identity
`01152517c992cdc9a159e412d6726a70311605a980ffe191f2ebb051a6c44292`.
Each passed 4,704 source tests, with one declared Darwin-only skip, and all 41
package tests. These are one clean sample per allocation, not hosted-runner
qualification or a statistically stable performance estimate.

| Source workers | Total elapsed | Source participant | Package participant | Private build |
| --- | --- | --- | --- | --- |
| 4 | 291 s | 281.228 s | 220.657 s | 2.916 s |
| 2 | 549 s | 538.909 s | 212.664 s | 2.328 s |

Total elapsed comes from second-resolution shell timestamps. Participant times
come from the overlap evidence. Two workers saved about eight seconds in the
package participant but added about 258 seconds to the source participant.
Keep the existing four-worker default. A hosted comparison is still needed
before changing the allocation for the GitHub runner.

An earlier two-worker trial failed the retained-reference inventory because this
new document was initially placed under `references/analysis/`. That placement
was corrected before the two clean runs. The failed trial is excluded above.

The four-worker timing profile identifies these largest source suites:

| Suite | Elapsed |
| --- | --- |
| `integration/runtimeBootstrapMatrix.test.ts` | 111.113 s |
| `state/todoDocsEntities.test.ts` | 102.251 s |
| `cli/personalGlossaryPublish.test.ts` | 55.119 s |
| `analytics/personalGlossaryReviewRecords.test.ts` | 53.907 s |
| `upgrade/upgradeEntityCutover.test.ts` | 52.459 s |

The bootstrap matrix already reuses its build fixture and memoizes reusable
results. Its remaining costs include live process execution, protected-root
snapshots, tampering cases and runtime parity checks. TODO/document entity tests
already invoke the CLI in-process; they cover cursor changes and journal failure
boundaries. Preserve these checks. The profile does not justify caching their
results or removing their independent cases.

Package static discovery took 155.726 s and package verification took 56.318 s.
Package setup was only 4.436 s of its 220.054 s inner wall time. Static discovery
therefore remains the largest package test after request-scoped YAML reuse.
These measurements preserve all 4,457 traversal queries, the two independent
package constructions, and the private overlap build.
