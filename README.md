<div align="center">
<pre>
┌─┐┌─┐┌─┐┌┐┌┌┬┐┌─┐┬─┐┌─┐
├─┤│ ┬├┤ │││ │ ├┤ ├┬┘├─┤
┴ ┴└─┘└─┘┘└┘ ┴ └─┘┴└─┴ ┴
</pre>

<strong>One agent, one CLI, many capabilities.</strong>
</div>

Agentera is a project-memory and workflow layer for coding agents. It keeps
direction, plans, decisions, progress, documentation state, and health evidence
in the repository so work can continue across sessions and runtimes.

## Get started

Agentera 3.0 is the self-contained TypeScript package on npm. Before the stable
dist-tag promotion, use `@next`; after promotion, the same commands work with
`agentera@latest` or an installed `agentera` binary.

```bash
npx -y agentera@next prime
```

Run that from a git project. In an editor runtime, invoke `/agentera`
(`$agentera` in Codex) for the rendered status dashboard.

`prime` is deliberately bounded: it summarizes current project state and the
next useful action. Use `doctor` when you need app, project-state, shared-skill,
and CLI evidence.

```bash
npx -y agentera@next prime --format json
npx -y agentera@next doctor --format json
```

## Runtime integration

Agentera 3.0 uses one portable integration for compatible runtimes: the shared
skill at `~/.agents/skills/agentera` plus the Agentera CLI. Normal `upgrade`
previews and applies only app/project migration; it has no current-runtime
selector and creates no native plugin, hook, agent, command, descriptor, or
marketplace file. See [UPGRADE.md](./UPGRADE.md) for the distinct one-way v2
migration and explicit retired Claude cleanup route:
`agentera upgrade --legacy-cleanup claude --dry-run|--yes`.

`doctor` reports read-only app, project-state, shared-skill, and CLI evidence.
`prime`, status, and project-integration output use the app/project recommendation
and shared-skill diagnosis to select the next action.

Claude Code is retired from active support. Its only lifecycle command is a
separate, explicit cleanup of the exact Agentera-owned legacy skill link:

```bash
npx -y agentera@next upgrade --legacy-cleanup claude --dry-run
npx -y agentera@next upgrade --legacy-cleanup claude --yes
```

Historical Claude transcripts are excluded by default. A local import requires
explicit `--import-source claude` consent, records historical provenance, and
does not create an active runtime identity.

## Project state

Agentera resolves artifact paths through the CLI and `.agentera/docs.yaml`.
Normal reads use `agentera state`; supported writes use the typed writer.

```bash
agentera state todo
agentera state plan
agentera state query --list-artifacts
agentera state progress explain --verb append --format json
```

Bounded collection retrieval uses stable identities, opaque snapshot cursors,
explicit omissions, and exact detail commands. The runtime contract is
[`references/artifacts/state-storage-authority.yaml`](./references/artifacts/state-storage-authority.yaml).

```bash
agentera state plan list --format json
agentera state plan get --id PLAN_ID --format json
agentera state plan tasks list --limit 20 --format json
agentera state experiments list --objective OBJECTIVE_ID --format json
agentera state experiments get --objective OBJECTIVE_ID --id EXPERIMENT_ID --format json
```

Plan list/get spans the active plan and immutable plan archives. Plan task
list/get is active-plan-only. Experiment retrieval merges its bounded projection
with objective-owned immutable archives and reports detail as full, summary-only,
or unavailable.

Ordinary mutable state uses one canonical file per entity. Every public record
has only `id` and `artifact` identity, and is accessed through bounded `list`,
exact `get --id`, and typed `agentera state <artifact> explain` write contracts.
Do not edit files under `.agentera/entities/` directly.

The intentional singleton project state is:

- `.agentera/vision.yaml` — product direction
- `.agentera/docs.yaml` — documentation policy and path/version mappings
- `TODO.md`, `CHANGELOG.md`, and `DESIGN.md` — human-facing project artifacts

## Capabilities

| | Capability | Use it when you need... |
| --- | --- | --- |
| ⌂ | status | Project briefing and next best action |
| ⛥ | vision | Product direction |
| ❈ | discuss | Structured deliberation |
| ⬚ | research | External pattern analysis |
| ≡ | plan | Scoped plan with acceptance criteria |
| ⧉ | build | One verified development cycle |
| ⎘ | optimize | Metric-driven optimization |
| ▤ | document | Documentation aligned with code |
| ◰ | design | Visual identity and design tokens |
| ⛶ | audit | Architecture and project health audits |
| ♾ | profile | Reusable decision profile |
| ⎈ | orchestrate | Autonomous plan execution with evaluation |

## Monorepo

| Package | Role |
| --- | --- |
| `packages/cli` (`agentera`) | Primary TypeScript CLI and bundled runtime data |
| `packages/web` (`@agentera/web`) | Marketing and Starlight documentation site |
| `packages/mobile` (`@agentera/mobile`) | Docs-only mobile product stub |

Contributor commands and repository rules live in [AGENTS.md](./AGENTS.md).
Migration and recovery details live in [UPGRADE.md](./UPGRADE.md).

```bash
pnpm -C packages/cli test
pnpm -C packages/cli run typecheck
pnpm -C packages/cli build
vp run web:check
```

License: [Apache-2.0](./LICENSE) · Author: Jonathan Gabor
