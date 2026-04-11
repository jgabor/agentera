# Agent Session Harness

Measuring the behavior of an agent running a session, reproducibly. Read this before writing a harness for objectives like "reduce token consumption per skill," "reduce wall-clock time for an agent task," or "reduce tool-call count during exploration." These are structurally different from the thin-wrapper archetypes in `examples/` because the measurement emerges from a multi-turn agent run, not from a single command that prints a number.

---

## When this archetype fits

The thin-wrapper archetypes (test-pass-rate, bundle-size, coverage, lint-score, benchmark) cover metrics you get from running one command and parsing its output. Reach for the agent-session archetype when the measurement requires all of:

- The thing you want to measure emerges from an agent running a session (multi-turn conversation, tool use, branching decisions)
- The measurement must be reproducible across runs, so host state (plugins, hooks, agents, MCPs, memory files, skills) cannot contaminate it
- You want to compare two or more conditions (with feature vs without, version A vs B, configuration X vs Y)
- The thing being optimized may not fire at all under some conditions, so "it happened and was small" must be distinguishable from "it never happened"

Example objectives that fit:

- Reduce total token consumption when a skill runs in a fresh session
- Reduce wall-clock time for an agent to complete a defined task
- Reduce tool-call count or read-byte count for exploration-heavy workflows
- Measure $USD cost of a pipeline that invokes multiple agent turns

Example objectives that do NOT fit (use a thin-wrapper archetype instead):

- Measure compile errors, lint warnings, bundle size, test pass rate
- Measure wall-clock time of a deterministic command with no agent involved

---

## Core concepts

### 1. Hermetic vehicle

The session runs in an environment stripped of everything except what the measurement requires. A pinned Docker image is the gold standard: deterministic base, nothing leaks in, reproducible across machines. Alternatives include VM images, Nix shells, firejail, or manual env-var scrubbing. The right choice depends on how sensitive the measurement is to host contamination.

Critical: anything the host provides automatically (claude-code plugins, hooks, agents, MCPs, memory files, globally-installed skills) contributes to every session's baseline. Uncontrolled baseline means cross-run comparisons are noise, not signal. If the user is debugging an unexpected million-token session, host contamination is usually the first suspect.

### 2. Two-condition A/B runs

Every measurement is a delta. Run the same prompt under two conditions, same vehicle, same everything, with only the thing being measured differing. "Without" is the baseline; "with" is the treatment. The metric is the delta, not the absolute number. Absolutes tempt you into claims the data doesn't support.

### 3. Structured per-turn telemetry

The runtime must emit structured per-event telemetry. For claude-code:

```
claude -p --output-format stream-json --verbose
```

emits one JSON object per event. `type=system` events carry session metadata; `type=assistant` events carry per-turn `usage` counts and `tool_use` blocks inside their `content` array. The parser reads the transcript post-hoc and projects whatever measurement matters (tokens, tool-call counts, cost, wall-time, etc.).

`--output-format json` (single blob) does NOT work for this archetype. The single-blob form gives you the last response only, with no per-turn breakdown.

### 4. Causal plus numeric gates

Two gates, both pre-registered before running:

- **Numeric**: the measurement is at or better than the threshold (lower tokens, lower time, etc.)
- **Causal**: the thing being measured actually happened (the skill fired, the tool was invoked, the code path ran)

A session that passes numerically by NOT doing the work (the skill never triggered, the tool was never invoked) fails the causal gate. Both must pass. Without the causal gate you will eventually fool yourself: an optimization that cuts tokens to zero because it stops doing anything is not an optimization.

Good causal gates: count `tool_use` events matching a pattern, detect a specific assistant-output string, verify a downstream artifact was written.

### 5. Per-run artifact directories

Each run writes everything to a dated directory:

```
<output_root>/<run-id>-<target>-<date>/
  prompt-1-without.jsonl    (stream-JSON transcript)
  prompt-1-with.jsonl
  prompt-1-without.meta     (duration, image digest, target measurements)
  prompt-1-with.meta
  prompt-1-without.stderr
  prompt-1-with.stderr
  ...
  run.log
```

Don't summarize away the raw transcripts. Post-processing scripts re-derive numbers on demand. If you want to change the metric formula, you re-parse the existing transcripts instead of re-running the sessions.

### 6. Runtime-measured target size

Never take a categorical `--repo-size small|medium|large` flag as a harness input. Users mislabel, and labels freeze while repos change. Measure the target at run time and record the measurements in the meta file:

- Total byte count and file count
- Byte count (or token-equivalent) of any directories the measurement cares about
- LOC by language if stack-relevant

When plotting or comparing, group by real numbers, not human-chosen buckets.

---

## Harness shape

The harness at `.optimera/harness` typically orchestrates these phases. Pseudo-code, not runnable:

```bash
#!/usr/bin/env bash
set -euo pipefail

TARGET="${TARGET_REPO:?TARGET_REPO required}"
RUN_DIR="benchmarks/$(basename "$TARGET")-$(date +%Y%m%d)"
mkdir -p "$RUN_DIR"

# 1. Vehicle ready (build Docker image, check pinned version, etc.)
ensure_vehicle || { echo "vehicle setup failed" >&2; exit 1; }

# 2. Measure target attributes, write meta
measure_target "$TARGET" > "$RUN_DIR/target.meta"

# 3. Run every prompt under both conditions
for name in "${!PROMPTS[@]}"; do
  prompt="${PROMPTS[$name]}"
  run_vehicle --baseline  "$prompt" "$TARGET" > "$RUN_DIR/${name}-without.jsonl" 2> "$RUN_DIR/${name}-without.stderr"
  run_vehicle --treatment "$prompt" "$TARGET" > "$RUN_DIR/${name}-with.jsonl"    2> "$RUN_DIR/${name}-with.stderr"
done

# 4. Parse transcripts and compute the metric
metric=$(python3 parse_transcripts.py "$RUN_DIR")

# 5. Evaluate gates
gates=$(python3 evaluate_gates.py "$RUN_DIR")

# 6. Emit standard optimera output (see output-schema.md)
echo "{\"metric\": $metric, \"direction\": \"lower\", \"unit\": \"tokens\", \"detail\": \"$gates\"}"
```

The parse and evaluate phases are stdlib Python scripts (agentera convention). Keep them out of the orchestrator shell; they're easier to test in isolation.

---

## Tradeoffs to raise in the brainstorm

The brainstorm should surface these tradeoffs explicitly and let the user pick:

- **Hermeticity versus setup cost**: Docker gives best reproducibility but adds complexity. Early iterations may get useful signal from scrubbing env vars and `--dangerously-skip-permissions --no-session-persistence --disable-slash-commands` without a container. Users debugging host contamination need full hermeticity; users iterating on a skill's own structure may not.

- **Precision versus runtime**: A single session takes tens of seconds. A full matrix (N prompts x M conditions x K targets) can run for an hour or more, at real dollar cost. Cap the matrix during iteration; reserve the full run for CI or milestone checks. State the per-run and per-matrix budgets in OBJECTIVE.md explicitly.

- **Absolute versus delta metrics**: Absolutes are tempting but misleading. Prefer delta metrics (`with - without`) so drift in the baseline doesn't look like a regression in the treatment. If the user insists on absolutes, ask whether a single-condition run is really what they want.

- **Per-resource attribution**: If the user wants to know which inputs contribute most (to decide where to shrink), instrument the vehicle with a tool-use hook that logs every resource access. This is additive infrastructure; skip it on the first cut and add only when the top-line metric plateaus and the user wants to target specific artifacts.

---

## See also

- `output-schema.md`: formal JSON output specification (all harnesses emit this)
- `harness-guide.md`: foundational principles shared by every harness archetype
- `examples/session-token-consumption.md`: first metric-specific realization of this archetype, applied to measuring skill token footprint
