# Semantic Fixture: status-cli-budget

## Prompt

Run /agentera for this project and route to the most useful next action.

## Seeded Project State

```json
{
  "files": [
    {
      "path": ".agentera/plan.yaml",
      "content": "header:\n  status: active\n  title: Flat Agentera State CLI\ntasks:\n  - number: 5\n    name: Add Tool-Budget And Regression Tests\n    status: pending\n"
    },
    {
      "path": ".agentera/progress.yaml",
      "content": "cycles:\n  - number: 270\n    phase: build\n    next: Implement Task 5\n"
    }
  ]
}
```

## Captured Output

```text
┌─┐┌─┐┌─┐┌┐┌┌┬┐┌─┐┬─┐┌─┐
├─┤│ ┬├┤ │││ │ ├┤ ├┬┘├─┤
┴ ┴└─┘└─┘┘└┘ ┴ └─┘┴└─┴ ┴

─── status ─────────────────────────────

  ≡ plan      [██████▓░░░] 4/6 tasks

  The active plan is moving; Task 5 is the next concrete checkpoint.

─── attention ──────────────────────────

  → PLAN Task 5: Add Tool-Budget And Regression Tests

─── next ───────────────────────────────

  suggested → ⎈ orkestrera (PLAN Task 5)
```

⌂ hej · waiting
Task 5 is ready to run from the active plan.

## Tool Trace

```json
{
  "calls": [
    "uv run scripts/agentera prime"
  ]
}
```

## Expected Facts

```json
{
  "required_output": [
    "┌─┐┌─┐┌─┐",
    "─── status ─────────────────────────────",
    "≡ plan      [██████▓░░░] 4/6 tasks",
    "→ PLAN Task 5: Add Tool-Budget And Regression Tests",
    "suggested → ⎈ orkestrera (PLAN Task 5)",
    "⌂ hej · waiting"
  ],
  "forbidden_output": [
    "agentera prime\nmode:",
    "next_action:",
    "source_contract:",
    "object=PLAN Task 5"
  ],
  "required_tool_calls": [
    "agentera prime"
  ],
  "tool_call_counts": {
    "agentera prime": 1
  },
  "forbidden_tool_calls": [
    "agentera plan",
    "agentera progress",
    "agentera health",
    "agentera todo",
    "agentera decisions",
    "agentera objective",
    "agentera experiments",
    ".agentera/plan.yaml",
    ".agentera/progress.yaml",
    ".agentera/health.yaml"
  ],
  "artifact_expectations": {"writes": "none"}
}
```
