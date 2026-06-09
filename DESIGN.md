# Agentera

Visual identity system for Agentera. Terminal-native tokens for CLI and agent-rendered Markdown; mobile UI tokens live in [`packages/mobile/DESIGN.md`](./packages/mobile/DESIGN.md).

## Surface register

One brand (Agentera), three register layers: terminal/mobile surfaces (below), brand-vs-product output registers, and suite-vs-project design authorities.

| Surface | Authority | Renders |
| --- | --- | --- |
| `terminal` | This file (`DESIGN.md`) | CLI dashboard, capability introductions, structured artifact headers in Markdown |
| `mobile` | `packages/mobile/DESIGN.md` | Touch UI, smart bar, sidebar, chat composer, responsive layouts |

Shared across surfaces: product name, capability glyphs, sharp-colleague voice.
Not shared: box-drawing logo usage (terminal key moments only), terminal severity arrows in mobile UI, Tailwind touch targets in terminal output.

## Output Registers

Agentera separates **where** tokens apply. One `DESIGN.md` holds both registers; agents must know which register governs the surface they render.

### Brand register

Human-facing root documentation: `README`, `UPGRADE`, `CHANGELOG`, package and plugin copy, and other public prose for installers and contributors. Voice may be warmer and more explanatory. The logo may appear in README hero contexts. Skill glyphs are optional; prefer plain capability names in prose.

### Product register

Agent-rendered terminal output for whichever design authority this file belongs to:

- **Suite `DESIGN.md`:** hej dashboard, capability introductions and exits, Agentera CLI-formatted state summaries
- **Project `DESIGN.md`:** the host product's own CLI, agent, or terminal-native output

The product register enforces logo scarcity, protocol glyphs, section dividers, and composition rules below. When an agent emits structured terminal Markdown on behalf of Agentera, the **suite** product register wins even if the same session also edited README or the host project has its own `DESIGN.md`.

### Design authorities (suite vs project)

Agentera maintains **two design authorities**. They never merge into one artifact.

#### Suite design authority

Governs **Agentera capability chrome** when the suite renders terminal output inside any host project.

| Source | Role |
|--------|------|
| `protocol.yaml` | Shared glyphs, dividers, severity, confidence, and exit tokens (npm bundle or app-home skills) |
| `agentera prime --context` capability prose (D65) | Hej dashboard, introductions, exits, and startup contracts |
| v2 `$AGENTERA_HOME/app/DESIGN.md` when present | Legacy managed-install suite product register |
| Agentera repo root `DESIGN.md` | Suite dogfood terminal register plus brand register for this repository |

**Surfaces:** hej orientation dashboard, capability introductions and exit markers, CLI-formatted `agentera state` summaries agents emit as Agentera.

#### Project design authority

Governs the **host repository's own product** — web UI, the user's coding-agent CLI, docs site, or other app output visualisera was asked to design.

| Source | Role |
|--------|------|
| Project `DESIGN.md` | Per-repo artifact via docs mapping (default: project root) |

**Surfaces:** the project's application UI, the project's own CLI or agent terminal output, and project-specific styled docs. Not Agentera suite chrome.

#### Resolution rules

- v3 npm publish (`packages/cli/bundle/`) ships `skills/` and `protocol.yaml`; it does **not** copy suite `DESIGN.md` into host projects.
- v2 managed app-home may include `app/DESIGN.md`; project install still does **not** copy it to the host project root.
- Visualisera in a host project writes **project** `DESIGN.md` only; never merge suite design sources into it.
- Hej reads project design for **status metadata** (exists, stale, missing) — not to style suite chrome.
- When both authorities apply in one session, suite chrome follows suite sources; the host product follows project `DESIGN.md`.
- In the Agentera repository, root `DESIGN.md` is suite terminal dogfood plus brand register; `packages/mobile/DESIGN.md` is the mobile surface register.


## Philosophy

The ambitious workshop. Every visual element carries semantic weight; craft and density are the same move. Open structure over enclosure: no frames except the logo, breathing room between sections, precision in alignment. The box-drawing logo is the crown; everything else earns distinction through Unicode glyphs and whitespace.

Modern terminal assumed. Full Unicode space available.


## Logo

The agentera logo uses box-drawing characters exclusively. It appears at key moments only: the hej dashboard, major completions, significant artifacts. Scarcity keeps it special.

<!-- design:logo -->

```yaml
text: |
  ┌─┐┌─┐┌─┐┌┐┌┌┬┐┌─┐┬─┐┌─┐
  ├─┤│ ┬├┤ │││ │ ├┤ ├┬┘├─┤
  ┴ ┴└─┘└─┘┘└┘ ┴ └─┘┴└─┴ ┴
placement: standalone-top
usage: key-moments-only
```

## Skill Glyphs

Each skill has a unique Unicode glyph that appears in section headers as a subtle signature. The glyphs lean into geometric shapes: angular, precise, echoing the logo's sharp corners.

<!-- design:glyphs -->

```yaml
hej:         { glyph: "⌂", code: "U+2302", meaning: "home base" }
realisera:   { glyph: "⧉", code: "U+29C9", meaning: "joined building blocks" }
inspektera:  { glyph: "⛶", code: "U+26F6", meaning: "viewfinder frame" }
resonera:    { glyph: "❈", code: "U+2748", meaning: "spark of insight" }
planera:     { glyph: "≡", code: "U+2261", meaning: "structured layers" }
visionera:   { glyph: "⛥", code: "U+26E5", meaning: "guiding star" }
optimera:    { glyph: "⎘", code: "U+2398", meaning: "measurement" }
dokumentera: { glyph: "▤", code: "U+25A4", meaning: "text on page" }
profilera:   { glyph: "♾", code: "U+267E", meaning: "permanent mark" }
inspirera:   { glyph: "⬚", code: "U+2B1A", meaning: "frame to fill" }
visualisera: { glyph: "◰", code: "U+25F0", meaning: "design grid" }
orkestrera:  { glyph: "⎈", code: "U+2388", meaning: "helm, steering" }
```

## Status Tokens

Task and item completion states. Square family: fill progression from empty to solid.

<!-- design:status -->

```yaml
complete:    { glyph: "■", code: "U+25A0" }
in-progress: { glyph: "▣", code: "U+25A3" }
open:        { glyph: "□", code: "U+25A1" }
blocked:     { glyph: "▨", code: "U+25A8" }
```

## Severity Tokens

Issue urgency. Rightward arrows: more arrows, more serious.

<!-- design:severity -->

```yaml
critical: { glyph: "⇶", code: "U+21F6", weight: 3 }
degraded: { glyph: "⇉", code: "U+21C9", weight: 2 }
annoying: { glyph: "⇢", code: "U+21E2", weight: 1 }
```

## Confidence Tokens

Decision certainty. Box-drawing line weight: heavier line, firmer commitment.

<!-- design:confidence -->

```yaml
firm:        { glyph: "━", code: "U+2501" }
provisional: { glyph: "─", code: "U+2500" }
exploratory: { glyph: "┄", code: "U+2504" }
```

## Trend Tokens

Direction of change.

<!-- design:trends -->

```yaml
improving: { glyph: "⮉", code: "U+2B89" }
degrading: { glyph: "⮋", code: "U+2B8B" }
```

## Structural Tokens

Layout primitives shared across all skills and artifacts.

<!-- design:structure -->

```yaml
section-divider: "─── label ───────"
list-item:       { glyph: "▸", code: "U+25B8" }
separator:       { glyph: "·", code: "U+00B7" }
flow:            { glyph: "→", code: "U+2192" }
progress-bar:    "█▓░"
```

## Composition Rules

<!-- design:constraints -->

```yaml
structural:
  - pattern: outer-frames
    rule: prohibited
    reason: "Open structure — no enclosure except the logo"
    exception: "Logo box-drawing characters only"
  - pattern: glyph-in-section-headers
    rule: prohibited
    reason: "Section headers are clean labels"
  - pattern: logo-on-every-invocation
    rule: prohibited
    reason: "Logo at key moments only — scarcity keeps it special"

compositional:
  - pattern: skill-introduction
    rule: required
    format: "─── glyph skillname · context ───"
  - pattern: breathing-room
    rule: required
    format: "Blank lines between sections"
  - pattern: narrative-position
    rule: convention
    format: "Narrative summaries close sections, not open them"
  - pattern: markdown-layering
    rule: required
    reason: "All artifacts stay valid Markdown — visual tokens layer within sections"

agent-output:
  - pattern: emoji-status-icons
    rule: prohibited
    reason: "Use severity and status tokens from this file, not emoji"
  - pattern: markdown-tables-in-agent-dashboard
    rule: prohibited
    scope: [hej-dashboard, capability-intros]
    reason: "Prefer dividers and metric lines over generic table slop"
  - pattern: bold-decoration-spam
    rule: prohibited
    reason: "Emphasis sparingly; structure carries meaning in the product register"
  - pattern: unicode-box-frames
    rule: prohibited
    exception: logo
    reason: "No outer frames except the logo box-drawing characters"
  - pattern: invented-glyphs
    rule: prohibited
    reason: "Use declared skill, status, and severity tokens only"

slop-test:
  description: "Generic agent formatting fails the product register"
  fail-signals:
    - "Swap the project name and nothing distinctive remains"
    - "Emoji, sparkles, or checkmark bullets replace declared tokens"
    - "Section headers ignore product-register dividers or glyph discipline"
    - "Logo or heavy framing on routine status updates"
  pass: "A reader identifies Agentera terminal output without seeing the project name"

```
