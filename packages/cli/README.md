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

`prime` returns a bounded project and four-runtime lifecycle summary. `doctor`
returns detailed read-only evidence and exact user actions.

## Runtime lifecycle

The four active runtimes are OpenCode, Codex, Cursor, and GitHub Copilot; their
IDs are exactly `opencode`, `codex`, `cursor`, and `copilot`.
Cursor Agent CLI and Cursor IDE are surfaces of one `cursor` identity; CLI is
required and IDE is conditional. The canonical shared skill path is
`~/.agents/skills/agentera`.

```bash
npx -y agentera@next upgrade --runtime all --dry-run
npx -y agentera@next upgrade --runtime all --yes
```

Use one active ID instead of `all` to scope the operation. `--dry-run` has zero
filesystem or state side effects. `--yes` approves only declared Agentera-owned
operations; native install/update, authentication, enablement, and trust remain
user-owned. Secure automatic apply is Linux-only and reports
`action_required` elsewhere.

Retired Claude cleanup is intentionally separate:

```bash
npx -y agentera@next upgrade --legacy-cleanup claude --dry-run
```

It can remove only the exact Agentera-owned legacy link. Historical transcript
import is also explicit (`agentera report refresh --import-source claude`) and
is excluded from default active-runtime analytics.

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
