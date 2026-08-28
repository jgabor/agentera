# Semantic Fixture: plan-explicit-preview

## Prompt

Preview the approved plan, then apply it after explicit approval.

## Seeded Project State

```json
{"files":[{"path":"/tmp/approved-plan.yaml","content":"schema_version: agentera.plan.v1"}]}
```

## Captured Output

The unchanged approved plan input was previewed and then applied.

## Tool Trace

```json
{"calls":["npx -y agentera@next state plan create --input /tmp/approved-plan.yaml --dry-run --format json","npx -y agentera@next state plan create --input /tmp/approved-plan.yaml --format json"]}
```

## Expected Facts

```json
{
  "required_tool_calls": ["state plan create --input /tmp/approved-plan.yaml --dry-run --format json", "state plan create --input /tmp/approved-plan.yaml --format json"],
  "tool_call_counts": {"state plan create": 2, "/tmp/approved-plan.yaml": 2, "--dry-run": 1},
  "forbidden_tool_calls": ["state plan lint", "/tmp/approved-plan-copy.yaml"],
  "artifact_expectations": {"writes": [{"path": ".agentera/entities/plan/plan"}]}
}
```
