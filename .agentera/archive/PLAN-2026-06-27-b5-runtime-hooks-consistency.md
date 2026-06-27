# Plan: v2/v3 coexistence B5 — Runtime hooks consistency

<!-- Level: full | Created: 2026-06-27 | Status: complete | Archived: 2026-06-27 -->
<!-- Previous plan: archive/PLAN-2026-06-27-b4-opencode-plugin-rewire.md -->

## What

Close the runtime-hooks-consistency defect batch. Unify repo hook npm
tags to npx -y agentera@next so no hook file silently resolves to the
v2 @latest shim. Align the Codex validator command with the v3 npx
entrypoint instead of a hardcoded uv-run Python path. Correct repo
template hook descriptions that claim v2 while invoking v3 entrypoints.
Add project-level Codex config detection to the upgrade migration
planner so it mirrors the Cursor planner. Clarify which runtime each
repo hook file targets and that each uses that runtime canonical event
names. Compute the CI L2 npm pin dynamically from
packages/cli/package.json and fail loud (not silent skip) when the
pinned version is unpublished. Fix the pre-commit staged-aware runner
so scripts/sandbox path changes route to the full vitest suite, not the
2-smoke branch.

## Tasks

1. Unify repo hook npm tags to npx -y agentera@next (#23) — **complete**
2. Align codexValidatorCommand with v3 npx entrypoint (#25) — **complete**
3. Correct repo template hook descriptions to reflect v3 (#26) — **complete**
4. Add Codex project-level config detection in planCodexItems (#27) — **complete**
5. Clarify hook event names and target runtime per hook file (#41) — **complete**
6. Compute CI L2 npm pin dynamically and fail loud on unpublished (#44, G6) — **complete**
7. Route scripts/sandbox path changes to full vitest in pre-commit (G5) — **complete**
8. Build, typecheck, test, validate, and compact — **complete**

## Overall Acceptance

All 8 tasks complete. All six defects (#23, #25, #26, #27, #41, #44)
and both test gaps (G5, G6) are resolved. Repo hook npm tags are unified
to npx -y agentera@next across all hook files (#23).
codexValidatorCommand delegates to CODEX_HOOK_COMMAND
(npx -y agentera@next hook validate-artifact), no uv-run Python path
(#25). Repo template hook descriptions reflect v3, not v2 (#26).
planCodexItems detects both project-level and home-level .codex
configs, mirroring planCursorItems (#27). Each repo hook file targets
exactly one runtime and uses that runtime canonical event names, with
the target runtime unambiguous (#41). CI L2 npm pin is computed
dynamically from packages/cli/package.json and fails loud (non-zero,
clear message) when unpublished, closing both #44 and G6. Pre-commit
routes scripts/sandbox path changes to the full vitest suite, not
2-smoke (G5). 1088 vitest tests pass (up from 1034, +54 new). Typecheck,
build, validate, and compact all green.

## Collapsed defects

Defects #23, #25, #26, #27, #41, #44 and test gaps G5, G6 from the
v2/v3 coexistence defects report are resolved by this batch. See
docs/notes/v2-v3-coexistence-defects.md batch plan.
