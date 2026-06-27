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

## v2 install track successor surfacing (#32)

When a **v2-classified** managed app-home (`install_track: v2`) runs the **v3 TypeScript
CLI** (`agentera doctor` / `agentera prime`), the next-major successor block must surface
the stable-line forward successor (`3.0.0` on the development channel) with the preview
command (`npx -y agentera@next upgrade --dry-run`) and the v2→v3 guide URL from
`references/cli/update-channels.yaml`. A v2 install must not be silently reported as
up to date against the v3 line.

| Surface | Branch | Behavior |
| --- | --- | --- |
| TypeScript (`packages/cli/src/upgrade/nextMajorDoctor.ts`, doctor/prime wiring) | `feat/v3` | Resolve successor from `channels.stable.next_major` for v2 installs; omit the block for v3 npm installs and feat/v3 source checkouts. |
| Python (`scripts/agentera_upgrade.py` doctor/prime writer) | `main` (stable) | Mirror the same v2-install successor block and preview command in stable-line doctor/prime output. Backport per the both-branch pattern; verify by round-trip parity with the v3 reader, not pytest in the feat/v3 worktree. |
