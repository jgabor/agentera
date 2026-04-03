# Documentation Contract

<!-- Maintained by dokumentera. Last audit: 2026-04-03 -->

## Conventions

```
doc_root: .
style:    technical, concise, sections with tables, no badges
auto_gen:
  - none
versioning:
  version_files:
    - skills/*/.claude-plugin/plugin.json
    - .claude-plugin/marketplace.json
    - registry.json
  semver_policy: "feat = minor, fix = patch, docs/chore/test = no bump"
```

## Artifact Mapping

Skills check this table for path overrides. If an artifact has no entry or
.agentera/DOCS.md is absent, use the default layout: VISION.md, TODO.md, and
CHANGELOG.md at root; all other artifacts in .agentera/.

| Artifact | Path | Producers |
|----------|------|-----------|
| VISION.md | VISION.md | visionera, realisera |
| TODO.md | TODO.md | realisera, inspektera |
| CHANGELOG.md | CHANGELOG.md | realisera |
| DECISIONS.md | .agentera/DECISIONS.md | resonera |
| PLAN.md | .agentera/PLAN.md | planera |
| PROGRESS.md | .agentera/PROGRESS.md | realisera |
| HEALTH.md | .agentera/HEALTH.md | inspektera |
| OBJECTIVE.md | .agentera/OBJECTIVE.md | optimera |
| EXPERIMENTS.md | .agentera/EXPERIMENTS.md | optimera |
| DOCS.md | .agentera/DOCS.md | dokumentera |
| DESIGN.md | .agentera/DESIGN.md | visualisera |
| PROFILE.md | ~/.claude/profile/PROFILE.md | profilera |

## Index

| Document | Path | Last Updated | Status |
|----------|------|-------------|--------|
| README | README.md | 2026-04-02 | ■ current |
| CLAUDE.md | CLAUDE.md | 2026-04-02 | ■ current |
| Decisions | .agentera/DECISIONS.md | 2026-04-02 | ■ current |
| Vision | VISION.md | 2026-03-31 | ■ current |
| Progress | .agentera/PROGRESS.md | 2026-04-02 | ■ current |
| TODO | TODO.md | 2026-04-02 | ■ current |
| Changelog | CHANGELOG.md | 2026-04-02 | ■ current |
| Health | .agentera/HEALTH.md | 2026-04-02 | ■ current |
| Plan | .agentera/PLAN.md | 2026-04-02 | ■ current (archived) |
| DOCS | .agentera/DOCS.md | 2026-04-02 | ■ current |
| Design | .agentera/DESIGN.md | 2026-04-02 | ■ current |
| Ecosystem spec | references/ecosystem-spec.md | 2026-04-02 | ■ current |
| Ideas | docs/IDEAS.md | 2026-03-29 | ■ current |
| Registry | registry.json | 2026-04-02 | ■ current |
| Marketplace manifest | .claude-plugin/marketplace.json | 2026-04-02 | ■ current |
| Test suite | tests/ | 2026-04-02 | ■ current |

## Coverage

- **Documented**: 12/12 skills have SKILL.md (single source of truth)
- **Undocumented**: 0 skills lack documentation
- **Stale**: none
- **Tests**: 171 tests across 7 files; extract_all.py untested; CI gating deferred

## Audit Log

### 2026-04-03 (Audit 5)

- [gap] CLAUDE.md repo layout missing tests/ directory · warning (fixed)
- [stale] DOCS.md HEALTH.md row showed stale status, Audit 6 updated it · warning (fixed)
- [stale] CHANGELOG.md [Unreleased] empty despite 7 post-1.5.0 commits · warning (fixed)
- [misaligned] ecosystem-spec Section 16 orkestrera row described proportionality forwarding instead of anti-bias constraint · warning (fixed)
- [misaligned] ecosystem-spec line 5 comment had hyphen instead of underscore in script name · info (fixed)
- [stale] DOCS.md DTC comment referenced ISSUES.md instead of TODO.md · info (fixed)
- [gap] DOCS.md Index missing test suite row · warning (fixed)
- [stale] DOCS.md Coverage note outdated, missing test count and gaps · warning (fixed)

### 2026-04-02 (Audit 4)

- [stale] README.md line 52 referenced /loop without mentioning /orkestrera as primary autonomous execution method · warning (fixed)
- [misaligned] README.md ecosystem diagram showed orkestrera → realisera but omitted orkestrera ↔ inspektera evaluation link · warning (fixed)
- [misaligned] README.md and ecosystem-spec.md VISION.md consumers missing orkestrera (reads during bootstrap) · warning (fixed)
- [stale] DOCS.md coverage notes referenced CLAUDE.md and README.md staleness already resolved by cycles 72-77 · warning (fixed)
- [stale] DOCS.md Index dates from 2026-03-31 for files updated 2026-04-02 · warning (fixed)
- [stale] DOCS.md last audit date said 2026-03-31 · info (fixed)
- [stale] DOCS.md Plan entry showed active but plan was archived · info (fixed)

### 2026-03-31 (Audit 3)

- [stale] ecosystem-spec.md + all 11 SKILL.md say "ten-skill", actually eleven after hej · critical (fixed)
- [gap] DOCS.md Index listed 6 documents, missing 6 that exist (VISION, PROGRESS, ISSUES, HEALTH, DESIGN, ecosystem-spec) · critical (fixed)
- [stale] marketplace.json description missing hej and visualisera activities · warning (fixed)
- [misaligned] DOCS.md version_files path had erroneous space · warning (fixed)
- [stale] ISSUES.md resolved items appeared after empty "## Open" heading · warning (fixed)
- [misaligned] registry.json inspirera said "an external link" vs plural elsewhere · warning (fixed)
- [stale] DOCS.md Index used plain text status instead of visual tokens · warning (fixed)
- [gap] CLAUDE.md Key conventions missing visual identity and versioning · info (fixed)
- [stale] HEALTH.md Audit 2 findings all resolved but artifact not re-audited · info (noted)
- [stale] DOCS.md last audit date said 2026-03-30 · info (fixed)

### 2026-03-30

- [stale] DOCS.md was flat index, upgraded to three-layer documentation contract · info (fixed)
- [stale] README DOCS.md row said "dokumentera, inspektera", now consumed by all skills · warning (fixed)

### 2026-03-29

- [stale] README.md said "Six skills", actually nine · critical (fixed)
- [stale] CLAUDE.md said "Four skills" then "eight skills", actually nine · critical (fixed)
- [stale] CLAUDE.md "What this is" named only 4 of 9 skills · critical (fixed: defers to README)
- [stale] marketplace.json description undersold the suite · critical (fixed)
- [stale] registry.json truncated descriptions for optimera, resonera, dokumentera · warning (fixed)
- [misaligned] plugin.json descriptions for inspirera/realisera/visionera diverged from canonical · warning (fixed)
- [misaligned] README.md OBJECTIVE.md listed resonera as maintainer; only optimera maintains it · warning (fixed)
- [redundant] Skill ecosystem described in both README.md and CLAUDE.md · warning (fixed: CLAUDE.md now defers to README)
- [redundant] Repository layout duplicated in both files · warning (kept: different audiences)

<!--
Status values:
  ■ current    · doc accurately reflects implementation
  ▣ stale      · code changed since doc was last updated
  □ missing    · module/feature has no documentation
  ▸ intent     · doc written before code (DTC-first), not yet implemented
  ▸ generated  · auto-generated by tooling listed in Conventions.auto_gen

Audit finding types:
  gap         · documented but not implemented
  stale       · code changed, docs not updated
  redundant   · same information in multiple places
  misaligned  · docs contradict implementation

Severity:
  critical · will cause user errors
  warning  · may cause confusion
  info     · minor issue

Sections:
  Conventions      · project-level doc config (doc_root, style, auto_gen, versioning)
  Artifact Mapping · canonical-to-path lookup for skill state files
  Index            · document registry with status tracking
  Coverage         · quantitative doc health summary
  Audit Log        · timestamped findings from dokumentera audits

DTC principle:
  If code diverges from docs, the code is wrong. File to TODO.md, don't update docs
  to match broken code. Exception: if the doc is genuinely wrong (outdated assumption),
  fix the doc explicitly.
-->
