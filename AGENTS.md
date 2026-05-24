# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## What this is

agentera v2: one Agentera skill (`skills/agentera/`) with twelve capabilities. Each capability is defined by human-readable prose (`instructions.md`) and machine-readable schemas (`triggers.yaml`, `artifacts.yaml`, `validation.yaml`, `exit.yaml`). The Agentera router routes incoming requests to the right capability.

## Capability validation

Validate any capability through the canonical `agentera validate` namespace.
`capability_schema_contract.yaml` owns capability schema structure;
`scripts/capability_contract.py` loads the model consumed by the validator. Do not
duplicate contract-owned groups, priority values, directory rules, or
primitive-reference field mappings in tests or docs unless a validation check ties
them back to the loader/model.

```bash
uv run scripts/agentera validate capability <name-or-path>
```

Self-validate the contract:

```bash
uv run scripts/agentera validate capability-contract --format json
```

## Adding or modifying a capability

1. Create `skills/agentera/capabilities/<name>/instructions.md` with behavioral instructions
2. Create `skills/agentera/capabilities/<name>/schemas/` with the four schema files: `triggers.yaml`, `artifacts.yaml`, `validation.yaml`, `exit.yaml`
3. Update the capability table in `skills/agentera/SKILL.md`
4. Validate: `uv run scripts/agentera validate capability <name-or-path>`

## Artifact path resolution

Prefer the CLI for state access before raw artifact reads:

```bash
uv run scripts/agentera hej
uv run scripts/agentera todo
uv run scripts/agentera docs
uv run scripts/agentera query --list-artifacts
```

Canonical artifact names such as `DOCS.md` may map to YAML paths such as `.agentera/docs.yaml`; use the mapping or CLI result as the source of truth.

Query and validate artifacts via the CLI:

```bash
uv run scripts/agentera query --list-artifacts
uv run scripts/agentera query decisions --topic <topic>
```

## Key conventions

- The Agentera routing entry point at `skills/agentera/SKILL.md` is the single entry point; capabilities live under `capabilities/`
- Shared primitives are defined in `protocol.yaml`, not per-skill specs
- Skills never push to remote repos or modify `.agentera/vision.yaml` or objective state during execution cycles
- Conventional commits: feat/fix/docs/refactor/chore/test; scopes follow the closed vocabulary below
- Visual identity: glyphs and semantic tokens defined in `protocol.yaml`
- Versioning convention in canonical `DOCS.md` (mapped here to `.agentera/docs.yaml`): `version_files` lists what to bump, `semver_policy` maps commit types to bump levels

## Commit message scopes

Scopes are optional. Omit the scope for broad suite-wide changes instead of using a generic scope.

Do not use `agentera` as a default scope; the repository already provides that context. Do not use vague scopes such as `suite`, `skills`, `capability`, `progress`, `plan`, `todo`, `docs`, or `changelog` unless they are added to the vocabulary below with a precise definition. Do not use comma scopes such as `hooks,scripts`; choose the dominant subsystem or omit the scope.

Use the scope for the primary behavior changed, not every file touched.

| Scope         | Use for                                                                                |
| ------------- | -------------------------------------------------------------------------------------- |
| `cli`         | `scripts/agentera`, command behavior, CLI output, command tests                        |
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

`uv run scripts/agentera ...` is the canonical documented entry point for normal
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

Use the same command as lefthook pre-commit (`.lefthook.yml`). Do not run bare
`uv run pytest` from the repo root.

Pytest runs on pre-commit only when staged files match Python, YAML, workflow, or
lockfile paths — not for web-only changes under `packages/web/**`.

```bash
uv run --with pytest --with pyyaml --with pytest-xdist pytest tests/ -q -n auto
```

Pitfalls:

- **`uv run pytest` without `tests/`** discovers ~49k parametrized cases outside the intended suite and can run for many minutes or appear hung. Always pass `tests/`.
- **Piping pytest through `tail`** buffers all output until the run finishes, which looks like a stall even when tests are progressing.
- **`uv run pytest tests/` without `-n auto`** still passes (~1200 tests) but takes ~3 minutes instead of ~1 minute with xdist.

## Agentera commits

- Commit messages should be concise, imperative descriptions of the actual product or project change, for example `add config file contract` or `fix: remove tui phase ownership`, depending on the active projects' conventions.
- Commit identity must come from the substantive engineering outcome, not from Agentera bookkeeping.
- Do not create standalone commits whose only changes are Agentera status, progress evidence, plan archival/removal, or ROADMAP closeout/status updates. Fold those changes into the related implementation, test, validation, or documentation commit.
- Include `.agentera/plan.yaml` and `.agentera/progress.yaml` updates in the same commit as the related implementation or validation change.
- If progress metadata is committed during implementation, squash or fold it into the meaningful task commit before considering the task complete.
- The final commit for a task should include the corresponding status-complete metadata update when Agentera artifacts are part of the task.
