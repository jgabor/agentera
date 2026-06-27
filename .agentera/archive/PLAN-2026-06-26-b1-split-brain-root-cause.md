# Plan: v2/v3 coexistence B1 — split-brain root cause

<!-- Level: full | Created: 2026-06-26 | Status: complete | Archived: 2026-06-26 -->
<!-- Previous plan: archive/PLAN-2026-06-26-d73-single-agentera-agent.md -->

## What

Fix the root cause of the v2/v3 coexistence defect surface: when AGENTERA_HOME
is set (standard for v2 users), the v3 CLI's activeAppModel() skips the
local-checkout shortcut and resolves skillRoot to the installed v2 app, while
resolveSourceRoot() resolves to the v3 repo. Also adds the
PROFILERA_PROFILE_DIR env-var fallback, schema-version validation, accurate
capability-startup readiness signaling, and a post-migration smoke test.

## Tasks

1. Fix activeAppModel() local-checkout guard in appContext.ts — **complete**
2. Add $PROFILERA_PROFILE_DIR/ fallback in resolveArtifactPath — **complete**
3. Add schema-version validation in loadArtifactRegistry — **complete**
4. Fix complete_for_capability_startup to derive from actual state — **complete**
5. Add post-migration prime smoke test to assert-v2v3-migration.sh — **complete**
6. Add split-brain test coverage — **complete**
7. Verify collapsed defects resolved — **complete**
8. Build, typecheck, test, validate, and compact — **complete**

## Overall Acceptance

All 8 tasks complete. The split-brain root cause is fixed: a v3 CLI running
from a local checkout reads repo v3 schemas, capabilities, and contracts even
when AGENTERA_HOME points at a v2 installed app. prime --context audit returns
no schema_error (was "No capability artifact schema found"). profile.status is
"loaded" (was "not found"). complete_for_capability_startup is derived from
actual state, not hardcoded. 1016 vitest tests pass (up from 1000, +16 new).
Typecheck, build, validate, and compact all green.

## Collapsed defects

Defects #1, #2, #3, #4, #9, #10, #11, #12, #13, #28 from the v2/v3 coexistence
defects report are resolved by this batch. See
docs/notes/v2-v3-coexistence-defects.md batch plan.
