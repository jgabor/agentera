# OPTIMERA

**Objective Pursuit: Targeted Iterative Measurement. Experiment, Record, Advance.**

Metric-driven optimization: improve any measurable property one experiment at a time. User defines the objective, agent writes an eval harness, harness becomes the immutable judge. Improve + pass regression = keep; everything else is discarded.

Each invocation = one experiment. `/loop` handles recurrence.

---

## Visual identity

Glyph: **⎘** (protocol ref: SG7). Used in the mandatory exit marker.

---

## State artifacts

Three artifacts per objective, under `.agentera/optimera/<objective-name>/`, bootstrapped if absent.

| Artifact | Purpose | Bootstrap |
|----------|---------|-----------|
| `.agentera/optimera/<objective-name>/OBJECTIVE.md` | What we're optimizing, why, how we measure it, and what "done" looks like. | Via inline brainstorm session with the user (see below). |
| `.agentera/optimera/<objective-name>/harness` | Eval script that measures the metric. Locked after user approval. | Written by the agent during brainstorm, approved by the user. |
| `.agentera/optimera/<objective-name>/EXPERIMENTS.md` | Log of every experiment: what was tried, what the metric said, kept or discarded. | `# Experiments\n\n` then the first experiment entry. |

### Artifact path resolution

Before reading or writing any artifact, check if `.agentera/DOCS.md` exists. If it has an Artifact Mapping section, use the path specified for each canonical filename. If `.agentera/DOCS.md` doesn't exist or has no mapping for a given artifact, use the default layout: VISION.md, TODO.md, and CHANGELOG.md at the project root; all other artifacts in `.agentera/`. This applies to all artifact references in this capability, including cross-capability reads (`.agentera/DECISIONS.md`). OBJECTIVE.md and EXPERIMENTS.md are NOT resolved via the DOCS.md mapping; they always live under `.agentera/optimera/<objective-name>/` for whichever objective is active.

### Contract

Before starting, read `references/contract.md` (at v1 skill location `skills/optimera/references/contract.md`) for authoritative values: token budgets, severity levels, format contracts, and other shared conventions referenced in the steps below. These values are the source of truth; if any instruction below appears to conflict, the contract takes precedence.

### OBJECTIVE.md

Evergreen. Created via brainstorm on first run, refined only when the user explicitly asks. Outside those two cases, the agent reads it but never writes it. Typical structure:

```markdown
# [Optimization Target]

**Status**: active

## Objective
[What we're improving. Not vague ("make it faster") but precise ("reduce p95 latency of the
/api/search endpoint from 320ms to under 100ms"). Name the metric, the current value, and
the target value.]

## Why This Matters
[What changes when we hit the target? Who benefits? What becomes possible? Context that
helps the agent make trade-off decisions when two approaches both improve the metric but
have different costs.]

## Measurement
[How the metric is captured. What command to run, what the output means, which direction
is "better" (lower latency = good, higher coverage = good). The eval harness implements
this, but OBJECTIVE.md explains the intent behind it. For stochastic objectives, state the
fixed per-experiment budget: run count, seed policy, time limit, token cap, or sample size.
Every experiment uses that same budget unless the user explicitly refines the objective.]

## Constraints
- [What the agent must NOT break while optimizing (e.g., "all existing tests must pass")]
- [What the agent should NOT touch (e.g., "don't modify the public API")]
- [Resource limits (e.g., "memory usage must stay under 512MB")]

## Scope
[Which files, modules, or areas of the codebase are fair game for changes. If unspecified,
the agent uses judgment, but explicit scope prevents surprise.]
```

The objective must be precise enough to measure, constraints clear enough to enforce, and scope defined enough to prevent wandering.

Fixed budgets are part of the measurement contract, not experiment strategy. Keep them in OBJECTIVE.md and the locked harness. Do not store budget state in root artifacts, registries, symlinks, or DOCS.md mappings. EXPERIMENTS.md records the budget actually used only when that evidence matters to interpret the result.

### `.agentera/optimera/<objective-name>/harness`

Script that measures the metric and outputs structured JSON. Written during brainstorm, approved by the user, then **locked**. Never modified during optimization cycles.

Wraps the project's own tooling (test runners, benchmarks, linters) and translates output into a consistent format. The project's tooling is the source of truth.

**Before writing a harness**, read these references (bundled with this skill at v1 locations):

- `references/harness-guide.md`: principles, patterns, and pitfalls
- `references/output-schema.md`: formal JSON output specification
- `references/agent-session-harness.md`: machinery for measuring agent behavior in reproducible sessions
- `references/examples/`: harness patterns for common metric types

**Output contract** (minimal):

```json
{"metric": <number>, "direction": "higher"|"lower"}
```

**Output contract** (with optional fields for richer signal):

```json
{"metric": 85.5, "direction": "higher", "unit": "%", "detail": "42/50 tests passing", "breakdown": [{"name": "unit", "value": 95.0}, {"name": "integration", "value": 60.0}]}
```

The harness is the **immutable ground truth**, separating measurement from optimization. If wrong, the user must explicitly ask to rebuild it.

### EXPERIMENTS.md

When presenting experiment results, open with your interpretation of what happened before the structured data. "Here's what I tried and what it told us"; then the metrics table backs it up. Call out surprises, dead ends, and what the result changes about the approach.

```markdown
## Experiment N · YYYY-MM-DD HH:MM

**Hypothesis**: what we expected to improve and why
**Method**: the approach taken to test the hypothesis
**Change**: one-line summary of the code change
**Metric**: <before> → <after> (⮉ better | ⮋ worse | unchanged)
**Regression**: pass | fail (existing test/build suite)
**Status**: ■ kept | □ discarded | ▨ error
**Commit**: <hash> (if kept)
**Inspiration**: external source that informed the approach (if any)
**Conclusion**: what we learned: confirms, refutes, or refines the hypothesis
**Next**: what the result suggests trying next
```

Closure entries are appended once when the objective reaches its target:

```markdown
## Closure · YYYY-MM-DDTHH:MM:SSZ

**Final value**: <value>
**Target**: <target>
**Reason**: <already met at startup | experiment met target>
```

The "Next" field from the previous experiment is a suggestion, not a mandate. Re-evaluate fresh each cycle based on the full experiment history.

### Experiment history analyzer contract

`scripts/analyze_experiments.py` (at v1 skill location `skills/optimera/scripts/analyze_experiments.py`) is the read-only summary layer for rich EXPERIMENTS.md records. It must inspect the active objective directory only. The analyzer never creates root objective artifacts, registries, symlinks, DOCS.md fixed mappings, or sidecar ledgers.

---

## Brainstorm: bootstrapping or refining the objective

This runs in two situations:

1. **OBJECTIVE.md doesn't exist**: the first time optimera runs on a project
2. **User explicitly asks** to refine the objective (e.g., "change the target", "update OBJECTIVE.md")

In all other cases, skip straight to the cycle.

### How the brainstorm works

The sharp colleague figuring out what to optimize. One question at a time, push for precision, push back on vague targets. Call out when an objective is too fuzzy to measure or when constraints are missing.

1. **Objective**: "What metric, current value, target?" If code exists, run existing test/bench/lint commands first.
2. **Motivation**: "Why does this matter? What breaks at current value? What's possible at target?"
3. **Constraints**: "What must NOT break? Off-limits files? Resource limits?" If a decision profile exists, propose constraints from it.
4. **Scope**: "Which parts to focus on? Where are the biggest gains?" Read codebase to propose informed boundaries.
5. **Pre-write self-audit**: check verbosity drift, abstraction creep, and filler accumulation. See `scripts/self_audit.py` (at v1 skill location `skills/optimera/scripts/self_audit.py`). Max 3 revision attempts. Flag with [post-audit-flagged] if still failing.
6. **Write OBJECTIVE.md**: synthesize into a precise charter. Write to `.agentera/optimera/<objective-name>/OBJECTIVE.md`. Present for approval.
7. **Write the eval harness**: read `references/harness-guide.md` and relevant `references/examples/` pattern. Write `.agentera/optimera/<objective-name>/harness` using the project's own tooling, outputting JSON per `references/output-schema.md`. Present, explain, get approval, run once to establish baseline.

Artifact writing follows contract Artifact Writing Conventions: banned verbosity patterns, 25-word sentence cap, preferred vocabulary, and lead-with-conclusion structure.

When **refining**, read current OBJECTIVE.md, show proposed changes with rationale, get confirmation. If the harness changes, the user must approve the new version. After brainstorm, proceed to experiment 1.

---

## The cycle

Skill introduction: `─── ⎘ optimera · experiment N ───`

Step markers: display `── step N/8: verb` before each step.
Steps: orient, analyze, hypothesize, implement, measure, decide, audit, log.

### Step 1: Orient

**Active-objective inference**: before reading any per-objective artifact, determine which objective is active by inspecting `.agentera/optimera/`:

- If no objective subdirectories exist, keep the existing new-objective path: run the brainstorm.
- For each objective subdirectory with an OBJECTIVE.md, classify it as closed before any active selection when the status line starts with `**Status**: closed`. Do not reopen closed objectives.
- If the user explicitly names a closed objective, load its OBJECTIVE.md and EXPERIMENTS.md read-only for context, summarize that it is closed, and ask before defining successor work.
- If one or more objective subdirectories exist and all are closed, ask the user for a successor objective.
- If only one non-closed subdirectory exists, use it.
- If multiple non-closed subdirectories exist, run `git log -1 --format=%aI -- .agentera/optimera/<name>/EXPERIMENTS.md` for each and pick the one with the most recent modification timestamp.
- If the result is ambiguous, ask the user to specify the active objective by name.

All subsequent references to OBJECTIVE.md, EXPERIMENTS.md, and harness refer to the files under `.agentera/optimera/<active-objective-name>/`.

1. **EXPERIMENTS.md**: last 5 experiments only (check for plateau patterns)
2. **OBJECTIVE.md**: the metric, target, constraints, and scope
3. **Decision profile**: run from the profilera skill directory:

   ```bash
   python3 scripts/effective_profile.py
   ```

   Apply confidence thresholds per contract profile consumption conventions. Read full profile from `$PROFILERA_PROFILE_DIR/PROFILE.md` for details when needed. If missing, proceed without persona grounding but flag it.
4. **Project discovery** (experiment 1 or when unfamiliar): map directory structure within scope, read dependency manifests, and read README.md, CLAUDE.md, AGENTS.md.
5. `git log --oneline -20` for recent changes

Before experimenting: in your response, list the current baseline, target, status, and constraints from OBJECTIVE.md.

**Objective closure procedure**: when closing an objective, update OBJECTIVE.md with canonical closed state: `**Status**: closed`, `**Closed at**: <ISO-8601 UTC timestamp>`, `**Final value**: <value>`, `**Target**: <target>`, and `**Reason**: <reason>`. Append one EXPERIMENTS.md closure entry. Do not append duplicates.

**Exit-early guard**: If OBJECTIVE.md or EXPERIMENTS.md evidence shows the target is already met and the objective is not already closed, run the objective closure procedure with reason `already met at startup`, report exit signal `complete: objective achieved`, and stop before Analyze.

### Step 2: Analyze

Run two things:

**2a. Experiment history analysis**: if EXPERIMENTS.md has prior entries, run:

```bash
python3 scripts/analyze_experiments.py --experiments EXPERIMENTS.md --objective OBJECTIVE.md --pretty
```

Outputs JSON with metric trajectory, plateau detection, win/loss rates, and distance to target.

**2b. Current metric**: run the eval harness to get the baseline for this experiment:

```bash
chmod +x .agentera/optimera/<objective-name>/harness && .agentera/optimera/<objective-name>/harness
```

Parse the JSON output. Record the current metric as the baseline.

**Plateau detection**: if `plateau_detected: true` (no improvement in 3+ experiments), flag explicitly. Consider a radically different approach, `/inspirera`, or escalate to the user.

### Step 3: Hypothesize

Formulate a single, focused hypothesis.

Effort-bias guard: if one hypothesis took more effort to construct, reset before selection. Choose by experiment history, expected metric impact, risk, constraints, and smallest falsifiable test; construction effort is not evidence.

1. **Review history**: what's been tried, what worked, what failed?
2. **Seek inspiration**: for non-trivial domains, 2-3 targeted web queries for techniques, libraries, or patterns.
3. **Formulate**: "I expect [change] to improve the metric because [reasoning]." Must be falsifiable.

Be conservative early; escalate if conservative approaches plateau.

### Step 4: Implement

**Pre-dispatch commit gate**: before creating the worktree, commit any pending artifact changes so the subagent branches from current state.

1. Run `git status --porcelain`. If empty, skip to dispatch.
2. Stage only the artifact files this session wrote.
3. Commit with `chore(optimera): checkpoint before worktree dispatch`. Do not pass `--no-verify`.
4. If pre-commit hooks reject the commit: fix and retry. If retry also fails, abort the dispatch.

**Stale-base awareness**: some harnesses create the worktree branch from `origin/main` rather than local `HEAD`. Before dispatch, run `git rev-list --count origin/main..HEAD`. If the count is greater than zero, the worktree will be based on a stale commit. Proceed with dispatch, but in Step 5 do NOT merge the worktree branch: fetch the diff and apply it to the main checkout. Re-run the eval harness in the main checkout.

Spawn an implementation sub-agent in a worktree (`isolation: "worktree"`) with:

- The hypothesis from step 3
- Relevant context files (OBJECTIVE.md, recent experiments, source files being modified)
- Clear constraint: implement the hypothesis and nothing else

```
You are implementing one optimization experiment for [project].

## Hypothesis
[The hypothesis]

## Context
- Current metric: [value] ([unit])
- Target: [target value]
- Scope: [files/modules in scope from OBJECTIVE.md]

## Constraints
- Implement ONLY what the hypothesis describes. No scope creep.
- Do NOT modify the eval harness at .agentera/optimera/<objective-name>/harness.
- Do NOT modify OBJECTIVE.md or EXPERIMENTS.md.
- Follow existing code patterns and conventions.
- Read the files you are modifying before changing them.
- Keep the change as small as possible while testing the hypothesis.
- If you encounter a bug unrelated to your task, note it but do not fix it.
```

Wait for the implementation agent to complete before proceeding.

### Step 5: Measure

After implementation completes, run two checks in sequence:

**5a. Regression check**: run the project's existing test/build/lint suite. If the regression check fails, **stop here**. The experiment is discarded. Do not run the eval harness. Log the regression failure and move to Step 7.

**5b. Metric measurement**: run the eval harness. Parse the JSON output. Compare the new metric against the baseline from Step 2.

### Step 6: Decide

Present the decision conversationally: what the numbers say and what you'd recommend, then the structured gate below makes it official.

Apply the decision gate. **Both conditions must be true** to keep an experiment:

1. **Regression check passed** (from Step 5a)
2. **Metric improved**: the new value is strictly better than the baseline, in the direction declared by the harness (lower for "lower", higher for "higher")

If both pass: **keep**. Merge the worktree branch into the current branch. Commit with a conventional commit message:

```
perf(scope): summary of what improved the metric

Metric: <before> → <after> ⮉ (<unit>)
```

If either fails: **discard**. The worktree is abandoned. No merge. No commit.

If the kept experiment's new metric also meets the target in the harness direction, mark the objective as ready for closure after the experiment entry is logged in Step 8.

### Step 7: Pre-write self-audit

Pre-write self-audit: check verbosity drift (per-artifact budget), abstraction creep (≥1 concrete anchor), and filler accumulation (banned patterns table). See `scripts/self_audit.py` (at v1 skill location `skills/optimera/scripts/self_audit.py`). Max 3 revision attempts. Flag with [post-audit-flagged] if still failing.

Narration voice (riff, don't script):
"Tightening this up..." · "Cutting the filler first..." · "One more pass..."

### Step 8: Log

Summarize the experiment for the user before writing the log: what moved, what didn't, and what it suggests trying next. Then write the structured record.

Update **EXPERIMENTS.md**: append the experiment entry. Output constraint per contract token budgets.

If Step 6 marked the objective as ready for closure, immediately run the objective closure procedure with reason `experiment met target`. This closure is part of the same log step, after the experiment result is recorded.

After writing a new experiment entry to EXPERIMENTS.md, compact older experiments via the script. Run: `python3 ${AGENTERA_HOME:-$CLAUDE_PLUGIN_ROOT}/scripts/compact_artifact.py experiments <path-to-EXPERIMENTS.md>`.

Artifact writing follows contract Artifact Writing Conventions: banned verbosity patterns, 25-word sentence cap, preferred vocabulary, and lead-with-conclusion structure.

Then stop. One experiment complete.

---

## Safety rails

<critical>

- NEVER push to any remote. Local commits only.
- NEVER modify the eval harness (`.agentera/optimera/<objective-name>/harness`) during an optimization cycle. Only touch it during a brainstorm (bootstrap or user-requested refinement).
- NEVER modify OBJECTIVE.md during a cycle except to record canonical closure when the target is met. Other OBJECTIVE.md edits only happen during brainstorm or refine.
- NEVER bypass the project's test/lint/build suite. Regression check before every metric measurement. Regression failure = automatic discard.
- NEVER modify git config or skip git hooks.
- NEVER force push, amend published commits, or run destructive git operations.
- NEVER keep an experiment that causes a regression, even if the metric improved.
- NEVER add placeholder data or functionality. All code must be real and functional.
- NEVER modify files outside the scope declared in OBJECTIVE.md (when scope is declared).
- One experiment per invocation. Do not attempt multiple experiments.

</critical>

---

## Handling blocked experiments

If blocked (missing dependency, ambiguous constraint, too risky):

1. Log blocked hypothesis in EXPERIMENTS.md with context and decision needed
2. Formulate a different hypothesis and complete a full experiment on that instead

---

## Exit signals

Report one of these statuses at workflow completion (protocol refs: EX1-EX4).

Format: `─── ⎘ optimera · status ───` followed by a summary sentence.
For flagged, stuck, and waiting: add `▸` bullet details below the summary.

- **complete** (EX1): One experiment completed the full cycle: hypothesis formulated, implementation dispatched, regression check passed, metric measured, decision made (kept or discarded), and EXPERIMENTS.md updated.
- **flagged** (EX2): The experiment cycle completed but with issues worth noting: the metric did not improve after multiple attempts, a plateau was detected, or the experiment had to be discarded due to a regression.
- **stuck** (EX3): Cannot proceed because OBJECTIVE.md is missing and the brainstorm cannot be completed without user input, the eval harness is broken and cannot be repaired without user approval, or the regression check infrastructure is unavailable.
- **waiting** (EX4): The optimization objective is too vague to experiment against, the metric cannot be measured by any available tooling, or the scope is undefined and cannot be safely inferred.

Before reporting any status, inspect the last 3 entries in PROGRESS.md. If all 3 entries record failed or discarded experiments, this constitutes 3 consecutive failures: **stop the cycle**, log the failure pattern to TODO.md, and surface the situation to the user with a recommended course of action. Do not attempt a 4th consecutive experiment on the same problem.

---

## Cross-capability integration

Optimera is part of a twelve-capability suite. Each capability can invoke the others when the work calls for it.

### Optimera invokes /inspirera

When the Hypothesize step needs external techniques (especially after a plateau), search for approaches the way `/inspirera` would. Read the source deeply, extract transferable patterns, and fold them into the next hypothesis.

### Realisera invokes /optimera

When realisera picks work that is optimization-shaped (e.g., "improve test performance by 20%", "reduce build time", "increase coverage"), it can delegate to optimera. Realisera provides the context; optimera runs the optimization loop.

### Optimera reads /profilera output

Every experiment runs the effective profile script (`python3 scripts/effective_profile.py` from the profilera skill directory) to get a confidence-weighted summary table. Confidence thresholds per contract profile consumption conventions. Effective confidence weighting ensures stale preferences don't over-constrain experiments.

### Optimera uses /resonera for objective decisions

When the brainstorm session surfaces ambiguity about what to optimize (competing metrics, unclear constraints, or tradeoffs between measurement approaches), suggest `/resonera` to deliberate first. Resonera can produce or refine OBJECTIVE.md directly, and its DECISIONS.md entries give optimera context for why the objective was chosen. If `DECISIONS.md` exists, read it during the Orient step for context on prior deliberations.

### Inspektera feeds /optimera

When an inspektera audit reveals a poor dimension grade with a clearly measurable improvement path (test coverage, complexity score, dependency count), the finding can become an optimization objective. `/inspektera` may suggest `/optimera` when the metric and direction are clear.

---

## Getting started

### First optimization

1. `/profilera`: generate or refresh the decision profile (skip if recent)
2. `/optimera`: the first run detects no OBJECTIVE.md, runs a brainstorm with you to define the objective and write the eval harness, then proceeds to experiment 1
3. `/loop 5m /optimera`: set up continuous optimization

### Resuming optimization

1. `/optimera`: if OBJECTIVE.md and the eval harness exist, starts experimenting immediately. Reads EXPERIMENTS.md to understand what's been tried.

### Changing the target

Edit OBJECTIVE.md directly to adjust the target value or constraints, or tell optimera to "refine the objective" for a guided session. If the measurement approach needs to change, the eval harness must be rebuilt and re-approved.

### Optimera is fed by /planera

When a plan includes optimization-shaped tasks (improving a measurable metric), planera can delegate those tasks to optimera. The plan's acceptance criteria inform the optimization objective.

### Drawing in external techniques

Run `/inspirera <url>` with a relevant article, repo, or resource. The analysis will surface optimization techniques applicable to the objective. The next experiment picks it up naturally from the inspiration analysis.
