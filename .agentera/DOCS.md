# Documentation Contract

<!-- Maintained by dokumentera. Last audit: 2026-04-20 (post-1.13.0) -->

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
| DOCS.md | .agentera/DOCS.md | dokumentera |
| DESIGN.md | .agentera/DESIGN.md | visualisera |
| SESSION.md | .agentera/SESSION.md | session stop hook |
| PROFILE.md | ~/.claude/profile/PROFILE.md | profilera |

## Index

| Document | Path | Last Updated | Status |
|----------|------|-------------|--------|
| README | README.md | 2026-04-10 | ■ current |
| CLAUDE.md | CLAUDE.md | 2026-04-02 | ■ current |
| Decisions | .agentera/DECISIONS.md | 2026-04-02 | ■ current |
| Vision | VISION.md | 2026-03-31 | ■ current |
| Progress | .agentera/PROGRESS.md | 2026-04-10 | ■ current |
| TODO | TODO.md | 2026-04-02 | ■ current |
| Changelog | CHANGELOG.md | 2026-04-10 | ■ current |
| Health | .agentera/HEALTH.md | 2026-04-20 | ■ current |
| Plan | .agentera/PLAN.md | 2026-04-13 | ■ current (archived) |
| DOCS | .agentera/DOCS.md | 2026-04-20 | ■ current |
| Design | .agentera/DESIGN.md | 2026-04-19 | ■ current |
| Ecosystem spec | SPEC.md | 2026-04-20 | ■ current |
| Ideas | docs/IDEAS.md | 2026-03-29 | ■ current |
| Registry | registry.json | 2026-04-13 | ■ current |
| Marketplace manifest | .claude-plugin/marketplace.json | 2026-04-13 | ■ current |
| Hooks registry | hooks/hooks.json | 2026-04-03 | ■ current |
| SessionStart hook | hooks/session_start.py | 2026-04-03 | ■ current |
| Session stop hook | hooks/session_stop.py | 2026-04-03 | ■ current |
| Validation hook | hooks/validate_artifact.py | 2026-04-03 | ■ current |
| Shared hook utils | hooks/common.py | 2026-04-03 | ■ current |
| Test suite | tests/ | 2026-04-13 | ■ current |
| Lefthook config | .lefthook.yml | 2026-04-20 | ■ current |
| CI workflow | .github/workflows/ci.yml | 2026-04-11 | ■ current |

## Coverage

- **Documented**: 12/12 skills have SKILL.md (single source of truth)
- **Undocumented**: 0 skills lack documentation
- **Stale**: none
- **Tests**: 263 tests across 12 files; CI runs on push/PR via GitHub Actions

## Audit Log

### 2026-04-20 (Audit 8, post-1.13.0)

- [stale] CHANGELOG.md [Unreleased] empty despite 6 bump-worthy commits since 1.13.0 · warning (fixed)
- [stale] DOCS.md Coverage test count said 240 across 12 files, actual 263; CI gating note outdated · warning (fixed)
- [stale] DOCS.md Index dates for HEALTH.md, SPEC.md, Test suite showed pre-1.13.0 dates · warning (fixed)
- [gap] CLAUDE.md repo layout missing .lefthook.yml · info (fixed)
- [stale] DOCS.md last audit date said 2026-04-10 post-1.8.0 · info (fixed)
- [gap] DOCS.md Index missing .lefthook.yml row · info (fixed)

### 2026-04-10 (Audit 7, post-1.8.0)

- [stale] DOCS.md Index "Ecosystem spec" path said `references/the spec.md`, renamed to SPEC.md at repo root in Decision 23 · critical (fixed)
- [stale] DOCS.md Coverage test count said 233 across 10 files, actual is 240 across 12 files (+4 platform-annotation tests, +generate_contracts and hook tests) · warning (fixed)
- [stale] DOCS.md Index dates for 7 entries showed 2026-04-02/03, updated to 2026-04-10 for files changed by Platform Portability plan · warning (fixed)
- [stale] DOCS.md last audit date said 2026-04-03 post-1.6.0, now post-1.8.0 · info (fixed)

### 2026-04-03 (Audit 6, post-1.6.0)

- [gap] DOCS.md Artifact Mapping missing SESSION.md (12th artifact, Decision 23) · critical (fixed)
- [stale] DOCS.md Coverage said 171 tests across 7 files, actual is 233 across 10 · warning (fixed)
- [gap] DOCS.md Index missing 5 hooks files (hooks.json, session_start.py, session_stop.py, validate_artifact.py, common.py) · warning (fixed)
- [stale] README.md inspektera description says "six dimensions", now 9 · warning (fixed)
- [stale] README.md artifact reference says "eight operational files", now nine (SESSION.md) · warning (fixed)
- [gap] README.md artifact table missing SESSION.md row · warning (fixed)
- [stale] CLAUDE.md hooks/hooks.json described as "PostToolUse hook registry", registers all 3 hooks · warning (fixed)
- [gap] CLAUDE.md repository layout missing hooks/session_start.py, hooks/session_stop.py, hooks/common.py · warning (fixed)
- [stale] CLAUDE.md "eight operational files" should be nine · warning (fixed)

### 2026-04-03 (Audit 5)

- [gap] CLAUDE.md repo layout missing tests/ directory · warning (fixed)
- [stale] DOCS.md HEALTH.md row showed stale status, Audit 6 updated it · warning (fixed)
- [stale] CHANGELOG.md [Unreleased] empty despite 7 post-1.5.0 commits · warning (fixed)
- [misaligned] the spec Section 16 orkestrera row described proportionality forwarding instead of anti-bias constraint · warning (fixed)
- [misaligned] the spec line 5 comment had hyphen instead of underscore in script name · info (fixed)
- [stale] DOCS.md DTC comment referenced ISSUES.md instead of TODO.md · info (fixed)
- [gap] DOCS.md Index missing test suite row · warning (fixed)
- [stale] DOCS.md Coverage note outdated, missing test count and gaps · warning (fixed)

### 2026-04-02 (Audit 4)

- [stale] README.md line 52 referenced /loop without mentioning /orkestrera as primary autonomous execution method · warning (fixed)
- [misaligned] README.md ecosystem diagram showed orkestrera → realisera but omitted orkestrera ↔ inspektera evaluation link · warning (fixed)
- [misaligned] README.md and the spec.md VISION.md consumers missing orkestrera (reads during bootstrap) · warning (fixed)
- [stale] DOCS.md coverage notes referenced CLAUDE.md and README.md staleness already resolved by cycles 72-77 · warning (fixed)
- [stale] DOCS.md Index dates from 2026-03-31 for files updated 2026-04-02 · warning (fixed)
- [stale] DOCS.md last audit date said 2026-03-31 · info (fixed)
- [stale] DOCS.md Plan entry showed active but plan was archived · info (fixed)

### 2026-03-31 (Audit 3)

- [stale] the spec.md + all 11 SKILL.md say "ten-skill", actually eleven after hej · critical (fixed)
- [gap] DOCS.md Index listed 6 documents, missing 6 that exist (VISION, PROGRESS, ISSUES, HEALTH, DESIGN, the spec) · critical (fixed)
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
