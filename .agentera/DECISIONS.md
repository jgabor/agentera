# Decisions

Reasoning trail maintained by resonera. Each deliberation session appends one entry. Decisions are referenced by realisera, optimera, and profilera for context on why choices were made.

## Decision 1 · 2026-03-29

**Question**: How should planera (a planning skill) be designed to fit the agent-skills suite?
**Context**: The suite has a gap between deliberation (resonera) and execution (realisera). For complex multi-file work, realisera's inline Step 4 plan is insufficient. Research covered spec-driven development, BMAD, TDD-as-planning, planning tools state-of-the-art, plan artifact formats, and Anthropic's harness design for long-running agents. 11 patterns and 4 key tensions identified.
**Alternatives**:
- Single-depth planning (always the same ceremony), rejected: too heavy for small, too light for complex
- Multi-file artifact pipeline (spec.md + design.md + tasks.md), rejected: suite uses single-file pattern
- Plan as advisory context (realisera still reasons from vision), rejected: unclear ownership
- Full DTC where planera writes test stubs, rejected: over-specification causes cascading errors
**Choice**: Scale-adaptive planning with three levels, single PLAN.md artifact, clean separation between planera (what/why/acceptance) and realisera (how)
**Reasoning**: The key insight is that planning overhead must be proportional to task complexity. The three-level model (skip/light/full) prevents both ceremony overhead on small tasks and under-planning on complex ones. Single PLAN.md keeps the suite's artifact pattern consistent. Behavioral acceptance criteria (Given/When/Then) enforce intent without prescribing implementation, aligning with DTC and the TDAD finding that context beats procedure. Adversarial critic for full plans only, compute where it compounds (multi-cycle work). Human approval when human-initiated, auto-approve when autonomous (preserves /loop and lira compatibility). Archive to .planera/ keeps PLAN.md presence as a signal of active work.
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

## Decision 2 · 2026-03-29

**Question**: Should the vision brainstorm be extracted from realisera into a dedicated skill?
**Context**: Realisera currently owns VISION.md creation via a quick 5-question brainstorm before cycle 1. This works but is shallow, it needs to get to execution quickly. Vision creation is a distinct creative/strategic activity that deserves depth. Additionally, the suite's architectural principle is that skills must work standalone AND mesh when co-installed.
**Alternatives**:
- Keep brainstorm in realisera, rejected: vision creation deserves more depth than a pre-cycle interview
- Make it a resonera specialization, rejected: vision creation is aspirational/creative, not deliberative
- Lightweight wrapper around resonera, rejected: distinct workflow with codebase reading + domain research
**Choice**: Visionera as a distinct skill with two modes (create/refine), deep codebase reading, domain research, and aspirational Socratic challenge. Realisera keeps its quick bootstrap for standalone use.
**Reasoning**: Vision creation is fundamentally different from deliberation (resonera) and execution planning (planera). It requires: (1) reading the codebase to understand what exists, (2) researching the domain to ground ambition in reality, (3) pushing the user to dream bigger through aspirational challenge. Realisera's 5-question brainstorm is a quick bootstrap, not deep strategic work. The standalone + mesh principle means realisera keeps working without visionera, but defers to it when installed.
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
| Validation/pivot | Out of scope: validation is inspektera's job, pivoting is resonera's |

## Decision 3 · 2026-03-29

**Question**: How should dokumentera (a documentation skill) be designed for the suite?
**Context**: The suite follows DTC (Document, Test, Code) but no skill owns the "D". Realisera writes code. Planera writes plans. Visionera writes VISION.md. But project documentation (README, CLAUDE.md, AGENTS.md, API docs, feature guides) has no dedicated skill. /doc-audit exists externally for auditing docs against code, but nothing creates or maintains docs.
**Alternatives**:
- Generate docs from code (reactive), rejected: violates DTC; docs should lead, not follow
- Maintain docs alongside changes only, rejected: misses the DTC-first opportunity
- Separate create/audit split (like visionera/inspektera), rejected: user wants full lifecycle in one skill
**Choice**: Dokumentera as the "D" in DTC. Two modes (create/update). DOCS.md index. Full lifecycle including audit (absorbs doc-audit). Context-detected approach. Strict DTC pipeline.
**Reasoning**: DTC says documentation defines intent. Currently nobody in the suite writes the intent documentation, the "D" is missing. Dokumentera fills this by writing docs before code (intent-first for new features) and generating docs from existing code (autonomous exploration). DOCS.md index gives other skills a map of what documentation exists. Full lifecycle including audit means one skill for all doc needs, simpler for users than coordinating dokumentera + doc-audit. Context detection (feature exists? → explore and document. Feature doesn't exist? → write intent docs) makes the skill adaptive without requiring the user to specify mode. The strict DTC pipeline (dokumentera → planera → realisera) embeds documentation-first as an architectural principle, not just a guideline.
**Confidence**: firm
**Feeds into**: DOCS.md artifact, DTC pipeline integration, doc-audit absorption

### Design Decisions Summary

| Aspect | Decision |
|--------|----------|
| Modes | Two: create (new docs) and update (revise existing docs) |
| Approach | Context-detected: intent-first for unbuilt features, autonomous exploration for existing code |
| Artifact | DOCS.md index + individual doc files (README, CLAUDE.md, etc.) |
| Audit | Full lifecycle: includes doc-vs-code verification (absorbs doc-audit) |
| Pipeline | Strict DTC: dokumentera → planera → realisera |
| Standalone | Works independently; meshes with suite when co-installed |

---

## Decision 4 · 2026-03-30

**Question**: how should skill-generated docs and artifacts integrate with existing project documentation conventions?

**Context**: The skill suite generates up to 10 state artifacts (VISION.md, DECISIONS.md, PLAN.md, etc.) and dokumentera writes project docs (README, CLAUDE.md, feature guides). When deploying into codebases with existing doc conventions (docs/, shared/docs/, auto-generated API docs, established README style), the skills currently hardcode root placement and impose their own structure. This breaks the host project's organizational contract.

**Alternatives**:
- [Always root], status quo, simple, but ignores existing conventions and clutters the root with up to 10 unfamiliar files
- [Dedicated directory (.claude/ or .skills/)], reduces clutter but treats artifacts as hidden tooling state rather than project documentation
- [Project-configurable path], flexible but adds configuration overhead, violates "convention over configuration"
- [Skills detect and adapt to project conventions], respects the host project, but requires reliable detection and a coordination mechanism

**Choice**: Skills adapt to the project's existing documentation conventions, coordinated through an expanded DOCS.md contract.

**Reasoning**: "Convention over configuration" (high-confidence profile entry) means the *project's* convention wins, not the skill suite's. The skills are guests in someone else's codebase. The key realization: these artifacts are genuinely dual-purpose (human documentation AND skill coordination state), which means they can't be hidden away in a tooling directory, but they also can't be dumped at root unconditionally.

**Design**:

DOCS.md evolves from a flat documentation index into a three-layer contract: 1. **Conventions**, where docs live in this project, style defaults (tone, structure, badges), auto-gen tooling declarations (TypeDoc, Storybook, OpenAPI tracked as `generated` / hands-off) 2. **Artifact mapping**, where each skill artifact goes in this project (customizable per-project, defaults to root for backward compatibility) 3. **Index**, what docs exist (authored, generated, skill artifacts), their status, coverage stats

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

## Decision 5 · 2026-03-30

**Question**: should visionera's VISION.md include a product identity layer (brand personality, voice, aesthetic, communication style)?

**Context**: VISION.md currently captures purpose identity, North Star, Who It's For, Principles, Direction. But it has no section for experiential identity, what the product *feels like* as an entity. Meanwhile, DESIGN.md (a separate spec at ~/git/DESIGN.md) handles visual design tokens (colors, typography, constraints) as a machine-parseable format for agents. The gap: verbal identity, personality, emotional register, and naming philosophy have no home. These skills are meant for public release and must work for any user and project.

**Alternatives**:
- [Expand DESIGN.md] to include verbal/experiential identity, rejected: DESIGN.md is a visual token system, adding brand strategy blurs its focus
- [Separate BRAND.md artifact], rejected: adds artifact sprawl; identity is part of what the project IS, not a separate concern
- [Fold into Principles], rejected: principles are values and tradeoffs; identity is personality and voice, a different dimension
- [Add Identity section to VISION.md], chosen: extends the "who is this project" document naturally

**Choice**: Add a four-dimension Identity section to VISION.md, explored by visionera's conversation. Explicitly link to DESIGN.md as the visual implementation of the declared identity.

**Reasoning**: VISION.md already answers "what does this project do, for whom, why, and where is it going." Identity answers the missing "who is this project as an entity." The four dimensions, personality (adjectives), voice (communication style), emotional register (how it feels to use), naming (how things are named), capture the non-visual identity that DESIGN.md can't express. The relationship is DTC-style: Identity section is the intent, DESIGN.md implements it visually, code implements it functionally. Visionera reads DESIGN.md during exploration to ensure coherence between declared identity and visual system.

### Design Decisions Summary

| Aspect | Decision |
|--------|----------|
| Location | Identity section in VISION.md (not a separate artifact) |
| Dimensions | Four: personality, voice, emotional register, naming |
| Tone | Aspirational, not prescriptive (like everything in VISION.md) |
| DESIGN.md linkage | Explicitly linked: visionera reads DESIGN.md to ensure coherence; Identity section is the brief for DESIGN.md |
| Visionera conversation | New fifth arc after direction: explore the product's personality |
| Public release | Skills work for any user: identity is explored fresh per project, profile provides defaults |

**Confidence**: firm
**Feeds into**: PLAN.md

---

## Decision 6 · 2026-03-30

**Question**: how should the DESIGN.md spec be absorbed into the skill suite, given skills must work standalone?

**Context**: Decision 5 added an Identity section to VISION.md and had visionera reference DESIGN.md for coherence. But visionera says "read DESIGN.md" without understanding the format, the `<!-- design:colors -->` marker syntax, the YAML token blocks, the standard sections, the constraint system. That knowledge lives in `~/git/DESIGN.md/DESIGN.md`, an external spec that's a moving target. The standalone principle means skills can't depend on external resources.

**Alternatives**:
- [Bundle spec in visionera/references/], makes visionera aware of the format, but other skills (realisera, dokumentera, inspektera) also need format knowledge; centralizing in one skill creates a hidden dependency
- [Shared suite-level reference], breaks the per-skill standalone model; skills are installed individually
- [New visualisera skill], dedicated skill that owns the DESIGN.md lifecycle and bundles the spec, paralleling visionera's role for VISION.md

**Choice**: Create visualisera as the 10th skill, the visual identity counterpart to visionera. Full DESIGN.md lifecycle with the spec bundled as a reference doc.

**Reasoning**: DESIGN.md is both a format specification AND a creative artifact. Creating a design system (brainstorming aesthetic, choosing tokens, defining constraints) is a distinct creative workflow that parallels what visionera does for purpose. Bundling the spec as a reference in visualisera's `references/` eliminates the external dependency. The read/write boundary is clean: visionera reads DESIGN.md for Identity coherence (like it reads HEALTH.md), visualisera owns all writes. This follows the same pattern as realisera/optimera (realisera reads OBJECTIVE.md, optimera writes it).

### Design Decisions Summary

| Aspect | Decision |
|--------|----------|
| Skill name | visualisera (Visual Identity: ...) |
| Artifact | DESIGN.md (created and maintained by visualisera) |
| Spec location | visualisera/references/DESIGN-spec.md (bundled, not external) |
| Lifecycle | Create, refine, audit: same modes as visionera |
| Read/write boundary | Visionera reads DESIGN.md for context; visualisera owns all writes |
| Coherence | Visualisera reads VISION.md Identity section; visionera reads DESIGN.md |
| Suite size | 10 skills (update all "nine-skill" references) |

**Confidence**: firm
**Feeds into**: PLAN.md

---

## Decision 7 · 2026-03-30

**Question**: How should the skill ecosystem enforce cross-skill alignment and prevent shared primitives from diverging as skills are added?

**Context**: The knowledge-synthesis cross-pollination analysis (inspirera) revealed that inspektera uses a 0-100 confidence scale while profilera uses 0.0-1.0 with exponential decay: two independently invented systems for the same concept. This is the poster child for a broader risk: as skills grow, shared primitives (confidence, severity, artifact formats, structural conventions) diverge because they're defined by copy-paste convention rather than a single source of truth. The user explicitly rejected artifact authority ordering in favor of preventing conflicts rather than arbitrating them.

**Alternatives**:
- [Artifact authority ordering], rejected: the user wants alignment enforcement, not conflict
  arbitration. Conflicts between artifacts signal real problems that should be surfaced and fixed.
- [Runtime validation when skills interact on a target project], rejected: alignment is a
  development-time concern. Skills are authored together in one repo, so catch drift before publishing.
- [Shared reference docs only (no enforcement)], rejected: DOCS.md's artifact path resolution
  is already a convention that skills honor voluntarily, and divergence still happened.
- [Per-primitive reference docs], rejected in favor of a single comprehensive spec for
  maintainability.

**Choice**: Single ecosystem spec (`references/SPEC.md`) defining all shared primitives, enforced by a Python linter (`scripts/validate-ecosystem.py`) running as a pre-commit hook.

**Reasoning**: The confidence divergence proved that convention-based alignment fails silently. Two skills independently invented scoring systems that use different scales for the same concept. The fix is twofold: (1) define shared primitives in one place so new skills inherit consistency, and (2) validate alignment deterministically so drift can't be committed. A pre-commit hook is the tightest feedback loop, it catches violations at the moment they're introduced, requiring zero discipline. The Anthropic `~~placeholder` + `CONNECTORS.md` pattern from knowledge-work-plugins confirmed the architecture: define once, reference everywhere, validate consistency.

**Primitives identified (9 total)**:

| # | Primitive | Category | Validation |
|---|-----------|----------|------------|
| 1 | Confidence scale (0-100, five tiers) | Behavioral | Deterministic: regex tier boundaries |
| 2 | Severity levels | Behavioral | Deterministic: exact string matching |
| 3 | Decision confidence labels (firm/provisional/exploratory) | Behavioral | Deterministic: enum values |
| 4 | Artifact format contracts | Behavioral | Manual review flag |
| 5 | Artifact path resolution (DOCS.md pattern) | Mechanical | Deterministic: instruction text matching |
| 6 | Profile consumption pattern | Mechanical | Deterministic: script invocation matching |
| 7 | Cross-skill integration section format | Structural | Deterministic: section presence + completeness |
| 8 | Safety rails section format | Structural | Deterministic: `<critical>` tag presence |
| 9 | SKILL.md frontmatter requirements | Structural | Deterministic: required fields |

**Validation approach**: Deterministic checks (boundaries, names, section presence, field requirements) block commits. Fuzzy checks (artifact format semantic alignment) flag for manual review but don't block. Python stdlib only, consistent with existing scripts.

**Confidence**: firm
**Feeds into**: ISSUES.md, PLAN.md

---

## Decision 8 · 2026-03-30

**Question**: Should the ecosystem unify its confidence model, and if so, on what scale?

**Context**: Inspektera uses a 0-100 integer scale with five tiers (90-100 verified, 70-89 strong, 50-69 moderate, 30-49 uncertain, 0-29 speculative). Profilera uses 0.0-1.0 float with exponential decay (`conf × e^(-λ × days_since_confirmed)`) and similar five tiers (0.85-0.95, 0.65-0.80, 0.45-0.60, 0.25-0.40, 0.10-0.20). Seven skills consume confidence values from one or both systems. The two scales express the same semantics at different numeric ranges.

**Alternatives**:
- [0.0-1.0 everywhere], rejected: less human-readable in artifacts like HEALTH.md that humans
  read directly. "confidence: 73" is more natural than "confidence: 0.73".
- [Unified semantic tiers only (let skills pick their scale)], rejected: the user wants one
  numeric scale, no translation needed between skills.
- [Same tier names across skills], rejected: tier *labels* are domain-specific (inspektera:
  "definitely a real issue" vs profilera: "shipped consistently"). Shared boundaries are sufficient; each skill describes what a tier means in its own context.

**Choice**: Unify on 0-100 integer scale. Five shared tier boundaries. Domain-specific labels. Temporal decay is opt-in.

**Reasoning**: 0-100 is more readable in human-facing artifacts (HEALTH.md, PROFILE.md) and inspektera already uses it. The decay formula works identically at this scale (`floor 20` instead of `floor 0.20`, same λ values). Same boundaries remove all translation friction when one skill reads another's confidence values. Domain-specific labels preserve each skill's ability to describe what confidence means in its context, "verified by reading the code" and "shipped consistently across 3+ projects" are both 90+ but mean different things.

### Design Decisions Summary

| Aspect | Decision |
|--------|----------|
| Scale | 0-100 integer |
| Tiers | Five (boundaries to be reconciled from inspektera/profilera current ranges) |
| Labels | Domain-specific: each skill defines its own tier descriptions |
| Decay | Opt-in per skill. Profilera uses it. Inspektera does not. |
| Migration | Profilera migrates from 0.0-1.0 to 0-100 |
| Boundary reconciliation | Implementation detail: reconcile during the spec authoring |

**Confidence**: firm
**Feeds into**: references/SPEC.md (Decision 7)

---

## Decision 9 · 2026-03-31

**Question**: What should this skill ecosystem be named? The current name "agent-skills" is generic and doesn't represent what it is or provides.
**Context**: The ecosystem is a collection of 10 interconnected Swedish-named skills that give a solo founder an engineering team. All skill names follow the Swedish -era verb convention. The name appears in the repo, marketplace manifest, README, and CLAUDE.md. It's the public identity.
**Alternatives**:
- [agent-skills], current name. Generic, describes the format not the identity. Could be any collection of any skills.
- [agenterna], "the agents" in Swedish. Directly plural/collective. Rejected: too literal, dictionary translation energy rather than proper name energy.
- [arsenalen], "the arsenal." Cross-language transparency, forge heritage. Rejected: military connotation clashes with crew/team energy.
- [ateljén / fabriken / hantverket], explored as forge/workshop alternatives with cross-language transparency. None landed, each had tradeoffs (too artsy, too industrial, too literal) that didn't match the desired feel.
- [smedjan], "the forge." Maximum Swedish character. Rejected: completely opaque to non-Swedes.
- [agenteri], "agent-ery," Swedish -eri suffix (bakery, brewery). Workshop energy. Discussed but not the frontrunner.
- [agentera], follows the -era verb convention. Consistent with skills. Runner-up: risks blending in with individual skill names since they're all -era verbs, but the verb-as-ecosystem-name has appeal.
**Choice**: **agentera**, "to agent." The ecosystem name follows the same -era verb convention as its skills.
**Reasoning**: The deliberation explored two directions, agent-rooted names and non-agent forge/workshop names. The forge direction produced evocative options but none satisfied all constraints simultaneously. Agenturen was the analytical frontrunner (noun, collective, survives scrutiny), but agentera is the instinctive choice: it follows the -era verb pattern that defines the entire suite's identity, "agent" is universally legible, and -era is the signature suffix. The noun-vs-verb distinction matters less than the user initially thought, the ecosystem IS an action. You don't just install a collection; you agentera your project. The name is both the identity and the invocation.

**Key constraints discovered during deliberation**:
- Must feel like a crew/team, specifically plurality/collective
- Must have proper name energy, character, not a dictionary translation
- Must be pronounceable by non-Swedes and hint at what it is
- Swedish flavor is non-negotiable (matches the -era skill identity)

**Primitive vocabulary convention** (added 2026-03-31): ecosystem primitives use lowercase, single-word terms with personality, matching the register of existing vocabularies (critical/degraded/annoying, firm/provisional/exploratory). New primitives must follow the same convention. ALL_CAPS engineering jargon and corporate headings are rejected in favor of workshop-floor language. Applied to exit signals: `complete/flagged/stuck/waiting`. Section headings: "Exit signals" (peer to "Safety rails"), "Loop guard" (workshop machinery metaphor for runaway prevention).

**Confidence**: firm
**Feeds into**: rename execution across repo, marketplace manifest, README, CLAUDE.md, registry; SPEC.md primitive vocabulary

---

## Decision 10 · 2026-03-31

**Question**: Which patterns from gstack (garrytan/gstack) should agentera adopt, defer, or reject?
**Context**: Inspirera analysis of gstack and its /office-hours skill identified 8 transferable concepts. Each was evaluated against agentera's existing capabilities, VISION.md principles (coherence over features, compounding over convenience, standalone + mesh), and the constraint that artifact sprawl has real cost.

**Alternatives evaluated**:

| # | Concept | Source pattern | Verdict | Reasoning |
|---|---------|---------------|---------|-----------|
| 1 | Forcing questions protocol | office-hours' 6 diagnostic questions | **Defer** | Resonera's Socratic identity is distinct from a product diagnostic. The pattern (don't accept vague answers) is worth absorbing into resonera's pushback principles (#3), but a formal diagnostic mode stretches resonera into two things. |
| 2 | Proactive skill routing system | gstack's shared preamble routing rules | **Reject** | Claude Code's trigger-pattern matching from skill descriptions is the right mechanism for pure-Markdown skills. A separate routing system duplicates this. Hej's dashboard and routing-by-suggestion cover the entry-point case. |
| 3 | Anti-sycophancy / pushback patterns | office-hours' explicit pushback rules and red flags | **Adopt now** | Clear gap. Resonera says "gently challenge assumptions" but doesn't codify pushback techniques. 3-4 explicit principles would sharpen deliberation without changing personality. |
| 4 | Compounding learnings artifact | gstack's /learn with JSONL persistence | **Defer** | PROGRESS.md:Discovered, ISSUES.md, and HEALTH.md:Patterns Observed already capture most of what a learnings system would. Adding LEARNINGS.md overlaps all three without clear unique value. |
| 5 | Design doc as intermediate artifact | office-hours' structured design doc between deliberation and planning | **Reject** | DECISIONS.md already serves this role (Question, Context, Alternatives, Choice, Reasoning). The entry format can stretch for complex decisions. Another artifact in the pipeline adds friction for every decision. |
| 6 | Mode adaptation from user context | office-hours' startup/builder mode detection | **Defer** | Hej already reads PROFILE.md as part of its artifact scan. Explicit mode switching is premature: agentera targets one persona. Revisit if user base diversifies. |
| 7 | Spec review loop for planera | office-hours' iterative accept/modify/reject loop | **Reject** | Decision 1 already established human approval for human-initiated plans. Adding an iterative review loop is ceremony. If the plan needs revision, the user says so. |
| 8 | Three-tier eval (Tier 3 LLM-as-judge) | gstack's Sonnet-scored quality eval | **Defer** | Two-tier system (linter + smoke tests) catches structural and execution issues. LLM-as-judge for quality assessment is useful but not urgent until the skill set stabilizes. |

**Choice**: Adopt #3 (anti-sycophancy pushback patterns for resonera). Defer #1, #4, #6, #8. Reject #2, #5, #7. Hej's dashboard and routing-by-suggestion are preserved, the reject on #2 applies only to a separate routing system layered on top.

**Reasoning**: Most gstack patterns already have partial equivalents in agentera. The delta that justifies immediate action is #3, resonera has the right structure for deliberation but lacks explicit pushback discipline. The deferred items have merit but either overlap existing artifacts or are premature for the current ecosystem size. The rejected items duplicate existing mechanisms (trigger patterns, DECISIONS.md format, planera approval gate).

**Confidence**: firm
**Feeds into**: resonera SKILL.md (pushback patterns)

---

## Decision 11 · 2026-03-31

**Question**: How should agentera express its identity visually across skills and artifacts?
**Context**: The ecosystem has 11 skills and up to 10 state artifacts, all producing plain text output. The verbal identity is strong (Swedish names, workshop-floor vocabulary, direct voice) but the visual output has no distinctive character. A box-drawing logo was created. The goal: visual formatting that elicits a "whoa" reaction while remaining conservative and tasteful.
**Alternatives**:
- [Framed precision] Box-drawing borders framing entire outputs, terminal UI panel style, rejected: too contained, too "UI panel," doesn't breathe
- [Open structure] No outer frames, breathing room, `───` dividers, Unicode markers, chosen: craft is in precision and whitespace, not enclosure
- [Ephemeral only] Visual treatment only in skill output, not artifacts, rejected: user wants full consistency where artifacts and output look like the same system
- [Custom format replacing Markdown] Replace `##` headers with `───` dividers in artifacts, rejected: artifacts must stay valid Markdown for portability
**Choice**: Open-structure visual identity system layered on standard Markdown. Full Unicode vocabulary with per-skill glyphs, semantic status/severity/confidence tokens, and the agentera logo at key moments. Section dividers (`─── label ───`) as the primary structural element. Hej dashboard as the reference composition.
**Reasoning**: The key insight is that craft and density are the same move, every visual element must carry semantic weight. The vocabulary divides into three categories: (1) skill identity glyphs, one unique geometric Unicode character per skill, appearing in section headers as subtle signatures; (2) semantic tokens, status, severity, confidence, and trends expressed as single characters with escalating visual weight; (3) structural tokens, section dividers, bullets, separators, and progress bars. The logo uses box-drawing characters exclusively, keeping it visually distinct from everything else. Artifacts stay valid Markdown with the visual vocabulary layered within sections. The hej dashboard demonstrates the composition pattern: logo at top, data grid with skill glyphs as markers, narrative summary, severity-marked attention items, and target-skill-glyph routing.

### Visual Token Vocabulary

| Category | Token | Code | Meaning |
|----------|-------|------|---------|
| hej | ⌂ | U+2302 | home base |
| realisera | ⧉ | U+29C9 | joined building blocks |
| inspektera | ⛶ | U+26F6 | viewfinder frame |
| resonera | ❈ | U+2748 | spark of insight |
| planera | ≡ | U+2261 | structured layers |
| visionera | ⛥ | U+26E5 | guiding star |
| optimera | ⎘ | U+2398 | measurement |
| dokumentera | ▤ | U+25A4 | text on page |
| profilera | ♾ | U+267E | permanent mark |
| inspirera | ⬚ | U+2B1A | frame to fill |
| visualisera | ◰ | U+25F0 | design grid |
| Status: complete | ■ | U+25A0 | filled square |
| Status: in-progress | ▣ | U+25A3 | nested square |
| Status: open | □ | U+25A1 | empty square |
| Status: blocked | ▨ | U+25A8 | crosshatch square |
| Severity: critical | ⇶ | U+21F6 | triple arrow |
| Severity: degraded | ⇉ | U+21C9 | double arrow |
| Severity: annoying | ⇢ | U+21E2 | dashed arrow |
| Confidence: firm | ━ | U+2501 | heavy line |
| Confidence: provisional | ─ | U+2500 | normal line |
| Confidence: exploratory | ┄ | U+2504 | dashed line |
| Trend: improving | ⮉ | U+2B89 | up arrow |
| Trend: degrading | ⮋ | U+2B8B | down arrow |

### Composition Rules

| Rule | Detail |
|------|--------|
| Logo placement | Key moments only (hej dashboard, major completions) |
| Skill introduction | `─── glyph skillname · context ───` |
| Section headers | Clean labels, no glyphs |
| Breathing room | Blank lines between sections |
| Narrative position | Summaries close sections, not open them |
| Markdown layering | All artifacts stay valid Markdown; visual tokens layer within |
| Box-drawing scope | Logo only: no frames anywhere else |

### Hej Dashboard Reference Composition

```
┌─┐┌─┐┌─┐┌┐┌┌┬┐┌─┐┬─┐┌─┐
├─┤│ ┬├┤ │││ │ ├┤ ├┬┘├─┤
┴ ┴└─┘└─┘┘└┘ ┴ └─┘┴└─┴ ┴

─── status ─────────────────────────────

  ⛶ health    ⮉ B+ (coupling: C)
  ⇶ issues    2 critical · 1 degraded
  ≡ plan      ██████▓▓░░ 6/10
  ⎘ optim     latency 230ms → 200ms
  ♾ profile   loaded

  Cycle 5 shipped auth middleware and rate
  limiting. Health improved but coupling drags.

─── attention ──────────────────────────

  ⇶ 2 critical issues need attention
  ⇉ HEALTH.md stale (18 days)

─── next ───────────────────────────────

  suggested → ⛶ /inspektera (health stale)
```

**Confidence**: firm
**Feeds into**: DESIGN.md (visual token system)

---

## Decision 12 · 2026-03-31

**Question**: How should version management work across the agentera ecosystem, both for agentera's own skill versions and for target projects agentera runs in?
**Context**: No skill currently owns version bumping. Two version mismatches (inspektera and inspirera) existed between plugin.json and marketplace.json with nobody catching them. CLAUDE.md describes the mechanics ("update both registry.json and plugin.json") but no skill triggers, detects, or executes bumps. The visual identity rollout changed all 11 SKILL.md files without any version bumps.
**Alternatives**:
- [New skill for version management], rejected: versioning is a convention enforced by existing skills, not a distinct workflow
- [Realisera auto-bumps at commit time], rejected: too granular, multi-commit changes would produce multiple bumps
- [Plan completion = version boundary], rejected: plans are a workflow tool, not a release boundary. A typo-fix plan shouldn't trigger a bump.
- [Strict semver default from commit types], rejected: too prescriptive. Different projects have different versioning philosophies.
- [Realisera + inspektera defense-in-depth], evolved into the final design
**Choice**: Project-driven versioning convention via DOCS.md, with three-layer enforcement across existing skills. No default imposed, if the project doesn't specify a versioning policy, no auto-bumping happens.
**Reasoning**: The key insight is that versioning is a *project convention*, not an agentera convention. The skills are guests in someone else's codebase (Decision 4 principle). DOCS.md already captures project conventions (doc structure, style defaults, artifact paths), versioning conventions belong there too. The three-layer enforcement follows the "detect → plan → execute" pattern already established: dokumentera detects conventions, planera evaluates scope, realisera executes, inspektera catches drift.

### Design

**DOCS.md conventions** (dokumentera survey): captures version file locations, semver policy, changelog location, release tooling. If the project has existing conventions, dokumentera records them. If none exist, DOCS.md says nothing about versioning.

**Three-layer enforcement**:

| Layer | Skill | Role | When |
|-------|-------|------|------|
| Proactive | planera | Includes a version bump task when planned scope warrants it (per DOCS.md policy) | During planning |
| Reactive | inspektera | Flags unbumped significant changes as audit findings | During health audits |
| Execution | realisera | Performs mechanical bump: reads DOCS.md for which files to update and semver level | When executing a bump task or picking up an inspektera finding |

**No convention = no auto-bumping**: If DOCS.md has no versioning section, skills don't attempt version bumps. The user can always request one explicitly or ask dokumentera to establish a convention.

**Same pattern for all projects**: agentera's 11+1 versioned files are just more version entries in DOCS.md conventions. Target projects with a single version file use the same mechanism. The skills don't need special logic per project type.

**Confidence**: ━ firm
**Feeds into**: DOCS.md template (versioning conventions), planera/inspektera/realisera SKILL.md updates

---

## Decision 13 · 2026-04-01

**Question**: Should agentera artifacts be consolidated out of the project root, and should their naming adopt common conventions?
**Context**: The ecosystem produces up to 10 state artifacts, all placed at the project root by default. This creates visual clutter (8+ unfamiliar .md files alongside README and CLAUDE.md) and makes it hard to gitignore artifacts for projects that want them private. Decision 4 established DOCS.md artifact mapping for per-project overrides, but the default layout remained root-only. Additionally, names like ISSUES.md and PROGRESS.md are agentera-specific when universally recognized equivalents (TODO.md, CHANGELOG.md) exist.
**Alternatives**:
- [Status quo, root placement with DOCS.md overrides], rejected: default is cluttered, requires per-project config to fix
- [Everything in .agentera/], rejected: project-facing documentation (vision, tasks, changelog) should be visible to all contributors
- [Rename only, no relocation], rejected: root pollution is half the problem
- [Split but keep agentera names], rejected: if content adapts to conventional formats, names should match
**Choice**: Three conventional files at project root, eight operational files in `.agentera/`. Content adapts to match conventional expectations.

**Reasoning**: The artifacts are genuinely dual-purpose (Decision 4), but they aren't uniformly so. TODO.md and CHANGELOG.md serve the project's contributors, any developer recognizes them. HEALTH.md, EXPERIMENTS.md, PROGRESS.md serve the skills' operational needs. Different audiences deserve different locations. The dot-prefix convention (`.agentera/`) gives projects a one-line gitignore for operational state while keeping project knowledge visible. Adopting conventional names means adopting conventional formats, a TODO.md with severity levels and audit findings would confuse more than help. DOCS.md stays as an optional override for projects that want non-default artifact locations.

### Design

**Root (3 files, universally recognized)**:

| File | Was | Format |
|------|-----|--------|
| TODO.md | ISSUES.md | Conventional TODO: actionable items with priority tags, checkboxes |
| CHANGELOG.md | PROGRESS.md | Keep-a-changelog style: version-level Added/Changed/Fixed summaries |
| VISION.md | VISION.md | Unchanged: project north star |

**.agentera/ (8 files + archive, operational state)**:

| File | Was | Notes |
|------|-----|-------|
| PROGRESS.md | PROGRESS.md | Cycle-by-cycle operational log (relocated, unchanged format) |
| DECISIONS.md | DECISIONS.md | Reasoning trail (relocated: name is agentera-specific) |
| PLAN.md | PLAN.md | Active work plan (relocated) |
| HEALTH.md | HEALTH.md | Audit grades (relocated) |
| OBJECTIVE.md | OBJECTIVE.md | Optimization target (relocated) |
| EXPERIMENTS.md | EXPERIMENTS.md | Experiment log (relocated) |
| DESIGN.md | DESIGN.md | Visual identity (relocated) |
| DOCS.md | DOCS.md | Doc index + conventions + optional artifact mapping override (relocated) |
| archive/ | .planera/archive/ | Completed plans (.planera/ absorbed) |

**Dual-write for realisera**: writes CHANGELOG.md (public, version-level summary) AND `.agentera/PROGRESS.md` (operational cycle detail). Two audiences, two files.

**Discovery convention**: skills check `.agentera/DOCS.md` for artifact mapping overrides. If absent, use the default convention (3 root + 8 in `.agentera/`). DOCS.md mapping is optional, the deterministic layout is the default.

**Gitignore**: `.agentera/` hides all operational state. Add TODO.md, CHANGELOG.md, VISION.md individually if the project wants full privacy.

## Decision 14 · 2026-04-02

**Question**: How should the ecosystem's user-facing messages be formatted?
**Context**: The eleven skills had inconsistent formatting for session openers, exit signals, step markers, and mid-session chrome. Instruction phrasing varied across SKILL.md files ("Output opens with:" vs "Each cycle opens with:"). Exit signals had no standard visual format. Long-running skills showed no progress between steps. Clinical verb choices (synthesize, hypothesize) clashed with the ecosystem's intended warmth.
**Alternatives**:
- [Status quo: freeform prose for exits, no step markers], rejected: no visual consistency across 11 skills
- [Heavy chrome: frames, progress bars, metadata blocks on every message], rejected: overweight for most contexts
- [Minimal tokens: inline status words, no dividers], rejected: too light, no ecosystem cohesion
**Choice**: Three-tier divider hierarchy with templated exit signals, step markers for long-running skills, and warm bare-verb step names.

**Reasoning**: The opener pattern was already strong. Extending it to exits (symmetric bookend) and steps (lighter 2-dash divider) creates a visual hierarchy that communicates structure without cluttering. Templated exits (status line + bullet details) solve the biggest gap: flagged/stuck/waiting statuses had no standard way to surface concerns. Step markers with N/M counts give users progress awareness during 5-8 step workflows. Keeping original verb names except for two clinical outliers (synthesize → distill, hypothesize → propose) preserves vocabulary stability while fixing the worst offenders.

### Design

**Divider hierarchy**:

| Level | Pattern | Used for |
|-------|---------|----------|
| Skill boundary | `─── glyph skill · context ───` | Session opener, exit signal |
| Step boundary | `── step N/M: verb` | Workflow progress |
| Container | `── label` | Scratchpad, other mid-session blocks |

**Exit signal template**:

| Status | Format |
|--------|--------|
| complete | Divider + one summary sentence |
| flagged | Divider + summary + `▸` concern bullets |
| stuck | Divider + summary + `▸` blocker bullets |
| waiting | Divider + summary + `▸` need bullets |

**Step name changes**: synthesize → distill (inspektera), hypothesize → propose (optimera)

**Style rules**: colons over em-dashes, labeled metadata, generous newlines

**Confidence**: firm
**Feeds into**: all 11 SKILL.md files, SPEC.md Section 12

**Confidence**: ━ firm
**Feeds into**: All 11 SKILL.md files, SPEC.md, artifact templates, linter, DOCS.md template

---

## Decision 15 · 2026-04-02

**Question**: How should TODO.md categorize issues beyond bug-severity, and should issues carry type tags?
**Context**: The inspirera analysis of harness filed four feature issues (ISS-21 through ISS-24) into Degraded and Annoying. These are new capabilities, not broken things, the bug-severity framing (Critical = broken, Degraded = works poorly, Annoying = cosmetic friction) doesn't accommodate features. Additionally, the lack of issue type metadata limits changelog generation and analytics.
**Alternatives**:
- [Severity-only, stretch definitions], rejected: forces features into problem language
- [Separate "Features" section alongside severity], rejected: splits by type instead of priority
- [Two-axis system (type × priority)], rejected: too much taxonomy for a working document
- [Rename headers to priority language], rejected: existing names already read as priority tiers
**Choice**: Four-tier priority system with type tags. Add → Normal (U+2192, Arrows block) between Degraded and Annoying. Keep existing header names. Add conventional commit type tags per issue.

**Reasoning**: The three tiers were functioning as priority, not severity, a high-impact feature belongs in ⇉ Degraded alongside a degradation. The missing tier was "default/standard work" that isn't degraded but isn't trivially annoying either. → Normal fills this. Type tags earn their keep through three concrete payoffs: triage (batching fixes vs features), changelog generation (dokumentera can auto-categorize), and analytics (feature/fix ratio tracking). Full conventional commit vocabulary (feat, fix, docs, refactor, chore, test, perf) eliminates translation between TODO and commits.

### Design

**Priority tiers** (all from Unicode Arrows block U+2190–U+21FF):

| Tier | Symbol | Name |
|------|--------|------|
| 1 | ⇶ | Critical |
| 2 | ⇉ | Degraded |
| 3 | → | Normal |
| 4 | ⇢ | Annoying |

**Issue format**: `- [ ] ISS-N: [type] Description, details`

**Type tags**: feat, fix, docs, refactor, chore, test, perf (matching conventional commits)

**Confidence**: firm
**Feeds into**: TODO.md, SPEC.md, TODO-template.md

## Decision 16 · 2026-04-02

**Question**: How should the ecosystem's voice and tone work across all 11 skills?
**Context**: An inspektera-style tone audit revealed a systemic split: three skills (resonera, visionera, visualisera) have distinct personality sections and feel like teammates; the rest (hej, planera, inspektera, optimera, profilera, dokumentera, inspirera, realisera) read like monitoring dashboards or workflow engines. The VISION.md promises "a competent team at your back" but half the skills feel like a different product. Hej's returning-mode dashboard, the first thing a user sees, is pure metrics with no warmth.
**Alternatives**:
- [Distinct personalities per skill], rejected: fragments the team into different-sounding individuals
- [Add personality sections to every skill], rejected: mechanical fix; if the vision is strong enough, voice emerges naturally from development
- [Skills only, no vision change], rejected: the voice standard needs a source of truth
- [Ecosystem spec as voice home], rejected: voice is identity, not a shared primitive
**Choice**: Define a single "sharp colleague" voice in VISION.md. One voice, many hats, the difference between skills is expertise, not personality. Data-dense outputs (dashboards, audit findings, plans) use a "dashboard + human frame" pattern: structured data stays for scannability, bookended by conversational opening and summary.
**Reasoning**: The vision already defines aesthetics and identity. Voice belongs there because skills developed *in alignment with the vision* should naturally adopt the right tone, adding personality sections to each skill treats the symptom. "Sharp colleague" (casual, opinionated, occasionally playful, pushes back) was chosen over "workshop-floor" (too terse) and "quiet confidence" (warmth through rigor alone is too cold). The dashboard + human frame pattern resolves the tension between scannability and warmth: the data is evidence, the voice is interpretation.
**Confidence**: firm
**Feeds into**: VISION.md voice section, SPEC.md narration section

## Decision 17 · 2026-04-02

**Question**: How should skills narrate their process between structural markers?
**Context**: ISS-26 converged personality sections and output framing to the "sharp colleague" voice (Decision 16), but structural narration, mode announcements ("Returning mode"), transition messages ("Starting /[skill]..."), and ad-hoc process narration ("Reading artifacts..."), stayed mechanical. The first thing a returning user sees is "Returning mode" instead of something that sounds like a colleague. 36+ narration points across 11 skills, of which ~20 are in scope (step markers and structural dividers are functional and stay).
**Alternatives**:
- [Warm up all narration points individually], rejected: 36 one-offs with no unifying principle
- [Principle only, no SKILL.md changes], rejected: skills need concrete examples to hit the register
- [Exact scripts per narration point], rejected: fixed conversational text becomes a tic with repetition
- [Minimize narration, let markers carry it], rejected: silence during long operations is worse than mechanical narration
**Choice**: Narration voice principle in the spec plus riffable example lines in each SKILL.md. Action narration register: brief, casual, tells you what's happening without explaining internals. Examples to riff on, not scripts, agent varies naturally within the register.
**Reasoning**: The sharp colleague doesn't announce subroutines ("Entering Returning mode"); she tells you what she's doing ("Pulling up the latest..."). Scripts become tics; examples set a register. Structural markers and step markers are functional (you scan them) so they stay unchanged. The narration between them is conversational (you read it) so it needs the same voice treatment that Decision 16 gave to personality sections and output framing. Principle in the spec ensures consistency; examples in SKILL.md demonstrate the register for each skill's specific narration points.
**Confidence**: firm
**Feeds into**: SPEC.md (new narration voice section), ~5 SKILL.md files (hej, visionera, profilera, visualisera, + ad-hoc narration guidance for all)
**Feeds into**: VISION.md (Identity section), skill refinement across all 11 SKILL.md files

## Decision 18 · 2026-04-02

**Question**: How should the ecosystem handle em-dashes and double dashes in all text?
**Context**: The decision profile has a high-confidence, stable entry (since Sep 2025) banning em-dashes because they signal AI-generated text. Decision 14 only enforced this for exit signal label separators (colons instead). The rest of the ecosystem (SKILL.md prose, the spec, templates, agent output) continued using em-dashes freely. The profile also incorrectly listed double dashes (--) as an acceptable replacement.
**Alternatives**:
- [Ban in agent output only, allow in SKILL.md source], rejected: inconsistent standard
- [Mechanical find-and-replace with double dashes], rejected: double dashes are equally a crutch
- [Context-sensitive replacement (colons for labels, commas/periods for prose)], rejected: restructuring is better
**Choice**: Full ban on em-dashes AND double dashes across the entire ecosystem. Replacement hierarchy: restructure the sentence first; fall back to commas, periods, or colons only when restructuring reads worse. Applies to SKILL.md source, the spec, templates, and all agent-generated output.
**Reasoning**: The goal is better prose, not a punctuation swap. Em-dashes and double dashes are a crutch for sentences that should be restructured. Removing them forces cleaner writing. The profile entry that listed double dashes as acceptable was wrong and needs correction.
**Confidence**: firm
**Feeds into**: SPEC.md (punctuation convention), all 11 SKILL.md files, PROFILE.md correction

## Decision 19 · 2026-04-02

**Question**: How should the ecosystem handle line-breaks in prose text?
**Context**: No rule existed for line-wrapping. Agent output mixed hard-wrapped lines (inside code blocks at ~70 chars) with free-flowing prose, creating visible inconsistency. SKILL.md source files also hard-wrapped paragraphs at ~90 chars. Word-count caps governed brevity but not wrapping.
**Alternatives**:
- [Hard wrap at a fixed column (80 or 100 chars) everywhere], rejected: looks wrong at non-matching terminal widths
- [Semantic line breaks (one sentence per line)], rejected: creates inconsistency when mixed with free flow
- [No hard wraps, let terminal handle it], chosen
**Choice**: No hard wraps in prose paragraphs. One paragraph = one line. Break only for paragraph boundaries, section boundaries, or list items. Terminal handles wrapping. Structured content (code blocks, lists, tables, frontmatter) keeps its inherent line breaks.
**Reasoning**: The problem was consistency, not readability. Mixing two wrapping approaches in the same response looked arbitrary. Removing hard wraps entirely eliminates the inconsistency. The tradeoff (whole-paragraph diffs) is acceptable for the consistency gain.
**Confidence**: firm
**Feeds into**: SPEC.md (line-break convention), all 11 SKILL.md files

## Decision 20 · 2026-04-02

**Question**: Should the agentera ecosystem add an orchestration skill, and what should it own?
**Context**: ISS-21 (separated evaluator), ISS-22 (headless runner), ISS-23 (AC verification), ISS-24 (retry caps) all pointed toward a missing orchestration layer. Realisera owns single-cycle execution but depends on `/loop` for recurrence. The ecosystem has no conductor that chains skills together. Research covered Claude Code's agent primitives (coordinator mode, worktrees, fork subagents, teams/swarm), lira's conductor/worker model (fixed pipeline, quality gates, task decomposition, SQLite state), and seven external frameworks (OpenAI Agents SDK, LangGraph, CrewAI, AutoGen, Mastra, PydanticAI, Google A2A). Also examined opencode-orchestrator and Auto-Claude from local repos.
**Alternatives**:
- [Orkestrera dispatches only to realisera], rejected: limits the conductor to implementation work
- [Orkestrera dispatches directly to Sonnet agents], rejected: duplicates realisera's dispatch step, skills lose their autonomy
- [Orkestrera as objective-driven with internal decomposition], rejected: duplicates planera's role
- [No new skill; add evaluator and runner to realisera], rejected: conflates orchestration with execution
**Choice**: Orkestrera as a skill-agnostic meta-orchestrator. Thin conductor, fat workers. Dispatches any skill as a subagent based on task semantics.
**Reasoning**: The core insight is separation of concerns between orchestration and execution. Lira's conductor/worker split (conductor owns state and dispatch, workers execute in isolation) is the right pattern, but implemented as a skill (SKILL.md) rather than infrastructure. The conductor follows a deterministic protocol, keeping its context lean; creativity happens in the dispatched skills. Each dispatched skill runs as a subagent with its own context window, preventing conductor context pollution. Key design decisions: (1) plan-required, delegates to inspirera/planera to create one if absent, (2) inspektera as evaluator (GAN pattern using existing skill), (3) multi-cycle single session with lean conductor, (4) sequential task dispatch (realisera parallelizes internally), (5) retry with inspektera findings, max 2, then block and skip, (6) reuses existing artifacts (PLAN.md, PROGRESS.md, HEALTH.md). Supersedes ISS-21, ISS-22, ISS-23, ISS-24.
**Confidence**: firm
**Feeds into**: new skill (skills/orkestrera/SKILL.md), TODO.md (supersede ISS-21, ISS-22, ISS-23, ISS-24), SPEC.md (12th skill primitives)

### Design Decisions Summary

| Aspect | Decision |
|--------|----------|
| Dispatch model | Skill-agnostic: orkestrera infers which skill handles each task |
| Input model | Plan-required: no PLAN.md triggers inspirera → planera chain |
| Evaluation | Inspektera as discriminator, dispatched after each task |
| Failure handling | Retry with inspektera findings, max 2, then block + skip to next |
| Recurrence | Multi-cycle single session, not /loop. Stops on: plan complete + clean health, budget, or user interrupt |
| Concurrency | Sequential task dispatch. Realisera keeps internal parallelism |
| State artifacts | Reuses PLAN.md, PROGRESS.md, HEALTH.md. No new artifact |
| Conductor model | Thin: dispatch + receive results + log. Never reads code, never runs tests |
| Skill independence | All skills stay as-is. Orkestrera passes task prompts; skills adapt naturally |
| Outer loop | Plan complete → inspektera health check → inspirera gap analysis → planera next plan → continue |

## Decision 21 · 2026-04-02

**Question**: How should autonomous plans constrain test generation to prevent unbounded output?
**Context**: The first orkestrera-driven test plan (ISS-31) produced 123 new tests in one cycle (48 to 171). The acceptance criteria said "test all 13 check functions with pass/fail/edge cases" without a volume constraint. Each agent wrote 3-7 tests per unit, producing ~6 tests per testable function. Half would have sufficed for a first pass. The root cause: agents optimize for literal acceptance criteria. Without a budget, "comprehensive" is the default.
**Alternatives**:
- [No constraint; trust agents to be proportional], rejected: agents default to comprehensive without explicit guidance
- [Hard cap (e.g., max 50 tests per plan)], rejected: arbitrary numbers ignore context; a large refactor legitimately needs more tests than a config change
- [Proportionality rule in acceptance criteria], chosen
**Choice**: Test tasks in plans must include a proportionality target. Default rule: one pass test + one fail test per unit under test. Edge case tests only for units with complex parsing, regex, or branching logic. Planera encodes this as an AC constraint; inspektera evaluates against it.
**Reasoning**: The problem is not that agents write tests badly; each test was correct and useful. The problem is that unbounded scope compounds across tasks. Three test tasks each producing 40 tests is 120, when 50 total would have covered the critical paths. The fix belongs in the plan (where scope is set), not in the agent (where scope is executed). Proportionality as an AC constraint makes it verifiable without adding new machinery.
**Confidence**: firm
**Feeds into**: SPEC.md (proportionality convention for test tasks), planera SKILL.md (test budget in AC guidance), inspektera SKILL.md (evaluate test proportionality)

## Decision 22 · 2026-04-03

**Question**: Should ISS-19 phase tracking be enforced across skills, and how should the ecosystem detect stale artifacts?
**Context**: ISS-19 spec (SPEC.md Section 17) defines five phases with transitions. The remaining work was SKILL.md integration: each skill reading phase and flagging out-of-order runs. Deliberation revealed that orkestrera's artifact-based routing already enforces order implicitly (no plan → bootstrap one), and that standalone skills must stay free from phase constraints. The actual concern was stale artifacts causing wrong routing decisions, not missing transition validation.
**Alternatives**:
- [Full phase enforcement across 12 skills], rejected: breaks standalone operation, redundant with artifact-based routing
- [Soft warnings in every skill], rejected: warning fatigue, still redundant
- [Orkestrera-only phase validation], rejected: artifact presence already serves this function
- [Fixed time threshold (14 days)], rejected: too coarse for high-velocity projects (77 cycles in 5 days)
- [Fixed cycle count threshold], rejected: doesn't account for plan scope
- [Plan-relative staleness detection], chosen
**Choice**: Drop phase enforcement. Add plan-relative staleness detection to orkestrera: after each plan cycle, flag plan-relevant artifacts that dispatched skills should have updated but didn't since plan start. Phase spec (Section 17) stays as ecosystem documentation. No SKILL.md changes needed.
**Reasoning**: Orkestrera already enforces ordering via artifact presence. Phase labels add a second state layer that could drift just as easily as the artifacts themselves. The real risk is stale artifacts misleading routing decisions. Plan-relative detection ties the clock to meaningful project milestones rather than arbitrary time or cycle counts. Checking only plan-relevant artifacts avoids false positives on slow-changing artifacts like VISION.md.
**Confidence**: firm
**Feeds into**: TODO.md (close ISS-19, open staleness detection issue), orkestrera SKILL.md (plan-relative staleness check)

## Decision 23 · 2026-04-03

**Question**: Where should session-to-session state live: new SESSION.md artifact, extend PROGRESS.md, or infrastructure dotfile?
**Context**: The hooks plan introduces a Stop hook that persists a session narrative (which skills ran, in what order) for the SessionStart hook to preload. The critic flagged that PROGRESS.md has a cycle entry format owned by realisera; writing session bookmarks there violates the producer contract. Three options explored: SESSION.md (new artifact), extending PROGRESS.md with a second entry type, or a non-artifact dotfile (.agentera/.session).
**Alternatives**:
- [SESSION.md as artifact #12], chosen: honest about what it is, properly documented in ecosystem spec
- [Extend PROGRESS.md with session entries], rejected: mixing producers muddies PROGRESS.md's clarity as a single-producer, single-format artifact
- [Non-artifact dotfile .agentera/.session], rejected: if it's ecosystem state, it should be a real artifact, not infrastructure hiding below the protocol
**Choice**: SESSION.md as the 12th ecosystem artifact. Produced by the Stop hook, consumed by SessionStart hook and hej. Context loader improvements make the additional artifact weight manageable.
**Reasoning**: The initial resistance was about cognitive and context weight of a 12th artifact, not architectural principle. Extending PROGRESS.md was rejected because its value comes from being single-producer, single-format. The dotfile option was a pragmatic workaround that dodged the real question. With improved context loading, the honest choice wins: session state is ecosystem state.
**Confidence**: firm
**Feeds into**: PLAN.md (hooks infrastructure), SPEC.md (artifact table)

## Decision 24 · 2026-04-03

**Question**: Should the PostToolUse validation hook coexist with the git pre-commit hook, or replace it?
**Context**: The hooks plan introduced PostToolUse for real-time artifact validation alongside the existing .githooks/pre-commit (ecosystem linter + context freshness). The plan said they have different concerns: PostToolUse validates individual artifact structure, pre-commit validates cross-skill alignment. But two validation mechanisms for overlapping file sets is messy and will drift.
**Alternatives**:
- [PostToolUse replaces pre-commit entirely], chosen: one validation path, cleaner
- [Coexistence with different concerns], rejected: two mechanisms is complexity that accretes; someone adds a check to one and forgets the other
- [PostToolUse primary, pre-commit as thin gate], rejected: still two mechanisms, just thinner
**Choice**: PostToolUse absorbs all validation: ecosystem linter, context freshness, and artifact structure. The git pre-commit hook is removed. The manual-edit gap (edits outside Claude Code) is accepted until CI gating (ISS-31) lands.
**Reasoning**: Agentera is a Claude Code skill ecosystem developed through Claude Code. The pre-commit was always a stopgap. PostToolUse provides faster feedback (edit-time vs commit-time) and covers the same checks. Two mechanisms for validation will drift. One mechanism is cleaner, and CI gating closes the remaining gap.
**Confidence**: firm
**Feeds into**: PLAN.md (hooks infrastructure), .githooks/pre-commit (removal)

## Decision 25 · 2026-04-03

**Question**: Should agentera's North Star evolve from "a solo founder installs an engineering team" to a spec-centric framing?
**Context**: 80 cycles have proven the compounding model works. The current vision is user-centric (one person, one problem, one transformation). But the domain has moved: Agent Skills is an open standard adopted by multiple platforms, 150+ skills exist in the ecosystem, multi-agent orchestration is mainstream. The Direction section already says "the spec becomes the gravity well," suggesting the North Star was lagging behind the project's actual ambition.
**Alternatives**:
- [Keep user-centric North Star, update supporting paragraphs], rejected: the frame has been outgrown; both audience ("solo founder") and transformation ("installs a team") feel past tense
- [Compounding intelligence as North Star ("the system that gets smarter")], rejected: describes a property of the system, not the ambition
- [Spec as North Star with adoption arc in Direction], chosen
**Choice**: North Star becomes "The open standard for turning AI agents into engineering teams." Cool, declarative one-liner. Supporting paragraphs carry the emotional weight: two-layer problem (individual amnesia + ecosystem fragmentation), the insight (artifact contracts = memory, shared primitives = common language), the ambition (the spec as industry gravity well). Solo founder persona stays as the human grounding (the why behind the spec). Direction becomes the adoption arc: reference implementation, third-party skills, platform adoption, industry standard.
**Reasoning**: The key insight is that the spec is the product, not the twelve skills. The skills are the reference implementation that proves the spec works. This reframes agentera from a tool (install skills, get a team) to a protocol (agents that speak this language become teams). The solo founder persona stays because the spec exists to solve her problem, not as abstract standards work. The problem statement gains a second layer: amnesia is the individual problem, fragmentation is the ecosystem problem. The spec solves both.
**Confidence**: firm
**Feeds into**: VISION.md (North Star, Direction, supporting paragraphs)

## Decision 23 · 2026-04-10

**Question**: Should the terminology for the ecosystem spec and per-skill context files be renamed for clarity and cohesion?
**Context**: Two filenames (`SPEC.md` and `contract.md`) use a double-word "ecosystem-" prefix that is redundant (agentera IS the ecosystem), mechanically named (the context file is spec excerpts, not "context" in the operational sense), and inconsistent (prose uses "the spec" while filenames use "the spec"). The external AI community (Google Workspace CLI, Justin Poehnelt's agent DX article) uses CONTEXT.md for runtime agent instructions, creating collision risk. The rename cascades into 12 SKILL.md files, 2 Python scripts, the linter, tests, HTML comment conventions, and prose throughout.
**Alternatives**:
- [Keep current names], rejected: "ecosystem-context" is opaque, two-word, and collides with emerging CONTEXT.md convention for runtime agent instructions. The file contains binding spec excerpts, not operational context.
- [Rename to context.md only], rejected: collision with the emerging agent community's CONTEXT.md convention (Google Workspace CLI, Justin Poehnelt). CONTEXT.md means "runtime instructions for agents" externally.
- [Rename spec-only], rejected: renaming the spec without renaming the per-skill excerpts misses the relationship clarity opportunity
**Choice**: `SPEC.md` (root, uppercase per artifact convention) and `contract.md` (per skill in references/, lowercase per reference file convention). Drop the "ecosystem-" prefix from all filenames, headers, script names, and prose.
**Reasoning**: The contract is a binding excerpt: the skill MUST follow these rules. "Contract" carries the obligation that "context" lacks. The pair is clean: the spec defines the rules, your contract is your binding slice. Dropping "ecosystem-" from everywhere eliminates redundancy (agentera IS the ecosystem). Upper/lower case split follows the existing convention: root artifacts are UPPERCASE (VISION.md, TODO.md), skill reference files are lowercase (harness-guide.md, audit-commands.md). The rename makes the spec a first-class root artifact rather than hiding it in references/.
**Confidence**: firm
**Feeds into**: PLAN.md (Platform Portability plan)

## Decision 26 · 2026-04-11

**Question**: How to implement Section 21's session corpus contract to close the gap between spec and extraction pipeline
**Context**: Section 21 defines four normalized record types (instruction_document, history_prompt, conversation_turn, project_config_signal) with provenance metadata, but extract_all.py bypasses the contract entirely, going from Claude Code JSONL internals to four ad-hoc intermediate JSON files. The spec exists; the implementation does not. Users may also switch between runtimes (Claude Code, OpenCode) between sessions, so the corpus must be runtime-agnostic.
**Alternatives**:
- [Separate adapter layer] new script translates extract_all.py output into Section 21 format, rejected: unnecessary indirection, two scripts maintaining the same knowledge
- [Runtime-specific adapters] each runtime ships its own adapter, profilera just expects corpus.json, rejected: user may switch runtimes between sessions, corpus must aggregate across all available runtimes
- [Current runtime only] detect and extract from whichever runtime is active, rejected: decision patterns are runtime-agnostic, older data from a different runtime is still valid signal
- [Four files, normalized schemas] keep the four-file split but apply Section 21 schemas, rejected: unnecessary complexity when a single file with source_kind filtering is cleaner
**Choice**: Refactor extract_all.py into a multi-runtime corpus builder that probes for available runtime data, extracts from all detected runtimes, and produces a single self-describing corpus.json with a metadata envelope and normalized Section 21 records. Adapter self-validates. Section 21 updated to specify the envelope format.
**Reasoning**: Runtime is provenance metadata, not a freshness signal. A user's decision patterns are the same regardless of which tool produced the record. Staleness is time-based, not runtime-based. The 1M context window is sufficient for multi-runtime data, and profilera runs rarely enough that the marginal token cost is justified by a more complete picture. Compression of extracted data before LLM consumption is a future optimization. Self-validation at the adapter catches malformed output at the source rather than letting it propagate to profilera.
**Confidence**: firm
**Feeds into**: TODO.md (ISS-37)

## Decision 27 · 2026-04-11

**Question**: Where should PROFILE.md and profilera's generated artifacts live by default, and how should runtime adapters provide path overrides?
**Context**: PROFILE.md was stored at `~/.claude/profile/PROFILE.md`, coupling it to Claude Code's config directory. This triggers permission prompts when skills read it, doesn't work on Windows, and treats the profile as Claude Code's data rather than agentera's. The `PROFILERA_PROFILE_DIR` env var was added (Decision 26 implementation) but nothing sets it automatically.
**Alternatives**:
- [Keep ~/.claude/profile/ default] other runtimes override via env var, rejected: profile belongs to agentera not Claude Code, triggers permission prompts, not cross-platform
- [Skill derives path from runtime detection] skill detects runtime and maps to path internally, rejected: breaks separation of concerns; the adapter should own path knowledge
- [Shared config file mapping] a .agentera/runtime.json maps runtime to paths, rejected: unnecessary indirection for a single path
- [General pattern for all Section 20 capabilities] every capability gets a PROFILERA_* env var, rejected: profile-path is the only capability that maps to a filesystem directory
**Choice**: Default to XDG-standard data directory: `$XDG_DATA_HOME/agentera/` on Linux (default: `~/.local/share/agentera/`), `~/Library/Application Support/agentera/` on macOS, `%APPDATA%/agentera/` on Windows. Adapter plugins set `PROFILERA_PROFILE_DIR` at init to override. Auto-migrate existing profiles from `~/.claude/profile/` on first run. stdlib-only platform detection.
**Reasoning**: The profile is agentera's data, not a runtime's. XDG is the standard for user application data on Linux; macOS and Windows have their own equivalents. Moving to an agentera-owned directory eliminates permission friction, enables cross-platform support, and removes the implicit Claude Code coupling. Auto-migration ensures existing users don't lose their profile. The env var remains the adapter injection point (set at plugin init), keeping the skill-adapter separation clean. Only profile-path needs this treatment; other Section 20 capabilities are about runtime mechanisms, not filesystem paths.
**Confidence**: firm
**Feeds into**: TODO.md

## Decision 28 · 2026-04-11

**Question**: How should optimera handle measurement archetypes that go beyond thin command-wrapper harnesses, and what should the first such reference look like?
**Context**: A /inspirera analysis of leda's benchmark suite proposed shipping `scripts/benchmark_skill.sh` at agentera's repo root plus a thin `.optimera/harness` wrapper (leda's own pattern). Two things didn't sit right: (1) that shape imposes leda-style infrastructure where optimera's philosophy says the harness is bespoke per project, and (2) a sketched `--repo-size` flag encodes fake precision because users can mislabel the target. A broader question surfaced — should optimera's brainstorm route to archetypes explicitly, or keep its conversation-driven model? Optimera's existing reference library (`test-pass-rate.md`, `bundle-size.md`, `coverage.md`, `lint-score.md`, `benchmark.md`) covers only thin-wrapper archetypes; nothing in it describes measuring agent behavior under controlled conditions.
**Alternatives**:
- Ship `scripts/benchmark_skill.sh` at repo root with a thin harness wrapper: rejected, doesn't match optimera's bespoke-per-project philosophy
- Ship composable Python primitives under `skills/optimera/scripts/primitives/`: rejected, over-engineering and creates a runtime install-path dependency
- Add an explicit archetype-routing substep to optimera's brainstorm: rejected, imposes taxonomy on a conversation that already adapts to user answers
- Single broad `session-telemetry.md` covering any session-level metric: rejected in favor of a split that factors machinery from the specific metric
- Single narrow `session-token-consumption.md` only: rejected, misses the chance to reuse vehicle machinery for future session-metric archetypes (wall-time, cost, tool-call counts)
**Choice**: Expand optimera's reference library with two new files. A machinery reference at `skills/optimera/references/agent-session-harness.md` (alongside `harness-guide.md`, not in `examples/`) describes running an agent under hermetic, reproducible conditions: two-condition A/B runs, stream-JSON telemetry parsing, causal plus numeric gates, per-run artifact layout, runtime-measured repo size. Docker is presented as one realization of "hermetic vehicle," not as a mandate. A metric-specific example at `skills/optimera/references/examples/session-token-consumption.md` applies the machinery to sum input_tokens + cache_creation_input_tokens + cache_read_input_tokens + output_tokens across assistant messages, with optional per-artifact attribution via a container-scoped PostToolUse hook. No changes to optimera's SKILL.md workflow. No repo-root scripts. No primitives infrastructure. The actual `.optimera/harness` for agentera's skill-token case gets brainstormed by /optimera when invoked, not pre-baked in this deliberation.
**Reasoning**: Optimera's brainstorm is already user-driven: users describe what they want to measure and the skill adapts, drawing on references silently as pattern material. The gap isn't process structure; it's that the reference library has no material for measurement styles needing real infrastructure. Expanding the library is the minimal change that closes the gap without introducing workflow ceremony. Splitting machinery from metric-specific example keeps the two concerns separate so future session-metric archetypes can reuse the vehicle without duplicating it. The `--repo-size` flag dissolves: a bespoke harness takes `TARGET_REPO=<path>`, measures size at runtime (bytes, file count, `.agentera/` artifact tokens), and records in the meta file — no user label to get wrong. Not pre-baking agentera's harness is deliberate: invoking /optimera to produce it validates that the new reference actually guides the brainstorm, which is how we'll know the reference is good.
**Confidence**: provisional
**Feeds into**: `skills/optimera/references/` (expansion), standalone

## Decision 30 · 2026-04-12

**Question**: How should optimera represent multiple objectives, and should `.optimera/` consolidate under `.agentera/`?
**Context**: Today optimera pins a single OBJECTIVE.md / EXPERIMENTS.md / `.optimera/harness`. Rotating targets (hej-token to realisera-token) requires hand-written archive moves. `.optimera/` lives outside `.agentera/`, splitting artifact roots. Decision 4 established single-root artifact resolution via `.agentera/DOCS.md`.
**Alternatives**:
- Flat files + registry: keep OBJECTIVE.md/EXPERIMENTS.md in `.agentera/`, add a registry file with an active pointer. More machinery, single-objective illusion.
- Active symlink: named subdirs with a symlink marking the active one. Cross-platform fragility.
- Named subdirs, self-contained: one directory per objective under `.agentera/optimera/`, each containing OBJECTIVE.md, EXPERIMENTS.md, harness, helpers, vehicle/, runs/. No registry, no symlinks. Directory existence is the registry.
**Choice**: Named subdirs under `.agentera/optimera/`. Each objective is fully self-contained (helpers duplicated per-objective, no shared dir). Active objective inferred from context: single objective = use it, multiple = most recent activity, ambiguous = ask. DOCS.md drops OBJECTIVE.md/EXPERIMENTS.md from artifact mapping (optimera owns its own path resolution). One-shot migration of existing hej-token and realisera-token data.
**Reasoning**: Convention over configuration. The directory structure IS the multi-objective representation. Self-contained objectives are independently archivable, independently measurable, and require zero coordination. Single root under `.agentera/` aligns with Decision 4. Dropping DOCS.md mapping is correct because OBJECTIVE.md/EXPERIMENTS.md are no longer at fixed paths.
**Confidence**: firm
**Feeds into**: TODO.md (implementation), optimera SKILL.md (path changes), DOCS.md (mapping update), .gitignore (path update)

## Decision 29 · 2026-04-12

**Question**: How should the realisera-token harness be redesigned after three consecutive discarded experiments where run-to-run variance (13-20%) drowned the optimization signal (5-10%)?
**Context**: Experiments 1-3 all measured the full-cycle composite (peak_context + output_total) via a single Docker A/B run. The composite conflates fixed cost (SKILL.md in the system prompt) and variable cost (which files the model reads, tool choice non-determinism). SKILL.md edits change the fixed cost deterministically, but the metric can't detect them because the variable cost swings 10-15K tokens between runs with identical code. The hej-token objective succeeded (29.5% signal vs 5% noise) because hej's session is short and deterministic; realisera's session is long and stochastic. A pre-flight token probe was built but couldn't isolate SKILL.md tokens via the CLI due to prompt caching. An API key is available for the Anthropic count_tokens endpoint.
**Alternatives**:
- Multi-run averaging (3x full Docker A/B, average composite): brute force, $9/experiment, reduces variance to ~5-7% but doesn't separate fixed from variable cost
- Tighter vehicle constraints (restrict tool surface further, deterministic file order): attacks variance at the source but reduces measurement realism
- Two-tier metric with Tier 2 composite as primary: keeps the noisy metric as the decision criterion, just adds Tier 1 as diagnostic
**Choice**: Two-tier metric. Tier 1 (primary): exact token count of SKILL.md + contract.md via the Anthropic count_tokens API (free, zero variance, deterministic). Tier 2 (behavioral validation): single Docker A/B run, pass bar is gates-only (causal + structural must pass), composite value is diagnostic only. An experiment is kept when Tier 1 improves AND Tier 2 gates pass.
**Reasoning**: The fixed cost (system prompt tokens) is exactly what SKILL.md edits control, and it's measurable with zero variance via the API. The variable cost (runtime reads, tool selection) is stochastic and outside the optimization scope of SKILL.md changes. Separating them means SKILL.md experiments get instant, exact feedback (Tier 1) while behavioral soundness is confirmed without requiring the noisy composite to improve (Tier 2). The full composite remains in the breakdown as a diagnostic for trend analysis across experiments. This unblocks contract.md lazy-reference, spec_sections trimming, and progressive disclosure experiments that were all stuck because the composite couldn't detect 5-10% improvements.
**Confidence**: firm
**Feeds into**: OBJECTIVE.md (metric redefinition), .optimera/harness (redesign)
