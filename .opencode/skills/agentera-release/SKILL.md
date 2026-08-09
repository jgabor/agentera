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

Preparation requires an explicit next version and source commit. It is pure,
registry-independent, and changes only package version and `agentera.gitRef`.
The same target is a no-op; stale, skipped, malformed, and out-of-policy targets
fail before effects.

```bash
pnpm cli:prepare:dev -- \
  --target-version 3.0.0-dev.N --source-commit COMMIT
# Review and commit packages/cli/package.json.
pnpm cli:qualify:source -- --candidate-dir /secure/external/candidate
pnpm cli:qualify:dev -- --candidate-dir /secure/external/candidate
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
Never infer a version, source commit, candidate directory, approval, or receipt.

## Qualification contract

Source qualification runs the contract-owned evidence DAG. Generated overlap
is the sole source, package, and build execution origin beside isolated stress
and typecheck owners. Performance runs alone after that batch settles. Compact
and capability-contract validation consume the lease-free generation.

On failure, correct the first reported owner and rerun the same source command.
Do not run omitted owners separately, force-kill overlap, construct a candidate,
or infer a receipt.

For a version and `gitRef`-only preparation, source evidence can be checked
without rerunning gates:

```bash
node packages/cli/scripts/release-qualification.mjs source-check \
  --candidate-dir /secure/external/candidate --json
```

Set `AGENTERA_PRECOMMIT_SOURCE_CANDIDATE_DIR` only to that external candidate
when pre-commit should attempt source evidence reuse. A valid check skips only
the source or release test policy. Build, compact, parity, candidate
qualification, release metadata, approval, and publication remain mandatory.

Candidate qualification requires a new external directory. It retains one
immutable tarball and runs a cold-state local smoke before registry action.
Every mutation requires a separate approval bound to candidate receipt,
package, version, integrity, registry, and expected tag. CI also requires the
transferred artifact and CI attestation.

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

## Release gates

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

`verify:release` is the canonical source, stress, performance, and package
conjunction. Do not bypass a failing gate or substitute direct package commands.

## Changelog and commit boundary

Load `.opencode/skills/agentera-state/SKILL.md` before committing release
metadata. Release cuts and npm registry alignment are the only narrow cases
that may land without paired product code. Promote `[Unreleased]` entries only
when the release contract calls for it. Do not add internal qualification,
receipt, state-entity, or agent bookkeeping to the changelog.
