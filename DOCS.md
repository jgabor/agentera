# Documentation Index

<!-- Maintained by dokumentera. Last audit: 2026-03-29 -->

## Documents

| Document | Path | Last Updated | Status |
|----------|------|-------------|--------|
| README | README.md | 2026-03-29 | current |
| CLAUDE.md | CLAUDE.md | 2026-03-29 | current |
| Decisions | DECISIONS.md | 2026-03-29 | current |
| Ideas | docs/IDEAS.md | 2026-03-29 | current |
| Registry | registry.json | 2026-03-29 | current |
| Marketplace manifest | .claude-plugin/marketplace.json | 2026-03-29 | current |
| inspirera plugin.json | skills/inspirera/.claude-plugin/plugin.json | 2026-03-29 | current |
| profilera plugin.json | skills/profilera/.claude-plugin/plugin.json | 2026-03-29 | current |
| realisera plugin.json | skills/realisera/.claude-plugin/plugin.json | 2026-03-29 | current |
| optimera plugin.json | skills/optimera/.claude-plugin/plugin.json | 2026-03-29 | current |
| resonera plugin.json | skills/resonera/.claude-plugin/plugin.json | 2026-03-29 | current |
| inspektera plugin.json | skills/inspektera/.claude-plugin/plugin.json | 2026-03-29 | current |
| planera plugin.json | skills/planera/.claude-plugin/plugin.json | 2026-03-29 | current |
| visionera plugin.json | skills/visionera/.claude-plugin/plugin.json | 2026-03-29 | current |
| dokumentera plugin.json | skills/dokumentera/.claude-plugin/plugin.json | 2026-03-29 | current |

## Coverage

- **Documented**: 9/9 skills have SKILL.md (single source of truth)
- **Undocumented**: 0 skills lack documentation
- **Stale**: 0 documents have drifted from implementation (after this audit)

## Audit Log

### 2026-03-29

- [stale] README.md said "Six skills" — actually nine — critical (fixed)
- [stale] CLAUDE.md said "Four skills" then "eight skills" — actually nine — critical (fixed)
- [stale] CLAUDE.md "What this is" named only 4 of 9 skills — critical (fixed: defers to README)
- [stale] marketplace.json description undersold the suite — critical (fixed)
- [stale] registry.json truncated descriptions for optimera, resonera, dokumentera — warning (fixed)
- [misaligned] plugin.json descriptions for inspirera/realisera/visionera diverged from canonical — warning (fixed)
- [misaligned] README.md OBJECTIVE.md listed resonera as maintainer; only optimera maintains it — warning (fixed)
- [redundant] Skill ecosystem described in both README.md and CLAUDE.md — warning (fixed: CLAUDE.md now defers to README)
- [redundant] Repository layout duplicated in both files — warning (kept: different audiences)

<!--
Status values:
  current    — doc accurately reflects implementation
  stale      — code changed since doc was last updated
  missing    — module/feature has no documentation
  intent     — doc written before code (DTC-first), not yet implemented

Audit finding types:
  gap         — documented but not implemented
  stale       — code changed, docs not updated
  redundant   — same information in multiple places
  misaligned  — docs contradict implementation

Severity:
  critical — will cause user errors
  warning  — may cause confusion
  info     — minor issue

DTC principle:
  If code diverges from docs, the code is wrong. File to ISSUES.md, don't update docs
  to match broken code. Exception: if the doc is genuinely wrong (outdated assumption),
  fix the doc explicitly.
-->
