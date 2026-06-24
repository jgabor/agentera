# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## What this is

Agentera is an opinionated mobile-first coding agent shipped as a monorepo:

| Package | Role |
| ------- | ---- |
| `@agentera/mobile` | Primary product — SvelteKit app with Cursor SDK |
| `@agentera/web` | Marketing site and Starlight docs |
| `@agentera/cli` | Agent runtime and `.agentera/` project-state CLI |

The skill bundle (`skills/agentera/`) with twelve capabilities remains the internal contract for the agent engine. Each capability is defined by human-readable prose (`packages/cli/src/capabilities/<name>/instructions.ts`) and machine-readable schemas (`triggers.yaml`, `artifacts.yaml`, `validation.yaml`, `exit.yaml`). The Agentera router routes incoming requests to the right capability. The runtime serves the prose through `agentera prime --context <name> --format json`.

Mobile uses Cursor SDK directly — not skill routing from `skills/agentera/SKILL.md`.

Monorepo consolidation plan: [`docs/consolidation/monorepo-plan.md`](./docs/consolidation/monorepo-plan.md).

## Branch model

**Target flow:** trunk-based development on `main`. Work commits directly to `main`;
branches are absent or extremely short-lived. There is no pull-request workflow —
CI and release tags gate quality, not merge requests.

**During the v3 rewrite (temporary):**

- `feat/v3` — active TypeScript rewrite; npm `@next` channel (`npx -y agentera@next`).
  Most `feat:`, `fix:`, and `test:` work lands here until v3 promotes to `main`.
- `main` — v2.x stable Python CLI (`npx -y agentera@latest`). Feature-frozen for
  the v3 cutover except velocity blockers (linter, commit-tracking flow, artifact
  validation hooks).
- `TODO.md` on `feat/v3` may still use `→ main`, `→ v3`, or `→ both` prefixes for
  dual-branch items until trunk cutover; retire those prefixes once development is
  trunk-only on `main`.

## Common commands

Recipe-first entry points (run from repo root unless noted):

| When | Command |
| ---- | ------- |
| Orientation / status dashboard | `npx -y agentera prime` |
| Capability startup context | `npx -y agentera prime --context <name> --format json` |
| Project state | `npx -y agentera state todo`, `state plan`, `state decisions` |
| Validate capability or contract | `npx -y agentera check validate capability <name>` · `check validate capability-contract` |
| Artifact compaction gate | `pnpm -C packages/cli build && node packages/cli/dist/bin/agentera.js check compact` |
| CLI tests (staged-aware via lefthook) | `pnpm -C packages/cli test` |
| CLI typecheck / build | `pnpm -C packages/cli run typecheck` · `pnpm -C packages/cli build` |
| Web lint / build / dev | `vp run web:check` · `vp run web:build` · `cd packages/web && npx astro dev` |
| Mobile check / dev | `vp run mobile:check` · `vp run mobile:dev` |

## Capability validation

Validate any capability through the canonical `agentera check validate` namespace.
Top-level `agentera validate` remains a migration alias during the namespace rollout.
`capability_schema_contract.yaml` owns capability schema structure;
`packages/cli/src/registries/capabilityContract.ts` loads the model consumed by the validator. Do not
duplicate contract-owned groups, priority values, directory rules, or
primitive-reference field mappings in tests or docs unless a validation check ties
them back to the loader/model.

```bash
npx -y agentera check validate capability <name-or-path>
```

Self-validate the contract:

```bash
npx -y agentera check validate capability-contract --format json
```

## Adding or modifying a capability

1. Create `packages/cli/src/capabilities/<name>/instructions.ts` that exports the behavioral instructions as a default-exported string constant named `instructions`
2. Create `skills/agentera/capabilities/<name>/schemas/` with the four schema files: `triggers.yaml`, `artifacts.yaml`, `validation.yaml`, `exit.yaml`
3. Update the capability table in `skills/agentera/SKILL.md`
4. Validate: `npx -y agentera check validate capability <name-or-path>`

## Artifact path resolution

Prefer the CLI for state access before raw artifact reads:

```bash
npx -y agentera prime
npx -y agentera state todo
npx -y agentera state docs
npx -y agentera state query --list-artifacts
```

Top-level aliases such as `status`, `todo`, and `docs` remain during migration with stderr deprecation.

Canonical artifact names such as `DOCS.md` may map to YAML paths such as `.agentera/docs.yaml`; use the mapping or CLI result as the source of truth.

Query and validate artifacts via the CLI:

```bash
npx -y agentera state query --list-artifacts
npx -y agentera state query decisions --topic <topic>
npx -y agentera check validate capability <name-or-path>
```

## Key conventions

- The Agentera routing entry point at `skills/agentera/SKILL.md` is the single entry point; capabilities live under `capabilities/`
- Shared primitives are defined in `protocol.yaml`, not per-skill specs
- Skills never push to remote repos or modify `.agentera/vision.yaml` or objective state during execution cycles
- Conventional commits: feat/fix/docs/refactor/chore/test; scopes follow the closed vocabulary below
- Visual identity: glyphs and semantic tokens defined in `protocol.yaml`
- Versioning convention in canonical `DOCS.md` (mapped here to `.agentera/docs.yaml`): `version_files` lists what to bump, `semver_policy` maps commit types to bump levels

## Changelog

`CHANGELOG.md` is the human-facing release history. Build maintains it at release time; fold changelog updates into the release commit rather than standalone bookkeeping commits.

### Structure

- Newest release first under `## [Unreleased]` (empty until the next cut).
- Version header: `## [X.Y.Z] · YYYY-MM-DD`.
- For minor and major releases with meaningful user-facing change, add `### Key highlights` before the categorized sections. Patch releases may omit highlights when the diff is small.
- Categorized sections: `### Added`, `### Changed`, `### Fixed`, `### Removed` — include only sections that apply.

### Tone and phrasing

- Write for someone reading the changelog cold: what shipped, what behavior changed, what broke and was fixed.
- Use factual, imperative release-note phrasing. Prefer direct descriptions (`Added …`, `Fixed …`, `Renamed …`) over narrative or marketing language.
- In **Key highlights**, lead with a short **bold label** and follow with a concise factual summary. Highlights orient the reader; the categorized sections carry the detail.
- In **Fixed**, start each bullet with `Fixed`.
- Include concrete command names, flags, env vars, and defaults when they help a reader act on the note.
- Include measurements and before/after numbers when they quantify a user-visible improvement (see 2.6.0 token budget highlights).

### Do not include

- Internal Agentera bookkeeping: decision numbers, plan/task closeout, progress evidence, smoke log paths, archive workpapers, registry/parity doc sync notes.
- Hype framing ("joins the roster", "behave like dashboards again", "leave the README-only era").
- Features, scaffolds, or infrastructure that are not yet shipped or user-visible.

### Examples

Good highlight:

```markdown
- **Cursor runtime support**: separate `cursor` (IDE) and `cursor-agent` (CLI) registry identities, repo-native hooks and managed capability agents, `agentera upgrade --runtime cursor`, doctor coverage, and `eval_skills --runtime cursor-agent`.
```

Good Fixed entry:

```markdown
- Fixed `agentera health` and status to select the latest health audit by highest audit number and read schema `date` instead of a missing `timestamp` field.
```

Avoid:

```markdown
- Cursor v1 per Decision 63: `.cursor/hooks.json`, …
- Registry and parity docs record passed live preToolUse Write smoke (2026-05-24).
- **Documentation website** in `packages/web` … (when the site is not yet developed)
```

## Commit message scopes

Scopes are optional. Omit the scope for broad suite-wide changes instead of using a generic scope.

Do not use `agentera` as a default scope; the repository already provides that context. Do not use vague scopes such as `suite`, `skills`, `capability`, `progress`, `plan`, `todo`, `docs`, or `changelog` unless they are added to the vocabulary below with a precise definition. Do not use comma scopes such as `hooks,scripts`; choose the dominant subsystem or omit the scope.

Use the scope for the primary behavior changed, not every file touched.

| Scope         | Use for                                                                                |
| ------------- | -------------------------------------------------------------------------------------- |
| `mobile`      | `packages/mobile`, mobile app UI, Cursor SDK integration, mobile deploy                |
| `web`         | `packages/web`, Astro/Starlight site, marketing pages, published docs                |
| `cli`         | `packages/cli`, command behavior, CLI output, command tests                            |
| `hooks`       | `hooks/*`, artifact validation hooks, session hooks, compaction hooks                  |
| `schemas`     | `protocol.yaml`, `capability_schema_contract.yaml`, artifact schemas, schema contracts |
| `eval`        | Semantic eval runner, fixtures, evaluation harnesses                                   |
| `install`     | App home, upgrade, app refresh, setup, doctor install behavior                         |
| `package`     | `registry.json`, plugin manifests, lockfiles, version-bearing package surfaces         |
| `runtime`     | Cross-runtime behavior or shared adapter contracts                                     |
| `opencode`    | OpenCode-specific runtime behavior or packaging                                        |
| `claude`      | Claude-specific runtime behavior or packaging                                          |
| `codex`       | Codex-specific runtime behavior or packaging                                           |
| `copilot`     | Copilot-specific runtime behavior or packaging                                         |
| `cursor`      | Cursor IDE and cursor-agent CLI runtime behavior, hooks, agents, and packaging           |
| `release`     | Version bumps, changelog promotion, release readiness, tag/publication prep            |
| `agents`      | `AGENTS.md` or runtime-neutral agent operating guidance                                |
| `status`      | Status capability behavior, prose, schemas, or tests                                     |
| `vision`      | Vision capability behavior, prose, schemas, or tests                                    |
| `discuss`     | Discuss capability behavior, prose, schemas, or tests                                  |
| `research`    | Research capability behavior, prose, schemas, or tests                                  |
| `plan`        | Plan capability behavior, prose, schemas, or tests                                      |
| `build`       | Build capability behavior, prose, schemas, or tests                                     |
| `optimize`    | Optimize capability behavior, prose, schemas, or tests                                 |
| `audit`       | Audit capability behavior, prose, schemas, or tests                                    |
| `document`    | Document capability behavior, prose, schemas, or tests                                  |
| `profile`     | Profile capability behavior, prose, schemas, or tests                                  |
| `design`      | Design capability behavior, prose, schemas, or tests                                   |
| `orchestrate` | Orchestrate capability behavior, prose, schemas, or tests                              |

New scopes are closed by default. If a commit needs a new scope, update this table with a one-line definition in the same commit; otherwise omit the scope.

## Helper script classification

`npx -y agentera ...` is the canonical documented entry point for normal
users and agents. Direct helper scripts remain in the repository, classified by
purpose rather than promoted as the default workflow:

| Class | Rule |
| --- | --- |
| User-facing workflow | Document and test the `agentera` namespace first. |
| Backward-compatible maintainer seam | Keep direct helper execution working when existing tests or maintainer scripts rely on it, but point new user docs at `agentera`. |
| Internal support module | Import from the canonical CLI or tests; do not document as a standalone user command. |
| Corpus generation | Keep extraction internal behind explicit stats refresh consent. |
| Maintainer-only generator or analysis surface | Document as local-only and explicit, with privacy/scope caveats. |

When adding a new helper, either expose a stable `agentera` namespace for normal
use or document why the helper is internal/maintainer-only. Do not add broad new
top-level CLI commands for implementation details.

## Package DX

### Web (`@agentera/web`)

The website lives in `packages/web` (Astro + Starlight on Cloudflare). Use [Vite+](https://viteplus.dev/) (`vp`) as the single entrypoint for Node tooling — avoid direct `pnpm` calls unless required.

Install git hooks once after clone:

```bash
lefthook install
```

Pre-commit on `feat/v3` runs staged-aware CLI tests via `scripts/precommit-vitest.sh`
(full `pnpm -C packages/cli test` only when broad CLI, schema, or workflow paths change).
On `main`, `scripts/precommit-pytest.sh` runs targeted pytest plus a small smoke set
instead of the full parallel suite for narrow edits. GitHub Actions still runs the
full vitest and pytest suites.

Use `LEFTHOOK=0 git commit` only for emergency bypass when the hook config itself is
broken or a failure is already tracked for CI — not for routine TODO.md or fixture edits.

Pre-commit also runs `vp staged` in `packages/web` when web files change; markdownlint
and prettier for repo-wide docs/configs stay on `bunx`.

### Mobile (`@agentera/mobile`)

The mobile app lives in `packages/mobile` (SvelteKit + Cursor SDK + Cloudflare Worker). Same `vp` entrypoint as web.

```bash
vp run mobile:check
vp run mobile:dev
vp run mobile:build
vp run mobile:deploy
```

Pre-commit runs `vp staged` in `packages/mobile` when mobile files change (mirrors web).

Mobile is opinionated: no skill loading, MCP servers, or plugin extensions. Custom sidebar actions are app-defined shortcuts, not arbitrary extension surfaces.

Convenience scripts from the repo root:

```bash
vp run web:check    # format, lint, and type-check the website
vp run web:build
vp run web:dev
vp run web:deploy
vp run mobile:check # format, lint, and type-check the mobile app
vp run mobile:build
vp run mobile:dev
vp run mobile:deploy
```

Or call package scripts directly:

```bash
vp run @agentera/web#check    # run a package.json script across the workspace
vp dev packages/web             # start Astro dev server in that package directory
```

Use `vp run @agentera/web#<script>` to run workspace package scripts;
use `vp dev packages/web` when you want the dev server pointed at that folder.

## Running tests

The CLI test suite is vitest. lefthook pre-commit runs it when staged files touch
`packages/cli/**`, the `skills/`/`references/` data, `registry.json`/`protocol.yaml`,
or workflow paths — not for web-only changes under `packages/web/**`.

```bash
pnpm -C packages/cli test
```

**Test layers:** Vitest proves hook and CLI **logic** from temp dirs and pinned fixtures
under `packages/cli/test/fixtures/` — not from whatever is in this checkout's live
`.agentera/` or `TODO.md`. Committed artifact **budgets** (`uniform_10_40_50`) are enforced
by `agentera check compact` in CI and lefthook, not by vitest reading the working tree.
See [`packages/cli/test/README.md`](./packages/cli/test/README.md) for the REPO_ROOT coupling
inventory and migration targets (tasks 2–5 of the active decouple plan).

Type-check and build:

```bash
pnpm -C packages/cli run typecheck
pnpm -C packages/cli build
```

The repository content gate (artifact compaction budgets) runs the built CLI:

```bash
pnpm -C packages/cli build && node packages/cli/dist/bin/agentera.js check compact
```

When vitest passes but `check compact` fails, fix committed artifacts or run compaction —
do not treat compact failures as missing unit tests.

## Agentera commits

Commit messages are concise, imperative descriptions of the product or project
change (`fix(cli): …`, `feat(mobile): …`). Commit identity must come from the
substantive engineering outcome, not from Agentera bookkeeping.

### Same-commit fold-in (default)

When a task touches code, tests, or user-facing docs, fold related artifact updates
into **that same commit**:

- `.agentera/plan.yaml` (task status, plan closeout, archive handoff)
- `.agentera/progress.yaml` (cycle evidence for the work)
- `TODO.md` (open items closed or filed)
- `.agentera/health.yaml` (audit capability output)
- `.agentera/decisions.yaml` (discuss satisfaction updates)

Do not leave a task "done" with artifact state committed in a follow-up chore
commit. If you already pushed the implementation commit, fold artifact updates into
the next substantive commit on the same task — not a hash-backfill pass.

### Standalone commits (narrow exceptions)

Only these may land without paired product code in the same commit:

- **Release cuts** — version bumps, changelog promotion, npm publish metadata
- **npm publish / registry alignment** when no code change accompanies the tag

Everything else — including plan archive, TODO Resolved moves, progress cycles,
health audits, and decision closeout — rides the implementation commit.

### Bookkeeping patterns to eliminate

Git history on `feat/v3` showed recurring standalone commits from these triggers.
**Do not create commits for:**

| Trigger | Retired pattern | Use instead |
| ------- | ----------------- | ------------- |
| TODO Resolved hash backfill | `chore: record … in TODO` with only `@ <hash>` | `resolved YYYY-MM-DD` or `resolved @ <semver>` in the implementation commit |
| Dual-branch hash ledger | `resolved on feat/v3 @ X and main @ Y` in a second pass | Date or release version; `git log --grep` for archaeology |
| Progress cycle hash backfill | `chore(progress): backfill cycle N commit hash` | No per-cycle commit field (Decision 66); evidence in the task commit message |
| Plan-only closeout | `chore(plan): close out …` with only archive + cleared slot | Archive + clear `.agentera/plan.yaml` in the final task commit |
| Author-rewrite / ledger hygiene | `docs: refresh commit hashes after …` | Avoid hash-dependent Resolved lines so rewrites do not orphan ledgers |

### Commit sequencing

When a task naturally splits refactor and behavior:

1. **Refactor commit first** — behavior-preserving extraction, rename, or move; tree
   green.
2. **Behavior commit second** — minimal diff for the fix or feature; tests in the
   same commit as the behavior unless the plan explicitly splits them.

If the user asked for one squashed delivery, a single commit is fine. Do not bundle
a behavior-preserving refactor into a behavior commit because it was discovered
mid-change — stage hunks or split commits instead.

### Code comments vs commit messages

Comments explain **why the code is shaped as it is** for a reader who has never seen
prior versions. Do not narrate development history, rejected alternatives, or
"cleaner than the previous approach" in source. That story belongs in the commit
message.

### Capability closeout fold-in

Capability runs that update artifacts must commit those writes with the
implementation, not in a follow-up chore commit:

| Capability | Artifact | Fold into |
| ---------- | -------- | --------- |
| audit | `.agentera/health.yaml` | Same commit as audit fixes or findings addressed |
| discuss | `.agentera/decisions.yaml` | Same commit as deliberation outcome or confirmation |
| plan / orchestrate / build | `.agentera/plan.yaml` (+ archive on complete) | Final task commit: mark tasks complete, archive plan, clear active slot |

## Cursor Cloud specific instructions

### Environment prerequisites

- Node.js 22+ with pnpm 10.30.3 (enable via `corepack enable`) for the CLI
  (`packages/cli`) and the website (`packages/web`); `vp` (Vite+) for the website.
- The `.opencode/` directory needs a standalone `npm install` (not managed by the
  pnpm workspace) to provide `@opencode-ai/plugin` types used by some tests.

### Running services

| Service | Command | Notes |
|---------|---------|-------|
| CLI tests | `pnpm -C packages/cli test` | vitest suite |
| CLI build | `pnpm -C packages/cli build` | tsc → `dist` |
| CLI validation | `node packages/cli/dist/bin/agentera.js check validate capability-contract --format json` | Validates all capability schemas |
| Web dev server | `cd packages/web && npx astro dev` | Use `astro dev` directly rather than `vp dev` for SSR with Cloudflare adapter |
| Web build | `vp run web:build` | Runs from workspace root |
| Mobile dev server | `vp run mobile:dev` | SvelteKit dev server via packages/mobile |
| Mobile check | `vp run mobile:check` | Lint, format, type-check mobile package |

### Gotchas

- `vp dev packages/web` starts Vite in client-only mode and returns 404 for SSR routes. Use `cd packages/web && npx astro dev` for full SSR dev experience.
- The published `agentera` npm package is self-contained: it bundles the app data
  (`skills/`, `references/`, `registry.json`) under `packages/cli/bundle/` at pack
  time, so `npx -y agentera` works with no repo checkout and no `AGENTERA_HOME`.
