<div align="center">
<pre>
┌─┐┌─┐┌─┐┌┐┌┌┬┐┌─┐┬─┐┌─┐
├─┤│ ┬├┤ │││ │ ├┤ ├┬┘├─┤
┴ ┴└─┘└─┘┘└┘ ┴ └─┘┴└─┴ ┴
</pre>

<strong>One agent, one CLI, many capabilities.</strong>

The colleague, not the team — one persistent identity that thinks through every
step and keeps working when you walk away. Close the laptop at midnight; the
project remembers in the morning.

<p>
<a href="#get-started">Get started</a> ·
<a href="#what-you-see">What you see</a> ·
<a href="#what-you-get">What you get</a> ·
<a href="#capabilities">Capabilities</a> ·
<a href="#development">Development</a>
</p>
</div>

## Get started

1. Install Agentera inside your coding agent (see below).
2. Open a git project.
3. Run `/agentera` (`$agentera` in Codex).

Your first run bootstraps project memory (`.agentera/`) as you work.

### For LLMs

If your coding agent doesn't have a native install path, paste this into its chat:

```text
Install Agentera as your project memory and routing layer.

1. Run: npx -y agentera@next prime
2. Based on the briefing you get back, tell me what to do next.

After bootstrap, route via "/agentera <capability>" or plain language like "help me decide".
```

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

```bash
git clone https://github.com/jgabor/agentera.git ~/.cursor/plugins/local/agentera
```

Restart Cursor or run **Developer: Reload Window**.

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

</details>

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

  suggested → ❈ discuss (resolve API schema to unblock task 7)
```

The briefing pulls from many artifacts (plan, progress, decisions, health,
issues) but only the slices that matter right now. You get breadth without
paying for a full dump of project state on every turn.

## What you get

Every project Agentera works on gets a structured memory under `.agentera/`:

- **Project direction remembered** → `.agentera/vision.yaml`
- **Plan tracked with acceptance criteria** → `.agentera/plan.yaml`
- **Shipped work with verification evidence** → `.agentera/progress.yaml`
- **Durable reasoning trail for why decisions were made** → `.agentera/decisions.yaml`
- **Architecture, test, dependency, and artifact health grades** → `.agentera/health.yaml`
- **Documentation inventory and drift** → `.agentera/docs.yaml`

Human-facing artifacts at the project root when useful: `TODO.md`, `CHANGELOG.md`, `DESIGN.md`.

The CLI is the colleague's brain. It remembers what was decided, what was
planned, what shipped, and what's broken — so you don't have to scroll chat
history to recover context. Open a project, ask for a briefing, and pick up
where you left off.

## Capabilities

Twelve built-in workflows — one colleague, many things it can do.

|     | Capability  | Use it when you need...                   |
| --- | ----------- | ----------------------------------------- |
| ⌂   | status      | Project briefing and next best action     |
| ⛥   | vision      | Product direction                         |
| ❈   | discuss     | Structured deliberation                   |
| ⬚   | research    | External pattern analysis                 |
| ≡   | plan        | Scoped plan with acceptance criteria      |
| ⧉   | build       | One verified development cycle            |
| ⎘   | optimize    | Metric-driven optimization                |
| ▤   | document    | Documentation aligned with code           |
| ◰   | design      | Visual identity and design tokens         |
| ⛶   | audit       | Architecture and project health audits    |
| ♾   | profile     | Reusable decision profile                 |
| ⎈   | orchestrate | Autonomous plan execution with evaluation |

Say what you want — "help me decide" routes to discuss; Agentera guides from there.

## Development

Requires Node.js 22+ with pnpm 10.30.3. Contributor rules, build commands, and test layout live in [`AGENTS.md`](./AGENTS.md). CLI channels and upgrade paths: [`packages/cli/README.md`](./packages/cli/README.md).

---

**License:** [Apache-2.0](./LICENSE) · **Author:** Jonathan Gabor [jgabor.se](https://jgabor.se)
