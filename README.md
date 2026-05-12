<div align="center">
<pre>
┌─┐┌─┐┌─┐┌┐┌┌┬┐┌─┐┬─┐┌─┐
├─┤│ ┬├┤ │││ │ ├┤ ├┬┘├─┤
┴ ┴└─┘└─┘┘└┘ ┴ └─┘┴└─┴ ┴
</pre>

<strong>Turn AI coding agents into an engineering team that remembers.</strong>

Agentera gives coding agents saved project context, decision profiles,
specialized roles, behavioral verification gates, and a common project protocol.

<p>
<a href="#agentera-v2">Agentera v2</a> ·
<a href="#upgrading-from-v1">Upgrade</a> ·
<a href="#why-agentera">Why Agentera</a> ·
<a href="#features">Features</a> ·
<a href="#what-you-see">What you see</a> ·
<a href="#state-cli">State CLI</a> ·
<a href="#quick-start">Quick start</a> ·
<a href="#why-it-works">Why it works</a> ·
<a href="#saved-project-context">Saved project context</a> ·
<a href="#capabilities">Capabilities</a> ·
<a href="#hooks">Hooks</a>
</p>

</div>

## Agentera v2

Agentera v2 is here: one `/agentera` entry point for the full suite, with
cleaner installs and better saved project context across Claude Code, OpenCode,
Copilot CLI, and Codex CLI.

What's new:

- **One install, one entry point**: the twelve v1 skills are now capabilities
  inside the bundled Agentera skill.
- **Guided v1 upgrades**: Agentera detects older project state and walks through
  the migration instead of leaving users to move files by hand.
- **More dependable saved context**: project state is structured, validated, and
  easier for the next agent session to read.
- **Better runtime support**: Codex, Copilot CLI, OpenCode, and Claude Code now
  share the same bundled suite model.

### Upgrading from v1

Run the v2 upgrade:

```bash
uvx --from git+https://github.com/jgabor/agentera agentera upgrade --project "$PWD" --yes --update-packages
```

Then start `/agentera`. See [UPGRADE.md](./UPGRADE.md) for the full migration
guide and dry-run form.

## Why Agentera?

Coding agents are good at tasks and bad at continuity. They forget decisions,
repeat investigations, lose project context, and hand the next session a pile of
code with little explanation.

Agentera fixes that with a single bundled skill containing twelve specialized
capabilities that coordinate through plain project files. One capability plans,
another builds, another audits, another documents, another remembers your
decision style. The work stops being a chat transcript and becomes saved project
context for the next session.

## Features

Agentera gives your AI coding runtime the missing parts of an engineering team:

- **Project briefings**: get a live read on status, risks, out-of-date work, and
  the next best action.
- **Decision memory**: capture why choices were made so future agents do not
  reopen settled questions.
- **Personal reasoning**: let agents learn your preferences from prior
  tradeoffs, corrections, scope calls, and review feedback.
- **Executable planning**: turn vague intent into scoped tasks with behavioral
  acceptance criteria.
- **Verified execution**: ship work in small increments with explicit evidence
  and handoff notes.
- **Autonomous orchestration**: run multi-step plans through evaluation and
  retry checks.
- **Health audits**: track architecture, tests, dependencies, artifacts, and
  release readiness.
- **Docs-first workflow**: document intended behavior before tests and code,
  then keep README, project docs, and documentation coverage aligned.
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

## State CLI

The Agentera CLI is the state access layer behind that briefing, not a
replacement for the dashboard. For a returning project, `/agentera` renders the
dashboard from one composite command:

```bash
uv run scripts/agentera hej
```

Routine state has flat top-level commands: `plan`, `progress`, `health`, `todo`,
`decisions`, `docs`, `objective`, and `experiments`. Use `query` only for
advanced custom artifact access or scripting:

```bash
uv run scripts/agentera plan
uv run scripts/agentera progress --limit 1
uv run scripts/agentera query session --format json
```

Slash routes and CLI state commands are separate surfaces. `/agentera build`
routes to `realisera`; primary aliases are not CLI commands. Shared words keep
their state meaning in the CLI: `/agentera plan` routes to `planera`, while
`agentera plan` reads plan state.

Use `agentera doctor` for Agentera CLI, app-home, install, and runtime self-checks.
It is separate from `agentera health`, which reports project artifact health.

Use `agentera lint --artifact <ARTIFACT>` for the pre-write artifact prose
self-audit. It reads text from stdin by default, or from `--file`/`--text`, and
reports bounded diagnostics for verbosity, abstraction, and filler issues. Lint
is advisory by default; add `--strict` when a failing check should return a
non-zero exit code.

Use `agentera describe --format json` when an agent needs to discover the live
CLI interface instead of relying on static prompt stuffing. It reports commands,
filters, output formats, structured fields, slash-route aliases, artifact schema
fields, and doctor self-check categories from one runtime surface. Missing
schema or contract facts are reported as explicit `gaps` entries.

## Quick start

Pick one runtime, install Agentera, then run `/agentera` (`$agentera` in Codex).

```bash
# Claude Code
npx skills add jgabor/agentera -g -a claude-code --skill agentera -y

# OpenCode (skills + plugin)
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

## Why it works

Most coding agents forget. Agentera writes the useful residue of the work into
plain project artifacts that live with the project:

- `.agentera/vision.yaml`: where the project is going.
- `.agentera/decisions.yaml`: why important choices were made.
- `.agentera/plan.yaml`: what should happen next.
- `.agentera/progress.yaml`: what shipped, how it was verified, and what changed.
- `.agentera/health.yaml`: where architecture and quality are out of sync with
  the project's goals.
- `.agentera/docs.yaml`: which docs exist, what they cover, and what needs sync.
- `.agentera/optimera/<name>/`: one self-contained optimization objective,
  with `objective.yaml`, `experiments.yaml`, and its locked measurement harness.

Each capability reads the artifacts it needs and writes the artifact it owns.
That is the trick: the next agent does not have to infer history from chat. It
can read the project's saved project context.

## Saved project context

`profilera` is the capability that makes Agentera feel personal instead of merely
stateful. It studies your decisions, tradeoffs, corrections, and recurring
preferences, then writes them into an editable `PROFILE.md`.

That profile teaches later agents how you think: what evidence you trust, when
you prefer speed over polish, how much planning you want, what kinds of tests
convince you, and when you expect pushback.

The profile is confidence-weighted and optional. When present, every capability
can use it to reason more like you. Without it, Agentera still works.

## Get the most out of it

- **Returning to a repo**: run `/agentera`. Let it read project state and route you.
- **Starting something big**: say "define the product direction" to trigger visionera, then "plan the work" for planera.
- **Stuck on a tradeoff**: say "help me decide" to trigger resonera; it records the decision for later agents.
- **Ready to build one focused thing**: say "build the next feature" to trigger realisera.
- **Ready to execute a whole plan**: say "run the plan" to trigger orkestrera.
- **Worried the codebase is out of sync with the plan**: say "audit the codebase" to trigger inspektera.
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

| | Capability | Plain route alias | Use it when you need... |
|---|---|---|---|
| ⌂ | hej | `/agentera status` | A project briefing and the next best action. |
| ⛥ | visionera | `/agentera vision` | A strong product direction in `.agentera/vision.yaml`. |
| ❈ | resonera | `/agentera discuss` | Structured deliberation before consequential choices. |
| ⬚ | inspirera | `/agentera research` | To map an external link, repo, or pattern to your project. |
| ▤ | dokumentera | `/agentera document` | Docs that stay aligned with code and project intent. |
| ◰ | visualisera | `/agentera design` | A durable visual identity and design-token direction. |
| ≡ | planera | `/agentera plan` | A scoped plan with behavioral acceptance criteria. |
| ⎈ | orkestrera | `/agentera orchestrate` | Autonomous plan execution with evaluation and retry checks. |
| ⧉ | realisera | `/agentera build` | One verified development cycle. |
| ⎘ | optimera | `/agentera optimize` | Measured improvement of a concrete metric. |
| ⛶ | inspektera | `/agentera audit` | Architecture, test, dependency, and artifact health audits. |
| ♾ | profilera | `/agentera profile` | A reusable decision profile that helps every capability reason more like you. |

Each capability has exactly one plain route alias. Canonical Swedish capability
names such as `realisera` and `dokumentera` remain the protocol identity; aliases
are only direct `/agentera <alias>` routes, not CLI state commands.

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

Validate any capability against the schema contract. Capability schema structure
is owned by `skills/agentera/capability_schema_contract.yaml` and loaded through
`scripts/capability_contract.py`; `scripts/validate_capability.py` consumes that
model instead of duplicating required groups, priority values, directory rules,
or capability-field primitive mappings.

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

`AGENTERA_HOME` points to the Agentera directory. User-owned state remains at the
directory root: `PROFILE.md`, `USAGE.md`, history, and intermediate corpus data.
Agentera's app files live separately under `$AGENTERA_HOME/app`.
Directory selection, repair checks, the normal-platform-directory fallback, and
no-write diagnostics are owned by `scripts/install_root.py`.

`agentera doctor` reports the active Agentera directory, app files directory, skill
root, runtime root, and source root. If it finds old app files directly in
`AGENTERA_HOME`, it reports `migration_required` and prints exact preview and
apply upgrade commands; doctor remains read-only. The current compatibility
selector for refreshing Agentera's app files is still `--only bundle`, but
user-facing docs and diagnostics describe that flow as an app repair. Human
output says `needs repair` when a no-write preview is the next safe step.

### Keep Agentera's app files current

Package and marketplace updates refresh what the host sees, but they may not
update the local app copy that actually runs Agentera. If `/agentera` reports
that Agentera is out of date or `agentera hej` is unavailable, preview the repair
first. The preview changes nothing:

```bash
uvx --from git+https://github.com/jgabor/agentera agentera upgrade --only bundle --install-root "$AGENTERA_HOME" --dry-run
```

After confirming the preview, apply the same Agentera directory:

```bash
uvx --from git+https://github.com/jgabor/agentera agentera upgrade --only bundle --install-root "$AGENTERA_HOME" --yes
```

Then retry Agentera:

```bash
uv run "$AGENTERA_HOME/app/scripts/agentera" hej
```

If `AGENTERA_HOME` is unset, Agentera uses the normal data directory for your
operating system. If it points at a missing path, a file, or a directory with
unrelated files, Agentera stops instead of guessing. Choose a different Agentera
directory before applying, or use `--force` only after checking that directory is safe
to replace.

When the normal platform directory is selected and the old `~/.agents/agentera`
directory still contains Agentera files, the preview says it will clean up the old
directory. Apply mode moves known user data such as `PROFILE.md` and `USAGE.md`
into the selected Agentera directory, removes old app files, and removes
`~/.agents/agentera` when it becomes empty.

<details>
<summary><strong>Claude Code hooks</strong></summary>

No extra setup is needed when Agentera is installed as a Claude Code plugin.

Claude Code provides the app-home environment Agentera needs. Hooks can
preload recent project context, validate artifact writes, and save session
bookmarks.

</details>

<details>
<summary><strong>OpenCode hooks</strong></summary>

Plugin install command:

```bash
mkdir -p ~/.config/opencode/plugins
curl -fsSL https://raw.githubusercontent.com/jgabor/agentera/main/.opencode/plugins/agentera.js \
  -o ~/.config/opencode/plugins/agentera.js
```

The plugin does not install the skills. It adds Agentera commands,
app-home discovery, artifact checks, and session bookmarks around skills
installed through `npx skills add jgabor/agentera -g -a opencode --skill agentera -y` or another
OpenCode skill path.

</details>

<details>
<summary><strong>Copilot CLI hooks</strong></summary>

Install from the Agentera marketplace:

```bash
copilot plugin marketplace add jgabor/agentera
copilot plugin install jgabor/agentera
```

The plugin includes Copilot hook definitions. The Agentera upgrade flow can also
persist helper-script access for Copilot shells.

Restart your shell after applying config changes.

</details>

<details>
<summary><strong>Codex CLI hooks</strong></summary>

Marketplace install:

```bash
codex plugin marketplace add jgabor/agentera
```

Then use interactive `/plugins` to install and enable the plugin.

The Agentera upgrade flow can wire helper-script access and artifact-validation
hooks for Codex.

</details>

Upgrade/setup writes are idempotent and preview changes before applying them.

For adapter-level runtime details, see
[`references/adapters/runtime-feature-parity.md`](./references/adapters/runtime-feature-parity.md).

<details>
<summary><strong>Manual clone fallback</strong></summary>

Manual clones are mostly useful for development, pinned local installs, or
inspection. The normal user-facing upgrade path is documented in
[UPGRADE.md](./UPGRADE.md).

</details>

## For capability authors

Agentera is also a reference implementation of a portable skill protocol.

Build against the artifact contracts instead of a single runtime. A capability
that reads `.agentera/plan.yaml`, writes `.agentera/health.yaml`, and uses the
shared severity/confidence vocabulary can mesh with the rest of the suite even
when the host runtime changes.

The core surfaces:

- [`skills/agentera/protocol.yaml`](./skills/agentera/protocol.yaml): shared primitives and vocabulary.
- [`skills/agentera/capability_schema_contract.yaml`](./skills/agentera/capability_schema_contract.yaml): capability schema contract.
- [`scripts/capability_contract.py`](./scripts/capability_contract.py): loader/model that makes the capability schema contract executable for validators and tests.
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

Optimera does not use root objective artifacts, registries, symlinks, or global
docs mappings for objective state. Each objective stays self-contained in its
own `.agentera/optimera/<name>/` directory.

Global profile:

`PROFILE.md` lives under `$PROFILERA_PROFILE_DIR`, defaulting to the
platform-appropriate agentera data directory.

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
