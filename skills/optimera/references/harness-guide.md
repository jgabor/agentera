# Harness Guide

How to write eval harnesses for optimera. Read this before writing a harness during the brainstorm phase.

---

## What a harness is

A harness is a script that measures a single metric about the project and outputs the result as JSON. It wraps the project's own tooling (test runners, benchmarks, linters, build tools) and translates their output into a consistent format that optimera can compare across experiments.

The harness is the **separation of concerns** between measuring and optimizing. The LLM optimizes the code; the harness measures whether the optimization worked. After the user approves it, the harness is locked. The LLM cannot modify it during optimization cycles.

## Principles

### Use the project's own tooling

The harness calls existing commands (`npm test`, `pytest`, `go test`, `cargo build`). It does
not reimplement measurement. The project's tooling is the source of truth; the harness just extracts a number from its output.

### Be deterministic

Given the same codebase state, the harness should produce the same metric. Avoid measurements that depend on network, external services, or system load (unless that's explicitly what's being optimized). If some variance is unavoidable (e.g., benchmark timing), note this in OBJECTIVE.md so the LLM knows to expect noise.

### Be fast

The harness runs every experiment cycle. If it takes 10 minutes, optimization is slow. Prefer focused measurements over comprehensive ones. Measure the specific thing being optimized, not everything.

### Fail loudly

If the measurement can't be taken (build failure, missing dependency, test harness crash), exit non-zero. Don't output a metric. The LLM needs to know the measurement failed, not that the metric is zero.

### Capture what matters

The primary metric is the number being optimized. But a harness can also output breakdowns that help the LLM understand *why* the metric changed. See `output-schema.md` for the full format.

---

## Writing the harness

### Step 1: Identify the measurement command

What existing command measures the thing being optimized?

| Objective | Typical command |
|-----------|----------------|
| Test pass rate | `npm test --json`, `pytest --tb=no -q`, `go test ./... -json` |
| Performance | `hyperfine`, `wrk`, `ab`, custom benchmark scripts |
| Bundle size | `npm run build` then measure file size |
| Lint score | `eslint --format json`, `pylint --output-format=json` |
| Test coverage | `nyc`, `coverage`, `go test -coverprofile` |
| Type coverage | `tsc --noEmit`, `mypy --json-report` |

If the project already has a measurement command, use it. If not, identify the simplest way to measure the metric using standard tooling for the project's language/stack.

### Step 2: Parse the output

Most tools have a structured output mode (JSON, TAP, JUnit XML). Prefer structured output over parsing human-readable text because it's more reliable across versions.

Common patterns:
- `--json` flag (npm test, eslint, pytest with plugins)
- `--format json` (eslint, golangci-lint)
- `-json` flag (go test)
- Pipe to `jq` for extraction
- `--output-format=json` (pylint)

If no structured output is available, parse the human-readable output carefully. Anchor on specific patterns that are unlikely to change across versions.

### Step 3: Output the result

Write one JSON line to stdout. See `output-schema.md` for the exact format. At minimum:

```json
{"metric": 85.5, "direction": "higher"}
```

### Step 4: Handle errors

- **Build/compile failure**: exit non-zero, write error to stderr
- **Test runner crash**: exit non-zero, write error to stderr
- **Partial measurement** (some tests skipped): decide during brainstorm whether to count
  skipped tests. Document the decision in OBJECTIVE.md.
- **Timeout**: the harness itself should not implement timeouts; that's the caller's job.
  But if the underlying tool hangs, consider adding a `timeout` command wrapper.

### Step 5: Test before locking

Run the harness once to verify:
1. It exits 0
2. The JSON output is valid
3. The metric value matches what you'd expect from running the command manually
4. It completes in a reasonable time

Present the output to the user and get explicit approval before locking.

---

## Language choice

Write the harness in whatever language is most natural for the project:

- **Shell (bash)**: good for simple "run command, extract number" patterns. Beware
  cross-platform issues (`stat` flags, `bc` availability, `jq` dependency).
- **Python**: good for complex parsing, available almost everywhere. Use only stdlib to avoid
  dependency issues.
- **Node**: good for JS/TS projects where the measurement tools are npm packages.
- **The project's language**: if the project has a build system (Make, Mage, Just, Task),
  consider adding a harness target.

The harness lives at `.agentera/optimera/<objective-name>/harness` and must be executable (`chmod +x`).

---

## Cross-platform considerations

If the project runs on multiple platforms:

- Use `#!/usr/bin/env bash` not `#!/bin/bash`
- Avoid GNU-specific flags (`stat -c%s` is GNU, `stat -f%z` is BSD), use fallbacks
- Avoid `bc` for math, use `python3 -c` or `node -e` instead for portability
- Test the harness on the platforms the project supports

---

## Multi-metric harnesses

Sometimes the objective involves a primary metric with secondary constraints (e.g., "reduce latency without increasing memory"). The harness can output a breakdown:

```json
{
  "metric": 142.3,
  "direction": "lower",
  "unit": "ms",
  "detail": "p95 latency, 1000 requests",
  "breakdown": [
    {"name": "p50 latency", "value": 89.1, "unit": "ms"},
    {"name": "p99 latency", "value": 312.0, "unit": "ms"},
    {"name": "memory peak", "value": 256, "unit": "MB"}
  ]
}
```

The primary `metric` is what optimera uses for keep/discard decisions. The breakdown gives the LLM richer signal for the Hypothesize step. It can see that p99 is the real problem, or that memory is creeping up.

---

## See also

- `output-schema.md`: formal output format specification
- `examples/`: harness patterns for common metric types
