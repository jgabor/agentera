# v3 npm packaging and verification

This document is the canonical authority for checkout generated output, npm
package construction, verification ownership, retention, and recovery. Shared
development and stable publication behavior is owned by
[`references/adapters/package-publication.json`](../../references/adapters/package-publication.json).
Other contributor guides link to these authorities rather than restating them.

Agentera v3 has one distribution boundary: the self-contained `agentera` npm
package used by `npx -y agentera@next`. Native runtime packages, editor
packages, and the former Bun single-binary surface are retired.

## Package layout

`packages/cli/package.json` publishes `dist/` and `bundle/`:

```text
agentera-<version>.tgz
└── package/
    ├── package.json
    ├── dist/bin/agentera.js
    └── bundle/
        ├── .agentera-npx-bundle.json
        ├── registry.json
        ├── skills/agentera/
        └── references/
```

`packages/cli/scripts/pack-package.mjs` constructs a regular isolated package
tree, and `packages/cli/scripts/copy-bundle.mjs` stages the registry-declared
shared skill and reference inputs into that tree. It then runs `npm pack` with
lifecycle scripts disabled. Checkout `prepack` is a guard that rejects direct
`npm pack`; it does not compile or stage publication output. Construction never
publishes directly and refuses to overwrite a prior package artifact. The
constructed `dist/bin/agentera.js` is a regular executable file with mode
`0755`; package verification rejects a missing or non-executable bin. Published
`dist/` omits source maps so package bytes do not disclose or depend on the
checkout or isolated construction path.

## Preparation, qualification, and publication

Publication is repository orchestration, not an Agentera CLI command. The
machine-readable authority is
[`references/adapters/package-publication.json`](../../references/adapters/package-publication.json).
It defines the development and stable adapters, component inputs, state table,
benchmark, and failure labels. This guide explains how maintainers use it.

Normal development publication starts from the single serialized local
`feat/v3` branch. Fast-forward it from `origin/feat/v3`, integrate the worktree
branch, and commit that source. From the resulting clean source commit, run:

```bash
pnpm cli:prepare:dev-push -- --json
# Review, then commit only packages/cli/package.json.
# Push feat/v3 once when authorized.
```

This local command is the only development-version allocator. It increments
`3.0.0-dev.N` exactly once and sets `agentera.gitRef` to the clean source
commit. The final metadata commit must be non-merge and change no other path.
On push, `.github/workflows/qualify-candidate.yml` compares the committed
version with the previous remote head, proves the push is a fast-forward,
qualifies the exact candidate, issues a machine candidate-bound development
approval, and publishes it to npm `@next`. One non-cancelling concurrency group
protects the active run. The local integrator waits for it to finish before the
next push, so every committed integer is processed in order. CI never allocates
or edits a version and does not use `github.run_number`. A rerun reuses the same
committed version and candidate.

The resumable readiness coordinator remains the manual diagnostic and recovery
path. It accepts an explicit external candidate directory, target version, and
source commit. On the contracted GitHub Actions source runner, a fresh run
executes the source evidence DAG once, writes the source receipt, and exits 0
with `outcome: "paused"`. A workstation can run performance diagnostics, but
cannot issue new source authority. A valid downloaded source receipt is reused
without running an owner.

```bash
pnpm cli:ready:dev -- \
  --candidate-dir /secure/external/candidate \
  --target-version 3.0.0-dev.N --source-commit SOURCE_COMMIT --json
# outcome: paused; state: awaiting_metadata_review

pnpm cli:prepare:dev -- \
  --candidate-dir /secure/external/candidate \
  --target-version 3.0.0-dev.N --source-commit SOURCE_COMMIT
# Review and commit packages/cli/package.json separately.

pnpm cli:ready:dev -- \
  --candidate-dir /secure/external/candidate \
  --target-version 3.0.0-dev.N --source-commit SOURCE_COMMIT \
  --metadata-commit METADATA_COMMIT --json
# outcome: ready; state: ready_for_approval

pnpm cli:prepare:dev -- \
  --candidate-dir /secure/external/candidate \
  --target-version 3.0.0-dev.N --source-commit SOURCE_COMMIT --check
```

The readiness coordinator never prepares metadata, commits, approves, rebuilds
a valid candidate, stages publication bytes, loads registry credentials, or
reads or mutates registry state. The metadata review is a hard pause. Resume
requires the same explicit inputs plus a clean current `HEAD` equal to
`--metadata-commit`. It validates the existing source receipt, then constructs
the candidate once or validates and reuses the exact existing candidate receipt
and retained bytes. Stale or mismatched evidence exits 1 before an issuance
owner starts. The candidate directory can be absent or empty for a fresh source
run; after that it is retained input and must not be replaced.

Preparation remains pure. The serialized integration command owns the local
`N+1` calculation and changes only `packages/cli/package.json#version` and
`agentera.gitRef`. The manual readiness preparer accepts an explicit target; a
stale, skipped, malformed, or out-of-policy target and missing or invalid source
evidence fail before effects. Neither path reads the registry or loads `.env`
credentials. Stable shim preparation retains its separate source-provenance
check and does not use the development receipt. `cli:qualify:source` and
`cli:qualify:dev` remain the exact low-level receipt owners.

Source qualification runs one evidence DAG. Batch A starts generated-overlap,
stress, and typecheck together with separate HOME, cache, npm configs, and
report outputs. Generated-overlap is the only checkout
generated-output writer. It invokes the exact public source, package, and build
commands once and returns their inventory, pending-test, build, generation, and
continuous-reader evidence. Source, package, and build are not spawned again.
After every batch owner passes and overlap settles one lease-free generation,
performance runs alone with one worker in fresh isolated state on the pinned
remote runner declared by the policy, and records the runner identity. Local
performance runs are diagnostic, not authoritative qualification evidence. This
ordered barrier provides resource isolation for machine-sensitive timing
evidence; separate HOME and npm state provide output isolation but cannot
prevent CPU contention. Performance receives the same absolute source deadline.
After it passes, capacity runs alone with one worker for large deterministic
scale evidence. After capacity passes, compact, capability-contract, and the
source-only activation conjunction run together as reader barrier B. All three
use the newly built CLI from that exact lease-free generation.

Before it returns, generated-overlap gives the source and package owners separate
isolated evidence directories under its report root. The source owner atomically
writes one schema-versioned, content-addressed file and loads each instruction
module independently from a source-only compilation. That source receipt also
owns the 190 source/package command rows, their classifications and diagnostics,
the pre-child rejection proof, missing-surface failures, and complete extracted
capability behavior. The package owner writes two content-addressed receipts with
separate bounds: package-owner evidence is at most 262,144 bytes, and the
independently retained package-identity receipt is at most 16,384 bytes. Package
evidence records construction, exact artifact layout and bytes, portability, and
one extracted `status` smoke. The identity receipt binds that evidence digest to
independently recomputed tarball SHA-512 integrity, SHA-1, SHA-256,
artifact-observation digest, and complete extracted-tree and tarball-tree
identities. Missing, stale, duplicate, unknown, malformed, wrongly attributed,
or cross-receipt evidence fails before combination.

Package finalization reads the tarball once through a bounded regular-file
descriptor. Hashing and extraction consume those same retained bytes; extraction
does not reopen the mutable construction path. The package parent also retains a
private snapshot containing those bytes, their clean extraction, and a bounded
schema marker. The snapshot permits at most a 64 MiB tarball, 128 MiB of extracted
regular-file content, 4,096 entries, and 512 characters per relative path. It
rejects symlinks, non-regular files, unexpected root entries, schema drift, and
tree or byte-count drift.

Generated-overlap then executes the selected generation's capability and
bootstrap paths. Immediately before combination it validates the parent-owned
snapshot against the package-identity receipt and installs it at the fixed private
`.activation-package-snapshot` child of that generation. Neither an environment
value nor `activation-evidence.json` can select another snapshot root. It then
writes `activation-evidence.json` into that generation. The combined manifest
binds its generation UUID, current source digest, extracted package integrity,
immutable tuple digest, the three producer digests, and 42 identity checks with
exact producer and artifact provenance. Observation digests hash only canonical
normalized observations; check IDs are not digest salt.
Source modules and runtime registry, generated modules, served CLI and schemas,
and extracted modules, registry, served CLI and schemas must contain the same 12
non-empty capability bodies and identities. Package semantic fields and source,
generated, and extracted bootstrap classifications must also agree. Generated
overlap returns the package identity and fixed snapshot descriptor separately
from the combined manifest. The release parent forwards only the retained identity
to Barrier B; the activation conjunction derives the snapshot from the already
authoritative generation root, rechecks realpath containment and all bounds,
rehashes the retained tarball, extracts those same bytes through stdin, and
recomputes the complete retained extracted tree. Post-finalization mutation,
deletion, or addition therefore fails with the package owner and correction even
when attacker-controlled activation evidence is fully re-signed. The parent
removes this unpublished private snapshot only after Barrier B settles. The
manifest never creates surface identity; the code-owned tuple catalog remains the
identity, owner, selector, semantic, and correction authority.

The coordinator passes generated-overlap the actual remaining absolute source
deadline. Overlap stops starting work 10,000 ms before the 420,000 ms envelope,
cancels and settles its owned process groups, and removes its generated surfaces
on failure. It must return at least 4,000 ms before the envelope so the parent can
reconcile and stop cancellable peers. The parent may request this cooperative
stop with `SIGTERM`; it never force-kills the overlap owner during publication.
The parent starts reader barrier B only when at least 6,000 ms of concurrent
child execution plus the 4,000 ms reconciliation reserve remain. The 420,000 ms
source envelope retains headroom over the observed 373,281 ms dirty-tree,
offline, cold-isolation run that passed all eleven gates.

The content-addressed `source-receipt.json` contains all eleven named gates with
their execution origin, `outcome: "passed"`, observations, finite durations, and
executed/reused state. Validation requires the exact gate order, governed origin
and phase, successful outcome, execution shape, and gate-relevant observations;
digest or semantic tampering fails closed. The receipt
also binds the normalized source tree (package version and gitRef excluded),
verification policy, lockfile, exact toolchain, and gate set. A committed
version/gitRef-only change can reuse matching evidence; any other input change
fails closed. On the first owner failure, the coordinator cancels cancellable
process groups, lets generated-overlap settle without forced termination,
blocks every later phase, reports every completed/cancelled failure while
retaining the first observed label, and issues no receipt. The
source-plus-candidate deadline remains a guard, not performance evidence.

Development preparation performs the same read-only source check before it
changes metadata. Maintainers can also run the check directly without running
gates or writing repository or candidate state:

```bash
node packages/cli/scripts/release-qualification.mjs source-check \
  --candidate-dir /secure/external/candidate --json
```

The check recomputes the full current staged and working tracked-tree identity
with the same normalization as qualification: only
`packages/cli/package.json#version`
and `agentera.gitRef` are excluded. Any other package field, source, contract,
policy, lockfile, gate, toolchain, digest, or receipt-semantic change fails.
Success emits `executed: "none"` and `reused: true` without receipt content or
private paths.

The local staged-verification lane does not consume release receipts or run
release qualification. `source-check` remains available for direct read-only
diagnosis and as the development-preparation prerequisite. Missing, stale,
malformed, or tampered evidence fails before metadata effects.

For the manual recovery path, readiness returning `ready` still requires a
separate explicit approval against the same external directory:

```bash
pnpm cli:approve:dev -- --candidate-dir /secure/external/candidate --approved-by NAME
```

Candidate qualification validates that source receipt, runs release-metadata,
compares dry-pack and retained-artifact observations, writes one mode-`0444`
tarball, and runs that exact tarball in a new empty npm home, cache, user config,
source receipt, metadata and source commits, adapter, target version, registry
and tag, exact bytes, integrity, construction observation, and smoke result.
The candidate directory must be outside the checkout. It is retained input, not
cleanup residue: later stages fail if the receipt, path containment, bytes,
integrity, permissions, or approval differ.

Candidate receipts measure release metadata, construction/equivalence, and
exact-artifact smoke as ordered, non-overlapping monotonic intervals. The
construction interval ends before smoke starts. Gate durations plus explicit
unattributed coordinator overhead exactly reconcile to candidate elapsed time;
smoke time is never counted again as construction time.

For the stable shim, `agentera.gitRef` must identify a commit with the same
`bin/`, `lib/`, `README.md`, and `LICENSE` inputs as the candidate. Its
`package.json` may differ only in `version` and `agentera.gitRef`, which are
the explicit preparation fields. An existing but unrelated historical SHA
fails provenance validation.

An approval is an immutable `approval.json` bound to that candidate digest,
package, version, integrity, registry, and public tag. Local receipts are
deterministic cache records only. CI mutation also requires the transferred
artifact and receipts plus a CI attestation from the source-qualification run.
After those checks pass, the `feat/v3` push workflow issues the development
approval automatically. Stable publication from `main` retains explicit
protected-environment review. A push never substitutes for candidate binding.
OIDC provenance remains deferred.

The CI attestation binds `jgabor/agentera`, the `Qualify release candidate`
workflow, `.github/workflows/qualify-candidate.yml@refs/heads/feat/v3`, and
the numeric source run ID. The full `refs/heads/...` contract is the branch
authority. For an automatic development push, the downstream publication job
downloads the immutable candidate from that same run, revalidates its receipt
and attestation, records the machine approval, and only then exposes
`NPM_TOKEN` to the bounded mutation child. It has no review environment.

The separately dispatched publication workflow remains the protected manual
path. It queries the qualification run before artifact download, validates the
candidate against the API-backed `head_sha`, and revalidates it inside the
`npm-publish` environment before credentials are available. Stable publication
from `main` uses this protected review. The local qualified-publication command
is emergency recovery only, after the same candidate-bound approval and
retained artifact are established:

```bash
NPM_TOKEN=... pnpm cli:publish:qualified:dev -- \
  --candidate-dir /secure/external/candidate \
  --receipt-file /secure/external/qualified-publication-receipt.json --json
```

The qualified-publication coordinator consumes the retained bytes; it does not
run `npm pack`, rebuild source, or run source qualification.

The coordinator measures one ordered stage, independent exact-version L2, and
promote envelope with a monotonic clock. Staging first inspects npm without
credentials. An absent version uploads the approved tarball once to
`candidate-<version>`, waits for exact integrity, and runs an isolated registry
smoke only when the public tag is older or absent. If the exact version is
absent while `next` or `latest` already names that target, staging treats the
state as a conflict before candidate-tag inspection or credentials: publishing
would make the public tag effective before exact-version qualification. Staging
does not move `next` or `latest`. The development L2 runs the pinned
exact-version consumer harness while the public tag is unchanged; the stable
adapter repeats its isolated exact-version consumer smoke. Promotion verifies
the staged exact version, moves the expected tag forward, waits for integrity
and tag convergence, and observes the final exact version. Exact matching
staged or promoted state replays without upload or backward tag movement. A
failure or timeout stops later phases and never rolls back; retry the same
coordinator with the same exact candidate.

Only the npm mutation child receives `NPM_TOKEN`, through a mode-`0600`
temporary config. Tool-version probes, pack, registry inspection, receipt
validation, and both smoke paths sanitize npm and pnpm variables and use new
HOME, cache, and user/global configuration. Transaction phase output remains
bounded. The coordinator emits one human or JSON timing receipt bound to the
candidate digest, metadata commit, package, version, artifact hash and
integrity, and source run ID. It reports measured stage/L2/promote components,
total and unattributed time, reconciliation, replay state, and whether the
total is strictly below 120,000 ms. It ignores child or caller elapsed claims.
The first failure retains its original phase label. Diagnostics and receipts
omit credentials and private absolute paths.

Run the non-mutating qualification benchmark from an external directory:

```bash
mkdir /secure/external/qualification-benchmark
pnpm cli:benchmark:qualification -- --adapter development \
  --candidate-root /secure/external/qualification-benchmark --json
```

This benchmark is measurement only. The normal development release checklist
does not require a benchmark receipt or a three-run benchmark. The repository
workflow `.github/workflows/qualification-benchmark.yml` is manual only: it has
`workflow_dispatch`, no `schedule`, checks out `feat/v3`, runs the same command,
and uploads the timing JSON. Do not describe it as scheduled until default
branch workflow registration is explicitly authorized.

The qualification command runs exactly three cold-cache repetitions, retains
one candidate per run, reports preflight, every source/candidate owner,
execution/reuse, owner phases and durations, reconciled staged DAG wall time,
and medians. It emits the first original
failing owner before it stops. It never receives credentials or mutates npm.
The separate qualified-publication command above measures the actual approved
registry sequence once and enforces a total below two minutes in human and JSON
output. The contract limits preflight to under 30 seconds and measured
source-plus-candidate qualification to under five minutes. Do not use a timeout
or a different cache/network state as performance evidence.

The observed pre-change workflow timings and failure classifications are in
`docs/packaging/v3-release-workflow-baseline.json`. That file is evidence only;
it is not a budget, candidate receipt, approval, or publication authority.

## Generated-output and verification ownership

`references/analysis/verification-policy.yaml` is the executable authority for
test inventory ownership and policy composition. The five test owners are
independent:

| Owner | Entry point | Owns |
| ----- | ----------- | ---- |
| Source | `pnpm -C packages/cli test` (`test:source`) | Deterministic correctness, including the complete 190-row source/package bootstrap matrix, semantic command parity, response-cap behavior, and every other source-assigned test. Its transient TypeScript subprocess output lives in an operating-system temporary directory. Source never writes checkout generated output, but may compare a settled bundled schema when the generated bundle is already present. |
| Stress | `pnpm -C packages/cli run test:stress` | Repeated probabilistic stress evidence assigned by the policy inventory. |
| Performance | `pnpm -C packages/cli run test:performance` | Machine-sensitive budget evidence, including its required structured evidence producer, one-worker execution, pinned remote runner policy, captured runner identity, and integration check. |
| Capacity | `pnpm -C packages/cli run test:capacity` | Large deterministic scale evidence that is too resource-heavy for source correctness or performance timing. |
| Package | `pnpm -C packages/cli run verify:package` | Distribution-only checks against two independently constructed package roots and one extracted regular tree: safe construction, deterministic package bytes, exact layout and integrity, source-map absence, executable mode, inventory, path independence, and one extracted smoke. |

Build is a separate generated-output participant, not a test owner.
`pnpm -C packages/cli build` publishes one immutable checkout generation
containing matching `dist/` and `bundle/`, followed by one atomic `current`
symlink replacement.

`packages/cli/test/packaging/packageSetup.ts` is the canonical package fixture.
It builds in two distinct metacharacter-bearing roots, packs each construction
once with lifecycle scripts disabled, rejects any byte or manifest difference,
scans the extracted tree for both absolute roots, and extracts once. Source integration
uses the same fixture for command parity, with a private package copy for tests
that exercise fail-closed mutations. `packageVerification.test.ts` consumes the
canonical fixture for distribution assertions and one extracted smoke.
`copyBundleSafety.test.ts` consumes it for focused staging preflight and
filesystem-side-effect failures. A failing lane labels its own boundary and
does not invoke the other lane.

The sole package wall-time authority is
`owners.package.execution.wall_time_budget_ms` in the verification policy. Its
adjacent `budget_basis` records the complete derivation. Task 1 measured three
serial pre-change runs at 611.675, 386.578, and 307.207 seconds under heavy
contention. On the same 16-thread Ryzen 7 9800X3D host with Node 22.23.2, pnpm
10.30.3, existing dependencies and caches, and no intentionally concurrent
verification, the final two-construction fixture took 12.376, 11.666, and
11.047 seconds in three serial end-to-end runs. Its measured owner times were
11.415, 10.789, and 10.202 seconds. Earlier single-construction calibration is
retained in the policy but is explicitly superseded as final-snapshot evidence:
the 10,000 ms candidate rejected a passing 10.429-second owner, while the
15,000 ms candidate passed owner runs of 9.859, 8.962, and 13.069 seconds. The
policy takes the smaller of the baseline minimum and 125 percent of the current
12.376-second maximum rounded up to the next five seconds. This yields the
governed 20,000 ms limit.
The controlled shell timings include command-launch overhead, so they
conservatively bound the owner process measured by `verify-lane.mjs`. An invalid
limit fails before test execution. A successful test process that exceeds the
limit fails with the package correction command.

The canonical policy compositions are:

| Policy | Owners, in order |
| ------ | ---------------- |
| `targeted` | Source |
| `precommit` | Source |
| `fast` | Source |
| `local` | Source |
| `merge` | Source, package |
| `scheduled` | Source, stress, performance, capacity |
| `release` | Source, stress, performance, capacity, package |

Pre-commit delegates composition to `verify-lane.mjs`. Ordinary source paths
run deterministic source-owned files plus typecheck within a 60-second total
budget and use at most two Vitest workers. State and documentation-only changes
run only their relevant compact, schema, lint, or format checks within a
10-second budget. Conservative authority and verification surfaces route to `ci_owned`; the hook runs source-owned route guards and does not execute a
local release lane. Specialized test files retain their exact owner in the
route result. Routine CI invokes the check-only `release` conjunction once on
pull requests and `main` pushes. On direct `feat/v3` pushes, the qualification
workflow owns that same DAG and routine CI skips its duplicate CLI job.
Generated
overlap is therefore the sole execution origin for source, package, and build;
the same DAG retains source-owned Py-TS parity, typecheck, compact, stress,
performance, and capacity evidence without standalone duplicate steps. Release
gates add metadata and dry-run publication checks while using the same package
construction path rather than adding another extracted-package matrix.

For check-only diagnosis, run the complete non-publishing release conjunction
from the repository root:

```bash
pnpm -C packages/cli run verify:release
pnpm -C packages/cli run typecheck
pnpm -C packages/cli build
node packages/cli/dist/bin/agentera.js check compact
node packages/cli/dist/bin/agentera.js check validate \
  capability-contract --format json
node packages/cli/dist/bin/agentera.js check validate \
  release-metadata --format json
pnpm -C packages/cli run pack:dry-run
```

This diagnostic conjunction is not a step before or after `cli:ready:dev` in a
normal candidate-readiness run. Doing both would repeat owners that the
coordinator already executes once.

`verify:release` runs that same eleven-gate source-qualification DAG against the
current source tree, including dirty or staged work, in check-only mode. It
emits one bounded result and creates no source receipt, candidate, registry
request, activation, or publication action. Receipt qualification retains its
clean committed-tree and explicit external candidate-directory requirements.

`pnpm -C packages/cli run verify:generated-overlap` starts the exact public
source, build, and package commands from absent checkout output. Each participant
has isolated npm state and report output. The coordinator releases their
global-setup barrier once all are ready, compares exact source and package
inventories and pending assertions with structured Vitest results, and
continuously pins and validates selected generations until every participant
exits. Its JSON evidence records commands, durations, owner inventories, build
status, selected generation, and reader identity/surface results; it does not
turn scheduler-dependent observation counts into durable evidence.

## Checkout generation protocol

`packages/cli/scripts/generated-output.mjs` is the executable authority. A
generation is complete only when its root, `dist/`, and `bundle/` carry the
same identity. `current` must be a symlink to a regular direct child of
`.agentera-generated/generations/`; canonical-path checks reject external
targets, prefix collisions, generation symlinks, missing surfaces, and identity
mismatches. Validation recursively `lstat`s and canonicalizes every `dist/` and
`bundle/` entry, accepting only regular directories and singly linked regular
files. Nested absolute, relative, directory, broken, and path-prefix symlinks,
special files, and multiply linked files are rejected. Package construction
applies the same rule before `npm pack`; npm metadata outside these surfaces
remains unaffected. The cost is linear in generated entries and reads metadata,
not file contents. The stable checkout launcher pins that validated generation
for its process lifetime before importing the CLI. It never resolves `dist` and
`bundle` separately.

Publication validates in staging, renames the complete generation into the
generations root, creates a temporary pointer, and atomically renames that
pointer to `current`. A short publisher lease protects the pre-selection
window. One short-lived, crash-recoverable mutation mutex serializes cleanup,
publication, retention, and compatibility-launcher installation; compilation
still occurs outside it. There is no publication journal.

Reader, publisher, staging, and mutation ownership records pair PID with process
birth identity: `/proc/<pid>/stat` start ticks on Linux,
`LC_ALL=C LANG=C TZ=UTC0 ps -o lstart` normalized to an UTC ISO timestamp on
macOS, and PowerShell `StartTime` ticks on Windows. PID reuse therefore becomes
stale ownership rather than a false live reader. Legacy, malformed,
permission-denied, unsupported, or otherwise unavailable process-start evidence
is `unknown`: cleanup or contended mutation fails with the preserved path
instead of deleting state or claiming bounded success.
Cleanup retains at most two complete generations unless additional generations
have live leases. A reader lease is a hard link to the generation guard;
cleanup atomically renames that guard before deletion, so lease acquisition
either wins first or retries without any live generation path disappearing. A
live lease restores an interrupted guard claim. A
later build or explicit cleanup removes stale leases and released generations,
so crashed readers do not create permanent growth on Linux, macOS, or Windows
when their declared process-start mechanism is available. The precise invariant
is two ordinary complete generations plus generations protected by currently
live leases; unknown leases are preserved and make cleanup fail visibly.

## Recovery and cleanup

Build runs recovery before staging and bounded retention after publication.
Recovery is idempotent and never follows or mutates an escaped target.

| State | Recovery |
| ----- | -------- |
| Missing `current` | Valid before the first build; the next successful build selects one complete generation. |
| Directory, regular file, broken link, escaped link, or otherwise invalid `current` | Atomically renamed to one `.preserved-current-*` path before replacement. Inspect that preserved path before deleting it. |
| `.current-*` temporary pointer | A well-formed stale symlink is removed; malformed or non-symlink state is preserved and reported with bounded paths. |
| `.staging-*` | Removed only when its owner is absent or its recorded process identity no longer matches. Live state is retained; malformed or uncertain ownership fails with a correction. |
| `.agentera-generation.guard.retiring-*` cleanup claim | Restored when the generation is current or a matching live lease exists; otherwise its unselected generation is removed. Conflicting guard state is preserved and reported. |
| `.mutation-lock` | Concurrent callers wait for an atomically-created owner record. Live ownership times out actionably; dead, PID-reused, and unknown canonical ownership is preserved and fails closed rather than using a non-atomic pathname claim. Inspect and remove only confirmed stale residue, then rerun `pnpm -C packages/cli run generated:cleanup -- --force`. |
| `.mutation-lock.reclaim-*` | Every interrupted reclaim claim is reclassified from its retained owner record. Proven-dead or PID-reused claims are removed, a lone live claim is restored to `.mutation-lock`, and matching duplicate records are collapsed. Malformed, permission-denied, unsupported, or conflicting canonical/claim ownership is preserved with bounded corrective paths. Retries converge without ignoring claim residue. |
| Legacy publication lock | Active or uncertain ownership is retained. A dead owner or an ownerless lock older than 30 seconds is reclaimed. |
| Legacy journal or backup residue | Never interpreted or deleted automatically. The build reports at most three paths and asks the contributor to inspect or remove confirmed residue. |

Preview and apply self-service retention headlessly:

```bash
pnpm -C packages/cli run generated:cleanup -- --dry-run --json
pnpm -C packages/cli run generated:cleanup -- --force --json
```

Cleanup requires either `--dry-run` or `--force`; retries are safe. To inspect
the publication tarball surface, use
`pnpm -C packages/cli run pack:dry-run`. Add `-- --json` or `-- --verbose` when
the complete file manifest is needed. Direct checkout `npm pack` remains
rejected because compatibility launchers and generations are not package
inputs.

## Ownership inventory

- Detailed runtime behavior and failure coverage stays under source-owned test
  areas such as `test/cli/`, `test/state/`, and `test/upgrade/`.
- `test/integration/runtimeBootstrapMatrix.test.ts` owns the complete 190-row
  source/package bootstrap matrix, classifications, protected-root proof, and
  pre-child rejection evidence.
- `test/integration/sourcePackageParity.test.ts` owns extracted command and
  failure semantics that must remain equal to the source runtime.
- `test/packaging/packageVerification.test.ts` owns distribution observations
  and one extracted smoke. It intentionally avoids command/failure matrices.
- `test/packaging/copyBundleSafety.test.ts` owns focused bundle-staging
  containment, collision, registry-shape, and fail-before-side-effect coverage.
- `test/verification/laneOwnership.test.ts` locks the lane configs, scripts,
  independent failure labels, and matrix ownership.
