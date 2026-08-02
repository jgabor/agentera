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
publishes directly and refuses to overwrite a prior package artifact.

## Preparation, qualification, and publication

Publication is repository orchestration, not an Agentera CLI command. The
machine-readable authority is
[`references/adapters/package-publication.json`](../../references/adapters/package-publication.json).
It defines the development and stable adapters, component inputs, state table,
benchmark, and failure labels. This guide explains how maintainers use it.

Preparation is pure. It does not read npm or create a package. Supply both the
next allowed target version and the immutable source commit:

```bash
pnpm cli:prepare:dev -- --target-version 3.0.0-dev.N --source-commit COMMIT
pnpm cli:prepare:dev -- --target-version 3.0.0-dev.N --source-commit COMMIT --check
```

Only `packages/cli/package.json#version` and `agentera.gitRef` can change. The
same target is a no-op. A stale, skipped, malformed, or out-of-policy target
fails before effects. Review and commit the diff; preparation never infers a
version, reads the registry, or loads `.env` credentials.

Source qualification runs one evidence DAG. Batch A starts generated-overlap,
stress, performance, and typecheck together with separate HOME, cache, npm
configs, and report outputs. Generated-overlap is the only checkout
generated-output writer. It invokes the exact public source, package, and build
commands once and returns their inventory, pending-test, build, generation, and
continuous-reader evidence. Source, package, and build are not spawned again.
After every batch owner passes and overlap settles one lease-free generation,
compact and capability-contract run together as reader barrier B.

The content-addressed `source-receipt.json` contains all nine named gates with
their execution origin, observations, durations, and executed/reused state. It
also binds the normalized source tree (package version and gitRef excluded),
verification policy, lockfile, exact toolchain, and gate set. A committed
version/gitRef-only change can reuse matching evidence; any other input change
fails closed. On the first owner failure, the coordinator cancels cancellable
process groups, lets generated-overlap settle without forced termination,
blocks barrier B, reports every completed/cancelled failure while retaining the
first observed label, and issues no receipt. The source-plus-candidate deadline
remains a guard, not performance evidence.

```bash
pnpm cli:qualify:source -- --candidate-dir /secure/external/candidate
pnpm cli:qualify:dev -- --candidate-dir /secure/external/candidate
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

For the stable shim, `agentera.gitRef` must identify a commit with the same
`bin/`, `lib/`, `README.md`, and `LICENSE` inputs as the candidate. Its
`package.json` may differ only in `version` and `agentera.gitRef`, which are
the explicit preparation fields. An existing but unrelated historical SHA
fails provenance validation.

An approval is an immutable `approval.json` bound to that candidate digest,
package, version, integrity, registry, and public tag. A branch push is not an
approval. Local receipts are deterministic cache records only. CI mutation also
requires the transferred artifact and receipts, a CI attestation from the
source-qualification run, and the explicit candidate-bound approval. OIDC
provenance remains deferred.

The CI attestation binds `jgabor/agentera`, the `Qualify release candidate`
workflow, `.github/workflows/qualify-candidate.yml@refs/heads/feat/v3`, and
the numeric source run ID. The full `refs/heads/...` contract is the branch
authority. Before artifact download, the publication workflow queries that run
and compares its repository, head repository, run ID, workflow name/path,
event, conclusion, and `head_branch`. It then loads the candidate receipt and
requires `metadataCommit` to equal the API-backed `head_sha`. These checks run
in a predecessor job before the separate `npm-publish` environment approval.
The approved job downloads the same immutable run artifact again; approval and
each registry phase revalidate the same candidate and CI attestation.

The qualified-publication coordinator consumes the retained bytes; it does not
run `npm pack`, rebuild source, or run source qualification:

```bash
NPM_TOKEN=... pnpm cli:publish:qualified:dev -- \
  --candidate-dir /secure/external/candidate \
  --receipt-file /secure/external/qualified-publication-receipt.json --json
```

The coordinator measures one ordered stage, independent exact-version L2, and
promote envelope with a monotonic clock. Staging first inspects npm without
credentials. An absent version uploads the approved tarball once to
`candidate-<version>`, waits for exact integrity, and runs an isolated registry
smoke. It does not move `next` or `latest`. The development L2 runs the pinned
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

The qualification command runs exactly three cold-cache repetitions, retains
one candidate per run, reports preflight, every source/candidate owner,
execution/reuse, concurrent owner-duration totals, reconciled DAG wall time,
and medians. It emits the first original
failing owner before it stops. It never receives credentials or mutates npm.
The separate qualified-publication command above measures the actual approved
registry sequence once and enforces a total below two minutes in human and JSON
output. The contract limits preflight to under 30 seconds and measured
source-plus-candidate qualification to under five minutes. Do not use a timeout
or a different cache/network state as performance evidence.

## Generated-output and verification ownership

`references/analysis/verification-policy.yaml` is the executable authority for
test inventory ownership and policy composition. The four test owners are
independent:

| Owner | Entry point | Owns |
| ----- | ----------- | ---- |
| Source | `pnpm -C packages/cli test` (`test:source`) | Every source-assigned test. Its transient TypeScript subprocess output lives in an operating-system temporary directory. Source never writes checkout generated output, but may compare a settled bundled schema when the generated bundle is already present. |
| Stress | `pnpm -C packages/cli run test:stress` | Repeated probabilistic stress evidence assigned by the policy inventory. |
| Performance | `pnpm -C packages/cli run test:performance` | Machine-sensitive budget evidence, including its required structured evidence producer and integration check. |
| Package | `pnpm -C packages/cli run verify:package` | Every package-assigned test against one genuinely packed, extracted, production-installed regular tree constructed independently of checkout output. |

Build is a separate generated-output participant, not a test owner.
`pnpm -C packages/cli build` publishes one immutable checkout generation
containing matching `dist/` and `bundle/`, followed by one atomic `current`
symlink replacement.

`packages/cli/test/packaging/packageSetup.ts` is the canonical package fixture.
It builds once, packs with lifecycle scripts disabled to prevent a second
build, extracts once, and installs once. `packageVerification.test.ts` consumes
the fixture for complete manifest classification and isolated installed-package
conjunctions. `copyBundleSafety.test.ts` consumes it for focused staging
preflight and filesystem-side-effect failures. A failing lane labels its own
boundary and does not invoke the other lane.

The canonical policy compositions are:

| Policy | Owners, in order |
| ------ | ---------------- |
| `targeted` | Source |
| `precommit` | Source |
| `fast` | Source |
| `local` | Source |
| `merge` | Source, package |
| `scheduled` | Source, stress, performance |
| `release` | Source, stress, performance, package |

Pre-commit delegates composition to `verify-lane.mjs`. Ordinary source paths
run targeted source files or the `local`/`precommit` source composition.
Conservative authority and verification surfaces route to `release`, so all
four owners run before those changes can commit. CI explicitly runs source and
package, generated-output overlap, typecheck, build, and repository gates.
Release gates add the stress and performance owners plus metadata and dry-run
publication checks, while using the same package construction path rather than
adding another extracted-package matrix.

Run the complete non-publishing release-readiness conjunction from the
repository root:

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

`verify:release` runs the source, stress, performance, and package owners in
policy order. These commands construct and inspect packages locally; they do
not publish, change a dist-tag, create a Git tag, or update a remote branch.

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
- `test/packaging/packageVerification.test.ts` owns distribution observations
  and intentionally avoids command/failure matrices.
- `test/packaging/copyBundleSafety.test.ts` owns focused bundle-staging
  containment, collision, registry-shape, and fail-before-side-effect coverage.
- `test/verification/laneOwnership.test.ts` locks the lane configs, scripts,
  independent failure labels, and matrix ownership.
