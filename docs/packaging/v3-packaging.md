# v3 npm packaging and verification

This document is the canonical authority for checkout generated output, npm
package construction, verification ownership, retention, and recovery. Other
contributor guides link here rather than restating the protocol.

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
`npm pack`; it does not compile or stage publication output.

## Generated-output and verification ownership

`references/analysis/verification-policy.yaml` is the executable authority for
test inventory ownership and policy composition. The four test owners are
independent:

| Owner | Entry point | Owns |
| ----- | ----------- | ---- |
| Source | `pnpm -C packages/cli test` (`test:source`) | Every source-assigned test. Its transient TypeScript subprocess output lives in an operating-system temporary directory; source never reads checkout `dist/`, `bundle/`, or `.agentera-generated/`. |
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

`pnpm -C packages/cli run verify:generated-overlap` starts the complete source,
build, and package participants from absent checkout output, releases their
global-setup barrier once
all are ready, compares the exact source and package file inventories with
structured Vitest results, and continuously pins and validates selected
generations until every participant exits. Its JSON result records exact owner file
and test totals plus whether any actual reader observation had an identity or
surface-validation mismatch; it does not turn scheduler-dependent observation
counts into durable evidence.

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
`pnpm -C packages/cli run pack:dry-run`. Direct checkout `npm pack` remains
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
