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

An autonomous development loop that evolves any software project one cycle at a time.
Decisions grounded in the user's decision profile. Continuity lives in files, not memory.

Each invocation = one cycle. `/loop` handles recurrence.

---

## State artifacts

Four files, bootstrapped if absent. VISION.md, TODO.md, and CHANGELOG.md at project root; PROGRESS.md in `.agentera/`.

| File | Purpose | Bootstrap |
|------|---------|-----------|
| `VISION.md` | North star. Direction, principles, aspirations. An evergreen constitution. | Via inline brainstorm session with the user (see below). |
| `TODO.md` | Tech debt, bugs, discrepancies. Things that need fixing. | `# TODO\n\n## ⇶ Critical\n\n## ⇉ Degraded\n\n## ⇢ Annoying\n\n## Resolved\n` |
| `CHANGELOG.md` | Public change history. Version-level summaries for contributors. | `# Changelog\n\n## [Unreleased]\n` |
| `PROGRESS.md` | Operational cycle log. What happened each cycle. | `# Progress\n\n` then the first cycle entry. |

Templates in `references/templates/` — use as starting structure, adapt to the project.

### Artifact path resolution

Before reading or writing any artifact, check if .agentera/DOCS.md exists. If it has an
Artifact Mapping section, use the path specified for each canonical filename (VISION.md,
TODO.md, .agentera/PROGRESS.md, etc.). If .agentera/DOCS.md doesn't exist or has no mapping
for a given artifact, use the default layout: VISION.md, TODO.md, and CHANGELOG.md at the
project root; all other artifacts in .agentera/. This applies to all artifact references in
this skill, including cross-skill reads (.agentera/DECISIONS.md, .agentera/HEALTH.md,
.agentera/PLAN.md).

### VISION.md

Evergreen. Created via brainstorm on first run, refined only when the user explicitly asks.
Outside those two cases, the agent reads it but never writes it. A constitution, not a backlog.
Typical structure:

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

The vision must be ambitious enough to sustain months of development, personas concrete
enough to resolve "who is this for?" debates, and direction clear enough to derive next
steps from the gap between vision and codebase.

### PROGRESS.md

```markdown
■ ## Cycle N — YYYY-MM-DD HH:MM

**What**: one-line summary of what shipped
**Commit**: <hash> <message>
**Inspiration**: what external source informed the approach (if any)
**Discovered**: issues or ideas found (also logged in TODO.md)
**Next**: what seems most valuable to work on next
**Context**: intent · constraints · unknowns · scope
```

The "Next" field from the previous cycle is a suggestion, not a mandate. Re-evaluate fresh.

### CHANGELOG.md

Public-facing change history. Keep-a-changelog format:

```markdown
# Changelog

## [Unreleased]

### Added
- description

### Changed
- description

### Fixed
- description

## [version] — YYYY-MM-DD

### Added
- description
```

Realisera appends entries under `## [Unreleased]` based on commit type: `feat` → Added,
`refactor/chore` → Changed, `fix` → Fixed. On version bumps, promote the Unreleased section
to a versioned heading.

---

## Brainstorm: bootstrapping or refining VISION.md

This runs in two situations:
1. **VISION.md doesn't exist** — the first time realisera runs on a project
2. **User explicitly asks** to refine the vision (e.g., "refine the vision", "update VISION.md")

In all other cases, skip straight to the cycle.

### How the brainstorm works

Brief, focused conversation. One question at a time. Push for ambition — bigger than
"a tool that does X." Ask the user to dream.

1. **Understand the dream** — "Not what the software does — what does it make possible?
   If this wildly succeeds, what changes?" If code exists, read it first, present your
   understanding, then push beyond: "This is what exists. Where does it want to go?"
2. **Find the people** — "Who reaches for this? Describe a person — their day, their
   frustrations, the moment they think 'I need this'?" Push for concrete personas.
3. **Find the principles** — "What principles guide every decision? What do you optimize
   for? What do you resist?" If a decision profile exists, propose principles from it.
4. **Set the direction** — "Where is this heading? Not features — what capabilities should
   it grow toward?"
5. **Write VISION.md** — synthesize into an aspirational north star. Tone: evocative, not
   clinical. Present for approval before writing.

When **refining**, read current VISION.md, show proposed changes with rationale, get
confirmation before writing. After brainstorm, proceed to cycle 1 (or resume cycling).

---

## The cycle

Skill introduction: `─── ⧉ realisera · cycle N ───`

### Step 1: Orient

Read VISION.md, PROGRESS.md, TODO.md, and HEALTH.md in parallel — these reads are
independent, issue all in a single response.

If PROGRESS.md has 3+ cycles, run the analytics script first:

```bash
python3 scripts/analyze_progress.py --progress PROGRESS.md --pretty
```

Outputs JSON with velocity, work type distribution, and suggestions. Use to inform work
selection — e.g., no test cycles is a signal.

1. **PROGRESS.md** — what happened last cycle, what was suggested next
2. **VISION.md** — read `## Principles` and `## Direction` sections (skip full personas/history for orient)
3. **TODO.md** — what's broken or degraded
3b. **HEALTH.md** — read `critical` and `degraded` findings only (if exists)
3c. **DECISIONS.md** — read all entries (if exists). `firm` entries are hard constraints. `provisional` entries are strong defaults. Note any `exploratory` entries — these are uncertain foundations that may need firming up before building on them.
4. **Decision profile** — run from the profilera skill directory:
   ```bash
   python3 scripts/effective_profile.py
   ```
   Entries with effective confidence 65+ are strong constraints; <45 are suggestions.
   Read full `~/.claude/profile/PROFILE.md` for details when needed.
   If missing, proceed without persona grounding but flag it.
5. **Project discovery** (cycle 1 or when unfamiliar):
   - Map the directory structure
   - Read dependency manifests (package.json, go.mod, Cargo.toml, pyproject.toml, etc.)
   - Read README, CLAUDE.md, AGENTS.md if they exist
   - Identify the build/test/lint commands
   - Read key source files to understand architecture
6. `git log --oneline -20` for recent changes

Before proceeding: in your response, list the 3-5 facts from VISION.md, PROGRESS.md,
TODO.md, and HEALTH.md that will determine what you build this cycle. These survive if
earlier tool results are cleared by context compaction.

Also read the prior cycle's Context block from PROGRESS.md — it captures what the last
cycle intended, what was uncertain, and what scope it expected to touch. Use this for
cross-cycle continuity.

**Exit-early guard (plan-driven mode only)**: If PLAN.md exists and all tasks are `■ complete`
or `skipped`, and no new tasks have been added — archive the plan and report exit signal
`complete: plan finished`. Do not proceed to Step 2. This guard does NOT apply in
vision-driven mode — realisera always has work when reasoning from the gap between vision
and codebase.

### Step 2: Pick work

Choose **one** focused increment. No backlog — decide by reasoning about the gap between
vision and codebase, weighted against known issues.

Each cycle: **build toward the vision, or fix something broken?** Consult the decision
profile. A critical bug trumps a new feature; a minor nit doesn't block progress.

**Building toward vision:** Read codebase + VISION.md, identify the gap, pick the smallest
increment closing the most valuable part.

**Fixing issues:** Pick from TODO.md by severity (broken > degraded > annoying).

**Optimization-shaped work:** Delegate to `/optimera` for measurable metrics (speed, size,
coverage). Realisera builds; optimera tunes.

Write a 1-2 sentence rationale. Scope down aggressively.

Compose a Context block for this cycle: intent (what and why, one line), constraints (what
must not break), unknowns (open questions or uncertain foundations), scope (areas expected
to be affected). ≤80 words total. This is written to PROGRESS.md in Step 8.

**Decision gate**: After selecting work, check whether any `exploratory` entries in DECISIONS.md relate to the selected work area. If found: flag the uncertain foundation, suggest `/resonera` to firm up the decision, and note the risk in the cycle's Context unknowns field. In autonomous mode, proceed with the work but log the risk — do not hard-block. If no DECISIONS.md exists or no exploratory entries relate, this gate is a no-op.

### Step 3: Seek inspiration

Search for relevant external approaches before planning.

1. **Assess** — bug fixes rarely benefit from inspiration. New features, architecture
   decisions, and unfamiliar domains do.
2. **Search** — 2-3 targeted web queries for libraries, articles, repos, or patterns.
3. **Analyze** — read promising finds deeply: core approach, transferable patterns,
   inapplicable parts. Note the source for PROGRESS.md credit.
4. **Integrate** — fold applicable patterns into the plan.

Goal: avoid reinventing wheels. If nothing useful turns up quickly, move on.

### Step 4: Plan

Write a concrete plan: what changes in which files, expected behavior, verification
approach, and any inspiration that informed it.

Read files you plan to modify before committing to the plan. If docs should update first
(docs define intent, code implements it), include that.

Keep small enough for one agent session. Too large? Split and save the rest for next cycle.

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

For non-trivial design decisions, spawn Opus for design first, then Sonnet for implementation.
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

If the current task is a version bump (e.g., a PLAN.md task labeled "Version bump per DOCS.md
convention", or a version-staleness finding picked up from TODO.md): read DOCS.md for the
`versioning` section — it lists `version_files` (files to update) and `semver_policy` (how to
determine the bump level from conventional commit types). Update every file in `version_files`
to the new version number, then include those files in the commit. If DOCS.md has no
`versioning` section, skip version management entirely.

### Step 8: Log

**Dual-write**: realisera maintains two change records — `.agentera/PROGRESS.md` (operational
cycle detail for consuming skills) and `CHANGELOG.md` (public summary for project contributors).

- **TODO.md** — add newly discovered issues, mark resolved ones. When updating existing
  entries (e.g., marking resolved), use the Edit tool on the specific entry rather than
  rewriting the file.
  Output constraint: ≤30 words per issue description, ≤15 words per remediation.
- **.agentera/PROGRESS.md** — append the cycle entry (number, timestamp, what shipped, commit
  hash, inspiration, discoveries, next suggestion, context block (intent, constraints,
  unknowns, scope)).
  Output constraint: ≤50 words for cycle work summary, ≤30 words per discovered issue.
- **CHANGELOG.md** — append a one-line entry under `## [Unreleased]` in the appropriate
  subsection: `feat` → Added, `refactor/chore` → Changed, `fix` → Fixed. Concise description,
  not the commit message verbatim.

When writing a new cycle entry to .agentera/PROGRESS.md, check entry count. If >10 full-detail
entries exist, collapse the oldest to one-line format under `## Archived Cycles` (one line per
cycle: `Cycle N (YYYY-MM-DD): ≤15-word summary`). If >40 one-line entries exist in the archive,
drop the oldest. See ecosystem-spec.md Section 4 compaction thresholds.

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

If blocked (ambiguous requirement, missing dependency, decision too consequential):

1. Log blocker in TODO.md with context and decision needed
2. Log skipped attempt in PROGRESS.md
3. Pick different work and complete a full cycle on that instead

---

## Exit signals

Report one of these statuses at workflow completion:

Format: `─── ⧉ realisera · status ───` followed by a summary sentence.
For flagged, stuck, and waiting: add `▸` bullet details below the summary.

- **complete**: One full cycle completed: work was selected, implemented, verified against the project's test/build suite, committed with a conventional message, and PROGRESS.md and TODO.md were updated.
- **flagged**: The cycle completed but with notable issues: verification passed but with warnings, the committed work is narrower than intended due to scope reduction, or discoveries logged in PROGRESS.md suggest the next cycle may face blockers.
- **stuck**: Cannot complete a cycle because VISION.md does not exist and the brainstorm cannot proceed without the user, every available work item is blocked (missing dependencies, ambiguous requirements, decisions too consequential to make autonomously), or the verification suite is broken and cannot be fixed within the cycle's scope.
- **waiting**: The project has no VISION.md and no codebase to infer direction from, or the user's explicit instruction for what to build is too ambiguous to act on without clarification.

Before reporting any status, inspect the last 3 entries in PROGRESS.md. If all 3 entries record failed cycles — commits that were reverted, cycles that logged a blocker and pivoted 3 times consecutively, or cycles whose "Discovered" field logs the same issue that was supposed to be fixed — this constitutes 3 consecutive failures: **stop**, log the failure pattern to TODO.md with what was attempted and what the skill believes is wrong, and surface the situation to the user with a recommended course of action (e.g., "/resonera to deliberate on the approach", "manual investigation needed", "dependency missing"). Do not attempt a 4th consecutive cycle on the same failing problem.

---

## Cross-skill integration

Realisera is part of an eleven-skill ecosystem. Each skill can invoke the others when the work
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
Every cycle runs the effective profile script (`python3 scripts/effective_profile.py` from the
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
When PLAN.md exists with `□ pending` tasks, realisera's Step 2 (Pick work) reads the plan instead
of reasoning from the vision. Pick the next `□ pending` task with satisfied dependencies. Use the
task's behavioral acceptance criteria as exit conditions. After committing, use the Edit tool
to update the task's status to `■ complete` (targeted edit, not full file rewrite). If reality diverges from the plan, add a Surprise entry. When all tasks
are complete, archive PLAN.md to `.agentera/archive/` and resume vision-driven work selection.

### Realisera reads /dokumentera output
DOCS.md provides artifact path resolution that realisera checks before reading or writing
any artifact. In the DTC pipeline, dokumentera writes intent docs that feed planera, which
feeds realisera.

### Realisera reads /visualisera output
DESIGN.md provides visual identity context (design tokens, constraints) that realisera
respects when building user-facing features.

### Realisera is audited by /inspektera
HEALTH.md findings filed to TODO.md become candidates for work selection. Run `/inspektera`
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
ideas applicable to the project. Add actionable items to TODO.md, or refine VISION.md's
direction if the inspiration shifts your thinking. The next cycle picks it up naturally.
