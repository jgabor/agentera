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
<a href="#packages">Packages</a> ·
<a href="#quick-start">Quick start</a> ·
<a href="#capabilities">Capabilities</a> ·
<a href="#development">Development</a> ·
<a href="#internals">Internals</a>
</p>
</div>

## Packages

| Package              | Path                                   | What it is                                                          |
| -------------------- | -------------------------------------- | ------------------------------------------------------------------- |
| **@agentera/cli**    | [`packages/cli`](./packages/cli)       | The agent. One CLI that owns memory, routing, and capabilities.     |
| **@agentera/mobile** | [`packages/mobile`](./packages/mobile) | The flagship app — SvelteKit, Cursor SDK, Cloudflare.             |
| **@agentera/web**    | [`packages/web`](./packages/web)       | Marketing site and published docs.                                 |

Missing behavior is built into Agentera, never bolted on. No extensions,
plugins, or MCP servers anywhere.

## Quick start

### CLI

```bash
npx -y agentera@next prime
```

`prime` returns a briefing on the current project and suggests what to do next.
You talk to the colleague; the CLI handles the rest.

See [`packages/cli/README.md`](./packages/cli/README.md) for channels, upgrade paths, and contributor build steps.

### Mobile app

The mobile app is the primary place you live inside the workflow. Development lives in [`packages/mobile`](./packages/mobile).

```bash
pnpm install
vp run mobile:dev      # fmt/lint via Vite+ stub until SvelteKit lands
vp run mobile:check    # same — no app dev server yet
```

See [`packages/mobile/README.md`](./packages/mobile/README.md) for product philosophy, UI conventions, and dev commands.
Monorepo consolidation plan: [`docs/consolidation/monorepo-plan.md`](./docs/consolidation/monorepo-plan.md).
Open decisions (CLI ↔ mobile integration, publish identity): [`docs/consolidation/mobile-open-decisions.md`](./docs/consolidation/mobile-open-decisions.md).

### Website

```bash
pnpm install
vp run web:dev         # http://localhost:4321
vp run web:check
```

See [`packages/web/README.md`](./packages/web/README.md).

## What you get

Every project Agentera works on gets a structured memory under `.agentera/`:

```text
.agentera/
  vision.yaml              product direction
  plan.yaml                active plan and acceptance criteria
  progress.yaml            shipped work and verification evidence
  decisions.yaml           durable reasoning trail
  health.yaml              architecture, test, dependency, and artifact health
  docs.yaml                documentation inventory
```

Human-facing artifacts at the project root when useful: `TODO.md`, `CHANGELOG.md`, `DESIGN.md`.

The CLI is the colleague's brain. It remembers what was decided, what was
planned, what shipped, and what's broken — so you don't have to scroll chat
history to recover context. Mobile is the primary surface for living inside
the workflow; the CLI is the brain underneath it.

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

Requires Node.js 22+ with pnpm 10.30.3. Contributor rules: [`AGENTS.md`](./AGENTS.md).

```bash
pnpm install
lefthook install

# Package shortcuts from repo root
vp run web:dev
vp run web:check
vp run mobile:dev      # packages/mobile
vp run mobile:check

# CLI
pnpm -C packages/cli test
pnpm -C packages/cli build
node packages/cli/dist/bin/agentera.js check validate capability-contract --format json
```

---

## Internals

Agentera runs inside the coding agent you already use — Claude Code, Cursor,
Codex, Copilot, OpenCode. The host provides the model; Agentera provides the
colleague. Same workflow, same memory, same capabilities — wherever you work.

<details>
<summary><strong>Install inside a host agent</strong></summary>

Install the Agentera CLI first (`npx -y agentera@next`), then pick a host:

**Claude Code**

```bash
npx skills add jgabor/agentera -g -a claude-code --skill agentera -y
```

**OpenCode**

```bash
npx skills add jgabor/agentera -g -a opencode --skill agentera -y
mkdir -p ~/.config/opencode/plugins
curl -fsSL https://raw.githubusercontent.com/jgabor/agentera/main/.opencode/plugins/agentera.js \
  -o ~/.config/opencode/plugins/agentera.js
```

**Cursor**

```bash
git clone https://github.com/jgabor/agentera.git ~/.cursor/plugins/local/agentera
# or: npx skills add jgabor/agentera -g -a cursor --skill agentera -y
# plus: uvx --from git+https://github.com/jgabor/agentera agentera upgrade --project "$PWD" --runtime cursor --yes
```

**Copilot CLI**

```bash
copilot plugin marketplace add jgabor/agentera
copilot plugin install jgabor/agentera
```

**Codex CLI**

```bash
codex plugin marketplace add jgabor/agentera
codex plugin add agentera@agentera
```

Runtime parity details: [`references/adapters/runtime-feature-parity.md`](./references/adapters/runtime-feature-parity.md).

</details>

<details>
<summary><strong>CLI channels and upgrade</strong></summary>

| Channel                    | npm tag   | Use for                  |
| -------------------------- | --------- | ------------------------ |
| development (3.x)          | `@next`   | `npx -y agentera@next`   |
| stable (2.x until cutover) | `@latest` | `npx -y agentera@latest` |

Upgrade and migration: [`UPGRADE.md`](./UPGRADE.md).

Troubleshooting:

```bash
npx -y agentera@next doctor
npx -y agentera@next upgrade --dry-run --channel development
```

</details>

<details>
<summary><strong>How structured state works</strong></summary>

Each capability reads what earlier ones wrote, does its work, and leaves evidence for the next run. Agents query through the CLI:

```bash
npx -y agentera@next state query --list-artifacts
npx -y agentera@next prime --context plan --format json
```

Capability schemas: `skills/agentera/capabilities/<name>/schemas/`. Instruction modules: `packages/cli/src/capabilities/<name>/instructions.ts`.

</details>

---

**License:** [Apache-2.0](./LICENSE) · **Version:** 3.0.0-next.1 · **Author:** Jonathan Gabor [jgabor.se](https://jgabor.se)
