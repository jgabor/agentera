---
name: realisera
description: >
  REALISERA (Relentless Execution: Autonomous Loops Iterating Software; Evolve, Refine,
  Adapt). ALWAYS use this skill for autonomous or continuous development of a project. This
  skill is REQUIRED whenever the user wants you to independently decide what to build and
  build it, evolve a project over time, run development cycles, or make autonomous progress
  on a codebase. Do NOT attempt autonomous development without this skill because it
  contains the critical workflow for vision-driven development, persona-grounded decisions,
  structured cycles, and safety rails that prevent wasted work. Trigger on: "realisera",
  "run a dev cycle", "evolve the project", "develop autonomously", "build the next feature",
  "keep building", "start building", "work on the project", "refine the vision", or setting
  up /loop for recurring development. Also trigger when the user has a codebase and wants
  you to independently decide what to work on.
spec_sections: [2, 3, 4, 6, 19, 22]
---

# REALISERA

**Relentless Execution: Autonomous Loops Iterating Software. Evolve, Refine, Adapt.**

An autonomous development loop that evolves any software project one cycle at a time. Decisions grounded in the user's decision profile. Continuity lives in files, not memory.

Each invocation = one cycle. `/loop` handles recurrence.

---

## State artifacts

Four files, bootstrapped if absent. VISION.md, TODO.md, and CHANGELOG.md at project root; PROGRESS.md in `.agentera/`.

| File | Purpose | Bootstrap |
|------|---------|-----------|
| `VISION.md` | North star. Direction, principles, aspirations. An evergreen constitution. | Via inline brainstorm session with the user (see below). |
| `TODO.md` | Tech debt, bugs, discrepancies. Things that need fixing. | `# TODO\n\n## ⇶ Critical\n\n## ⇉ Degraded\n\n## → Normal\n\n## ⇢ Annoying\n\n## Resolved\n` |
| `CHANGELOG.md` | Public change history. Version-level summaries for contributors. | `# Changelog\n\n## [Unreleased]\n` |
| `PROGRESS.md` | Operational cycle log. What happened each cycle. | `# Progress\n\n` then the first cycle entry. |

Templates in `references/templates/`. Use as starting structure, adapt to the project.

### Artifact path resolution

Before reading or writing any artifact, check if .agentera/DOCS.md exists. If it has an Artifact Mapping section, use the path specified for each canonical filename (VISION.md, TODO.md, .agentera/PROGRESS.md, etc.). If .agentera/DOCS.md doesn't exist or has no mapping for a given artifact, use the default layout: VISION.md, TODO.md, and CHANGELOG.md at the project root; all other artifacts in .agentera/. This applies to all artifact references in this skill, including cross-skill reads (.agentera/DECISIONS.md, .agentera/HEALTH.md, .agentera/PLAN.md).

### Contract

Before starting, read `references/contract.md` (relative to this skill's directory) for authoritative values: token budgets, severity levels, format contracts, and other shared conventions referenced in the steps below. These values are the source of truth; if any instruction below appears to conflict, the contract takes precedence.

### VISION.md

Evergreen. Created via brainstorm on first run, refined only when the user explicitly asks. Outside those two cases, the agent reads it but never writes it. A constitution, not a backlog. Typical structure:

```markdown
# [Project Name]

## North Star
[The dream. What this software makes possible, not just what it does. Paint a
picture of the world where this project has succeeded. What does it feel like to
use? What changes for the people who have it? Be ambitious.]

## Who It's For
[Concrete personas. Not "developers" but specific people with specific days,
specific frustrations, specific workflows. Who reaches for this tool and why?]

## Principles
- [Core principles that guide every decision]
- [What to optimize for, what to resist]

## Direction
[Where this project is heading. The kind of capabilities it should grow toward.
Aspirational, not prescriptive.]

## Identity
[What this project IS as an entity: personality, voice, emotional register, naming.]
```

The vision must be ambitious enough to sustain months of development, personas concrete enough to resolve "who is this for?" debates, and direction clear enough to derive next steps from the gap between vision and codebase.

### PROGRESS.md

```markdown
■ ## Cycle N · YYYY-MM-DD HH:MM

**What**: one-line summary of what shipped
**Commit**: <hash> <message>
**Inspiration**: what external source informed the approach (if any)
**Discovered**: issues or ideas found (also logged in TODO.md)
**Verified**: observed output from running the primary entrypoint against real project state, OR `N/A: <tag>` from the Section 19 allowlist, OR a free-form rationale of at least 8 words explaining why the change has no observable behavior
**Next**: what seems most valuable to work on next
**Context**: intent · constraints · unknowns · scope
```

The `**Verified**` field is mandatory for every cycle entry per contract Section 19, Reality Verification Gate. See Step 6 for how it is populated.

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

## [version] · YYYY-MM-DD

### Added
- description
```

Realisera appends entries under `## [Unreleased]` based on commit type: `feat` → Added, `refactor/chore` → Changed, `fix` → Fixed. On version bumps, promote the Unreleased section to a versioned heading.

---

## Brainstorm: bootstrapping or refining VISION.md

This runs in two situations:

1. **VISION.md doesn't exist**: the first time realisera runs on a project
2. **User explicitly asks** to refine the vision (e.g., "refine the vision", "update VISION.md")

In all other cases, skip straight to the cycle.

### How the brainstorm works

The sharp colleague, here to build. Brief, focused conversation. One question at a time. Push for ambition: bigger than "a tool that does X." Ask the user to dream.

1. **Understand the dream**: "Not what the software does, but what does it make possible? If this wildly succeeds, what changes?" If code exists, read it first, present your understanding, then push beyond: "This is what exists. Where does it want to go?"
2. **Find the people**: "Who reaches for this? Describe a person: their day, their frustrations, the moment they think 'I need this'?" Push for concrete personas.
3. **Find the principles**: "What principles guide every decision? What do you optimize for? What do you resist?" If a decision profile exists, propose principles from it.
4. **Set the direction**: "Where is this heading? Not features, but what capabilities should it grow toward?"
5. **Write VISION.md**: synthesize into an aspirational north star. Tone: evocative, not clinical. Present for approval before writing.

Artifact writing follows contract Section 23 (Artifact Writing Conventions): banned verbosity patterns, 25-word sentence cap, preferred vocabulary, and lead-with-conclusion structure.

When **refining**, read current VISION.md, show proposed changes with rationale, get confirmation before writing. After brainstorm, proceed to cycle 1 (or resume cycling).

---

## The cycle

Skill introduction: `─── ⧉ realisera · cycle N ───`

Throughout the cycle, the sharp colleague is building: direct about what's happening, honest about what's not working, brief about what's routine. Structured outputs stay structured; the framing around them should read like a colleague's working notes.

Step markers: display `── step N/8: verb` before each step.
Steps: orient, select, research, plan, dispatch, verify, commit, log.

### Step 1: Orient

Read VISION.md, PROGRESS.md, TODO.md, and HEALTH.md in parallel. These reads are independent; issue all in a single response.

If PROGRESS.md has 3+ cycles, run the analytics script first:

```bash
python3 scripts/analyze_progress.py --progress PROGRESS.md --pretty
```

Outputs JSON with velocity, work type distribution, and suggestions. Use to inform work selection (e.g., no test cycles is a signal).

1. **PROGRESS.md**: what happened last cycle, what was suggested next
2. **VISION.md**: read `## Principles` and `## Direction` sections (skip full personas/history for orient)
3. **TODO.md**: what's broken or degraded
3b. **HEALTH.md**: read `critical` and `degraded` findings only (if exists)
3c. **DECISIONS.md**: read all entries (if exists). `firm` entries are hard constraints. `provisional` entries are strong defaults. Note any `exploratory` entries, as these are uncertain foundations that may need firming up before building on them.
4. **Decision profile**: run from the profilera skill directory:

   ```bash
   python3 scripts/effective_profile.py
   ```

   Apply confidence thresholds per contract profile consumption conventions. Read full profile from `$PROFILERA_PROFILE_DIR/PROFILE.md` (default: `$XDG_DATA_HOME/agentera/PROFILE.md`) for details when needed. <!-- platform: profile-path --> If missing, proceed without persona grounding but flag it.
5. **Project discovery** (cycle 1 or when unfamiliar):
   - Map the directory structure
   - Read dependency manifests (package.json, go.mod, Cargo.toml, pyproject.toml, etc.)
   - Read README.md, CLAUDE.md, AGENTS.md if they exist
   - Identify the build/test/lint commands
   - Read key source files to understand architecture
6. `git log --oneline -20` for recent changes

Before proceeding: in your response, list the 3-5 facts from VISION.md, PROGRESS.md, TODO.md, and HEALTH.md that will determine what you build this cycle. These survive if earlier tool results are cleared by context compaction.

Also read the prior cycle's Context block from PROGRESS.md. It captures what the last cycle intended, what was uncertain, and what scope it expected to touch. Use this for cross-cycle continuity.

**Exit-early guard (plan-driven mode only)**: If PLAN.md exists and all tasks are `■ complete` or `skipped`, and no new tasks have been added, perform a **plan-completion sweep** before archiving. This guard does NOT apply in vision-driven mode because realisera always has work when reasoning from the gap between vision and codebase.

The plan-completion sweep closes the structural freshness gap that existed when the guard simply archived without running Step 8. Sweep checklist:

1. **PROGRESS.md aggregate cycle entry**: append a cycle entry whose **What** field summarizes the entire plan's work (not just the last task), whose **Commits** field lists the plan's commits in order (use `git log` since the plan's `Created` date), whose **Discovered** field captures any cross-task surprises from `## Surprises`, and whose **Next** field states the next milestone or vision-driven direction. Apply the standard PROGRESS.md compaction thresholds.
2. **CHANGELOG.md plan-level entries**: verify the `## [Unreleased]` section has at least one Added/Changed/Fixed line covering each completed task's user-facing impact. If entries are missing, append them based on the task titles and acceptance criteria (one short line per task, not commit messages verbatim). If the plan included a version bump task, promote `[Unreleased]` to a versioned heading with today's date.
3. **TODO.md milestone advance**: mark each plan task as a Resolved entry (referencing the commits), and advance the active milestone to the next planned version. If this was the last planned version, remove the active-milestone line and let realisera resume vision-driven work.
4. **HEALTH.md cross-reference**: if the plan resolved any prior HEALTH.md findings, mention them in the new PROGRESS.md cycle entry's **Discovered** field so the next inspektera audit can mark them resolved.

If the plan contains a "Plan-level freshness checkpoint" task (per the planera convention), that task's acceptance criteria are the authoritative contract: verify each one is met. If the plan was created before the checkpoint convention landed and has no such task, perform the sweep on a best-effort basis: warn (don't fail) on missing entries, append them where possible, and note the gap in the cycle entry so future audits see it.

Only after the sweep completes does the guard archive PLAN.md to `.agentera/archive/PLAN-{date}.md` and report exit signal `complete: plan finished`. Do not proceed to Step 2.

### Step 2: Pick work

Choose **one** focused increment. No backlog; decide by reasoning about the gap between vision and codebase, weighted against known issues.

Each cycle: **build toward the vision, or fix something broken?** Consult the decision profile. A critical bug trumps a new feature; a minor nit doesn't block progress.

**Building toward vision:** Read codebase + VISION.md, identify the gap, pick the smallest increment closing the most valuable part.

**Fixing issues:** Pick from TODO.md by severity (broken > degraded > annoying).

**Optimization-shaped work:** Delegate to `/optimera` for measurable metrics (speed, size,
coverage). Realisera builds; optimera tunes.

Write a 1-2 sentence rationale. Scope down aggressively.

Compose a Context block for this cycle: intent (what and why, one line), constraints (what must not break), unknowns (open questions or uncertain foundations), scope (areas expected to be affected). ≤80 words total. This is written to PROGRESS.md in Step 8.

**Decision gate**: After selecting work, check whether any `exploratory` entries in DECISIONS.md relate to the selected work area. If found: flag the uncertain foundation, suggest `/resonera` to firm up the decision, and note the risk in the cycle's Context unknowns field. In autonomous mode, proceed with the work but log the risk without hard-blocking. If no DECISIONS.md exists or no exploratory entries relate, this gate is a no-op.

### Step 3: Seek inspiration

Search for relevant external approaches before planning.

1. **Assess**: bug fixes rarely benefit from inspiration. New features, architecture decisions, and unfamiliar domains do.
2. **Search**: 2-3 targeted web queries for libraries, articles, repos, or patterns.
3. **Analyze**: read promising finds deeply: core approach, transferable patterns, inapplicable parts. Note the source for PROGRESS.md credit.
4. **Integrate**: fold applicable patterns into the plan.

Goal: avoid reinventing wheels. If nothing useful turns up quickly, move on.

### Step 4: Plan

Write a concrete plan: what changes in which files, expected behavior, verification approach, and any inspiration that informed it.

Read files you plan to modify before committing to the plan. If docs should update first (docs define intent, code implements it), include that.

Keep small enough for one agent session. Too large? Split and save the rest for next cycle.

### Step 5: Dispatch

**Pre-dispatch commit gate** (per contract Section 22): before creating the worktree, commit any pending artifact changes so the subagent branches from current state.

1. Run `git status --porcelain`. If empty, the working tree is clean: skip to dispatch.
2. Stage only the artifact files this session wrote (e.g., `git add .agentera/PLAN.md .agentera/PROGRESS.md`). Do not use `git add -A` or `git add .`.
3. Commit with `chore(realisera): checkpoint before worktree dispatch`. Do not pass `--no-verify`.
4. If pre-commit hooks reject the commit: fix the artifact validation error, re-stage, and retry. If the retry also fails, abort the dispatch and report the failure. Do not proceed with a worktree branching from stale state.

**Stale-base awareness**: some harnesses create the worktree branch from `origin/main` (or the configured remote default) rather than from local `HEAD`. Before dispatch, run `git rev-list --count origin/main..HEAD`. If the count is greater than zero, the worktree will be based on a stale commit and the sub-agent will verify against out-of-date code. Proceed with dispatch, but in Step 6 do NOT merge the worktree branch: fetch the sub-agent's diff with `git -C <worktree> diff` (including both staged and unstaged changes) and apply it to the main checkout via `git apply --index -`. Re-run the project's verification suite in the main checkout so the numbers reflect HEAD, not the stale base. If the patch does not apply cleanly, the sub-agent's change touched a file that diverged between `origin/main` and HEAD; diagnose and resolve before committing.

Spawn an implementation sub-agent in a worktree (`isolation: "worktree"`) <!-- platform: sub-agent-dispatch --> with:

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
- Verify the change works as described, then run the project's test/build suite.
- If you encounter a bug unrelated to your task, note it but do not fix it.
```

For non-trivial design decisions, spawn a design sub-agent first, then an implementation sub-agent. Wait for all dispatched agents to complete before proceeding.

### Step 6: Verify

Verification has two phases per contract Section 19, Reality Verification Gate: structural (tests, lint, build are green) and behavioral (the new feature was actually observed running against real project state). Both phases must pass before the cycle can advance to commit. Passing tests alone are necessary but not sufficient evidence that the work is real.

**Dispatch boundary**: If Step 5 dispatched a sub-agent to implement the work in a worktree <!-- platform: sub-agent-dispatch -->, verification runs in realisera's main checkout AFTER the worktree has been merged, not inside the worktree. The sub-agent implements; realisera verifies post-merge. Dispatched agents cannot self-attest verification.

**Phase A, structural verification**: After implementation completes:

1. **Check the diff**: does it match the plan? Any unplanned changes?
2. **Functional check**: does the changed behavior actually work end-to-end?
3. **Run the project's verification suite** (test/build/lint): use whatever the project provides:
   - Look for a top-level `check`, `ci`, `test`, or `verify` target first (Makefile, mage,
     package.json scripts, taskfile, justfile)
   - If none exists, run the language-appropriate defaults:
     Go: `go test ./... && go vet ./...`
     Node: `npm test`
     Python: `pytest`
     Rust: `cargo test && cargo clippy`
   - Confirms both new behavior and existing tests still pass.

**Phase B, behavioral verification (Reality Verification Gate)**: Once structural verification is green, observe the new behavior by running the project's primary entrypoint against real project state. The primary entrypoint depends on the project archetype per contract Section 19:

- CLI tool: invoke the binary with realistic arguments
- Library / SDK: run a smoke driver that exercises the public API touched by the change
- Web service: send a request to a production-shaped endpoint
- Skill repo: dispatch the skill via the runtime's eval mechanism (for agentera, `python3 scripts/eval_skills.py --skill <name>`)
- Design system: render a representative component against real design tokens
- Data pipeline: run the pipeline against a real input sample (not synthetic fixtures)

Projects whose archetype is not listed above carry a `verification_entrypoint` key in `.agentera/DOCS.md`. If a `verification_budget` key is set and the budget is exhausted, downgrade to `**Verified**: partial (budget hit)` with a note capturing what was attempted, what was observed, and which portions remain unverified.

Capture the observation: a short transcript (stdout/stderr snippets), exit code, or summary of what happened. The transcript should be concrete enough that a reader can tell whether the behavior actually happened. This capture populates the `**Verified**` field in the PROGRESS.md cycle entry written in Step 8.

**N/A path**: If the cycle has no runnable behavior change, populate `**Verified**` with `N/A: <tag>` using exactly one of the five enumerated allowlist tags from Section 19:

- `docs-only`: the change touched only documentation with no code path affected
- `refactor-no-behavior-change`: the change restructured code but preserved observable behavior exactly
- `chore-dep-bump`: the change updated a dependency version without modifying code that calls it differently
- `chore-build-config`: the change modified build tooling, linter configuration, or packaging metadata
- `test-only`: the change added or adjusted tests without modifying the code under test

Any N/A justification outside the allowlist must be a free-form prose rationale of at least 8 words explaining specifically why the change has no observable behavior. Shorter rationales fail the gate. A cycle that bundles runnable work with an N/A-tagged change still requires observed output for the runnable portion; the tag covers only the non-runnable slice.

If verification fails (structural or behavioral):

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
- Never push to remote. Local commits only.

If the current task is a version bump (e.g., a PLAN.md task labeled "Version bump per DOCS.md convention", or a version-staleness finding picked up from TODO.md): read DOCS.md for the `versioning` section. It lists `version_files` (files to update) and `semver_policy` (how to determine the bump level from conventional commit types). Update every file in `version_files` to the new version number, then include those files in the commit. If DOCS.md has no `versioning` section, skip version management entirely.

### Step 8: Log

**Dual-write**: realisera maintains two change records, `.agentera/PROGRESS.md` (operational cycle detail for consuming skills) and `CHANGELOG.md` (public summary for project contributors).

- **TODO.md**: add newly discovered issues, mark resolved ones. Classify each entry by severity per contract severity levels. When updating existing entries (e.g., marking resolved), use the Edit tool on the specific entry rather than rewriting the file.
  Output constraint per contract token budgets.
  When marking an item resolved, compact the `## Resolved` section via the script. Run: `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/compact_artifact.py todo-resolved <path-to-TODO.md>`.
- **.agentera/PROGRESS.md**: append the cycle entry (number, timestamp, what shipped, commit hash, inspiration, discoveries, verified observation from Step 6, next suggestion, context block (intent, constraints, unknowns, scope)). The `**Verified**` field is mandatory per contract Section 19; it carries either Step 6's observed output from the primary entrypoint, an allowlisted `N/A: <tag>`, or a free-form rationale of at least 8 words. Write the entry like a colleague's quick debrief: what happened, what surprised you, what's next. Not a form submission.
  Output constraint per contract token budgets.
- **CHANGELOG.md**: append a one-line entry under `## [Unreleased]` in the appropriate subsection: `feat` → Added, `refactor/chore` → Changed, `fix` → Fixed. Concise description, not the commit message verbatim.

After appending a new cycle to PROGRESS.md, compact older entries via the script. Run: `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/compact_artifact.py progress <path-to-PROGRESS.md>`.

Artifact writing follows contract Section 23 (Artifact Writing Conventions): banned verbosity patterns, 25-word sentence cap, preferred vocabulary, and lead-with-conclusion structure.

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

- **complete**: One full cycle completed. Work was selected, implemented, verified against the project's test/build suite, committed with a conventional message, and PROGRESS.md and TODO.md were updated.
- **flagged**: The cycle completed but with notable issues. Possible causes: verification passed but with warnings, the committed work is narrower than intended due to scope reduction, or discoveries logged in PROGRESS.md suggest the next cycle may face blockers.
- **stuck**: Cannot complete a cycle because VISION.md does not exist and the brainstorm cannot proceed without the user, every available work item is blocked (missing dependencies, ambiguous requirements, decisions too consequential to make autonomously), or the verification suite is broken and cannot be fixed within the cycle's scope.
- **waiting**: The project has no VISION.md and no codebase to infer direction from, or the user's explicit instruction for what to build is too ambiguous to act on without clarification.

Before reporting any status, inspect the last 3 entries in PROGRESS.md. If all 3 entries record failed cycles (commits that were reverted, cycles that logged a blocker and pivoted 3 times consecutively, or cycles whose "Discovered" field logs the same issue that was supposed to be fixed), this constitutes 3 consecutive failures: **stop**, log the failure pattern to TODO.md with what was attempted and what the skill believes is wrong, and surface the situation to the user with a recommended course of action (e.g., "/resonera to deliberate on the approach", "manual investigation needed", "dependency missing"). Do not attempt a 4th consecutive cycle on the same failing problem.

---

## Cross-skill integration

Realisera is part of a twelve-skill suite. Each skill can invoke the others when the work calls for it.

### Realisera defers to /visionera for vision creation

When visionera is installed and VISION.md doesn't exist, suggest `/visionera` for deep vision creation instead of running the built-in quick brainstorm. If visionera is NOT installed, the built-in brainstorm works as a standalone fallback. When the user asks to refine the vision, defer to `/visionera` if installed. Both skills produce the same VISION.md format.

### Realisera delegates to /optimera

When the picked work is optimization-shaped (improving a measurable metric like test performance, bundle size, latency, or coverage), delegate to optimera instead of implementing directly. Realisera provides the context; optimera runs the metric-driven experiment loop.

### Realisera uses /inspirera

In Step 3 (Seek inspiration), search for external approaches the way /inspirera would: read the source deeply, extract transferable patterns, note the source for credit in PROGRESS.md. For deeper analysis, run `/inspirera <url>` directly.

### Realisera reads /profilera output

Every cycle runs the effective profile script (`python3 scripts/effective_profile.py` from the profilera skill directory) to get a confidence-weighted summary table. Confidence thresholds per contract profile consumption conventions determine which entries are strong constraints vs suggestions. Full rules are read from `$PROFILERA_PROFILE_DIR/PROFILE.md` (default: `$XDG_DATA_HOME/agentera/PROFILE.md`) when needed for detailed reasoning about trade-offs and priorities. <!-- platform: profile-path -->

### Realisera uses /resonera for complex decisions

When the brainstorm session or work selection surfaces a decision too complex for inline resolution (competing architectural approaches, ambiguous scope, or consequential tradeoffs), suggest `/resonera` to deliberate first. Resonera can produce or refine VISION.md directly, and its DECISIONS.md entries give realisera reasoning context for future cycles. If `DECISIONS.md` exists, read it during the Orient step for context on prior deliberations.

### Realisera consumes /planera plans

When PLAN.md exists with `□ pending` tasks, realisera's Step 2 (Pick work) reads the plan instead of reasoning from the vision. Pick the next `□ pending` task with satisfied dependencies. Use the task's behavioral acceptance criteria as exit conditions. After committing, use the Edit tool to update the task's status to `■ complete` (targeted edit, not full file rewrite). If reality diverges from the plan, add a Surprise entry. When all tasks are complete, archive PLAN.md to `.agentera/archive/` and resume vision-driven work selection.

### Realisera reads /dokumentera output

DOCS.md provides artifact path resolution that realisera checks before reading or writing any artifact. In the DTC pipeline, dokumentera writes intent docs that feed planera, which feeds realisera.

### Realisera reads /visualisera output

DESIGN.md provides visual identity context (design tokens, constraints) that realisera respects when building user-facing features.

### Realisera is audited by /inspektera

HEALTH.md findings filed to TODO.md become candidates for work selection. Run `/inspektera` every 5-10 cycles to ensure forward progress isn't accumulating structural debt. If HEALTH.md exists, read its latest grades during the Orient step. Poor grades signal that structural fixes should be prioritized over new features.
