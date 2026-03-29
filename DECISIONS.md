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
