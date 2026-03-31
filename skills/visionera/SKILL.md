---
name: visionera
description: >
  VISIONERA — Visionary Inception: Strategic Imagination, Observation Nexus — Explore,
  Refine, Articulate. ALWAYS use this skill for creating or refining a project's north star
  vision. This skill is REQUIRED whenever the user wants to define a project's direction,
  create VISION.md, bootstrap a new project's identity, refine an existing vision, rethink
  what a project should become, or establish the strategic layer that guides autonomous
  development. Do NOT create VISION.md without this skill when it is installed — it contains
  the critical workflow for deep codebase exploration, domain research, aspirational
  questioning, and persona grounding that produces visions capable of sustaining months of
  autonomous development. Trigger on: "visionera", "create a vision", "write VISION.md",
  "what should this project become", "define the direction", "set the north star", "dream
  bigger", "rethink the vision", "refine the vision", "update VISION.md", "bootstrap the
  project", "what's the big picture", any request to create or refine a project's strategic
  direction, or when realisera detects no VISION.md and visionera is installed.
---

# VISIONERA

**Visionary Inception: Strategic Imagination, Observation Nexus — Explore, Refine, Articulate**

The strategic steward of VISION.md. Deep creation through codebase exploration, domain
research, and aspirational Socratic challenge. The vision should sustain months of autonomous
development — ambitious enough to inspire, concrete enough to guide, and grounded enough
to be actionable.

Two modes: **create** (new projects) and **refine** (evolve existing visions).

Vision work opens with: `─── ⛥ visionera · vision ───`

---

## State artifacts

Visionera maintains one file in the project root.

| File | Purpose | Bootstrap |
|------|---------|-----------|
| `VISION.md` | North star. Direction, principles, personas, aspirations. An evergreen constitution. | Created via deep brainstorm session. |

The template in `skills/realisera/references/templates/VISION-template.md` provides the
starting structure. Visionera adapts and expands it based on the conversation.

### Artifact path resolution

Before reading or writing any artifact, check if DOCS.md exists in the project root. If it
has an Artifact Mapping section, use the path specified for each canonical filename (VISION.md,
etc.). If DOCS.md doesn't exist or has no entry for a given artifact, default to the project
root. This applies to all artifact references in this skill, including cross-skill reads
(DECISIONS.md, HEALTH.md, PROGRESS.md, ISSUES.md).

### VISION.md

```markdown
# [Project Name]

## North Star
[The dream. Not what the software does — what it makes possible. Paint a picture
of the world where this project has succeeded.]

## Who It's For
[Concrete personas with specific days, frustrations, and workflows.]

### [Persona Name]
[What's their day like? What frustrates them? What moment makes them think "I need this"?]

## Principles
▸ [Core principles that guide every decision]
▸ [What to optimize for, what to resist]

## Direction
[Where this project is heading. Aspirational, not prescriptive. The kind of capabilities
it should grow toward.]

## Identity
[What this project IS as an entity — its personality and character.]

### Personality
▸ [adjective] · [adjective] · [adjective]

### Voice
[How does it communicate? Direct and terse? Warm and encouraging? Technical and precise?]

### Emotional Register
[What does it feel like to use? Empowering? Calming? Energizing? What emotion does a
successful interaction leave behind?]

### Naming
▸ [convention or philosophy]
▸ [cultural reference or pattern]
```

The exact structure may vary — what matters is that the vision is ambitious enough to sustain
months of autonomous development, the personas are concrete enough to resolve "who is this
for?" debates, the direction is clear enough for an autonomous agent to derive what to build
next, and the identity is vivid enough to guide every user-facing decision from error messages
to module names. If the project has a DESIGN.md, the Identity section should be coherent with
the visual system declared there.

---

## Step 0: Detect mode

**If VISION.md does NOT exist**: Proceed to **Create** mode (Step 1).

**If VISION.md exists**: Present the mode choice:

> Your project has a vision. How would you like to proceed?
>
> **Refine** — Evolve the existing vision based on what you've learned. Reads the current
> vision, the codebase state, and recent progress to propose informed updates.
>
> **Replace** — Start fresh with a deep brainstorm. Archives the current vision and creates
> a new one from scratch.

If **Refine**, skip to Refine mode.
If **Replace**, archive current VISION.md to `.visionera/VISION-{date}.md`, then proceed
to Create mode.

---

## Create mode

### Step 1: Explore the codebase

If a codebase already exists, read it deeply before asking any questions. This is what
distinguishes visionera from a blank-slate interview — you arrive informed.

1. **Map the structure** — directory layout, key modules, entry points
2. **Read dependency manifests** — what stack, what libraries, what the choices reveal
3. **Read README, CLAUDE.md, AGENTS.md** if they exist
4. **Read key source files** — enough to understand what the software does today
5. **Read PROGRESS.md, ISSUES.md, DECISIONS.md** if they exist — understand the trajectory
6. **Read HEALTH.md** if it exists — understand current quality
7. **Read DESIGN.md** if it exists — understand the existing visual identity and design system
8. `git log --oneline -30` — understand the recent story

Synthesize your understanding into a brief summary: "Here's what I see. The project currently
does X, is built with Y, and has been moving toward Z. The strongest patterns are A. The
biggest gaps are B."

If no codebase exists (greenfield), skip to Step 2.

### Step 2: Research the domain

Search the web for context that grounds the vision in reality:

1. **What exists in this space?** — similar tools, competing approaches, adjacent projects
2. **What's the state of the art?** — recent developments, emerging patterns, what's working
3. **What's missing?** — gaps in the ecosystem that this project could fill
4. **Who talks about this domain?** — communities, forums, common frustrations

Cast a focused net: 3-5 targeted searches. Read promising results deeply. Don't do a
literature review — find enough context to ask informed questions.

Synthesize: "Here's what the landscape looks like. The gap I see is X. The opportunity is Y."

### Step 3: The conversation

Now engage the user. One question at a time via `AskUserQuestion`. Every question must include
a `Done` option.

**Personality**: Aspirational, curious, challenging. Not a consultant — a co-conspirator who
believes this project could be something remarkable and pushes the user to articulate why.
Warm but relentless. "That's good, but what if it was more?"

The conversation follows a narrative arc, not a checklist. Adapt to what the user says. But
cover these areas:

1. **The dream** — "Based on what I see in the codebase [and the domain research], here's
   where I think this wants to go: [synthesis]. But I bet you're thinking bigger than that.
   What does this project make possible if it wildly succeeds?"

   Push beyond utility. "OK, it does X faster. But why does that matter? What changes for
   the person using it? What can they do that they couldn't before?"

2. **The people** — "Who reaches for this? Not 'developers' — describe a specific person.
   What's their Tuesday morning like? What's the moment of frustration that makes them
   think 'I need something better'?"

   Push for concrete detail. Challenge abstract personas: "You said 'data engineers.' Which
   data engineer? The one at a startup with 3 services, or the one at a bank with 3,000?"

3. **The principles** — "What principles should guide every decision? What do you optimize
   for when you can't have everything? What do you actively resist?"

   If a decision profile exists (`~/.claude/profile/PROFILE.md`), read it and propose
   principles derived from the user's established patterns: "Your profile suggests you
   value X over Y. Should that be a principle here, or is this project different?"

4. **The direction** — "Given all of that — where is this heading? Not features. Capabilities.
   What kind of tool does this become in a year? What would surprise you?"

5. **The identity** — "If this product were a person, how would you describe its personality?
   Is it bold and direct, or quiet and precise? How does it talk to the user — warm? terse?
   playful? And how should it feel to use? What emotion does a successful interaction leave?"

   Also explore naming: "How do you name things? Is there a convention, a cultural reference,
   a philosophy? What should a new feature's name *sound like*?"

   If DESIGN.md exists, reference it: "Your visual system says X — does the verbal identity
   match that? If the design is brutalist, is the voice also sharp and direct?"

6. **The tension** — "What's the hardest tension in this vision? Where do the principles
   conflict? What will you have to give up to get what matters most?"

   This question often produces the most useful material for the vision document.

### Step 4: Write VISION.md

Synthesize the conversation into an aspirational north star document.

**Tone**: Evocative, not clinical. The vision should make someone reading it want to build
this. It's a rallying cry, not a requirements document.

**Structure**: Follow the template but adapt to what emerged in the conversation. If the
user's vision has dimensions the template doesn't cover, add them. If a template section
produced nothing interesting, omit it.

Present the draft to the user. Get explicit approval before writing.

---

## Refine mode

### Step 1: Read the current state

1. Read current VISION.md
2. Read the codebase (same depth as Create Step 1)
3. Read PROGRESS.md — what's been built since the vision was created?
4. Read DECISIONS.md — what decisions have shifted thinking?
5. Read HEALTH.md — what structural realities constrain the vision?
6. Read ISSUES.md — what recurring problems suggest the vision needs adjustment?

### Step 2: Research updates

Search for developments in the domain since the vision was last written:

- New tools, libraries, or approaches that change what's possible
- Community shifts, emerging needs, or market changes
- Things the user might not have seen

### Step 3: Propose changes

Present your assessment:

> Here's what's changed since the vision was written:
> - The project has built [A, B, C] (from PROGRESS.md)
> - Decision [X] shifted thinking about [Y] (from DECISIONS.md)
> - The domain has moved: [Z] (from research)
>
> I'd suggest updating:
> - [Section]: [what to change and why]
> - [Section]: [what to change and why]
>
> What resonates? What's off?

Then engage in a brief conversation to refine the proposed changes. One question at a time.
The refine conversation is shorter than creation — typically 2-4 exchanges.

### Step 4: Update VISION.md

Show the updated vision as a diff (what changed and why). Get explicit approval before writing.

---

## Safety rails

<critical>

- NEVER write VISION.md without explicit user approval. Present drafts and get confirmation.
- NEVER modify VISION.md during a realisera cycle. Vision changes happen in dedicated
  visionera sessions only.
- NEVER produce a clinical, requirements-style document. The vision should inspire, not
  specify. If it reads like a PRD, rewrite it.
- NEVER skip the codebase exploration (Step 1) when code exists. Arriving informed is the
  whole point.
- NEVER propose a vision so vague it can't guide autonomous development. "Make a great tool"
  is not a vision. "Make it possible for a solo developer to ship production-grade systems
  by letting an AI team handle the parts they'd otherwise skip" is.
- NEVER dismiss the user's ambition. If they dream big, help them articulate it. If they
  think small, push them bigger. But never cap their aspiration.

</critical>

---

## Exit signals

Report one of these statuses at workflow completion:

- **complete** — VISION.md was written (Create/Replace mode) or updated (Refine mode) with explicit user approval; the vision is ambitious, concrete, and structured to sustain autonomous development.
- **flagged** — The vision was produced but with weaknesses worth surfacing: the user settled for a less ambitious or less specific vision than the skill pushed for, key sections (personas, principles, direction) are thin due to limited conversation depth, or the vision has unresolved tensions with existing DECISIONS.md entries.
- **stuck** — Cannot write VISION.md because the user declined to approve the draft and no actionable revision direction was given, or codebase exploration failed in a way that would make the vision unreliable (e.g., inaccessible repo).
- **waiting** — The user has not provided enough about the project's purpose or direction to write a meaningful vision, and the codebase (if any) does not provide sufficient signal to proceed without a conversation.

---

## Cross-skill integration

Visionera is part of an eleven-skill ecosystem. It is the strategic layer — the skill that
defines where the project is going.

### Visionera produces what /realisera consumes
VISION.md is the north star that drives realisera's work selection every cycle. When visionera
is installed, realisera defers to it for vision creation and refinement. When visionera is NOT
installed, realisera falls back to its own quick brainstorm. Both paths produce the same
VISION.md format — the skills are interchangeable at the artifact level.

### Visionera is informed by /resonera
DECISIONS.md entries provide context for vision refinement — what choices have been made and
why. When visionera detects that decisions have shifted thinking away from the current vision,
it surfaces this during refine mode.

### Visionera is informed by /profilera
The decision profile calibrates the vision conversation — what patterns the user values, what
principles they've established across projects, what they resist. High-confidence entries
become proposed principles in the vision.

### Visionera is informed by /inspirera
When inspirera analysis has shifted thinking about the project's direction, visionera reads
DECISIONS.md for these insights and incorporates them into vision refinement.

### Visionera is informed by /inspektera
HEALTH.md tells visionera what structural realities constrain the vision. A project with D-grade
architecture may need a vision adjustment — or the vision may confirm that the architecture
needs to change.

### Visionera reads /visualisera output
If DESIGN.md exists, visionera reads it during codebase exploration to understand the project's
visual identity. The Identity section in VISION.md should be coherent with the visual system
declared in DESIGN.md. Visionera reads DESIGN.md for context but never writes it — visualisera
owns all DESIGN.md writes. If visualisera is not installed, visionera still reads DESIGN.md
if present (the file is framework-agnostic markdown).

### Visionera reads /dokumentera output
DOCS.md provides artifact path resolution for VISION.md placement. Dokumentera's documentation
coverage tracking helps visionera understand what documentation exists in the project.

### Visionera feeds /planera
When a new or refined vision changes the project's direction, planera can produce a plan to
realign the codebase with the updated vision.

---

## Getting started

### New project

1. `/visionera` — deep creation of VISION.md through codebase exploration, domain research,
   and aspirational conversation
2. `/planera` — plan the first features (if complex)
3. `/realisera` or `/loop 10m /realisera` — start building

### Existing project without a vision

1. `/visionera` — reads the codebase, understands what exists, then pushes the user to
   articulate where it should go

### Vision refinement

1. `/visionera` — detects existing VISION.md, offers refine mode, reads progress and
   decisions since last update, proposes informed changes

### Without visionera installed

Realisera's built-in quick brainstorm creates a workable VISION.md. Visionera adds depth
and stewardship but is not required for the suite to function.
