# Plan: v2/v3 coexistence B4 — OpenCode plugin rewire

<!-- Level: full | Created: 2026-06-27 | Status: complete | Archived: 2026-06-27 -->
<!-- Previous plan: archive/PLAN-2026-06-27-b3-bundle-status-channel-resolution.md -->

## What

Fix the OpenCode plugin runtime defects that make every hook event dead
or routed to v2 after migration: rewire hook handlers to the v3 npm
entrypoint, make app-home resolution recognize the v3 npm bundle via v3
bundle evidence (not v2 probes matching by coincidence), verify
setProfileDir uses the v3 canonical AGENTERA_PROFILE_DIR name, verify the
doctor catches the deprecated profile-dir env var, and add a persistent
doctor check that catches the profile-dir schema-literal breakage in the
installed plugin source as a recurring health check.

## Tasks

1. Verify OpenCode hooks route through v3 npm entrypoint with no v2-script fallback (#7) — **complete**
2. Replace vestigial v2 probes in isRunnableAgenteraAppRoot/resolveAgenteraHome with v3 bundle-evidence recognition (#8) — **complete**
3. Verify setProfileDir uses v3 canonical AGENTERA_PROFILE_DIR name (#24) — **complete**
4. Verify doctor OpenCode profile-dir check catches deprecated env var (#36) — **complete**
5. Add persistent doctor check that catches the profile-dir schema-literal breakage (#38) — **complete**
6. Build, typecheck, test, validate, and compact — **complete**

## Overall Acceptance

All 6 tasks complete. All five defects (#7, #8, #24, #36, #38) are
resolved. OpenCode hooks route through the v3 npm entrypoint
(npx -y agentera@next) with no residual uv-run/Python-managed-entrypoint
fallback in the plugin (#7). App-home resolution recognizes a v3
npm-bundled app via v3 bundle evidence, not via v2 probes matching by
coincidence (#8). setProfileDir uses the v3 canonical
AGENTERA_PROFILE_DIR name; the legacy PROFILERA_PROFILE_DIR is only a
one-time migration bridge whose full removal is tracked as a separate
v3.0.0-stable chore (#24). The doctor catches the deprecated env var
(#36) AND catches the schema-literal breakage in the installed plugin
source as a recurring health check (#38). 1064 vitest tests pass (up
from 1034, +30 new). Typecheck, build, validate, and compact all green.

## Collapsed defects

Defects #7, #8, #24, #36, #38 from the v2/v3 coexistence defects
report are resolved by this batch. See
docs/notes/v2-v3-coexistence-defects.md batch plan.
