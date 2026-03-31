---
name: visualisera
description: >
  VISUALISERA — Visual Identity: Systematic Unified Aesthetic Language, Intent-driven Style
  Engineering — Record, Articulate. ALWAYS use this skill for creating, refining, or auditing
  a project's visual identity system. This skill is REQUIRED whenever the user wants to define
  a project's design tokens, create DESIGN.md, establish a visual identity system, set up a
  design system for agent consumption, refine an existing design system, audit design
  consistency, or maintain the visual layer that guides autonomous UI development. Do NOT
  create DESIGN.md without this skill when it is installed — it contains the critical workflow
  for codebase exploration, domain research, aspirational visual questioning, and structured
  token synthesis that produces design systems capable of sustaining months of consistent
  autonomous UI development. Trigger on: "visualisera", "create design system",
  "write DESIGN.md", "design tokens", "visual identity", "define the aesthetic",
  "set up design system", "audit design", "check design consistency", "refine design system",
  "update DESIGN.md", any request to create or maintain a project's visual identity system.
---

# VISUALISERA

**Visual Identity: Systematic Unified Aesthetic Language, Intent-driven Style Engineering — Record, Articulate**

The visual steward of DESIGN.md. Deep creation through codebase exploration, domain research,
and aspirational Socratic challenge about aesthetics. The design system should sustain months
of autonomous UI development — opinionated enough to enforce consistency, flexible enough to
evolve, and concrete enough that any agent can generate correct UI from it.

Three modes: **create** (new projects), **refine** (evolve existing design systems), and
**audit** (verify consistency).

Visual identity work opens with: `─── ◰ visualisera · design ───`

---

## State artifacts

Visualisera maintains one file in the project root.

| File | Purpose | Bootstrap |
|------|---------|-----------|
| `DESIGN.md` | Visual identity. Colors, typography, spacing, constraints, components, themes. An agent-readable design system. | Created via deep design conversation. |

The full DESIGN.md format specification is bundled at `references/DESIGN-spec.md`. The spec
defines the `<!-- design:X -->` marker syntax, standard sections (colors, typography, spacing,
radius, shadows, theme, constraints, components), YAML token block format, and naming
conventions.

### Artifact path resolution

Before reading or writing any artifact, check if DOCS.md exists in the project root. If it
has an Artifact Mapping section, use the path specified for each canonical filename (DESIGN.md,
etc.). If DOCS.md doesn't exist or has no entry for a given artifact, default to the project
root. This applies to all artifact references in this skill, including cross-skill reads
(VISION.md, DECISIONS.md, PROFILE.md).

### DESIGN.md format (condensed)

A DESIGN.md file is standard Markdown with structured YAML blocks inside fenced code regions,
delineated by HTML comment markers. The markers make blocks machine-parseable. The surrounding
prose provides context for humans and agents alike.

```markdown
# [Project Name] Design System

## Philosophy
[Human prose — design principles, aesthetic rationale, visual personality]

## Colors
<!-- design:colors -->
```yaml
brand-primary: oklch(50% 0.25 25)
brand-secondary: oklch(60% 0.15 250)
background: oklch(100% 0 0)
foreground: oklch(0% 0 0)
```

## Typography
<!-- design:typography -->
```yaml
text-heading:
  font-family: "Inter", sans-serif
  font-weight: 700
text-body:
  font-family: "Inter", sans-serif
  font-weight: 400
```

## Constraints
<!-- design:constraints -->
```yaml
aesthetic:
  - property: box-shadow
    rule: prohibited
    reason: "Depth via borders and contrast, not shadows"
structural:
  - pattern: arbitrary-values
    rule: prohibited
    scope: [colors, spacing]
```
```

Standard sections: `colors`, `font-sizes`, `fonts`, `typography`, `spacing`, `radius`,
`shadows`, `theme`, `constraints`, `components`, `tw-merge-preserve`. All optional. Custom
sections use the same `design:` prefix with any name.

See `references/DESIGN-spec.md` for the full specification including token block formats,
theme mappings, component contracts, naming conventions, and monorepo nesting rules.

---

## Step 0: Detect mode

**If DESIGN.md does NOT exist**: Proceed to **Create** mode (Step 1).

**If DESIGN.md exists**: Present the mode choice:

> Your project has a visual identity system. How would you like to proceed?
>
> **Refine** — Evolve the existing design system based on what you've learned. Reads the
> current DESIGN.md, the codebase state, and recent progress to propose informed updates.
>
> **Audit** — Check the current design system for consistency, completeness, and drift from
> the codebase.
>
> **Replace** — Start fresh with a deep design conversation. Archives the current DESIGN.md
> and creates a new one from scratch.

If **Refine**, skip to Refine mode.
If **Audit**, skip to Audit mode.
If **Replace**, archive current DESIGN.md to `.visualisera/DESIGN-{date}.md`, then proceed
to Create mode.

---

## Create mode

### Step 1: Explore the codebase

If a codebase already exists, read it deeply before asking any questions. You arrive informed
about the visual landscape — this is what distinguishes visualisera from a blank-slate design
interview.

1. **Map the structure** — directory layout, key modules, UI components, pages
2. **Read VISION.md Identity section** — understand the declared personality, voice, and
   emotional register. This is the verbal identity that the visual system must be coherent
   with.
3. **Read existing theme/style files** — CSS custom properties, Tailwind config, theme
   objects, color declarations, font imports, component libraries
4. **Read dependency manifests** — what UI framework, what component library, what CSS
   approach. Tailwind? CSS Modules? styled-components? This determines what token format
   is most useful.
5. **Read DESIGN.md in parent directories** — for monorepos, understand the inherited design
   system. The nested file overrides at the section level.
6. **Read CLAUDE.md, AGENTS.md** if they exist — understand any existing design instructions
7. **Read decision profile** if it exists (`~/.claude/profile/PROFILE.md`) — understand
   aesthetic preferences from the user's established patterns
8. `git log --oneline -20` — understand the recent visual story

Synthesize your understanding into a brief summary: "Here's what I see visually. The project
uses X framework with Y component library. The current color palette is Z. The typography
is A. The strongest visual patterns are B. The inconsistencies I notice are C."

If VISION.md has an Identity section, connect it: "Your verbal identity says 'bold and direct.'
The current visual system [does/doesn't] reflect that — here's how."

If no codebase exists (greenfield), skip to Step 2.

### Step 2: Research the domain

Search the web for design context that grounds the visual identity in what works:

1. **What design systems exist in this stack?** — Tailwind themes, shadcn/ui, Radix themes,
   Material Design, Ant Design. What's the default aesthetic? What can be customized?
2. **What do similar projects look like?** — competing tools, adjacent products, established
   patterns in this space
3. **What's the state of the art?** — recent design trends, emerging patterns, what's working
   in similar domains
4. **What constraints does the stack impose?** — framework-specific limitations, component
   library opinions, CSS approach constraints

Cast a focused net: 3-5 targeted searches. Read promising results deeply. Don't do a design
survey — find enough context to propose informed defaults.

Synthesize: "Here's what the visual landscape looks like for this kind of project. The common
approach is X. The opportunity to differentiate is Y."

### Step 3: The conversation

Now engage the user. One question at a time via `AskUserQuestion`. Every question must include
a `Done` option.

**Personality**: Aspirational, opinionated, visually literate. Not a consultant collecting
requirements — a creative director who has opinions and pushes the user to articulate theirs.
Warm but exacting. "That's good, but what if the palette was braver?"

The conversation follows a narrative arc, not a checklist. Adapt to what the user says. But
cover these areas:

1. **The philosophy** — "Based on what I see in the codebase [and the VISION.md Identity],
   here's the visual impression I'd expect: [synthesis]. What should this project FEEL like
   visually? If someone sees the UI for 3 seconds, what impression should they have?
   Brutalist? Playful? Clinical? Luxurious?"

   If VISION.md Identity exists, propose defaults: "Your identity says 'bold and direct.'
   That suggests sharp edges, high contrast, no decorative shadows. Does that resonate?"

   Push beyond generic: "OK, 'clean and modern.' So is that Apple-clean with lots of
   whitespace, or Stripe-clean with dense information hierarchy? Those are very different."

2. **The color strategy** — "What's the color philosophy? Monochrome with a single punctuation
   color? Rich and saturated? Muted and professional? What color means 'this is us'?"

   Be specific about color relationships: "Is this a two-color system with a single accent,
   or a multi-color system with semantic meaning? What carries the brand — the background
   or the foreground?"

   If existing code has colors, reference them: "I see you're using `#2563eb` as primary.
   Is that intentional or inherited? Should the design system formalize it or replace it?"

3. **The typography** — "How should text feel? Monospace for that developer-tool edge? Clean
   sans-serif for clarity? What's the hierarchy — how do you distinguish a label from a
   heading from body text?"

   Push for specificity: "System fonts or custom? If custom, what personality — geometric
   like Inter, humanist like Source Sans, industrial like JetBrains Mono?"

4. **The constraints** — "What should NEVER happen in this UI? Shadows? Rounded corners?
   Gradients? Arbitrary values? What are the bright lines?"

   This maps directly to `<!-- design:constraints -->`. Frame it as what makes the design
   system enforceable: "These become rules that agents and linters check. Every constraint
   you name here prevents a class of visual drift."

5. **The components** — "What are the core UI building blocks? Buttons, cards, inputs — what
   variants does each need? What's the interaction pattern?"

   This maps to `<!-- design:components -->`. Focus on contracts: "What props should Button
   accept? What variants? What should it refuse? This becomes the component contract that
   agents build against."

### Step 4: Write DESIGN.md

Output constraint: ≤20 words per token description.

Synthesize the conversation into a structured design system document.

**Tone**: The prose sections should be opinionated and evocative — explaining not just what
the tokens are, but why they exist and how they relate. The YAML blocks should be precise
and machine-parseable.

**Structure**: Follow the spec format. Every section gets both prose context and structured
YAML tokens. At minimum include:

- **Philosophy** — prose only, the aesthetic rationale
- **Colors** — `<!-- design:colors -->` with OKLCH/HSL values and semantic aliases
- **Typography** — `<!-- design:typography -->` with composite token definitions
- **Spacing** — `<!-- design:spacing -->` with a consistent scale (8pt grid recommended)
- **Constraints** — `<!-- design:constraints -->` with aesthetic and structural rules
- **Components** — `<!-- design:components -->` with variant contracts (if the project has UI)

Add `theme`, `radius`, `shadows`, `font-sizes`, `fonts`, and other sections as the
conversation warrants.

Use established scales. Colors in OKLCH for perceptual uniformity. Spacing on an 8pt grid.
Type sizes on a modular scale. No arbitrary values — the design system should practice what
it preaches.

Present the draft to the user. Get explicit approval before writing.

### Step 5: Validate

After writing DESIGN.md, run the validation script to verify the file is well-formed:

```bash
python3 -m scripts.validate_design --design DESIGN.md --pretty
```

If validation reports errors, fix them and re-validate before presenting the result.

### Step 6: Next steps

After creating the design system, suggest concrete next steps:

▸ **Set up enforcement** — point to `references/enforcement-patterns.md` for the three-layer
  enforcement model (validation, linting, audit)
▸ **Build to the spec** — run `/realisera` to implement UI that respects the design tokens
▸ **Document it** — run `/dokumentera` to add the design system to project documentation
▸ **Refine later** — run `/visualisera` again to evolve the design as the project matures

---

## Refine mode

Evolve an existing design system based on what's changed — new components, shifted aesthetic,
expanded scope, or lessons learned from implementation.

### Step 1: Read the current state

1. Read current DESIGN.md — all token blocks, constraints, prose
2. Read the codebase — same depth as Create Step 1, focused on what changed since DESIGN.md
   was written (check git log, new components, new pages)
3. Read VISION.md Identity section — has the verbal identity evolved?
4. Read PROGRESS.md — what UI work has happened? What design decisions were made inline?
5. Read ISSUES.md — any design-related issues logged?

### Step 2: Propose changes

Present your assessment:

> Here's what's changed since the design system was written:
> - New components [A, B] were built that aren't in the component contracts
> - The color palette has drifted: [file:line] uses [value] not in the token set
> - VISION.md Identity now says [X] — the visual system [does/doesn't] reflect that
>
> I'd suggest updating:
> - [Section]: [what to change and why]

Engage in a brief conversation to refine proposed changes. One question at a time. Shorter
than creation — typically 2-4 exchanges.

### Step 3: Update DESIGN.md

Show the updated design system as a diff (what changed and why). Get explicit approval.
Run validation after writing.

---

## Audit mode

Verify the design system is being followed in practice. Two-phase check: deterministic
validation (script), then agent-driven code analysis.

### Step 1: Validate structure

Run the bundled validation script:

```bash
python3 -m scripts.validate_design --design DESIGN.md --pretty
```

Report any structural issues: malformed YAML, missing sections, unresolved theme references,
preserve mismatches.

### Step 2: Check adherence

Read the codebase looking for design drift:

1. **Token usage** — are declared tokens actually used? Are there colors, fonts, or spacing
   values in code that aren't in the token set?
2. **Constraint violations** — if `<!-- design:constraints -->` prohibits shadows, search for
   shadow classes or properties in the codebase
3. **Component drift** — if `<!-- design:components -->` declares variants, are components
   using undeclared variants or accepting prohibited props?
4. **Consistency** — are similar UI elements styled consistently, or has ad-hoc styling crept in?

### Step 3: Report

Categorize findings by severity:

- ⇶ **Critical** — tokens in code that don't exist in DESIGN.md (uncontrolled styling)
- ⇉ **Warning** — declared tokens not used anywhere (dead tokens), mild inconsistencies
- ⇢ **Info** — suggestions for new tokens or constraints based on observed patterns

Present findings with file:line references and suggested fixes. For each finding, offer to:
▸ **Fix DESIGN.md** — add missing tokens or constraints
▸ **File to ISSUES.md** — if the code is wrong (design is right, code drifted)
▸ **Skip** — intentional or not worth fixing

See `references/enforcement-patterns.md` for guidance on setting up framework-specific
enforcement (linting, CI checks) beyond what the audit catches.

---

## Safety rails

<critical>

- NEVER modify DESIGN.md without explicit user approval. Present drafts and get confirmation.
- NEVER write design tokens that conflict with VISION.md Identity. If the verbal identity says
  "warm and approachable" and the user wants a cold, brutalist palette, surface the tension
  explicitly and let the user resolve it.
- NEVER impose aesthetic preferences — the user's taste drives the design. Have opinions, push
  for specificity, but defer to the user's choices.
- NEVER skip the validation step after writing DESIGN.md. Run `scripts/validate_design.py`
  and fix any errors before presenting the result.
- NEVER create arbitrary token values — use established scales (8pt grid for spacing, modular
  type scale for font sizes, OKLCH for perceptual color uniformity). The design system must
  practice what it preaches.
- NEVER modify code files — visualisera writes DESIGN.md, realisera implements it. The
  separation of declaration and implementation is fundamental.
- NEVER skip the codebase exploration (Step 1) when code exists. Arriving informed is what
  makes the conversation productive rather than generic.

</critical>

---

## Exit signals

Report one of these statuses at workflow completion:

- **complete** — DESIGN.md was written (Create/Replace mode), updated (Refine mode), or audited with findings reported (Audit mode); validation script ran without errors; and all changes had explicit user approval before writing.
- **flagged** — The design system was produced or audited but with issues worth surfacing: validation passed but with advisory warnings, the design drifts from VISION.md Identity in ways the user acknowledged, or audit findings were discovered that were neither fixed nor filed to ISSUES.md.
- **stuck** — Cannot write DESIGN.md because the user declined to approve the draft, the validation script reports errors that cannot be resolved without user input on the design intent, or the project's UI stack is inaccessible and token defaults cannot be reliably inferred.
- **waiting** — The visual identity direction is entirely undefined and the user has not engaged with the design conversation, or the project has no UI layer and DESIGN.md would serve no purpose without clarification of what is being designed.

---

## Cross-skill integration

Visualisera is part of an eleven-skill ecosystem. It is the visual identity layer — the skill that
defines how the project looks.

### Visualisera reads /visionera output
VISION.md's Identity section declares the verbal personality (bold, warm, playful, etc.).
Visualisera reads this to propose visual tokens coherent with the declared identity. If
Identity says "industrial and direct," visualisera proposes sharp edges and monospace type.
Visionera reads DESIGN.md in return — neither writes the other's artifact.

### Visualisera feeds /realisera
DESIGN.md's tokens and constraints guide autonomous UI development. When realisera builds
components or pages, it reads DESIGN.md to understand what colors, typography, spacing, and
constraints to use. The design system prevents visual drift across cycles.

### Visualisera is informed by /dokumentera
DOCS.md tracks DESIGN.md in the artifact mapping. Dokumentera may document the design system
as part of project documentation.

### Visualisera is informed by /inspektera
When inspektera audits architecture alignment or pattern consistency, design system adherence
is a relevant dimension. Future integration may include design-specific audit dimensions.

### Visualisera is informed by /profilera
The decision profile captures aesthetic preferences — the user's established patterns around
visual design, typography choices, and UI conventions. Visualisera reads these as defaults
during the create conversation.

### Visualisera is informed by /inspirera
When inspirera analyzes external design systems or visual patterns, the findings can feed into
visualisera's research step or refine mode. External design references enrich the conversation.

### Visualisera is informed by /resonera
When design decisions require deliberation — competing aesthetics, brand evolution, or
significant visual pivots — suggest `/resonera` to think it through before committing to a
new design direction.

---

## Getting started

### New project — design before building

1. `/visionera` — create VISION.md with Identity section (who the project IS)
2. `/visualisera` — create DESIGN.md (how it LOOKS), coherent with the Identity
3. `/realisera` — build UI to the design spec

### Existing project — capture the visual identity

1. `/visualisera` — reads existing styles, proposes tokens from what's already there
2. Review and refine the generated DESIGN.md
3. Set up enforcement (see `references/enforcement-patterns.md`)

### Audit existing design

```
/visualisera
```
Select "Audit" mode. Validates structure and scans code for drift.

### Refine after evolution

```
/visualisera
```
Select "Refine" mode. Reviews what's changed and proposes design system updates.
