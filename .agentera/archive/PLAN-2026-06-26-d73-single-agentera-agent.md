# Plan: Ship single Agentera agent (D73)

<!-- Level: full | Created: 2026-06-26 | Status: complete | Archived: 2026-06-26 -->
<!-- Decision: Decision 73 (firm) -->
<!-- Reviewed: 2026-06-26 | Critic issues: 5 found, 5 addressed, 0 dismissed -->
<!-- Implementation: d1b4145d feat: replace per-capability subagents with single Agentera agent (D73) -->

## What

Replace 12 per-capability managed subagents (audit.md, build.md, design.md,
etc.) with a single primary agent named "Agentera" (agentera.md) for both
OpenCode and Cursor runtimes. The Agentera agent loads the skill for routing,
fetches capability prose via the CLI, and dispatches to the runtime built-in
general subagent for execution with the prose as the task prompt. Body is
minimal (dispatch mechanism only; no routing logic duplication).

## Why

D65 made per-capability subagents redundant. They are fetch-and-execute
wrappers around CLI-served prose. A single agent eliminates the collision
where Agentera build.md and plan.md clobber OpenCode built-in Build and
Plan agents (doom_loop, plan_exit, plan_enter permissions). D73 resolved
the design. Broad permissions (write+bash allow), Task dispatch to general
subagents, minimal body, routing stays in SKILL.md.

## Constraints

- Must not clobber OpenCode built-in Build and Plan agents in user config dirs.
- Cross-runtime scope is OpenCode and Cursor only. Claude, Codex, and Copilot have no managed agents.
- Routing logic stays in SKILL.md (D65).
- Branch is feat/v3.
- Do not touch the v2-to-v3 upgrade cleanup of stale Swedish-verb agents (separate TODO).
- Do not touch vision.yaml or objective state.
- Do not modify the Cursor v3 skip condition behavior for external projects.

## Scope

Included:

- `.opencode/agents/` — create agentera.md, remove 12 per-capability files
- `.cursor/agents/` — create agentera.md, remove 12 per-capability files
- `packages/cli/src/upgrade/runtimeMigration.ts` — restrict copy-agent loop
- `packages/cli/test/upgrade/cursorAgentSurface.test.ts` — rewrite for single agent
- `skills/agentera/SKILL.md` — update handoff and agent dispatch language

Excluded:

- v2-to-v3 upgrade cleanup of stale Swedish-verb agents (TODO line 35)
- `.claude-plugin/`, `.codex-plugin/`, `.cursor-plugin/` description text
- `.agentera/vision.yaml`, objective state
- Cursor skip condition logic for external projects

Deferred:

- Cleanup of stale Swedish-verb agents in user config dirs (TODO line 35)

## Design

Two phases. First create the replacement agent, then remove the old surface
and update the distribution and test layers. Creation establishes the
replacement before removal eliminates the old surface. The distribution
surface (copy loop) is updated to sync only agentera.md so future non-managed
md files are not accidentally copied. Tests are rewritten last to reflect
the final single-agent state. SKILL.md handoff language tracks the change
throughout.

## Tasks

1. Create agentera.md for OpenCode and Cursor — **complete**
2. Remove 12 per-capability agent files from both runtimes — **complete**
3. Update runtimeMigration.ts copy loop and verify Cursor skip condition — **complete**
4. Rewrite cursorAgentSurface.test.ts and update SKILL.md — **complete**
5. Build, typecheck, test, validate, and compact — **complete**

## Overall Acceptance

All tasks complete. The repository `.opencode/agents/` and `.cursor/agents/`
each contain only `agentera.md`. A dry-run upgrade preview shows copy-agent
items referencing only `agentera.md` for OpenCode and Cursor agents skipped
(v3 skip condition). OpenCode built-in `build.md` and `plan.md` in user
config dirs are not clobbered. `pnpm -C packages/cli run typecheck` and
`pnpm -C packages/cli build` both succeed. `pnpm -C packages/cli test`
passes in full. `node packages/cli/dist/bin/agentera.js check validate
capability-contract --format json` passes. `node packages/cli/dist/bin/agentera.js
check compact` reports no budget regression.

## Notes

Implementation landed in commit `d1b4145d` without the plan-artifact fold-in
(task statuses left as `pending`, plan not archived). This archive remediates
the missed fold-in — verified complete via working-tree inspection of all five
tasks' acceptance criteria. SKILL.md required no changes (already consistent
with the single-agent model).
