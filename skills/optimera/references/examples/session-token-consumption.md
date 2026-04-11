# Harness Example: Session Token Consumption

Measuring how many tokens an agent session consumes, with the goal of reducing total tokens or peak context-window size. Typical objectives: "hej consumes too much in a fresh session," "the orchestrator skill's context window is near the limit," "which artifact contributes most to session cost?"

Read `../agent-session-harness.md` first for the foundational machinery (hermetic vehicle, two-condition A/B runs, stream-JSON telemetry, causal gates, runtime-measured target size) that this example instantiates. This file only covers what's specific to the token-consumption metric.

---

## The metric

Total tokens consumed across an assistant session:

```
total = input_tokens
      + cache_creation_input_tokens
      + cache_read_input_tokens
      + output_tokens
```

summed across every `type=assistant` message in the stream-JSON transcript. Direction: `lower`. Unit: `tokens`.

Projections worth capturing as `breakdown` entries:

- **peak_context**: `max(cache_read_input_tokens + cache_creation_input_tokens)` across any single turn. Signals how close the session came to the context window limit.
- **output_total**: sum of `output_tokens`. Measures how much the agent had to say. High values mean the agent is verbose, not that context is bloated.
- **cache_efficiency**: `sum(cache_read_input_tokens) / (sum(cache_read) + sum(cache_create))`. High values mean the agent re-reads the same prompt material on every turn (expected on multi-turn sessions); low values suggest cache churn.

The primary `metric` is `total` for delta comparisons; the breakdown gives the LLM signal for the Hypothesize step.

---

## Stream-JSON parser

Stdlib-only Python that reads a transcript file and emits a token breakdown. Saved as a helper script next to the harness, called from it:

```python
#!/usr/bin/env python3
"""Parse a claude -p stream-json transcript and emit a token breakdown."""
import json
import sys

def parse(path):
    totals = {"input": 0, "cache_create": 0, "cache_read": 0, "output": 0}
    peak_context = 0
    turn_count = 0
    for line in open(path):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if obj.get("type") != "assistant":
            continue
        turn_count += 1
        usage = (obj.get("message") or {}).get("usage") or {}
        totals["input"]        += usage.get("input_tokens", 0)
        totals["cache_create"] += usage.get("cache_creation_input_tokens", 0)
        totals["cache_read"]   += usage.get("cache_read_input_tokens", 0)
        totals["output"]       += usage.get("output_tokens", 0)
        ctx = usage.get("cache_read_input_tokens", 0) + usage.get("cache_creation_input_tokens", 0)
        if ctx > peak_context:
            peak_context = ctx
    return {
        "total": sum(totals.values()),
        "peak_context": peak_context,
        "turns": turn_count,
        **totals,
    }

if __name__ == "__main__":
    print(json.dumps(parse(sys.argv[1])))
```

The harness calls this per transcript, then computes deltas:

```bash
with_total=$(python3 parse_tokens.py "$RUN_DIR/hej-with.jsonl" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["total"])')
without_total=$(python3 parse_tokens.py "$RUN_DIR/hej-without.jsonl" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["total"])')
delta=$((with_total - without_total))
```

---

## Conditions

For per-skill token measurements:

- **without**: the vehicle runs with no skill plugin mounted. The agent has only the native tool surface (`Read, Glob, Grep, Bash`) and responds to the trigger prompt using runtime-default behavior. This is the baseline for what the trigger prompt "costs" without the skill.
- **with**: the vehicle runs with the skill plugin mounted (or the whole suite, depending on scope). Same trigger prompt, same tool surface, same pinned runtime version.

The per-skill delta is `with.total - without.total`. A positive delta is the skill's session cost. The optimization objective reduces it toward zero.

Trigger prompts should be minimal activations, not workflow runs. One sentence that names the skill or the task it triggers on. Agentera already has a `TRIGGER_PROMPTS` dict in `scripts/eval_skills.py` that can be reused.

---

## Causal gate

A low-token session that passed the numeric gate by never invoking the skill under test is meaningless. The causal gate confirms the skill fired by counting `tool_use` events in the transcript:

```python
def count_skill_invocations(path, skill_name):
    count = 0
    for line in open(path):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        msg = obj.get("message") or {}
        for block in (msg.get("content") or []):
            if not isinstance(block, dict):
                continue
            if block.get("type") != "tool_use":
                continue
            if block.get("name") != "Skill":
                continue
            inp = block.get("input") or {}
            if inp.get("skill") == skill_name:
                count += 1
    return count
```

If `count == 0` in the "with" condition, the causal gate fails and the run is discarded. The harness should surface this clearly in stderr so brainstorm iterations can debug the trigger.

For skills that don't trigger through the `Skill` tool (e.g., MCP-invoked or prompt-pattern-matched), adapt the detector: look for the skill's characteristic step markers in assistant text output, or for a downstream artifact write that only the skill would produce.

---

## Per-artifact attribution (optional)

When the user wants to know which artifacts contribute most to the measurement (to decide where to shrink), instrument the vehicle with a PostToolUse hook on `Read` that logs every file access. Wire the hook inside the container, not on the host, via a minimal `settings.json` copied into the vehicle at build time:

```python
#!/usr/bin/env python3
# log_reads.py: PostToolUse hook that appends each Read to $RUN_DIR/reads.jsonl
import json
import os
import sys

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
path = (data.get("tool_input") or {}).get("file_path")
if not path:
    sys.exit(0)
size = os.path.getsize(path) if os.path.isfile(path) else 0
log_path = os.environ.get("BENCH_READS_LOG", "/tmp/reads.jsonl")
with open(log_path, "a") as f:
    f.write(json.dumps({"path": path, "bytes": size}) + "\n")
```

Post-process the log to rank artifacts by total bytes read:

```python
import json
import collections
totals = collections.Counter()
with open("reads.jsonl") as f:
    for line in f:
        obj = json.loads(line)
        totals[obj["path"]] += obj["bytes"]
for path, bytes_total in totals.most_common(10):
    print(f"{bytes_total:>10} {path}")
```

This turns the harness output into targeted optimization guidance: "PROGRESS.md is 34 KB and gets read three times in this session; consider pagination or summary-only reads." The breakdown field in the optimera JSON output can carry the top-5 contributors.

Skip this on the first iteration. Add it only after the top-line metric has plateaued and the user needs to know where to cut.

---

## Runtime target measurement

For token-consumption measurements the relevant "size" of a target is not total LOC but **artifact size in the state directories the skills read**. A huge codebase with an empty `.agentera/` can be cheaper to run hej against than a tiny repo with bloated state artifacts. Measure accordingly and record:

```bash
cat > "$RUN_DIR/target.meta" <<EOF
target_repo=$TARGET_REPO
measured_at=$(date -Iseconds)
total_bytes=$(find "$TARGET_REPO" -type f -not -path '*/.git/*' -printf '%s\n' | awk '{s+=$1} END{print s+0}')
file_count=$(find "$TARGET_REPO" -type f -not -path '*/.git/*' | wc -l)
agentera_bytes=$(find "$TARGET_REPO/.agentera" -type f -printf '%s\n' 2>/dev/null | awk '{s+=$1} END{print s+0}')
agentera_token_est=$((agentera_bytes / 4))
EOF
```

Token estimate uses bytes/4 as a cheap approximation; swap in `tiktoken` or similar if precision matters. Record the measurements so cross-run comparisons can plot skill cost against `agentera_token_est` rather than against a human-typed bucket.

---

## Gates pseudo-code

```
numeric_pass: (with.total - without.total) < delta_budget
              OR with.total < absolute_budget

causal_pass:  skill_invocation_count(with.jsonl) >= 1

status = PASS if (numeric_pass AND causal_pass) else FAIL
```

Pre-register both gates in OBJECTIVE.md before the first run. Lock them. Refusing to adjust gates after seeing results is what keeps the measurement honest.

---

## Optimera output example

```json
{
  "metric": 48230,
  "direction": "lower",
  "unit": "tokens",
  "detail": "hej session delta vs baseline, pinned vehicle claude@2.1.101, target=agentera@HEAD",
  "breakdown": [
    {"name": "peak_context",     "value": 31200, "unit": "tokens"},
    {"name": "output_total",     "value": 1890,  "unit": "tokens"},
    {"name": "cache_read_total", "value": 42100, "unit": "tokens"},
    {"name": "turns",            "value": 14,    "unit": "count"},
    {"name": "agentera_bytes",   "value": 184320, "unit": "bytes"}
  ]
}
```

---

## Required runtime flags

The vehicle must invoke claude-code with:

- `--output-format stream-json` (not `json`, which gives a single blob)
- `--verbose` (required for `tool_use` events to appear in the stream)
- `--no-session-persistence` (prevents cross-run cache contamination)
- `--dangerously-skip-permissions` (hermetic vehicle has nothing sensitive to protect)
- `--disable-slash-commands` (prevents host slash-command leakage)
- `--max-budget-usd <cap>` (caps runaway cost during harness iteration)
- `--tools "Read,Glob,Grep,Bash"` (explicit tool surface both conditions share)

Missing any of these produces a measurement you can't trust.
