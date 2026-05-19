# Semantic Fixture: hej-bare-empty-repo

## Prompt

hej

## Seeded Project State

```json
{
  "files": []
}
```

## Captured Output

```text
┌─┐┌─┐┌─┐┌┐┌┌┬┐┌─┐┬─┐┌─┐
├─┤│ ┬├┤ │││ │ ├┤ ├┬┘├─┤
┴ ┴└─┘└─┘┘└┘ ┴ └─┘┴└─┴ ┴

─── status ─────────────────────────────

  ⌂ project   new

  No saved Agentera project state is present yet. Start by defining the project direction.

─── next ───────────────────────────────

  suggested → ⛥ visionera (define project direction)
```

⌂ hej · waiting
Briefed the empty project from `agentera hej`; continue with the suggested project-direction step when ready.

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
    "┌─┐┌─┐┌─┐",
    "─── status ─────────────────────────────",
    "─── next ───────────────────────────────",
    "suggested → ⛥ visionera (define project direction)",
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
    "agentera hej\nmode:",
    "next_action:",
    "source_contract:",
    "question menu"
  ],
  "required_tool_calls": [
    "agentera hej"
  ],
  "tool_call_counts": {
    "agentera hej": 1
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
