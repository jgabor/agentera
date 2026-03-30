# Decisions

Reasoning trail maintained by resonera. Each deliberation session appends one entry. Decisions
are referenced by realisera, optimera, and profilera for context on why choices were made.

## Decision 1 — 2026-03-29

**Question**: How should planera (a planning skill) be designed to fit the agent-skills suite?
**Context**: The suite has a gap between deliberation (resonera) and execution (realisera). For
complex multi-file work, realisera's inline Step 4 plan is insufficient. Research covered
spec-driven development, BMAD, TDD-as-planning, planning tools state-of-the-art, plan artifact
formats, and Anthropic's harness design for long-running agents. 11 patterns and 4 key tensions
identified.
**Alternatives**:
- Single-depth planning (always the same ceremony) — rejected: too heavy for small, too light for complex
- Multi-file artifact pipeline (spec.md + design.md + tasks.md) — rejected: suite uses single-file pattern
- Plan as advisory context (realisera still reasons from vision) — rejected: unclear ownership
- Full DTC where planera writes test stubs — rejected: over-specification causes cascading errors
**Choice**: Scale-adaptive planning with three levels, single PLAN.md artifact, clean separation between planera (what/why/acceptance) and realisera (how)
**Reasoning**: The key insight is that planning overhead must be proportional to task complexity.
The three-level model (skip/light/full) prevents both ceremony overhead on small tasks and
under-planning on complex ones. Single PLAN.md keeps the suite's artifact pattern consistent.
Behavioral acceptance criteria (Given/When/Then) enforce intent without prescribing implementation,
aligning with DTC and the TDAD finding that context beats procedure. Adversarial critic for full
plans only — compute where it compounds (multi-cycle work). Human approval when human-initiated,
auto-approve when autonomous (preserves /loop and lira compatibility). Archive to .planera/ keeps
PLAN.md presence as a signal of active work.
**Confidence**: firm
**Feeds into**: PLAN.md artifact design, realisera integration, inspektera integration

### Design Decisions Summary

| Aspect | Decision |
|--------|----------|
| Levels | Three: skip (trivial work), light (single cycle), full (multi-cycle) |
| Artifact | Single PLAN.md with sections scaling by level |
| Acceptance criteria | Behavioral (Given/When/Then), all levels |
| Task selection ownership | Planera owns WHAT, realisera owns HOW |
| Adversarial review | Full plans only (critic agent must find issues) |
| Human approval | Required when human-initiated; auto-approve when autonomous |
| Plan lifecycle | Active in root as PLAN.md; archived to .planera/ on completion |
| Boundary | Planera: what + why + constraints + acceptance. Realisera: which files, implementation, tests, code |
| Plan surprises | Realisera logs surprises, picks next viable task; doesn't block on stale tasks |

## Decision 2 — 2026-03-29

**Question**: Should the vision brainstorm be extracted from realisera into a dedicated skill?
**Context**: Realisera currently owns VISION.md creation via a quick 5-question brainstorm
before cycle 1. This works but is shallow — it needs to get to execution quickly. Vision
creation is a distinct creative/strategic activity that deserves depth. Additionally, the
suite's architectural principle is that skills must work standalone AND mesh when co-installed.
**Alternatives**:
- Keep brainstorm in realisera — rejected: vision creation deserves more depth than a pre-cycle interview
- Make it a resonera specialization — rejected: vision creation is aspirational/creative, not deliberative
- Lightweight wrapper around resonera — rejected: distinct workflow with codebase reading + domain research
**Choice**: Visionera as a distinct skill with two modes (create/refine), deep codebase reading,
domain research, and aspirational Socratic challenge. Realisera keeps its quick bootstrap for
standalone use.
**Reasoning**: Vision creation is fundamentally different from deliberation (resonera) and
execution planning (planera). It requires: (1) reading the codebase to understand what exists,
(2) researching the domain to ground ambition in reality, (3) pushing the user to dream bigger
through aspirational challenge. Realisera's 5-question brainstorm is a quick bootstrap, not
deep strategic work. The standalone + mesh principle means realisera keeps working without
visionera, but defers to it when installed.
**Confidence**: firm
**Feeds into**: VISION.md artifact ownership, realisera integration

### Design Decisions Summary

| Aspect | Decision |
|--------|----------|
| Modes | Two: create (new project) and refine (evolve existing vision) |
| Depth | Codebase reading + domain research + aspirational Socratic challenge |
| Artifact | VISION.md (same format, now owned by visionera when installed) |
| Standalone principle | All skills work independently AND mesh when co-installed |
| Realisera relationship | Realisera keeps quick bootstrap. Defers to visionera when installed. |
| Validation/pivot | Out of scope — validation is inspektera's job, pivoting is resonera's |

## Decision 3 — 2026-03-29

**Question**: How should dokumentera (a documentation skill) be designed for the suite?
**Context**: The suite follows DTC (Document, Test, Code) but no skill owns the "D". Realisera
writes code. Planera writes plans. Visionera writes VISION.md. But project documentation
(README, CLAUDE.md, AGENTS.md, API docs, feature guides) has no dedicated skill. /doc-audit
exists externally for auditing docs against code, but nothing creates or maintains docs.
**Alternatives**:
- Generate docs from code (reactive) — rejected: violates DTC; docs should lead, not follow
- Maintain docs alongside changes only — rejected: misses the DTC-first opportunity
- Separate create/audit split (like visionera/inspektera) — rejected: user wants full lifecycle in one skill
**Choice**: Dokumentera as the "D" in DTC. Two modes (create/update). DOCS.md index. Full
lifecycle including audit (absorbs doc-audit). Context-detected approach. Strict DTC pipeline.
**Reasoning**: DTC says documentation defines intent. Currently nobody in the suite writes the
intent documentation — the "D" is missing. Dokumentera fills this by writing docs before code
(intent-first for new features) and generating docs from existing code (autonomous exploration).
DOCS.md index gives other skills a map of what documentation exists. Full lifecycle including
audit means one skill for all doc needs — simpler for users than coordinating dokumentera +
doc-audit. Context detection (feature exists? → explore and document. Feature doesn't exist? →
write intent docs) makes the skill adaptive without requiring the user to specify mode.
The strict DTC pipeline (dokumentera → planera → realisera) embeds documentation-first as
an architectural principle, not just a guideline.
**Confidence**: firm
**Feeds into**: DOCS.md artifact, DTC pipeline integration, doc-audit absorption

### Design Decisions Summary

| Aspect | Decision |
|--------|----------|
| Modes | Two: create (new docs) and update (revise existing docs) |
| Approach | Context-detected: intent-first for unbuilt features, autonomous exploration for existing code |
| Artifact | DOCS.md index + individual doc files (README, CLAUDE.md, etc.) |
| Audit | Full lifecycle — includes doc-vs-code verification (absorbs doc-audit) |
| Pipeline | Strict DTC: dokumentera → planera → realisera |
| Standalone | Works independently; meshes with suite when co-installed |

---

## Decision 4 — 2026-03-30

**Question**: how should skill-generated docs and artifacts integrate with existing project documentation conventions?

**Context**: The skill suite generates up to 10 state artifacts (VISION.md, DECISIONS.md, PLAN.md, etc.) and dokumentera writes project docs (README, CLAUDE.md, feature guides). When deploying into codebases with existing doc conventions (docs/, shared/docs/, auto-generated API docs, established README style), the skills currently hardcode root placement and impose their own structure. This breaks the host project's organizational contract.

**Alternatives**:
- [Always root] — status quo, simple, but ignores existing conventions and clutters the root with up to 10 unfamiliar files
- [Dedicated directory (.claude/ or .skills/)] — reduces clutter but treats artifacts as hidden tooling state rather than project documentation
- [Project-configurable path] — flexible but adds configuration overhead, violates "convention over configuration"
- [Skills detect and adapt to project conventions] — respects the host project, but requires reliable detection and a coordination mechanism

**Choice**: Skills adapt to the project's existing documentation conventions, coordinated through an expanded DOCS.md contract.

**Reasoning**: "Convention over configuration" (high-confidence profile entry) means the *project's* convention wins, not the skill suite's. The skills are guests in someone else's codebase. The key realization: these artifacts are genuinely dual-purpose (human documentation AND skill coordination state), which means they can't be hidden away in a tooling directory, but they also can't be dumped at root unconditionally.

**Design**:

DOCS.md evolves from a flat documentation index into a three-layer contract:
1. **Conventions** — where docs live in this project, style defaults (tone, structure, badges), auto-gen tooling declarations (TypeDoc, Storybook, OpenAPI tracked as `generated` / hands-off)
2. **Artifact mapping** — where each skill artifact goes in this project (customizable per-project, defaults to root for backward compatibility)
3. **Index** — what docs exist (authored, generated, skill artifacts), their status, coverage stats

**How it works**:
- Dokumentera's first run on a new project performs a survey: explore the codebase, detect existing doc structure/style/tooling, propose a full convention map, user approves
- The convention map is written to DOCS.md
- All nine skills check DOCS.md for artifact paths before reading/writing, with root as fallback (backward compatible)
- Dokumentera reads existing docs + DOCS.md style defaults to match tone when generating new docs; broad rules declared, fine details inferred
- Auto-generated docs tracked with `generated` status so dokumentera knows to observe but not touch

**Implementation scope**: Update DOCS.md template, update dokumentera's survey/audit flow, update all 9 SKILL.md files to check DOCS.md for artifact paths.

**Confidence**: firm
**Feeds into**: PLAN.md

---

## Decision 5 — 2026-03-30

**Question**: should visionera's VISION.md include a product identity layer (brand personality, voice, aesthetic, communication style)?

**Context**: VISION.md currently captures purpose identity — North Star, Who It's For, Principles, Direction. But it has no section for experiential identity — what the product *feels like* as an entity. Meanwhile, DESIGN.md (a separate spec at ~/git/DESIGN.md) handles visual design tokens (colors, typography, constraints) as a machine-parseable format for agents. The gap: verbal identity, personality, emotional register, and naming philosophy have no home. These skills are meant for public release and must work for any user and project.

**Alternatives**:
- [Expand DESIGN.md] to include verbal/experiential identity — rejected: DESIGN.md is a visual token system, adding brand strategy blurs its focus
- [Separate BRAND.md artifact] — rejected: adds artifact sprawl; identity is part of what the project IS, not a separate concern
- [Fold into Principles] — rejected: principles are values and tradeoffs; identity is personality and voice, a different dimension
- [Add Identity section to VISION.md] — chosen: extends the "who is this project" document naturally

**Choice**: Add a four-dimension Identity section to VISION.md, explored by visionera's conversation. Explicitly link to DESIGN.md as the visual implementation of the declared identity.

**Reasoning**: VISION.md already answers "what does this project do, for whom, why, and where is it going." Identity answers the missing "who is this project as an entity." The four dimensions — personality (adjectives), voice (communication style), emotional register (how it feels to use), naming (how things are named) — capture the non-visual identity that DESIGN.md can't express. The relationship is DTC-style: Identity section is the intent, DESIGN.md implements it visually, code implements it functionally. Visionera reads DESIGN.md during exploration to ensure coherence between declared identity and visual system.

### Design Decisions Summary

| Aspect | Decision |
|--------|----------|
| Location | Identity section in VISION.md (not a separate artifact) |
| Dimensions | Four: personality, voice, emotional register, naming |
| Tone | Aspirational, not prescriptive (like everything in VISION.md) |
| DESIGN.md linkage | Explicitly linked — visionera reads DESIGN.md to ensure coherence; Identity section is the brief for DESIGN.md |
| Visionera conversation | New fifth arc after direction: explore the product's personality |
| Public release | Skills work for any user — identity is explored fresh per project, profile provides defaults |

**Confidence**: firm
**Feeds into**: PLAN.md

---

## Decision 6 — 2026-03-30

**Question**: how should the DESIGN.md spec be absorbed into the skill suite, given skills must work standalone?

**Context**: Decision 5 added an Identity section to VISION.md and had visionera reference DESIGN.md for coherence. But visionera says "read DESIGN.md" without understanding the format — the `<!-- design:colors -->` marker syntax, the YAML token blocks, the standard sections, the constraint system. That knowledge lives in `~/git/DESIGN.md/DESIGN.md`, an external spec that's a moving target. The standalone principle means skills can't depend on external resources.

**Alternatives**:
- [Bundle spec in visionera/references/] — makes visionera aware of the format, but other skills (realisera, dokumentera, inspektera) also need format knowledge; centralizing in one skill creates a hidden dependency
- [Shared suite-level reference] — breaks the per-skill standalone model; skills are installed individually
- [New visualisera skill] — dedicated skill that owns the DESIGN.md lifecycle and bundles the spec, paralleling visionera's role for VISION.md

**Choice**: Create visualisera as the 10th skill — the visual identity counterpart to visionera. Full DESIGN.md lifecycle with the spec bundled as a reference doc.

**Reasoning**: DESIGN.md is both a format specification AND a creative artifact. Creating a design system (brainstorming aesthetic, choosing tokens, defining constraints) is a distinct creative workflow that parallels what visionera does for purpose. Bundling the spec as a reference in visualisera's `references/` eliminates the external dependency. The read/write boundary is clean: visionera reads DESIGN.md for Identity coherence (like it reads HEALTH.md), visualisera owns all writes. This follows the same pattern as realisera/optimera (realisera reads OBJECTIVE.md, optimera writes it).

### Design Decisions Summary

| Aspect | Decision |
|--------|----------|
| Skill name | visualisera (Visual Identity: ...) |
| Artifact | DESIGN.md (created and maintained by visualisera) |
| Spec location | visualisera/references/DESIGN-spec.md (bundled, not external) |
| Lifecycle | Create, refine, audit — same modes as visionera |
| Read/write boundary | Visionera reads DESIGN.md for context; visualisera owns all writes |
| Coherence | Visualisera reads VISION.md Identity section; visionera reads DESIGN.md |
| Suite size | 10 skills (update all "nine-skill" references) |

**Confidence**: firm
**Feeds into**: PLAN.md
