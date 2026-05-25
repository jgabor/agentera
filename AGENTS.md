# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## What this is

agentera v2: one Agentera skill (`skills/agentera/`) with twelve capabilities. Each capability is defined by human-readable prose (`instructions.md`) and machine-readable schemas (`triggers.yaml`, `artifacts.yaml`, `validation.yaml`, `exit.yaml`). The Agentera router routes incoming requests to the right capability.

## Capability validation

Validate any capability through the canonical `agentera check validate` namespace.
Top-level `agentera validate` remains a migration alias during the namespace rollout.
`capability_schema_contract.yaml` owns capability schema structure;
`scripts/capability_contract.py` loads the model consumed by the validator. Do not
duplicate contract-owned groups, priority values, directory rules, or
primitive-reference field mappings in tests or docs unless a validation check ties
them back to the loader/model.

```bash
uv run scripts/agentera check validate capability <name-or-path>
```

Self-validate the contract:

```bash
uv run scripts/agentera check validate capability-contract --format json
```

## Adding or modifying a capability

1. Create `skills/agentera/capabilities/<name>/instructions.md` with behavioral instructions
2. Create `skills/agentera/capabilities/<name>/schemas/` with the four schema files: `triggers.yaml`, `artifacts.yaml`, `validation.yaml`, `exit.yaml`
3. Update the capability table in `skills/agentera/SKILL.md`
4. Validate: `uv run scripts/agentera check validate capability <name-or-path>`

## Artifact path resolution

Prefer the CLI for state access before raw artifact reads:

```bash
uv run scripts/agentera prime
uv run scripts/agentera state todo
uv run scripts/agentera state docs
uv run scripts/agentera state query --list-artifacts
```

Top-level aliases such as `hej`, `todo`, and `docs` remain during migration with stderr deprecation.

Canonical artifact names such as `DOCS.md` may map to YAML paths such as `.agentera/docs.yaml`; use the mapping or CLI result as the source of truth.

Query and validate artifacts via the CLI:

```bash
uv run scripts/agentera state query --list-artifacts
uv run scripts/agentera state query decisions --topic <topic>
uv run scripts/agentera check validate capability <name-or-path>
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

Use the same command as lefthook pre-commit (`.lefthook.yml`). Pre-commit always
runs the **full** suite with no marker filter.

Pytest runs on pre-commit only when staged files match Python, YAML, workflow, or
lockfile paths — not for web-only changes under `packages/web/**`.

```bash
uv run --with pytest --with pyyaml --with pytest-xdist pytest tests/ -q -n auto
```

For faster local iteration, skip slow whole-repo or full-surface tests:

```bash
uv run --with pytest --with pyyaml --with pytest-xdist pytest tests/ -q -n auto -m "not slow"
```

Do not change lefthook to use `-m "not slow"`; hooks must keep full regression coverage.

Python coverage (includes extensionless `scripts/agentera`):

```bash
uv run --with pytest --with pyyaml --with pytest-xdist --with pytest-cov \
  pytest tests/ -q -n auto \
  --cov=scripts --cov=hooks --cov=src \
  --cov-report=term-missing:skip-covered
```

Import-based unit tests attribute coverage in-process; subprocess CLI tests still
under-count unless you add targeted import coverage for those modules.

Pitfalls:

- **`uv run pytest` without `tests/`** used to discover ~50k cases via the
  `plugins/agentera -> ..` symlink loop. `pyproject.toml` now sets `testpaths =
  ["tests"]`, but always pass `tests/` in docs and CI for clarity.
- **Piping pytest through `tail`** buffers all output until the run finishes, which looks like a stall even when tests are progressing.
- **`uv run pytest tests/` without `-n auto`** still passes (~1200 tests) but takes ~3 minutes instead of ~1 minute with xdist.

## Agentera commits

- Commit messages should be concise, imperative descriptions of the actual product or project change, for example `add config file contract` or `fix: remove tui phase ownership`, depending on the active projects' conventions.
- Commit identity must come from the substantive engineering outcome, not from Agentera bookkeeping.
- Do not create standalone commits whose only changes are Agentera status, progress evidence, plan archival/removal, or ROADMAP closeout/status updates. Fold those changes into the related implementation, test, validation, or documentation commit.
- Include `.agentera/plan.yaml` and `.agentera/progress.yaml` updates in the same commit as the related implementation or validation change.
- If progress metadata is committed during implementation, squash or fold it into the meaningful task commit before considering the task complete.
- The final commit for a task should include the corresponding status-complete metadata update when Agentera artifacts are part of the task.

### Progress `commit` field

In `.agentera/progress.yaml`, `cycles[].commit` names **the git commit that contains the
product change** for that cycle—not the commit that last edited progress metadata.

- `commit: pending` is valid until that hash is known (common in the implementation commit).
- After the product commit exists, set `commit` to that hash (optional subject suffix). Use one
  forward commit if needed; never amend solely to backfill this field.
- Use `N/A: …` only when no product commit was made for the cycle.
