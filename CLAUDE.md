# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

agentera: a Claude Code skill marketplace. Eleven skills, each a self-contained `SKILL.md` with optional `references/` and `scripts/`, that give Claude specialized autonomous behaviors. See the README for the full skill table and ecosystem diagram.

## Repository layout

```
skills/<name>/SKILL.md               # Frontmatter + full workflow (the skill itself)
skills/<name>/references/            # Supplementary docs, templates, schemas
skills/<name>/scripts/               # Python helpers (stdlib only, no pip deps)
skills/<name>/.claude-plugin/plugin.json  # Per-skill marketplace plugin manifest
references/ecosystem-spec.md         # Shared primitives spec (all skills must align)
scripts/validate_ecosystem.py        # Ecosystem linter (pre-commit hook)
scripts/eval_skills.py               # Tier 2 eval runner (smoke-tests skills via claude -p)
.githooks/pre-commit                 # Git hook running the linter
registry.json                        # Skill index with versions and tags
.claude-plugin/marketplace.json      # Plugin marketplace manifest
```

## Skill ecosystem

The eleven skills form a connected graph, not isolated tools. See the README for the full ecosystem diagram and state artifact reference table. All skills work standalone AND mesh when co-installed. Each skill generates state artifacts in the *target project*, not in this repo. Default layout: three project-facing files at root (VISION.md, TODO.md, CHANGELOG.md) and eight operational files in `.agentera/` (PROGRESS.md, DECISIONS.md, PLAN.md, HEALTH.md, OBJECTIVE.md, EXPERIMENTS.md, DESIGN.md, DOCS.md). Skills check `.agentera/DOCS.md` for path overrides; if absent, use the deterministic default layout.

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
python3 skills/profilera/scripts/extract_all.py
python3 skills/optimera/scripts/analyze_experiments.py
python3 skills/realisera/scripts/analyze_progress.py
```

The repo-level `scripts/validate_ecosystem.py` checks all 11 SKILL.md files against `references/ecosystem-spec.md`. Run from the repo root:
```bash
python3 scripts/validate_ecosystem.py
```

The repo-level `scripts/eval_skills.py` smoke-tests skills via `claude -p` (Tier 2 eval). Run from the repo root:
```bash
python3 scripts/eval_skills.py --dry-run          # list skills and prompts
python3 scripts/eval_skills.py --skill realisera   # test one skill
python3 scripts/eval_skills.py --parallel 3        # test all skills, 3 at a time
```

## Ecosystem linter

A pre-commit hook runs the linter on any commit touching `skills/*/SKILL.md` or `references/ecosystem-spec.md`. Enable with:
```bash
git config core.hooksPath .githooks
```
The linter blocks commits with alignment errors and warns on advisory issues.

## Key conventions

- SKILL.md is the single source of truth for each skill's behavior: workflow steps, trigger patterns, output format, safety rails, and cross-skill integration are all defined there
- Shared primitives (confidence scale, severity levels, completion status protocol, escalation discipline, structural conventions) are defined in `references/ecosystem-spec.md`. All SKILL.md files must align with this spec
- Skills never push to remote repos or modify VISION.md/OBJECTIVE.md during execution cycles
- Conventional commits: feat/fix/docs/refactor/chore/test
- realisera and optimera dispatch implementation work to Sonnet agents in worktrees, then verify before committing
- Visual identity system defined in `references/ecosystem-spec.md` Section 12: skill glyphs, semantic tokens (status, severity, confidence, trend), and composition rules that all skills and artifact templates follow
- Versioning convention in DOCS.md: `version_files` lists what to bump, `semver_policy` maps commit types to bump levels. Planera flags bump-worthy plans, inspektera checks for unbumped changes, realisera executes bumps
