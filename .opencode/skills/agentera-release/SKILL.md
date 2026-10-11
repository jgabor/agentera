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
  staging tags, verification, approval, registry state, replay, recovery, and
  the credential boundary.
- `docs/packaging/v3-packaging.md` owns the complete maintainer workflow.
- `.opencode/skills/agentera-verification/SKILL.md` owns verification lanes,
  generated output, package construction, and pre-commit behavior.

Keep `.agentera/docs.yaml` and `references/adapters/package-registry.yaml`
synchronized. Do not add ad hoc version surfaces, version checks, or direct
`npm pack` or `npm publish` commands.

## Version boundary

Until `3.0.0` has landed on npm `@latest`, do not bump suite or release
metadata beyond `3.0.0`. Keep changelog entries under `[Unreleased]` and
publish development builds only to `@next`.

The development npm package and suite metadata have distinct versions:

- `packages/cli/package.json#version` is the publishable `X.Y.Z-dev.N`. CI uses
  only its `X.Y.Z` base line.
- `agentera.suiteVersion`, skill frontmatter, and `registry.json` use the
  release version `X.Y.Z`.
- `agentera.gitRef` names the immutable source commit selected for the release.

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

For an explicitly authorized manual publication, inject the token from the
established local credential source into the exact publication command. The
coordinator sanitizes inherited npm configuration and requires `NPM_TOKEN` only
when an upload is necessary. A `.env` or `.npmrc` is a credential source, not
approval; the immutable artifact-bound approval is registry mutation authority.

## Development publication

Every passing queued push whose full ref matches the checked-in
`references/adapters/package-publication.json#ci.developmentPush.ref`
publishes one development package to `@next` through
`.github/workflows/publish.yml`. Routing reads that authority from default
`main`, and `main` is always excluded.

CI allocates `3.0.0-dev.(GITHUB_RUN_NUMBER + 89)`: runs 1, 2, and 3 map to
`3.0.0-dev.90`, `3.0.0-dev.91`, and `3.0.0-dev.92`. It builds once from
`GITHUB_SHA`. Only copied manifest `version` and `agentera.gitRef` change, in an
isolated construction tree; the checkout is never edited. CI validates the
tarball metadata, smokes its CLI, and publishes those exact bytes.

- Ordinary pushes need no pre-push development version bump or metadata-only
  release commit.
- The package-global `publish-agentera` concurrency group uses `queue: max`,
  which keeps up to 100 pending runs.
- A rerun reuses the same run number, `GITHUB_SHA`, and candidate version.
  Matching already-published bytes are a successful replay.
- Failed runs can leave gaps. All pushes allocate run numbers before routing,
  so `main` and other unselected pushes leave gaps too. Later runs cannot move
  `@next` backward.
- Development preparation rejects `--target-version`; stable preparation
  continues to require explicit `--target-version`.

A user's explicit push authorization is single-use and is consumed by one
`git push`. Local commits do not publish. After that push, stop. A failed or
cancelled workflow ends that release attempt and does not authorize another
version or push. Fix the cause on a worktree branch and obtain fresh explicit
authorization before the next integration push.

To change the development ref, change `ci.developmentPush.ref` through a
reviewed commit on default `main`. Land that authority and `publish.yml` on
`main` first, then make sure the selected branch contains `publish.yml` before
its first publishing push. Routing fails closed during an incomplete landing;
do not add a runtime fallback.

### Trusted Publishing boundary

Routine development publication uses npm Trusted Publishing with GitHub OIDC.
The build job has no OIDC. The entire checkout-free, action-free publication
job has OIDC capability and runs only fixed reviewed workflow logic. Only its
fixed `npm publish` child receives the OIDC request variables;
`package-publication.json#invariants.credentials` describes the full boundary.
Consequences for recovery:

- Exact and superseded replay need no upload and no OIDC.
- `forward-retag` fails closed because OIDC does not authorize `npm dist-tag`.
  Use interactive npm 2FA or a later forward version.
- npm has no atomic compare-and-publish operation, so an external registry race
  remains possible. An `npm publish` conflict fails closed.
- Manual development recovery and stable publication remain token-bearing.

## Manual development recovery

The resumable readiness coordinator is a manual diagnostic and recovery path,
separate from push publication. It uses the committed manifest version and an
explicit source commit. The only permitted manual bump is
`packages/cli/package.json#version` from `3.0.0-dev.N` to `3.0.0-dev.N+1`.

Current limit: CI allocates `@next` versions from run numbers, so the committed
manifest version stays below `@next`, and the publisher never moves a tag
backward. This path therefore cannot currently publish to `@next`. Recover a
failed development release with a workflow rerun or a later forward push; each
needs fresh explicit authorization because it can publish. TODO `dpqmygjyme`
tracks the policy decision.

A fresh coordinator run can issue source authority only on the contracted
GitHub Actions runner; a workstation can run performance diagnostics but cannot
issue a source receipt. The coordinator pauses for separate metadata
preparation, review, and commit. Resume with the same inputs plus the reviewed
metadata commit:

```bash
vp run cli:ready:dev -- \
  --candidate-dir /secure/external/agentera-package \
  --source-commit SOURCE_COMMIT --json
# Update, review, and commit packages/cli/package.json separately.
vp run cli:prepare:dev -- \
  --candidate-dir /secure/external/agentera-package \
  --source-commit SOURCE_COMMIT
vp run cli:ready:dev -- \
  --candidate-dir /secure/external/agentera-package \
  --source-commit SOURCE_COMMIT \
  --metadata-commit METADATA_COMMIT --json
vp run cli:approve:dev -- \
  --candidate-dir /secure/external/agentera-package --approved-by NAME
vp run cli:benchmark:qualification -- \
  --adapter development \
  --candidate-root /secure/external/agentera-verification-benchmark --json
NPM_TOKEN=... vp run cli:publish:qualified:dev -- \
  --candidate-dir /secure/external/agentera-package \
  --receipt-file /secure/external/qualified-publication-receipt.json --json
```

Preparation, verification, approval, and publication are separate operations.
Do not infer or mutate their inputs outside the owning commands. The readiness
coordinator never prepares metadata, commits, approves, rebuilds a valid package
artifact, stages bytes, or mutates registry state. `paused` and `ready` exit 0;
invalid or stale evidence returns `rejected` and exits 1.

Development preparation runs the read-only source-evidence check before changing
version or `gitRef`. Run the same check directly without rerunning gates:

```bash
vp node packages/cli/scripts/release-qualification.mjs source-check \
  --candidate-dir /secure/external/agentera-package --json
```

Package verification reuses the external readiness directory, runs
release-metadata validation, retains one immutable tarball, and smokes it from a
cold state before any registry action. Manual mutation requires a separate
approval bound to the package artifact receipt, package, version, integrity,
registry, and expected tag. Manual CI mutation also requires the transferred
artifact and CI attestation.

The publication coordinator never rebuilds or re-verifies source. It stages the
retained artifact, runs the staged package migration smoke test, and promotes
the expected tag forward. Matching version, integrity, and tag state replays
without upload. A conflicting integrity, escaped artifact, stale tag, or
unrecognized registry state fails before mutation. On failure, correct the
reported cause and rerun with the same artifact. Never reconstruct it, move a
tag backward, or attempt rollback.

## Release qualification

`vp run verify` runs `verify:release`: the twelve-gate evidence DAG in
`package-publication.json#qualification.source.dag`. It includes generated
overlap, typecheck, build, source, package, stress, performance, capacity,
compact, capability-contract, activation-conjunction, and historical
certification.
`references/analysis/verification-policy.yaml` owns its composition; the
verification skill describes the lanes. Performance evidence counts only from
the policy-pinned remote runner. New source authority binds to the contracted
workflow identity and the committed checkout SHA.

Do not run `vp run verify` before or after `cli:ready:dev` in a readiness run;
the coordinator already runs those owners once. On failure, correct the first
reported owner and rerun the same command. Do not run omitted owners
separately, force-kill generated overlap, construct a package, or infer a
receipt.

`check validate release-metadata` checks the committed `agentera.gitRef`
against the package source tree. It belongs to manual and stable metadata
commits, where package verification runs it. On an ordinary checkout, CI never
updates `gitRef`, so this check fails by design.

## Stable shim

Stable publication is not operational yet. It needs protected stable jobs in
`.github/workflows/publish.yml` on default `main`: a build job without OIDC and
a dependent publication job, the only stable job with `id-token: write`, in the
`npm-publish` environment. Do not run stable publication until those jobs land.

The stable shim publishes `packages/cli/shim` to `@latest`. The intended
commands are:

```bash
vp run cli:prepare:stable -- \
  --target-version X.Y.Z --source-commit COMMIT
# Review and commit packages/cli/shim/package.json.
NPM_TOKEN=... vp run cli:publish:qualified:stable -- \
  --candidate-dir /secure/external/agentera-package \
  --receipt-file /secure/external/qualified-publication-receipt.json --json
```

## Changelog and commit boundary

Load `.opencode/skills/agentera-state/SKILL.md` before committing release
metadata; it owns changelog and commit rules. Release cuts and npm registry
alignment are the only cases that may land without paired product code. Promote
`[Unreleased]` entries only when the release contract calls for it.
