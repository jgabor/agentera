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
  release verification/approval, registry credentials, dist-tags, or replay, load
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

Ordinary testing or a mention of verification does not trigger release
procedures without a release-specific need. When loaded, Agentera guidance
follows `skills/agentera/protocol.yaml#OPERATING_RULES`: reuse applicable passing
evidence, probe consequential unknowns narrowly, and stop at accepted scope.
Project/host/trust gates and explicit permissions remain binding.

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

Use CLI-first reads when state knowledge is needed; reuse existing knowledge
while relevant state is unchanged. These are need-driven recipes, not a startup
checklist; commit-only work does not itself require orientation:

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

Contributors use standalone Vite+ **1.0.0**, which supplies the Node.js version
in `.node-version` and pnpm 10.30.3 from `package.json#packageManager`.
No separate Node, Corepack, pnpm, or hook manager installation is required.

Obtain the standalone launcher from the trusted
[Vite+ v1.0.0 release](https://github.com/voidzero-dev/vite-plus/releases/tag/v1.0.0),
not the Node-dependent project shim. The verified Linux x64 asset is
`vp-x86_64-unknown-linux-gnu.tar.gz`; review the release provenance and checksum
before extracting its executable into a user-owned directory on ordinary
shell **and Git** `PATH`. Download/extraction tools are OS prerequisites, not
provided by Vite+. Do not substitute an unpinned installer or an older global
`vp`; `vp --version` must report 1.0.0 for the launcher and, after install, the
local package. This contributor path is verified on Linux x64 only; macOS and
Windows are not qualified by that evidence.

The selected Linux x64 archive SHA-256 is
`2adca8386c8f7e158eea4abe1a3eda9f89313c869145f788409a0be45979dd6a`.
Verify it before extraction or execution. The immutable release, selected npm
SLSA provenance, bootstrap isolation, and fresh/warm cache limits are recorded in
[the bootstrap authority](references/analysis/bootstrap-integrity.md).

From the repository root, first install (also dependency recovery):

```bash
vp --version
vp env on
VP_GIT_HOOKS=0 vp install --frozen-lockfile
```

`vp run bootstrap` repeats the frozen install only **after local dependencies
exist**; it is not the fresh-checkout entrypoint. If the launcher is missing or
old, restore the supported standalone executable on `PATH` first. If the frozen
lock check fails, restore matching checked-in manifests and lockfile, then rerun
the frozen install; do not bypass the lock check or install another manager.

Dependency installation does not authorize hook activation. In an independent
clone, activate the native dispatcher with `vp hooks enable` after install, and
inspect `vp hooks status`. Do not enable it in a linked worktree without permission
to change shared Git configuration. The existing common hook remains supported
through a small invoking-worktree bridge, without installing Lefthook.

Daily commands, also from the repository root:

```bash
VP_GIT_HOOKS=0 vp install
vp check
vp run typecheck
vp run test
vp run build
vp run verify:development
vp run verify
```

The required root recipes are native tasks in `vite.config.ts`, with per-task `cache: false`.
They stay fresh even under `vp run --cache` and delegate to the existing CLI package owners.
Root pnpm scripts are removed. Update root-level automation from `pnpm run TASK`
to `vp run TASK`; package-level pnpm scripts remain the internal owners.
Runtime-bearing tasks use the invoking standalone launcher's `VP_CLI_BIN` with
explicit `env exec --node` from `.node-version`. Native `run` and `exec` alone
can select ambient Node even after managed setup. The public root `vp run`
recipes and argument forwarding stay unchanged. For package-directory recipes,
use `vp env exec --node 24.19.0 vp -C packages/cli run TASK` from the root.
This is scoped execution, not a global PATH or hook change.
`vp run test` is the complete source owner; `vp run build` builds the CLI.
Native `vp test` and `vp build` are not aliases for those tasks.
`vp run test:local` is an explicit developer diagnostic for the positive fast
`local` project, not full source assurance. `vp run typecheck:fresh` is an explicit
alias for fresh typecheck. `vp run typecheck:cached` is the sole opt-in cached
developer feedback entry. Its public task always runs the outer guard around
private `_typecheck:cached`, which runs the same read-only compiler owner.
Source, test, manifest/lock/toolchain inputs and relevant environment changes
invalidate that verdict. Test-file invalidation does not mean tests are typechecked
or cached. Default typecheck, hooks, tests/lint, verification, build, package and
publication remain fresh. Never invoke the private task as an assurance entry.
See [the toolchain guide](docs/packaging/vite-plus-1-toolchain.md#fresh-checks-and-optional-caching) for scope and qualification.
The pinned native `Cache lookup failed` diagnostic can accompany exit 0 without
child execution. Never accept that skip as a pass. The maintainer outer guard in
`packages/cli/scripts/guard-native-cache.mjs` rejects that diagnostic; it is a
workaround, not an upstream repair or authority to cache other owners. Recover with
the unchanged fresh entry (`vp run typecheck:fresh` for typecheck). See the guide's
recovery section for placement and limits. Ordinary failures still need
their own diagnosis.
`vp run verify:development` is routine development safety; `vp run verify` is
full qualification, including repeated measurements and historical certification.
pnpm remains the underlying workspace/lockfile authority, managed through Vite+.
Maintainer-only package and lane commands live in
`.opencode/skills/agentera-verification/SKILL.md` and
`docs/packaging/v3-packaging.md`.

Project-state operations use the published development runtime,
`npx -y agentera@next state ...`. Checks for changed local CLI behavior use
`vp node packages/cli/dist/bin/agentera.js ...` from a current `vp run build`; they
do not use the published package. Reuse that build until relevant inputs change
or the artifact is absent, rather than rebuilding before every invocation.

Local hooks use native staged formatting/linting with partial-hunk preservation,
import-related tests within the policy's positive fast `local` project, a small
authority guard project, and separate typecheck. Root native discovery partitions
the full source owner into `local`, `source` (remainder), and `guards` without duplication;
full CI retains specialized owners. See the verification skill for coverage
limits, fixture exclusions, and local-tool recovery.

Vite+ is the sole hook owner. `.vite-hooks/pre-commit` invokes project-local
`vp staged`; `vite.config.ts#staged` runs fixes, then the scoped readers in
`packages/cli/scripts/pre-commit-checks.mjs`, within the hidden-partial-hunk
snapshot. `packages/cli/scripts/run-lefthook.sh` only forwards an old installed
`run pre-commit` entry point to that policy. It never activates hooks.
Restore launcher discovery and each worktree's dependencies before retrying Git.
Oxfmt owns Markdown formatting, not Markdown structural lint. Root, package and
editor formatting use width 320 and the root exclusions. See the
[formatting concessions](docs/packaging/vite-plus-1-toolchain.md#formatting-and-hooks).
These bypassable local hooks prevent ordinary mistakes; they are not a security
boundary or a substitute for required CI checks.

### Optional checkout-local runtime dependencies

Only when optional `.opencode/` runtime code or tests need its declared types,
and its npm manifest/lockfile are present, run from the repository root after
the root install:

```bash
vp exec npm --prefix .opencode install --ignore-scripts --no-audit --no-fund
```

This Vite+ 1.0.0 recipe uses managed npm with the nested npm manifest and
`package-lock.json`, without adopting it into pnpm or changing the parent
workspace authorities. It is not part of root install. Keep that ignored,
checkout-local dependency boundary outside the pnpm workspace and Agentera
package; do not replace it with `vp install` in the nested directory.

First use needs network access for uncached runtime, manager, and dependencies.
Warm cached offline use is verified; an empty offline cache cannot provision
Node. Optional npm `--offline` also requires its dependency artifacts locally.
Vite+ does not supply the OS tools or Git history required by tests and hooks;
see [test prerequisites](packages/cli/test/README.md#contributor-prerequisites).
CI's verified native Vite+ bootstrap, internal pnpm scripts, isolated npm package
construction, and fixed OIDC publisher are separate authorities, not alternate
contributor setup recipes. Consumer `npx -y agentera@next` is unchanged.

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
- Never skip hooks as a routine shortcut. Use `VP_GIT_HOOKS=0` at commit time only when hook
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
- The installed host projection is exactly one `SKILL.md`; runtime contracts
  remain inside the CLI package. Use purpose-owned static detail commands, not
  host companion reads. `docs/cli-coverage-contract.md` maps those interfaces.
- `upgrade --shared-skill` is separate from project migration and defaults to
  preview. Follow `UPGRADE.md#one-file-shared-skill-installation-and-repair` for
  approval, dedicated-directory conversion, retained data and Linux apply limits. Never prune
  a host symlink target or infer global permission from project scope.
- Prefer `agentera check validate`; top-level `agentera validate` is a migration
  alias.
- Use `agentera prime` for status and typed `agentera state` commands for
  artifacts. Top-level `status`, `todo`, and `docs` are not v3 commands.
- Upgrade preview is read-only. Apply is forward-only and requires explicit
  consent. The separate `--legacy-cleanup RESOURCE_ID` route also requires
  matching ownership evidence.
- User-facing CLI behavior belongs under an `agentera` namespace. Direct
  `scripts/` entry points are maintainer-only unless documented otherwise.
