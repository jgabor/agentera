# Semantic Fixture: hej-cli-budget

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
      "content": "cycles:\n  - number: 270\n    phase: verify\n    next: Implement Task 5\n"
    }
  ]
}
```

## Captured Output

agentera hej
mode: returning
plan: status=active | progress=4/6
attention:

- normal: PLAN Task 5: Add Tool-Budget And Regression Tests
next_action:
- object=PLAN Task 5: Add Tool-Budget And Regression Tests | capability=orkestrera | reason=first pending plan task

⌂ hej · waiting

## Tool Trace

```json
{
  "calls": [
    "uv run scripts/agentera hej"
  ]
}
```

## Expected Facts

```json
{
  "required_output": [
    "agentera hej",
    "object=PLAN Task 5: Add Tool-Budget And Regression Tests",
    "capability=orkestrera",
    "⌂ hej · waiting"
  ],
  "required_tool_calls": [
    "agentera hej"
  ],
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
