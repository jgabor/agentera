# Agentera CLI

Native TypeScript CLI for Agentera 3.0, published as
[`agentera`](https://www.npmjs.com/package/agentera). The npm package is
self-contained: compiled commands live in `dist/` and runtime data, manifests,
hooks, agents, skills, contracts, and documentation live in `bundle/`.

Until the stable dist-tag is promoted, run 3.0 through `@next`:

```bash
npx -y agentera@next prime --format json
npx -y agentera@next doctor --format json
```

`prime --format json` returns a bounded decision brief (at most 12000 UTF-8
bytes); use `prime --dashboard --format json` for the full orientation payload.
Status startup is one call: `prime --context status --format json` returns
`capability_context.instructions` and bounded
`capability_context.context.status_context` together (at most 25000 UTF-8
bytes). Omitted detail names its authoritative recovery command. `doctor`
returns detailed read-only evidence and exact user actions.

## Runtime lifecycle

The four active runtimes are OpenCode, Codex, Cursor, and GitHub Copilot; their
IDs are exactly `opencode`, `codex`, `cursor`, and `copilot`.
Cursor Agent CLI and Cursor IDE are surfaces of one `cursor` identity; CLI is
required and IDE is conditional. The canonical shared skill path is
`~/.agents/skills/agentera`.

```bash
npx -y agentera@next upgrade --dry-run --channel development
npx -y agentera@next upgrade --runtime all --dry-run
npx -y agentera@next upgrade --runtime all --yes
```

On v3 development, the selector-free dry-run previews all active runtimes.
Use one active ID instead of `all` to scope runtime work. A selector-free apply
remains app-only; runtime apply requires the selector and `--yes`. `--dry-run`
has zero filesystem or state side effects. `--yes` approves only declared
Agentera-owned operations; native install/update, authentication, enablement,
and trust remain user-owned. Secure automatic apply is Linux-only and reports
`action_required` elsewhere.

Retired Claude cleanup is intentionally separate:

```bash
npx -y agentera@next upgrade --legacy-cleanup claude --dry-run
```

It can remove only the exact Agentera-owned legacy link. Historical transcript
import is also explicit (`agentera report refresh --import-source claude`) and
is excluded from default active-runtime analytics.

## Bounded state retrieval

The executable contract is
[`references/artifacts/state-storage-authority.yaml`](../../references/artifacts/state-storage-authority.yaml)
and is projected by `agentera schema --format json`.

```bash
agentera state plan list --format json
agentera state plan get --plan PLAN_ID --format json
agentera state plan tasks list --limit 20 --format json
agentera state experiments list --objective OBJECTIVE_ID --format json
agentera state experiments get --objective OBJECTIVE_ID --number N --format json
```

Pages use opaque snapshot cursors, explicit omission fields, whole-entry output
bounds, and exact retrieval. Plan history is owned by active/archive plan files;
plan task retrieval is active-only. Experiment history is objective-scoped and
reports full, summary-only, or unavailable detail without fabricating archives.

See [UPGRADE.md](../../UPGRADE.md) for ownership, recovery, and migration
details and [runtime feature parity](../../references/adapters/runtime-feature-parity.md)
for host-specific behavior.

## Contributors

Requires Node.js 22+ and pnpm 10.30.3.

```bash
pnpm -C packages/cli test
pnpm -C packages/cli run typecheck
pnpm -C packages/cli build
pnpm -C packages/cli run lint
```

Use `npm pack --dry-run --json --ignore-scripts` after `build` and
`bundle:data` to inspect the exact publication surface. Do not publish from a
normal development or capability cycle.
