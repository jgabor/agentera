# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Claude Code skill marketplace. Ten skills — each a self-contained `SKILL.md` with optional `references/` and `scripts/` — that give Claude specialized autonomous behaviors. See the README for the full skill table and ecosystem diagram.

## Repository layout

```
skills/<name>/SKILL.md          # Frontmatter + full workflow (the skill itself)
skills/<name>/references/       # Supplementary docs, templates, schemas
skills/<name>/scripts/          # Python helpers (stdlib only, no pip deps)
references/ecosystem-spec.md    # Shared primitives spec (all skills must align)
scripts/validate-ecosystem.py   # Ecosystem linter (pre-commit hook)
.githooks/pre-commit            # Git hook running the linter
registry.json                   # Skill index with versions and tags
.claude-plugin/marketplace.json # Plugin marketplace manifest
```

## Skill ecosystem

The ten skills form a connected graph — not isolated tools. See the README for the full ecosystem diagram and state artifact reference table. All skills work standalone AND mesh when co-installed. Each skill generates state artifacts (DECISIONS.md, PLAN.md, VISION.md, PROGRESS.md, ISSUES.md, HEALTH.md, OBJECTIVE.md, EXPERIMENTS.md, DOCS.md, PROFILE.md, DESIGN.md) in the *target project*, not in this repo. All consuming skills check DOCS.md for artifact paths before reading or writing, falling back to project root when DOCS.md is absent.

## Adding or modifying a skill

1. Create `skills/<name>/SKILL.md` with frontmatter (name, description, trigger patterns) and step-by-step workflow instructions
2. Add entry to `registry.json` (name, description, path, tags, added date)
3. Update the table in `README.md`
4. If the skill has a marketplace plugin: add/update `skills/<name>/.claude-plugin/plugin.json`

Version bumps: update both `registry.json` and any `plugin.json` for the skill. The marketplace manifest (`.claude-plugin/marketplace.json`) tracks the overall collection version separately.

## Python scripts

Scripts live in `skills/*/scripts/` and use only Python stdlib. They parse state artifacts and output JSON for Claude to consume.

Run from the skill directory:
```bash
cd skills/profilera && python3 -m scripts.extract_all
cd skills/optimera && python3 -m scripts.analyze_experiments
cd skills/realisera && python3 -m scripts.analyze_progress
```

The repo-level `scripts/validate-ecosystem.py` checks all 10 SKILL.md files against `references/ecosystem-spec.md`. Run from the repo root:
```bash
python3 scripts/validate-ecosystem.py
```

## Ecosystem linter

A pre-commit hook runs the linter on any commit touching `skills/*/SKILL.md` or `references/ecosystem-spec.md`. Enable with:
```bash
git config core.hooksPath .githooks
```
The linter blocks commits with alignment errors and warns on advisory issues.

## Key conventions

- SKILL.md is the single source of truth for each skill's behavior — workflow steps, trigger patterns, output format, safety rails, and cross-skill integration are all defined there
- Shared primitives (confidence scale, severity levels, structural conventions) are defined in `references/ecosystem-spec.md` — all SKILL.md files must align with this spec
- Skills never push to remote repos or modify VISION.md/OBJECTIVE.md during execution cycles
- Conventional commits: feat/fix/docs/refactor/chore/test
- realisera and optimera dispatch implementation work to Sonnet agents in worktrees, then verify before committing
