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
<a href="#try-it">Try it</a> ·
<a href="#quick-start">Install</a> ·
<a href="#capabilities">Capabilities</a> ·
<a href="#agentera-cli">CLI</a> ·
<a href="#troubleshooting">Troubleshooting</a> ·
<a href="#for-capability-authors">Authors</a> ·
<a href="#upgrade-from-v1">Upgrade</a>
</p>
</div>

## Try it

1. Install Agentera for your runtime ([Quick start](#quick-start)).
2. Open a git project (existing repo or new).
3. Run `/agentera` in the agent (`$agentera` in Codex).

You do not need to create `.agentera/` by hand. The first briefing bootstraps
project state as capabilities run; `PROFILE.md` stays optional until you use
`profilera`.

If hooks or the managed app look wrong, run
[`agentera doctor`](#troubleshooting) before debugging install paths by hand.

## What you see

`/agentera` renders a project briefing and suggests the most useful next
capability.

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

## Quick start

Pick one runtime, install, then run `/agentera` (`$agentera` in Codex).

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

When the Agentera Codex plugin is installed and enabled, Agentera uses the
plugin-provided hooks as the primary hook path and `agentera upgrade --runtime
codex` trusts that plugin hook metadata. Copied `~/.codex/hooks.json` hooks are
kept only as the compatibility fallback for non-plugin installs. You can also
open `/plugins`, enable Agentera, then start `$agentera`.

</details>

### Skill install vs local clone

| You have | Use for day-to-day work | Use for upgrade, repair, validation |
|---|---|---|
| Skill or marketplace plugin only | `/agentera` (or `$agentera`) | `uvx --from git+https://github.com/jgabor/agentera agentera …` |
| Git clone of this repo | `/agentera` plus hooks if configured | `uv run scripts/agentera …` |

Agentera keeps a managed app under your Agentera data directory (app home). Skill
installs load routing prose; upgrade and doctor refresh the managed app and wire
runtime config. You rarely set paths manually—`agentera doctor` reports stale or
missing app files and suggested repair commands.

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
| ♾ | profilera | `profile` | A reusable decision profile for future sessions. |

You can also use plain language: `/agentera help me decide`, `/agentera plan
this`, `/agentera run the plan`, `/agentera audit the codebase`, or `/agentera
update docs`.

## How it works

Agentera is a plain-file coordination protocol: each capability reads what it
needs, writes what it owns, and leaves evidence for the next session.

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
| `PROFILE.md` | profilera | User decision profile, stored in the Agentera data directory by default. |

Session hook bookmarks are runtime-local under the Agentera data directory, not
committed project state.

Before Agentera, every session has to rediscover intent:

```diff
- "Why did we pick the repository pattern?"
- "What was the next task?"
- "Did the auth middleware actually get tested?"
+ .agentera/decisions.yaml says why the repository pattern won.
+ .agentera/plan.yaml says task 7 is next and blocked on an API schema choice.
+ .agentera/progress.yaml says auth middleware shipped with rate-limit tests.
```

That is the read-own-read chain: `resonera` records a decision, `planera` builds
a plan from it, `realisera` ships against that plan, `inspektera` audits the
result, and the next `/agentera` briefing reads the same artifacts instead of
guessing from chat history.

| Approach | Coordination model | State location | Runtime portability |
|---|---|---|---|
| Prompt chains | Sequential prompts | Chat transcript | Low |
| Agent platforms | Platform-owned workflows | Vendor service | Platform-bound |
| Vector memory | Retrieved snippets | External index | Depends on integration |
| Agentera | Capability-owned artifacts with behavioral acceptance and health gates | Your repo and data directory | Claude Code, OpenCode, Copilot CLI, Codex CLI |

Routing is deterministic before it is fuzzy. The Agentera routing entry point at
`skills/agentera/SKILL.md` uses a five-layer routing model: bare `/agentera` or
`hej`, exact capability or alias, high-confidence natural language, borderline
disambiguation, and fallback to the dashboard. Capability trigger patterns live in
each capability's schema, not in a single hardcoded prompt.

## Agentera CLI

The Agentera CLI is how agents read project state precisely. Instead of opening
whole artifacts and spending context on irrelevant history, they ask targeted
questions: what changed, what is next, what is blocked, what decisions matter,
and whether the project is healthy.

From a clone (Python 3.11+, [uv](https://docs.astral.sh/uv/)):

```bash
uv run scripts/agentera hej --format json
uv run scripts/agentera plan --format json
uv run scripts/agentera progress --limit 1 --format json
uv run scripts/agentera decisions --topic api --format json
uv run scripts/agentera health --format json
uv run scripts/agentera doctor --format json
```

Without a clone:

```bash
uvx --from git+https://github.com/jgabor/agentera agentera doctor --format json
uvx --from git+https://github.com/jgabor/agentera agentera hej --format json
```

Startup context gets read again and again. Benchmarks measure when agents still
fall back to raw artifact reads after using the CLI, then use that evidence to
improve commands—less token waste, fewer stale assumptions, faster handoff. See
[`references/analysis/benchmark.md`](./references/analysis/benchmark.md) for methodology.

Slash routes and CLI commands are separate surfaces. `/agentera plan` routes to
`planera`; `agentera plan` reads plan state.

## Saved project context

`profilera` is the capability that makes Agentera personal instead of merely
stateful. It studies your decisions, tradeoffs, corrections, scope calls, and
review feedback, then writes an editable `PROFILE.md`.

That profile tells later agents what evidence you trust, when you prefer speed
over polish, how much planning you want, what tests convince you, and when you
expect pushback. It is confidence-weighted and optional. Without it, Agentera
still works; with it, every capability has better local judgment.

## Portable protocol

Agentera is the same protocol across four runtimes. The host changes; the
capabilities and artifacts stay recognizable.

| Runtime | Entry point | Skill loading | Session context | Artifact validation |
|---|---|---|---|---|
| Claude Code | `/agentera` | Marketplace or native skills | Active via hooks | Advisory after mutation |
| OpenCode | `/agentera`, bare `hej` | Native skills plus plugin | Active for compaction context | Blocking for reconstructable edits |
| Copilot CLI | `/agentera` | Marketplace plugin | Active via hooks | Blocking for reconstructable edits |
| Codex CLI | `$agentera` | Plugin and agent descriptors | Partial | Advisory for patch paths |

Hooks are optional runtime adapters for session preload, artifact checks, app-home
discovery, and bookmarks. The protocol works without them; hooks make supported
runtimes smoother. See
[`references/adapters/runtime-feature-parity.md`](./references/adapters/runtime-feature-parity.md)
for exact runtime behavior and hook surfaces.

## Troubleshooting

**Install or app home looks wrong**

```bash
uvx --from git+https://github.com/jgabor/agentera agentera doctor
# or from a clone:
uv run scripts/agentera doctor
```

Doctor checks the managed app, Agentera app files status, and runtime wiring. Follow the
printed repair commands rather than guessing `AGENTERA_HOME` paths.

**Migrating from Agentera v1**

Preview, then apply (see [Upgrade from v1](#upgrade-from-v1) or [`UPGRADE.md`](./UPGRADE.md)):

```bash
uvx --from git+https://github.com/jgabor/agentera agentera upgrade --project "$PWD" --dry-run
uvx --from git+https://github.com/jgabor/agentera agentera upgrade --project "$PWD" --yes
```

**Behavior differs by runtime**

Validation strictness, session preload, and Codex hook setup vary by host. Use
[`references/adapters/runtime-feature-parity.md`](./references/adapters/runtime-feature-parity.md)
as the source of truth.

## For capability authors

Agentera is also a reference implementation of a portable skill protocol. Build
against the artifact contracts instead of one runtime.

| Surface | Path |
|---|---|
| Agentera routing entry point | [`skills/agentera/SKILL.md`](./skills/agentera/SKILL.md) |
| Shared primitives | [`skills/agentera/protocol.yaml`](./skills/agentera/protocol.yaml) |
| Schema contract | [`skills/agentera/capability_schema_contract.yaml`](./skills/agentera/capability_schema_contract.yaml) |
| Instruction-file contract | [`references/cli/capability-instruction-contract.yaml`](./references/cli/capability-instruction-contract.yaml) |
| Runtime parity | [`references/adapters/runtime-feature-parity.md`](./references/adapters/runtime-feature-parity.md) |
| Terminology | [`references/cli/vocabulary.md`](./references/cli/vocabulary.md) |

Validate a capability through the canonical namespace:

```bash
uv run scripts/agentera validate capability <name-or-path>
uv run scripts/agentera validate capability-contract --format json
```

Every capability has `instructions.md` plus `schemas/triggers.yaml`,
`schemas/artifacts.yaml`, `schemas/validation.yaml`, and `schemas/exit.yaml`.
The schema contract makes those files executable for validators and tests.
Decision 57 defines `first_invocation_read` metadata in the Agentera 3.0
capability startup capsule from
`agentera prime --context <name> --format json` (top-level `capability_context`,
with Planera's startup contract at
`capability_context.context.planning_context.startup_contract`). Historical
`hej --capability-context` and `--context-profile` paths are removed.
runtime enforcement is still false. See
[`AGENTS.md`](./AGENTS.md) for agent operating rules and
[`references/cli/capability-instruction-contract.yaml`](./references/cli/capability-instruction-contract.yaml)
for instruction-file contracts.

## Development

Requires Python 3.11+ and [uv](https://docs.astral.sh/uv/).

```bash
uv run --with pytest --with pyyaml pytest -q
uv run scripts/agentera validate capability-contract --format json
```

## Upgrade from v1

<details>
<summary><strong>Preview and apply the v2 upgrade</strong></summary>

Run the no-write preview first:

```bash
uvx --from git+https://github.com/jgabor/agentera agentera upgrade --project "$PWD" --dry-run
```

After reviewing the preview, apply the upgrade:

```bash
uvx --from git+https://github.com/jgabor/agentera agentera upgrade --project "$PWD" --yes
```

Add `--update-packages` only when you explicitly want Agentera to run package
manager commands such as `npx skills add` or `npx skills remove`. See
[`UPGRADE.md`](./UPGRADE.md) for the full migration guide.

</details>

## Uninstall

For Codex, disable Agentera in `/plugins` before removing the marketplace entry.

```bash
# Claude Code / OpenCode
npx skills remove jgabor/agentera -g -y

# Copilot CLI
copilot plugin uninstall jgabor/agentera

# Codex CLI
codex plugin marketplace remove jgabor/agentera
```

---

**License:** [Apache-2.0](./LICENSE) · **Changelog:** [`CHANGELOG.md`](./CHANGELOG.md) · **Version:** 2.6.1
