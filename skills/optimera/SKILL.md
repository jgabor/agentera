---
name: optimera
description: >
  OPTIMERA — Objective Pursuit: Targeted Iterative Measurement — Experiment, Record, Advance.
  ALWAYS use this skill for metric-driven optimization of a measurable objective. This skill
  is REQUIRED whenever the user wants to improve a concrete, quantifiable property of their
  codebase — test pass rate, benchmark performance, bundle size, latency, lint score, type
  coverage, or any other metric that can be measured by running a command. Do NOT attempt
  iterative optimization without this skill — it contains the critical workflow for
  objective-driven experimentation, eval harness design, structured keep/discard decisions,
  and safety rails that prevent regressions. Trigger on: "optimera", "optimize", "improve
  performance", "reduce latency", "increase test coverage", "lower bundle size", "speed up",
  "make faster", "make smaller", "get the score up", "hit the target", "improve the metric",
  "benchmark and iterate", "run experiments", "tune", "experiment until", any mention of
  iterative optimization against a measurable target, any request to improve a number, or
  setting up /loop for recurring optimization. Also trigger when the user names a metric and
  wants it improved through systematic experimentation.
---

# OPTIMERA

**Objective Pursuit: Targeted Iterative Measurement — Experiment, Record, Advance**

A metric-driven optimization loop that improves any measurable property of a software project,
one focused experiment at a time. The user defines the objective. The agent writes an eval
harness. The harness becomes the immutable judge. Experiments that improve the metric and
pass regression checks are kept; everything else is discarded.

Each invocation = one experiment. `/loop` handles recurrence.

---

## State artifacts

Optimera maintains three artifacts in the project root. All are bootstrapped if they don't exist.

| Artifact | Purpose | Bootstrap |
|----------|---------|-----------|
| `OBJECTIVE.md` | What we're optimizing, why, how we measure it, and what "done" looks like. | Via inline brainstorm session with the user (see below). |
| `.optimera/harness` | Eval script that measures the metric. Locked after user approval. | Written by the agent during brainstorm, approved by the user. |
| `EXPERIMENTS.md` | Log of every experiment — what was tried, what the metric said, kept or discarded. | `# Experiments\n\n` then the first experiment entry. |

### Artifact path resolution

Before reading or writing any artifact, check if DOCS.md exists in the project root. If it
has an Artifact Mapping section, use the path specified for each canonical filename
(OBJECTIVE.md, EXPERIMENTS.md, etc.). If DOCS.md doesn't exist or has no entry for a given
artifact, default to the project root. This applies to all artifact references in this skill,
including cross-skill reads (DECISIONS.md).

### OBJECTIVE.md

An evergreen document. Optimera creates it through a brainstorm session on first run, and can
refine it when the user explicitly asks. Outside of those two cases, the agent never touches
it — it reads the objective, it doesn't rewrite it. Typical structure:

```markdown
# [Optimization Target]

## Objective
[What we're improving. Not vague ("make it faster") — precise ("reduce p95 latency of the
/api/search endpoint from 320ms to under 100ms"). Name the metric, the current value, and
the target value.]

## Why This Matters
[What changes when we hit the target? Who benefits? What becomes possible? Context that
helps the agent make trade-off decisions when two approaches both improve the metric but
have different costs.]

## Measurement
[How the metric is captured. What command to run, what the output means, which direction
is "better" (lower latency = good, higher coverage = good). The eval harness implements
this, but OBJECTIVE.md explains the intent behind it.]

## Constraints
- [What the agent must NOT break while optimizing (e.g., "all existing tests must pass")]
- [What the agent should NOT touch (e.g., "don't modify the public API")]
- [Resource limits (e.g., "memory usage must stay under 512MB")]

## Scope
[Which files, modules, or areas of the codebase are fair game for changes. If unspecified,
the agent uses judgment — but explicit scope prevents surprise.]
```

The exact structure may vary — what matters is that the objective is precise enough to measure,
the constraints are clear enough to enforce, and the scope is defined enough to prevent the
agent from wandering.

### .optimera/harness

A script that measures the metric and outputs structured JSON. The agent writes this during
the brainstorm phase using the reference documentation as a guide. The user approves it.
After approval, the harness is **locked** — the agent never modifies it during optimization
cycles.

The harness wraps the project's own tooling (test runners, benchmarks, linters, build tools)
and translates their output into a consistent format. It does not reimplement measurement —
the project's tooling is the source of truth.

**Before writing a harness**, read these references (bundled with this skill):
- `references/harness-guide.md` — principles, patterns, and pitfalls
- `references/output-schema.md` — formal JSON output specification
- `references/examples/` — harness patterns for common metric types:
  - `test-pass-rate.md` — Node (Jest/Vitest), Python (pytest), Go, Rust
  - `benchmark.md` — hyperfine, built-in benchmarks, HTTP latency
  - `bundle-size.md` — JS bundles, Go binaries, Docker images, gzipped size
  - `lint-score.md` — ESLint, Pylint, golangci-lint, Biome
  - `coverage.md` — c8/nyc, coverage.py, go cover, cargo-tarpaulin

**Output contract** (minimal):
```json
{"metric": <number>, "direction": "higher"|"lower"}
```

**Output contract** (with optional fields for richer signal):
```json
{"metric": 85.5, "direction": "higher", "unit": "%", "detail": "42/50 tests passing", "breakdown": [{"name": "unit", "value": 95.0}, {"name": "integration", "value": 60.0}]}
```

The harness is the **immutable ground truth**. It prevents the agent from gaming the metric
by separating measurement from optimization. If the harness is wrong, the user must explicitly
ask to rebuild it.

### EXPERIMENTS.md

```markdown
## Experiment N — YYYY-MM-DD HH:MM

**Hypothesis**: what we expected to improve and why
**Method**: the approach taken to test the hypothesis
**Change**: one-line summary of the code change
**Metric**: <before> → <after> (⮉ better | ⮋ worse | unchanged)
**Regression**: pass | fail (existing test/build suite)
**Status**: ■ kept | □ discarded | ▨ error
**Commit**: <hash> (if kept)
**Inspiration**: external source that informed the approach (if any)
**Conclusion**: what we learned — confirms, refutes, or refines the hypothesis
**Next**: what the result suggests trying next
```

The "Next" field from the previous experiment is a suggestion, not a mandate. Re-evaluate fresh
each cycle based on the full experiment history.

---

## Brainstorm: bootstrapping or refining the objective

This runs in two situations:
1. **OBJECTIVE.md doesn't exist** — the first time optimera runs on a project
2. **User explicitly asks** to refine the objective (e.g., "change the target", "update OBJECTIVE.md")

In all other cases, skip straight to the cycle.

### How the brainstorm works

A focused conversation to understand what the user wants to optimize and build the eval
harness. One question at a time. Push for precision — vague objectives produce aimless
experiments.

1. **Understand the objective** — "What specific metric do you want to improve? What's its
   current value? What's the target?" If the codebase already exists, read it first — run
   any existing test/bench/lint commands to establish the current state. Present your
   understanding: "Here's what I measured. Is this the metric you care about?"
2. **Understand the motivation** — "Why does this metric matter? What breaks or suffers at
   the current value? What becomes possible at the target?" This context helps the agent
   make trade-off decisions during optimization.
3. **Define constraints** — "What must NOT break while optimizing? Are there files or modules
   that are off-limits? Any resource limits?" If a decision profile exists, propose constraints
   derived from it and let the user adjust.
4. **Define scope** — "Which parts of the codebase should I focus on? Where do you suspect
   the biggest gains are?" Read the codebase to propose informed scope boundaries.
5. **Write OBJECTIVE.md** — synthesize the answers into a precise optimization charter.
   Present it to the user for approval before writing.
6. **Write the eval harness** — read `references/harness-guide.md` and the relevant example
   in `references/examples/` for the metric type. Based on the objective and the reference
   patterns, write a script at `.optimera/harness` that measures the metric using the
   project's own tooling and outputs structured JSON per `references/output-schema.md`.
   Present the script to the user, explain what it does, and get explicit approval before
   locking it. Run it once to verify it works and establish the baseline metric value.

When **refining** an existing objective, read the current OBJECTIVE.md first, show the user what
you'd change and why, and get confirmation before writing. If the harness needs to change,
the user must explicitly approve the new version.

After the brainstorm completes, proceed to experiment 1.

---

## The cycle

Each experiment opens with the skill introduction: `─── ⎘ optimera · experiment N ───`

### Step 1: Orient

Read the optimization state to understand where things stand.

1. **EXPERIMENTS.md** — read last 5 experiments only (check for plateau patterns)
2. **OBJECTIVE.md** — the metric, target, constraints, and scope
3. **Decision profile** — run the effective profile script for a confidence-weighted summary:
   ```bash
   python3 -m scripts.effective_profile
   ```
   Run from the profilera skill directory (typically
   `~/.claude/plugins/marketplaces/agentera/skills/profilera`).
   This outputs a summary table with effective confidence after dormancy decay.
   Use it to calibrate experimentation style: high effective confidence entries (65+)
   are strong constraints on approach, low effective confidence entries (<45) are
   suggestions that can be overridden. Read full `~/.claude/profile/PROFILE.md` for
   complete rule details when needed.
   If the script or PROFILE.md is missing, proceed without persona grounding but flag it:
   "Consider running /profilera to generate a decision profile — it helps me make choices
   you'd agree with."
4. **Project discovery** (experiment 1 or when unfamiliar):
   - Map the directory structure within the declared scope
   - Read dependency manifests
   - Read README, CLAUDE.md if they exist
   - Identify the build/test/lint commands (needed for regression checks)
   - Read key source files in scope to understand architecture
5. `git log --oneline -20` for recent changes

Before experimenting: in your response, list the current baseline, target, and constraints
from OBJECTIVE.md. These survive if earlier reads are cleared.

**Exit-early guard**: If OBJECTIVE.md target has been met (current metric ≥ target) — report
exit signal `complete: objective achieved` and stop.

### Step 2: Analyze

Run two things:

**2a. Experiment history analysis** — if EXPERIMENTS.md has prior entries, run the analysis
script (bundled with this skill) to get structured trend data:

```bash
python3 -m scripts.analyze_experiments --experiments EXPERIMENTS.md --objective OBJECTIVE.md --pretty
```

This outputs JSON with: metric trajectory, plateau detection, win/loss rates, distance to
target, and recent experiment summaries. Use this to inform the Hypothesize step.

**2b. Current metric** — run the eval harness to get the baseline for this experiment:

```bash
chmod +x .optimera/harness && ./.optimera/harness
```

Parse the JSON output. Record the current metric as the baseline.

**Plateau detection**: if the analysis script reports `plateau_detected: true` (no improvement
in 3+ experiments), flag this explicitly. Consider a radically different approach, seek
external inspiration via /inspirera, or escalate to the user.

### Step 3: Hypothesize

Formulate a single, focused hypothesis about what change will improve the metric.

1. **Review history** — read EXPERIMENTS.md to understand what's been tried, what worked,
   what didn't, and what the last experiment's "Next" field suggested. Look for patterns:
   which kinds of changes produce gains? Which approaches keep failing?
2. **Seek inspiration** — if the optimization domain is non-trivial, proactively search for
   external techniques. Use web search to find articles, libraries, or repos addressing
   similar optimization problems. Cast a focused net: 2-3 targeted queries. Analyze anything
   promising the way /inspirera would: core approach, transferability, applicability.
3. **Formulate** — write a 1-2 sentence hypothesis: "I expect [change] to improve the metric
   because [reasoning]." The hypothesis should be falsifiable — if the metric doesn't improve,
   the hypothesis was wrong.

Consult the decision profile. Be conservative (small, safe changes) early in the optimization.
Escalate to more aggressive changes if conservative approaches plateau.

### Step 4: Implement

Spawn a Sonnet implementation agent in a worktree (`isolation: "worktree"`) with:

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
- Do NOT modify the eval harness at .optimera/harness.
- Do NOT modify OBJECTIVE.md or EXPERIMENTS.md.
- Follow existing code patterns and conventions.
- Read the files you are modifying before changing them.
- Keep the change as small as possible while testing the hypothesis.
- If you encounter a bug unrelated to your task, note it but do not fix it.
```

Wait for the implementation agent to complete before proceeding.

### Step 5: Measure

After implementation completes, run two checks in sequence:

**5a. Regression check** — run the project's existing test/build/lint suite:
- Look for a top-level `check`, `ci`, `test`, or `verify` target first (Makefile, mage,
  package.json scripts, taskfile, justfile)
- If none exists, run the language-appropriate defaults:
  Go: `go test ./... && go vet ./...`
  Node: `npm test`
  Python: `pytest`
  Rust: `cargo test && cargo clippy`

If the regression check fails, **stop here** — the experiment is discarded. Do not run the
eval harness. Log the regression failure in EXPERIMENTS.md and move to Step 7.

**5b. Metric measurement** — run the eval harness:

```bash
./.optimera/harness
```

Parse the JSON output. Compare the new metric against the baseline from Step 2.

### Step 6: Decide

Apply the decision gate — **both conditions must be true** to keep an experiment:

1. **Regression check passed** (from Step 5a)
2. **Metric improved** — the new value is strictly better than the baseline, in the direction
   declared by the harness (lower for "lower", higher for "higher")

If both pass: **keep** — merge the worktree branch into the current branch. Commit with a
conventional commit message:

```
perf(scope): summary of what improved the metric

Metric: <before> → <after> ⮉ (<unit>)
```

If either fails: **discard** — the worktree is abandoned. No merge. No commit.

### Step 7: Log

Update **EXPERIMENTS.md** — append the experiment entry (number, timestamp, hypothesis, change
summary, metric before/after, regression result, status, commit hash if kept, inspiration
source if any, suggestion for next experiment).
Output constraint: ≤20 words hypothesis, ≤50 words result, ≤20 words conclusion per experiment.

When writing a new experiment entry to EXPERIMENTS.md, check entry count. If >8 full-detail
entries exist, collapse the oldest to one-line format under `## Archived Experiments` (one
line per experiment: `EXP-N: ≤15-word result summary`). If >22 one-line entries exist, drop
the oldest. See ecosystem-spec.md Section 4 compaction thresholds.

Then stop. One experiment complete.

---

## Safety rails

<critical>

- NEVER push to any remote. Local commits only.
- NEVER modify the eval harness (`.optimera/harness`) during an optimization cycle. Only
  touch it during a brainstorm (bootstrap or user-requested refinement).
- NEVER modify OBJECTIVE.md during a cycle. Only touch it during a brainstorm.
- NEVER bypass the project's test/lint/build suite. Regression check before every metric
  measurement. Regression failure = automatic discard.
- NEVER modify git config or skip git hooks.
- NEVER force push, amend published commits, or run destructive git operations.
- NEVER keep an experiment that causes a regression, even if the metric improved.
- NEVER add placeholder data or functionality. All code must be real and functional.
- NEVER modify files outside the scope declared in OBJECTIVE.md (when scope is declared).
- One experiment per invocation. Do not attempt multiple experiments.

</critical>

---

## Handling blocked experiments

If the hypothesis can't be tested (missing dependency, ambiguous constraint, change would be
too risky to make autonomously):

1. Log the blocked hypothesis in EXPERIMENTS.md with context and what decision is needed
2. Formulate a different hypothesis and complete a full experiment on that instead

Never waste a cycle. If the first hypothesis is blocked, pivot.

---

## Exit signals

Report one of these statuses at workflow completion:

- **complete** — One experiment completed the full cycle: hypothesis formulated, implementation dispatched, regression check passed, metric measured, decision made (kept or discarded), and EXPERIMENTS.md updated.
- **flagged** — The experiment cycle completed but with issues worth noting: the metric did not improve after multiple attempts, a plateau was detected, or the experiment had to be discarded due to a regression.
- **stuck** — Cannot proceed because OBJECTIVE.md is missing and the brainstorm cannot be completed without user input, the eval harness is broken and cannot be repaired without user approval, or the regression check infrastructure is unavailable.
- **waiting** — The optimization objective is too vague to experiment against, the metric cannot be measured by any available tooling, or the scope is undefined and cannot be safely inferred.

Before reporting any status, inspect the last 3 entries in PROGRESS.md. If all 3 entries record failed or discarded experiments (regression failures, blocked hypotheses with no successful pivot, or the "Discovered" field logging the same unresolved issue), this constitutes 3 consecutive failures: **stop the cycle**, log the failure pattern to ISSUES.md with what was attempted and what the skill believes is wrong, and surface the situation to the user with a recommended course of action (e.g., "/resonera to deliberate on the optimization approach", "manual investigation of the regression blocker needed"). Do not attempt a 4th consecutive experiment on the same problem.

---

## Cross-skill integration

Optimera is part of an eleven-skill ecosystem. Each skill can invoke the others when the work
calls for it.

### Optimera invokes /inspirera
When the Hypothesize step needs external techniques — especially after a plateau — search for
approaches the way /inspirera would. Read the source deeply, extract transferable patterns,
and fold them into the next hypothesis.

### Realisera invokes /optimera
When realisera picks work that is optimization-shaped (e.g., "improve test performance by 20%",
"reduce build time", "increase coverage"), it can delegate to optimera. Realisera provides the
context; optimera runs the optimization loop.

### Optimera reads /profilera output
Every experiment runs the effective profile script (`python3 -m scripts.effective_profile` from
the profilera skill directory) to get a confidence-weighted summary table. Effective confidence
weighting ensures stale preferences don't over-constrain experiments — how aggressive to be,
how much complexity is acceptable, and what trade-offs the user prefers are all modulated by
how recently each preference was confirmed.

### Optimera uses /resonera for objective decisions
When the brainstorm session surfaces ambiguity about what to optimize — competing metrics,
unclear constraints, or tradeoffs between measurement approaches — suggest `/resonera` to
deliberate first. Resonera can produce or refine OBJECTIVE.md directly, and its DECISIONS.md
entries give optimera context for why the objective was chosen. If `DECISIONS.md` exists,
read it during the Orient step for context on prior deliberations.

### Inspektera feeds /optimera
When an inspektera audit reveals a poor dimension grade with a clearly measurable improvement
path (test coverage, complexity score, dependency count), the finding can become an optimization
objective. `/inspektera` may suggest `/optimera` when the metric and direction are clear.

---

## Getting started

### First optimization

1. `/profilera` — generate or refresh the decision profile (skip if recent)
2. `/optimera` — the first run detects no OBJECTIVE.md, runs a brainstorm with you to define
   the objective and write the eval harness, then proceeds to experiment 1
3. `/loop 5m /optimera` — set up continuous optimization (like autoresearch overnight runs)

### Resuming optimization

1. `/optimera` — if OBJECTIVE.md and the eval harness exist, starts experimenting immediately.
   Reads EXPERIMENTS.md to understand what's been tried.

### Changing the target

Edit OBJECTIVE.md directly to adjust the target value or constraints, or tell optimera to
"refine the objective" for a guided session. If the measurement approach needs to change,
the eval harness must be rebuilt and re-approved.

### Optimera is fed by /planera
When a plan includes optimization-shaped tasks (improving a measurable metric), planera can
delegate those tasks to optimera. The plan's acceptance criteria inform the optimization
objective.

### Drawing in external techniques

Run `/inspirera <url>` with a relevant article, repo, or resource. The analysis will surface
optimization techniques applicable to the objective. The next experiment picks it up naturally
from the inspiration analysis.
