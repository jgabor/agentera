---
name: planera
description: >
  PLANERA — Planning Logic: Adaptive Notation, Executable Requirements Architecture —
  Explore, Refine, Articulate. ALWAYS use this skill for structured planning of complex work
  before execution. This skill is REQUIRED whenever the work is too large for a single
  realisera cycle, involves multi-file changes across multiple modules, requires task
  decomposition and ordering, or would benefit from explicit acceptance criteria before
  implementation begins. Do NOT attempt multi-cycle development without this skill — it
  contains the critical workflow for scale-adaptive planning, behavioral acceptance criteria,
  adversarial review, and plan-to-cycle integration that prevents wasted work on complex tasks.
  Trigger on: "planera", "plan this", "write a plan", "break this down", "decompose this",
  "how should we build this", "spec this out", "plan before building", "multi-step feature",
  "this is too big for one cycle", any request to plan complex work before execution, any
  mention of structured task decomposition, or when realisera encounters work too large for
  a single cycle. Also trigger when the user describes a feature that clearly spans multiple
  files or modules.
---

# PLANERA

**Planning Logic: Adaptive Notation, Executable Requirements Architecture — Explore, Refine, Articulate**

A scale-adaptive planning skill that bridges deliberation and execution. Produces a PLAN.md
with behavioral acceptance criteria that realisera consumes for task selection. Planera owns
WHAT and WHY. Realisera owns HOW.

Three levels: **skip** (trivial work — just run realisera), **light** (single-cycle enrichment),
**full** (multi-cycle orchestration with adversarial review).

---

## State artifacts

Planera maintains one file in the project root and one directory for archives.

| Artifact | Purpose | Bootstrap |
|----------|---------|-----------|
| `PLAN.md` | Active plan. Spec, tasks, acceptance criteria. | Created during planning session. |
| `.planera/archive/` | Completed or discarded plans. | Created on first archival. |

**Presence signal**: `PLAN.md` in the project root means active planned work. Absence means no
plan — realisera reasons from VISION.md as usual.

Templates live in `references/templates/`. Use them as the starting structure — adapt to the
project, don't copy verbatim.

### Artifact path resolution

Before reading or writing any artifact, check if DOCS.md exists in the project root. If it
has an Artifact Mapping section, use the path specified for each canonical filename (PLAN.md,
etc.). If DOCS.md doesn't exist or has no entry for a given artifact, default to the project
root. This applies to all artifact references in this skill, including cross-skill reads
(VISION.md, DECISIONS.md, HEALTH.md, ISSUES.md, PROGRESS.md).

---

## Step 0: Detect level

Before planning, assess the work complexity to choose the right level.

Read the work description (from the user, from DECISIONS.md, or from ISSUES.md). Scan the
codebase if needed to understand scope.

| Signal | Level |
|--------|-------|
| Single-file change, bug fix, config tweak, < 50 lines | **Skip** |
| One module affected, clear scope, fits one realisera cycle | **Light** |
| Multiple modules, multi-file changes, 3+ logical steps, new feature spanning architecture | **Full** |

**Skip**: Tell the user this doesn't need a plan — just run `/realisera`. Stop here.

**Light or Full**: Proceed to planning.

If uncertain between light and full, default to light. The user can escalate.

---

## Step 1: Orient

Read project state for context.

1. **VISION.md** — the north star (if exists)
2. **DECISIONS.md** — prior deliberations relevant to this work (if exists)
3. **HEALTH.md** — latest codebase health grades (if exists)
4. **ISSUES.md** — related known issues (if exists)
5. **PROGRESS.md** — what was built recently (if exists)
6. **Decision profile** — run the effective profile script:
   ```bash
   python3 -m scripts.effective_profile
   ```
   Run from the profilera skill directory. Use it to calibrate planning depth, pattern
   preferences, and constraint priorities.
   If the script or PROFILE.md is missing, proceed without persona grounding.
7. **Project discovery** (if unfamiliar):
   - Map directory structure
   - Read dependency manifests, README, CLAUDE.md
   - Identify build/test/lint commands
   - Read key source files to understand architecture

---

## Step 2: Specify

Define WHAT is being built and WHY. This is the intent layer — not implementation details.

### Light plans

A brief, focused conversation (2-3 questions max) to capture:

- **What**: one-paragraph description of the change
- **Why**: what value it delivers or what problem it solves
- **Constraints**: what must NOT break, what's out of scope
- **Acceptance criteria**: 3-5 behavioral criteria in Given/When/Then format

Write PLAN.md with these sections. Present to the user for approval (if human-initiated) or
proceed (if autonomous).

### Full plans

A deeper conversation to capture:

- **What**: detailed description of the feature or change
- **Why**: motivation, user impact, relationship to VISION.md
- **Constraints**: architectural boundaries, off-limits modules, non-functional requirements
- **Scope**: what's in, what's explicitly out, what's deferred
- **Design**: high-level approach — which modules are affected, how they interact, key
  decisions. Do NOT specify implementation details (which functions to call, line-level
  changes). Focus on product context and high-level technical design.
- **Task decomposition**: break the work into 3-8 ordered tasks, each sized for one realisera
  cycle. Each task gets:
  - One-line description
  - Dependencies (which tasks must complete first)
  - Acceptance criteria: 3-5 behavioral Given/When/Then criteria per task
- **Overall acceptance criteria**: behavioral criteria for the complete feature

Present the full plan to the user for approval (if human-initiated) or proceed to adversarial
review (if autonomous).

---

## Step 3: Review (full plans only)

Spawn an adversarial critic agent to review the plan. The critic MUST find issues — "looks
good" is not an acceptable review.

```
You are reviewing a development plan for [project]. Your job is to find problems.

## The plan
[Full PLAN.md content]

## Your mandate
You MUST identify at least one issue. "Looks good" is not acceptable.

Look for:
- Tasks that are too large for a single implementation cycle
- Missing dependencies between tasks
- Acceptance criteria that are too vague to verify
- Acceptance criteria that leak implementation details (should be behavioral only)
- Scope gaps — things the plan doesn't cover but should
- Scope creep — things the plan covers but shouldn't
- Ordering issues — tasks that should happen earlier or later
- Constraints that conflict with each other
- Risks the plan doesn't acknowledge

Return a numbered list of issues, ordered by severity.
```

Review the critic's findings. Address legitimate issues by updating the plan. Dismiss false
positives with brief rationale.

Present the reviewed plan to the user for approval (if human-initiated) or finalize (if
autonomous).

---

## Step 4: Write PLAN.md

Write the plan to `PLAN.md` in the project root.

### Light plan format

```markdown
# Plan: [Short Title]

<!-- Level: light | Created: YYYY-MM-DD | Status: active -->

## What
[One paragraph]

## Why
[Motivation and value]

## Constraints
- [What must not break]
- [What's out of scope]

## Acceptance Criteria
- GIVEN [context] WHEN [action] THEN [expected outcome]
- GIVEN [context] WHEN [action] THEN [expected outcome]
- ...
```

### Full plan format

```markdown
# Plan: [Short Title]

<!-- Level: full | Created: YYYY-MM-DD | Status: active -->
<!-- Reviewed: YYYY-MM-DD | Critic issues: N found, N addressed, N dismissed -->

## What
[Detailed description]

## Why
[Motivation, user impact, relationship to vision]

## Constraints
- [Architectural boundaries]
- [Off-limits modules]
- [Non-functional requirements]

## Scope
**In**: [what's included]
**Out**: [what's explicitly excluded]
**Deferred**: [what's saved for later]

## Design
[High-level approach — modules affected, interactions, key decisions.
NOT implementation details.]

## Tasks

### Task 1: [Title]
**Depends on**: none
**Status**: pending
**Acceptance**:
- GIVEN [context] WHEN [action] THEN [expected outcome]
- ...

### Task 2: [Title]
**Depends on**: Task 1
**Status**: pending
**Acceptance**:
- GIVEN [context] WHEN [action] THEN [expected outcome]
- ...

[Repeat for 3-8 tasks]

## Overall Acceptance
- GIVEN [context] WHEN [action] THEN [expected outcome]
- ...

## Surprises
[Empty — populated by realisera during execution when reality diverges from plan]
```

---

## Step 5: Handoff

After PLAN.md is written and approved:

- **Light plans**: Suggest running `/realisera` to execute the single cycle with the plan's
  acceptance criteria as exit conditions.
- **Full plans**: Suggest running `/realisera` (or `/loop` for autonomous execution). Realisera
  reads PLAN.md, picks the next pending task with satisfied dependencies, and executes it.

---

## How realisera reads PLAN.md

When PLAN.md exists with pending tasks, realisera's Step 2 (Pick work) changes:

1. Read PLAN.md
2. Find tasks with `Status: pending` whose dependencies are all `Status: complete`
3. Pick the first eligible task
4. Use the task's acceptance criteria as exit conditions for the cycle
5. After committing, update the task's status to `complete` in PLAN.md
6. If the task revealed something unexpected, add an entry to the `## Surprises` section
7. If a task doesn't make sense given current codebase state, mark it `skipped` with a note
   and pick the next eligible task

When all tasks are complete (or the plan is explicitly discarded):

1. Archive PLAN.md to `.planera/archive/PLAN-{date}.md`
2. Delete PLAN.md from the project root
3. Realisera resumes reasoning from VISION.md for subsequent cycles

---

## Safety rails

<critical>

- NEVER include implementation details in PLAN.md. No function names, no line numbers, no
  "change file X at line Y." Planera owns WHAT and WHY. Realisera owns HOW.
- NEVER write acceptance criteria that reference implementation (class names, API endpoints,
  database tables). Use behavioral, domain-language criteria only.
- NEVER produce more than 8 tasks in a full plan. If work requires more, split into multiple
  sequential plans.
- NEVER modify PLAN.md during a realisera cycle except to update task status and add surprises.
  Plan changes require a re-planning session.
- NEVER skip adversarial review for full plans. The critic must run.
- NEVER auto-approve plans when human-initiated. Present for approval.
- NEVER plan trivial work. If the level is skip, say so and stop.

</critical>

---

## Exit signals

Report one of these statuses at workflow completion:

- **complete** — PLAN.md was written and approved (or the user confirmed skip level), the adversarial review ran for full plans, and the handoff to realisera was suggested.
- **flagged** — The plan was produced but with caveats: the adversarial critic raised issues that were dismissed rather than resolved, the work scope is larger than ideally fits the plan format, or one or more acceptance criteria could not be made fully behavioral.
- **stuck** — Cannot plan because the work description is too ambiguous to decompose, required context files (VISION.md, DECISIONS.md) contain contradictions that must be resolved first, or the user declined to approve the plan and no clear revision path exists.
- **waiting** — The feature or change to plan has not been specified with enough detail to produce acceptance criteria, or key architectural constraints that would shape the plan are unknown and cannot be inferred from the codebase.

---

## Cross-skill integration

Planera is part of a ten-skill ecosystem. It is the bridge between deliberation and execution.

### Planera is fed by /resonera
When resonera's deliberation concludes with a decision to build something, the natural next
step is `/planera` to plan the work. DECISIONS.md provides the "why" context that planera
reads during its Orient step.

### Planera feeds /realisera
PLAN.md's tasks become realisera's work queue. Each task's acceptance criteria become the
cycle's exit conditions. Realisera updates task status and logs surprises. When the plan
completes, realisera resumes vision-driven work selection.

### Planera feeds /optimera
When a plan includes optimization-shaped tasks (improving a measurable metric), those tasks
can be delegated to optimera. The plan's acceptance criteria inform the optimization objective.

### Planera is informed by /inspektera
HEALTH.md findings can trigger remediation plans. When inspektera reveals structural issues,
planera can produce a focused plan to address them — with acceptance criteria that inspektera
can later verify were met.

### Planera is informed by /profilera
The decision profile calibrates planning depth and pattern preferences. High-confidence
entries about architecture, scope discipline, and quality standards weight the plan's
constraints and acceptance criteria.

### Planera is informed by /inspirera
When inspirera's analysis recommends adopting patterns or libraries, planera can incorporate
those recommendations into the plan's design section and task decomposition.

### Planera is fed by /dokumentera (DTC pipeline)
In the strict DTC pipeline, dokumentera writes intent docs first, then planera decomposes
them into implementation tasks. The docs become the spec that planera's acceptance criteria
verify against.

---

## Getting started

### Planning a new feature

1. `/resonera` — deliberate on what to build and why (produces DECISIONS.md entry)
2. `/planera` — plan how to build it (produces PLAN.md)
3. `/realisera` or `/loop 10m /realisera` — execute the plan

### Planning a remediation

1. `/inspektera` — audit codebase health (produces HEALTH.md)
2. `/planera` — plan fixes for critical findings (produces PLAN.md)
3. `/realisera` — execute the fixes

### Mid-feature replanning

If realisera logs multiple surprises in PLAN.md, the plan may need revision:

1. Read the surprises section
2. `/planera` — reassess tasks, reorder, add/remove as needed
3. Resume `/realisera`

### Skipping the plan

For trivial work, planera will detect skip level and tell you to run `/realisera` directly.
No overhead for bug fixes and single-file changes.
