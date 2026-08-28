# Semantic Fixture: plan-normal-publication

## Prompt

Publish the approved plan normally.

## Seeded Project State

```json
{"files":[{"path":"/tmp/approved-plan.yaml","content":"schema_version: agentera.plan.v1"}]}
```

## Captured Output

The approved plan was published with one typed writer call.

## Tool Trace

```json
{"calls":["npx -y agentera@next state plan create --input /tmp/approved-plan.yaml --format json"]}
```

## Expected Facts

```json
{
  "required_tool_calls": ["state plan create --input /tmp/approved-plan.yaml --format json"],
  "tool_call_counts": {"state plan create": 1, "/tmp/approved-plan.yaml": 1},
  "forbidden_tool_calls": ["state plan lint", "--dry-run"],
  "artifact_expectations": {"writes": [{"path": ".agentera/entities/plan/plan"}]}
}
```
