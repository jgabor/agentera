---
name: realisera
description: >
  REALISERA — Relentless Execution: Autonomous Loops Iterating Software — Evolve, Refine, Adapt.
  ALWAYS use this skill for autonomous or continuous development of a project. This skill
  is REQUIRED whenever the user wants you to independently decide what to build and build it,
  evolve a project over time, run development cycles, or make autonomous progress on a
  codebase. Do NOT attempt autonomous development without this skill — it contains the
  critical workflow for vision-driven development, persona-grounded decisions, structured
  cycles, and safety rails that prevent wasted work. Trigger on: "realisera", "run a dev
  cycle", "evolve the project", "develop autonomously", "build the next feature", "keep
  building", "start building", "work on the project", "refine the vision", any mention of
  autonomous/continuous development, any request to figure out what to build next, any
  request to pick up where you left off, any request to make progress on a project without
  specific instructions, or setting up /loop for recurring development. Also trigger when
  the user has a codebase and wants you to independently decide what to work on.
---

# REALISERA

**Relentless Execution: Autonomous Loops Iterating Software — Evolve, Refine, Adapt**

An autonomous development loop that evolves any software project, one focused cycle at a time.
Decisions are grounded in the user's persona via their decision profile. Inspiration is drawn
proactively from external sources. Continuity lives in files, not memory.

Each invocation = one cycle. `/loop` handles recurrence.

---

## State artifacts

Realisera maintains three files in the project root. All are bootstrapped if they don't exist.

| File | Purpose | Bootstrap |
|------|---------|-----------|
| `VISION.md` | North star. Direction, principles, aspirations. An evergreen constitution. | Via inline brainstorm session with the user (see below). |
| `ISSUES.md` | Tech debt, bugs, discrepancies. Things that need fixing. | `# Issues\n\nNo known issues.` |
| `PROGRESS.md` | Continuity log. What happened each cycle. | `# Progress\n\n` then the first cycle entry. |

Templates for each artifact live in `references/templates/`. Use them as the starting structure
when bootstrapping — adapt to the project, don't copy verbatim.

### Artifact path resolution

Before reading or writing any artifact, check if DOCS.md exists in the project root. If it
has an Artifact Mapping section, use the path specified for each canonical filename (VISION.md,
ISSUES.md, etc.). If DOCS.md doesn't exist or has no entry for a given artifact, default to
the project root. This applies to all artifact references in this skill, including cross-skill
reads (DECISIONS.md, HEALTH.md, PLAN.md).

### VISION.md

An evergreen document. Realisera creates it through a brief brainstorm session on first run,
and can refine it when the user explicitly asks. Outside of those two cases, the agent never
touches it — it reads the vision, it doesn't rewrite it. VISION.md sets a direction without
prescribing specific goals. A constitution, not a backlog. Typical structure:

```markdown
# [Project Name]

## North Star
[The dream. Not what the software does — what it makes possible. Paint a picture
of the world where this project has succeeded. What does it feel like to use?
What changes for the people who have it? Be ambitious.]

## Who It's For
[Concrete personas. Not "developers" — specific people with specific days, specific
frustrations, specific workflows. Who reaches for this tool and why?]

## Principles
- [Core principles that guide every decision]
- [What to optimize for, what to resist]

## Direction
[Where this project is heading. The kind of capabilities it should grow toward.
Aspirational, not prescriptive.]

## Identity
[What this project IS as an entity — personality, voice, emotional register, naming.]
```

The exact structure may vary — what matters is that the vision is ambitious enough to
sustain months of autonomous development, the personas are concrete enough to resolve
"who is this for?" debates, and the direction is clear enough for an autonomous agent
to derive what to build next by reasoning about the gap between the vision and the
current state of the codebase.

### PROGRESS.md

```markdown
## Cycle N — YYYY-MM-DD HH:MM

**What**: one-line summary of what shipped
**Commit**: <hash> <message>
**Inspiration**: what external source informed the approach (if any)
**Discovered**: issues or ideas found (also logged in ISSUES.md)
**Next**: what seems most valuable to work on next
```

The "Next" field from the previous cycle is a suggestion, not a mandate. Re-evaluate fresh.

---

## Brainstorm: bootstrapping or refining VISION.md

This runs in two situations:
1. **VISION.md doesn't exist** — the first time realisera runs on a project
2. **User explicitly asks** to refine the vision (e.g., "refine the vision", "update VISION.md")

In all other cases, skip straight to the cycle.

### How the brainstorm works

A brief, focused conversation to capture the user's intent. One question at a time.
Push for ambition — the vision should sustain months of autonomous development, so it
needs to be bigger than "a tool that does X." Ask the user to dream.

1. **Understand the dream** — "What's the big picture here? Not what the software does —
   what does it make possible? If this project wildly succeeds, what changes?" If the
   codebase already exists, read it first and present your understanding, then push beyond
   it: "This is what exists. Where does it want to go?"
2. **Find the people** — "Who specifically reaches for this? Describe a person — what's
   their day like, what frustrates them, what moment makes them think 'I need this'?"
   Push for concrete personas, not abstract user categories.
3. **Find the principles** — "What principles should guide every decision? What do you
   optimize for? What do you resist?" If a decision profile exists, propose principles
   derived from it and let the user adjust.
4. **Set the direction** — "Where is this heading? Not specific features — what kind of
   capabilities should it grow toward? What's the long game?"
5. **Write VISION.md** — synthesize the answers into an aspirational north star document.
   The tone should be evocative, not clinical. Present it to the user for approval
   before writing.

When **refining** an existing vision, read the current VISION.md first, show the user what
you'd change and why, and get confirmation before writing.

After the brainstorm completes, proceed to cycle 1 (or resume cycling if this was a refinement).

---

## The cycle

### Step 1: Orient

Read the project state to understand where things stand. If PROGRESS.md exists and has 3+
cycles, run the analytics script first for a structured overview:

```bash
python3 -m scripts.analyze_progress --progress PROGRESS.md --pretty
```

The script (in `scripts/analyze_progress.py`) outputs JSON with velocity, work type
distribution, inspiration rate, and pattern-based suggestions. Use this to inform work
selection — e.g., if the output shows no test cycles, that's a signal.

1. **PROGRESS.md** — what happened last cycle, what was suggested next
2. **VISION.md** — the north star, principles, and direction
3. **ISSUES.md** — what's broken or degraded
4. **Decision profile** — run the effective profile script for a confidence-weighted summary:
   ```bash
   python3 -m scripts.effective_profile
   ```
   Run from the profilera skill directory (typically
   `~/.claude/plugins/marketplaces/agent-skills/skills/profilera`).
   This outputs a summary table with effective confidence after dormancy decay.
   Use it to weight decisions: high effective confidence entries (0.65+) are strong
   constraints, low effective confidence entries (<0.45) are suggestions. Read full
   `~/.claude/profile/PROFILE.md` for complete rule details when needed.
   If the script or PROFILE.md is missing, proceed without persona grounding but flag it:
   "Consider running /profilera to generate a decision profile — it helps me make choices
   you'd agree with."
5. **Project discovery** (cycle 1 or when unfamiliar):
   - Map the directory structure
   - Read dependency manifests (package.json, go.mod, Cargo.toml, pyproject.toml, etc.)
   - Read README, CLAUDE.md, AGENTS.md if they exist
   - Identify the build/test/lint commands
   - Read key source files to understand architecture
6. `git log --oneline -20` for recent changes

### Step 2: Pick work

Choose **one** focused increment. There is no backlog — the agent decides what to build by
reasoning about the gap between the vision and the current state of the codebase, weighted
against known issues.

The decision each cycle: **build toward the vision, or fix something broken?**

Consult the decision profile. Weigh the severity of open issues against the value of the
most promising next step toward the vision. A critical bug trumps a new feature. A minor
style nit doesn't block meaningful progress. Use judgment — that's what the decision
profile is for.

**When building toward the vision:**
- Read the codebase and PROGRESS.md to understand what exists
- Read VISION.md to understand the direction
- Identify the gap: what capability, pattern, or quality is missing that would move the
  project closer to its north star?
- Pick the smallest increment that closes the most valuable part of that gap

**When fixing issues:**
- Pick from ISSUES.md, prioritizing by severity (broken > degraded > annoying)

**When the work is optimization-shaped:**
- If the increment is about improving a measurable metric (e.g., "speed up test suite by 30%",
  "reduce bundle size"), consider delegating to `/optimera` instead. Realisera builds;
  optimera tunes.

Write a 1-2 sentence rationale. Scope down aggressively — one focused increment per cycle.

### Step 3: Seek inspiration

Before planning the implementation, proactively search for relevant external approaches.

1. **Assess** — is this a problem others have likely solved well? Bug fixes and mechanical
   changes rarely benefit from inspiration. New features, architecture decisions, and
   unfamiliar domains do.
2. **Search** — use web search to find libraries, articles, repos, or patterns addressing
   similar problems. Cast a focused net: 2-3 targeted queries.
3. **Analyze** — if something promising surfaces, read it deeply (the way /inspirera would):
   understand its core approach, identify what's transferable, assess what doesn't apply.
   Note the source so it can be credited in PROGRESS.md.
4. **Integrate** — fold applicable patterns into the plan. Record what you found and why
   it's relevant.

This step is about finding better approaches, not about being exhaustive. If nothing useful
turns up quickly, move on. The goal is to avoid reinventing wheels, not to do a literature
review.

### Step 4: Plan

Write a concrete plan:

- What changes, in which files
- What the expected behavior is after the change
- How to verify it works
- Any inspiration that informed the approach

Read the files you plan to modify before committing to the plan. If documentation should be
updated first (docs define intent, code implements it), include that in the plan.

The plan should be small enough for one implementation agent to execute in a single session.
If it's too large, split it and save the rest for the next cycle.

### Step 5: Dispatch

Spawn a Sonnet implementation agent in a worktree (`isolation: "worktree"`) with:

- The plan from step 4
- Relevant context files (architecture docs, decision profile, source files being modified)
- Clear constraint: implement the plan and nothing else

```
You are implementing a focused change for [project].

## Task
[The plan]

## Constraints
- Implement ONLY what the plan describes. No scope creep.
- Follow existing code patterns and conventions.
- Read the files you are modifying before changing them.
- If docs need updating, update them before the code.
- Run the project's test/build suite before declaring done.
- If you encounter a bug unrelated to your task, note it but do not fix it.
```

For non-trivial design decisions, spawn an Opus agent first for the design, then a Sonnet
agent for the implementation.

Wait for all dispatched agents to complete before proceeding.

### Step 6: Verify

After implementation completes:

1. **Check the diff** — does it match the plan? Any unplanned changes?
2. **Run the project's verification suite** — use whatever the project provides:
   - Look for a top-level `check`, `ci`, `test`, or `verify` target first (Makefile, mage,
     package.json scripts, taskfile, justfile)
   - If none exists, run the language-appropriate defaults:
     Go: `go test ./... && go vet ./...`
     Node: `npm test`
     Python: `pytest`
     Rust: `cargo test && cargo clippy`
3. **Functional check** — does the changed behavior actually work end-to-end?
4. **Regression check** — do existing tests still pass?

If verification fails:
- Diagnose the root cause (never retry blindly)
- Spawn a fix agent with the diagnosis
- Re-verify after fix

### Step 7: Commit

Once verified, commit with a conventional commit message:

```
type(scope): summary
```

- Types: `feat`, `fix`, `docs`, `refactor`, `chore`, `test`
- Include all related files (code + docs + tests)
- Never commit partial or broken work
- Never push to remote — local commits only

### Step 8: Log

- **ISSUES.md** — add newly discovered issues, mark resolved ones
- **PROGRESS.md** — append the cycle entry (number, timestamp, what shipped, commit hash,
  inspiration, discoveries, next suggestion)

Then stop. One cycle complete.

---

## Safety rails

<critical>

- NEVER push to any remote. Local commits only.
- NEVER bypass the project's test/lint/build suite. Full verification before committing.
- NEVER modify git config or skip git hooks.
- NEVER force push, amend published commits, or run destructive git operations.
- NEVER add placeholder data or functionality. All code must be real and functional.
- NEVER modify files outside the project directory.
- NEVER modify VISION.md during a cycle. Only touch it during a brainstorm (bootstrap or
  user-requested refinement).
- One cycle per invocation. Do not attempt multiple cycles.

</critical>

---

## Handling blocked work

If the chosen work is blocked (ambiguous requirement, missing dependency, decision too
consequential to make autonomously):

1. Log the blocker in ISSUES.md with context and what decision is needed
2. Log the skipped attempt in PROGRESS.md
3. Pick different work and complete a full cycle on that instead

Never waste a cycle. If the first pick is blocked, pivot.

---

## Cross-skill integration

Realisera is part of a nine-skill ecosystem. Each skill can invoke the others when the work
calls for it.

### Realisera defers to /visionera for vision creation
When visionera is installed and VISION.md doesn't exist, suggest `/visionera` for deep vision
creation instead of running the built-in quick brainstorm. If visionera is NOT installed,
the built-in brainstorm works as a standalone fallback. When the user asks to refine the
vision, defer to `/visionera` if installed. Both skills produce the same VISION.md format.

### Realisera delegates to /optimera
When the picked work is optimization-shaped — improving a measurable metric like test performance,
bundle size, latency, or coverage — delegate to optimera instead of implementing directly.
Realisera provides the context; optimera runs the metric-driven experiment loop.

### Realisera uses /inspirera
In Step 3 (Seek inspiration), search for external approaches the way /inspirera would: read
the source deeply, extract transferable patterns, note the source for credit in PROGRESS.md.
For deeper analysis, run `/inspirera <url>` directly.

### Realisera reads /profilera output
Every cycle runs the effective profile script (`python3 -m scripts.effective_profile` from the
profilera skill directory) to get a confidence-weighted summary table. High effective confidence
entries are treated as strong constraints; low effective confidence entries are treated as
suggestions. Full rules are read from `~/.claude/profile/PROFILE.md` when needed for detailed
reasoning about trade-offs and priorities.

### Realisera uses /resonera for complex decisions
When the brainstorm session or work selection surfaces a decision too complex for inline
resolution — competing architectural approaches, ambiguous scope, or consequential tradeoffs —
suggest `/resonera` to deliberate first. Resonera can produce or refine VISION.md directly,
and its DECISIONS.md entries give realisera reasoning context for future cycles. If
`DECISIONS.md` exists, read it during the Orient step for context on prior deliberations.

### Realisera consumes /planera plans
When PLAN.md exists with pending tasks, realisera's Step 2 (Pick work) reads the plan instead
of reasoning from the vision. Pick the next pending task with satisfied dependencies. Use the
task's behavioral acceptance criteria as exit conditions. After committing, update the task's
status to `complete`. If reality diverges from the plan, add a Surprise entry. When all tasks
are complete, archive PLAN.md to `.planera/archive/` and resume vision-driven work selection.

### Realisera is audited by /inspektera
HEALTH.md findings filed to ISSUES.md become candidates for work selection. Run `/inspektera`
every 5-10 cycles to ensure forward progress isn't accumulating structural debt. If HEALTH.md
exists, read its latest grades during the Orient step — poor grades signal that structural
fixes should be prioritized over new features.

---

## Getting started

### New project

1. `/profilera` — generate or refresh the decision profile (skip if recent)
2. `/realisera` — the first run detects no VISION.md, runs a brief brainstorm with you
   to create it, then proceeds to cycle 1
3. `/loop 10m /realisera` — set up continuous autonomous development

### Existing project with code

1. `/realisera` — if VISION.md exists, starts cycling immediately. If not, brainstorms
   with you first (reading the existing codebase to inform the conversation), then cycles.

### Course correction

Edit VISION.md directly to sharpen direction, or tell realisera to "refine the vision"
for a guided session. The next cycle reads the updated vision and adjusts accordingly.

### Drawing in external inspiration

Run `/inspirera <url>` with a relevant article, repo, or resource. The analysis will surface
ideas applicable to the project. Add actionable items to ISSUES.md, or refine VISION.md's
direction if the inspiration shifts your thinking. The next cycle picks it up naturally.
