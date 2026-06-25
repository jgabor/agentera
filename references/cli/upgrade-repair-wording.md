# Upgrade repair wording — v3 cursor agent skip

When `agentera upgrade --runtime cursor` (or a full runtime phase) runs against a
**project** directory, managed `.cursor/agents/*.md` descriptors are normally
copied from the active app-home bundle. On a **v3 capability-surface** project
that signal is suppressed so D65 `prime --context` bodies are not regressed to
the retired `instructions.md` read path.

## v3 surface probe

Treat the project as v3 when **all twelve** instruction modules exist:

`packages/cli/src/capabilities/<name>/instructions.ts`

for every routed capability (`status`, `vision`, `discuss`, `research`,
`plan`, `build`, `optimize`, `audit`, `document`, `profile`,
`design`, `orchestrate`).

If any module is missing, preserve v2 upgrade behavior (copy/refresh managed
agents from the bundle).

## Orchestrator behavior

| Orchestrator | Branch | Behavior |
| --- | --- | --- |
| TypeScript (`packages/cli/src/upgrade/runtimeMigration.ts`) | `feat/v3` | On v3 probe match, emit `skipped` `copy-agent` items for in-tree `.cursor/agents/` instead of copying from the bundle. |
| Python (`scripts/agentera_upgrade.py`) | `main` (stable) | Same probe before the cursor agent copy loop; do not schedule `copy-agent` targets under the project when the probe matches. Backport per the both-branch pattern. |

## User-visible skip message

`v3 capability instruction modules present; in-tree .cursor/agents/ uses prime --context and is not overwritten`
