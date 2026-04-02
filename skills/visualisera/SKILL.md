---
name: visualisera
description: >
  VISUALISERA (Visual Identity: Systematic Unified Aesthetic Language, Intent-driven Style Engineering; Record, Articulate). ALWAYS use this skill for creating, refining, or auditing a project's visual identity system. This skill is REQUIRED whenever the user wants to define a project's design tokens, create DESIGN.md, establish a visual identity system, set up a design system for agent consumption, refine an existing design system, audit design consistency, or maintain the visual layer that guides autonomous UI development. Do NOT create DESIGN.md without this skill when it is installed because it contains the critical workflow for codebase exploration, domain research, aspirational visual questioning, and structured token synthesis that produces design systems capable of sustaining months of consistent autonomous UI development. Trigger on: "visualisera", "create design system", "write DESIGN.md", "design tokens", "visual identity", "define the aesthetic", "set up design system", "audit design", "check design consistency", "refine design system", "update DESIGN.md", any request to create or maintain a project's visual identity system.
---

# VISUALISERA

**Visual Identity: Systematic Unified Aesthetic Language, Intent-driven Style Engineering. Record, Articulate.**

The visual steward of DESIGN.md. Deep creation through codebase exploration, domain research, and Socratic challenge about aesthetics. Opinionated enough to enforce consistency, flexible enough to evolve, concrete enough for any agent to generate correct UI.

Three modes: **create**, **refine**, **audit**.

Skill introduction: `─── ◰ visualisera · design ───`

---

## State artifacts

One file in `.agentera/`.

| File | Purpose | Bootstrap |
|------|---------|-----------|
| `DESIGN.md` | Visual identity. Colors, typography, spacing, constraints, components, themes. An agent-readable design system. | Created via deep design conversation. |

Full spec at `references/DESIGN-spec.md`: `<!-- design:X -->` marker syntax, standard sections, YAML token block format, and naming conventions.

### Artifact path resolution

Before reading or writing any artifact, check if .agentera/DOCS.md exists. If it has an Artifact Mapping section, use the path specified for each canonical filename (.agentera/DESIGN.md, etc.). If .agentera/DOCS.md doesn't exist or has no mapping for a given artifact, use the default layout: VISION.md, TODO.md, and CHANGELOG.md at the project root; all other artifacts in .agentera/. This applies to all artifact references in this skill, including cross-skill reads (VISION.md, .agentera/DECISIONS.md, PROFILE.md).

### DESIGN.md format (condensed)

Standard Markdown with structured YAML blocks inside fenced code regions, delineated by HTML comment markers for machine parseability.

```markdown
# [Project Name] Design System

## Philosophy
[Human prose: design principles, aesthetic rationale, visual personality]

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

Standard sections: `colors`, `font-sizes`, `fonts`, `typography`, `spacing`, `radius`, `shadows`, `theme`, `constraints`, `components`, `tw-merge-preserve`. All optional. Custom sections use the same `design:` prefix with any name.

See `references/DESIGN-spec.md` for the full specification including token block formats, theme mappings, component contracts, naming conventions, and monorepo nesting rules.

---

## Step 0: Detect mode

**If DESIGN.md does NOT exist**: Proceed to **Create** mode (Step 1).

**If DESIGN.md exists**: Present the mode choice.

Narration voice (riff, don't script):
✗ "Your project has a visual identity system. How would you like to proceed?"
✓ "Design system's already in place. Evolve it, audit it, or start fresh?" · "Found your visual identity. Refine, check for drift, or clean slate?"

Offer:

> **Refine**: Evolve the existing design system based on what you've learned. Reads the current DESIGN.md, the codebase state, and recent progress to propose informed updates.
>
> **Audit**: Check the current design system for consistency, completeness, and drift from the codebase.
>
> **Replace**: Start fresh with a deep design conversation. Archives the current DESIGN.md and creates a new one from scratch.

If **Refine**, skip to Refine mode.
If **Audit**, skip to Audit mode.
If **Replace**, archive current DESIGN.md to `.agentera/archive/DESIGN-{date}.md`, then proceed
to Create mode.

---

## Create mode

Step markers: display `── step N/6: verb` before each step.
Steps: explore, research, converse, write, validate, next.

### Step 1: Explore the codebase

If code exists, read deeply before asking questions. Arriving informed distinguishes visualisera from a blank-slate design interview.

1. **Map the structure**: directory layout, UI components, pages
2. **VISION.md Identity section**: declared personality, voice, emotional register. The visual system must cohere with this.
3. **Existing theme/style files**: CSS properties, Tailwind config, color declarations, font imports, component libraries
4. **Dependency manifests**: UI framework, component library, CSS approach (determines token format)
5. **Parent DESIGN.md**: for monorepos, the inherited design system (nested overrides)
6. **CLAUDE.md, AGENTS.md**: existing design instructions
7. **Decision profile** (`~/.claude/profile/PROFILE.md`): aesthetic preferences
8. `git log --oneline -20`: recent visual story

Synthesize: "The project uses X with Y. Palette is Z. Typography is A. Strongest patterns: B. Inconsistencies: C." If VISION.md Identity exists, connect it to the visual system.

Greenfield? Skip to Step 2.

### Step 2: Research the domain

Search for design context that grounds the identity in what works:

1. **Stack design systems**: Tailwind themes, shadcn/ui, Radix, Material Design. Defaults and customization points.
2. **Similar projects**: competing tools, adjacent products, established patterns
3. **State of the art**: recent trends, emerging patterns in similar domains
4. **Stack constraints**: framework limitations, component library opinions

3-5 targeted searches. Read promising results deeply. Synthesize: "Common approach is X. Opportunity to differentiate is Y."

### Step 3: The conversation

Engage the user. One question at a time via `AskUserQuestion` (always include `Done` option).

**Personality**: the sharp colleague, here to design, not collect requirements. Exacting about details: "That's good, but what if the palette was braver?"

Follow a narrative arc, not a checklist. Adapt, but cover:

1. **The philosophy**: "Based on what I see in the codebase [and the VISION.md Identity], here's the visual impression I'd expect: [synthesis]. What should this project FEEL like visually? If someone sees the UI for 3 seconds, what impression should they have? Brutalist? Playful? Clinical? Luxurious?"

   If VISION.md Identity exists, propose defaults: "Your identity says 'bold and direct.' That suggests sharp edges, high contrast, no decorative shadows. Does that resonate?"

   Push beyond generic: "'Clean and modern' is too vague. Apple-clean with whitespace, or Stripe-clean with dense information hierarchy? Very different."

2. **The color strategy**: "What's the color philosophy? Monochrome with a single punctuation color? Rich and saturated? Muted and professional? What color means 'this is us'?"

   Be specific: "Two-color with single accent, or multi-color with semantic meaning? What carries the brand: background or foreground?"

   Reference existing code colors: "`#2563eb` as primary: intentional or inherited?"

3. **The typography**: "How should text feel? Monospace for that developer-tool edge? Clean sans-serif for clarity? What's the hierarchy: how do you distinguish a label from a heading from body text?"

   Push: "System fonts or custom? Geometric (Inter), humanist (Source Sans), industrial (JetBrains Mono)?"

4. **The constraints**: "What should NEVER happen in this UI? Shadows? Rounded corners? Gradients? Arbitrary values? What are the bright lines?"

   Maps to `<!-- design:constraints -->`. "Every constraint prevents a class of visual drift."

5. **The components**: "What are the core UI building blocks? Buttons, cards, inputs. What variants does each need? What's the interaction pattern?"

   Maps to `<!-- design:components -->`. Focus on contracts: "What props, variants, refusals? This becomes the contract agents build against."

### Step 4: Write DESIGN.md

Output constraint: ≤20 words per token description.

Synthesize the conversation into a structured design system document.

**Tone**: prose sections opinionated and evocative (why tokens exist, how they relate); YAML blocks precise and machine-parseable.

**Structure**: follow the spec. Every section gets prose + YAML. At minimum:

- **Philosophy**: prose only, the aesthetic rationale
- **Colors**: `<!-- design:colors -->` with OKLCH/HSL values and semantic aliases
- **Typography**: `<!-- design:typography -->` with composite token definitions
- **Spacing**: `<!-- design:spacing -->` with a consistent scale (8pt grid recommended)
- **Constraints**: `<!-- design:constraints -->` with aesthetic and structural rules
- **Components**: `<!-- design:components -->` with variant contracts (if the project has UI)

Add `theme`, `radius`, `shadows`, `font-sizes`, `fonts` as warranted.

Use established scales: OKLCH for colors, 8pt grid for spacing, modular scale for type. No arbitrary values. Present draft, get explicit approval before writing.

### Step 5: Validate

Validate the written file:

```bash
python3 scripts/validate_design.py --design DESIGN.md --pretty
```

Fix errors and re-validate before presenting.

### Step 6: Next steps

▸ **Set up enforcement**: point to `references/enforcement-patterns.md` for the three-layer enforcement model (validation, linting, audit)
▸ **Build to the spec**: run `/realisera` to implement UI that respects the design tokens
▸ **Document it**: run `/dokumentera` to add the design system to project documentation
▸ **Refine later**: run `/visualisera` again to evolve the design as the project matures

---

## Refine mode

Evolve an existing design system based on what's changed.

Step markers: display `── step N/3: verb` before each step.
Steps: read, propose, update.

### Step 1: Read current state

1. Current DESIGN.md: all token blocks, constraints, prose
2. Codebase: focused on changes since DESIGN.md was written (git log, new components)
3. VISION.md Identity: has verbal identity evolved?
4. PROGRESS.md: UI work and inline design decisions
5. TODO.md: design-related issues

### Step 2: Propose changes

> Here's what's changed since the design system was written:
> - New components [A, B] were built that aren't in the component contracts
> - The color palette has drifted: [file:line] uses [value] not in the token set
> - VISION.md Identity now says [X], and the visual system [does/doesn't] reflect that
>
> I'd suggest updating:
> - [Section]: [what to change and why]

Brief conversation (2-4 exchanges) to refine proposed changes.

### Step 3: Update DESIGN.md

Show diff with rationale. Get approval. Run validation after writing.

---

## Audit mode

Two-phase check: deterministic validation (script), then agent-driven code analysis.

Step markers: display `── step N/3: verb` before each step.
Steps: validate, check, report.

### Step 1: Validate structure

```bash
python3 scripts/validate_design.py --design DESIGN.md --pretty
```

Report structural issues: malformed YAML, missing sections, unresolved references.

### Step 2: Check adherence

Scan codebase for design drift:

1. **Token usage**: undeclared colors, fonts, or spacing values in code
2. **Constraint violations**: prohibited properties in use (e.g., shadows when banned)
3. **Component drift**: undeclared variants or prohibited props
4. **Consistency**: ad-hoc styling on similar elements

### Step 3: Report

Categorize findings by severity:

- ⇶ **Critical**: tokens in code that don't exist in DESIGN.md (uncontrolled styling)
- ⇉ **Warning**: declared tokens not used anywhere (dead tokens), mild inconsistencies
- ⇢ **Info**: suggestions for new tokens or constraints based on observed patterns

Present with file:line references. For each finding, offer to:
▸ **Fix DESIGN.md**: add missing tokens or constraints
▸ **File to TODO.md**: if the code is wrong (design is right, code drifted)
▸ **Skip**: intentional or not worth fixing

See `references/enforcement-patterns.md` for framework-specific enforcement beyond audits.

---

## Safety rails

<critical>

- NEVER modify DESIGN.md without explicit user approval. Present drafts and get confirmation.
- NEVER write design tokens that conflict with VISION.md Identity. If the verbal identity says "warm and approachable" and the user wants a cold, brutalist palette, surface the tension explicitly and let the user resolve it.
- NEVER impose aesthetic preferences. The user's taste drives the design. Have opinions, push
  for specificity, but defer to the user's choices.
- NEVER skip the validation step after writing DESIGN.md. Run `scripts/validate_design.py`
  and fix any errors before presenting the result.
- NEVER create arbitrary token values. Use established scales (8pt grid for spacing, modular type scale for font sizes, OKLCH for perceptual color uniformity). The design system must practice what it preaches.
- NEVER modify code files. Visualisera writes DESIGN.md; realisera implements it. The
  separation of declaration and implementation is fundamental.
- NEVER skip the codebase exploration (Step 1) when code exists. Arriving informed is what
  makes the conversation productive rather than generic.

</critical>

---

## Exit signals

Report one of these statuses at workflow completion:

Format: `─── ◰ visualisera · status ───` followed by a summary sentence.
For flagged, stuck, and waiting: add `▸` bullet details below the summary.

- **complete**: DESIGN.md was written (Create/Replace mode), updated (Refine mode), or audited with findings reported (Audit mode). Validation script ran without errors, and all changes had explicit user approval before writing.
- **flagged**: The design system was produced or audited but with issues worth surfacing. Possible causes: validation passed but with advisory warnings, the design drifts from VISION.md Identity in ways the user acknowledged, or audit findings were discovered that were neither fixed nor filed to TODO.md.
- **stuck**: Cannot write DESIGN.md because the user declined to approve the draft, the validation script reports errors that cannot be resolved without user input on the design intent, or the project's UI stack is inaccessible and token defaults cannot be reliably inferred.
- **waiting**: The visual identity direction is entirely undefined and the user has not engaged with the design conversation, or the project has no UI layer and DESIGN.md would serve no purpose without clarification of what is being designed.

---

## Cross-skill integration

Visualisera is part of an eleven-skill ecosystem. It is the visual identity layer, the skill that defines how the project looks.

### Visualisera reads /visionera output
VISION.md's Identity section declares the verbal personality (bold, warm, playful, etc.). Visualisera reads this to propose visual tokens coherent with the declared identity. If Identity says "industrial and direct," visualisera proposes sharp edges and monospace type. Visionera reads DESIGN.md in return; neither writes the other's artifact.

### Visualisera feeds /realisera
DESIGN.md's tokens and constraints guide autonomous UI development. When realisera builds components or pages, it reads DESIGN.md to understand what colors, typography, spacing, and constraints to use. The design system prevents visual drift across cycles.

### Visualisera is informed by /dokumentera
DOCS.md tracks DESIGN.md in the artifact mapping. Dokumentera may document the design system as part of project documentation.

### Visualisera is informed by /inspektera
When inspektera audits architecture alignment or pattern consistency, design system adherence is a relevant dimension. Future integration may include design-specific audit dimensions.

### Visualisera is informed by /profilera
The decision profile captures aesthetic preferences, specifically the user's established patterns around visual design, typography choices, and UI conventions. Visualisera reads these as defaults during the create conversation.

### Visualisera is informed by /inspirera
When inspirera analyzes external design systems or visual patterns, the findings can feed into visualisera's research step or refine mode. External design references enrich the conversation.

### Visualisera is informed by /resonera
When design decisions require deliberation (competing aesthetics, brand evolution, or significant visual pivots), suggest `/resonera` to think it through before committing to a new design direction.

---

## Getting started

### New project: design before building

1. `/visionera`: create VISION.md with Identity section (who the project IS)
2. `/visualisera`: create DESIGN.md (how it LOOKS), coherent with the Identity
3. `/realisera`: build UI to the design spec

### Existing project: capture the visual identity

1. `/visualisera`: reads existing styles, proposes tokens from what's already there
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
