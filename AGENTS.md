# AGENTS.md

This file is the always-on bootstrap for repository work. Detailed maintainer
workflows live in repo-local skills and the authority documents they name. Keep
that detail there, not here.

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

Load every matching skill before acting. If a runtime cannot auto-load project
skills, read the matching `SKILL.md` directly.

- `agentera-release` (`.opencode/skills/agentera-release/SKILL.md`): npm
  publication, version changes, release metadata, package artifacts, release
  qualification or approval, registry credentials, dist-tags, or replay.
- `agentera-capability-dev` (`.opencode/skills/agentera-capability-dev/SKILL.md`):
  capability instructions, schemas, triggers, protocol primitives, routing,
  validation, or bundled skill behavior.
- `agentera-state` (`.opencode/skills/agentera-state/SKILL.md`): any mutation of
  state entities, TODO, or changelog, and creating any commit.
- `agentera-verification` (`.opencode/skills/agentera-verification/SKILL.md`):
  changing or diagnosing tests, verification lanes, hooks, generated output,
  package construction, compaction, or runtime parity. Running the daily
  commands below does not require it.

Ordinary testing does not trigger release procedures. When loaded, Agentera
guidance follows `skills/agentera/protocol.yaml#OPERATING_RULES`: reuse
applicable passing evidence, probe consequential unknowns narrowly, and stop at
accepted scope. Project, host, and trust gates and explicit permissions remain
binding.

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
docs/packaging/             Canonical packaging, release, and toolchain guides
```

## State authority

Read state through the CLI when you need it, and reuse what you already know
while relevant state is unchanged. These recipes are not a startup checklist;
commit-only work does not require orientation:

```bash
npx -y agentera@next prime
npx -y agentera@next state todo list
npx -y agentera@next state plan list --status open
npx -y agentera@next state query --list-artifacts
```

Progress, decisions, plans, tasks, and health records are typed writer-owned
entities. Never edit `.agentera/entities/` directly. Load `agentera-state`
before any mutation.

Never modify `.agentera/vision.yaml` outside a vision capability or an explicit
vision task. Canonical artifact names can map to YAML paths; use CLI inventory
and `.agentera/docs.yaml` mappings rather than assuming paths.

## Branch model

- `main` holds the feature-frozen v2 history until v3 replaces the placeholder
  shim on npm `@latest`.
- `feat/v3` is the v3 integration and release source branch. Feature and
  worktree branches target it until cutover; a worktree is not an alternate
  integration trunk.
- The archived `main-pre-squash-v1` branch is historical only.

### Pushes publish

Every passing push to the ref in
`references/adapters/package-publication.json#ci.developmentPush.ref` publishes
a development package to npm `@next`. Ordinary pushes need no version bump or
metadata commit.

- A user's explicit push authorization permits exactly one push. After that
  push, stop.
- A failed or cancelled workflow does not authorize another push or version.
  Fix the cause on a worktree branch and get fresh explicit authorization.
- Until `3.0.0` is on npm `@latest`, do not bump suite or release metadata
  beyond `3.0.0`.

Load `agentera-release` for version allocation, CI publication, credentials,
recovery, the stable path, or a change to the development ref.

## Common commands

Contributors use standalone Vite+ 1.0.0, which supplies Node.js from
`.node-version` and pnpm from `package.json#packageManager`. Install the
launcher, verify it, and recover a broken setup with the
[toolchain guide](docs/packaging/vite-plus-1-toolchain.md#contributor-setup).
Do not use an unpinned installer, an older global `vp`, or another package
manager.

First install in a fresh checkout or worktree, from the repository root:

```bash
vp --version
vp env on
VP_GIT_HOOKS=0 vp install --frozen-lockfile
```

Daily commands, from the repository root:

```bash
vp check                   # formatting and lint
vp run typecheck           # fresh compiler check
vp run test                # complete source tests
vp run build               # build the CLI
vp run verify:development  # routine development gates
vp run verify              # full qualification (slow)
```

- Native `vp test` and `vp build` are not aliases for `vp run test` and
  `vp run build`.
- Bare `vp -C` can select ambient Node. Run package-directory recipes as
  `vp env exec --node "$(cat .node-version)" vp -C packages/cli run TASK`.
- `vp run typecheck:cached` is opt-in developer feedback only. If it reports
  `Cache lookup failed`, the compiler did not run and the guard fails the task.
  Rerun with `vp run typecheck:fresh`.
- To check changed local CLI behavior, run
  `vp node packages/cli/dist/bin/agentera.js ...` from a current
  `vp run build`. Reuse that build until relevant inputs change. Project-state
  operations use the published `npx -y agentera@next state ...`.
- Installing dependencies does not enable hooks. Run `vp hooks enable` only in
  an independent clone; in a linked worktree, it changes shared Git
  configuration and needs permission. Hooks catch ordinary mistakes; they are
  not a security boundary or a substitute for CI.

Run the narrowest relevant check first, then broaden according to impact.

## Always-on boundaries

- Never publish, tag, or push without explicit user authorization. This holds
  during capability execution too.
- Credentials (`.env`, `.npmrc`, inherited `NPM_TOKEN`), source receipts, and
  CI success are never registry-mutation approval. Load `agentera-release`
  before checking or using npm credentials.
- Never use direct `npm pack` or `npm publish` for Agentera packages outside the
  repository package construction and publication helpers.
- Never amend, force-push, or use destructive Git operations unless the user
  explicitly authorizes the applicable action.
- Never skip hooks as a routine shortcut. Use `VP_GIT_HOOKS=0` at commit time
  only when hook configuration is broken or a failure is already tracked for CI.
- Preserve unrelated worktree changes and stage only intended files.

## Runtime notes

- The published v3 package is self-contained under `packages/cli/bundle/` and
  does not require a checkout or `AGENTERA_HOME`.
- The installed host projection is exactly one `SKILL.md`; runtime contracts
  remain inside the CLI package. Use purpose-owned static detail commands, not
  host companion reads. `docs/cli-coverage-contract.md` maps those interfaces.
- `upgrade --shared-skill` is separate from project migration and defaults to
  preview. Follow `UPGRADE.md#one-file-shared-skill-installation-and-repair` for
  approval, dedicated-directory conversion, retained data, and Linux apply
  limits. Never prune a host symlink target or infer global permission from
  project scope.
- Upgrade preview is read-only. Apply is forward-only and requires explicit
  consent. The separate `--legacy-cleanup RESOURCE_ID` route also requires
  matching ownership evidence.
- Prefer `agentera check validate`; top-level `agentera validate` is a migration
  alias.
- Use `agentera prime` for status and typed `agentera state` commands for
  artifacts. Top-level `status`, `todo`, and `docs` are not v3 commands.
- User-facing CLI behavior belongs under an `agentera` namespace. Direct
  `scripts/` entry points are maintainer-only unless documented otherwise.
