# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## What this is

agentera v2: one bundled skill (`skills/agentera/`) with twelve capabilities. Each capability is defined by human-readable prose (`prose.md`) and machine-readable schemas (`triggers.yaml`, `artifacts.yaml`, `validation.yaml`, `exit.yaml`). The agent reads `SKILL.md` to route incoming requests to the right capability.

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

Validate any capability against the schema contract. `capability_schema_contract.yaml`
owns capability schema structure; `scripts/capability_contract.py` loads the
model consumed by `scripts/validate_capability.py`. Do not duplicate
contract-owned groups, priority values, directory rules, or primitive-reference
field mappings in tests or docs unless a validation check ties them back to the
loader/model.

```bash
uv run scripts/validate_capability.py skills/agentera/capabilities/<name>
```

Self-validate the contract:

```bash
uv run scripts/validate_capability.py --self-validate
```

## Adding or modifying a capability

1. Create `skills/agentera/capabilities/<name>/prose.md` with behavioral instructions
2. Create `skills/agentera/capabilities/<name>/schemas/` with the four schema files: `triggers.yaml`, `artifacts.yaml`, `validation.yaml`, `exit.yaml`
3. Update the capability table in `skills/agentera/SKILL.md`
4. Validate: `uv run scripts/validate_capability.py skills/agentera/capabilities/<name>`

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
- Conventional commits: feat/fix/docs/refactor/chore/test
- Visual identity: glyphs and semantic tokens defined in `protocol.yaml`
- Versioning convention in canonical `DOCS.md` (mapped here to `.agentera/docs.yaml`): `version_files` lists what to bump, `semver_policy` maps commit types to bump levels
