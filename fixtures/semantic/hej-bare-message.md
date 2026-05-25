# Semantic Fixture: hej-bare-message

## Prompt

hej

## Seeded Project State

```json
{
  "files": [
    {
      "path": ".agentera/plan.yaml",
      "content": "header:\n  status: active\n  title: Bare Hej Routing\ntasks:\n  - number: 2\n    name: Verify bare hej path\n    status: pending\n"
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

  ≡ plan      [░░░░░░░░░░] 0/1 tasks

  The active plan has one concrete next step: verify the bare hej path.

─── attention ──────────────────────────

  → PLAN Task 2: Verify bare hej path

─── next ───────────────────────────────

  suggested → ⎈ orkestrera (PLAN Task 2)
```

⌂ hej · waiting
Briefed the project from `agentera prime`; continue with the suggested plan task when ready.

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
    "→ PLAN Task 2: Verify bare hej path",
    "suggested → ⎈ orkestrera (PLAN Task 2)",
    "⌂ hej · waiting"
  ],
  "forbidden_output": [
    "/realisera",
    "/planera",
    "/orkestrera",
    "/optimera",
    "Hello",
    "Hi there",
    "How can I help",
    "agentera prime\nmode:",
    "next_action:",
    "source_contract:",
    "object=PLAN Task 2",
    "question menu"
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
    "question"
  ],
  "artifact_expectations": {"writes": "none"}
}
```
