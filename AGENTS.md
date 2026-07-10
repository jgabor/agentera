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
├── .agentera/                              # User project-state directory (CLI is canonical read path)
│   ├── vision.yaml                        # Product north star — do not modify in execution cycles
│   ├── plan.yaml                          # Active plan + archive
│   ├── progress.yaml                      # Shipped work with verification evidence
│   ├── decisions.yaml                     # Durable reasoning trail
│   ├── health.yaml                        # Architecture and project health audits
│   └── docs.yaml                          # Documentation inventory and drift
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
└── references/                            # Cross-runtime adapters, contract docs
```

Read project state through the CLI before reading artifacts directly:

```bash
agentera prime                    # Orientation briefing
agentera state todo                # Active items
agentera state plan                # Active + archived plan
agentera state query --list-artifacts   # Canonical artifact inventory
```

Canonical artifact names such as `DOCS.md` may map to YAML paths such as `.agentera/docs.yaml`; use the CLI result as the source of truth.

## Branch model

**Target:** trunk-based development on `main`. Commits land directly on `main`; branches are absent or extremely short-lived. No pull-request workflow — CI and release tags gate quality.

**During the v3 rewrite (temporary):**

- `feat/v3` — active TypeScript rewrite; npm `@next` channel (`npx -y agentera@next`). Most `feat:`, `fix:`, and `test:` work lands here.
- `main` — v2.x stable Python CLI (`npx -y agentera@latest`). Feature-frozen except velocity blockers.

Note: global agent guidance includes worktree tooling (`wt switch --create feat/<slug>`). This project commits to trunks, not branches — only use worktrees if commits can stay on the target trunk.

## Commands

Invocation convention: `npx -y agentera <cmd>` invokes the published channel; bare `agentera` requires an installed CLI or `packages/cli/dist/bin/agentera.js`. Use contributor paths (`pnpm -C packages/cli`, `node packages/cli/dist/bin/agentera.js`) when modifying CLI source; use `vp run` for web and mobile workspace scripts.

### Recipe-first entry points (run from repo root unless noted)

| When | Command |
| ---- | ------- |
| Orientation / status dashboard | `npx -y agentera prime` |
| Capability startup context | `npx -y agentera prime --context <name> --format json` |
| Project state | `npx -y agentera state todo` · `state plan` · `state decisions` |
| Artifact inventory | `npx -y agentera state query --list-artifacts` |
| Validate capability or contract | `npx -y agentera check validate capability <name>` · `check validate capability-contract` |
| CLI tests | `pnpm -C packages/cli test` |
| CLI typecheck / build | `pnpm -C packages/cli run typecheck` · `pnpm -C packages/cli build` |
| Compaction gate | `pnpm -C packages/cli build && node packages/cli/dist/bin/agentera.js check compact` |
| Web check / build | `vp run web:check` · `vp run web:build` |
| Web dev (full SSR) | `cd packages/web && npx astro dev` |
| Mobile check / dev | `vp run mobile:check` · `vp run mobile:dev` |
| Workspace package script | `vp run @agentera/<pkg>#<script>` |

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
5. Validate: `npx -y agentera check validate capability <name-or-path>`.

### Validation

`capability_schema_contract.yaml` (`skills/agentera/capability_schema_contract.yaml`) owns capability schema structure; `packages/cli/src/registries/capabilityContract.ts` loads the model consumed by the validator. Do not duplicate contract-owned groups, priority values, directory rules, or primitive-reference field mappings in tests or docs unless a validation check ties them back to the loader/model.

```bash
npx -y agentera check validate capability <name-or-path>
npx -y agentera check validate capability-contract --format json
```

Top-level `agentera validate` remains a migration alias during the namespace rollout; prefer `agentera check validate`.

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
| `package` | `registry.json`, plugin manifests, lockfiles, version-bearing package surfaces |
| `runtime` | Cross-runtime behavior or shared adapter contracts |
| `opencode` | OpenCode-specific runtime behavior or packaging |
| `claude` | Claude-specific runtime behavior or packaging |
| `codex` | Codex-specific runtime behavior or packaging |
| `copilot` | Copilot-specific runtime behavior or packaging |
| `cursor` | Cursor IDE and cursor-agent CLI runtime behavior, hooks, agents, packaging |
| `release` | Version bumps, changelog promotion, release readiness, tag/publication prep |
| `agents` | `AGENTS.md` or runtime-neutral agent operating guidance |
| `status` · `vision` · `discuss` · `research` · `plan` · `build` · `optimize` · `audit` · `document` · `profile` · `design` · `orchestrate` | Capability behavior, prose, schemas, or tests for the named capability |

New scopes are closed by default. If a commit needs a new scope, add it to the table above in the same commit; otherwise omit the scope. Do not use `agentera` as a scope (the repository already provides that context); do not use comma-separated scopes — choose the dominant subsystem or omit.

### Same-commit fold-in (default)

When a task touches code, tests, or user-facing docs, fold related artifact updates into **that same commit**:

- `.agentera/plan.yaml` (task status, plan closeout, archive handoff)
- `.agentera/progress.yaml` (cycle evidence for the work)
- `TODO.md` (open items closed or filed)
- `.agentera/health.yaml` (audit capability output)
- `.agentera/decisions.yaml` (discuss satisfaction updates)

The principle applies to every capability that writes to `.agentera/`: `audit` writes `health.yaml`; `plan`/`orchestrate`/`build` write `plan.yaml`; `discuss` writes `decisions.yaml`. Do not leave a task "done" with artifact state committed in a follow-up chore commit. If the implementation commit already shipped, fold artifact updates into the next substantive commit on the same task — not a hash-backfill pass.

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
- Top-level aliases such as `status`, `todo`, and `docs` remain during migration with stderr deprecation; prefer `agentera state <subcmd>`.
- Shared primitives live in `protocol.yaml`, not per-skill specs.
- Visual identity (glyphs, semantic tokens) defined in `protocol.yaml`.
- Versioning convention in `.agentera/docs.yaml`: `version_files` lists what to bump; `semver_policy` maps commit types to bump levels.

## Gotchas

- **`vp dev packages/web` starts Vite in client-only mode** and returns 404 for SSR routes. Use `cd packages/web && npx astro dev` for full SSR dev experience.
- **The published `agentera` npm package is self-contained**: it bundles app data (`skills/`, `references/`, `registry.json`) under `packages/cli/bundle/` at pack time, so `npx -y agentera` works with no repo checkout and no `AGENTERA_HOME`.
- **`.lefthook.yml` is the source of truth for pre-commit behavior** — verify there before relying on the summary above.
- **`.opencode/` requires a standalone `npm install`** (not managed by the pnpm workspace) — provides `@opencode-ai/plugin` types used by some tests.
- Requires Node.js 22+ with pnpm 10.30.3 (enable via `corepack enable`).

## Conventions (condensed)

### Helper script policy

`npx -y agentera ...` is the canonical documented entry point for normal users and agents. Direct helper scripts in `scripts/` are maintainer-only unless they back an `agentera` namespace command. When adding helpers, prefer exposing a stable `agentera` namespace; otherwise document the helper explicitly as local-only with privacy/scope caveats. Do not add broad new top-level CLI commands for implementation details.

### Changelog

`CHANGELOG.md` follows [Keep-a-Changelog](https://keepachangelog.com/) style. Write for a cold reader: what shipped, what changed, what broke. In minor or major releases with meaningful user-facing change, add `### Key highlights` before categorized sections; patch releases may omit highlights when the diff is small. Version header: `## [X.Y.Z] · YYYY-MM-DD`.

Do not include:

- Internal Agentera bookkeeping: decision numbers, plan/task closeout, progress evidence, smoke log paths, archive workpapers, registry/parity doc sync notes.
- Hype framing ("joins the roster", "behave like dashboards again", "leave the README-only era").
- Features, scaffolds, or infrastructure not yet shipped or user-visible.

In **Key highlights**, lead with a short **bold label** and follow with a concise factual summary. In **Fixed**, start each bullet with `Fixed`. Include concrete command names, flags, env vars, defaults, and before/after measurements when they help a reader act. Fold changelog updates into the release commit rather than standalone bookkeeping commits.
