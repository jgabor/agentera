# Agentera CLI

Native TypeScript CLI for Agentera 3.0, published as
[`agentera`](https://www.npmjs.com/package/agentera). The npm package is
self-contained: compiled commands live in `dist/`; the canonical shared skill,
its schemas, required references, and `registry.json` live in `bundle/`. It
ships no host-native plugin, hook, command, agent, descriptor, or marketplace
surface.

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

## Shared-skill integration

Agentera uses one portable integration: the Agentera CLI plus the shared skill
at `~/.agents/skills/agentera`. Normal upgrade previews and applies app/project
migration only. It has no current-runtime selector and does not create native
runtime resources.

```bash
npx -y agentera@next upgrade --channel development --project "$PWD" --dry-run
npx -y agentera@next upgrade --channel development --project "$PWD" --yes
```

Preview has no side effects. The apply path is the explicit, one-way v2-to-v3
migration described in [UPGRADE.md](../../UPGRADE.md); it does not run a native
package installer.

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
agentera state plan get --id PLAN_ID --format json
agentera state plan tasks list --limit 20 --format json
agentera state experiments list --objective OBJECTIVE_ID --format json
agentera state experiments get --objective OBJECTIVE_ID --id EXPERIMENT_ID --format json
```

Pages use opaque snapshot cursors, explicit omission fields, whole-entry output
bounds, and exact retrieval. Plan history is owned by active/archive plan files;
plan task retrieval is active-only. Experiment history is objective-scoped and
reports full, summary-only, or unavailable detail without fabricating archives.

See [UPGRADE.md](../../UPGRADE.md) for ownership, recovery, and migration
details.

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
