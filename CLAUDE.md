# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A personal Claude Code skill marketplace. Four skills — each a self-contained `SKILL.md` with optional `references/` and `scripts/` — that give Claude specialized autonomous behaviors: cross-pollination research (inspirera), autonomous development loops (realisera), metric-driven optimization (optimera), and decision-profile mining (profilera).

## Repository layout

```
skills/<name>/SKILL.md          # Frontmatter + full workflow (the skill itself)
skills/<name>/references/       # Supplementary docs, templates, schemas
skills/<name>/scripts/          # Python helpers (stdlib only, no pip deps)
registry.json                   # Skill index with versions and tags
.claude-plugin/marketplace.json # Plugin marketplace manifest
```

## Skill ecosystem

The five skills form a connected graph — not isolated tools:

- **resonera** (deliberates) produces decision artifacts and feeds into realisera's VISION.md and optimera's OBJECTIVE.md
- **realisera** (builds) delegates metric work to **optimera**, consumes research from **inspirera**, and escalates complex decisions to **resonera**
- **inspirera** feeds findings into realisera's VISION.md/ISSUES.md, optimization hypotheses into optimera, and adoption decisions into resonera
- **profilera** produces PROFILE.md consumed by all other skills to weight decisions by user persona

Each skill generates state artifacts (DECISIONS.md, VISION.md, PROGRESS.md, ISSUES.md, OBJECTIVE.md, EXPERIMENTS.md, PROFILE.md) in the *target project*, not in this repo. These artifacts are structured markdown designed for both human reading and script parsing.

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

## Key conventions

- SKILL.md is the single source of truth for each skill's behavior — workflow steps, trigger patterns, output format, safety rails, and cross-skill integration are all defined there
- Skills never push to remote repos or modify VISION.md/OBJECTIVE.md during execution cycles
- Conventional commits: feat/fix/docs/refactor/chore/test
- realisera and optimera dispatch implementation work to Sonnet agents in worktrees, then verify before committing
