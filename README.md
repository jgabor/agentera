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
<a href="#skills">Skills</a> ·
<a href="#hooks">Hooks</a>
</p>

</div>

## Why Agentera?

Coding agents are good at tasks and bad at continuity. They forget decisions,
repeat investigations, lose project context, and hand the next session a pile of
code with little explanation.

Agentera fixes that with twelve specialized skills that coordinate through
plain project files. One skill plans, another builds, another audits, another
documents, another remembers your decision style. The work stops being a chat
transcript and becomes an operating record for the project.

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

Start with `/hej` (`$hej` in Codex). It gives you a project briefing and routes
you to the most useful next skill.

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

  suggested → ❈ /resonera (resolve API schema to unblock task 7)
```

## Quick start

Pick the agent you use, install Agentera, then open a project and run the
entry skill.

### Claude Code

```bash
npx skills add jgabor/agentera -g -a claude-code --skill '*' -y
```

Start with `/hej`.

### OpenCode

Install the skills and the OpenCode plugin. The skills provide the actual
Agentera workflows; the plugin adds `/hej` commands, hooks, and install-root
discovery.

```bash
npx skills add jgabor/agentera -g -a opencode --skill '*' -y
mkdir -p ~/.config/opencode/plugins
curl -fsSL https://raw.githubusercontent.com/jgabor/agentera/main/.opencode/plugins/agentera.js \
  -o ~/.config/opencode/plugins/agentera.js
```

Start with `/hej`.

### Copilot CLI

```bash
copilot plugin marketplace add jgabor/agentera
copilot plugin install jgabor/agentera
```

Start with `/hej`.

### Codex CLI

```bash
codex plugin marketplace add jgabor/agentera
```

Open `/plugins`, enable Agentera, and start with `$hej`.

Normal skill use does not require helper scripts. Hooks are recommended when
you want session bookmarks, artifact validation, and helper-script access.
See [Hooks](#hooks).

If Agentera does not appear in Codex after a marketplace update, refresh
Codex's cache:

```bash
codex plugin marketplace upgrade agentera
```

## Why it works

Most coding agents forget. Agentera writes the useful residue of the work into
plain markdown artifacts that live with the project:

- `VISION.md`: where the project is going.
- `.agentera/DECISIONS.md`: why important choices were made.
- `.agentera/PLAN.md`: what should happen next.
- `.agentera/PROGRESS.md`: what shipped, how it was verified, and what changed.
- `.agentera/HEALTH.md`: where architecture and quality are drifting.
- `.agentera/DOCS.md`: which docs exist, what they cover, and what is stale.

Each skill reads the artifacts it needs and writes the artifact it owns. That is
the trick: the next agent does not have to infer history from chat. It can read
the project’s operating record.

## The memory layer

`profilera` is the skill that makes Agentera feel personal instead of merely
stateful. It studies your decisions, tradeoffs, corrections, and recurring
preferences, then writes them into an editable `PROFILE.md`.

That profile teaches later agents how you think: what evidence you trust, when
you prefer speed over polish, how much planning you want, what kinds of tests
convince you, and when you expect pushback.

The profile is confidence-weighted and optional. If it exists, every skill can
use it to reason more like you. If it is missing, Agentera still works.

## Get the most out of it

- **Returning to a repo**: run `/hej`. Let it read project state and route you.
- **Starting something big**: run `/visionera` for direction, then `/planera`.
- **Stuck on a tradeoff**: run `/resonera`; it records the decision for later agents.
- **Ready to build one focused thing**: run `/realisera`.
- **Ready to execute a whole plan**: run `/orkestrera`.
- **Worried the codebase is drifting**: run `/inspektera`.
- **Optimizing a metric**: run `/optimera` with the score you want to improve.

A good default loop is:

```text
/hej → /resonera or /planera → /orkestrera → /inspektera
```

## Skills

| Skill | Use it when you need... |
|-------|--------------------------|
| ⌂ [`hej`](./skills/hej/) | A project briefing and the next best action. |
| ⛥ [`visionera`](./skills/visionera/) | A strong product direction and `VISION.md`. |
| ❈ [`resonera`](./skills/resonera/) | Structured deliberation before consequential choices. |
| ⬚ [`inspirera`](./skills/inspirera/) | To map an external link, repo, or pattern to your project. |
| ▤ [`dokumentera`](./skills/dokumentera/) | Docs that stay aligned with code and project intent. |
| ◰ [`visualisera`](./skills/visualisera/) | A durable visual identity and design-token direction. |
| ≡ [`planera`](./skills/planera/) | A scoped plan with behavioral acceptance criteria. |
| ⎈ [`orkestrera`](./skills/orkestrera/) | Autonomous plan execution with evaluation and retry gates. |
| ⧉ [`realisera`](./skills/realisera/) | One verified development cycle. |
| ⎘ [`optimera`](./skills/optimera/) | Measured improvement of a concrete metric. |
| ⛶ [`inspektera`](./skills/inspektera/) | Architecture, test, dependency, and artifact health audits. |
| ♾ [`profilera`](./skills/profilera/) | A reusable decision profile that helps every skill reason more like you. |

## Hooks

Agentera works as portable skills first. Hooks are optional, but they add enough
value that most users should know they exist.

Use hooks when you want:

- Session continuity between agent runs.
- Artifact checks while the agent edits project files.
- Runtime shell tools that know where Agentera is installed.

Profile data already uses the platform data directory by default:
`$XDG_DATA_HOME/agentera` on Linux, `~/Library/Application Support/agentera` on
macOS, and `%APPDATA%/agentera` on Windows.

`AGENTERA_HOME` is different. It points to the Agentera install root, so skills
and hooks can resolve repo helper scripts such as `compact_artifact.py`.
Claude Code and OpenCode can set that automatically. Codex and Copilot may need
a host-level setup step when you want helper-script execution.

The current helper scripts assume you know the Agentera install root. If you
installed from a marketplace and your runtime does not expose that path, normal
skills still work. A unified installer and doctor command are planned for a
future release.

The helpers use an existing valid `AGENTERA_HOME` to find the install root.
They may still write persistent runtime config so future agent sessions can see
the same value.

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
installed through `npx skills add` or another OpenCode skill path.
Session preload is not enabled yet, so start returning work with `/hej`.

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
python3 "$AGENTERA_HOME/scripts/setup_copilot.py"
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
python3 "$AGENTERA_HOME/scripts/setup_codex.py"
```

For Codex agent dispatch, also create `[agents.<name>]` entries:

```bash
python3 "$AGENTERA_HOME/scripts/setup_codex.py" --enable-agents
```

That flag writes config entries pointing at bundled files under
`skills/<name>/agents/<name>.toml`. It does not generate those files.

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
  python3 "${AGENTERA_HOME:-$CLAUDE_PLUGIN_ROOT}/scripts/compact_artifact.py"
'
```

You want to see the expected `AGENTERA_HOME` path and the `compact_artifact.py`
usage line. For Codex, run the same check from a Codex shell command after
`setup_codex.py`, because Codex passes `AGENTERA_HOME` through its config.

For adapter-level runtime details, see
[`references/adapters/runtime-feature-parity.md`](./references/adapters/runtime-feature-parity.md).

<details>
<summary><strong>Manual clone fallback</strong></summary>

```bash
git clone git@github.com:jgabor/agentera.git ~/.agents/agentera
```

Then link or reference `skills/<name>/SKILL.md` through your runtime’s skill
folder mechanism. For OpenCode:

```bash
mkdir -p ~/.config/opencode/skills
for skill in ~/.agents/agentera/skills/*/; do
  ln -s "$skill" ~/.config/opencode/skills/$(basename "$skill")
done
```

</details>

## For skill authors

Agentera is also a reference implementation of a portable skill protocol.

Build against the artifact contracts instead of a single runtime. A skill that
reads `PLAN.md`, writes `HEALTH.md`, and uses the shared severity/confidence
vocabulary can mesh with the rest of the suite even when the host runtime
changes.

The core surfaces:

- [`SPEC.md`](./SPEC.md): shared primitives and artifact contracts.
- [`registry.json`](./registry.json): skill index, versions, tags, paths.
- [`references/adapters/runtime-feature-parity.md`](./references/adapters/runtime-feature-parity.md):
  runtime capability comparison.

## Maintainer checks

```bash
python3 scripts/generate_contracts.py --check
python3 scripts/validate_spec.py
python3 scripts/validate_lifecycle_adapters.py
python3 -m pytest -q
```

<details>
<summary><strong>State artifact reference</strong></summary>

Project-facing files:

| Artifact | Owner | Purpose |
|----------|-------|---------|
| `VISION.md` | visionera, realisera | Product direction. |
| `TODO.md` | realisera, inspektera | Prioritized work and findings. |
| `CHANGELOG.md` | realisera | Contributor-facing release history. |

Operational files in `.agentera/`:

| Artifact | Owner | Purpose |
|----------|-------|---------|
| `PROGRESS.md` | realisera | Cycle history and verification notes. |
| `DECISIONS.md` | resonera | Durable reasoning trail. |
| `PLAN.md` | planera | Active task plan. |
| `HEALTH.md` | inspektera | Audit grades, findings, trends. |
| `DOCS.md` | dokumentera | Documentation index and coverage. |
| `DESIGN.md` | visualisera | Visual identity system. |
| `SESSION.md` | session stop hook | Session bookmarks. |

Global profile:

`PROFILE.md` lives under `$PROFILERA_PROFILE_DIR`, defaulting to the
platform-appropriate agentera data directory.

</details>
