# Mobile open decisions

> Durable reference for ambiguous and non-blocking items from the mobile monorepo
> closeout (progress cycle 650, commit `4a2d301b`). Implementation work stays in
> [`packages/mobile/TODO.md`](../../packages/mobile/TODO.md).

## CLI ↔ mobile state integration

**Status:** Open — blocks SvelteKit scaffold wiring, not docs-only closeout.

The mobile app must read and write `.agentera/` project state (vision, plan,
progress, decisions, docs, health, TODO). Three integration strategies remain
on the table; **no choice has been recorded** — open, unnumbered. A future
decision may follow once [Decision 69](./d69/) (multi-surface invariant) and
the [D68 follow-up](./d69/d68-followup.md) clarify what "one fixed workflow"
means at the implementation layer.

| Option | Shape | Tradeoffs |
| ------ | ----- | --------- |
| **CLI subprocess** | Mobile shells out to `agentera prime`, `agentera state *`, and related commands | Reuses the shipped CLI contract and parity tests; subprocess latency and error parsing overhead; requires Node/npm or bundled CLI on device |
| **Embedded TypeScript** | Mobile imports shared modules from `packages/cli` (state readers, prime context builders) | Lowest latency and tightest type sharing; couples mobile release to CLI internals; must respect the self-contained npm bundle boundary for deploy |
| **Hybrid** | CLI subprocess for project-state reads/writes; Cursor SDK for the agent loop only | Clear separation of concerns; two integration surfaces to maintain; subprocess cost only on state transitions |

**References:**

- CLI channels, state commands, and contributor build: [`packages/cli/README.md`](../../packages/cli/README.md)
- Mobile workflow FSM and chat conventions: [`packages/mobile/README.md`](../../packages/mobile/README.md)
- Consolidation context: [`monorepo-plan.md`](./monorepo-plan.md)
- Related (separate) multi-surface invariant deliberation — Decision 69 draft
  archive: [`d69/`](./d69/) (start at [`d68-followup.md`](./d69/d68-followup.md))

## `@agentera/mobile` publish identity

**Status:** Open.

`packages/mobile/package.json` sets `"private": true`. Three distribution
models remain under consideration:

| Model | Meaning |
| ----- | ------- |
| **Workspace-private** | Package exists only inside the monorepo; no npm publish |
| **npm publish** | Scoped `@agentera/mobile` on npm for installable app/tooling consumers |
| **Deploy-only** | Cloudflare Worker (or similar) deploy artifact; no npm package |

Mobile v1 does not require a decision before SvelteKit scaffold work, but CI
and release docs should align once chosen.

## Skill bundle long-term role

**Status:** Open / horizon — not blocking mobile v1.

Decision 68 records that editor skill/plugin runtimes are **delivery surfaces**
for the same fixed twelve-capability workflow — not extension hosts. The
`skills/agentera/` bundle and `references/` schemas power CLI, web, and editor
surfaces today.

A future **sunset** of the editor skill path is an optional product decision,
not implied by the mobile-first pivot. Coexistence is the current default until
a separate decision records otherwise.

## Capability English schema rename (D3 provisional)

**Status:** Provisional — staging Decision D3 archived with alias-table confidence.

Mobile UX uses **English aliases** (brief, discuss, plan, …). CLI schemas and
runtime IDs retain Swedish `-era` names (`hej`, `resonera`, `planera`, …). The
alias table in [`packages/mobile/README.md`](../../packages/mobile/README.md) is
permanent user-facing UX.

A full internal schema rename is a **separate future pass** scoped to Decision
58 single-name protocol boundaries — not part of the mobile docs closeout.

## `packages/tui` vs `agentera-tui`

**Status:** Open / horizon — not blocking mobile v1.

Decision 68 names a future `packages/tui` package in the monorepo for terminal
UI surfaces. A separate repository
[`agentera-tui`](https://github.com/jgabor/agentera-tui) also exists. The
relationship (merge, fork, or independent track) is **TBD**.

## Hook plumbing stub (`vite.config.ts`)

**Status:** Temporary.

[`packages/mobile/vite.config.ts`](../../packages/mobile/vite.config.ts) exists
only so lefthook `vp staged` passes when staging docs-only markdown in
`packages/mobile/`. It configures Vite+ format/lint for `*.{md,json,yaml,yml}`
and is **not** application source.

Remove this stub when the SvelteKit scaffold replaces it with real app tooling.
Tracked in [`packages/mobile/TODO.md`](../../packages/mobile/TODO.md).

## TODO tag conventions

Root [`TODO.md`](../../TODO.md) uses `[type:3.0.0]` tags for validator
consistency. [`packages/mobile/TODO.md`](../../packages/mobile/TODO.md) keeps
informal `[docs]` / `[feat]` / `[chore]` tags until a separate normalization
pass; open items above are mirrored in both ledgers where appropriate.
