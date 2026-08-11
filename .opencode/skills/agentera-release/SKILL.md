---
name: agentera-release
description: >-
  Prepare, qualify, approve, publish, replay, or recover Agentera npm releases.
  Use for version bumps, release metadata, npm credentials, candidates,
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
  candidate tags, qualification, approval, registry state, replay, and
  recovery.
- `docs/packaging/v3-packaging.md` owns the complete maintainer workflow.
- `.opencode/skills/agentera-verification/SKILL.md` owns verification lanes,
  generated output, package construction, and pre-commit behavior.

Do not replace these authorities with ad hoc version checks, direct `npm pack`,
or direct `npm publish` commands.

## Current release boundary

Until `3.0.0` has landed on npm `@latest`, do not bump suite or release
metadata beyond `3.0.0`. The only permitted development bump is
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
credential source into the exact qualified-publication command. A `.env` or
`.npmrc` is a credential source, not approval. The immutable candidate-bound
approval remains registry mutation authority. Matching registry state can
replay without a token.

## Development publication

Serialized integration preparation requires a clean committed source tree and
changes only package version and `agentera.gitRef`. The manual readiness
preparer requires an explicit next version, source commit, and external
candidate directory containing a current normalized source receipt. Both paths
are pure and registry-independent. Stable preparation retains its separate
source-provenance behavior without the development receipt.

The normal development path has one version authority: serialized local
integration on `feat/v3`. Fast-forward local `feat/v3` from its remote, integrate
the worktree branch, then add one final metadata-only commit. That commit must
increment `packages/cli/package.json#version` exactly once and set
`agentera.gitRef` to its first parent. Push once. The workflow validates this
shape against the previous remote head, qualifies the exact committed candidate,
issues a machine candidate-bound development approval, and publishes it to
`@next`. It never allocates a version and never uses `github.run_number`. A rerun
reuses the same committed version and candidate. Wait for that workflow to
finish before the next `feat/v3` integration push.

```bash
pnpm cli:prepare:dev-push -- --json
# Commit only packages/cli/package.json as the final local feat/v3 commit.
```

The resumable readiness coordinator remains the manual diagnostic and recovery
path. Its fresh run can issue source authority only on the contracted GitHub
Actions runner. It pauses for separate metadata preparation, review, and commit.
Resume requires the same explicit inputs plus the reviewed metadata commit. It
then constructs the candidate once or reuses the exact valid candidate receipt
and bytes. A workstation can run performance diagnostics, but cannot issue a new
source receipt.

```bash
pnpm cli:ready:dev -- \
  --candidate-dir /secure/external/candidate \
  --target-version 3.0.0-dev.N --source-commit SOURCE_COMMIT --json
pnpm cli:prepare:dev -- \
  --candidate-dir /secure/external/candidate \
  --target-version 3.0.0-dev.N --source-commit SOURCE_COMMIT
# Review and commit packages/cli/package.json.
pnpm cli:ready:dev -- \
  --candidate-dir /secure/external/candidate \
  --target-version 3.0.0-dev.N --source-commit SOURCE_COMMIT \
  --metadata-commit METADATA_COMMIT --json
pnpm cli:approve:dev -- \
  --candidate-dir /secure/external/candidate --approved-by NAME
pnpm cli:benchmark:qualification -- \
  --adapter development \
  --candidate-root /secure/external/qualification-benchmark --json
NPM_TOKEN=... pnpm cli:publish:qualified:dev -- \
  --candidate-dir /secure/external/candidate \
  --receipt-file /secure/external/qualified-publication-receipt.json --json
```

Preparation, qualification, approval, and publication are separate operations.
Do not infer or mutate their inputs outside the owning commands. The local
integration preparer owns the `N+1` mutation; the push validator derives that
same expected value only to compare it with the committed metadata.
The readiness coordinator never prepares metadata, commits, approves, rebuilds
a valid candidate, stages bytes, or mutates registry state. `paused` and `ready`
exit 0; invalid or stale evidence returns `rejected` and exits 1.

## Qualification contract

Source qualification runs the contract-owned evidence DAG. Generated overlap
is the sole source, package, and build execution origin beside isolated stress
and typecheck owners. Performance runs alone with one worker on the pinned
remote runner after that batch settles, and records runner identity. Capacity
then runs serially before compact and capability-contract validation consume the
lease-free generation. New source authority is bound to the contracted workflow
identity and committed checkout SHA.

On failure, correct the first reported owner and rerun the same source command.
Do not run omitted owners separately, force-kill overlap, construct a candidate,
or infer a receipt.

Development preparation runs the read-only source-evidence check before changing
version or `gitRef`. The same check can be invoked directly without rerunning
gates:

```bash
node packages/cli/scripts/release-qualification.mjs source-check \
  --candidate-dir /secure/external/candidate --json
```

Candidate qualification reuses the retained external readiness directory. It
retains one immutable tarball and runs a cold-state local smoke before registry
action.
Every mutation requires a separate approval bound to candidate receipt,
package, version, integrity, registry, and expected tag. CI also requires the
transferred artifact and CI attestation. The `feat/v3` push workflow may issue
the development approval automatically after all bound checks pass. Stable
publication from `main` retains protected-environment review.

The publication coordinator never rebuilds or requalifies source. It stages the
retained bytes, runs the independent exact-version L2 check, and promotes the
expected tag forward. Matching exact version, integrity, and tag state replays
without upload. A conflicting integrity, escaped artifact, stale tag, or
unrecognized registry state fails before mutation.

On failure, correct the reported cause and rerun the same exact candidate.
Never reconstruct it, move a tag backward, or attempt rollback.

## Stable shim

The stable shim uses the same candidate flow and remains on `@latest`:

```bash
pnpm cli:prepare:stable -- \
  --target-version X.Y.Z --source-commit COMMIT
# Review and commit packages/cli/shim/package.json.
NPM_TOKEN=... pnpm cli:publish:qualified:stable -- \
  --candidate-dir /secure/external/candidate \
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
package conjunction. Do not bypass a failing gate or substitute direct package
commands. This diagnostic conjunction is not a step before or after
`cli:ready:dev` in a normal candidate-readiness run because that would repeat
owners that the coordinator already executes once.

## Changelog and commit boundary

Load `.opencode/skills/agentera-state/SKILL.md` before committing release
metadata. Release cuts and npm registry alignment are the only narrow cases
that may land without paired product code. Promote `[Unreleased]` entries only
when the release contract calls for it. Do not add internal qualification,
receipt, state-entity, or agent bookkeeping to the changelog.
