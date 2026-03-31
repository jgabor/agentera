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

---

## Decision 7 — 2026-03-30

**Question**: How should the skill ecosystem enforce cross-skill alignment and prevent shared primitives from diverging as skills are added?

**Context**: The knowledge-synthesis cross-pollination analysis (inspirera) revealed that
inspektera uses a 0-100 confidence scale while profilera uses 0.0-1.0 with exponential decay —
two independently invented systems for the same concept. This is the poster child for a broader
risk: as skills grow, shared primitives (confidence, severity, artifact formats, structural
conventions) diverge because they're defined by copy-paste convention rather than a single
source of truth. The user explicitly rejected artifact authority ordering in favor of
preventing conflicts rather than arbitrating them.

**Alternatives**:
- [Artifact authority ordering] — rejected: the user wants alignment enforcement, not conflict
  arbitration. Conflicts between artifacts signal real problems that should be surfaced and fixed.
- [Runtime validation when skills interact on a target project] — rejected: alignment is a
  development-time concern. Skills are authored together in one repo, so catch drift before
  publishing.
- [Shared reference docs only (no enforcement)] — rejected: DOCS.md's artifact path resolution
  is already a convention that skills honor voluntarily, and divergence still happened.
- [Per-primitive reference docs] — rejected in favor of a single comprehensive spec for
  maintainability.

**Choice**: Single ecosystem spec (`references/ecosystem-spec.md`) defining all shared primitives,
enforced by a Python linter (`scripts/validate-ecosystem.py`) running as a pre-commit hook.

**Reasoning**: The confidence divergence proved that convention-based alignment fails silently.
Two skills independently invented scoring systems that use different scales for the same concept.
The fix is twofold: (1) define shared primitives in one place so new skills inherit consistency,
and (2) validate alignment deterministically so drift can't be committed. A pre-commit hook is
the tightest feedback loop — it catches violations at the moment they're introduced, requiring
zero discipline. The Anthropic `~~placeholder` + `CONNECTORS.md` pattern from knowledge-work-plugins
confirmed the architecture: define once, reference everywhere, validate consistency.

**Primitives identified (9 total)**:

| # | Primitive | Category | Validation |
|---|-----------|----------|------------|
| 1 | Confidence scale (0-100, five tiers) | Behavioral | Deterministic — regex tier boundaries |
| 2 | Severity levels | Behavioral | Deterministic — exact string matching |
| 3 | Decision confidence labels (firm/provisional/exploratory) | Behavioral | Deterministic — enum values |
| 4 | Artifact format contracts | Behavioral | Manual review flag |
| 5 | Artifact path resolution (DOCS.md pattern) | Mechanical | Deterministic — instruction text matching |
| 6 | Profile consumption pattern | Mechanical | Deterministic — script invocation matching |
| 7 | Cross-skill integration section format | Structural | Deterministic — section presence + completeness |
| 8 | Safety rails section format | Structural | Deterministic — `<critical>` tag presence |
| 9 | SKILL.md frontmatter requirements | Structural | Deterministic — required fields |

**Validation approach**: Deterministic checks (boundaries, names, section presence, field
requirements) block commits. Fuzzy checks (artifact format semantic alignment) flag for manual
review but don't block. Python stdlib only — consistent with existing scripts.

**Confidence**: firm
**Feeds into**: ISSUES.md, PLAN.md

---

## Decision 8 — 2026-03-30

**Question**: Should the ecosystem unify its confidence model, and if so, on what scale?

**Context**: Inspektera uses a 0-100 integer scale with five tiers (90-100 verified, 70-89
strong, 50-69 moderate, 30-49 uncertain, 0-29 speculative). Profilera uses 0.0-1.0 float with
exponential decay (`conf × e^(-λ × days_since_confirmed)`) and similar five tiers (0.85-0.95,
0.65-0.80, 0.45-0.60, 0.25-0.40, 0.10-0.20). Seven skills consume confidence values from one
or both systems. The two scales express the same semantics at different numeric ranges.

**Alternatives**:
- [0.0-1.0 everywhere] — rejected: less human-readable in artifacts like HEALTH.md that humans
  read directly. "confidence: 73" is more natural than "confidence: 0.73".
- [Unified semantic tiers only (let skills pick their scale)] — rejected: the user wants one
  numeric scale, no translation needed between skills.
- [Same tier names across skills] — rejected: tier *labels* are domain-specific (inspektera:
  "definitely a real issue" vs profilera: "shipped consistently"). Shared boundaries are
  sufficient; each skill describes what a tier means in its own context.

**Choice**: Unify on 0-100 integer scale. Five shared tier boundaries. Domain-specific labels.
Temporal decay is opt-in.

**Reasoning**: 0-100 is more readable in human-facing artifacts (HEALTH.md, PROFILE.md) and
inspektera already uses it. The decay formula works identically at this scale (`floor 20`
instead of `floor 0.20`, same λ values). Same boundaries remove all translation friction when
one skill reads another's confidence values. Domain-specific labels preserve each skill's ability
to describe what confidence means in its context — "verified by reading the code" and "shipped
consistently across 3+ projects" are both 90+ but mean different things.

### Design Decisions Summary

| Aspect | Decision |
|--------|----------|
| Scale | 0-100 integer |
| Tiers | Five (boundaries to be reconciled from inspektera/profilera current ranges) |
| Labels | Domain-specific — each skill defines its own tier descriptions |
| Decay | Opt-in per skill. Profilera uses it. Inspektera does not. |
| Migration | Profilera migrates from 0.0-1.0 to 0-100 |
| Boundary reconciliation | Implementation detail — reconcile during ecosystem-spec authoring |

**Confidence**: firm
**Feeds into**: references/ecosystem-spec.md (Decision 7)

---

## Decision 9 — 2026-03-31

**Question**: What should this skill ecosystem be named? The current name "agent-skills" is generic and doesn't represent what it is or provides.
**Context**: The ecosystem is a collection of 10 interconnected Swedish-named skills that give a solo founder an engineering team. All skill names follow the Swedish -era verb convention. The name appears in the repo, marketplace manifest, README, and CLAUDE.md. It's the public identity.
**Alternatives**:
- [agent-skills] — current name. Generic, describes the format not the identity. Could be any collection of any skills.
- [agenterna] — "the agents" in Swedish. Directly plural/collective. Rejected: too literal, dictionary translation energy rather than proper name energy.
- [arsenalen] — "the arsenal." Cross-language transparency, forge heritage. Rejected: military connotation clashes with crew/team energy.
- [ateljén / fabriken / hantverket] — explored as forge/workshop alternatives with cross-language transparency. None landed — each had tradeoffs (too artsy, too industrial, too literal) that didn't match the desired feel.
- [smedjan] — "the forge." Maximum Swedish character. Rejected: completely opaque to non-Swedes.
- [agenteri] — "agent-ery," Swedish -eri suffix (bakery, brewery). Workshop energy. Discussed but not the frontrunner.
- [agentera] — follows the -era verb convention. Consistent with skills. Runner-up: risks blending in with individual skill names since they're all -era verbs, but the verb-as-ecosystem-name has appeal.
**Choice**: **agentera** — "to agent." The ecosystem name follows the same -era verb convention as its skills.
**Reasoning**: The deliberation explored two directions — agent-rooted names and non-agent forge/workshop names. The forge direction produced evocative options but none satisfied all constraints simultaneously. Agenturen was the analytical frontrunner (noun, collective, survives scrutiny), but agentera is the instinctive choice: it follows the -era verb pattern that defines the entire suite's identity, "agent" is universally legible, and -era is the signature suffix. The noun-vs-verb distinction matters less than the user initially thought — the ecosystem IS an action. You don't just install a collection; you agentera your project. The name is both the identity and the invocation.

**Key constraints discovered during deliberation**:
- Must feel like a crew/team, specifically plurality/collective
- Must have proper name energy — character, not a dictionary translation
- Must be pronounceable by non-Swedes and hint at what it is
- Swedish flavor is non-negotiable (matches the -era skill identity)

**Primitive vocabulary convention** (added 2026-03-31): ecosystem primitives use lowercase, single-word terms with personality — matching the register of existing vocabularies (critical/degraded/annoying, firm/provisional/exploratory). New primitives must follow the same convention. ALL_CAPS engineering jargon and corporate headings are rejected in favor of workshop-floor language. Applied to exit signals: `complete/flagged/stuck/waiting`. Section headings: "Exit signals" (peer to "Safety rails"), "Loop guard" (workshop machinery metaphor for runaway prevention).

**Confidence**: firm
**Feeds into**: rename execution across repo, marketplace manifest, README, CLAUDE.md, registry; ecosystem-spec.md primitive vocabulary

---

## Decision 10 — 2026-03-31

**Question**: Which patterns from gstack (garrytan/gstack) should agentera adopt, defer, or reject?
**Context**: Inspirera analysis of gstack and its /office-hours skill identified 8 transferable
concepts. Each was evaluated against agentera's existing capabilities, VISION.md principles
(coherence over features, compounding over convenience, standalone + mesh), and the constraint
that artifact sprawl has real cost.

**Alternatives evaluated**:

| # | Concept | Source pattern | Verdict | Reasoning |
|---|---------|---------------|---------|-----------|
| 1 | Forcing questions protocol | office-hours' 6 diagnostic questions | **Defer** | Resonera's Socratic identity is distinct from a product diagnostic. The pattern (don't accept vague answers) is worth absorbing into resonera's pushback principles (#3), but a formal diagnostic mode stretches resonera into two things. |
| 2 | Proactive skill routing system | gstack's shared preamble routing rules | **Reject** | Claude Code's trigger-pattern matching from skill descriptions is the right mechanism for pure-Markdown skills. A separate routing system duplicates this. Hej's dashboard and routing-by-suggestion cover the entry-point case. |
| 3 | Anti-sycophancy / pushback patterns | office-hours' explicit pushback rules and red flags | **Adopt now** | Clear gap. Resonera says "gently challenge assumptions" but doesn't codify pushback techniques. 3-4 explicit principles would sharpen deliberation without changing personality. |
| 4 | Compounding learnings artifact | gstack's /learn with JSONL persistence | **Defer** | PROGRESS.md:Discovered, ISSUES.md, and HEALTH.md:Patterns Observed already capture most of what a learnings system would. Adding LEARNINGS.md overlaps all three without clear unique value. |
| 5 | Design doc as intermediate artifact | office-hours' structured design doc between deliberation and planning | **Reject** | DECISIONS.md already serves this role (Question, Context, Alternatives, Choice, Reasoning). The entry format can stretch for complex decisions. Another artifact in the pipeline adds friction for every decision. |
| 6 | Mode adaptation from user context | office-hours' startup/builder mode detection | **Defer** | Hej already reads PROFILE.md as part of its artifact scan. Explicit mode switching is premature — agentera targets one persona. Revisit if user base diversifies. |
| 7 | Spec review loop for planera | office-hours' iterative accept/modify/reject loop | **Reject** | Decision 1 already established human approval for human-initiated plans. Adding an iterative review loop is ceremony. If the plan needs revision, the user says so. |
| 8 | Three-tier eval (Tier 3 LLM-as-judge) | gstack's Sonnet-scored quality eval | **Defer** | Two-tier system (linter + smoke tests) catches structural and execution issues. LLM-as-judge for quality assessment is useful but not urgent until the skill set stabilizes. |

**Choice**: Adopt #3 (anti-sycophancy pushback patterns for resonera). Defer #1, #4, #6, #8. Reject #2, #5, #7. Hej's dashboard and routing-by-suggestion are preserved — the reject on #2 applies only to a separate routing system layered on top.

**Reasoning**: Most gstack patterns already have partial equivalents in agentera. The delta
that justifies immediate action is #3 — resonera has the right structure for deliberation but
lacks explicit pushback discipline. The deferred items have merit but either overlap existing
artifacts or are premature for the current ecosystem size. The rejected items duplicate
existing mechanisms (trigger patterns, DECISIONS.md format, planera approval gate).

**Confidence**: firm
**Feeds into**: resonera SKILL.md (pushback patterns)

---

## Decision 11 — 2026-03-31

**Question**: How should agentera express its identity visually across skills and artifacts?
**Context**: The ecosystem has 11 skills and up to 10 state artifacts, all producing plain text
output. The verbal identity is strong (Swedish names, workshop-floor vocabulary, direct voice)
but the visual output has no distinctive character. A box-drawing logo was created. The goal:
visual formatting that elicits a "whoa" reaction while remaining conservative and tasteful.
**Alternatives**:
- [Framed precision] Box-drawing borders framing entire outputs, terminal UI panel style — rejected: too contained, too "UI panel," doesn't breathe
- [Open structure] No outer frames, breathing room, `───` dividers, Unicode markers — chosen: craft is in precision and whitespace, not enclosure
- [Ephemeral only] Visual treatment only in skill output, not artifacts — rejected: user wants full consistency where artifacts and output look like the same system
- [Custom format replacing Markdown] Replace `##` headers with `───` dividers in artifacts — rejected: artifacts must stay valid Markdown for portability
**Choice**: Open-structure visual identity system layered on standard Markdown. Full Unicode
vocabulary with per-skill glyphs, semantic status/severity/confidence tokens, and the agentera
logo at key moments. Section dividers (`─── label ───`) as the primary structural element. Hej
dashboard as the reference composition.
**Reasoning**: The key insight is that craft and density are the same move — every visual element
must carry semantic weight. The vocabulary divides into three categories: (1) skill identity
glyphs — one unique geometric Unicode character per skill, appearing in section headers as subtle
signatures; (2) semantic tokens — status, severity, confidence, and trends expressed as single
characters with escalating visual weight; (3) structural tokens — section dividers, bullets,
separators, and progress bars. The logo uses box-drawing characters exclusively, keeping it
visually distinct from everything else. Artifacts stay valid Markdown with the visual vocabulary
layered within sections. The hej dashboard demonstrates the composition pattern: logo at top,
data grid with skill glyphs as markers, narrative summary, severity-marked attention items, and
target-skill-glyph routing.

### Visual Token Vocabulary

| Category | Token | Code | Meaning |
|----------|-------|------|---------|
| hej | 🞔 | U+1F794 | angular hub |
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
| Box-drawing scope | Logo only — no frames anywhere else |

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

## Decision 12 — 2026-03-31

**Question**: How should version management work across the agentera ecosystem — both for agentera's own skill versions and for target projects agentera runs in?
**Context**: No skill currently owns version bumping. Two version mismatches (inspektera and
inspirera) existed between plugin.json and marketplace.json with nobody catching them. CLAUDE.md
describes the mechanics ("update both registry.json and plugin.json") but no skill triggers,
detects, or executes bumps. The visual identity rollout changed all 11 SKILL.md files without
any version bumps.
**Alternatives**:
- [New skill for version management] — rejected: versioning is a convention enforced by existing skills, not a distinct workflow
- [Realisera auto-bumps at commit time] — rejected: too granular, multi-commit changes would produce multiple bumps
- [Plan completion = version boundary] — rejected: plans are a workflow tool, not a release boundary. A typo-fix plan shouldn't trigger a bump.
- [Strict semver default from commit types] — rejected: too prescriptive. Different projects have different versioning philosophies.
- [Realisera + inspektera defense-in-depth] — evolved into the final design
**Choice**: Project-driven versioning convention via DOCS.md, with three-layer enforcement
across existing skills. No default imposed — if the project doesn't specify a versioning
policy, no auto-bumping happens.
**Reasoning**: The key insight is that versioning is a *project convention*, not an agentera
convention. The skills are guests in someone else's codebase (Decision 4 principle). DOCS.md
already captures project conventions (doc structure, style defaults, artifact paths) — versioning
conventions belong there too. The three-layer enforcement follows the "detect → plan → execute"
pattern already established: dokumentera detects conventions, planera evaluates scope, realisera
executes, inspektera catches drift.

### Design

**DOCS.md conventions** (dokumentera survey): captures version file locations, semver policy,
changelog location, release tooling. If the project has existing conventions, dokumentera
records them. If none exist, DOCS.md says nothing about versioning.

**Three-layer enforcement**:

| Layer | Skill | Role | When |
|-------|-------|------|------|
| Proactive | planera | Includes a version bump task when planned scope warrants it (per DOCS.md policy) | During planning |
| Reactive | inspektera | Flags unbumped significant changes as audit findings | During health audits |
| Execution | realisera | Performs mechanical bump — reads DOCS.md for which files to update and semver level | When executing a bump task or picking up an inspektera finding |

**No convention = no auto-bumping**: If DOCS.md has no versioning section, skills don't
attempt version bumps. The user can always request one explicitly or ask dokumentera to
establish a convention.

**Same pattern for all projects**: agentera's 11+1 versioned files are just more version
entries in DOCS.md conventions. Target projects with a single version file use the same
mechanism. The skills don't need special logic per project type.

**Confidence**: ━ firm
**Feeds into**: DOCS.md template (versioning conventions), planera/inspektera/realisera SKILL.md updates
