# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## What this is

agentera v2: one Agentera skill (`skills/agentera/`) with twelve capabilities. Each capability is defined by human-readable prose (`instructions.md`) and machine-readable schemas (`triggers.yaml`, `artifacts.yaml`, `validation.yaml`, `exit.yaml`). The Agentera router routes incoming requests to the right capability.

## Branch model

- `main` is the v2.x stable branch. The Python CLI ships from here as `npx -y agentera@latest`. Feature-frozen for the v3 cutover, but bug-fix-allowed for velocity blockers (the linter, the commit-tracking flow, the artifact validation hooks).
- `feat/v3` is the v3.0.0 dev branch. The TypeScript CLI ships from here as `npx -y agentera@next`. Active development; the bulk of `feat:` and `test:` work lands here.
- `TODO.md` lives on `feat/v3`. Items prefixed `→ main` require `git checkout main`, implement, push (CI cuts a new release), then `git checkout feat/v3` to mark the item resolved in TODO.md and continue. Items prefixed `→ v3` stay on this branch. Items prefixed `→ both` span main and feat/v3 — prose on both, code on whichever branch owns the surface.

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

1. Create `skills/agentera/capabilities/<name>/instructions.md` with behavioral instructions
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

Top-level aliases such as `hej`, `todo`, and `docs` remain during migration with stderr deprecation.

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

`CHANGELOG.md` is the human-facing release history. Realisera maintains it at release time; fold changelog updates into the release commit rather than standalone bookkeeping commits.

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
- Fixed `agentera health` and hej to select the latest health audit by highest audit number and read schema `date` instead of a missing `timestamp` field.
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
| `hej`         | Hej capability behavior, prose, schemas, or tests                                      |
| `visionera`   | Visionera capability behavior, prose, schemas, or tests                                |
| `resonera`    | Resonera capability behavior, prose, schemas, or tests                                 |
| `inspirera`   | Inspirera capability behavior, prose, schemas, or tests                                |
| `planera`     | Planera capability behavior, prose, schemas, or tests                                  |
| `realisera`   | Realisera capability behavior, prose, schemas, or tests                                |
| `optimera`    | Optimera capability behavior, prose, schemas, or tests                                 |
| `inspektera`  | Inspektera capability behavior, prose, schemas, or tests                               |
| `dokumentera` | Dokumentera capability behavior, prose, schemas, or tests                              |
| `profilera`   | Profilera capability behavior, prose, schemas, or tests                                |
| `visualisera` | Visualisera capability behavior, prose, schemas, or tests                              |
| `orkestrera`  | Orkestrera capability behavior, prose, schemas, or tests                               |

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

## Web DX

The website lives in `packages/web` (Astro + Starlight on Cloudflare). Use [Vite+](https://viteplus.dev/) (`vp`) as the single entrypoint for Node tooling — avoid
direct `pnpm` calls unless required.

Install git hooks once after clone:

```bash
lefthook install
```

Pre-commit on `main` runs staged-aware pytest via `scripts/precommit-pytest.sh`
(smoke plus touched test modules; full `pytest tests/ -n auto` only for workflow,
`pyproject.toml`, or `uv.lock` changes). GitHub Actions still runs the full suite.
Use `LEFTHOOK=0 git commit` only for emergency bypass when the hook itself is broken.

Pre-commit runs `vp staged` in `packages/web` when web files change; markdownlint
and prettier for repo-wide docs/configs stay on `bunx`.

Convenience scripts from the repo root:

```bash
vp run web:check    # format, lint, and type-check the website
vp run web:build
vp run web:dev
vp run web:deploy
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

Type-check and build:

```bash
pnpm -C packages/cli run typecheck
pnpm -C packages/cli build
```

The repository content gate (artifact compaction budgets) runs the built CLI:

```bash
pnpm -C packages/cli build && node packages/cli/dist/bin/agentera.js check compact
```

## Agentera commits

- Commit messages should be concise, imperative descriptions of the actual product or project change, for example `add config file contract` or `fix: remove tui phase ownership`, depending on the active projects' conventions.
- Commit identity must come from the substantive engineering outcome, not from Agentera bookkeeping.
- Do not create standalone commits whose only changes are Agentera status, progress evidence, plan archival/removal, or ROADMAP closeout/status updates. Fold those changes into the related implementation, test, validation, or documentation commit.
- Include `.agentera/plan.yaml` and `.agentera/progress.yaml` updates in the same commit as the related implementation or validation change.
- If progress metadata is committed during implementation, squash or fold it into the meaningful task commit before considering the task complete.
- The final commit for a task should include the corresponding status-complete metadata update when Agentera artifacts are part of the task.

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

### Gotchas

- **Worktrunk `wt merge` and `core.bare`:** A successful `wt merge --remove` can rarely leave the primary checkout with `core.bare = true` in `.git/config` (git then fails with `fatal: this operation must be run in a work tree`). This correlates with a `Branch-worktree mismatch` warning (`expected @ …/.git.<branch>` vs sibling `../<repo>.<branch>`). After any `wt merge` that removes a worktree, confirm `git config --bool core.bare` is `false`. Recovery: `git config core.bare false`. Lefthook `post-merge` runs `hooks/post-merge-check-bare.sh` to auto-repair.
- `vp dev packages/web` starts Vite in client-only mode and returns 404 for SSR routes. Use `cd packages/web && npx astro dev` for full SSR dev experience.
- The published `agentera` npm package is self-contained: it bundles the app data
  (`skills/`, `references/`, `registry.json`) under `packages/cli/bundle/` at pack
  time, so `npx -y agentera` works with no repo checkout and no `AGENTERA_HOME`.
