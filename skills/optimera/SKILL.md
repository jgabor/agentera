---
name: optimera
description: >
  OPTIMERA (Objective Pursuit: Targeted Iterative Measurement; Experiment, Record, Advance). ALWAYS use this skill for metric-driven optimization of a measurable objective. This skill is REQUIRED whenever the user wants to improve a concrete, quantifiable property of their codebase: test pass rate, benchmark performance, bundle size, latency, lint score, type coverage, or any other metric that can be measured by running a command. Do NOT attempt iterative optimization without this skill because it contains the critical workflow for objective-driven experimentation, eval harness design, structured keep/discard decisions, and safety rails that prevent regressions. Trigger on: "optimera", "optimize", "improve performance", "reduce latency", "increase test coverage", "lower bundle size", "speed up", "make faster", "make smaller", "get the score up", "hit the target", "improve the metric", "benchmark and iterate", "run experiments", "tune", "experiment until", or setting up /loop for recurring optimization.
spec_sections: [1, 3, 4, 5, 6, 23]
---

# OPTIMERA

**Objective Pursuit: Targeted Iterative Measurement. Experiment, Record, Advance.**

Metric-driven optimization: improve any measurable property one experiment at a time. User defines the objective, agent writes an eval harness, harness becomes the immutable judge. Improve + pass regression = keep; everything else is discarded.

Each invocation = one experiment. `/loop` handles recurrence.

---

## State artifacts

Three artifacts per objective, under `.agentera/optimera/<objective-name>/`, bootstrapped if absent.

| Artifact | Purpose | Bootstrap |
|----------|---------|-----------|
| `.agentera/optimera/<objective-name>/OBJECTIVE.md` | What we're optimizing, why, how we measure it, and what "done" looks like. | Via inline brainstorm session with the user (see below). |
| `.agentera/optimera/<objective-name>/harness` | Eval script that measures the metric. Locked after user approval. | Written by the agent during brainstorm, approved by the user. |
| `.agentera/optimera/<objective-name>/EXPERIMENTS.md` | Log of every experiment: what was tried, what the metric said, kept or discarded. | `# Experiments\n\n` then the first experiment entry. |

### Artifact path resolution

Before reading or writing any artifact, check if .agentera/DOCS.md exists. If it has an Artifact Mapping section, use the path specified for each canonical filename (.agentera/DECISIONS.md, etc.). If .agentera/DOCS.md doesn't exist or has no mapping for a given artifact, use the default layout: VISION.md, TODO.md, and CHANGELOG.md at the project root; all other artifacts in .agentera/. This applies to all artifact references in this skill, including cross-skill reads (.agentera/DECISIONS.md). OBJECTIVE.md and EXPERIMENTS.md are NOT resolved via the DOCS.md mapping; they always live under `.agentera/optimera/<objective-name>/` for whichever objective is active (see active-objective inference in the Orient step).

### Contract

Before starting, read `references/contract.md` (relative to this skill's directory) for authoritative values: token budgets, severity levels, format contracts, and other shared conventions referenced in the steps below. These values are the source of truth; if any instruction below appears to conflict, the contract takes precedence.

### OBJECTIVE.md

Evergreen. Created via brainstorm on first run, refined only when the user explicitly asks. Outside those two cases, the agent reads it but never writes it. Typical structure:

```markdown
# [Optimization Target]

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
this, but OBJECTIVE.md explains the intent behind it.]

## Constraints
- [What the agent must NOT break while optimizing (e.g., "all existing tests must pass")]
- [What the agent should NOT touch (e.g., "don't modify the public API")]
- [Resource limits (e.g., "memory usage must stay under 512MB")]

## Scope
[Which files, modules, or areas of the codebase are fair game for changes. If unspecified,
the agent uses judgment, but explicit scope prevents surprise.]
```

The objective must be precise enough to measure, constraints clear enough to enforce, and scope defined enough to prevent wandering.

### `.agentera/optimera/<objective-name>/harness`

Script that measures the metric and outputs structured JSON. Written during brainstorm, approved by the user, then **locked**. Never modified during optimization cycles.

Wraps the project's own tooling (test runners, benchmarks, linters) and translates output into a consistent format. The project's tooling is the source of truth.

**Before writing a harness**, read these references (bundled with this skill):

- `references/harness-guide.md`: principles, patterns, and pitfalls
- `references/output-schema.md`: formal JSON output specification
- `references/agent-session-harness.md`: machinery for measuring agent behavior in reproducible sessions (hermetic vehicle, two-condition A/B, stream-JSON telemetry, causal gates). Reach for this when the measurement requires running an agent under controlled conditions rather than parsing one command's output
- `references/examples/`: harness patterns for common metric types:
  - `test-pass-rate.md`: Node (Jest/Vitest), Python (pytest), Go, Rust
  - `benchmark.md`: hyperfine, built-in benchmarks, HTTP latency
  - `bundle-size.md`: JS bundles, Go binaries, Docker images, gzipped size
  - `lint-score.md`: ESLint, Pylint, golangci-lint, Biome
  - `coverage.md`: c8/nyc, coverage.py, go cover, cargo-tarpaulin
  - `session-token-consumption.md`: agent session token footprint (stream-JSON parsing, causal gate via Skill-tool counting, optional per-artifact attribution). Applies the agent-session-harness machinery

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

The "Next" field from the previous experiment is a suggestion, not a mandate. Re-evaluate fresh each cycle based on the full experiment history.

---

## Brainstorm: bootstrapping or refining the objective

This runs in two situations:

1. **OBJECTIVE.md doesn't exist**: the first time optimera runs on a project
2. **User explicitly asks** to refine the objective (e.g., "change the target", "update OBJECTIVE.md")

In all other cases, skip straight to the cycle.

### How the brainstorm works

The sharp colleague figuring out what to optimize. One question at a time, push for precision, push back on vague targets. Call out when an objective is too fuzzy to measure or when constraints are missing.

1. **Objective**: "What metric, current value, target?" If code exists, run existing test/bench/lint commands first: "Here's what I measured. Is this the metric you care about?"
2. **Motivation**: "Why does this matter? What breaks at current value? What's possible at target?" Context helps trade-off decisions during optimization.
3. **Constraints**: "What must NOT break? Off-limits files? Resource limits?" If a decision profile exists, propose constraints from it.
4. **Scope**: "Which parts to focus on? Where are the biggest gains?" Read codebase to propose informed boundaries.
5. **Pre-write self-audit** (SPEC §24 Self-Audit Protocol):
   1. Verbosity drift: approximate word count. Exceeds §4 budget → compact. Re-check from check 1.
   2. Abstraction creep: missing concrete anchor (file path, line number, commit hash, metric, identifier, direct quote) → add one. Re-check from check 1.
   3. Filler accumulation: scan against §24 Banned verbosity patterns table. Found → remove. Re-check from check 1.
   Max 3 revision attempts per entry. After 3 failures, write the entry with `[post-audit-flagged]` marker.
   Narration voice (riff, don't script):
   ✗ "Self-audit failed. Revising entry."
   ✓ "Tightening this up..." · "Cutting the filler first..." · "One more pass..."
6. **Write OBJECTIVE.md**: synthesize into a precise charter. Write to `.agentera/optimera/<objective-name>/OBJECTIVE.md`. Present for approval.
7. **Write the eval harness**: read `references/harness-guide.md` and relevant `references/examples/` pattern. Write `.agentera/optimera/<objective-name>/harness` using the project's own tooling, outputting JSON per `references/output-schema.md`. Present, explain, get approval, run once to establish baseline.

Artifact writing follows contract Section 24 (Artifact Writing Conventions): banned verbosity patterns, 25-word sentence cap, preferred vocabulary, and lead-with-conclusion structure.

When **refining**, read current OBJECTIVE.md, show proposed changes with rationale, get confirmation. If the harness changes, the user must approve the new version. After brainstorm, proceed to experiment 1.

---

## The cycle

Skill introduction: `─── ⎘ optimera · experiment N ───`

Step markers: display `── step N/8: verb` before each step.
Steps: orient, analyze, hypothesize, implement, measure, decide, audit, log.

### Step 1: Orient

**Active-objective inference**: before reading any per-objective artifact, determine which objective is active by inspecting `.agentera/optimera/`:

- If only one subdirectory exists, use it.
- If multiple subdirectories exist, run `git log -1 --format=%aI -- .agentera/optimera/<name>/EXPERIMENTS.md` for each and pick the one with the most recent modification timestamp.
- If the timestamps are the same, no EXPERIMENTS.md exists in any subdirectory, or the result is otherwise ambiguous, ask the user to specify the active objective by name.

All subsequent references to OBJECTIVE.md, EXPERIMENTS.md, and harness in this step and throughout the cycle refer to the files under `.agentera/optimera/<active-objective-name>/`.

1. **EXPERIMENTS.md**: last 5 experiments only (check for plateau patterns)
2. **OBJECTIVE.md**: the metric, target, constraints, and scope
3. **Decision profile**: run from the profilera skill directory:

   ```bash
   python3 scripts/effective_profile.py
   ```

   Apply confidence thresholds per contract profile consumption conventions. Read full profile from `$PROFILERA_PROFILE_DIR/PROFILE.md` (default: `$XDG_DATA_HOME/agentera/PROFILE.md`) for details when needed. <!-- platform: profile-path -->
   If missing, proceed without persona grounding but flag it.
4. **Project discovery** (experiment 1 or when unfamiliar): map directory structure within scope, read dependency manifests, and read README.md, CLAUDE.md, AGENTS.md.
   Identify build/test/lint commands and read key source files in scope.
5. `git log --oneline -20` for recent changes

Before experimenting: in your response, list the current baseline, target, and constraints from OBJECTIVE.md. These survive if earlier reads are cleared.

**Exit-early guard**: If OBJECTIVE.md target has been met (current metric ≥ target), report exit signal `complete: objective achieved` and stop.

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

**Plateau detection**: if `plateau_detected: true` (no improvement in 3+ experiments), flag
explicitly. Consider a radically different approach, /inspirera, or escalate to the user.

### Step 3: Hypothesize

Formulate a single, focused hypothesis.

1. **Review history**: what's been tried, what worked, what failed? Which change types produce gains? What did the last "Next" field suggest?
2. **Seek inspiration**: for non-trivial domains, 2-3 targeted web queries for techniques, libraries, or patterns. Analyze promising finds for transferability.
3. **Formulate**: "I expect [change] to improve the metric because [reasoning]." Must be falsifiable.

Be conservative early; escalate if conservative approaches plateau.

### Step 4: Implement

**Pre-dispatch commit gate** (per contract Section 23): before creating the worktree, commit any pending artifact changes so the subagent branches from current state.

1. Run `git status --porcelain`. If empty, the working tree is clean: skip to dispatch.
2. Stage only the artifact files this session wrote (e.g., `git add .agentera/optimera/<objective-name>/OBJECTIVE.md .agentera/optimera/<objective-name>/EXPERIMENTS.md`). Do not use `git add -A` or `git add .`.
3. Commit with `chore(optimera): checkpoint before worktree dispatch`. Do not pass `--no-verify`.
4. If pre-commit hooks reject the commit: fix the artifact validation error, re-stage, and retry. If the retry also fails, abort the dispatch and report the failure. Do not proceed with a worktree branching from stale state.

**Stale-base awareness**: some harnesses create the worktree branch from `origin/main` (or the configured remote default) rather than from local `HEAD`. Before dispatch, run `git rev-list --count origin/main..HEAD`. If the count is greater than zero, the worktree will be based on a stale commit and the sub-agent's keep/discard evaluation will run against out-of-date code. Proceed with dispatch, but in Step 5 do NOT merge the worktree branch: fetch the sub-agent's diff with `git -C <worktree> diff` (including both staged and unstaged changes) and apply it to the main checkout via `git apply --index -`. Re-run the eval harness in the main checkout so keep/discard reflects HEAD, not the stale base. If the patch does not apply cleanly, the sub-agent's change touched a file that diverged between `origin/main` and HEAD; diagnose and resolve before deciding.

Spawn an implementation sub-agent in a worktree (`isolation: "worktree"`) <!-- platform: sub-agent-dispatch --> with:

- The hypothesis from step 3
- Relevant context files (OBJECTIVE.md, recent experiments, source files being modified)
- Clear constraint: implement the hypothesis and nothing else

Per-runtime substrate for the spawn:

- Claude Code: Task tool.
- OpenCode: plugin background-agent path.
- Codex: `[agents.<name>]` entries in `~/.codex/config.toml`, wired by `python3 scripts/setup_codex.py --enable-agents`.
- Copilot: no programmatic in-session equivalent; surface the dispatch as a user-driven `/fleet` recommendation.

See orkestrera SKILL.md `Runtime dispatch substrates` for the full table.

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

**5a. Regression check**: run the project's existing test/build/lint suite:

- Look for a top-level `check`, `ci`, `test`, or `verify` target first (Makefile, mage,
  package.json scripts, taskfile, justfile)
- If none exists, run the language-appropriate defaults:
  Go: `go test ./... && go vet ./...`
  Node: `npm test`
  Python: `pytest`
  Rust: `cargo test && cargo clippy`

If the regression check fails, **stop here**. The experiment is discarded. Do not run the eval harness. Log the regression failure in EXPERIMENTS.md and move to Step 7.

**5b. Metric measurement**: run the eval harness:

```bash
.agentera/optimera/<objective-name>/harness
```

Parse the JSON output. Compare the new metric against the baseline from Step 2.

### Step 6: Decide

Present the decision conversationally: what the numbers say and what you'd recommend, then the structured gate below makes it official.

Apply the decision gate. **Both conditions must be true** to keep an experiment:

1. **Regression check passed** (from Step 5a)
2. **Metric improved**: the new value is strictly better than the baseline, in the direction declared by the harness (lower for "lower", higher for "higher")

If both pass: **keep**. Merge the worktree <!-- platform: sub-agent-dispatch --> branch into the current branch. Commit with a conventional commit message:

```
perf(scope): summary of what improved the metric

Metric: <before> → <after> ⮉ (<unit>)
```

If either fails: **discard**. The worktree <!-- platform: sub-agent-dispatch --> is abandoned. No merge. No commit.

### Step 7: Pre-write self-audit

Pre-write self-audit (SPEC §24 Self-Audit Protocol):

1. **Verbosity drift**: approximate word count. Exceeds §4 budget → compact. Re-check from check 1.
2. **Abstraction creep**: missing concrete anchor (file path, line number, commit hash, metric, identifier, direct quote) → add one. Re-check from check 1.
3. **Filler accumulation**: scan against §24 Banned verbosity patterns table. Found → remove. Re-check from check 1.

Max 3 revision attempts per entry. After 3 failures, write the entry with `[post-audit-flagged]` marker.

Narration voice (riff, don't script):
✗ "Self-audit failed. Revising entry."
✓ "Tightening this up..." · "Cutting the filler first..." · "One more pass..."

### Step 8: Log

Summarize the experiment for the user before writing the log: what moved, what didn't, and what it suggests trying next. Then write the structured record.

Update **EXPERIMENTS.md**: append the experiment entry (number, timestamp, hypothesis, change summary, metric before/after, regression result, status, commit hash if kept, inspiration source if any, suggestion for next experiment).
Output constraint per contract token budgets.

After writing a new experiment entry to EXPERIMENTS.md, compact older experiments via the script. Run: `python3 ${AGENTERA_HOME:-$CLAUDE_PLUGIN_ROOT}/scripts/compact_artifact.py experiments <path-to-EXPERIMENTS.md>`.

Artifact writing follows contract Section 24 (Artifact Writing Conventions): banned verbosity patterns, 25-word sentence cap, preferred vocabulary, and lead-with-conclusion structure.

Then stop. One experiment complete.

---

## Safety rails

<critical>

- NEVER push to any remote. Local commits only.
- NEVER modify the eval harness (`.agentera/optimera/<objective-name>/harness`) during an optimization cycle. Only touch it during a brainstorm (bootstrap or user-requested refinement).
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

If blocked (missing dependency, ambiguous constraint, too risky):

1. Log blocked hypothesis in EXPERIMENTS.md with context and decision needed
2. Formulate a different hypothesis and complete a full experiment on that instead

---

## Exit signals

Report one of these statuses at workflow completion:

Format: `─── ⎘ optimera · status ───` followed by a summary sentence.
For flagged, stuck, and waiting: add `▸` bullet details below the summary.

- **complete**: One experiment completed the full cycle: hypothesis formulated, implementation dispatched, regression check passed, metric measured, decision made (kept or discarded), and EXPERIMENTS.md updated.
- **flagged**: The experiment cycle completed but with issues worth noting: the metric did not improve after multiple attempts, a plateau was detected, or the experiment had to be discarded due to a regression.
- **stuck**: Cannot proceed because OBJECTIVE.md is missing and the brainstorm cannot be completed without user input, the eval harness is broken and cannot be repaired without user approval, or the regression check infrastructure is unavailable.
- **waiting**: The optimization objective is too vague to experiment against, the metric cannot be measured by any available tooling, or the scope is undefined and cannot be safely inferred.

Before reporting any status, inspect the last 3 entries in PROGRESS.md. If all 3 entries record failed or discarded experiments (regression failures, blocked hypotheses with no successful pivot, or the "Discovered" field logging the same unresolved issue), this constitutes 3 consecutive failures: **stop the cycle**, log the failure pattern to TODO.md with what was attempted and what the skill believes is wrong, and surface the situation to the user with a recommended course of action (e.g., "/resonera to deliberate on the optimization approach", "manual investigation of the regression blocker needed"). Do not attempt a 4th consecutive experiment on the same problem.

---

## Cross-skill integration

Optimera is part of a twelve-skill suite. Each skill can invoke the others when the work calls for it.

### Optimera invokes /inspirera

When the Hypothesize step needs external techniques (especially after a plateau), search for approaches the way /inspirera would. Read the source deeply, extract transferable patterns, and fold them into the next hypothesis.

### Realisera invokes /optimera

When realisera picks work that is optimization-shaped (e.g., "improve test performance by 20%", "reduce build time", "increase coverage"), it can delegate to optimera. Realisera provides the context; optimera runs the optimization loop.

### Optimera reads /profilera output

Every experiment runs the effective profile script (`python3 scripts/effective_profile.py` from the profilera skill directory) to get a confidence-weighted summary table. Confidence thresholds per contract profile consumption conventions. Effective confidence weighting ensures stale preferences don't over-constrain experiments. How aggressive to be, how much complexity is acceptable, and what trade-offs the user prefers are all modulated by how recently each preference was confirmed.

### Optimera uses /resonera for objective decisions

When the brainstorm session surfaces ambiguity about what to optimize (competing metrics, unclear constraints, or tradeoffs between measurement approaches), suggest `/resonera` to deliberate first. Resonera can produce or refine OBJECTIVE.md directly, and its DECISIONS.md entries give optimera context for why the objective was chosen. If `DECISIONS.md` exists, read it during the Orient step for context on prior deliberations.

### Inspektera feeds /optimera

When an inspektera audit reveals a poor dimension grade with a clearly measurable improvement path (test coverage, complexity score, dependency count), the finding can become an optimization
objective. `/inspektera` may suggest `/optimera` when the metric and direction are clear.

---

## Getting started

### First optimization

1. `/profilera`: generate or refresh the decision profile (skip if recent)
2. `/optimera`: the first run detects no OBJECTIVE.md, runs a brainstorm with you to define the objective and write the eval harness, then proceeds to experiment 1
3. `/loop 5m /optimera`: set up continuous optimization (like autoresearch overnight runs)

### Resuming optimization

1. `/optimera`: if OBJECTIVE.md and the eval harness exist, starts experimenting immediately. Reads EXPERIMENTS.md to understand what's been tried.

### Changing the target

Edit OBJECTIVE.md directly to adjust the target value or constraints, or tell optimera to "refine the objective" for a guided session. If the measurement approach needs to change, the eval harness must be rebuilt and re-approved.

### Optimera is fed by /planera

When a plan includes optimization-shaped tasks (improving a measurable metric), planera can delegate those tasks to optimera. The plan's acceptance criteria inform the optimization objective.

### Drawing in external techniques

Run `/inspirera <url>` with a relevant article, repo, or resource. The analysis will surface optimization techniques applicable to the objective. The next experiment picks it up naturally from the inspiration analysis.
