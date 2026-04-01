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

Scale-adaptive planning bridging deliberation and execution. PLAN.md with behavioral
acceptance criteria for realisera. Planera owns WHAT and WHY; realisera owns HOW.

Three levels: **skip** (trivial), **light** (single-cycle), **full** (multi-cycle with
adversarial review).

Planning output opens with: `─── ≡ planera · planning ───`

---

## State artifacts

One file and one archive directory in `.agentera/`.

| Artifact | Purpose | Bootstrap |
|----------|---------|-----------|
| `PLAN.md` | Active plan. Spec, tasks, acceptance criteria. | Created during planning session. |
| `.planera/archive/` | Completed or discarded plans. | Created on first archival. |

**Presence signal**: `.agentera/PLAN.md` means active planned work. Absence means no
plan — realisera reasons from VISION.md as usual.

Templates in `references/templates/` — use as starting structure, adapt to the project.

### Artifact path resolution

Before reading or writing any artifact, check if .agentera/DOCS.md exists. If it has an
Artifact Mapping section, use the path specified for each canonical filename (.agentera/PLAN.md,
etc.). If .agentera/DOCS.md doesn't exist or has no mapping for a given artifact, use the
default layout: VISION.md, TODO.md, and CHANGELOG.md at the project root; all other artifacts
in .agentera/. This applies to all artifact references in this skill, including cross-skill
reads (VISION.md, .agentera/DECISIONS.md, .agentera/HEALTH.md, TODO.md, .agentera/PROGRESS.md).

---

## Step 0: Detect level

Assess work complexity. Read the description (user, DECISIONS.md, or TODO.md). Scan
codebase if needed.

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

Read VISION.md, DECISIONS.md, and TODO.md in parallel — these reads are independent, issue
all in a single response.

1. **VISION.md** — the north star (if exists)
2. **DECISIONS.md** — read `firm` entries only (these are hard constraints for planning)
3. **HEALTH.md** — latest codebase health grades (if exists)
4. **TODO.md** — related known issues (if exists)
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

Before decomposing: in your response, summarize the constraints from VISION.md and
DECISIONS.md that bound this plan. These survive compaction.

---

## Step 2: Specify

Define WHAT and WHY. Intent layer, not implementation details.

### Light plans

Brief conversation (2-3 questions):

- **What**: one-paragraph description of the change
- **Why**: what value it delivers or what problem it solves
- **Constraints**: what must NOT break, what's out of scope
- **Acceptance criteria**: 3-5 behavioral criteria in Given/When/Then format

Write PLAN.md. Present for approval (human-initiated) or proceed (autonomous).

### Full plans

Deeper conversation:

- **What**: detailed description of the feature or change
- **Why**: motivation, user impact, relationship to VISION.md
- **Constraints**: architectural boundaries, off-limits modules, non-functional requirements
- **Scope**: what's in, what's explicitly out, what's deferred
- **Design**: high-level approach — modules affected, interactions, key decisions. No
  implementation details (functions, line-level changes).
- **Task decomposition**: 3-8 ordered tasks, each one realisera cycle. Per task: one-line
  description, dependencies, 3-5 behavioral Given/When/Then acceptance criteria
- **Version bump check**: if DOCS.md has a `versioning` block and plan includes `feat`/`fix`
  work, add final task "Version bump per DOCS.md convention" depending on all others. No
  versioning convention = skip entirely.
- **Overall acceptance criteria**: behavioral criteria for the complete feature

Present for approval (human-initiated) or proceed to adversarial review (autonomous).

---

## Step 3: Review (full plans only)

Spawn an adversarial critic. The critic MUST find issues — "looks good" is not acceptable.

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

Address legitimate issues; dismiss false positives with rationale. Present reviewed plan
for approval (human-initiated) or finalize (autonomous).

---

## Step 4: Write PLAN.md

Reason through dependencies in response text. Write ONLY tasks with acceptance criteria
to PLAN.md — no rationale. The conversation preserves reasoning; the artifact preserves
the plan.

Output constraint: ≤30 words per task description, ≤20 words per acceptance criterion.

Write the plan to `.agentera/PLAN.md`.

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
▸ GIVEN [context] WHEN [action] THEN [expected outcome]
▸ GIVEN [context] WHEN [action] THEN [expected outcome]
▸ ...
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
**Status**: □ pending
**Acceptance**:
▸ GIVEN [context] WHEN [action] THEN [expected outcome]
▸ ...

### Task 2: [Title]
**Depends on**: Task 1
**Status**: □ pending
**Acceptance**:
▸ GIVEN [context] WHEN [action] THEN [expected outcome]
▸ ...

[Repeat for 3-8 tasks]

## Overall Acceptance
▸ GIVEN [context] WHEN [action] THEN [expected outcome]
▸ ...

## Surprises
[Empty — populated by realisera during execution when reality diverges from plan]
```

---

## Step 5: Handoff

- **Light plans**: suggest `/realisera` with plan's acceptance criteria as exit conditions.
- **Full plans**: suggest `/realisera` or `/loop`. Realisera picks next pending task with
  satisfied dependencies.

---

## How realisera reads PLAN.md

When PLAN.md has pending tasks, realisera's Step 2 changes:

1. Read PLAN.md
2. Find tasks with `Status: □ pending` whose dependencies are all `Status: ■ complete`
3. Pick the first eligible task
4. Use the task's acceptance criteria as exit conditions for the cycle
5. After committing, update the task's status to `■ complete` in PLAN.md
6. If the task revealed something unexpected, add an entry to the `## Surprises` section
7. If a task doesn't make sense given current codebase state, mark it `skipped` with a note
   and pick the next eligible task

When all tasks are complete (or the plan is explicitly discarded):

1. Archive PLAN.md to `.planera/archive/PLAN-{date}.md`
2. Delete `.agentera/PLAN.md`
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

Planera is part of an eleven-skill ecosystem. It is the bridge between deliberation and execution.

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

### Planera reads /visionera output
VISION.md provides the north star that planera reads during its Orient step. When visionera
creates or refines the vision, planera's next planning session aligns with the updated
direction.

### Planera is fed by /dokumentera (DTC pipeline)
In the strict DTC pipeline, dokumentera writes intent docs first, then planera decomposes
them into implementation tasks. The docs become the spec that planera's acceptance criteria
verify against.

### Planera reads /dokumentera versioning conventions
Planera reads the `versioning` block from DOCS.md Conventions (populated by dokumentera).
When the plan's scope includes `feat` or `fix` work, planera appends a version bump task
that depends on all other tasks. Realisera executes this bump at the end of the plan.

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
