# Semantic Fixture: initial-terminology-startup

## Prompt

Start Plan with initial terminology advice for the selected term.

## Seeded Project State

```json
{"files": []}
```

## Captured Output

Initial terminology advice was returned in capability_context.glossary_advice.

## Tool Trace

```json
{"calls":["npx -y agentera@next prime --context plan --term-input /tmp/selected-term --format json"]}
```

## Expected Facts

```json
{
  "required_output": ["capability_context.glossary_advice"],
  "required_tool_calls": ["prime --context plan --term-input /tmp/selected-term --format json"],
  "tool_call_counts": {"prime --context plan": 1},
  "forbidden_tool_calls": ["python", "printf", "report glossary-advice", "full-event"],
  "artifact_expectations": {"writes": "none"}
}
```
