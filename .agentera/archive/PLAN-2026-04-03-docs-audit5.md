# Plan: dokumentera Audit 5 fixes

<!-- Level: light | Created: 2026-04-03 | Status: active -->

## What

Fix 8 documentation findings from dokumentera Audit 5: 4 warnings (CLAUDE.md missing tests/, DOCS.md stale HEALTH.md status, CHANGELOG.md empty [Unreleased], ecosystem-spec orkestrera row misaligned) and 4 info (ecosystem-spec filename comment, DOCS.md ISSUES.md reference, DOCS.md missing test suite index entry, DOCS.md missing test coverage note).

## Why

Documentation drifted during 7 post-1.5.0 commits (test suite, proportionality convention, anti-bias hardening, README overhaul). 0 critical issues but 4 warnings that cause contributor confusion.

## Constraints

- Ecosystem linter must stay at 0 errors, 0 warnings
- No content changes beyond the 8 documented findings
- For Finding 4 (spec vs dispatch alignment): update the spec to match implementation, not vice versa

## Acceptance Criteria

▸ GIVEN CLAUDE.md repo layout WHEN read THEN it includes a `tests/` entry
▸ GIVEN DOCS.md Index WHEN HEALTH.md row is read THEN it shows `2026-04-02 | ■ current` and Coverage note reflects Audit 6
▸ GIVEN CHANGELOG.md [Unreleased] WHEN read THEN it logs the test suite, proportionality convention, and anti-bias changes
▸ GIVEN ecosystem-spec Section 16 orkestrera row WHEN read THEN it describes the anti-bias dispatch constraint, not proportionality forwarding
▸ GIVEN ecosystem-spec line 5 comment WHEN read THEN it says `validate_ecosystem.py` (underscore)
▸ GIVEN DOCS.md comment at line 136 WHEN read THEN it says TODO.md, not ISSUES.md
▸ GIVEN DOCS.md Index WHEN read THEN it has a test suite row
▸ GIVEN DOCS.md Coverage WHEN read THEN it mentions 171 tests and remaining gaps
