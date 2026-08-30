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
the stable npm channel or an installed CLI binary.

```bash
npx -y agentera@next prime --context status --format json
```

Run that from a git project. In an editor runtime, invoke `/agentera`
(`$agentera` in Codex) for the rendered status dashboard.

This is the pre-cutover bootstrap. One `@next` call returns the status
instructions, a bounded startup outcome, and any exact recovery command. Clean,
v2, and partially migrated projects return `blocked` with
`state_cutover.recovery_command` set to the full development-channel entity
upgrade. A v3 project returns `ok` when no independent health degradation
applies and needs no fallback or second dashboard call. Do not substitute bare
or stable-channel CLI forms; those can resolve stable v2 until promotion.

Use the same channel for a separate read-only doctor probe when you need full
app, project-state, shared-skill, and CLI evidence:

```bash
npx -y agentera@next doctor --format json
```

## Runtime integration

Agentera 3.0 uses one portable integration for compatible runtimes: the shared
skill at `~/.agents/skills/agentera` plus the Agentera CLI. No OpenCode gate or
`hook` command replaces the retired plugin. Normal `upgrade` automatically
previews and removes a proven Agentera-installed copy of that plugin, with no
separate cleanup selector. It preserves unproven files for manual review. See
[UPGRADE.md](./UPGRADE.md) for the distinct one-way v2 migration and the
explicit cleanup route for other retired native resources.

`doctor` reports read-only app, project-state, shared-skill, and CLI evidence.
`prime`, status, and project-integration output use the app/project recommendation
and shared-skill diagnosis to select the next action.

Supported hosts use the canonical shared skill and CLI. Full and focused cleanup
require preview and explicit approval. For declared Codex descriptors, OpenCode
agents, and OpenCode commands, the exact managed marker declares Agentera ownership;
removing it opts out, and marker text in unrelated resources does not qualify. This
behavior is supported by the development package. Claude is retired:

```bash
npx -y agentera@next upgrade --legacy-cleanup claude.agentera-skill-link --dry-run
npx -y agentera@next upgrade --legacy-cleanup claude.agentera-skill-link --yes
```

Historical Claude transcripts are excluded by default. A local import requires
explicit `--import-source claude` consent, records historical provenance, and
does not create an active runtime identity.

## Project state

Agentera resolves artifact paths through the CLI and `.agentera/docs.yaml`.
Normal reads use the state namespace; supported writes use the typed writer.

```bash
npx -y agentera@next state todo list --format json
npx -y agentera@next state plan list --status open --format json
npx -y agentera@next state query --list-artifacts
npx -y agentera@next state progress explain --verb append --format json
```

Bounded collection retrieval uses stable identities, opaque snapshot cursors,
explicit omissions, and exact detail commands. The runtime contract is
[`references/artifacts/state-storage-authority.yaml`](./references/artifacts/state-storage-authority.yaml).

```bash
npx -y agentera@next state plan list --format json
npx -y agentera@next state plan get --id PLAN_ID --format json
npx -y agentera@next state plan tasks list --limit 20 --format json
npx -y agentera@next state experiments list --objective OBJECTIVE_ID --format json
npx -y agentera@next state experiments get --id EXPERIMENT_ID --format json
```

Plan list/get spans the active plan and immutable plan archives. Plan task
list/get is active-plan-only. Experiment retrieval merges its bounded projection
with objective-owned immutable archives and reports detail as full, summary-only,
or unavailable.

Ordinary mutable state uses one canonical file per entity. Every public record
has only `id` and `artifact` identity, and is accessed through bounded `list`,
exact `get --id`, and typed `npx -y agentera@next state <artifact> explain` write contracts.
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

## Package

| Package | Role |
| --- | --- |
| `packages/cli` (`agentera`) | Primary TypeScript CLI and bundled runtime data |

Contributor commands and repository rules live in [AGENTS.md](./AGENTS.md).
Migration and recovery details live in [UPGRADE.md](./UPGRADE.md).

```bash
pnpm -C packages/cli test
pnpm -C packages/cli run typecheck
pnpm -C packages/cli build
```

License: [Apache-2.0](./LICENSE) · Author: Jonathan Gabor
