import { describe, expect, it } from "vitest";

import type { JsonObject } from "../../src/core/jsonValue.js";
import { buildReport, evaluateFixture } from "../../src/eval/semanticEval.js";
import { validateFixtureText } from "../../src/eval/semanticFixtures.js";

const defaultExpectedFacts: JsonObject = {
  required_output: ["⧉ realisera", "Task 2"],
  forbidden_output: ["/realisera"],
  required_artifacts: [{ path: ".agentera/plan.yaml", contains: ["Task 2"] }],
  artifact_expectations: { writes: "none" },
};

function fixtureText(opts: {
  output?: string;
  toolTrace?: string[] | null;
  expectedFacts?: JsonObject;
} = {}): string {
  const output = opts.output ?? "suggest ⧉ realisera for Task 2";
  const toolTrace = opts.toolTrace ?? null;
  const expectedFacts = opts.expectedFacts ?? defaultExpectedFacts;
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
    JSON.stringify(expectedFacts, null, 2) +
    "\n" +
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
    const facts = factMap(
      fixtureText({
        output: "suggest ⧉ realisera",
        expectedFacts: { ...defaultExpectedFacts, required_output: ["⧉ realisera", "Task 999"] },
      }),
    );
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
    const expectedFacts = {
      ...defaultExpectedFacts,
      required_artifacts: [{ path: ".agentera/progress.yaml", contains: ["Task 2"] }],
    };
    expect(factMap(fixtureText({ expectedFacts }))["required_artifacts[0]"]).toEqual({
      fact: "required_artifacts[0]",
      status: "fail",
      detail: "seeded artifact '.agentera/progress.yaml' is missing",
    });
  });
});

describe("tool trace assertion", () => {
  it("passes a required tool call", () => {
    const text = fixtureText({
      toolTrace: ["uv run scripts/agentera hej"],
      expectedFacts: { ...defaultExpectedFacts, required_tool_calls: ["agentera hej"] },
    });
    expect(factMap(text)["required_tool_calls[0]"]).toEqual({
      fact: "required_tool_calls[0]",
      status: "pass",
      detail: "tool trace contains 'agentera hej'",
    });
  });
  it("fails a missing required tool call", () => {
    const text = fixtureText({
      toolTrace: ["uv run scripts/agentera status"],
      expectedFacts: { ...defaultExpectedFacts, required_tool_calls: ["agentera hej"] },
    });
    expect(factMap(text)["required_tool_calls[0]"]).toEqual({
      fact: "required_tool_calls[0]",
      status: "fail",
      detail: "tool trace does not contain 'agentera hej'",
    });
  });
  it("passes a forbidden tool call absent from the trace", () => {
    const text = fixtureText({
      toolTrace: ["uv run scripts/agentera hej"],
      expectedFacts: { ...defaultExpectedFacts, forbidden_tool_calls: ["agentera plan"] },
    });
    expect(factMap(text)["forbidden_tool_calls[0]"]).toEqual({
      fact: "forbidden_tool_calls[0]",
      status: "pass",
      detail: "tool trace omits forbidden 'agentera plan'",
    });
  });
  it("fails a forbidden tool call present in the trace", () => {
    const text = fixtureText({
      toolTrace: ["uv run scripts/agentera hej", "uv run scripts/agentera plan"],
      expectedFacts: { ...defaultExpectedFacts, forbidden_tool_calls: ["agentera plan"] },
    });
    expect(factMap(text)["forbidden_tool_calls[0]"]).toEqual({
      fact: "forbidden_tool_calls[0]",
      status: "fail",
      detail: "tool trace contains forbidden 'agentera plan'",
    });
  });
  it("passes an exact tool-call count", () => {
    const text = fixtureText({
      toolTrace: ["uv run scripts/agentera hej"],
      expectedFacts: { ...defaultExpectedFacts, tool_call_counts: { "agentera hej": 1 } },
    });
    expect(factMap(text)["tool_call_counts[agentera hej]"]).toEqual({
      fact: "tool_call_counts[agentera hej]",
      status: "pass",
      detail: "tool trace contains 1 call(s) matching 'agentera hej'; expected 1",
    });
  });
  it("fails a duplicate tool-call count", () => {
    const text = fixtureText({
      toolTrace: ["uv run scripts/agentera hej", "uv run scripts/agentera hej"],
      expectedFacts: { ...defaultExpectedFacts, tool_call_counts: { "agentera hej": 1 } },
    });
    expect(factMap(text)["tool_call_counts[agentera hej]"]).toEqual({
      fact: "tool_call_counts[agentera hej]",
      status: "fail",
      detail: "tool trace contains 2 call(s) matching 'agentera hej'; expected 1",
    });
  });
});

it("round-trips special characters in expected facts", () => {
  const special = 'quote " slash \\ newline\n```json';
  const expectedFacts: JsonObject = {
    required_output: [special],
    forbidden_output: [special],
    required_artifacts: [{ path: special, contains: [special] }],
    required_tool_calls: [special],
    forbidden_tool_calls: [special],
    tool_call_counts: { [special]: 1 },
    artifact_expectations: { writes: [{ path: special, contains: [special] }] },
  };
  const [fixture, errors] = validateFixtureText(fixtureText({ expectedFacts }));
  expect(errors).toEqual([]);
  expect(fixture?.expectedFacts).toEqual(expectedFacts);
});

describe("report summaries", () => {
  it("passes and lists checked facts", () => {
    const [fixture, errors] = validateFixtureText(fixtureText());
    expect(errors).toEqual([]);
    const result = evaluateFixture(fixture!, "fixture.md");
    const report = buildReport([result]);
    expect(report.status).toBe("pass");
    expect(report.passed).toBe(1);
    expect(result.checked_facts.find((f: any) => f.fact === "artifact_expectations.writes")).toEqual({
      fact: "artifact_expectations.writes",
      status: "pass",
      detail: "fixture expects no artifact writes; offline eval performed none",
    });
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
      fixtureText({
        output: "suggest ⧉ realisera",
        expectedFacts: {
          ...defaultExpectedFacts,
          required_output: ["⧉ realisera", "Task 999"],
          required_artifacts: [{ path: ".agentera/MISSING.md", contains: ["Task 2"] }],
        },
      }),
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
