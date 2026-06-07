# Agentera

Official mobile app for Agentera (`@agentera/mobile`) — an opinionated mobile-first coding agent built with [Cursor SDK](https://cursor.com/docs/sdk/typescript), [SvelteKit](https://svelte.dev/), and [Tailwind](https://tailwindcss.com/).

_FIXME: Add logo, badges, and screenshot._

Agentera does not, and will not, support extensions, plugins, MCP servers, or any other type of customization. It ships with a fixed system prompt, a fixed set of tools, and a workflow that works out of the box.

## Philosophy

Agentera is intentionally opinionated, based on a set of non-negotiables. Anything missing is built into Agentera, and never pushed into hooks, modes, plugins, skills, or any other type of customization.

- **Low latency** without sacrificing a rich user experience
- **Cache optimized** by combining intelligent compaction with stable context-prefixing
- **Mobile friendly** with responsiveness for those late night vibe sessions
- **Built-in tools** that just work and transparently compress results
- **Subagents** for aggressive parallelism, wider exploration, and deeper reasoning
- **Tiered model system** for maximum cost and token efficiency
- **YOLO** by default, but with configurable levels of autonomy
- **Single mode** to avoid context switching between planning and building

**tl;dr:** Agentera will always be immediately productive out of the box.

**Planning:** Ecosystem vision in [`.agentera/vision.yaml`](../../.agentera/vision.yaml). Full monorepo consolidation plan in [`docs/consolidation/monorepo-plan.md`](../../docs/consolidation/monorepo-plan.md).

## Chat interface

The chat is the only surface. These conventions replace slash commands and desktop-only patterns.

| Convention | How it works                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Smart bar  | The next recommended actions appear as buttons at the right time, replacing the burden of remembering slash commands                       |
| Attachment | Instead of typing `@` to search project files, a smart file dialog surfaces likely relevant files, with a fuzzy finder for everything else |
| Paste      | Pasting >2 lines results in a formatted `[Pasted lines +X]` block that expands and collapses with a single tap                             |
| Queue      | Messages queue while work is active, but can optionally interrupt or steer                                                                 |
| Diff       | Review uncommitted changes as side-by-side or stacked diffs                                                                                |
| Rewind     | Rewind the conversation or undo a file change with a single tap shown in context                                                           |

### Sidebar

The sidebar is the control center: quick actions, settings, and live project context in one toggleable panel.

| Widget / action | What it does                                                                         |
| --------------- | ------------------------------------------------------------------------------------ |
| Compact         | Trigger context compaction manually                                                  |
| Autonomy        | Switch between off, read, write, and yolo tool-approval levels                       |
| Review          | Open diff review for the current repo                                                |
| History         | Browse and resume past conversations                                                 |
| Custom actions  | User-defined buttons (e.g. a `Deploy` action that runs `vp run deploy`)              |
| Status strip    | Background utility status, context usage vs window, git repo, branch, diff, worktree |

## Built-in actions, capabilities, tools, and utilities

Everything here is built in:

- **Actions** are initiated by a button or message.
- **Capabilities** are agent workflows built on top.
- **Tools** touch the world: files, shell, search, and fetch.
- **Utilities** are background chores run by the utility model.

### Actions

One-tap shortcuts surfaced in the smart bar or sidebar when context makes them useful. Examples include compact, review diff, rewind last edit, and user-defined custom actions.

### Capabilities

User-facing names appear in the app; internal names match the monorepo agent runtime.

| Glyph | User-facing | Internal    | What it does                                                                       |
| :---: | ----------- | ----------- | ---------------------------------------------------------------------------------- |
|   ⌂   | brief       | hej         | Briefs on project status, current plan, known gaps, and suggested next action      |
|   ⛥   | vision      | visionera   | Helps you shape the project's vision and long-term goals                           |
|   ❈   | discuss     | resonera    | Structured deliberation before consequential choices                               |
|   ⬚   | research    | inspirera   | Assists with adapting concepts, patterns, or solutions                             |
|   ≡   | plan        | planera     | Scoped planning with behavioral acceptance criteria                                |
|   ⧉   | build       | realisera   | Executes a single task or step of a plan, and then holds                           |
|   ⎘   | optimize    | optimera    | Helps you research and design a locked harness that optimizes a metric             |
|   ▤   | document    | dokumentera | Keeps documentation aligned with the actual project                                |
|   ◰   | design      | visualisera | Creates a design system that is durable and understood by agents                   |
|   ⛶   | audit       | inspektera  | Architecture, test, dependency, and project health audits                          |
|   ♾   | profile     | profilera   | Profiles your decision thought processes from previous conversations               |
|   ⎈   | orchestrate | orkestrera  | Bounded plan coordination with supervised child work, evaluation, and retry checks |

You do not need to remember these names. Say what you want — "Help me decide" routes to `discuss` and Agentera guides you from there.

### Tools

Minimal set of tools that just work and transparently compress results on the fly.

| Glyph | Tool  | What it does                                                   |
| :---: | :---- | -------------------------------------------------------------- |
|       | read  | Reads files with line ranges and safe previews                 |
|       | edit  | Applies approved text edits safely                             |
|       | write | Creates or overwrites files with permission checks and history |
|       | bash  | Runs local commands with visible scope and expected effect     |
|       | grep  | Searches project content and returns matching files and lines  |
|       | find  | Finds project files by path patterns                           |
|       | fetch | Fetches remote content and returns it as Markdown              |

### Utilities

Utility capabilities are hidden background work run by the utility model. They are never action commands.

| Glyph | Utility     | What it does                                                                |
| :---: | ----------- | --------------------------------------------------------------------------- |
|       | compression | Dynamically compresses and prunes stale messages and tool results           |
|       | memory      | Stores, reflects, and refreshes memories as needed                          |
|       | preparation | Prepares context for likely next work and pre-fills when needed             |
|       | profile     | Builds and refreshes your profile as decisions and patterns emerge          |
|       | workflow    | Keeps track of current progress and state to enable smooth state transition |

## Configuration

### Autonomy level

| Glyph | Level   | Meaning                                                                 |
| :---: | ------- | ----------------------------------------------------------------------- |
|       | `off`   | Every tool call must be approved                                        |
|       | `read`  | `read`, `find`, `fetch`, `grep`, `bash[git status, git diff, pwd, ls]`  |
|       | `write` | Everything above plus `edit`, `write`, and file-mutating shell commands |
|       | `yolo`  | All tool calls are granted. This is the default.                        |

### Tiered model system

Models are grouped into three tiers: `large`, `small`, and `utility`. Tiers can be assigned to each action, capability, and utility for cost and token efficiency, keeping the main context window lean.

Actions, capabilities, and utilities dispatch as subagents with their assigned tier; tools execute inside the subagent directly.

_FIXME: Add table with glyph, tier, default model, and action/capability/utility columns._

## Workflow

Agentera uses a small state machine behind the scenes. You should not have to think about it while using the app.

| State       | What it means                                               |
| ----------- | ----------------------------------------------------------- |
| **IDLE**    | Nothing is active yet; orient, resume, or route the request |
| **DISCUSS** | Think through a consequential choice before committing      |
| **PLAN**    | Turn intent into scoped work with acceptance criteria       |
| **BUILD**   | Make the change, document it, design it, or optimize it     |
| **REVIEW**  | Check architecture, tests, dependencies, and project health |

Most requests do not walk through every state. A tiny edit can go straight to `BUILD`. Vague or risky tasks slow down for clarification, discussion, or planning first. A review that finds something important loops back to the right earlier state.

Exit signals are handled as signals, not fake states. `complete` and `flagged` move work forward, `waiting` pauses for input, and `stuck` parks work with blocker details so it can be resumed or redirected later.

## Development

[Vite+](https://viteplus.dev/) is the canonical entry point for local and CI checks.

```bash
vp dev     # Start the development server
vp build   # Build Dockerfile
vp check   # Formatters, linters, tests, and hooks
vp deploy  # Deploy Docker image to Cloudflare
vp lint    # Formatting + linters
vp test    # Test suite
```

[Lefthook](https://lefthook.dev/) manages pre-commit and pre-push hooks.

## Tech stack

- Vite+
- SvelteKit
- Cursor SDK
- Cloudflare Worker

---

**License:** [Apache-2.0](./LICENSE) · **Version:** 0.0.1 · **Author:** Jonathan Gabor ([jgabor.se](https://jgabor.se))
