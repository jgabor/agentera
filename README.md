<div align="center">
<pre>
┌─┐┌─┐┌─┐┌┐┌┌┬┐┌─┐┬─┐┌─┐
├─┤│ ┬├┤ │││ │ ├┤ ├┬┘├─┤
┴ ┴└─┘└─┘┘└┘ ┴ └─┘┴└─┴ ┴
</pre>

<strong>One agent, one CLI, many capabilities.</strong>

The colleague, not the team — one persistent identity that thinks through every
step and keeps working when you walk away. Host coding agents are harnesses;
Agentera provides the identity, memory, discipline, and routing.

<p>
<a href="#packages">Packages</a> ·
<a href="#quick-start">Quick start</a> ·
<a href="#capabilities">Capabilities</a> ·
<a href="#development">Development</a> ·
<a href="#internals">Internals</a>
</p>
</div>

## Packages

| Package              | Path                                   | What it is                                                                   |
| -------------------- | -------------------------------------- | ---------------------------------------------------------------------------- |
| **@agentera/cli**    | [`packages/cli`](./packages/cli)       | Agent runtime — owns routing, memory, capability prose, worker-spec contract. Published to npm as `agentera`. The narrow waist: every other surface is a client. |
| **@agentera/mobile** | [`packages/mobile`](./packages/mobile) | Flagship product surface — SvelteKit, Cursor SDK, Cloudflare. Presentation-only tiering as a client of the CLI engine. |
| **@agentera/web**    | [`packages/web`](./packages/web)       | Marketing site and published Starlight docs                                  |

No extensions, plugins, MCP servers, or user skill loading on any surface —
ever. Missing behavior is built into Agentera, not loaded from outside.

## Quick start

### CLI (the agent runtime)

```bash
npx -y agentera@next prime --format json
npx -y agentera@next state plan --format json
```

`prime` returns the orientation briefing and suggests the next capability.
State commands read targeted slices; the CLI never asks you to raw-read
`.agentera/*.yaml`.

See [`packages/cli/README.md`](./packages/cli/README.md) for channels, upgrade paths, and contributor build steps.

### Mobile app (flagship surface)

Development lives in [`packages/mobile`](./packages/mobile). Mobile is a client
of the CLI engine — Cursor SDK registered as a Layer B adapter behind the CLI,
not a separate Agentera loop.

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

Agentera tracks project direction, active work, shipped evidence, deliberation history, health grades, and prioritized findings as structured artifacts under `.agentera/`:

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

The CLI is the colleague's brain and spine. Host agents learn one contract
(the CLI) and route through it for state access, capability prose, and worker
dispatch. Mobile is the flagship surface for living inside the workflow.

## Capabilities

Eleven top-level capabilities plus one background utility. v3 (`@next`) uses
English capability names everywhere; v2 stable (`@latest`) retains the legacy
Swedish `-era` IDs (Decision 70).

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
| ⎈   | orchestrate | Autonomous plan execution with evaluation |

`profile` is a background utility that surfaces through existing capabilities
(discuss, plan, status) — not a top-level peer of the eleven above.

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

Python 3.11+ with [uv](https://docs.astral.sh/uv/) is still used for the stable 2.x line on `main`.

---

## Internals

Host runtimes (Claude, Cursor, Codex, Copilot, OpenCode) are **harnesses** for
the same Agentera agent — the host provides the model and tool runtime, Agentera
provides the identity, memory, discipline, and routing. Schema contracts and
runtime adapters in the monorepo power every surface; they stay documented here
for contributors, not as a separate protocol headline.

<details>
<summary><strong>Host runtime installs (CLI skill bundle)</strong></summary>

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
