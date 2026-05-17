# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## What this is

agentera v2: one Agentera skill (`skills/agentera/`) with twelve capabilities. Each capability is defined by human-readable prose (`prose.md`) and machine-readable schemas (`triggers.yaml`, `artifacts.yaml`, `validation.yaml`, `exit.yaml`). The agent reads `SKILL.md` to route incoming requests to the right capability.

## Repository layout

```
skills/agentera/
  SKILL.md                          # Master dispatcher (frontmatter + routing + safety rails)
  protocol.yaml                     # Shared primitives (confidence, severity, phases, glyphs)
  capability_schema_contract.yaml   # Capability schema structure contract
  capabilities/
    <name>/
      prose.md                      # Behavioral instructions for the capability
      schemas/
        triggers.yaml               # Trigger patterns and routing rules
        artifacts.yaml              # Artifact references and path contracts
        validation.yaml             # Structural validation rules
        exit.yaml                   # Exit signals and codes
  references/                       # Supplementary docs and templates
  schemas/                          # Skill-level schemas
scripts/
  agentera                          # CLI for project state, artifact queries, upgrade, and diagnostics
  capability_contract.py            # Load the capability schema contract model
  validate_capability.py            # Validate a capability through the contract model
  eval_skills.py                    # Tier 2 eval runner (smoke-tests via claude -p)
  semantic_eval.py                  # Offline semantic eval for captured fixtures
  usage_stats.py                    # Suite usage analytics from the session corpus
  smoke_* / setup_*                 # Runtime smoke checks and setup helpers
hooks/
  hooks.json / codex-hooks.json     # Hook registries
  validate_artifact.py              # PostToolUse artifact validation
  session_start.py / session_stop.py # Session artifact handling
  compaction.py                     # Artifact compaction helpers
  common.py                         # Shared artifact path resolution
tests/                              # pytest suite
.lefthook.yml                       # Pre-commit and pre-push hooks
```

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

1. Create `skills/agentera/capabilities/<name>/prose.md` with behavioral instructions
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

Before reading or writing any artifact directly, check if `.agentera/docs.yaml` exists with an Artifact Mapping section. If absent, use the default layout:

- Human-facing artifacts at project root: `TODO.md`, `CHANGELOG.md`, `DESIGN.md`
- Agent-facing artifacts in `.agentera/`: `progress.yaml`, `decisions.yaml`, `health.yaml`, `plan.yaml`, `docs.yaml`, `vision.yaml`, `session.yaml`
- Optimera objective state under `.agentera/optimera/<objective-name>/`: `objective.yaml`, `experiments.yaml`

Canonical artifact names such as `DOCS.md` may map to YAML paths such as `.agentera/docs.yaml`; use the mapping or CLI result as the source of truth.

Query and validate artifacts via the CLI:

```bash
uv run scripts/agentera query --list-artifacts
uv run scripts/agentera query decisions --topic <topic>
```

## Key conventions

- `skills/agentera/SKILL.md` is the single entry point; capabilities live under `capabilities/`
- Shared primitives are defined in `protocol.yaml`, not per-skill specs
- Skills never push to remote repos or modify `.agentera/vision.yaml` or objective state during execution cycles
- Conventional commits: feat/fix/docs/refactor/chore/test; scopes follow the closed vocabulary below
- Visual identity: glyphs and semantic tokens defined in `protocol.yaml`
- Versioning convention in canonical `DOCS.md` (mapped here to `.agentera/docs.yaml`): `version_files` lists what to bump, `semver_policy` maps commit types to bump levels

## Commit message scopes

Scopes are optional. Omit the scope for broad suite-wide changes instead of using a generic scope.

Do not use `agentera` as a default scope; the repository already provides that context. Do not use vague scopes such as `suite`, `skills`, `capability`, `progress`, `plan`, `todo`, `docs`, or `changelog` unless they are added to the vocabulary below with a precise definition. Do not use comma scopes such as `hooks,scripts`; choose the dominant subsystem or omit the scope.

Use the scope for the primary behavior changed, not every file touched.

| Scope | Use for |
|-------|---------|
| `cli` | `scripts/agentera`, command behavior, CLI output, command tests |
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
| `release` | Version bumps, changelog promotion, release readiness, tag/publication prep |
| `agents` | `AGENTS.md` or runtime-neutral agent operating guidance |
| `hej` | Hej capability behavior, prose, schemas, or tests |
| `visionera` | Visionera capability behavior, prose, schemas, or tests |
| `resonera` | Resonera capability behavior, prose, schemas, or tests |
| `inspirera` | Inspirera capability behavior, prose, schemas, or tests |
| `planera` | Planera capability behavior, prose, schemas, or tests |
| `realisera` | Realisera capability behavior, prose, schemas, or tests |
| `optimera` | Optimera capability behavior, prose, schemas, or tests |
| `inspektera` | Inspektera capability behavior, prose, schemas, or tests |
| `dokumentera` | Dokumentera capability behavior, prose, schemas, or tests |
| `profilera` | Profilera capability behavior, prose, schemas, or tests |
| `visualisera` | Visualisera capability behavior, prose, schemas, or tests |
| `orkestrera` | Orkestrera capability behavior, prose, schemas, or tests |

New scopes are closed by default. If a commit needs a new scope, update this table with a one-line definition in the same commit; otherwise omit the scope.

## Helper script classification

`uv run scripts/agentera ...` is the canonical documented entry point for normal
users and agents. Direct helper scripts remain in the repository, classified by
purpose rather than promoted as the default workflow:

| Class | Rule | Examples |
|-------|------|---------|
| User-facing workflow | Document and test the `agentera` namespace first. | `agentera validate ...`, `agentera verify ...`, `agentera stats ...`, `agentera lint ...`, `agentera compact ...`, `agentera doctor`, `agentera upgrade` |
| Backward-compatible maintainer seam | Keep direct helper execution working when existing tests or maintainer scripts rely on it, but point new user docs at `agentera`. | `scripts/validate_capability.py`, `scripts/validate_cross_capability.py`, `scripts/validate_lifecycle_adapters.py`, `scripts/usage_stats.py`, `scripts/self_audit.py`, smoke/eval helpers |
| Internal support module | Import from the canonical CLI or tests; do not document as a standalone user command. | `scripts/artifact_registry.py`, `scripts/capability_contract.py`, `scripts/package_registry.py`, `scripts/runtime_adapter_registry.py`, `scripts/install_root.py` |
| Corpus generation | Keep extraction internal behind explicit stats refresh consent. | `agentera stats refresh --dry-run`, then `agentera stats refresh --consent local-history`; no top-level `agentera corpus` command |
| Maintainer-only generator or analysis surface | Document as local-only and explicit, with privacy/scope caveats. | `scripts/generate_js_install_root_contract.py`, `scripts/startup_analysis_contract.py`, token/benchmark analyzers |

When adding a new helper, either expose a stable `agentera` namespace for normal
use or document why the helper is internal/maintainer-only. Do not add broad new
top-level CLI commands for implementation details.

## Install root documentation

The install root contract is owned by `scripts/install_root.py`. All
documentation that describes `AGENTERA_HOME`, the normal platform Agentera
directory, app files, the upgrade lifecycle, repair diagnostics, directory
selection, or no-write fallback behavior must point to `scripts/install_root.py`
as the authoritative implementation.

Contract terms that must appear in install-root documentation:

- `AGENTERA_HOME`: environment variable pointing to the Agentera directory
- `normal Agentera directory`: the platform-appropriate data directory
- `app files`: managed Agentera code under `$AGENTERA_HOME/app`
- `directory with unknown files`: a directory that exists but does not look like
  Agentera state; doctor reports it instead of guessing
- `needs repair`: diagnostic when app files are missing or stale
