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
npx -y agentera@next state todo list --format json
npx -y agentera@next state plan list --status open --format json
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

- Every passing queued push to `feat/v3` publishes one rolling
  development package to npm `@next`. CI derives `3.0.0-dev.N` as
  `GITHUB_RUN_NUMBER + 72` and binds package and receipt metadata to
  `GITHUB_SHA` in isolated package construction. It does not edit the checkout
  or require a final metadata commit.
- The `publish-next-${{ github.ref }}` concurrency group uses `queue: max`, which
  keeps up to 100 pending pushes. Failed runs can create version gaps. A rerun
  keeps the same run number, SHA, version, and package artifact.
- A user's explicit push authorization permits exactly one push and is consumed
  by it. After that push, stop. A failed or cancelled workflow does not
  authorize another version or push. Repair the cause on a
  worktree branch and obtain fresh explicit authorization before integrating it.
- Before the first push with `.github/workflows/qualify.yml`, confirm that this
  new workflow is still unregistered at run number 0 and npm `3.0.0-dev.73` is
  absent. The offset 72 is a one-time migration assumption, not a registry query.
- Publication from `main` remains the stable path and requires protected
  environment review before npm mutation. The stable `workflow_dispatch`
  paths are not operational until `verify-stable.yml` and `publish.yml` exist
  on the default `main` branch. Landing them there is a v3 cutover prerequisite.

Until `3.0.0` is on npm `@latest`, do not bump suite or release metadata beyond
`3.0.0`. Any version or publication task must load `agentera-release` before
editing files or checking credentials.

## Common commands

Use Node.js 22 or newer and pnpm 10.30.3 through Corepack. Run commands from the
repository root unless noted.

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
  capability-contract --format json

# Package dry run
pnpm -C packages/cli run pack:dry-run
```

Run the narrowest relevant check first, then broaden according to impact. Load
`agentera-verification` before changing gate policy, diagnosing a failed lane,
or touching generated and packaged output.

## Always-on boundaries

- Never publish, tag, or push without explicit user authorization. The automatic
  `feat/v3` workflow is standing policy after an authorized push; it does not
  authorize an agent to make that push.
- Never infer missing npm credentials from inherited `NPM_TOKEN` alone. Load
  `agentera-release` and complete its credential preflight.
- Never use `.env`, `.npmrc`, a source receipt, or CI success as registry
  mutation approval. A serialized `feat/v3` push may cause the workflow to issue
  development approval only after the verified package artifact contract passes.
  Stable publication always requires explicit protected review.
- Never use direct `npm pack` or `npm publish` for Agentera packages.
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
