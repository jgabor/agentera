# Decisions

Reasoning trail maintained by resonera. Each deliberation session appends one entry. Decisions
are referenced by realisera, optimera, and profilera for context on why choices were made.

## Decision 1 · YYYY-MM-DD

**Question**: what was being decided
**Context**: relevant constraints, triggers, or prior decisions
**Alternatives**:
**Choice**: what was chosen
**Reasoning**: the key insight or tradeoff that resolved it
**Confidence**: ━ firm | ─ provisional | ┄ exploratory
**Feeds into**: VISION.md | OBJECTIVE.md | TODO.md | standalone

<!--
Entry format reference:

  ## Decision N · YYYY-MM-DD

  **Question**: [what was being decided]
  **Context**: [constraints, triggers, prior decisions]
  **Alternatives**:
  - [Option A]: [tradeoffs]; win condition: [concrete signal]
  - [Option B]: [tradeoffs]; win condition: [concrete signal]
  **Choice**: [what was chosen]
  **Reasoning**: [key insight or tradeoff that resolved it]
  **Confidence**: ━ firm | ─ provisional | ┄ exploratory
  **Feeds into**: VISION.md | OBJECTIVE.md | TODO.md | standalone

Numbering and placement:
  N is one greater than the highest active or archived decision number.
  New full entries go before ## Archived Decisions, or at EOF if no archive exists.
  Active decision entries stay unique and ascending by decision number.

Compatibility:
  Keep Question, Context, Alternatives, Choice, Reasoning, Confidence, and Feeds into
  as top-level fields. Win conditions stay inside Alternatives bullets.

Confidence levels:
  firm         : committed; other skills treat this as a constraint
  provisional  : best current answer, open to revision if evidence changes
  exploratory  : direction to try, explicitly expected to be revisited

Feeds into:
  VISION.md    : project direction, scope, principles (consumed by realisera)
  OBJECTIVE.md : optimization target, constraints, scope (consumed by optimera)
  TODO.md    : tech debt or problems surfaced during deliberation
  standalone   : the decision stands on its own, no downstream artifact
-->
