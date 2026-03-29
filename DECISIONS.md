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
