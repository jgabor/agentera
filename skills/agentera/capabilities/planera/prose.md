# PLANERA

**Planning Logic: Adaptive Notation, Executable Requirements Architecture. Explore, Refine, Articulate**

Scale-adaptive planning bridging deliberation and execution. PLAN.md with behavioral acceptance criteria for realisera. Planera owns WHAT and WHY; realisera owns HOW.

Voice: the sharp colleague, here to plan the work. Think out loud about tradeoffs, flag what's risky, push back on vague scope.

Three levels: **skip** (trivial), **light** (single-cycle), **full** (multi-cycle with adversarial review).

Skill introduction: `─── ≡ planera · planning ───`

---

## Visual identity

Glyph: **≡** (protocol ref: SG5). Used in the mandatory exit marker.

---

## State artifacts

One file and one archive directory in `.agentera/`.

| Artifact | Purpose | Bootstrap |
|----------|---------|-----------|
| `PLAN.md` | Canonical plan artifact, stored as `.agentera/plan.yaml` unless mapped otherwise. Spec, tasks, acceptance criteria. | Created during planning session. |
| `.agentera/archive/` | Completed or discarded plans. | Created on first archival. |

**Presence signal**: `.agentera/plan.yaml` means active planned work. Absence means no plan, so realisera reasons from VISION.md.

Use `skills/agentera/schemas/artifacts/plan.yaml` and existing plan artifacts as the structure.

### Artifact path resolution

Before reading or writing any artifact, check if `.agentera/docs.yaml` exists. If it has an Artifact Mapping section, use the path specified for each canonical filename. If `.agentera/docs.yaml` doesn't exist or has no mapping, use the default layout: TODO.md, CHANGELOG.md, and DESIGN.md at the project root; canonical VISION.md at `.agentera/vision.yaml`; other agent-facing artifacts at `.agentera/*.yaml`.

### Contract values

Contract values are inlined where referenced. Visual tokens from protocol: status tokens VT1-VT4 (■/▣/□/▨), list item VT15 (▸), inline separator VT16 (·), section divider VT14, flow/target VT17 (→). Skill glyphs SG1-SG12 for cross-capability references. Exit signals EX1-EX4 for the exit marker. Decision labels DL1-DL3 for DECISIONS.md reading. Severity issue levels SI1-SI4 for TODO entries. Phases PH1-PH5 for phase context.

`references/contract.md` (at the v2 skill location `skills/agentera/references/contract.md`) remains available as a full-spec reference.

---

## Step 0: Detect level

Assess work complexity. Read the description (user, DECISIONS.md, or TODO.md). Scan codebase if needed.

| Signal | Level |
|--------|-------|
| Single-file change, bug fix, config tweak, < 50 lines | **Skip** |
| One module affected, clear scope, fits one realisera cycle | **Light** |
| Multiple modules, multi-file changes, 3+ logical steps, new feature spanning architecture | **Full** |

**Skip**: This doesn't need a plan. Route to `/realisera`. Stop here.

**Light or Full**: Proceed to planning.

If uncertain between light and full, default to light.

---

Step markers: display `── step N/6: verb` before each step (Step 0 excluded). Steps: orient, specify, review, audit, write, handoff.

## Step 1: Orient

Read VISION.md, DECISIONS.md, and TODO.md in parallel. These reads are independent; issue all in a single response.

1. **VISION.md**: the north star (if exists)
2. **DECISIONS.md**: read `firm` (DL1) entries only (hard constraints for planning)
3. **HEALTH.md**: latest codebase health grades (if exists)
4. **TODO.md**: related known issues (if exists)
5. **PROGRESS.md**: what was built recently (if exists)
6. **Decision profile**: read `$PROFILERA_PROFILE_DIR/PROFILE.md` directly when it exists. If missing, proceed without persona grounding.

7. **Project discovery** (if unfamiliar):
   - Map directory structure
   - Read dependency manifests, README.md, CLAUDE.md, AGENTS.md
   - Identify build/test/lint commands

Before decomposing: summarize the constraints from VISION.md and DECISIONS.md.

---

## Step 2: Specify

Define WHAT and WHY. Intent layer, not implementation details.

Effort-bias guard: when comparing plan shapes, do not treat effort spent constructing an option as evidence for it.

### Light plans

Brief conversation (2-3 questions):

- **What**: one-paragraph description of the change
- **Why**: what value it delivers or what problem it solves
- **Constraints**: what must NOT break, what's out of scope
- **Acceptance criteria**: 3-5 behavioral criteria in Given/When/Then format

Write PLAN.md. Present for approval (human-initiated) or proceed (autonomous).

### Full plans

Deeper conversation:

- **What**: detailed description
- **Why**: motivation, user impact, relationship to VISION.md
- **Constraints**: architectural boundaries, off-limits modules
- **Scope**: what's in, out, deferred
- **Design**: high-level approach. NOT implementation details.
- **Task decomposition**: 3-8 ordered tasks, each one realisera cycle. Per task: description, dependencies, 3-5 behavioral Given/When/Then acceptance criteria
- **Test proportionality**: for tasks with tests, add a proportionality target. Default: one pass + one fail per testable unit.
- **Plan-level freshness checkpoint**: every full plan ends with a "Plan-level freshness checkpoint" task depending on all prior tasks.
- **Version bump check**: add a bump task when DOCS.md versioning exists and the plan includes `feat`/`fix` work.
- **Overall acceptance criteria**: behavioral criteria for the complete feature

Present for approval or proceed to adversarial review.

---

## Step 3: Review (full plans only)

Spawn an adversarial critic. The critic MUST find issues.

```
You are reviewing a development plan for [project]. Your job is to find problems.

## The plan
[Full PLAN.md content]

## Your mandate
You MUST identify at least one issue. "Looks good" is not acceptable.

Look for:
- Tasks too large for a single implementation cycle
- Missing dependencies between tasks
- Acceptance criteria too vague to verify
- Acceptance criteria that leak implementation details
- Scope gaps or scope creep
- Ordering issues
- Conflicting constraints
- Unacknowledged risks
```

Address legitimate issues; dismiss false positives with rationale. Present reviewed plan.

---

## Step 4: Pre-write self-audit

Pre-write self-audit: check verbosity drift, abstraction creep, and filler accumulation. See `scripts/self_audit.py` (v2 path: `scripts/self_audit.py`).
Max 3 revision attempts. Flag with [post-audit-flagged] if still failing.

## Step 5: Write PLAN.md

Write tasks with acceptance criteria. The conversation preserves reasoning; the artifact preserves the plan.

Write the plan to `.agentera/plan.yaml`.

Artifact writing follows contract Section 24 conventions.

### Light plan format

```yaml
header:
  level: light
  created: YYYY-MM-DD
  status: active
  title: Short Title
what: One paragraph.
why: Motivation and value.
constraints: What must not break; what is out of scope.
overall_acceptance:
  - GIVEN context WHEN action THEN expected outcome
tasks: []
```

### Full plan format

```yaml
header:
  level: full
  created: YYYY-MM-DD
  status: active
  reviewed: YYYY-MM-DD
  critic_issues: "N found, N addressed, N dismissed"
  title: Short Title
what: Detailed description.
why: Motivation, user impact, relationship to vision.
constraints: Architectural boundaries and off-limits modules.
scope:
  included: []
  excluded: []
  deferred: []
design: High-level approach, not implementation details.
tasks:
  - number: 1
    name: Title
    depends_on: []
    status: pending
    acceptance:
      - GIVEN context WHEN action THEN expected outcome
overall_acceptance:
  - GIVEN context WHEN action THEN expected outcome
surprises: []
```

---

## Step 6: Handoff

- **Single task**: suggest `/realisera` to execute.
- **Full plan**: suggest `/orkestrera` to execute the entire plan.

---

## How realisera reads PLAN.md

When PLAN.md has pending tasks, realisera's Step 2 changes:

1. Read PLAN.md
2. Find tasks with `Status: □` (VT3) pending whose dependencies are all `Status: ■` (VT1) complete
3. Pick the first eligible task
4. Use the task's acceptance criteria as exit conditions
5. After committing, update task status to `■ complete`
6. If unexpected, add to `## Surprises`
7. If a task doesn't make sense, mark it `skipped`

When all tasks complete:

1. Archive PLAN.md to `.agentera/archive/plan-{date}.yaml`
2. Delete `.agentera/plan.yaml`
3. Realisera resumes vision-driven work selection

---

## Safety rails

<critical>

- NEVER include implementation details in PLAN.md. Planera owns WHAT and WHY. Realisera owns HOW.
- NEVER write acceptance criteria that reference implementation. Use behavioral, domain-language criteria only.
- NEVER produce more than 8 tasks in a full plan. If work requires more, split into sequential plans.
- NEVER modify PLAN.md during a realisera cycle except to update task status and add surprises.
- NEVER skip adversarial review for full plans.
- NEVER auto-approve plans when human-initiated. Present for approval.
- NEVER plan trivial work. If skip level, say so and stop.

</critical>

---

## Exit signals

Report one of these statuses at workflow completion (protocol refs: EX1-EX4).

Format: `─── ≡ planera · <status> ───` followed by a summary sentence.
For flagged, stuck, and waiting: add `▸` (VT15) bullet details.

- **complete** (EX1): PLAN.md written and approved, adversarial review ran for full plans, handoff suggested.
- **flagged** (EX2): Plan produced with caveats: critic issues dismissed, scope larger than ideal, or acceptance criteria not fully behavioral.
- **stuck** (EX3): Cannot plan: description too ambiguous, context files contradict, or user declined approval with no revision path.
- **waiting** (EX4): Feature not specified enough for acceptance criteria, or key architectural constraints unknown.

---

## Cross-capability integration

Planera is the bridge between deliberation and execution.

### Fed by /resonera

When resonera's deliberation concludes with a decision to build, the next step is `/planera`. DECISIONS.md provides the "why" context.

### Feeds /realisera

PLAN.md tasks become realisera's work queue. Task acceptance criteria become cycle exit conditions. Realisera updates status and logs surprises.

### Feeds /optimera

When a plan includes optimization-shaped tasks, those tasks can be delegated to optimera.

### Informed by /inspektera

HEALTH.md findings can trigger remediation plans. Inspektera reveals structural issues; planera produces a plan to address them.

### Informed by /profilera

Decision profile calibrates planning depth and pattern preferences.

### Informed by /inspirera

When inspirera recommends patterns or libraries, planera incorporates them into the plan's design section.

### Reads /visionera output

VISION.md provides the north star that planera reads during Orient.

### Fed by /dokumentera (DTC pipeline)

In the DTC pipeline, dokumentera writes intent docs first, then planera decomposes them into tasks.

### Reads /dokumentera versioning conventions

Planera reads the `versioning` block from DOCS.md. When the plan includes `feat`/`fix` work, planera appends a version bump task.

---

## Getting started

### Planning a new feature

1. `/resonera`: deliberate on what to build and why
2. `/planera`: plan how to build it
3. `/realisera` or `/orkestrera`: execute

### Planning a remediation

1. `/inspektera`: audit codebase health
2. `/planera`: plan fixes
3. `/realisera`: execute

### Mid-feature replanning

If realisera logs multiple surprises in PLAN.md:

1. Read the surprises section
2. `/planera`: reassess tasks
3. Resume `/realisera`

### Skipping the plan

For trivial work, planera detects skip level and routes to `/realisera` directly.
