# Agentera mobile design system

Visual identity for the Agentera mobile app (`@agentera/mobile`). Touch-first, responsive web UI — distinct from the terminal-native design system in the monorepo root `DESIGN.md`.

## Philosophy

Phone-shaped interactions are the design language, not adaptations of a desktop agent. Every screen works at 360px first. The smart bar replaces slash commands; the sidebar replaces scattered settings panels.

One brand (Agentera), one voice (direct, opinionated, warm). Mobile UI uses standard web components and Tailwind tokens, not box-drawing terminal glyphs — except where capability glyphs appear as subtle signatures in capability pickers and status displays.

## Breakpoints

| Name    | Min width | Intent                                                            |
| ------- | --------- | ----------------------------------------------------------------- |
| mobile  | 0         | Primary design target                                             |
| tablet  | 768px     | Two-column layouts where useful (diff review, sidebar persistent) |
| desktop | 1024px    | Wider chat column; sidebar docked                                 |

Design mobile-first; enhance at larger breakpoints, never degrade below 360px.

## Core UI regions

| Region    | Role                                                                     |
| --------- | ------------------------------------------------------------------------ |
| Chat      | Primary surface — messages, tool results, capability introductions       |
| Smart bar | Contextual next-action buttons above the composer                        |
| Composer  | Message input, attachment picker, queue controls                         |
| Sidebar   | Control center — settings, git context, custom actions, utilities status |

## Smart bar

- Surfaces 1–4 actions maximum; overflow goes to sidebar or a "more" sheet
- Labels are plain language ("Review diff", "Plan next step"), not slash commands
- Actions appear when workflow state makes them relevant (IDLE, DISCUSS, PLAN, BUILD, REVIEW)
- Disabled state explains why (e.g. "No uncommitted changes")

## Sidebar

- Toggleable on mobile; persistent on tablet/desktop
- Sections: autonomy level, compact, review, history, custom actions, status strip
- Status strip shows context usage, git branch, worktree, background utility state
- Custom actions are user-defined shortcuts (e.g. `vp run deploy`), not arbitrary plugins

## Touch targets

- Minimum tap target: 44×44 CSS pixels
- Spacing between adjacent actions: at least 8px
- Swipe gestures reserved for queue management and diff navigation only

## Capability glyphs

Reuse monorepo glyph assignments for capability pickers and status chips:

| Glyph | User-facing | Internal    |
| :---: | ----------- | ----------- |
|   ⌂   | brief       | hej         |
|   ⛥   | vision      | visionera   |
|   ❈   | discuss     | resonera    |
|   ⬚   | research    | inspirera   |
|   ≡   | plan        | planera     |
|   ⧉   | build       | realisera   |
|   ⎘   | optimize    | optimera    |
|   ▤   | document    | dokumentera |
|   ◰   | design      | visualisera |
|   ⛶   | audit       | inspektera  |
|   ♾   | profile     | profilera   |
|   ⎈   | orchestrate | orkestrera  |

Glyphs appear in capability headers and smart-bar chips; not in every message bubble.

## Paste and queue affordances

- Multi-line paste collapses to `[Pasted lines +N]` with expand/collapse control
- Queued messages show a visible queue indicator; interrupt distinguishes steer (interrupt) vs follow-up (after turn)

## Composition rules

- Chat content is scannable: tool results collapsed by default, expandable on tap
- Diff review supports side-by-side (tablet+) and stacked (mobile) modes
- Rewind/undo actions appear inline on the message or file change they affect
- No decorative chrome — density serves late-night couch sessions

## Relationship to monorepo DESIGN.md

| Surface                  | Design authority                        |
| ------------------------ | --------------------------------------- |
| Terminal / CLI dashboard | Root `DESIGN.md` in jgabor/agentera     |
| Mobile web app           | This file (`packages/mobile/DESIGN.md`) |

Shared: product name, capability glyphs, voice. Not shared: box-drawing logo usage, terminal severity arrows, Markdown layering rules.
