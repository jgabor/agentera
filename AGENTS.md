# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## What this is

Agentera is an opinionated mobile-first coding agent shipped as a monorepo:

| Package | npm | Role |
| ------- | --- | ---- |
| `packages/cli` | `agentera` | **Primary product** — agent runtime and `.agentera/` project-state CLI ("the colleague's brain") |
| `packages/mobile` | `@agentera/mobile` | Mobile client — SvelteKit app with Cursor SDK (currently a docs-only stub; state and dev workflow: `packages/mobile/AGENTS.md`) |
| `packages/web` | `@agentera/web` | Marketing site and Starlight docs |

Mobile uses Cursor SDK directly — not skill routing from `skills/agentera/SKILL.md`.

Twelve capabilities route through the CLI and editor runtimes:

| Capability | Use when you need... |
| ---------- | -------------------- |
| `status` | Project briefing and next best action |
| `vision` | Product direction |
| `discuss` | Structured deliberation |
| `research` | External pattern analysis |
| `plan` | Scoped plan with acceptance criteria |
| `build` | One verified development cycle |
| `optimize` | Metric-driven optimization |
| `document` | Documentation aligned with code |
| `design` | Visual identity and design tokens |
| `audit` | Architecture and project health audits |
| `profile` | Reusable decision profile |
| `orchestrate` | Autonomous plan execution with evaluation |

Each capability is defined by human-readable prose (`packages/cli/src/capabilities/<name>/instructions.ts`) and machine-readable schemas (`triggers.yaml`, `artifacts.yaml`, `validation.yaml`, `exit.yaml`). The Agentera router routes incoming requests to the right capability. The runtime serves the prose through `agentera prime --context <name> --format json`.

Monorepo consolidation plan: [`docs/consolidation/monorepo-plan.md`](./docs/consolidation/monorepo-plan.md).

## Project layout

```text
agentera/
├── .agentera/                              # User project state; CLI is the canonical read/write seam
│   ├── entities/                          # One writer-owned file per mutable state entity
│   ├── state-mode.yaml                    # Durable entity-authority marker
│   ├── vision.yaml                        # Product north star — intentional singleton
│   └── docs.yaml                          # Documentation policy/mappings singleton
├── AGENTS.md                              # This file
├── README.md, DESIGN.md, TODO.md, CHANGELOG.md, UPGRADE.md
├── package.json                           # vp-based workspace shortcuts (web:*, mobile:*)
├── .lefthook.yml                          # Pre-commit hook config (authoritative)
├── packages/
│   ├── cli/                               # `agentera` — TypeScript CLI + bundled skills
│   │   ├── src/                           #   source: capabilities/, cli/, core/, state/, validate/, registries/, ...
│   │   ├── test/                          #   vitest (pinned fixtures under fixtures/repo-state/)
│   │   ├── dist/                          #   tsc build output (build before invoking bare `agentera` or `check compact`)
│   │   ├── bundle/                        #   packed app data (skills/, references/, registry.json)
│   │   └── shim/                          #   npm shim for stable channel
│   ├── web/                               # `@agentera/web` — Astro + Starlight on Cloudflare
│   └── mobile/                            # `@agentera/mobile` — docs-only stub; see packages/mobile/AGENTS.md
├── skills/agentera/
│   ├── SKILL.md                           # Editor-runtime entry point + routing stub
│   ├── capabilities/<name>/schemas/       # triggers, artifacts, validation, exit
│   ├── protocol.yaml                      # Shared primitives, glyphs, semantic tokens
│   ├── capability_schema_contract.yaml    # Schema structure contract
│   └── references/                        # Internal schemas, adapters, vocabulary
└── references/                            # Contracts and migration references
```

Read project state through the CLI before reading artifacts directly:

```bash
agentera prime                    # Orientation briefing
agentera state todo                # Active items
agentera state plan                # Active + archived plan
agentera state query --list-artifacts   # Canonical artifact inventory
```

Canonical artifact names such as `DOCS.md` may map to YAML paths such as `.agentera/docs.yaml`; use the CLI result as the source of truth.

Mutable state records have public `id` and `artifact` fields and one canonical
entity file. Write `progress`, `decisions`, `plan`, and `health` through the typed
state writer instead of editing `.agentera/entities/`. The writer assigns IDs,
validates records, and publishes atomically. Discover each live mutation contract
before constructing a write:

```bash
agentera state decisions explain --format json
agentera state decisions explain --verb update --format json
agentera state progress explain --verb append --format json
agentera state plan explain --verb create --format json
agentera state health explain --verb append --format json
```

Bounded retrieval is governed by
`references/artifacts/state-storage-authority.yaml`; do not duplicate its
identity, cursor, omission, compatibility, archive-ownership, or output-bound
rules. Inspect it through `agentera schema --format json`. Public reads include
`agentera state plan list`, active-only `agentera state plan tasks list`, and
`agentera state experiments list --objective OBJECTIVE_ID`; use their matching
exact `get` forms for detail.

Use the returned examples and field definitions, and add `--dry-run` when a
preview is appropriate. Artifacts outside those four families remain governed
by their owning capability instructions.

## Branch model

**Target:** trunk-based development on `main`. Commits land directly on `main`; branches are absent or extremely short-lived. No pull-request workflow — CI and release tags gate quality.

**During the v3 rewrite (temporary):**

- `feat/v3` — active TypeScript rewrite; npm `@next` channel (`npx -y agentera@next`). Most `feat:`, `fix:`, and `test:` work lands here.
- `main` — v2.x stable Python CLI (`npx -y agentera@latest`). Feature-frozen except velocity blockers.

Note: global agent guidance includes worktree tooling (`wt switch --create feat/<slug>`). This project commits to trunks, not branches — only use worktrees if commits can stay on the target trunk.

## Commands

Invocation convention: during the v3 rewrite, `npx -y agentera@next <cmd>` invokes the published v3 channel; `npx -y agentera@latest` remains the stable v2.x channel until promotion. Bare `agentera` requires an installed CLI or `packages/cli/dist/bin/agentera.js`. Use contributor paths (`pnpm -C packages/cli`, `node packages/cli/dist/bin/agentera.js`) when modifying CLI source; use `vp run` for web and mobile workspace scripts.

### Recipe-first entry points (run from repo root unless noted)

| When | Command |
| ---- | ------- |
| Orientation / status dashboard | `npx -y agentera@next prime` |
| Capability startup context | `npx -y agentera@next prime --context <name> --format json` |
| Project state | `npx -y agentera@next state todo` · `state plan` · `state decisions` |
| Discover artifact writes | `npx -y agentera@next state <artifact> explain --format json` |
| Inspect writer operation matrix | `npx -y agentera@next schema --format json` |
| Artifact inventory | `npx -y agentera@next state query --list-artifacts` |
| Validate capability or contract | `npx -y agentera@next check validate capability <name>` · `check validate capability-contract` |
| CLI source tests | `pnpm -C packages/cli test` |
| CLI package boundary | `pnpm -C packages/cli run verify:package` |
| CLI typecheck / build | `pnpm -C packages/cli run typecheck` · `pnpm -C packages/cli build` |
| Compaction gate | `pnpm -C packages/cli build && node packages/cli/dist/bin/agentera.js check compact` |
| Web check / build | `vp run web:check` · `vp run web:build` |
| Web dev (full SSR) | `cd packages/web && npx astro dev` |
| Mobile check / dev | `vp run mobile:check` · `vp run mobile:dev` |
| Workspace package script | `vp run @agentera/<pkg>#<script>` |

## Versioning and publishing

**v3 cutover hold:** Until `3.0.0` has landed on npm `@latest`, do not bump
the suite or release metadata beyond `3.0.0`. The only permitted version bump
is `packages/cli/package.json#version` from `3.0.0-dev.N` to the next
`3.0.0-dev.N+1` development build. Keep every suite-bearing version surface at
`3.0.0`, retain unreleased changelog entries under `[Unreleased]`, and publish
these builds only to npm `@next`.

Use `.agentera/docs.yaml` as the version authority: `feat` releases bump
minor, `fix` releases bump patch, and `docs`/`chore`/`test` changes do not
bump a version. For a release, update every path in
`conventions.version_files` together with the matching `CHANGELOG.md` entry:

- `packages/cli/package.json`
- `skills/agentera/SKILL.md`
- `registry.json`

The development npm package and suite metadata have distinct versions:
`packages/cli/package.json#version` uses the publishable `X.Y.Z-dev.N`
version, while `agentera.suiteVersion`, the skill frontmatter, and
`registry.json` use the release `X.Y.Z` version. Set
`packages/cli/package.json#agentera.gitRef` to the immutable commit selected
for that release. Keep the version-file list synchronized with
`references/adapters/package-registry.yaml` rather than adding ad hoc version
surfaces.

Before publishing, run the release gates from the repository root:

```bash
pnpm -C packages/cli test
pnpm -C packages/cli run typecheck
pnpm -C packages/cli build
node packages/cli/dist/bin/agentera.js check validate \
  capability-contract --format json
pnpm -C packages/cli run pack:dry-run
```

Publish only after the release commit is clean and all gates pass. The v3
development channel publishes `agentera` to npm `@next`; it loads `NPM_TOKEN`
from `.env` when present. npm rejects an already-published version, so compare
the local package version with the current `@next` version before publishing.
When they match, increment `packages/cli/package.json#version`, commit that
bump, and rerun the checks before publishing:

```bash
npm view agentera@next version
pnpm cli:publish:dev
```

The stable channel remains the transitional shim on npm `@latest`. Its publish
script requires a clean tree, runs its regression tests, increments the shim
patch version, pins its `gitRef`, and publishes. It intentionally leaves the
successful bump in `packages/cli/shim/package.json`; commit that bump after a
successful publication:

```bash
pnpm cli:publish:stable
```

Never publish, tag, or push during normal capability execution without the
user's explicit instruction.

### Pre-commit hooks

Install hooks once after clone: `lefthook install`. Hook configuration is [`.lefthook.yml`](./.lefthook.yml) (authoritative source — verify there before relying on summaries below).

Pre-commit runs:

- **`agentera check compact`** — artifact compaction budget gate (`uniform_10_40_50`). The most important repository content gate.
- **`scripts/precommit-vitest.sh {staged_files}`** — staged-aware vitest; full `pnpm -C packages/cli test` only when broad CLI, schema, or workflow paths change.
- **`vp staged`** in `packages/web` and `packages/mobile` when web or mobile files change.
- **markdownlint** (via `bunx`) for repo-wide docs; **`vp fmt`** for configs.

Use `LEFTHOOK=0 git commit` only for emergency bypass when the hook config itself is broken or a failure is already tracked for CI — not for routine TODO.md or fixture edits.

### Tests

CLI test suite is vitest. Lefthook pre-commit runs it when staged files touch `packages/cli/**`, `skills/`/`references/` data, `registry.json`/`protocol.yaml`, or workflow paths — not for web-only changes under `packages/web/**`.

```bash
pnpm -C packages/cli test
```

**Layers:** Vitest proves hook and CLI **logic** from temp dirs and pinned fixtures under `packages/cli/test/fixtures/repo-state/` — **not** from this checkout's live `.agentera/` or `TODO.md`. Committed artifact **budgets** (`uniform_10_40_50`) are enforced by `agentera check compact` in CI and lefthook, not by vitest. See [`packages/cli/test/README.md`](./packages/cli/test/README.md) for the REPO_ROOT coupling inventory.

When vitest passes but `check compact` fails, fix committed artifacts or run compaction — do not treat compact failures as missing unit tests.

## Capabilities

### Adding or modifying a capability

1. Create `packages/cli/src/capabilities/<name>/instructions.ts` exporting the behavioral instructions as a default-exported string constant named `instructions`.
2. Create schema files under `skills/agentera/capabilities/<name>/schemas/`: `triggers.yaml`, `artifacts.yaml`, `validation.yaml`, `exit.yaml`.
3. Update the capability table in `skills/agentera/SKILL.md`.
4. Verify every command name, file path, env var, and contract reference in the prose against the v3 runtime (`--help`, filesystem check). v2-era prose drifts from v3 reality and ships ghosts that pass lint but mislead agents at runtime.
5. Validate: `npx -y agentera@next check validate capability <name-or-path>`.

### Validation

`capability_schema_contract.yaml` (`skills/agentera/capability_schema_contract.yaml`) owns capability schema structure; `packages/cli/src/registries/capabilityContract.ts` loads the model consumed by the validator. Do not duplicate contract-owned groups, priority values, directory rules, or primitive-reference field mappings in tests or docs unless a validation check ties them back to the loader/model.

```bash
npx -y agentera@next check validate capability <name-or-path>
npx -y agentera@next check validate capability-contract --format json
```

Top-level `agentera validate` remains a migration alias during the namespace rollout; prefer `agentera check validate`. Use `agentera prime` for status and `agentera state todo` or `agentera state docs` for artifact reads; top-level `status`, `todo`, and `docs` are not v3 commands.

## Commits

### Format

Conventional Commits: `feat(scope): …`, `fix(scope): …`, `docs(scope): …`, `refactor(scope): …`, `chore(scope): …`, `test(scope): …`. Commit messages are concise, imperative descriptions of the substantive engineering outcome, not Agentera bookkeeping. Scopes are optional; omit for broad suite-wide changes.

### Scopes (closed vocabulary)

| Scope | Use for |
| ----- | ------- |
| `mobile` | `packages/mobile`, mobile UI, Cursor SDK integration, mobile deploy |
| `web` | `packages/web`, Astro/Starlight site, marketing pages, published docs |
| `cli` | `packages/cli`, command behavior, CLI output, command tests |
| `hooks` | `hooks/*`, artifact validation hooks, session hooks, compaction hooks |
| `schemas` | `protocol.yaml`, `capability_schema_contract.yaml`, artifact schemas, schema contracts |
| `eval` | Semantic eval runner, fixtures, evaluation harnesses |
| `install` | App home, upgrade, app refresh, setup, doctor install behavior |
| `package` | `packages/cli/package.json`, `registry.json`, lockfiles, and current version-bearing package surfaces |
| `runtime` | Cross-runtime behavior or shared adapter contracts |
| `opencode` | OpenCode-specific runtime behavior or packaging |
| `claude` | Retired Claude migration or historical-import behavior only |
| `codex` | Codex-specific runtime behavior or packaging |
| `copilot` | Copilot-specific runtime behavior or packaging |
| `cursor` | Cursor IDE and cursor-agent CLI runtime behavior, hooks, agents, packaging |
| `release` | Version bumps, changelog promotion, release readiness, tag/publication prep |
| `agents` | `AGENTS.md` or runtime-neutral agent operating guidance |
| `status` · `vision` · `discuss` · `research` · `plan` · `build` · `optimize` · `audit` · `document` · `profile` · `design` · `orchestrate` | Capability behavior, prose, schemas, or tests for the named capability |

New scopes are closed by default. If a commit needs a new scope, add it to the table above in the same commit; otherwise omit the scope. Do not use `agentera` as a scope (the repository already provides that context); do not use comma-separated scopes — choose the dominant subsystem or omit.

### Same-commit fold-in (default)

When a task touches code, tests, or user-facing docs, fold related artifact updates into **that same commit**:

- plan and task entities through `agentera state plan explain`
- progress entities through `agentera state progress explain`
- `TODO.md` (open items closed or filed)
- health entities through `agentera state health explain`
- decision entities through `agentera state decisions explain`

The principle applies to every capability that writes state: `audit`, `plan`,
`orchestrate`, `build`, and `discuss` use their typed entity writers. Do not leave
a task "done" with state committed in a follow-up chore commit. If the
implementation commit already shipped, fold state updates into the next
substantive commit on the same task — not a hash-backfill pass.

### Standalone commits (narrow exceptions)

Only these may land without paired product code in the same commit:

- **Release cuts** — version bumps, changelog promotion, npm publish metadata
- **npm publish / registry alignment** when no code change accompanies the tag

Anything else — including plan archive, TODO Resolved moves, progress cycles, health audits, and decision closeout — rides the implementation commit. **Do not create standalone `chore:` commits for state artifact bookkeeping; do not hash-backfill `resolved @ <sha>` lines** — `resolved YYYY-MM-DD` or `resolved @ <semver>` in the implementation commit is sufficient.

### Sequencing

When a task naturally splits refactor and behavior:

1. **Refactor commit first** — behavior-preserving extraction, rename, or move; tree green.
2. **Behavior commit second** — minimal diff for the fix or feature; tests in the same commit unless the plan explicitly splits them.

If the user asked for one squashed delivery, a single commit is fine. Do not bundle a behavior-preserving refactor into a behavior commit because it was discovered mid-change — stage hunks or split commits instead.

### Code comments vs commit messages

Comments explain **why the code is shaped as it is** for a reader who has never seen prior versions. Do not narrate development history, rejected alternatives, or "cleaner than the previous approach" in source — that story belongs in the commit message.

## Restrictions

- **Never push to remote repos** during capability execution cycles.
- **Never modify `.agentera/vision.yaml`** unless running the `vision` capability or an explicit vision task.
- **Never use `LEFTHOOK=0` as a routine shortcut** — emergency bypass only when the hook config itself is broken or a failure is tracked for CI.
- **Never create standalone `chore:` commits for state artifact bookkeeping** — fold into the implementation commit (see above).
- Shared primitives live in `protocol.yaml`, not per-skill specs.
- Visual identity (glyphs, semantic tokens) defined in `protocol.yaml`.
- Versioning convention in `.agentera/docs.yaml`: `version_files` lists what to bump; `semver_policy` maps commit types to bump levels.

## Gotchas

- **`vp dev packages/web` starts Vite in client-only mode** and returns 404 for SSR routes. Use `cd packages/web && npx astro dev` for full SSR dev experience.
- **The published v3 npm package is self-contained**: it bundles app data (`skills/`, `references/`, `registry.json`) under `packages/cli/bundle/` at pack time, so `npx -y agentera@next` works with no repo checkout and no `AGENTERA_HOME`.
- **Upgrade previews are read-only**: normal upgrade handles app/project migration only; the separate `--legacy-cleanup claude` route requires explicit approval and matching ownership evidence.
- **`.lefthook.yml` is the source of truth for pre-commit behavior** — verify there before relying on the summary above.
- **`.opencode/` requires a standalone `npm install`** (not managed by the pnpm workspace) — provides `@opencode-ai/plugin` types used by some tests.
- Requires Node.js 22+ with pnpm 10.30.3 (enable via `corepack enable`).

## Conventions (condensed)

### Helper script policy

`npx -y agentera@next ...` is the canonical documented entry point until v3 is promoted to the stable dist-tag. Direct helper scripts in `scripts/` are maintainer-only unless they back an `agentera` namespace command. When adding helpers, prefer exposing a stable `agentera` namespace; otherwise document the helper explicitly as local-only with privacy/scope caveats. Do not add broad new top-level CLI commands for implementation details.

### Changelog

`CHANGELOG.md` follows [Keep-a-Changelog](https://keepachangelog.com/) style. Write for a cold reader: what shipped, what changed, what broke. In minor or major releases with meaningful user-facing change, add `### Key highlights` before categorized sections; patch releases may omit highlights when the diff is small. Version header: `## [X.Y.Z] · YYYY-MM-DD`.

Do not include:

- Internal Agentera bookkeeping: decision numbers, plan/task closeout, progress evidence, smoke log paths, archive workpapers, registry/parity doc sync notes.
- Hype framing ("joins the roster", "behave like dashboards again", "leave the README-only era").
- Features, scaffolds, or infrastructure not yet shipped or user-visible.

In **Key highlights**, lead with a short **bold label** and follow with a concise factual summary. In **Fixed**, start each bullet with `Fixed`. Include concrete command names, flags, env vars, defaults, and before/after measurements when they help a reader act. Fold changelog updates into the release commit rather than standalone bookkeeping commits.
