# Plan: v2/v3 coexistence B3 — bundle-status & channel resolution

<!-- Level: full | Created: 2026-06-27 | Status: complete | Archived: 2026-06-27 -->
<!-- Previous plan: archive/PLAN-2026-06-27-b2-env-var-path-resolution.md -->

## What

Fix the bundle-status and channel-resolution defects that produce
contradictory prime output when a v3 CLI runs against a v2 installed
app. Centralize channel resolution so doctor and project_integration
agree. Fix retryCommand to derive from the invoking CLI runtime, not
the v2 managed script shebang. Make expectedVersion channel-aware so
a correct v2 stable install is not falsely flagged as version_mismatch.
Separate crossMajorBoundary detected from announced semantics so the
false-coalesce does not suppress cross-major awareness. Fix the
dryRunCommand/applyCommand dead end when crossMajorPending is true.
Replace hardcoded stable channel guidance text with the resolved
channel name.

## Tasks

1. Centralize channel resolution through resolveInvokedUpdateChannel — **complete**
2. Fix retryCommand to derive from invoking CLI runtime — **complete**
3. Make expectedVersion channel-aware — **complete**
4. Separate crossMajorBoundary detected vs announced semantics — **complete**
5. Fix dryRunCommand/applyCommand dead end when crossMajorPending — **complete**
6. Fix hardcoded "stable channel" guidance text — **complete**
7. Add test coverage for bundle-status channel resolution — **complete**
8. Build, typecheck, test, validate, and compact — **complete**

## Overall Acceptance

All 8 tasks complete. Channel resolution is centralized: doctor and
project_integration report the same channel. retryCommand derives from
the invoking CLI runtime (npx/node for v3, uv run for v2). expectedVersion
is channel-aware: stable channel reads the installed app bundle version,
development reads the source registry. crossMajorBoundary separates
detected from announced so project_integration is not suppressed.
dryRunCommand/applyCommand is not a dead end when crossMajorPending —
approval text is corrected when no command is available. Guidance text
uses the resolved channel name. 1034 vitest tests pass (up from 1027,
+7 new). Typecheck, build, validate, and compact all green.

## Collapsed defects

Defects #5, #6, #17, #18, #19, #39 from the v2/v3 coexistence defects
report are resolved by this batch. See
docs/notes/v2-v3-coexistence-defects.md batch plan.
