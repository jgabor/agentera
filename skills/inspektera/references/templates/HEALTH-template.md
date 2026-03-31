# Health

Codebase health assessments maintained by inspektera. Each audit appends one entry. Prior
audits are kept for trend tracking. Findings feed into ISSUES.md for realisera to pick up.

## Patterns Observed

[De facto architecture patterns extracted from the codebase. Updated by the latest audit —
stable across audits unless the architecture changes.]

- Module structure: [how code is organized]
- Error handling: [predominant pattern]
- Testing approach: [how tests are structured]
- Dependency patterns: [how deps are managed]

## Audit 1 — YYYY-MM-DD

**Dimensions assessed**: [list of dimensions]
**Findings**: X critical, Y warnings, Z info (N filtered by confidence)
**Overall trajectory**: ⮉ improving | ⮋ degrading | baseline (first audit)
**Grades**: Architecture [?] | Patterns [?] | Coupling [?] | Complexity [?] | Tests [?] | Deps [?]

### [Dimension Name]: [A-F grade]

#### ⇶ [Finding title] — critical (confidence: N/100)
#### ⇉ [Finding title] — warning (confidence: N/100)
#### ⇢ [Finding title] — info (confidence: N/100)
- **Location**: `file:line` (or module/package)
- **Evidence**: [quoted code or structural observation]
- **Impact**: [what breaks, degrades, or risks]
- **Suggested action**: [specific fix, investigation, or refactor]

### Trends vs prior audit
[First audit — no comparison available. Future audits compare against this baseline.]

<!--
Dimension grades:
  A — No critical or warning findings. Healthy.
  B — No critical findings. Some warnings. Solid with room for improvement.
  C — 1-2 critical findings or many warnings. Needs attention.
  D — Multiple critical findings. Structural problems.
  F — Pervasive critical findings. Health crisis.

Finding severity:
  critical  — Structural problem that will cause bugs, blocks, or compounding debt
  warning   — Pattern break or quality issue that degrades maintainability
  info      — Minor observation or low-confidence finding worth noting

Confidence scoring (0-100):
  90-100 — Definitely real. Verified by reading code. Clear impact.
  70-89  — Very likely real. Strong evidence, some context might justify it.
  50-69  — Possibly an issue. Suspicious but could be intentional. Auto-capped at info severity.
  <50    — Filtered out. Not included in report.
-->
