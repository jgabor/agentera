# agentera

Visual identity system for the agentera skill ecosystem. Terminal-native, layered on standard Markdown, designed for both human reading and agent consumption.

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
hej:         { glyph: "🞔", code: "U+1F794", meaning: "angular hub" }
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
```
