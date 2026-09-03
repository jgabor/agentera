# AGENTS.md

This file is the always-on bootstrap for repository work. Detailed maintainer
workflows live in repo-local skills and must be loaded when their triggers
match the task.

## Product

Agentera is one bundled, self-contained npm CLI for project state, artifact
validation, and capability routing for coding agents. The published v3 entry
point is:

```bash
npx -y agentera@next
```

The twelve capabilities are:

- `status`: project orientation and routing.
- `vision`: product direction and north star.
- `discuss`: structured decisions and trade-offs.
- `research`: external source analysis.
- `plan`: executable task planning.
- `build`: one scoped development cycle.
- `optimize`: measurable improvement loops.
- `audit`: codebase health review.
- `document`: documentation maintenance.
- `profile`: reusable decision profiling.
- `design`: visual identity and design systems.
- `orchestrate`: multi-task plan execution.

## Required skills

Load every matching skill before acting. Skill descriptions are intentionally
explicit so runtime skill discovery can select them from user intent.

- For npm publication, version changes, release metadata, package artifacts,
  verification, approval, registry credentials, dist-tags, or replay, load
  `agentera-release` from
  `.opencode/skills/agentera-release/SKILL.md`.
- For capability instructions, schemas, triggers, protocol primitives,
  routing, validation, or bundled skill behavior, load
  `agentera-capability-dev` from
  `.opencode/skills/agentera-capability-dev/SKILL.md`.
- Before reading or mutating state entities, changing TODO or changelog state,
  or creating any commit, load `agentera-state` from
  `.opencode/skills/agentera-state/SKILL.md`.
- For tests, typecheck, builds, generated output, packaging, compaction,
  pre-commit hooks, runtime parity, or gate diagnosis, load
  `agentera-verification` from
  `.opencode/skills/agentera-verification/SKILL.md`.

If a runtime cannot auto-load project skills, read the matching `SKILL.md`
directly before work. Keep canonical workflow detail in skills or their named
authority documents, not in this bootstrap.

## Project layout

```text
packages/cli/
  src/
    cli/                    CLI dispatch and command implementations
    capabilities/           Canonical capability instruction modules
    registries/             Contract loaders and typed registry models
    state/                  Typed project-state readers and writers
    validate/               Artifact and contract validation
  scripts/                  Build, package, verification, publication
  test/                     Source, package, stress, and performance tests
  shim/                     Transitional stable npm package

skills/agentera/            Bundled public Agentera skill and schemas
references/                 Protocol, adapter, and verification authorities
.agentera/                  Project state and artifact mappings
.opencode/skills/           Repo-local maintainer skills
docs/packaging/             Canonical packaging and release guide
```

## State authority

Read project state through the CLI before direct artifact reads:

```bash
npx -y agentera@next prime
npx -y agentera@next state todo list
npx -y agentera@next state plan list --status open
npx -y agentera@next state query --list-artifacts
```

Progress, decisions, plans, tasks, and health records are typed writer-owned
entities. Never edit `.agentera/entities/` directly. Before mutation, load
`agentera-state` and run the matching `state <artifact> explain` command.

Never modify `.agentera/vision.yaml` outside a vision capability or an explicit
vision task. Canonical artifact names can map to YAML paths; use CLI inventory
and `.agentera/docs.yaml` mappings rather than assuming paths.

## Branch model

- `main` remains the feature-frozen v2 stable history until the v3 npm
  `@latest` cutover. Its published entry point is `npx -y agentera@latest`.
- `feat/v3` is the current v3 integration and release source branch.
- Feature branches target `feat/v3` until cutover.
- Worktree branches follow the same target; a worktree is not an alternate
  integration trunk.
- The archived `main-pre-squash-v1` branch is historical only.

### Development push contract

- Every passing queued push whose full ref matches
  `references/adapters/package-publication.json#ci.developmentPush.ref`
  publishes one rolling development package to npm `@next`. The routing job
  reads that authority from default `main` and excludes `main`.
  CI allocates `3.0.0-dev.(GITHUB_RUN_NUMBER plus 89)`
  on the valid checked-in manifest base line, builds once from `GITHUB_SHA`,
  and sets the candidate version and package `agentera.gitRef` only in isolated
  package construction. It
  validates and smokes that exact tarball before publishing the same bytes. It
  does not edit the checkout or require a final metadata commit.
- The routine development workflow uses npm Trusted Publishing with GitHub
  OIDC. The entire checkout-free, action-free publication job has OIDC
  capability and runs only fixed reviewed workflow logic. That logic strips
  OIDC and npm credentials/config from guard and convergence children; only
  the fixed forward `npm publish` child is intentionally passed the OIDC
  request variables. A fixed credential-free post-check verifies
  convergence. Replay needs no OIDC, and `forward-retag` fails closed because
  OIDC does not authorize `npm dist-tag`. An external npm race remains possible
  because the registry has no atomic compare-and-publish operation; publish
  conflicts fail closed. Stable publication remains unchanged.
- The package-global `publish-agentera` concurrency group uses `queue: max`, which
  keeps up to 100 pending pushes. A rerun keeps the same run number, candidate
  version, pushed SHA, and bytes. Failed runs leave gaps; later queued runs get
  higher versions and cannot move `@next` backward.
- A user's explicit push authorization permits exactly one push and is consumed
  by it. After that push, stop. A failed or cancelled workflow does not
  authorize another version or push. Repair the cause on a
  worktree branch and obtain fresh explicit authorization before integrating it.
- Development preparation rejects `--target-version`; stable preparation
  continues to require explicit `--target-version`.
- Ordinary pushes to the configured development ref require no pre-push
  development version bump or metadata-only release commit.
- All pushes allocate workflow run numbers before routing. Nonselected and
  `main` pushes can therefore leave permitted development version gaps.
- To change the development branch, change `ci.developmentPush.ref` through a
  reviewed commit on default `main`. Land that authority and `publish.yml` on
  `main` first, then ensure the selected branch contains `publish.yml` before
  its publishing push. There is no bootstrap fallback.
- Publication from `main` remains the future stable path in `publish.yml` and
  requires protected `npm-publish` environment review before npm mutation.
  That stable job is not implemented yet and remains governed TODO work.

Until `3.0.0` is on npm `@latest`, do not bump suite or release metadata beyond
`3.0.0`. Any version or publication task must load `agentera-release` before
editing files or checking credentials.

## Common commands

Use the Node.js 24 LTS version pinned in `.node-version` and pnpm 10.30.3
through Corepack. Run commands from the repository root unless noted.

```bash
# CLI tests
pnpm -C packages/cli test

# Package boundary
pnpm -C packages/cli run verify:package

# Typecheck and build
pnpm -C packages/cli run typecheck
pnpm -C packages/cli build

# Artifact compact gate, after build
node packages/cli/dist/bin/agentera.js check compact

# Capability contract, after build
node packages/cli/dist/bin/agentera.js check validate \
  capability-contract

# Package dry run
pnpm -C packages/cli run pack:dry-run
```

Run the narrowest relevant check first, then broaden according to impact. Load
`agentera-verification` before changing gate policy, diagnosing a failed lane,
or touching generated and packaged output.

## Always-on boundaries

- Never publish, tag, or push without explicit user authorization. The automatic
  configured development ref workflow is standing policy after an authorized
  push; it does not authorize an agent to make that push.
- Never infer missing npm credentials from inherited `NPM_TOKEN` alone. Load
  `agentera-release` and complete its credential preflight.
- Never use `.env`, `.npmrc`, a source receipt, or CI success as registry
  mutation approval. A serialized push to the configured development ref runs
  the direct development publication workflow. Stable publication always
  requires explicit protected review.
- Never use direct `npm pack` or `npm publish` for Agentera packages outside the
  repository package construction and publication helpers.
- Never push during ordinary capability execution.
- Never amend, force-push, or use destructive Git operations unless the user
  explicitly authorizes the applicable action.
- Never skip hooks as a routine shortcut. Use `LEFTHOOK=0` only when hook
  configuration is broken or a failure is already tracked for CI.
- Preserve unrelated worktree changes and stage only intended files.
- Never bypass typed state writers with direct entity edits.
- Keep shared protocol primitives in `skills/agentera/protocol.yaml`, not in
  per-capability schemas.
- Keep version and package surfaces governed by `.agentera/docs.yaml` and
  `references/adapters/package-registry.yaml`; do not add ad hoc copies.
- Do not add internal state bookkeeping, verification details, receipt paths,
  or agent activity to user-facing changelog entries.

## Runtime notes

- The published v3 package is self-contained under `packages/cli/bundle/` and
  does not require a checkout or `AGENTERA_HOME`.
- Prefer `agentera check validate`; top-level `agentera validate` is a migration
  alias.
- Use `agentera prime` for status and typed `agentera state` commands for
  artifacts. Top-level `status`, `todo`, and `docs` are not v3 commands.
- Upgrade preview is read-only. Apply is forward-only and requires explicit
  consent. The separate `--legacy-cleanup RESOURCE_ID` route also requires
  matching ownership evidence.
- User-facing CLI behavior belongs under an `agentera` namespace. Direct
  `scripts/` entry points are maintainer-only unless documented otherwise.
