<div align="center">
<pre>
┌─┐┌─┐┌─┐┌┐┌┌┬┐┌─┐┬─┐┌─┐
├─┤│ ┬├┤ │││ │ ├┤ ├┬┘├─┤
┴ ┴└─┘└─┘┘└┘ ┴ └─┘┴└─┴ ┴
</pre>

<strong>The open protocol for turning AI coding agents into an engineering team.</strong>

Agentera gives coding agents specialized roles, shared project artifacts,
behavioral verification gates, and portable saved context across runtimes.

<p>
<a href="#what-you-see">Try it</a> ·
<a href="#capabilities">Capabilities</a> ·
<a href="#how-it-works">How it works</a> ·
<a href="#get-started">Install</a> ·
<a href="#agentera-cli">CLI</a> ·
<a href="#troubleshooting">Troubleshooting</a>
</p>
</div>

## What you see

Run `/agentera` (`$agentera` in Codex) and get a project briefing that reads
your repo instead of guessing from chat history.

```text
┌─┐┌─┐┌─┐┌┐┌┌┬┐┌─┐┬─┐┌─┐
├─┤│ ┬├┤ │││ │ ├┤ ├┬┘├─┤
┴ ┴└─┘└─┘┘└┘ ┴ └─┘┴└─┴ ┴

─── status ─────────────────────────────

  ⛶ health    ⮉ B+ (testing: C)
  ⇶ issues    0 critical · 2 degraded · 5 annoying
  ≡ plan      [██████▓░░░] 6/10 tasks
  ♾ profile   loaded

  Shipped auth middleware and rate limiting last cycle.
  Health trending up, test coverage still lagging.

─── attention ──────────────────────────

  ⇉ test coverage below 60%, degrading since cycle 8
  ⇉ task 7 blocked on API schema decision

─── next ───────────────────────────────

  suggested → ❈ resonera (resolve API schema to unblock task 7)
```

The briefing pulls from many artifacts (plan, progress, decisions, health,
issues) but only the slices that matter right now. You get breadth without paying
for a full dump of project state on every turn.

## Get started

1. Install the Agentera CLI (see [Agentera CLI](#agentera-cli)) and pick your runtime below.
2. Open a git project (existing repo or new).
3. Run `/agentera` (`$agentera` in Codex) or `npx -y agentera@next prime`.

Your first briefing bootstraps `.agentera/` as capabilities run.

**Agentera 3.x** ships as a self-contained npm TypeScript CLI. Use
`npx -y agentera@next` on the development channel today; the 3.0 cutover
graduates that line to `npx -y agentera@latest`. The current `@latest` tag
remains the Python-backed 2.x support line until that publish.

Optional: build a Bun-compiled single-binary with
`bash scripts/single-binary.sh` after `pnpm -C packages/cli build` (see
[`docs/packaging/v3-packaging.md`](./docs/packaging/v3-packaging.md)).

<details>
<summary><strong>Claude Code</strong></summary>

```bash
npx skills add jgabor/agentera -g -a claude-code --skill agentera -y
```

</details>

<details>
<summary><strong>OpenCode</strong></summary>

Install the skill and the plugin (both steps):

```bash
npx skills add jgabor/agentera -g -a opencode --skill agentera -y
mkdir -p ~/.config/opencode/plugins
curl -fsSL https://raw.githubusercontent.com/jgabor/agentera/main/.opencode/plugins/agentera.js \
  -o ~/.config/opencode/plugins/agentera.js
```

OpenCode also routes a bare message `hej` to the same dashboard.

</details>

<details>
<summary><strong>Cursor</strong></summary>

**Option A — local plugin (no Marketplace listing required)**

Install Agentera as a Cursor plugin from a clone or release checkout. The plugin
root must contain `.cursor-plugin/plugin.json` (this repository already does).

```bash
git clone https://github.com/jgabor/agentera.git ~/.cursor/plugins/local/agentera
# or: ln -s /path/to/agentera ~/.cursor/plugins/local/agentera
```

Restart Cursor or run **Developer: Reload Window**. You can also load the folder
through Cursor's local plugin UI. Agentera is not published to the Cursor
Marketplace yet; use this manual path instead.

The plugin loads skills, managed capability agents, and plugin hooks. When you open
a project that is not an Agentera install root, `sessionStart` exports
`AGENTERA_HOME` from the plugin checkout.

**Option B — portable skill plus project upgrade**

Install the skill:

```bash
npx skills add jgabor/agentera -g -a cursor --skill agentera -y
```

Install managed hooks, capability agents, and plugin metadata in your project:

```bash
uvx --from git+https://github.com/jgabor/agentera agentera upgrade --project "$PWD" --runtime cursor --yes
```

From a clone, use `uv run scripts/agentera upgrade --runtime cursor --yes` instead.

Use **Option A** for a user-global plugin install. Use **Option B** when you want
project-committed `.cursor/` surfaces (team sharing, CI doctor checks, or working
without the plugin). You can combine both: plugin for global availability, upgrade
for per-project `.cursor/hooks.json` and `.cursor/agents/` copies.

This repository dogfoods committed `.cursor/` surfaces; other projects receive them
through upgrade. Cloud agents are unsupported in v1. Bare message `hej` stays
metadata-only like Claude, Copilot, and Codex.

Adapter details: [`references/adapters/cursor.md`](./references/adapters/cursor.md).

</details>

<details>
<summary><strong>Copilot CLI</strong></summary>

```bash
copilot plugin marketplace add jgabor/agentera
copilot plugin install jgabor/agentera
```

</details>

<details>
<summary><strong>Codex CLI</strong></summary>

```bash
codex plugin marketplace add jgabor/agentera
codex plugin add agentera@agentera
```

Open `/plugins`, enable Agentera, then run `$agentera`.

When the plugin is installed and enabled, Agentera uses plugin-provided hooks
as the primary hook path, and `agentera upgrade --runtime codex` trusts that
plugin hook metadata. Copied `~/.codex/hooks.json` hooks remain only as a
compatibility fallback for non-plugin installs. Full hook and validation details:
[`references/adapters/runtime-feature-parity.md`](./references/adapters/runtime-feature-parity.md).

</details>

Something broken after install? See [Troubleshooting](#troubleshooting).

## Capabilities

All twelve capabilities live inside one Agentera skill. Canonical Swedish names
are the protocol identity; aliases are direct `/agentera <alias>` routes.

| | Capability | Alias | Use it when you need... |
|---|---|---|---|
| ⌂ | hej | `status` | A project briefing and next best action. |
| ⛥ | visionera | `vision` | Product direction in `.agentera/vision.yaml`. |
| ❈ | resonera | `discuss` | Structured deliberation before consequential choices. |
| ⬚ | inspirera | `research` | External pattern or reference analysis. |
| ▤ | dokumentera | `document` | Documentation aligned with code and intent. |
| ◰ | visualisera | `design` | Visual identity and design-token direction. |
| ≡ | planera | `plan` | A scoped plan with behavioral acceptance criteria. |
| ⎈ | orkestrera | `orchestrate` | Autonomous plan execution with evaluation and retry checks. |
| ⧉ | realisera | `build` | One verified development cycle. |
| ⎘ | optimera | `optimize` | Measured improvement of a concrete metric. |
| ⛶ | inspektera | `audit` | Architecture, test, dependency, and artifact health audits. |
| ♾ | profilera | `profile` | A reusable decision profile that travels with you across projects. |

You can also use plain language: `/agentera help me decide`, `/agentera plan
this`, `/agentera run the plan`, `/agentera audit the codebase`, or `/agentera
update docs`.

## How it works

Agentera is a plain-file coordination protocol: each capability reads what it
needs, writes what it owns, and leaves evidence for the next session.

### Rich state, precise reads

Agentera tracks far more than a single plan file. Project direction, active
work, shipped evidence, deliberation history, health grades, documentation drift,
optimization objectives, and prioritized findings each live in their own
artifact, owned by the capability that understands it.

```text
.agentera/
  vision.yaml              product direction
  plan.yaml                active plan and acceptance criteria
  progress.yaml            shipped work and verification evidence
  decisions.yaml           durable reasoning trail
  health.yaml              architecture, test, dependency, and artifact health
  docs.yaml                documentation inventory and drift
  optimera/<objective>/
    objective.yaml         metric, target, scope, constraints
    experiments.yaml       measurement history and closure
```

Human-facing artifacts stay at the project root when useful:

| Artifact | Primary owner | Purpose |
|---|---|---|
| `TODO.md` | realisera, inspektera | Prioritized work and findings. |
| `CHANGELOG.md` | realisera | Contributor-facing release history. |
| `DESIGN.md` | visualisera | Visual identity system. |
| `PROFILE.md` | profilera | Your decision profile (Agentera data directory by default). |

That breadth is the point: every session can see product intent, plan state,
what shipped, why choices were made, and whether the repo is healthy. Each turn
loads only the slices an agent needs.

Agents query targeted slices through the Agentera CLI (`prime`, `state plan`,
`state progress`, `state decisions`, `state health`, and more) instead of
raw-reading whole YAML files or Markdown logs. Legacy top-level names (`hej`,
`plan`, `validate`, …) still forward with a one-line stderr alias; see
[`references/cli/audience-namespace-cli-migration.yaml`](references/cli/audience-namespace-cli-migration.yaml).
Capability startup uses bounded JSON envelopes from
`agentera prime --context <name> --format json` so orientation stays complete
without loading full artifact history into context. When agents need a specific
artifact, list canonical names and paths first:

```bash
npx -y agentera@next state query --list-artifacts
```

Wide coverage, narrow reads: many artifacts, token-efficient handoffs.

### Handoffs between sessions

Each capability reads what earlier ones wrote, does its work, and leaves evidence
for the next run:

| Question | Answer in |
|---|---|
| Why did we pick the repository pattern? | `.agentera/decisions.yaml` |
| What is task 7 waiting on? | `.agentera/plan.yaml` |
| Did the auth middleware ship with tests? | `.agentera/progress.yaml` |

`resonera` records the decision, `planera` scopes the work, `realisera` ships
with evidence, `inspektera` audits the result. The next `/agentera` briefing
reads those files instead of reconstructing context from chat.

| Approach | Coordination model | State location | Runtime portability |
|---|---|---|---|
| Prompt chains | Sequential prompts | Chat transcript | Low |
| Agent platforms | Platform-owned workflows | Vendor service | Platform-bound |
| Vector memory | Retrieved snippets | External index | Depends on integration |
| Agentera | Capability-owned artifacts with behavioral acceptance and health gates | Your repo and data directory | Claude Code, OpenCode, Copilot CLI, Codex CLI, Cursor |

## Saved project context

Stateful artifacts tell agents **what the project is**. Your profile tells them
**how you work**.

`profilera` studies your decisions, tradeoffs, corrections, scope calls, and
review feedback, optionally drawing on portable runtime history, then writes an
editable `PROFILE.md`. Every capability can read it: high-confidence entries
become strong constraints; lower-confidence ones stay suggestions you can
challenge or refine.

That is why Agentera feels personal instead of merely organized. Without a
profile, agents still coordinate through shared repo artifacts. With one, they
stop re-learning the same preferences every session: what evidence you trust,
when you prefer speed over polish, how much planning you want, what tests
convince you, and when you expect pushback.

| | Without profile | With profile loaded |
|---|---|---|
| Change scope | Broad refactor before the first code change | Minimal diff matched to the ask |
| Test strategy | Full integration suite by default | Unit tests for internal helpers |
| When to deliberate | Ad hoc discussion in chat | `resonera` when API boundaries change |

The profile lives in your Agentera data directory by default, so it travels
across projects while repo artifacts stay project-local.

**After your first briefing, run `/agentera profile` to teach Agentera how you decide.**

---

## Agentera CLI

The CLI is how agents read project state precisely. Agentera 3.x is a native
TypeScript CLI published to npm: skills, schemas, and registry ship inside the
package, so `npx` works with no repo checkout and no `AGENTERA_HOME` for normal
use.

| Channel | npm tag | Use for |
| --- | --- | --- |
| **development** (3.x today) | `@next` | `npx -y agentera@next` — self-contained TypeScript CLI |
| **stable** (2.x until 3.0 cutover) | `@latest` | `npx -y agentera@latest` — Python-backed 2.x support line |
| **v2 git maintainer** | n/a | `uvx --from git+https://github.com/jgabor/agentera@main agentera` — stable Python from `main` only |

Select a channel with `--channel`, `AGENTERA_UPDATE_CHANNEL`, or
`update.channel` in `~/.config/agentera/config.toml`. See
[`references/cli/update-channels.yaml`](references/cli/update-channels.yaml).

Canonical top-level commands (from `agentera --help`):

| Group | Commands |
| --- | --- |
| Agent | `prime`, `schema`, `state`, capability routing (`planera`, `realisera`, …) |
| User | `upgrade`, `doctor`, `report` |
| Maintainer | `check` (`validate`, `verify`, `lint`, `compact`) |

Without a clone (3.x development channel):

```bash
npx -y agentera@next prime --format json
npx -y agentera@next prime --context planera --format json
npx -y agentera@next state plan --format json
npx -y agentera@next state progress --limit 1 --format json
npx -y agentera@next state decisions --topic api --format json
npx -y agentera@next state health --format json
npx -y agentera@next check validate capability-contract --format json
npx -y agentera@next doctor --format json
```

`agentera prime` replaces the former top-level `hej` command for orientation.
`agentera check validate` is canonical; top-level `agentera validate` still
runs with a stderr alias. Validate a capability with
`npx -y agentera@next check validate capability <name-or-path>`.

Contributors on this repository use `pnpm -C packages/cli build` and
`node packages/cli/dist/bin/agentera.js …`. The stable 2.x Python line on
`main` still uses `uv run scripts/agentera …`. See [Development](#development).

Slash routes and CLI commands are separate surfaces. `/agentera plan` routes to
`planera`; `agentera state plan` reads plan state.

Maintainers benchmark when agents still raw-read artifacts after CLI queries; see
[`references/analysis/benchmark.md`](./references/analysis/benchmark.md).

## Portable protocol

Agentera runs on Claude Code, OpenCode, Copilot CLI, Codex CLI, and Cursor with the
same capabilities and artifacts. Hooks are optional runtime adapters for session
preload, artifact checks, app-home discovery, and bookmarks. The protocol works
without them; hooks make supported runtimes smoother.

Runtime entry points, validation strictness, and hook behavior:
[`references/adapters/runtime-feature-parity.md`](./references/adapters/runtime-feature-parity.md).

## Troubleshooting

**Install or app home looks wrong**

On **3.x** (`npx -y agentera@next`), doctor checks the bundled CLI, runtime
wiring, and coexistence with a leftover v2 managed app home:

```bash
npx -y agentera@next doctor
npx -y agentera@next upgrade --dry-run --channel development
```

On the **2.x stable** line (`npx -y agentera@latest`), preview before apply:

```bash
npx -y agentera@latest doctor
npx -y agentera@latest upgrade --project "$PWD" --dry-run
```

Follow the printed channel-aware repair commands. From a clone on `main`:
`uv run scripts/agentera doctor`.

**Migrating from Agentera v1 or v2 to v3**

See [Upgrade from v1](#upgrade-from-v1) or [`UPGRADE.md`](./UPGRADE.md) for
stable-channel v1→v2 steps, the `v3-handoff.json` preflight, coexistence
doctor warnings, and explicit v2→v3 opt-in on the development channel.

**Behavior differs by runtime**

Validation strictness, session preload, and Codex hook setup vary by host. Use
[`references/adapters/runtime-feature-parity.md`](./references/adapters/runtime-feature-parity.md)
as the source of truth.

## Upgrade from v1

<details>
<summary><strong>Preview and apply the v2 upgrade (stable channel)</strong></summary>

The default stable channel uses `@latest` on the 2.x support line. Run the no-write
preview first:

```bash
npx -y agentera@latest upgrade --project "$PWD" --dry-run
```

After reviewing the preview, apply the upgrade:

```bash
npx -y agentera@latest upgrade --project "$PWD" --yes
```

Add `--update-packages` only when you explicitly want Agentera to run package
manager commands such as `npx skills add` or `npx skills remove`. For update
channels, v2→v3 opt-in, and maintainer backport order, see
[`UPGRADE.md`](./UPGRADE.md).

</details>

## Uninstall

For Codex, disable Agentera in `/plugins` before removing the marketplace entry.

```bash
# Claude Code / OpenCode / Cursor
npx skills remove jgabor/agentera -g -y

# Copilot CLI
copilot plugin uninstall jgabor/agentera

# Codex CLI
codex plugin marketplace remove jgabor/agentera
```

## Development

Requires Node.js 22+ with pnpm for the TypeScript CLI (`packages/cli`) and
Python 3.11+ with [uv](https://docs.astral.sh/uv/) for the stable 2.x line on
`main`. Contributor rules, capability layout, and schema contracts:
[`AGENTS.md`](./AGENTS.md).

Every capability has `packages/cli/src/capabilities/<name>/instructions.ts`
plus `schemas/triggers.yaml`, `schemas/artifacts.yaml`, `schemas/validation.yaml`,
and `schemas/exit.yaml` (the `schemas/` directory lives at
`skills/agentera/capabilities/<name>/schemas/`). The TypeScript module exports
the capability prose as a default-exported string constant; the runtime serves
the full prose through the `prose` field of the `capability_context` capsule.
Capability startup exposes `first_invocation_read: prime_context` metadata via
`agentera prime --context <name> --format json`; runtime enforcement is true
(agents shell out to the prime command instead of reading the prose module
directly).
Instruction-file contract:
[`references/cli/capability-instruction-contract.yaml`](./references/cli/capability-instruction-contract.yaml).

### Skill install vs local clone

| You have | Use for day-to-day work | Use for upgrade, repair, validation |
|---|---|---|
| Skill or marketplace plugin only | `/agentera` (or `$agentera`) | `npx -y agentera@next …` (3.x) or `npx -y agentera@latest …` (2.x stable) |
| Git clone of this repo (`feat/v3`) | `/agentera` plus hooks if configured | `node packages/cli/dist/bin/agentera.js …` after `pnpm -C packages/cli build` |
| Git clone of this repo (`main`) | `/agentera` plus hooks if configured | `uv run scripts/agentera …` |

On 3.x, the published npm package is self-contained: upgrade and doctor operate
on the bundled `dist/` and `bundle/` trees. On 2.x stable, Agentera keeps a
managed app under your Agentera data directory (app home).

```bash
pnpm -C packages/cli test
pnpm -C packages/cli run typecheck
pnpm -C packages/cli build
node packages/cli/dist/bin/agentera.js check validate capability-contract --format json
node packages/cli/dist/bin/agentera.js check compact
```

---

**License:** [Apache-2.0](./LICENSE) · **Changelog:** [`CHANGELOG.md`](./CHANGELOG.md) · **Version:** 3.0.0 (`@next`; stable `@latest` remains 2.x until cutover)
