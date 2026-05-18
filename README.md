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
<a href="#quick-start">Quick start</a> ·
<a href="#how-it-works">How it works</a> ·
<a href="#capabilities">Capabilities</a> ·
<a href="#upgrade-from-v1">Upgrade</a>
</p>

</div>

## Quick start

Pick one runtime, install Agentera, then run `/agentera` (`$agentera` in Codex).

```bash
# Claude Code
npx skills add jgabor/agentera -g -a claude-code --skill agentera -y

# OpenCode
npx skills add jgabor/agentera -g -a opencode --skill agentera -y
mkdir -p ~/.config/opencode/plugins
curl -fsSL https://raw.githubusercontent.com/jgabor/agentera/main/.opencode/plugins/agentera.js \
  -o ~/.config/opencode/plugins/agentera.js

# Copilot CLI
copilot plugin marketplace add jgabor/agentera
copilot plugin install jgabor/agentera

# Codex CLI
codex plugin marketplace add jgabor/agentera
```

For Codex, open `/plugins`, enable Agentera, then start `$agentera`.

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

Session hook bookmarks are runtime-local under the Agentera data directory, not committed project state.

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
| Agentera | Capability-owned artifacts | Your repo and data directory | Claude Code, OpenCode, Copilot CLI, Codex CLI |

Routing is deterministic before it is fuzzy. The Agentera routing entry point at
`skills/agentera/SKILL.md` uses a five-layer routing model: bare `/agentera` or `hej`, exact capability or alias,
high-confidence natural language, borderline disambiguation, and fallback to the
dashboard. Capability trigger patterns live in each capability's schema, not in a
single hardcoded prompt.

## Agentera CLI

The Agentera CLI is how agents read project state precisely. Instead of opening
whole artifacts and spending context on irrelevant history, they ask targeted
questions: what changed, what is next, what is blocked, what decisions matter,
and whether the project is healthy.

```bash
uv run scripts/agentera hej --format json
uv run scripts/agentera plan --format json
uv run scripts/agentera progress --limit 1 --format json
uv run scripts/agentera decisions --topic api --format json
uv run scripts/agentera health --format json
uv run scripts/agentera doctor --format json
```

That matters because startup context gets read again and again. Benchmarks track
when agents still fall back to raw artifact reads after using the CLI, then use
that evidence to improve the commands. The result is less token waste, fewer
stale assumptions, and faster handoff between sessions because agents can read
the right slice of state at the right time.

Slash routes and CLI commands are separate surfaces. `/agentera plan` routes to
`planera`; `agentera plan` reads plan state.

See [`docs/benchmark.md`](./docs/benchmark.md) for the benchmark methodology.

## What you see

Start with `/agentera`. It renders a project briefing and suggests the most useful
next capability.

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

## For capability authors

Agentera is also a reference implementation of a portable skill protocol. Build
against the artifact contracts instead of one runtime.

Core surfaces:

| Surface | Path |
|---|---|
| Agentera routing entry point | [`skills/agentera/SKILL.md`](./skills/agentera/SKILL.md) |
| Shared primitives | [`skills/agentera/protocol.yaml`](./skills/agentera/protocol.yaml) |
| Schema contract | [`skills/agentera/capability_schema_contract.yaml`](./skills/agentera/capability_schema_contract.yaml) |
| Instruction-file contract | [`references/cli/capability-instruction-contract.yaml`](./references/cli/capability-instruction-contract.yaml) |
| Runtime parity | [`references/adapters/runtime-feature-parity.md`](./references/adapters/runtime-feature-parity.md) |

Validate a capability through the canonical namespace:

```bash
uv run scripts/agentera validate capability <name-or-path>
uv run scripts/agentera validate capability-contract --format json
```

Every capability has `instructions.md` plus `schemas/triggers.yaml`,
`schemas/artifacts.yaml`, `schemas/validation.yaml`, and `schemas/exit.yaml`.
The schema contract makes those files executable for validators and tests.
Decision 57 also defines `first_invocation_read` metadata emitted by
`agentera hej --format json --capability-context <name>`. Planera reports its
compact startup contract there; runtime enforcement is still false.

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

```bash
# Claude Code / OpenCode
npx skills remove jgabor/agentera -g -y

# Copilot CLI
copilot plugin uninstall jgabor/agentera

# Codex CLI
# First disable Agentera in /plugins, then:
codex plugin marketplace remove jgabor/agentera
```
