# Documentation Contract

<!-- Maintained by dokumentera. Last audit: 2026-04-26 (Suite Usage Analytics Task 4) -->

## Conventions

```
doc_root: .
style:    technical, concise, sections with tables, no badges
auto_gen:
  - none
  versioning:
  version_files:
    - plugin.json
    - .github/plugin/plugin.json
    - .codex-plugin/plugin.json
    - skills/*/.claude-plugin/plugin.json
    - .claude-plugin/marketplace.json
    - .opencode/plugins/agentera.js
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
| PROFILE.md | $PROFILERA_PROFILE_DIR/PROFILE.md (default: $XDG_DATA_HOME/agentera/PROFILE.md) | profilera |
| USAGE.md | $AGENTERA_USAGE_DIR/USAGE.md (default: $XDG_DATA_HOME/agentera/USAGE.md, sibling of PROFILE.md) | scripts/usage_stats.py |

## Index

| Document | Path | Last Updated | Status |
|----------|------|-------------|--------|
| README | README.md | 2026-04-26 | ■ current |
| CLAUDE.md | CLAUDE.md | 2026-04-02 | ■ current |
| Decisions | .agentera/DECISIONS.md | 2026-04-02 | ■ current |
| Vision | VISION.md | 2026-03-31 | ■ current |
| Progress | .agentera/PROGRESS.md | 2026-04-25 | ■ current |
| TODO | TODO.md | 2026-04-25 | ■ current |
| Changelog | CHANGELOG.md | 2026-04-25 | ■ current |
| Health | .agentera/HEALTH.md | 2026-04-23 | ■ current |
| Plan | .agentera/PLAN.md | 2026-04-25 | ■ current (no active plan) |
| DOCS | .agentera/DOCS.md | 2026-04-25 | ■ current |
| Design | .agentera/DESIGN.md | 2026-04-19 | ■ current |
| Ecosystem spec | SPEC.md | 2026-04-20 | ■ current |
| Ideas | docs/IDEAS.md | 2026-03-29 | ■ current |
| Registry | registry.json | 2026-04-13 | ■ current |
| Marketplace manifest | .claude-plugin/marketplace.json | 2026-04-13 | ■ current |
| Copilot plugin manifest | plugin.json | 2026-04-25 | ■ current |
| Codex plugin manifest | .codex-plugin/plugin.json | 2026-04-24 | ■ current |
| Codex UI metadata | skills/&lt;name&gt;/agents/openai.yaml; agents/openai.yaml | 2026-04-24 | ■ current |
| Hooks registry | hooks/hooks.json | 2026-04-03 | ■ current |
| Lifecycle adapter validator | scripts/validate_lifecycle_adapters.py | 2026-04-23 | ■ current |
| Usage analytics script | scripts/usage_stats.py | 2026-04-26 | ■ current |
| SessionStart hook | hooks/session_start.py | 2026-04-03 | ■ current |
| Session stop hook | hooks/session_stop.py | 2026-04-03 | ■ current |
| Validation hook | hooks/validate_artifact.py | 2026-04-03 | ■ current |
| Shared hook utils | hooks/common.py | 2026-04-03 | ■ current |
| Test suite | tests/ | 2026-04-24 | ■ current |
| Lefthook config | .lefthook.yml | 2026-04-20 | ■ current |
| CI workflow | .github/workflows/ci.yml | 2026-04-11 | ■ current |

## Coverage

- **Documented**: 12/12 skills have SKILL.md (single source of truth)
- **Undocumented**: 0 skills lack documentation
- **Stale**: none
- **Tests**: 359 tests across 13 files; CI runs on push/PR via GitHub Actions

## Audit Log

### 2026-04-26 (Suite Usage Analytics Task 4)

- [gap] DOCS.md Artifact Mapping missing USAGE.md (new global artifact, sibling of PROFILE.md, produced by `scripts/usage_stats.py`) · warning (fixed)
- [gap] DOCS.md Index missing `scripts/usage_stats.py` row · info (fixed)
- [gap] README.md had no Scripts section listing repo-level utilities (`validate_spec.py`, `eval_skills.py`, `usage_stats.py`) · warning (fixed)
- [gap] CLAUDE.md (symlink to AGENTS.md) Python scripts section did not list `scripts/usage_stats.py` · warning (fixed)

### 2026-04-25 (Copilot packaging fix)

- [gap] Current-checkout Copilot plugin loading rejected `../../skills`; root `plugin.json` now loads shared `skills/` inside plugin root · info (fixed)

### 2026-04-25 (Live Copilot/Codex smoke)

- [gap] Live host caveat narrowed: Codex `$hej` and installed Copilot skills work, but current-checkout Copilot plugin loading rejects `../../skills` · info (deferred)

### 2026-04-25 (Audit 11 freshness checkpoint)

- [stale] Audit 11 PLAN, TODO, PROGRESS, and CHANGELOG needed one current completed state after Tasks 1-7 passed · warning (fixed)
- [gap] Live Copilot/Codex host behavior remains untested and must stay explicit until smoke-tested · info (deferred)

### 2026-04-24 (Task 6 profilera integration)

- [stale] README.md and Codex metadata still described profilera as missing Copilot/Codex collectors after collectors landed · warning (fixed)
- [gap] DOCS.md Coverage test count predated Task 6 envelope validation fixtures · warning (fixed)

### 2026-04-24 (Task 1 runtime install audit)

- [stale] README.md listed non-existent `claude plugin add` flow instead of marketplace add plus plugin install · critical (fixed)
- [misaligned] README.md mixed plugin distribution paths with direct skill-folder loading for Copilot, Codex, and OpenCode · warning (fixed)
- [misaligned] README.md hook table over-specified parity for runtimes with partial or experimental lifecycle support · warning (fixed)

### 2026-04-24 (Audit 10 follow-up)

- [stale] DOCS.md Coverage test count said 263 across 12 files, actual 320 across 13 after runtime adapter tests · warning (fixed)
- [stale] DOCS.md Index dates for Progress, TODO, Changelog, Health, Plan, and Test suite predated Copilot/Codex plan updates · warning (fixed)
- [stale] DOCS.md Plan row said archived while a completed active PLAN.md exists · info (fixed)

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
