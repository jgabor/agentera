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
npx -y agentera@next prime --context status
```

Run that from a git project. In an editor runtime, invoke `/agentera`
(`$agentera` in Codex) for the rendered status dashboard.

This is the pre-cutover bootstrap. One `@next` call returns the status
instructions, a bounded startup outcome, and any exact recovery command. A fresh
Git project is `fresh_uninitialized`: `prime --context plan` is operable and its
first typed `state plan create` initializes state. Recognized v2 uses the full
development-channel entity upgrade; partial, corrupt or unknown state stays
blocked behind read-only recovery. A v3 project returns `ok` when no independent health degradation
applies and needs no fallback or second dashboard call. Do not substitute bare
or stable-channel CLI forms; those can resolve stable v2 until promotion.

Use the same channel for a separate read-only doctor probe when you need full
app, project-state, shared-skill, and CLI evidence:

```bash
npx -y agentera@next doctor
```

## Runtime integration

Agentera 3.0 uses one portable integration for compatible runtimes: the shared
skill at `~/.agents/skills/agentera/SKILL.md` plus the Agentera CLI. The host
directory contains only that file; runtime schemas and references stay inside
the package. For an outdated supported installation, `prime` and `doctor` return
one update offer. Answer Yes once; the host runs the CLI-provided command without
asking about technical details. No or no answer changes nothing. Older directories
and symlinks need no historical ownership journal or per-file approval.
See [UPGRADE.md](./UPGRADE.md#one-file-shared-skill-installation-and-repair) for
commands, Linux apply limits, retained data and bounded recovery. No route
prunes through a host symlink or automatically repairs during diagnosis.

No OpenCode gate or `hook` command replaces the retired plugin. Project-only
migration does not mutate global host resources. App/global retirement requires
explicit scope and ownership; unproven files remain for manual review. The
upgrade guide separates shared-skill repair, one-way v2 migration and cleanup.
Approved app/global migration retires a proven historical OpenCode plugin with
no separate cleanup selector; unproven resources remain for manual review.

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

## CLI-only discovery

Start with `npx -y agentera@next schema` for the command and contract inventory.
Use `schema --artifact NAME`, `schema --protocol`, or
`schema --capability-contract` for construction and authoring details;
`prime --context NAME --detail instructions|artifacts|validation|exit|worker`
selects capability guidance. `route explain`, `report explain`, `check explain`
and `upgrade --explain` expose their purpose-owned contracts.

Follow returned section selectors and `next_command` until the needed detail is
complete. Pages are bounded; an index is not the whole contract. Static detail
works without project state and grants no execution, history or mutation consent.
Operational output defaults to JSON (the format selector also accepts JSON); help,
version and `prime --guidance` are text exceptions without format selectors.

## Project state

Agentera resolves artifact paths through the CLI and `.agentera/docs.yaml`.
Normal reads use the state namespace; supported writes use the typed writer.

```bash
npx -y agentera@next state todo list
npx -y agentera@next state plan list --status open
npx -y agentera@next state query --list-artifacts
npx -y agentera@next state progress explain --verb append
```

Bounded collection retrieval uses stable identities, opaque snapshot cursors,
explicit omissions, and exact detail commands. The runtime contract is
[`references/artifacts/state-storage-authority.yaml`](./references/artifacts/state-storage-authority.yaml).

```bash
npx -y agentera@next state plan list
npx -y agentera@next state plan get --id PLAN_ID
npx -y agentera@next state plan tasks list --limit 20
npx -y agentera@next state experiments list --objective OBJECTIVE_ID
npx -y agentera@next state experiments get --id EXPERIMENT_ID
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

Use the canonical daily Vite+ contributor commands in
[AGENTS.md](./AGENTS.md#common-commands). Migration and recovery details live
in [UPGRADE.md](./UPGRADE.md).

License: [Apache-2.0](./LICENSE) · Author: Jonathan Gabor
