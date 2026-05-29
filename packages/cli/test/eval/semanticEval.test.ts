import { describe, expect, it } from "vitest";

import { buildReport, evaluateFixture } from "../../src/eval/semanticEval.js";
import { validateFixtureText } from "../../src/eval/semanticFixtures.js";

function fixtureText(opts: {
  output?: string;
  toolTrace?: string[] | null;
  required?: string;
  forbidden?: string;
  artifactPath?: string;
  artifactContains?: string;
} = {}): string {
  const output = opts.output ?? "suggest ⧉ realisera for Task 2";
  const toolTrace = opts.toolTrace ?? null;
  const required = opts.required ?? "Task 2";
  const forbidden = opts.forbidden ?? "/realisera";
  const artifactPath = opts.artifactPath ?? ".agentera/plan.yaml";
  const artifactContains = opts.artifactContains ?? "Task 2";
  let toolTraceSection = "";
  if (toolTrace !== null) {
    toolTraceSection = `\n## Tool Trace\n\`\`\`json\n{"calls": ${JSON.stringify(toolTrace)}}\n\`\`\`\n`;
  }
  return (
    "# Semantic Fixture: task-two\n\n" +
    "## Prompt\n" +
    "Start a session.\n\n" +
    "## Seeded Project State\n" +
    "```json\n" +
    '{"files": [{"path": ".agentera/plan.yaml", "content": "### Task 2: Build Offline Semantic Eval Command"}]}\n' +
    "```\n\n" +
    "## Captured Output\n" +
    `${output}\n` +
    toolTraceSection +
    "\n## Expected Facts\n" +
    "```json\n" +
    "{\n" +
    `  "required_output": ["⧉ realisera", "${required}"],\n` +
    `  "forbidden_output": ["${forbidden}"],\n` +
    `  "required_artifacts": [{"path": "${artifactPath}", "contains": ["${artifactContains}"]}],\n` +
    '  "artifact_expectations": {"writes": "none"}\n' +
    "}\n" +
    "```\n"
  );
}

function factMap(text: string): Record<string, any> {
  const [fixture, errors] = validateFixtureText(text);
  expect(errors).toEqual([]);
  const result = evaluateFixture(fixture!, "fixture.md");
  const map: Record<string, any> = {};
  for (const fact of result.checked_facts) {
    map[fact.fact] = fact;
  }
  return map;
}

describe("required output assertion", () => {
  it("passes when captured text matches", () => {
    expect(factMap(fixtureText())["required_output[1]"]).toEqual({
      fact: "required_output[1]",
      status: "pass",
      detail: "captured output contains 'Task 2'",
    });
  });
  it("fails and reports missing text", () => {
    const facts = factMap(fixtureText({ output: "suggest ⧉ realisera", required: "Task 999" }));
    expect(facts["required_output[1]"]).toEqual({
      fact: "required_output[1]",
      status: "fail",
      detail: "captured output does not contain 'Task 999'",
    });
  });
});

describe("forbidden output assertion", () => {
  it("passes when forbidden text is absent", () => {
    expect(factMap(fixtureText())["forbidden_output[0]"]).toEqual({
      fact: "forbidden_output[0]",
      status: "pass",
      detail: "captured output omits forbidden '/realisera'",
    });
  });
  it("fails when forbidden text present", () => {
    expect(factMap(fixtureText({ output: "route /realisera" }))["forbidden_output[0]"]).toEqual({
      fact: "forbidden_output[0]",
      status: "fail",
      detail: "captured output contains forbidden '/realisera'",
    });
  });
});

describe("seeded artifact assertion", () => {
  it("passes when seeded path matches", () => {
    expect(factMap(fixtureText())["required_artifacts[0]"]).toEqual({
      fact: "required_artifacts[0]",
      status: "pass",
      detail: "seeded artifact '.agentera/plan.yaml' matched",
    });
  });
  it("fails when seeded path missing", () => {
    expect(factMap(fixtureText({ artifactPath: ".agentera/progress.yaml" }))["required_artifacts[0]"]).toEqual({
      fact: "required_artifacts[0]",
      status: "fail",
      detail: "seeded artifact '.agentera/progress.yaml' is missing",
    });
  });
});

describe("read-only writes assertion", () => {
  it("passes for read-only writes", () => {
    expect(factMap(fixtureText())["artifact_expectations.writes"]).toEqual({
      fact: "artifact_expectations.writes",
      status: "pass",
      detail: "fixture expects no artifact writes; offline eval performed none",
    });
  });
});

describe("tool trace assertion", () => {
  it("passes a required tool call", () => {
    const text = fixtureText({ toolTrace: ["uv run scripts/agentera hej"] }).replace(
      '"artifact_expectations": {"writes": "none"}',
      '"required_tool_calls": ["agentera hej"], "artifact_expectations": {"writes": "none"}',
    );
    expect(factMap(text)["required_tool_calls[0]"]).toEqual({
      fact: "required_tool_calls[0]",
      status: "pass",
      detail: "tool trace contains 'agentera hej'",
    });
  });
  it("fails a forbidden tool call present in the trace", () => {
    const text = fixtureText({
      toolTrace: ["uv run scripts/agentera hej", "uv run scripts/agentera plan"],
    }).replace(
      '"artifact_expectations": {"writes": "none"}',
      '"forbidden_tool_calls": ["agentera plan"], "artifact_expectations": {"writes": "none"}',
    );
    expect(factMap(text)["forbidden_tool_calls[0]"]).toEqual({
      fact: "forbidden_tool_calls[0]",
      status: "fail",
      detail: "tool trace contains forbidden 'agentera plan'",
    });
  });
  it("fails a duplicate tool-call count", () => {
    const text = fixtureText({
      toolTrace: ["uv run scripts/agentera hej", "uv run scripts/agentera hej"],
    }).replace(
      '"artifact_expectations": {"writes": "none"}',
      '"tool_call_counts": {"agentera hej": 1}, "artifact_expectations": {"writes": "none"}',
    );
    expect(factMap(text)["tool_call_counts[agentera hej]"]).toEqual({
      fact: "tool_call_counts[agentera hej]",
      status: "fail",
      detail: "tool trace contains 2 call(s) matching 'agentera hej'; expected 1",
    });
  });
});

describe("report summaries", () => {
  it("passes and lists checked facts", () => {
    const [fixture, errors] = validateFixtureText(fixtureText());
    expect(errors).toEqual([]);
    const result = evaluateFixture(fixture!, "fixture.md");
    const report = buildReport([result]);
    expect(report.status).toBe("pass");
    expect(report.passed).toBe(1);
    expect(new Set(result.checked_facts.map((f: any) => f.fact))).toEqual(
      new Set([
        "required_output[0]",
        "required_output[1]",
        "forbidden_output[0]",
        "required_artifacts[0]",
        "artifact_expectations.writes",
      ]),
    );
  });

  it("fails and reports the first failing fact", () => {
    const [fixture, errors] = validateFixtureText(
      fixtureText({ output: "suggest ⧉ realisera", required: "Task 999", artifactPath: ".agentera/MISSING.md" }),
    );
    expect(errors).toEqual([]);
    const result = evaluateFixture(fixture!, "fixture.md");
    const report = buildReport([result]);
    expect(report.status).toBe("fail");
    expect(result.failing_fact).toEqual({
      fact: "required_output[1]",
      status: "fail",
      detail: "captured output does not contain 'Task 999'",
    });
  });
});
