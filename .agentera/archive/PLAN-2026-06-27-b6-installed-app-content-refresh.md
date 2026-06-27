# Plan: v2/v3 coexistence B6 — Installed-app content refresh on upgrade

<!-- Level: full | Created: 2026-06-27 | Status: complete | Archived: 2026-06-27 -->
<!-- Previous plan: archive/PLAN-2026-06-27-b5-runtime-hooks-consistency.md -->

## What

Fix the installed-app content so that on upgrade, the managed app home
ships v3 content (SKILL.md, protocol.yaml, contract, schemas, hooks)
instead of stale v2 copies. B1 fixed the runtime path so the v3 CLI
reads v3 sources from the repo; B6 fixes the installed app so it also
has v3 content for when the CLI falls back to the app home. Add a
content-refresh step to the upgrade planner, verify all installed
surfaces are v3 English (not Swedish), pin the npmParityMatrix oracle
to main with a drift gate, retire v2 installed hooks, and guard against
instructions.md dead-weight shipping.

## Tasks

1. Add installed-app content refresh step and stale-surface gap detector (#11) — **complete**
2. Verify installed SKILL.md post-upgrade is v3 English routing surface (#4) — **complete**
3. Verify installed contract is v3 (instructions.ts per D65, English ROUTE_ALIASES per D70) (#13) — **complete**
4. Verify installed artifact schemas use English producer/consumer and v3 validation limits (#12) — **complete**
5. Verify installed protocol.yaml has English SKILL_GLYPHS/PHASES (#28) — **complete**
6. Pin npmParityMatrix oracle to main and wire rebase_oracle.sh --check into CI/precommit drift gate (#34) — **complete**
7. Retire v2 installed hooks on upgrade and rewire pre-upgrade active hook configs (#35) — **complete**
8. Strip instructions.md dead weight from installed bundle, guard copy-bundle.mjs, build/typecheck/test/validate/compact (#43) — **complete**

## Overall Acceptance

All 8 tasks complete. All eight defects (#4, #11, #12, #13, #28, #34, #35, #43) are resolved. The upgrade planner includes a content-refresh
step that copies v3 repo source (skills/, references/, registry.json,
dist/capabilities) to the managed app home, superseding stale v2 content.
A stale-surface gap detector surfaces refresh items during --dry-run.
Installed SKILL.md routes English names (#4). Installed contract
references instructions.ts with English ROUTE_ALIASES (#13). Installed
artifact schemas use English producer/consumer and v3 limits (#12).
Installed protocol.yaml has English SKILL_GLYPHS/PHASES (#28).
npmParityMatrix oracle pin is tracked against main with a drift gate
(#34). V2 installed hooks are retired on upgrade and active configs
rewired (#35). instructions.md dead weight is guarded against (#43).
1107 vitest tests pass (up from 1034, +73 new). Typecheck, build,
validate, and compact all green.

## Collapsed defects

Defects #4, #11, #12, #13, #28, #34, #35, #43 from the v2/v3 coexistence
defects report are resolved by this batch. See
docs/notes/v2-v3-coexistence-defects.md batch plan.
