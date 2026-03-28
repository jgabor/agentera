# Harness Output Schema

The eval harness outputs one JSON line to stdout. This document defines the format.

---

## Required fields

```json
{
  "metric": <number>,
  "direction": "higher" | "lower"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `metric` | number | The measured value. Must be a finite number (no NaN, no Infinity). |
| `direction` | string | Which direction is "better". `"higher"` means larger values are improvements. `"lower"` means smaller values are improvements. |

## Optional fields

```json
{
  "metric": 85.5,
  "direction": "higher",
  "unit": "%",
  "detail": "42/50 unit tests + 8/10 integration tests passing",
  "breakdown": [
    {"name": "unit tests", "value": 84.0, "unit": "%"},
    {"name": "integration tests", "value": 80.0, "unit": "%"}
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `unit` | string | Unit of measurement (e.g., `"%"`, `"ms"`, `"KB"`, `"violations"`). Displayed in EXPERIMENTS.md for readability. |
| `detail` | string | Human-readable summary of what was measured. Helps the LLM understand the result in context. |
| `breakdown` | array | Sub-measurements that compose the primary metric. Each entry has `name` (string), `value` (number), and optionally `unit` (string). |

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Measurement succeeded. JSON output is valid. |
| Non-zero | Measurement failed. No metric to report. Stderr may contain error details. |

When the harness exits non-zero, the LLM should log the experiment as `status: error` in
EXPERIMENTS.md and include any stderr output for diagnosis.

## Output rules

- Exactly **one JSON line** to stdout. No other stdout output.
- Diagnostic messages, progress bars, and warnings go to **stderr**.
- The JSON must be valid (parseable by any JSON parser).
- The `metric` field must be a finite number. If the measurement produces NaN or Infinity,
  the harness should exit non-zero instead.

## Parsing

The LLM parses the output by reading the single line from stdout and interpreting it as JSON.
No regex extraction, no partial parsing. If the JSON is invalid, treat it as a measurement
failure.

## Examples

Minimal:
```json
{"metric": 0.9978, "direction": "lower"}
```

With unit and detail:
```json
{"metric": 142.3, "direction": "lower", "unit": "ms", "detail": "p95 latency across 1000 requests"}
```

With breakdown:
```json
{"metric": 92.0, "direction": "higher", "unit": "%", "detail": "276/300 tests passing", "breakdown": [{"name": "unit", "value": 95.0, "unit": "%"}, {"name": "integration", "value": 80.0, "unit": "%"}, {"name": "e2e", "value": 90.0, "unit": "%"}]}
```
