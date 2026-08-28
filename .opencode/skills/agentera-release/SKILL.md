---
name: agentera-release
description: >-
  Prepare, verify, approve, publish, replay, or recover Agentera npm releases.
  Use for version bumps, release metadata, npm credentials, package artifacts,
  dist-tags, publication receipts, and stable or development channels.
---

# Agentera release workflow

Load this skill before changing a version-bearing file or taking any npm
release action. Publication, tagging, and pushing require explicit user
authorization. Credentials and a branch push are never publication authority.

## Authorities

- `.agentera/docs.yaml` owns versioning policy and `version_files`.
- `references/adapters/package-registry.yaml` owns synchronized package
  surfaces.
- `references/adapters/package-publication.json` owns package adapters,
  staging tags, verification, approval, registry state, replay, and recovery.
- `docs/packaging/v3-packaging.md` owns the complete maintainer workflow.
- `.opencode/skills/agentera-verification/SKILL.md` owns verification lanes,
  generated output, package construction, and pre-commit behavior.

Do not replace these authorities with ad hoc version checks, direct `npm pack`,
or direct `npm publish` commands.

## Current release boundary

Until `3.0.0` has landed on npm `@latest`, do not bump suite or release
metadata beyond `3.0.0`. The only permitted manual recovery development bump is
`packages/cli/package.json#version` from `3.0.0-dev.N` to
`3.0.0-dev.N+1`. Keep suite-bearing surfaces at `3.0.0`, retain changelog
entries under `[Unreleased]`, and publish development builds only to `@next`.

The development npm package and suite metadata have distinct versions:

- `packages/cli/package.json#version` is the publishable `X.Y.Z-dev.N`.
- `agentera.suiteVersion`, skill frontmatter, and `registry.json` use the
  release version `X.Y.Z`.
- `agentera.gitRef` names the immutable source commit selected for the release.

Do not add ad hoc version surfaces. Keep `.agentera/docs.yaml` and
`references/adapters/package-registry.yaml` synchronized.

## Credential preflight

Credential availability is separate from registry mutation authorization.
Before reporting that npm credentials are unavailable:

1. Run `npm whoami`.
2. Check whether inherited `NPM_TOKEN` exists without printing its value.
3. Run `npm config get userconfig` and check that config for an auth entry
   without printing its value.
4. Run `git worktree list --porcelain` to resolve the primary worktree.
5. Check the primary worktree's ignored `.env` and `.npmrc` files for token
   presence without printing, copying, or committing a value.

Linked worktrees do not contain ignored credential files by default. An absent
inherited `NPM_TOKEN` does not prove that no credential is available.

The publication coordinator sanitizes inherited npm configuration and requires
`NPM_TOKEN` in its environment only when an upload is necessary. For an
explicitly authorized publication, inject the token from the established local
credential source into the exact publication command. A `.env` or
`.npmrc` is a credential source, not approval. The immutable artifact-bound
approval remains registry mutation authority. Matching registry state can
replay without a token.

## Development publication

CI development preparation copies the checked-in package version and changes
only `agentera.gitRef` in the isolated construction manifest. The manual
readiness preparer reads that checked-in version and requires a source commit
and external artifact directory containing a current normalized source receipt.
Both paths are pure and registry-independent. Stable preparation retains its
separate source-provenance behavior without the development receipt.

Every passing queued push to `feat/v3` publishes the checked-in
`packages/cli/package.json#version` to `@next`. CI builds once from `GITHUB_SHA`
and sets package `agentera.gitRef` to that SHA without editing the checkout. It
validates the isolated tarball metadata, runs its executable CLI version smoke,
and publishes those exact bytes to `@next`. `queue: max` keeps up to 100 pending
runs. A rerun reuses the same pushed SHA and checked-in version; matching
already-published bytes are a successful replay. A failed run does not allocate
a replacement version.

A user's explicit push authorization is single-use and is consumed by one
`git push`. Local commits do not publish. After that push, stop. A failed or
cancelled workflow ends that release attempt and does not authorize another
version or push. Make corrections on a worktree branch and
obtain fresh explicit authorization before a later integration push. Rerunning
an existing workflow reuses the same pushed SHA and checked-in version.

The resumable readiness coordinator remains the manual diagnostic and recovery
path, separate from normal push publication. Its fresh run can issue source
authority only on the contracted GitHub
Actions runner. It pauses for separate metadata preparation, review, and commit.
Resume requires the same explicit inputs plus the reviewed metadata commit. It
then constructs the package artifact once or reuses the exact valid receipt and
artifact. A workstation can run performance diagnostics, but cannot issue a new
source receipt.

```bash
pnpm cli:ready:dev -- \
  --candidate-dir /secure/external/agentera-package \
  --source-commit SOURCE_COMMIT --json
# Update, review, and commit packages/cli/package.json separately.
pnpm cli:prepare:dev -- \
  --candidate-dir /secure/external/agentera-package \
  --source-commit SOURCE_COMMIT
pnpm cli:ready:dev -- \
  --candidate-dir /secure/external/agentera-package \
  --source-commit SOURCE_COMMIT \
  --metadata-commit METADATA_COMMIT --json
pnpm cli:approve:dev -- \
  --candidate-dir /secure/external/agentera-package --approved-by NAME
pnpm cli:benchmark:qualification -- \
  --adapter development \
  --candidate-root /secure/external/agentera-verification-benchmark --json
NPM_TOKEN=... pnpm cli:publish:qualified:dev -- \
  --candidate-dir /secure/external/agentera-package \
  --receipt-file /secure/external/qualified-publication-receipt.json --json
```

Preparation, verification, approval, and publication are separate operations.
Do not infer or mutate their inputs outside the owning commands. Normal push
publication reads the checked-in package version and changes only
`agentera.gitRef` in the isolated construction manifest. Manual recovery
preparation uses the committed development version and explicit source commit.
Development preparation rejects `--target-version`; stable preparation
continues to require explicit `--target-version`.
The readiness coordinator never prepares metadata, commits, approves, rebuilds
a valid package artifact, stages bytes, or mutates registry state. `paused` and `ready`
exit 0; invalid or stale evidence returns `rejected` and exits 1.

## Verification contract

Source verification runs the contract-owned evidence DAG. Generated overlap
is the sole source, package, and build execution origin beside isolated stress
and typecheck owners. Performance runs alone with one worker on the pinned
remote runner after that batch settles, and records runner identity. Capacity
then runs serially before compact and capability-contract validation consume the
lease-free generation. New source authority is bound to the contracted workflow
identity and committed checkout SHA.

On failure, correct the first reported owner and rerun the same source command.
Do not run omitted owners separately, force-kill overlap, construct a package,
or infer a receipt.

Development preparation runs the read-only source-evidence check before changing
version or `gitRef`. The same check can be invoked directly without rerunning
gates:

```bash
node packages/cli/scripts/release-qualification.mjs source-check \
  --candidate-dir /secure/external/agentera-package --json
```

Package verification reuses the retained external readiness directory. It
retains one immutable tarball and runs a cold-state local smoke before registry
action.
Manual mutation requires a separate approval bound to the package artifact receipt,
package, version, integrity, registry, and expected tag. Stable CI also requires
the transferred artifact and CI attestation. The routine `feat/v3` push workflow
is separate and publishes its locally validated exact tarball directly. Stable
publication from `main` retains protected-environment review.

The publication coordinator never rebuilds or re-verifies source. It stages the
retained package artifact, runs the independent staged package migration smoke
test, and promotes the expected tag forward. Matching exact version, integrity,
and tag state replays without upload. A conflicting integrity, escaped artifact,
stale tag, or unrecognized registry state fails before mutation.

On failure, correct the reported cause and rerun the same exact package artifact.
Never reconstruct it, move a tag backward, or attempt rollback.

## Stable shim

Stable verification and publication are not operational until
`.github/workflows/publish-stable.yml` exists on the default `main` branch. Its
`workflow_dispatch` trigger is a v3 `@latest` cutover prerequisite, not a path
available from the current `feat/v3`-only checkout. One run prepares and attests
the exact candidate, then the `npm-publish` environment gates the dependent
publication job.

The stable shim uses the same package flow and remains on `@latest`:

```bash
pnpm cli:prepare:stable -- \
  --target-version X.Y.Z --source-commit COMMIT
# Review and commit packages/cli/shim/package.json.
NPM_TOKEN=... pnpm cli:publish:qualified:stable -- \
  --candidate-dir /secure/external/agentera-package \
  --receipt-file /secure/external/qualified-publication-receipt.json --json
```

## Check-only release gates

Run from the repository root:

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

`verify:release` is the canonical source, stress, performance, capacity, and
package verification. Do not bypass a failing gate or substitute direct package
commands. This diagnostic verification is not a step before or after
`cli:ready:dev` in a normal package-readiness run because that would repeat
owners that the coordinator already executes once.

## Changelog and commit boundary

Load `.opencode/skills/agentera-state/SKILL.md` before committing release
metadata. Release cuts and npm registry alignment are the only narrow cases
that may land without paired product code. Promote `[Unreleased]` entries only
when the release contract calls for it. Do not add internal verification,
receipt, state-entity, or agent bookkeeping to the changelog.
