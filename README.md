<div align="center">
<pre>
┌─┐┌─┐┌─┐┌┐┌┌┬┐┌─┐┬─┐┌─┐
├─┤│ ┬├┤ │││ │ ├┤ ├┬┘├─┤
┴ ┴└─┘└─┘┘└┘ ┴ └─┘┴└─┴ ┴
</pre>

<strong>Turn AI coding agents into an engineering team that remembers.</strong>

Agentera gives coding agents shared memory, decision profiles, specialized
roles, verification gates, and a common project protocol.

<p>
<a href="#quick-start">Quick start</a> ·
<a href="#what-you-see">What you see</a> ·
<a href="#features">Features</a> ·
<a href="#why-it-works">Why it works</a> ·
<a href="#the-memory-layer">Memory layer</a> ·
<a href="#capabilities">Capabilities</a> ·
<a href="#hooks">Hooks</a>
</p>

</div>

## Why Agentera?

Coding agents are good at tasks and bad at continuity. They forget decisions,
repeat investigations, lose project context, and hand the next session a pile of
code with little explanation.

Agentera fixes that with a single bundled skill containing twelve specialized
capabilities that coordinate through plain project files. One capability plans,
another builds, another audits, another documents, another remembers your
decision style. The work stops being a chat transcript and becomes an operating
record for the project.

## Upgrading from v1

If you used Agentera before v2, see [UPGRADE.md](./UPGRADE.md) for migration
instructions. v2 replaces twelve standalone skills with one bundled skill at
`skills/agentera/` and adds a YAML-based artifact format and query CLI.

## Features

Agentera gives your AI coding runtime the missing parts of an engineering team:

- **Project briefings**: get a live read on status, risks, stale work, and the
  next best action.
- **Decision memory**: capture why choices were made so future agents do not
  reopen settled questions.
- **Personal reasoning**: let agents learn your preferences from prior
  tradeoffs, corrections, scope calls, and review feedback.
- **Executable planning**: turn vague intent into scoped tasks with behavioral
  acceptance criteria.
- **Verified execution**: ship work in small increments with explicit evidence
  and handoff notes.
- **Autonomous orchestration**: run multi-step plans through evaluation and
  retry gates.
- **Health audits**: track architecture, tests, dependencies, artifacts, and
  release readiness.
- **Documentation upkeep**: keep README, project docs, and documentation
  coverage aligned with the code.
- **Portable skill protocol**: use the same project artifacts across Claude
  Code, OpenCode, Copilot CLI, and Codex CLI.

The result is not a bag of prompts. It is a protocol for agents that coordinate
through project files, keep receipts, and compound context over time.

## What you see

Start with `/agentera` (`$agentera` in Codex). It gives you a project briefing
and routes you to the most useful next capability.

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

All capabilities live in one bundled skill at `skills/agentera/`. Install once,
then invoke the bundled skill. The dispatcher in `/agentera` reads your
intent and routes to the right capability automatically.

Pick your runtime, install Agentera, then open a project and run `/agentera`.

### Claude Code

```bash
npx skills add jgabor/agentera -g -a claude-code --skill '*' -y
```

Start with `/agentera`.

### OpenCode

Install the skills and the OpenCode plugin. The skills provide the actual
Agentera workflows; the plugin adds slash commands, hooks, and install-root
discovery.

```bash
npx skills add jgabor/agentera -g -a opencode -y
mkdir -p ~/.config/opencode/plugins
curl -fsSL https://raw.githubusercontent.com/jgabor/agentera/main/.opencode/plugins/agentera.js \
  -o ~/.config/opencode/plugins/agentera.js
```

Start with `/agentera`.

### Copilot CLI

```bash
copilot plugin marketplace add jgabor/agentera
copilot plugin install jgabor/agentera
```

Start with `/agentera`.

### Codex CLI

```bash
codex plugin marketplace add jgabor/agentera
```

Open `/plugins`, enable Agentera, and start with `$agentera`.

### Check the bundle

Use the setup doctor before editing runtime config by hand. It reads the
installed bundle or local clone, classifies each runtime, and does not write
files by default.

```bash
uv run scripts/setup_doctor.py --smoke
```

If doctor reports fixable Codex or Copilot setup gaps, preview the
runtime-native write first:

```bash
uv run scripts/setup_doctor.py --install --dry-run --runtime codex
uv run scripts/setup_doctor.py --install --dry-run --runtime copilot
```

Apply only after reviewing the target runtime, target file, and reason:

```bash
uv run scripts/setup_doctor.py --install --yes --runtime codex
uv run scripts/setup_doctor.py --install --yes --runtime copilot
```

## Why it works

Most coding agents forget. Agentera writes the useful residue of the work into
plain project artifacts that live with the project:

- `.agentera/vision.yaml`: where the project is going.
- `.agentera/decisions.yaml`: why important choices were made.
- `.agentera/plan.yaml`: what should happen next.
- `.agentera/progress.yaml`: what shipped, how it was verified, and what changed.
- `.agentera/health.yaml`: where architecture and quality are drifting.
- `.agentera/docs.yaml`: which docs exist, what they cover, and what is stale.
- `.agentera/optimera/<name>/`: one self-contained optimization objective,
  with `OBJECTIVE.md`, `EXPERIMENTS.md`, and its locked measurement harness.

Each capability reads the artifacts it needs and writes the artifact it owns.
That is the trick: the next agent does not have to infer history from chat. It
can read the project's operating record.

## The memory layer

`profilera` is the capability that makes Agentera feel personal instead of merely
stateful. It studies your decisions, tradeoffs, corrections, and recurring
preferences, then writes them into an editable `PROFILE.md`.

That profile teaches later agents how you think: what evidence you trust, when
you prefer speed over polish, how much planning you want, what kinds of tests
convince you, and when you expect pushback.

The profile is confidence-weighted and optional. If it exists, every capability
can use it to reason more like you. If it is missing, Agentera still works.

## Get the most out of it

- **Returning to a repo**: run `/agentera`. Let it read project state and route you.
- **Starting something big**: say "define the product direction" to trigger visionera, then "plan the work" for planera.
- **Stuck on a tradeoff**: say "help me decide" to trigger resonera; it records the decision for later agents.
- **Ready to build one focused thing**: say "build the next feature" to trigger realisera.
- **Ready to execute a whole plan**: say "run the plan" to trigger orkestrera.
- **Worried the codebase is drifting**: say "audit the codebase" to trigger inspektera.
- **Optimizing a metric**: say "improve test coverage" to trigger optimera.

A good default loop is:

```text
/agentera (briefing) → deliberation or planning → build → audit
```

## Capabilities

All twelve capabilities are bundled in `skills/agentera/`. Each has a
`prose.md` defining its behavior and `schemas/` defining its triggers,
artifacts, validation rules, and exit signals. The dispatcher in
`skills/agentera/SKILL.md` routes every `/agentera` request to the matching
capability automatically.

| | Capability | Use it when you need... |
|---|---|---|
| ⌂ | hej | A project briefing and the next best action. |
| ⛥ | visionera | A strong product direction in `.agentera/vision.yaml`. |
| ❈ | resonera | Structured deliberation before consequential choices. |
| ⬚ | inspirera | To map an external link, repo, or pattern to your project. |
| ▤ | dokumentera | Docs that stay aligned with code and project intent. |
| ◰ | visualisera | A durable visual identity and design-token direction. |
| ≡ | planera | A scoped plan with behavioral acceptance criteria. |
| ⎈ | orkestrera | Autonomous plan execution with evaluation and retry gates. |
| ⧉ | realisera | One verified development cycle. |
| ⎘ | optimera | Measured improvement of a concrete metric. |
| ⛶ | inspektera | Architecture, test, dependency, and artifact health audits. |
| ♾ | profilera | A reusable decision profile that helps every capability reason more like you. |

### Natural language mapping

You do not need to remember capability names. Type `/agentera` followed by what you want:

| What you want | `/agentera` understands |
|---|---|
| "help me think through this" | → resonera (deliberation) |
| "help me decide" | → resonera (decision) |
| "plan this" | → planera (planning) |
| "run the plan" | → orkestrera (execution) |
| "build the next feature" | → realisera (development) |
| "evolve the project" | → realisera (development) |
| "audit the codebase" | → inspektera (health audit) |
| "check code health" | → inspektera (health audit) |
| "improve test coverage" | → optimera (optimization) |
| "define the direction" | → visionera (vision) |
| "design the visual identity" | → visualisera (design system) |
| "update docs" | → dokumentera (documentation) |
| "research this pattern" | → inspirera (external analysis) |
| "what should I work on" | → hej (briefing) |

Validate any capability against the schema contract:

```bash
uv run scripts/validate_capability.py skills/agentera/capabilities/<name>
```

## Hooks

Agentera works as a portable bundled skill first. Hooks are optional, but they
add enough value that most users should know they exist.

Use hooks when you want:

- Session continuity between agent runs.
- Artifact checks while the agent edits project files.
- Runtime shell tools that know where Agentera is installed.

Profile data already uses the platform data directory by default:
`$XDG_DATA_HOME/agentera` on Linux, `~/Library/Application Support/agentera` on
macOS, and `%APPDATA%/agentera` on Windows.

`AGENTERA_HOME` is different. It points to the Agentera install root, so
capabilities and hooks can resolve repo helper scripts such as
`scripts/agentera`. Claude Code and OpenCode can set that automatically.
Codex and Copilot may need a host-level setup step when you want helper-script
execution.

Start with the bundle doctor:

```bash
uv run scripts/setup_doctor.py --smoke
```

<details>
<summary><strong>Claude Code hooks</strong></summary>

No extra setup is needed when Agentera is installed as a Claude Code plugin.

Claude Code provides the install-root environment Agentera needs. Hooks can
preload recent project context, validate artifact writes, and save session
bookmarks.

</details>

<details>
<summary><strong>OpenCode hooks</strong></summary>

Install the plugin if you did not already install it in the quick start:

```bash
mkdir -p ~/.config/opencode/plugins
curl -fsSL https://raw.githubusercontent.com/jgabor/agentera/main/.opencode/plugins/agentera.js \
  -o ~/.config/opencode/plugins/agentera.js
```

The plugin does not install the skills. It adds Agentera commands,
install-root discovery, artifact checks, and session bookmarks around skills
installed through `npx skills add jgabor/agentera -g -a opencode -y` or another
OpenCode skill path.

</details>

<details>
<summary><strong>Copilot CLI hooks</strong></summary>

Install from the Agentera marketplace:

```bash
copilot plugin marketplace add jgabor/agentera
copilot plugin install <skill>@agentera
```

Or install the full suite:

```bash
copilot plugin install jgabor/agentera
```

The plugin includes Copilot hook definitions. For helper-script access, set
`AGENTERA_HOME` in the shell that launches Copilot.

If you use a local clone or know the install root, the helper can persist that
export for bash, zsh, or fish:

```bash
export AGENTERA_HOME=/path/to/agentera
uv run "$AGENTERA_HOME/scripts/setup_copilot.py"
```

Restart your shell after running it.

</details>

<details>
<summary><strong>Codex CLI hooks</strong></summary>

Marketplace install:

```bash
codex plugin marketplace add jgabor/agentera
```

Then use interactive `/plugins` to install and enable the plugin.

For helper-script access, write `AGENTERA_HOME` to `~/.codex/config.toml`.
If you use a local clone or know the install root:

```bash
export AGENTERA_HOME=/path/to/agentera
uv run "$AGENTERA_HOME/scripts/setup_codex.py"
```

For artifact-validation hooks:

```bash
mkdir -p ~/.codex
cp "$AGENTERA_HOME/hooks/codex-hooks.json" ~/.codex/hooks.json
```

</details>

Both setup helpers are idempotent and support `--dry-run`.

Check that a shell can see Agentera:

```bash
bash -c '
  echo "AGENTERA_HOME=$AGENTERA_HOME"
  uv run "${AGENTERA_HOME:-$CLAUDE_PLUGIN_ROOT}/scripts/agentera" query --list-artifacts
'
```

For adapter-level runtime details, see
[`references/adapters/runtime-feature-parity.md`](./references/adapters/runtime-feature-parity.md).

<details>
<summary><strong>Manual clone fallback</strong></summary>

```bash
git clone git@github.com:jgabor/agentera.git ~/.agents/agentera
```

Then reference `skills/agentera/SKILL.md` through your runtime's skill
configuration.

</details>

## For capability authors

Agentera is also a reference implementation of a portable skill protocol.

Build against the artifact contracts instead of a single runtime. A capability
that reads `PLAN.md`, writes `HEALTH.md`, and uses the shared severity/confidence
vocabulary can mesh with the rest of the suite even when the host runtime
changes.

The core surfaces:

- [`skills/agentera/protocol.yaml`](./skills/agentera/protocol.yaml): shared primitives and vocabulary.
- [`skills/agentera/capability_schema_contract.yaml`](./skills/agentera/capability_schema_contract.yaml): schema contract for capabilities.
- [`registry.json`](./registry.json): capability index, versions, tags, paths.
- [`references/adapters/runtime-feature-parity.md`](./references/adapters/runtime-feature-parity.md):
  runtime capability comparison.

## Maintainer checks

```bash
uv run scripts/validate_capability.py --self-validate
uv run scripts/validate_capability.py skills/agentera/capabilities/<name>
uv run scripts/validate_cross_capability.py
uv run scripts/validate_lifecycle_adapters.py --check-uv-runtime
uv run --with pytest --with pyyaml pytest -q
```

Agentera has two eval surfaces:

- `scripts/eval_skills.py`: runtime smoke eval. Invokes capabilities through
  Claude Code or OpenCode and checks for crashes, non-zero exits, and obvious
  error output.
- `scripts/semantic_eval.py`: offline semantic eval. Reads captured
  Markdown fixtures from `fixtures/semantic/*.md`, checks expected output facts
  and seeded artifact facts, never invokes a model runtime.

<details>
<summary><strong>State artifact reference</strong></summary>

Project-facing files:

| Artifact | Owner | Purpose |
|----------|-------|---------|
| `TODO.md` | realisera, inspektera | Prioritized work and findings. |
| `CHANGELOG.md` | realisera | Contributor-facing release history. |
| `DESIGN.md` | visualisera | Visual identity system. |

Operational files in `.agentera/`:

| Artifact | Owner | Purpose |
|----------|-------|---------|
| `vision.yaml` | visionera, realisera | Product direction. |
| `progress.yaml` | realisera | Cycle history and verification notes. |
| `decisions.yaml` | resonera | Durable reasoning trail. |
| `plan.yaml` | planera | Active task plan. |
| `health.yaml` | inspektera | Audit grades, findings, trends. |
| `docs.yaml` | dokumentera | Documentation index and coverage. |
| `session.yaml` | session stop hook | Session bookmarks. |

Optimera objective directories under `.agentera/optimera/<name>/`:

| Artifact | Owner | Purpose |
|----------|-------|---------|
| `objective.yaml` | optimera | Objective state, metric, target, constraints, scope, and canonical closure fields. |
| `experiments.yaml` | optimera | Experiment history plus one closure entry with final value, target, and reason. |
| `harness` | optimera | Locked metric command approved during objective bootstrap. |

Optimera does not use root objective artifacts, registries, symlinks, or DOCS.md
fixed mappings for objective state. Each objective stays self-contained in its
own `.agentera/optimera/<name>/` directory.

Global profile:

`PROFILE.md` lives under `$PROFILERA_PROFILE_DIR`, defaulting to the
platform-appropriate agentera data directory.

</details>
