# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## What this is

agentera v2: one bundled skill (`skills/agentera/`) with twelve capabilities. Each capability is defined by human-readable prose (`prose.md`) and machine-readable schemas (`triggers.yaml`, `artifacts.yaml`, `validation.yaml`, `exit.yaml`). The agent reads `SKILL.md` to route incoming requests to the right capability.

## Repository layout

```
skills/agentera/
  SKILL.md                          # Master dispatcher (frontmatter + routing + safety rails)
  protocol.yaml                     # Shared primitives (confidence, severity, phases, glyphs)
  capability_schema_contract.yaml   # Self-referential schema contract
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
  validate_capability.py            # Validate a capability against the schema contract
  validate_spec.py                  # Legacy v1 linter (still present)
  eval_skills.py                    # Tier 2 eval runner (smoke-tests via claude -p)
  semantic_eval.py                  # Offline semantic eval for captured fixtures
  generate_contracts.py             # Contract generation and freshness checks
  usage_stats.py                    # Usage report from profilera corpus
hooks/
  hooks.json                        # Hook registry
  validate_artifact.py              # PostToolUse artifact validation
  common.py                         # Shared artifact path resolution
tests/                              # pytest suite
.lefthook.yml                       # Pre-commit and pre-push hooks
```

## Capability validation

Validate any capability against the schema contract:

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

Before reading or writing any artifact, check if `.agentera/DOCS.md` exists with an Artifact Mapping section. If absent, use the default layout: VISION.md, TODO.md, and CHANGELOG.md at the project root; all other artifacts in `.agentera/`.

## Key conventions

- `skills/agentera/SKILL.md` is the single entry point; capabilities live under `capabilities/`
- Shared primitives are defined in `protocol.yaml`, not per-skill specs
- Skills never push to remote repos or modify VISION.md/OBJECTIVE.md during execution cycles
- Conventional commits: feat/fix/docs/refactor/chore/test
- Visual identity: glyphs and semantic tokens defined in `protocol.yaml`
- Versioning convention in DOCS.md: `version_files` lists what to bump, `semver_policy` maps commit types to bump levels
