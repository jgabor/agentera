# AGENTS.md

Guidance for AI coding agents working in the Agentera mobile package.

## What this is

Agentera (`@agentera/mobile`) is the official mobile-first coding agent app in the
[jgabor/agentera](https://github.com/jgabor/agentera) monorepo at `packages/mobile`.
It is an opinionated product with a fixed system prompt, fixed tools, and a single
chat surface. It does not load skills, MCP servers, plugins, or runtime adapters.

## Stack

- **SvelteKit** — app framework and routing
- **Cursor SDK** — agent runtime integration
- **Tailwind CSS** — styling
- **Cloudflare Worker** — deployment target
- **Vite+** (`vp`) — canonical entry point for dev, lint, test, build, deploy

## Key conventions

- Use `vp dev`, `vp check`, `vp test`, `vp build`, `vp deploy` — not ad-hoc toolchains
- Mobile-first: every screen must work at 360px width first
- No extension or plugin architecture — build missing behavior into the app
- User-facing capability names are English (brief, discuss, plan); internal runtime names use -era suffix (hej, resonera, planera) — see README alias table
- Project state lives in the monorepo root `.agentera/` (vision, plan, progress, decisions, docs)
- Do not modify `.agentera/vision.yaml` during routine execution cycles unless running visionera or an explicit vision task

## Monorepo relationship

| Package            | Role                                             |
| ------------------ | ------------------------------------------------ |
| `@agentera/mobile` | This app — primary product surface               |
| `@agentera/web`    | Marketing site and Starlight docs                |
| `@agentera/cli`    | Agent runtime and `.agentera/` project-state CLI |

Mobile uses Cursor SDK directly, not skill routing from `skills/agentera/SKILL.md`.

## Commit conventions

Concise, imperative commit messages describing the product change. Examples: `add smart bar action routing`, `fix: sidebar context usage display`.

Scopes (optional): `mobile`, `ui`, `agent`, `deploy`, `docs`.

## Running checks

```bash
vp dev     # Development server
vp check   # Format, lint, type-check, tests
vp test    # Test suite only
vp lint    # Lint and format only
```

Install git hooks once: `lefthook install`
