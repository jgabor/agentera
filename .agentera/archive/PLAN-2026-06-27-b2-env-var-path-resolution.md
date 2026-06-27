# Plan: v2/v3 coexistence B2 — env-var & path resolution remainder

<!-- Level: full | Created: 2026-06-27 | Status: complete | Archived: 2026-06-27 -->
<!-- Previous plan: archive/PLAN-2026-06-26-b1-split-brain-root-cause.md -->

## What

Fix the remaining env-var and path-resolution defects that B1 did not cover:
restore the PROFILERA_PROFILE_DIR precedence fallback in v3 resolvers that
dropped it during the rename, widen the migration rewire to update
installed-app artifact path mappings and schema literals, unify
XDG_DATA_HOME tilde expansion across all resolvers, align the docs.yaml
schema documentation with resolver support, fix startupBenchmarkDir to accept
caller-provided env, and fix the install-root precedence to include the
profile layer. Close test gaps G1, G2, G4.

## Tasks

1. Restore PROFILERA_PROFILE_DIR fallback in v3 env-var resolvers — **complete**
2. Widen rewireProfileraEnvVar to update installed-app artifact path mappings — **complete**
3. Unify XDG_DATA_HOME tilde expansion across all resolvers — **complete**
4. Align docs.yaml schema documentation with resolver support — **complete**
5. Fix startupBenchmarkDir to accept caller-provided env — **complete**
6. Fix install-root precedence profile layer and visibleSkillVersion v2 residue — **complete**
7. Close test gaps G1, G2, G4 — **complete**
8. Build, typecheck, test, validate, and compact — **complete**

## Overall Acceptance

All 8 tasks complete. All v3 resolvers that read AGENTERA_PROFILE_DIR also
check PROFILERA_PROFILE_DIR as a lower-precedence fallback. The migration
rewire updates installed-app artifact path mappings and schema literals.
XDG_DATA_HOME tilde expansion is unified across all resolvers. docs.yaml
schema documentation matches resolver support. startupBenchmarkDir accepts
caller-provided env. Install-root precedence includes the profile layer;
visibleSkillVersion no longer probes v2 residue. Test gaps G1, G2, G4 are
closed. 1027 vitest tests pass (up from 1016, +11 new). Typecheck, build,
validate, and compact all green.

## Collapsed defects

Defects #14, #15, #16, #21, #29, #30 from the v2/v3 coexistence defects
report are resolved by this batch. Test gaps G1, G2, G4 are closed. See
docs/notes/v2-v3-coexistence-defects.md batch plan.
