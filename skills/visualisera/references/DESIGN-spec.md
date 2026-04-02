# DESIGN.md

A simple, open format for defining visual identity in a way LLM agents can read, enforce, and generate from.

Think of DESIGN.md as a **design system for agents**: a dedicated, predictable place to declare how your project looks (colors, typography, spacing, constraints, components, and themes) in a single markdown file that is both human-reviewable and machine-parseable.

## Why DESIGN.md?

Design systems today are built for humans using GUIs. Figma tokens, Style Dictionary configs, theme objects: none of these are legible to an LLM agent that reads text, writes code, and runs commands.

Meanwhile, agents are increasingly the primary authors of UI code. Without a readable spec, they drift: wrong colors, arbitrary spacing, shadows where there shouldn't be shadows, rounded corners on a brutalist site.

DESIGN.md solves this by putting the design system where agents already look: in the repo, as markdown.

We intentionally kept it separate from AGENTS.md to:

- Give the visual system its own predictable location.
- Keep AGENTS.md focused on behavioral instructions (how to work) rather than visual specifications (how things look).
- Allow the design system to be versioned, diffed, and reviewed independently.

## How it works

A DESIGN.md file is standard Markdown with structured YAML blocks inside fenced code regions, delineated by HTML comment markers. The markers make blocks machine-parseable. The surrounding prose provides context for humans and agents alike.

````markdown
# My Project

## Philosophy

[Human prose — design principles, aesthetic rationale, voice]

## Colors

<!-- design:colors -->

```yaml
dd-black: oklch(0% 0 0)
dd-white: oklch(100% 0 0)
dd-primary: oklch(50% 0.25 25)
```

## Typography
<!-- design:typography -->
```yaml
text-label:
  font-family: var(--font-mono)
  font-size: 0.75rem
  font-weight: 700
  text-transform: uppercase
```
````

The file is simultaneously:

- **Documentation** that renders cleanly on GitHub, in a PR, or in any editor.
- **Configuration** that tools can parse and generate code from.
- **Constraints** that agents and linters can enforce.

## Specification

### File location

Place a `DESIGN.md` file at the root of your repository, or nested in subdirectories for monorepos. Agents read the nearest `DESIGN.md` in the directory tree; the closest one takes precedence.

```text
my-project/
├── DESIGN.md              # Root design system
├── AGENTS.md          # Behavioral instructions
├── packages/
│   └── marketing/
│       └── DESIGN.md      # Override for marketing site
```

### File structure

A DESIGN.md file consists of:

1. **Prose sections**: Markdown headings and paragraphs providing context, rationale, and usage guidance. No special format required. Write whatever helps agents understand the design intent.

2. **Token blocks**: Fenced YAML code blocks preceded by an HTML comment marker. These are the machine-parseable sections that tools read and generate from.

### Marker format

Markers use HTML comments with a `design:` prefix:

```text
<!-- design:{section} -->
```

The marker must appear on the line immediately before a fenced YAML code block. The marker and the block together form a **token declaration**.

### Standard sections

The following section names are defined by the spec. All are optional; a minimal DESIGN.md might only define `colors` and `typography`.

| Marker                              | Purpose                                 | Content                                                |
| ----------------------------------- | --------------------------------------- | ------------------------------------------------------ |
| `<!-- design:colors -->`            | Color primitives and semantic aliases   | OKLCH/HSL/hex values, `var()` references               |
| `<!-- design:font-sizes -->`        | Font size scale                         | rem/px values                                          |
| `<!-- design:fonts -->`             | Font family declarations                | Family strings                                         |
| `<!-- design:typography -->`        | Composite typography utilities          | Objects with font-family, font-size, font-weight, etc. |
| `<!-- design:spacing -->`           | Spacing scale                           | rem/px values                                          |
| `<!-- design:radius -->`            | Border radius primitives                | rem/px values                                          |
| `<!-- design:shadows -->`           | Shadow primitives                       | CSS shadow values or `none`                            |
| `<!-- design:theme -->`             | Theme mappings (light/dark/custom)      | Token references per mode                              |
| `<!-- design:constraints -->`       | Prohibited patterns and aesthetic rules | Structured constraint objects                          |
| `<!-- design:components -->`        | Component contracts                     | Variant definitions, required props, semantic roles    |
| `<!-- design:tw-merge-preserve -->` | Tailwind-merge class preservation list  | Array of class names                                   |

### Custom sections

You may define additional sections using the `design:` prefix with any name:

```text
<!-- design:animations -->
<!-- design:breakpoints -->
<!-- design:z-index -->
```

Tools should ignore sections they don't recognize and pass them through unchanged.

### Token block format

Token blocks are YAML inside fenced code blocks (` ```yaml `). The YAML structure depends on the section type.

### Simple key-value tokens

Used for colors, font sizes, spacing, radius, shadows:

```yaml
dd-black: oklch(0% 0 0)
dd-white: oklch(100% 0 0)
dd-primary: var(--dd-red)
```

#### Composite tokens

Used for typography and other multi-property declarations:

```yaml
text-label:
  font-family: var(--font-mono)
  font-size: 0.75rem
  font-weight: 700
  text-transform: uppercase
  letter-spacing: 0.05em
```

#### Theme mappings

Used for `<!-- design:theme -->`. Top-level keys are mode names. Values reference token names:

```yaml
light:
  background: dd-white
  foreground: dd-black
  primary: dd-primary

dark:
  background: dd-black
  foreground: dd-white
  primary: dd-primary
```

#### Constraints

Used for `<!-- design:constraints -->`. Declares what is prohibited and why:

```yaml
aesthetic:
  - property: box-shadow
    rule: prohibited
    reason: "Depth via borders and contrast, not shadows"
    alternatives: ["border-border"]
  - property: border-radius
    rule: prohibited
    reason: "Sharp edges, industrial aesthetic"
    override: "rounded-none"

structural:
  - pattern: arbitrary-values
    rule: prohibited
    reason: "Use design tokens, not magic numbers"
    scope: [colors, spacing, z-index]
  - pattern: inline-styles
    rule: prohibited
    reason: "All styling through utility classes or variants"
    exceptions: ["Progress", "Chart"]
```

#### Component contracts

Used for `<!-- design:components -->`. Declares what components exist and what they accept:

```yaml
Button:
  variants:
    variant: [default, outline, ghost, success, destructive, link, accent]
    size: [default, sm, lg, icon]
  required-slot: children
  prohibited-props: [class, style]
  semantic-role: "All clickable actions"

Badge:
  variants:
    variant: [default, secondary, muted, destructive, success, warning, info]
  required-slot: children
  semantic-role: "Status indicators"
```

### Comments in YAML

YAML supports inline comments with `#`. Use them to annotate tokens with rationale:

```yaml
dd-red: oklch(50% 0.25 25) # Primary brand, WCAG AA on white
dd-amber: oklch(50% 0.18 85) # Warning/caution states
dd-primary: var(--dd-red) # Alias: change this to rebrand
```

### Prose sections

Everything outside of marker + YAML block pairs is prose. There are no format requirements for prose. Write whatever helps agents and humans understand the design system.

Recommended prose sections:

- **Philosophy / Principles**: Why does the system look the way it does? What aesthetic rules guide decisions? This context helps agents make judgment calls when the tokens don't cover a specific situation.
- **Usage guidance**: How to use specific tokens. When to use `text-label` vs `text-body-sm`. What the semantic color mapping means.
- **Anti-patterns**: What agents (and humans) commonly get wrong. Specific examples of violations and their corrections.
- **Component guidelines**: Usage patterns, examples, and do's/don'ts that go beyond what the `<!-- design:components -->` block can express.
- **Migration notes**: If tokens have been renamed or deprecated, document the mapping.

### Naming conventions

Token names should follow a consistent convention. The spec does not mandate a specific convention, but recommends:

- Use lowercase with hyphens: `dd-primary`, not `ddPrimary` or `DD_PRIMARY`.
- Use a project prefix to avoid collisions: `dd-`, `acme-`, etc.
- Use semantic names, not visual descriptions: `dd-primary`, not `dd-red-500`.
- Keep names short enough to use in utility classes.

### Encoding

DESIGN.md files must be UTF-8 encoded.

## Relationship to other standards

| Standard                     | Scope                              | How DESIGN.md relates                                                                                                                       |
| ---------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **AGENTS.md**                | Behavioral instructions for agents | DESIGN.md is referenced from AGENTS.md but lives separately. AGENTS.md might say "see DESIGN.md for design tokens."                         |
| **SKILL.md**                 | Task-specific capabilities         | A skill could teach agents how to _work with_ DESIGN.md files (parse, validate, generate). The DESIGN.md file itself is not a skill.        |
| **DTCG** (W3C Design Tokens) | Cross-platform token format        | DESIGN.md can be a source that _generates_ DTCG-format tokens. The `design:colors` block is simpler than DTCG JSON but can transform to it. |
| **Style Dictionary**         | Token build tool                   | DESIGN.md can serve as input to Style Dictionary via a parser plugin, or as a replacement for Style Dictionary's JSON config files.         |

## Tooling

DESIGN.md is a format, not a tool. Any tool can parse it. The marker + YAML pattern is trivially extractable with a regex:

````javascript
const regex = /<!-- design:(\w[\w-]*) -->\s*```ya?ml\n([\s\S]*?)```/gm;
````

### Recommended toolchain

A reference CLI (name TBD) can:

- **Parse**: Extract token blocks from DESIGN.md into structured data.
- **Validate**: Check that tokens are well-formed and internally consistent (no dangling references, valid color values, etc.).
- **Generate**: Emit CSS custom properties, Tailwind config, TypeScript types, and theme files from the token blocks.
- **Lint**: Check a codebase against the constraints declared in `<!-- design:constraints -->`.
- **Audit**: Run the full loop: validate source, check generated files, lint code, report results.
- **Schema**: Dump the spec format as JSON for agent introspection.

The CLI follows agent-first design principles:

- All commands accept `--json` for structured input.
- All output is JSON by default (pretty output via `--output pretty`).
- `--dry-run` on all mutating commands.
- Self-describing via `schema` command.
- MCP surface via `mcp --stdio` for typed tool invocation.

## Examples

### Minimal DESIGN.md

````markdown
# Design System

## Colors

<!-- design:colors -->

```yaml
primary: #2563eb
secondary: #64748b
background: #ffffff
foreground: #0f172a
```

## Typography
<!-- design:typography -->
```yaml
heading:
  font-family: "Inter", sans-serif
  font-weight: 700
body:
  font-family: "Inter", sans-serif
  font-weight: 400
```
````

### Comprehensive DESIGN.md (brutalist example)

See the [Deprecated Developers brand.md][dd-brand] for a production example of this pattern. It uses `design-tokens:` markers (the predecessor to `design:` markers) with the same structure.

[dd-brand]: https://github.com/jgabor/deprecated-developers/blob/main/docs/handbook/brand.md

### Monorepo with overrides

```text
acme-corp/
├── DESIGN.md                    # Shared brand
├── apps/
│   ├── marketing/
│   │   └── DESIGN.md            # Extends: playful radius
│   ├── dashboard/
│   │   └── DESIGN.md            # Extends: data-viz colors
│   └── docs/
│       └── DESIGN.md            # Extends: prose typography
```

## FAQ

### Are there required sections?

No. DESIGN.md is markdown with optional structured blocks. Use whichever sections your project needs. A file with only prose and no YAML blocks is still a valid DESIGN.md, but it won't be machine-parseable for token generation.

### How does DESIGN.md relate to Figma?

DESIGN.md replaces the _handoff_ step, not the _exploration_ step. Use Figma for visual exploration and iteration. When design decisions are made, encode them in DESIGN.md. A tool can sync tokens between Figma Variables and DESIGN.md in either direction.

### Can I use DESIGN.md with Tailwind?

Yes. A generator reads `<!-- design:colors -->` and `<!-- design:typography -->` blocks and emits Tailwind-compatible CSS custom properties and theme configuration. The `<!-- design:tw-merge-preserve -->` block specifically addresses the tailwind-merge class stripping problem.

### What if my framework uses JSON/JS for config?

DESIGN.md is the source of truth. A generation step emits whatever format your framework needs: CSS custom properties, JSON tokens, JavaScript theme objects, Tailwind config, Style Dictionary format. The markdown file is the interface; the output is framework-specific.

### How do nested DESIGN.md files work?

The nearest DESIGN.md to the file being edited takes precedence. A tool or agent should walk up the directory tree and merge DESIGN.md files, with more specific (deeper) files overriding less specific (shallower) ones. The merge strategy is section-level: a nested DESIGN.md that defines `<!-- design:colors -->` replaces the parent's color block entirely. Sections not redefined in the nested file inherit from the parent.

### Can I have multiple token blocks of the same type?

No. Each `<!-- design:X -->` marker should appear at most once per DESIGN.md file. If you need to organize tokens into groups, use YAML comments within a single block.

### What about dark mode?

Use the `<!-- design:theme -->` block. Define light and dark (and any custom) modes as top-level keys. Values reference token names from `<!-- design:colors -->`. The generator emits mode-specific CSS using your framework's conventions (CSS custom properties with selectors, Tailwind dark: prefix, etc.).

## Contributing

DESIGN.md is an open format. Contributions, feedback, and adoption are welcome.

If you build a tool that reads or writes DESIGN.md files, please let us know so we can list it here.
