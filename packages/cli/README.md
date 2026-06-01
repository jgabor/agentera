# Agentera CLI (npm)

Native TypeScript CLI for Agentera 3.x, published as [`agentera`](https://www.npmjs.com/package/agentera).

| Dist tag | Channel | Use for |
| --- | --- | --- |
| `@latest` | stable (2.x) | Supported production line |
| `@next` | development (3.x pre-releases) | Early testing of the self-contained npm CLI |

## Quick start

```bash
npx -y agentera@next prime --format json
npx -y agentera@next upgrade --dry-run --channel development
```

Run those from a project root. `prime` reports `project_integration.recommendation`
(`stay` or `upgrade`) and suggested commands for the current repo.

Full preview instructions, highlights, and migration paths:
[repository README — Agentera 3.0 preview](../../README.md#agentera-30-preview).

Upgrade channels and v2→v3 opt-in: [`UPGRADE.md`](../../UPGRADE.md).

## Package layout

- `dist/` — compiled CLI (`agentera` bin)
- `bundle/` — shipped app data (`skills/`, `references/`, `registry.json`)

Requires Node.js 22+.

## Contributors

Build and test from the monorepo:

```bash
pnpm -C packages/cli build
pnpm -C packages/cli test
pnpm -C packages/cli run publish:dev   # publishes with @next tag
```

See [`AGENTS.md`](../../AGENTS.md) for capability validation and commit conventions.
