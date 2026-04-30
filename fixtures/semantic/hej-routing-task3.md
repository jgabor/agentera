# Semantic Fixture: hej-routing-task3

## Prompt

Run /hej for this project and route to the most useful next action.

## Seeded Project State

```json
{
  "files": [
    {
      "path": ".agentera/PLAN.md",
      "content": "# Plan: Semantic Skill Evaluation Surface\n\n## Tasks\n\n### Task 3: Add Hej Routing Fixture\n**Depends on**: Task 2\n**Status**: □ pending\n**Acceptance**:\n▸ GIVEN seeded artifacts with one highest-priority action WHEN hej output is evaluated THEN the expected concrete next action is required.\n\n### Task 4: Add Unit-Level Assertion Tests\n**Depends on**: Tasks 1, 2, 3\n**Status**: □ pending\n**Acceptance**:\n▸ GIVEN fixture parsing is tested WHEN pytest runs THEN one pass and one fail cover each testable contract unit."
    },
    {
      "path": ".agentera/PROGRESS.md",
      "content": "# Progress\n\n■ ## Cycle 240 · 2026-04-30 10:03 · feat(eval): add offline semantic runner\n\n**What**: Completed Task 2 of the Semantic Skill Evaluation Surface plan.\n**Verified**: Offline semantic eval command passed focused and full pytest validation.\n**Next**: Execute Task 3: add the first hej routing fixture without changing the runner contract."
    }
  ]
}
```

## Captured Output

─── status ─────────────────────────────
plan active · Tasks 1-2 complete · Task 3 pending

─── attention ──────────────────────────
highest-priority action: Task 3: Add Hej Routing Fixture

─── next ───────────────────────────────
suggested -> /realisera (Execute Task 3: Add Hej Routing Fixture)
exit condition: fixture passes only when status, attention item, and concrete Task 3 next action are present.

## Expected Facts

```json
{
  "required_output": [
    "plan active · Tasks 1-2 complete · Task 3 pending",
    "highest-priority action: Task 3: Add Hej Routing Fixture",
    "suggested -> /realisera (Execute Task 3: Add Hej Routing Fixture)",
    "exit condition: fixture passes only when status, attention item, and concrete Task 3 next action are present."
  ],
  "forbidden_output": [
    "Execute Task 4: Add Unit-Level Assertion Tests"
  ],
  "required_artifacts": [
    {
      "path": ".agentera/PLAN.md",
      "contains": [
        "### Task 3: Add Hej Routing Fixture",
        "**Status**: □ pending",
        "### Task 4: Add Unit-Level Assertion Tests"
      ]
    },
    {
      "path": ".agentera/PROGRESS.md",
      "contains": [
        "**Next**: Execute Task 3: add the first hej routing fixture without changing the runner contract."
      ]
    }
  ],
  "artifact_expectations": {"writes": "none"}
}
```
