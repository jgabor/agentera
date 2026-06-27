# Plan: v2/v3 coexistence B7 — v2 residue cleanup & minor fixes

<!-- Level: full | Created: 2026-06-27 | Status: complete | Archived: 2026-06-27 -->
<!-- Previous plan: archive/PLAN-2026-06-27-b6-installed-app-content-refresh.md -->

## What

Close the final v2/v3 coexistence defect batch. Remove orphaned
Swedish-verb agents on upgrade, fix Cursor doctor hooks/agents path
probing to use project/user-level paths, catalog custom profile/config-dir
artifacts in the v2-to-v3 handoff, surface the v3 successor to v2 install
tracks, deduplicate CAPABILITY_NAMES to a single source, verify-and-lock
hasManagedBundleEvidence v3-awareness, fix pending_runtime to count
runtimes not items, and replace volatile TODO line-number references
with stable identifiers.

## Tasks

1. Remove orphaned Swedish-verb agents on upgrade (#20) — **complete**
2. Fix Cursor doctor hooks/agents path probing (#22) — **complete**
3. Catalog custom profile/config-dir artifacts in the v2-to-v3 handoff (#31) — **complete**
4. Surface v3 successor to v2 install tracks (#32) — **complete**
5. Deduplicate CAPABILITY_NAMES to a single source (#33) — **complete**
6. Verify-and-lock hasManagedBundleEvidence v3-awareness (#37) — **complete**
7. Fix pending_runtime to count runtimes, not items (#40) — **complete**
8. Replace volatile TODO line-number references with stable identifiers (#42) — **complete**

## Overall Acceptance

All 8 tasks complete. All eight defects (#20, #22, #31, #32, #33, #37, #40, #42) are resolved. The upgrade cleanup phase removes the 12
orphaned Swedish-verb agents from .cursor/agents/ and .opencode/agents/
(#20). Cursor doctor probes project + user-level .cursor/hooks.json and
agents/ paths, not the v2 installRoot bundle path (#22). The v2-to-v3
handoff catalogs custom PROFILERA_PROFILE_DIR and runtime-config-dir
artifacts (#31). V2 install tracks surface the v3 successor line in
doctor/prime output (#32). CAPABILITY_NAMES is derived from
Object.keys(CAPABILITY_INSTRUCTIONS), eliminating drift risk (#33).
hasManagedBundleEvidence checks the v3 BUNDLE_MARKER first with the v2
fallback documented (#37). pending_runtime counts distinct runtimes,
not migration items (#40). Volatile TODO line-number references in
active artifacts are replaced with stable identifiers (#42). 1145
vitest tests pass (up from 1107, +38 new). Typecheck, build, validate,
and compact all green.

## Collapsed defects

Defects #20, #22, #31, #32, #33, #37, #40, #42 from the v2/v3
coexistence defects report are resolved by this batch. See
docs/notes/v2-v3-coexistence-defects.md batch plan. This is the final
batch — all 44 defects across 7 batches (B1-B7) are now resolved.
