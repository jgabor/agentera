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

## Preparation, verification, and publication

Publication is repository orchestration, not an Agentera CLI command. The
machine-readable authority is
[`references/adapters/package-publication.json`](../../references/adapters/package-publication.json).
It defines the development and stable adapters, component inputs, state table,
benchmark, and failure labels. This guide explains how maintainers use it.

Every passing queued push to `feat/v3` publishes through
`.github/workflows/publish-next.yml` to npm `@next`. CI reads the checked-in
`packages/cli/package.json#version`, builds once from `GITHUB_SHA`, and sets
`agentera.gitRef` to `GITHUB_SHA` only in the copied construction manifest. It
validates that exact tarball's version and git ref, runs its executable CLI
version smoke, then publishes the same tarball to `@next`. This routine path does
not run the manual qualification, receipt, attestation, benchmark, or artifact
handoff framework. It does not edit the checkout or require a final metadata-only
commit. The `publish-next-${{ github.ref }}` group uses
`queue: max`, which keeps up to 100 pending pushes.
A rerun keeps the same pushed SHA and checked-in version. If identical bytes
already exist at that version on `@next`, publication succeeds without another
upload. A failed run does not allocate a replacement version.

Before each later `feat/v3` push, choose a development version newer than the
current npm `@next`, update only `packages/cli/package.json#version`, and commit
that change with the source that it identifies. Do not push an unpublished
version again after changing its source. Instead, commit a new development
version and obtain fresh push authorization. Rerun the existing workflow when
the version and source are unchanged, because that is an exact replay. If npm
already contains different bytes at the checked-in version, treat it as a
conflict: do not overwrite or retag it; commit a new development version and
obtain fresh push authorization.

One explicit push authorization permits exactly one push and is consumed by it.
After that push, stop. A failed or cancelled workflow ends the release attempt;
it does not authorize another version or push. Make fixes on a
worktree branch, then obtain fresh authorization for a later integration push.
Local commits do not publish. Rerunning an existing workflow reuses the same
pushed SHA and checked-in version.

The resumable readiness coordinator remains the manual diagnostic and recovery
path. It is separate from normal push publication and accepts an explicit
external artifact directory and source commit. It reads the development package
version from `packages/cli/package.json#version`. On the contracted GitHub
Actions source runner, a fresh run
executes the source evidence DAG once, writes the source receipt, and exits 0
with `outcome: "paused"`. A workstation can run performance diagnostics, but
cannot issue new source authority. A valid downloaded source receipt is reused
without running an owner.

```bash
pnpm cli:ready:dev -- \
  --candidate-dir /secure/external/agentera-package \
  --source-commit SOURCE_COMMIT --json
# outcome: paused; state: awaiting_metadata_review

# Update, review, and commit packages/cli/package.json separately.
pnpm cli:prepare:dev -- \
  --candidate-dir /secure/external/agentera-package \
  --source-commit SOURCE_COMMIT

pnpm cli:ready:dev -- \
  --candidate-dir /secure/external/agentera-package \
  --source-commit SOURCE_COMMIT \
  --metadata-commit METADATA_COMMIT --json
# outcome: ready; state: ready_for_approval

pnpm cli:prepare:dev -- \
  --candidate-dir /secure/external/agentera-package \
  --source-commit SOURCE_COMMIT --check
```

The readiness coordinator never prepares metadata, commits, approves, rebuilds
a valid package artifact, stages publication bytes, loads registry credentials, or
reads or mutates registry state. The metadata review is a hard pause. Resume
requires the same explicit inputs plus a clean current `HEAD` equal to
`--metadata-commit`. It validates the existing source receipt, then constructs
the package artifact once or validates and reuses the exact existing receipt and
retained artifact. Stale or mismatched evidence exits 1 before an issuance owner
starts. The external artifact directory can be absent or empty for a fresh
source run; after that it is retained input and must not be replaced.

Preparation remains pure. Normal push publication copies the checked-in package
version into the isolated CI construction tree, injects only `agentera.gitRef`,
and does not prepare checkout metadata. The manual recovery preparer validates
the checked-in development version, explicit source commit, and source evidence
without changing checkout metadata. Development preparation rejects
`--target-version`; stable preparation continues to require explicit
`--target-version`. Neither path reads the registry or loads `.env` credentials.
Stable shim preparation retains its separate source-provenance check and does
not use the development receipt. `cli:qualify:source` and `cli:qualify:dev`
remain the exact low-level receipt owners.

The stable publication workflow is a cutover prerequisite, not a currently
operational dispatch path. GitHub does not expose its `workflow_dispatch`
trigger until `.github/workflows/publish-stable.yml` exists on the default
`main` branch. Land and review that workflow on `main` before the v3 `@latest`
cutover.

Source verification runs one evidence DAG. Batch A starts generated-overlap,
stress, and typecheck together with separate HOME, cache, npm configs, and
report outputs. Generated-overlap invokes the exact public source, package, and
build commands once. The build writes only its private immutable root and returns
the owner inventories, pending-test results, and build evidence. Source, package,
and build are not spawned again.
The GitHub source verification step gives the long-running source participant two
workers, gives hosted Vitest assertions a 120-second ceiling, and limits the
concurrently starting package and stress participants to one worker each. Local
assertions retain the 30-second default. This bounds initial contention without
starving the source owner that determines the generated-overlap wall time.
After every batch owner passes and overlap validates one immutable private build,
performance runs alone with one worker in fresh isolated state on the pinned
remote runner declared by the policy, and records the runner identity. Local
performance runs are diagnostic, not authoritative package verification evidence. This
ordered barrier provides resource isolation for machine-sensitive timing
evidence; separate HOME and npm state provide output isolation but cannot
prevent CPU contention. Performance receives the same absolute source deadline.
After it passes, capacity runs alone with one worker for large deterministic
scale evidence. After capacity passes, compact, capability-contract, and the
source-only activation conjunction run together as reader barrier B. All three
use the newly built CLI from that exact private build. Generated-overlap
computes one Git commit, Git tree, and exact working-tree digest before
releasing participants. Build and both package constructions embed that
identity in `dist/` and `bundle/`; barrier reads reject a private build whose
source identity differs.

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
descriptor. Hashing and extraction consume that retained package artifact; extraction
does not reopen the mutable construction path. The package parent also retains a
private snapshot containing those bytes, their clean extraction, and a bounded
schema marker. The snapshot permits at most a 64 MiB tarball, 128 MiB of extracted
regular-file content, 4,096 entries, and 512 characters per relative path. It
rejects symlinks, non-regular files, unexpected root entries, schema drift, and
tree or byte-count drift.

Generated-overlap then executes the private build's capability and
bootstrap paths. Immediately before combination it validates the parent-owned
snapshot against the package-identity receipt and installs it at the fixed private
`.activation-package-snapshot` child of that build root. Neither an environment
value nor `activation-evidence.json` can select another snapshot root. It then
writes `activation-evidence.json` into that build root. The combined manifest
binds its source-identity SHA-256, current source digest, extracted package integrity,
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
authoritative private build root, rechecks realpath containment and all bounds,
rehashes the retained tarball, extracts those same bytes through stdin, and
recomputes the complete retained extracted tree. Post-finalization mutation,
deletion, or addition therefore fails with the package owner and correction even
when attacker-controlled activation evidence is fully re-signed. The parent
removes this unpublished private snapshot only after Barrier B settles. The
manifest never creates surface identity; the code-owned tuple catalog remains the
identity, owner, selector, semantic, and correction authority.

The coordinator passes generated-overlap the actual remaining absolute source
deadline. Overlap stops starting work 10,000 ms before the 2,400,000 ms envelope,
cancels and settles its owned process groups, and removes its generated surfaces
on failure. It must return at least 4,000 ms before the envelope so the parent can
reconcile and stop cancellable peers. The parent may request this cooperative
stop with `SIGTERM`; it never force-kills the overlap owner during publication.
The parent starts reader barrier B only when at least 6,000 ms of concurrent
child execution plus the 4,000 ms reconciliation reserve remain. The 2,400,000 ms
source envelope retains headroom over the observed 1,676,355 ms hosted failure
with two 120-second fixture ceilings and the 516,590 ms local eleven-gate pass.

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
The source and package verification deadline remains a guard, not performance evidence.

Development preparation performs the same read-only source check before it
changes metadata. Maintainers can also run the check directly without running
gates or writing repository or artifact state:

```bash
node packages/cli/scripts/release-qualification.mjs source-check \
  --candidate-dir /secure/external/agentera-package --json
```

The check recomputes the full current staged and working tracked-tree identity
with the same normalization as source verification: only
`packages/cli/package.json#version`
and `agentera.gitRef` are excluded. Any other package field, source, contract,
policy, lockfile, gate, toolchain, digest, or receipt-semantic change fails.
Success emits `executed: "none"` and `reused: true` without receipt content or
private paths.

The local staged verification lane does not consume release receipts or run
release verification. `source-check` remains available for direct read-only
diagnosis and as the development-preparation prerequisite. Missing, stale,
malformed, or tampered evidence fails before metadata effects.

### Manual development recovery and stable publication

For the manual recovery path, readiness returning `ready` still requires a
separate explicit approval against the same external directory:

```bash
pnpm cli:approve:dev -- --candidate-dir /secure/external/agentera-package --approved-by NAME
```

Package verification validates that source receipt, runs release-metadata,
compares dry-pack and retained artifact observations, writes one mode-`0444`
tarball, and runs that exact tarball in a new empty npm home, cache, user config,
source receipt, metadata and source commits, adapter, package version, registry
and tag, exact bytes, integrity, construction observation, and smoke result.
The external artifact directory must be outside the checkout. It is retained input, not
cleanup residue: later stages fail if the receipt, path containment, bytes,
integrity, permissions, or approval differ.

Package artifact receipts measure release metadata, construction/equivalence, and
exact-artifact smoke as ordered, non-overlapping monotonic intervals. The
construction interval ends before smoke starts. Gate durations plus explicit
unattributed coordinator overhead exactly reconcile to package verification time;
smoke time is never counted again as construction time.

For the stable shim, `agentera.gitRef` must identify a commit with the same
`bin/`, `lib/`, `README.md`, and `LICENSE` inputs as the package artifact. Its
`package.json` may differ only in `version` and `agentera.gitRef`, which are
the explicit preparation fields. An existing but unrelated historical SHA
fails provenance validation.

In the manual development and stable paths, approval is an immutable
`approval.json` bound to that package artifact digest, package, version,
integrity, registry, and public tag. Local receipts are deterministic cache
records only. Manual CI mutation also requires the transferred package artifact
and receipts plus a CI attestation from the source verification run. Stable
publication from `main` retains explicit protected-environment review. OIDC
provenance remains deferred.

The manual CI attestation binds `jgabor/agentera`, the
`Publish development package (@next)` workflow,
`.github/workflows/publish-next.yml@refs/heads/feat/v3`, and
the numeric source run ID. The full `refs/heads/...` contract is the branch
authority. This attestation and approval flow is not part of routine `feat/v3`
push publication.

After `.github/workflows/publish-stable.yml` lands on default `main`, its manual
dispatch prepares, attests, and uploads one immutable candidate. The dependent
publication job downloads the candidate from the same workflow run and waits
for `npm-publish` environment approval. It revalidates the receipt, artifact,
and same-run CI attestation before registry credentials are used. Stable
publication from `main` uses this protected review. The local publication
command is emergency recovery only, after the same artifact-bound approval and
retained package artifact are established:

```bash
NPM_TOKEN=... pnpm cli:publish:qualified:dev -- \
  --candidate-dir /secure/external/agentera-package \
  --receipt-file /secure/external/qualified-publication-receipt.json --json
```

The manual publication coordinator consumes the retained package artifact; it
does not run `npm pack`, rebuild source, or run source verification.

The coordinator measures one ordered stage, independent staged package migration smoke test, and
promote envelope with a monotonic clock. Staging first inspects npm without
credentials. An absent version uploads the approved tarball once to
the staging tag for `<version>`, waits for exact integrity, and runs an isolated registry
smoke only when the public tag is older or absent. If the exact version is
absent while `next` or `latest` already names that target, staging treats the
state as a conflict before staging-tag inspection or credentials: publishing
would make the public tag effective before the staged package migration smoke test. Staging
does not move `next` or `latest`. The development npm package runs the pinned
exact-version consumer harness while the public tag is unchanged. It retries
only npm's transient `ETARGET` missing-version response at five-second
intervals, at most ten attempts and within the existing publication deadline.
The stable adapter repeats its isolated npm package consumer smoke.
Promotion verifies
the staged exact version, moves the expected tag forward, waits for integrity
and tag convergence, and observes the final exact version. Exact matching
staged or promoted state replays without upload or backward tag movement. A
failure or timeout stops later phases and never rolls back; retry the same
coordinator with the same exact package artifact.

Only the npm mutation child receives `NPM_TOKEN`, through a mode-`0600`
temporary config. Tool-version probes, pack, registry inspection, receipt
validation, and both smoke paths sanitize npm and pnpm variables and use new
HOME, cache, and user/global configuration. Transaction phase output remains
bounded. The coordinator emits one human or JSON timing receipt bound to the
package artifact digest, metadata commit, package, version, artifact hash and
integrity, and source run ID. It reports measured stage, staged package migration
smoke, and promote components,
total and unattributed time, reconciliation, replay state, and whether the
  total is strictly below 120,000 ms. It ignores child or caller elapsed claims.
The first failure retains its original phase label. Diagnostics and receipts
omit credentials and private absolute paths.

Run the non-mutating package verification benchmark from an external directory:

```bash
mkdir /secure/external/agentera-verification-benchmark
pnpm cli:benchmark:qualification -- --adapter development \
  --candidate-root /secure/external/agentera-verification-benchmark --json
```

This local benchmark is measurement only. The normal development release
checklist does not require a benchmark receipt or a three-run benchmark.

The verification command runs exactly three cold-cache repetitions, retains
one package artifact per run, reports preflight, every source/package owner,
execution/reuse, owner phases and durations, reconciled staged DAG wall time,
and medians. It emits the first original
failing owner before it stops. It never receives credentials or mutates npm.
The separate publication command above measures the actual approved
registry sequence once and enforces a total below two minutes in human and JSON
output. The contract limits preflight to under 30 seconds and measured
source-plus-package verification to under fifteen minutes. Do not use a timeout
or a different cache/network state as performance evidence.

The observed pre-change workflow timings and failure classifications are in
`docs/packaging/v3-release-workflow-baseline.json`. That file is evidence only;
it is not a budget, package artifact receipt, approval, or publication authority.

## Generated-output and verification ownership

`references/analysis/verification-policy.yaml` is the executable authority for
test inventory ownership and policy composition. The five test owners are
independent:

| Owner | Entry point | Owns |
| ----- | ----------- | ---- |
| Source | `pnpm -C packages/cli test` (`test:source`) | Deterministic correctness, including the complete 190-row source/package bootstrap matrix, detailed command and failure behavior in feature-owned tests, response-cap behavior, and every other source-assigned test. Its transient TypeScript subprocess output lives in an operating-system temporary directory. Source never writes checkout generated output, but may compare a settled bundled schema when the generated bundle is already present. |
| Stress | `pnpm -C packages/cli run test:stress` | Repeated probabilistic stress evidence assigned by the policy inventory. |
| Performance | `pnpm -C packages/cli run test:performance` | Machine-sensitive budget evidence, including its required structured evidence producer, one-worker execution, pinned remote runner policy, captured runner identity, and integration check. |
| Capacity | `pnpm -C packages/cli run test:capacity` | Large deterministic scale evidence that is too resource-heavy for source correctness or performance timing. |
| Package | `pnpm -C packages/cli run verify:package` | Distribution-only checks against two independently constructed package roots and one extracted regular tree: safe construction, deterministic package bytes, exact layout and integrity, source-map absence, executable mode, inventory, path independence, and one extracted smoke. |

Build is a separate generated-output participant, not a test owner. Routine
builds synchronize staged output into checkout `dist/` and `bundle/`; release
verification instead retains one private immutable build root.

`packages/cli/test/packaging/packageSetup.ts` is the canonical package fixture.
It builds in two distinct metacharacter-bearing roots, packs each construction
once with lifecycle scripts disabled, rejects any byte or manifest difference,
scans the extracted tree for both absolute roots, and extracts once. Source integration
does not repeat that extracted package command matrix. Feature-owned source tests
cover detailed command and failure behavior. `packageVerification.test.ts`
consumes the canonical fixture for distribution assertions and one extracted smoke.
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
11.047 seconds in three serial end-to-end runs. After the package owner was
reduced to its distribution-only inventory, three controlled runs took 5.558,
5.489, and 5.471 seconds. Their measured owner times were 4.752, 4.698, and
4.672 seconds. Earlier single-construction calibration is
retained in the policy but is explicitly superseded as final-snapshot evidence:
  the 10,000 ms limit rejected a passing 10.429-second owner, while the
  15,000 ms limit passed owner runs of 9.859, 8.962, and 13.069 seconds. The
policy combines the controlled maximum with the remote cold-run evidence. The
remote headroom governs the current 60,000 ms limit.
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
route result. Routine CI invokes the check-only `release` verification once on
pull requests and `main` pushes. Direct `feat/v3` pushes run the package verification
workflow instead of routine CI.
Generated
overlap is therefore the sole execution origin for source, package, and build;
the same DAG retains source-owned Py-TS parity, typecheck, compact, stress,
performance, and capacity evidence without standalone duplicate steps. Release
gates add metadata and dry-run publication checks while using the same package
construction path rather than adding another extracted-package matrix.

For check-only diagnosis, run the complete non-publishing release verification
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

This diagnostic verification is not a step before or after `cli:ready:dev` in a
normal package-readiness run. Doing both would repeat owners that the
coordinator already executes once.

`verify:release` runs that same eleven-gate source verification DAG against the
current source tree, including dirty or staged work, in check-only mode. It
emits one bounded result and creates no source receipt, package artifact, registry
request, activation, or publication action. Receipt verification retains its
clean committed-tree and explicit external artifact directory requirements.

`pnpm -C packages/cli run verify:generated-overlap` starts the exact public
source, package, and build owners concurrently. The build owner writes one
source-identified immutable tree under the coordinator's private temporary
root. Release readers and activation evidence use that explicit root. No
checkout generation pointer, lease, retention, or cleanup protocol participates.

## Checkout generated output

Routine `pnpm -C packages/cli build` constructs `dist/` and `bundle/` in an OS
temporary directory. It then synchronizes those trees into the checkout. The
synchronizer adds missing files, replaces files whose bytes or executable mode
changed, and removes stale files. It does not rewrite unchanged files, so an
unchanged build preserves output bytes and modification times. An interrupted
build can leave partial checkout output; rerun the build to repair it.

Matching `.agentera-build-source.json` markers in `dist/` and `bundle/` bind
isolated package and release construction to the Git commit, Git tree, file
count, and exact tracked-plus-untracked working-tree digest. Regular-tree
validation rejects links, special files, and multiply linked files. The
checkout `dist/bin/agentera.js` is the compiled regular executable, not a
generation launcher. Routine builds do not write `.agentera-generated`.

To inspect the publication tarball surface, use
`pnpm -C packages/cli run pack:dry-run`. Add `-- --json` or `-- --verbose` when
the complete file manifest is needed. Direct checkout `npm pack` remains
rejected because package construction owns the publication inputs.

## Ownership inventory

- Detailed runtime behavior and failure coverage stays under source-owned test
  areas such as `test/cli/`, `test/state/`, and `test/upgrade/`.
- `test/integration/runtimeBootstrapMatrix.test.ts` owns the complete 190-row
  source/package bootstrap matrix, classifications, protected-root proof, and
  pre-child rejection evidence.
- Feature-owned source tests under `test/cli/`, `test/state/`, `test/upgrade/`,
  and related areas own detailed command and failure behavior.
- `test/packaging/packageVerification.test.ts` contains five distribution-only
  tests, including one extracted smoke. It does not own command/failure matrices.
- `test/packaging/copyBundleSafety.test.ts` owns focused bundle-staging
  containment, collision, registry-shape, and fail-before-side-effect coverage.
- `test/verification/laneOwnership.test.ts` locks the lane configs, scripts,
  independent failure labels, and matrix ownership.
