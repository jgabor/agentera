# Upgrade repair wording

## Runtime migration boundary

Recognized v2-to-v3 project migration rewires existing Agentera v2 hook
configurations to the npm CLI and retires only proven Agentera-owned legacy hook
files. It does not copy or refresh plugins, agents, commands, or skill links.

Runtime lifecycle installation and remediation are separate. Apply requires an
explicit `--runtime` selector and `--yes`; declared ownership, collision
remediation, and convergent retry behavior remain governed by `UPGRADE.md`.

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
