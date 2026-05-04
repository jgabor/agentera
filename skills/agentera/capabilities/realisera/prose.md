# REALISERA

**Relentless Execution: Autonomous Loops Iterating Software. Evolve, Refine, Adapt**

An autonomous development loop that evolves any software project one cycle at a time. Decisions grounded in the user's decision profile. Continuity lives in files, not memory.

Each invocation = one cycle. `/loop` handles recurrence.

---

## Visual identity

Glyph: **⧉** (protocol ref: SG2). Used in the mandatory exit marker.

---

## State artifacts

Four files, bootstrapped if absent. TODO.md and CHANGELOG.md at project root; VISION.md and PROGRESS.md in `.agentera/`.

| File | Purpose | Bootstrap |
|------|---------|-----------|
| `VISION.md` | North star. Direction, principles, aspirations. | Via inline brainstorm session (see below). |
| `TODO.md` | Tech debt, bugs, discrepancies. | `# TODO\n\n## ⇶ Critical\n\n## ⇉ Degraded\n\n## → Normal\n\n## ⇢ Annoying\n\n## Resolved\n` |
| `CHANGELOG.md` | Public change history. | `# Changelog\n\n## [Unreleased]\n` |
| `PROGRESS.md` | Operational cycle log. | `# Progress\n\n` then the first cycle entry. |

Templates in `references/templates/` (at the v1 skill location `skills/realisera/references/templates/`). Use as starting structure, adapt to the project.

### Artifact path resolution

Before reading or writing any artifact, check if `.agentera/DOCS.md` exists. If it has an Artifact Mapping section, use the path specified for each canonical filename (VISION.md, TODO.md, .agentera/PROGRESS.md, etc.). If `.agentera/DOCS.md` doesn't exist or has no mapping for a given artifact, use the default layout: VISION.md, TODO.md, and CHANGELOG.md at the project root; all other artifacts in `.agentera/`.

### Contract values

Contract values are inlined where referenced. Visual tokens from protocol: severity arrows VT5-VT8 (⇶/⇉/→/⇢), status tokens VT1-VT4 (■/▣/□/▨), list item VT15 (▸), inline separator VT16 (·), section divider VT14, flow/target VT17 (→). Skill glyphs SG1-SG12 for cross-capability references. Exit signals EX1-EX4 for the exit marker. Severity issue levels SI1-SI4 for TODO classification. Decision labels DL1-DL3 for DECISIONS.md entries. Confidence scale CS1-CS5 with thresholds for profile consumption.

`references/contract.md` (at the v1 skill location `skills/realisera/references/contract.md`) remains available as a full-spec reference for ambiguous cases or cross-checking.

### VISION.md

Evergreen. Created via brainstorm on first run, refined only when the user explicitly asks. Outside those two cases, the agent reads it but never writes it. A constitution, not a backlog.

```markdown
# [Project Name]

## North Star
[The dream. What this software makes possible, not just what it does.]

## Who It's For
[Concrete personas. Not "developers" but specific people with specific days,
specific frustrations, specific workflows.]

## Principles
- [Core principles that guide every decision]
- [What to optimize for, what to resist]

## Direction
[Where this project is heading. Aspirational, not prescriptive.]

## Identity
[What this project IS as an entity: personality, voice, emotional register, naming.]
```

### PROGRESS.md

```markdown
■ ## Cycle N · YYYY-MM-DD HH:MM

**What**: one-line summary of what shipped
**Commit**: <hash> <message>
**Inspiration**: what external source informed the approach (if any)
**Discovered**: issues or ideas found (also logged in TODO.md)
**Verified**: observed output from running the primary entrypoint against real project state, OR `N/A: <tag>` from the allowlist, OR a free-form rationale of at least 8 words
**Next**: what seems most valuable to work on next
**Context**: intent · constraints · unknowns · scope
```

The `**Verified**` field is mandatory for every cycle entry.

### CHANGELOG.md

Public-facing change history. Keep-a-changelog format. Realisera appends entries under `## [Unreleased]` based on commit type: `feat` → Added, `refactor/chore` → Changed, `fix` → Fixed. On version bumps, promote the Unreleased section to a versioned heading.

---

## Brainstorm: bootstrapping or refining VISION.md

This runs in two situations:

1. **VISION.md doesn't exist**: the first time realisera runs on a project
2. **User explicitly asks** to refine the vision

In all other cases, skip straight to the cycle.

The sharp colleague, here to build. Brief, focused conversation. One question at a time. Push for ambition.

1. **Understand the dream**: "Not what the software does, but what does it make possible?"
2. **Find the people**: "Who reaches for this? Describe a person: their day, their frustrations."
3. **Find the principles**: "What principles guide every decision?" If a decision profile exists, propose principles from it.
4. **Set the direction**: "Where is this heading? Not features, but capabilities."
5. **Write VISION.md**: synthesize into an aspirational north star. Present for approval.

Artifact writing follows contract Section 24 conventions: banned verbosity patterns, 25-word sentence cap, preferred vocabulary, and lead-with-conclusion structure.

---

## The cycle

Skill introduction: `─── ⧉ realisera · cycle N ───`

Step markers: display `── step N/9: verb` before each step.
Steps: orient, select, research, plan, dispatch, verify, commit, audit, log.

### Step 1: Orient

Read VISION.md, PROGRESS.md, TODO.md, and HEALTH.md in parallel. These reads are independent; issue all in a single response.

If PROGRESS.md has 3+ cycles, run the analytics script first:

```bash
python3 scripts/analyze_progress.py --progress PROGRESS.md --pretty
```

(Run from the v1 skill location `skills/realisera/scripts/`.)

1. **PROGRESS.md**: what happened last cycle, what was suggested next
2. **VISION.md**: read `## Principles` and `## Direction` sections
3. **TODO.md**: what's broken or degraded
4. **HEALTH.md**: read `critical` and `degraded` findings only (if exists)
5. **DECISIONS.md**: read all entries (if exists). `firm` (DL1) entries are hard constraints. `provisional` (DL2) entries are strong defaults. Note `exploratory` (DL3) entries.
6. **Decision profile**: run from the profilera v1 skill directory:

   ```bash
   python3 scripts/effective_profile.py
   ```

   Read full profile from `$PROFILERA_PROFILE_DIR/PROFILE.md` (default: `$XDG_DATA_HOME/agentera/PROFILE.md`). If missing, proceed without persona grounding but flag it.

7. **Project discovery** (cycle 1 or when unfamiliar):
   - Map the directory structure
   - Read dependency manifests
   - Read README.md, CLAUDE.md, AGENTS.md if they exist
   - Identify build/test/lint commands
   - Read key source files to understand architecture

8. `git log --oneline -20` for recent changes

Before proceeding, list the 3-5 facts that determine this cycle.

**Exit-early guard (plan-driven mode only)**: If PLAN.md is done and no tasks were added, perform a **plan-completion sweep** before archiving. This guard does NOT apply in vision-driven mode.

Sweep checklist:

1. **PROGRESS.md aggregate cycle entry**: append a cycle entry summarizing the whole plan.
2. **CHANGELOG.md plan-level entries**: verify `## [Unreleased]` covers each completed task's user-facing impact.
3. **TODO.md milestone advance**: mark each plan task as Resolved.
4. **HEALTH.md cross-reference**: mention any resolved findings.

After the sweep, archive PLAN.md to `.agentera/archive/PLAN-{date}.md` and report exit signal `complete: plan finished`.

### Step 2: Pick work

Choose **one** focused increment. No backlog; decide by reasoning about the gap between vision and codebase, weighted against known issues.

Each cycle: **build toward the vision, or fix something broken?** Consult the decision profile. A critical bug trumps a new feature; a minor nit doesn't block progress.

**Building toward vision:** Read codebase + VISION.md, identify the gap, pick the smallest increment closing the most valuable part.

**Fixing issues:** Pick from TODO.md by severity (critical > degraded > annoying).

**Optimization-shaped work:** Delegate to `/optimera` for measurable metrics.

Write a 1-2 sentence rationale. Scope down aggressively.

Compose a Context block for this cycle: intent, constraints, unknowns, and scope. Keep it ≤80 words.

**Decision gate**: After selecting work, check whether any `exploratory` (DL3) entries in DECISIONS.md relate to the selected work area. If found: flag the uncertain foundation, suggest `/resonera` to firm up the decision. In autonomous mode, proceed with the work but log the risk.

### Step 3: Seek inspiration

Search for relevant external approaches before planning.

1. **Assess**: bug fixes rarely benefit from inspiration. New features, architecture decisions, and unfamiliar domains do.
2. **Search**: 2-3 targeted web queries for libraries, articles, repos, or patterns.
3. **Analyze**: read promising finds deeply.
4. **Integrate**: fold applicable patterns into the plan.

### Step 4: Plan

Write a concrete plan: what changes in which files, expected behavior, verification approach.

Read files you plan to modify before committing to the plan. If docs should update first (DTC), include that.

Keep small enough for one agent session. Too large? Split and save the rest.

### Step 5: Dispatch

**Pre-dispatch commit gate**: before creating the worktree, commit any pending artifact changes so the subagent branches from current state.

1. Run `git status --porcelain`. If empty, skip to dispatch.
2. Stage only the artifact files this session wrote.
3. Commit with `chore(realisera): checkpoint before worktree dispatch`.
4. If pre-commit hooks reject: fix, re-stage, retry. If retry fails, abort dispatch.

**Stale-base awareness**: Before dispatch, run `git rev-list --count origin/main..HEAD`. If count > 0, do not merge the worktree branch. Fetch the sub-agent's diff and apply it to the main checkout.

Spawn an implementation sub-agent in a worktree with:

- The plan from step 4
- Relevant context files
- Clear constraint: implement the plan and nothing else

```
You are implementing a focused change for [project].

## Task
[The plan]

## Constraints
- Implement ONLY what the plan describes. No scope creep.
- Follow existing code patterns and conventions.
- Read the files you are modifying before changing them.
- Verify the change works as described, then run the project's test/build suite.
- If you encounter a bug unrelated to your task, note it but do not fix it.
```

### Step 6: Verify

Verification has two phases: structural and behavioral. Both must pass before commit.

**Phase A, structural verification**: After implementation:

1. **Check the diff**: does it match the plan?
2. **Functional check**: does the changed behavior work end-to-end?
3. **Run the project's verification suite** (test/build/lint).

**Phase B, behavioral verification (Reality Verification Gate)**: observe the new behavior by running the project's primary entrypoint against real project state:

- CLI tool: invoke with realistic arguments
- Library/SDK: run a smoke driver
- Web service: send a request to a production-shaped endpoint
- Skill repo: `python3 scripts/eval_skills.py --skill <name>`

If verification fails: diagnose, spawn a fix agent, re-verify.

**N/A path**: If the cycle has no runnable behavior change, use `N/A: <tag>` from the allowlist: `docs-only`, `refactor-no-behavior-change`, `chore-dep-bump`, `chore-build-config`, `test-only`.

### Step 7: Commit

Once verified, commit with a conventional commit message: `type(scope): summary`.

Types: `feat`, `fix`, `docs`, `refactor`, `chore`, `test`. Include all related files. Never commit partial or broken work. Never push to remote.

If the current task is a version bump: read DOCS.md for the `versioning` section. Update every file in `version_files`.

### Step 8: Pre-write self-audit

Pre-write self-audit: check verbosity drift, abstraction creep, and filler accumulation. See `scripts/self_audit.py` (at the v1 skill location `skills/realisera/scripts/self_audit.py`).
Max 3 revision attempts. Flag with [post-audit-flagged] if still failing.

### Step 9: Log

**Dual-write**: realisera maintains PROGRESS.md and CHANGELOG.md.

- **TODO.md**: add newly discovered issues, mark resolved ones. Classify by severity (SI1-SI4).
- **PROGRESS.md**: append the cycle entry. The `**Verified**` field is mandatory.
- **CHANGELOG.md**: append a one-line entry under `## [Unreleased]`.

After appending to PROGRESS.md, compact older entries:

```bash
python3 ${AGENTERA_HOME:-$CLAUDE_PLUGIN_ROOT}/scripts/compact_artifact.py progress <path-to-PROGRESS.md>
```

Artifact writing follows contract Section 24 conventions.

Then stop. One cycle complete.

---

## Safety rails

<critical>

- NEVER push to any remote. Local commits only.
- NEVER bypass the project's test/lint/build suite.
- NEVER modify git config or skip git hooks.
- NEVER force push, amend published commits, or run destructive git operations.
- NEVER add placeholder data or functionality.
- NEVER modify files outside the project directory.
- NEVER modify VISION.md during a cycle. Only touch it during a brainstorm.
- One cycle per invocation. Do not attempt multiple cycles.

</critical>

---

## Handling blocked work

If blocked:

1. Log blocker in TODO.md with context and decision needed
2. Log skipped attempt in PROGRESS.md
3. Pick different work and complete a full cycle on that instead

---

## Exit signals

Report one of these statuses at workflow completion (protocol refs: EX1-EX4).

Format: `─── ⧉ realisera · <status> ───` followed by a summary sentence.
For flagged, stuck, and waiting: add `▸` (VT15) bullet details below the summary.

- **complete** (EX1): One full cycle completed. Work selected, implemented, verified, committed, artifacts updated.
- **flagged** (EX2): Cycle completed but with notable issues: verification warnings, scope reduction, or discoveries suggesting next cycle may face blockers.
- **stuck** (EX3): Cannot complete: VISION.md missing and brainstorm can't proceed, all work blocked, or verification suite broken.
- **waiting** (EX4): No VISION.md and no codebase to infer direction, or user instruction too ambiguous.

Before reporting any status, inspect the last 3 entries in PROGRESS.md. If all 3 record failed cycles, stop, log the failure pattern to TODO.md, and surface to the user. Do not attempt a 4th consecutive cycle on the same failing problem.

---

## Cross-capability integration

Realisera is part of a twelve-capability suite.

### Delegates to /visionera

When visionera is installed and VISION.md doesn't exist, suggest `/visionera` for deep vision creation. If visionera is NOT installed, the built-in brainstorm works as a standalone fallback.

### Delegates to /optimera

When picked work is optimization-shaped (improving a measurable metric), delegate to optimera.

### Uses /inspirera

In Step 3 (Seek inspiration), search for external approaches. For deeper analysis, run `/inspirera <url>`.

### Reads /profilera output

Every cycle runs the effective profile script. Confidence thresholds (CS1-CS5) determine which entries are strong constraints vs suggestions.

### Uses /resonera for complex decisions

When the brainstorm or work selection surfaces a decision too complex for inline resolution, suggest `/resonera`.

### Consumes /planera plans

When PLAN.md exists with pending tasks, Step 2 reads the plan instead of reasoning from vision. Pick next pending task with satisfied dependencies. Update task status. When all complete, archive PLAN.md.

### Reads /dokumentera output

DOCS.md provides artifact path resolution. In the DTC pipeline, dokumentera writes intent docs that feed planera, which feeds realisera.

### Reads /visualisera output

DESIGN.md provides visual identity context respected when building user-facing features.

### Audited by /inspektera

HEALTH.md findings become candidates for work selection. Run `/inspektera` every 5-10 cycles.
