import { SemanticFixture, loadFixture, pyRepr } from "./semanticFixtures.js";
import { pyJsonIndent } from "../core/pyjson.js";
import type { JsonObject } from "../core/jsonValue.js";

/**
 * Offline semantic eval runner for captured skill fixtures. Faithful TS port of
 * scripts/semantic_eval.py. Never invokes a model runtime.
 */

export interface CheckedFact {
  fact: string;
  status: string;
  detail: string;
}

function utcTimestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function evaluateFixture(fixture: SemanticFixture, source = "<fixture>"): JsonObject {
  const facts = [
    ...checkOutputFacts(fixture),
    ...checkToolTraceFacts(fixture),
    ...checkSeededArtifactFacts(fixture),
  ];
  const failing = facts.find((fact) => fact.status === "fail") ?? null;
  return {
    fixture: source,
    status: failing ? "fail" : "pass",
    checked_facts: facts.map((f) => ({ fact: f.fact, status: f.status, detail: f.detail })),
    failing_fact: failing ? { fact: failing.fact, status: failing.status, detail: failing.detail } : null,
  };
}

export function evaluateFixtureFile(path: string): JsonObject {
  const [fixture, errors] = loadFixture(path);
  if (errors.length > 0) {
    const failing = { fact: "fixture_contract", status: "fail", detail: errors.join("; ") };
    return {
      fixture: path,
      status: "fail",
      checked_facts: [failing],
      failing_fact: failing,
    };
  }
  return evaluateFixture(fixture!, path);
}

export function buildReport(results: JsonObject[]): JsonObject {
  const passed = results.filter((result) => result.status === "pass").length;
  const failed = results.length - passed;
  return {
    timestamp: utcTimestamp(),
    status: failed ? "fail" : "pass",
    fixtures_tested: results.length,
    passed,
    failed,
    results,
  };
}

function checkOutputFacts(fixture: SemanticFixture): CheckedFact[] {
  const facts: CheckedFact[] = [];
  const expected = fixture.expectedFacts;
  const requiredOutput = expected.required_output;
  const requiredOutputArr: string[] = Array.isArray(requiredOutput) ? (requiredOutput as string[]) : []; // cast: JSON.parse fixture IO boundary
  requiredOutputArr.forEach((text: string, index: number) => {
    const found = fixture.capturedOutput.includes(text);
    facts.push({
      fact: `required_output[${index}]`,
      status: found ? "pass" : "fail",
      detail: `captured output ${found ? "contains" : "does not contain"} ${pyRepr(text)}`,
    });
  });
  const forbiddenOutput = expected.forbidden_output;
  const forbiddenOutputArr: string[] = Array.isArray(forbiddenOutput) ? (forbiddenOutput as string[]) : []; // cast: JSON.parse fixture IO boundary
  forbiddenOutputArr.forEach((text: string, index: number) => {
    const found = fixture.capturedOutput.includes(text);
    facts.push({
      fact: `forbidden_output[${index}]`,
      status: found ? "fail" : "pass",
      detail: `captured output ${found ? "contains forbidden" : "omits forbidden"} ${pyRepr(text)}`,
    });
  });

  const artifactExpectations = expected.artifact_expectations as JsonObject | null; // cast: JSON.parse fixture IO boundary
  const writes = artifactExpectations?.writes;
  if (writes === "none") {
    facts.push({
      fact: "artifact_expectations.writes",
      status: "pass",
      detail: "fixture expects no artifact writes; offline eval performed none",
    });
  }
  return facts;
}

function checkToolTraceFacts(fixture: SemanticFixture): CheckedFact[] {
  const facts: CheckedFact[] = [];
  const expected = fixture.expectedFacts;
  const rawCalls = fixture.toolTrace.calls;
  const callList: string[] = Array.isArray(rawCalls) ? (rawCalls as string[]) : []; // cast: JSON.parse fixture IO boundary
  const calls = callList.join("\n");
  const requiredToolCalls = expected.required_tool_calls;
  const requiredToolCallsArr: string[] = Array.isArray(requiredToolCalls) ? (requiredToolCalls as string[]) : []; // cast: JSON.parse fixture IO boundary
  requiredToolCallsArr.forEach((text: string, index: number) => {
    const found = calls.includes(text);
    facts.push({
      fact: `required_tool_calls[${index}]`,
      status: found ? "pass" : "fail",
      detail: `tool trace ${found ? "contains" : "does not contain"} ${pyRepr(text)}`,
    });
  });
  const forbiddenToolCalls = expected.forbidden_tool_calls;
  const forbiddenToolCallsArr: string[] = Array.isArray(forbiddenToolCalls) ? (forbiddenToolCalls as string[]) : []; // cast: JSON.parse fixture IO boundary
  forbiddenToolCallsArr.forEach((text: string, index: number) => {
    const found = calls.includes(text);
    facts.push({
      fact: `forbidden_tool_calls[${index}]`,
      status: found ? "fail" : "pass",
      detail: `tool trace ${found ? "contains forbidden" : "omits forbidden"} ${pyRepr(text)}`,
    });
  });
  const toolCallCounts = expected.tool_call_counts;
  if (toolCallCounts && typeof toolCallCounts === "object" && !Array.isArray(toolCallCounts)) {
    for (const [text, expectedCount] of Object.entries(toolCallCounts as JsonObject)) { // cast: JSON.parse fixture IO boundary
      const actual = callList.filter((call) => call.includes(text)).length;
      facts.push({
        fact: `tool_call_counts[${text}]`,
        status: actual === expectedCount ? "pass" : "fail",
        detail: `tool trace contains ${actual} call(s) matching ${pyRepr(text)}; expected ${expectedCount}`,
      });
    }
  }
  return facts;
}

function checkSeededArtifactFacts(fixture: SemanticFixture): CheckedFact[] {
  const facts: CheckedFact[] = [];
  const byPath: Record<string, string> = {};
  const rawFiles = fixture.seededState.files;
  const filesArr: unknown[] = Array.isArray(rawFiles) ? rawFiles : [];
  for (const item of filesArr) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const obj = item as JsonObject; // cast: JSON.parse fixture IO boundary
      const path = obj.path;
      if (typeof path === "string") {
        byPath[path] = obj.content as string; // cast: JSON.parse fixture IO boundary
      }
    }
  }

  const requiredArtifacts = fixture.expectedFacts.required_artifacts;
  const requiredArtifactsArr: unknown[] = Array.isArray(requiredArtifacts) ? requiredArtifacts : [];
  requiredArtifactsArr.forEach((expected: unknown, index: number) => {
    const factName = `required_artifacts[${index}]`;
    if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
      facts.push({ fact: factName, status: "fail", detail: "expected artifact fact must be an object" });
      return;
    }
    const expectedObj = expected as JsonObject; // cast: JSON.parse fixture IO boundary
    const path = expectedObj.path;
    if (typeof path !== "string" || !path.trim()) {
      facts.push({ fact: factName, status: "fail", detail: "expected artifact fact must name a path" });
      return;
    }
    const content = byPath[path];
    if (content === undefined) {
      facts.push({ fact: factName, status: "fail", detail: `seeded artifact ${pyRepr(path)} is missing` });
      return;
    }
    const containsRaw = expectedObj.contains;
    const containsArr: string[] = Array.isArray(containsRaw) ? (containsRaw as string[]) : []; // cast: JSON.parse fixture IO boundary
    const missing = containsArr.filter((text: string) => !content.includes(text));
    if (missing.length > 0) {
      facts.push({ fact: factName, status: "fail", detail: `seeded artifact ${pyRepr(path)} lacks ${pyRepr(missing[0])}` });
    } else {
      facts.push({ fact: factName, status: "pass", detail: `seeded artifact ${pyRepr(path)} matched` });
    }
  });
  return facts;
}

export function main(argv: string[] = [], out: (line: string) => void = (l) => process.stdout.write(l)): number {
  if (argv.length === 0) {
    process.stderr.write("usage: semantic_eval <fixtures...>\n");
    return 2;
  }
  const report = buildReport(argv.map((path) => evaluateFixtureFile(path)));
  out(pyJsonIndent(report) + "\n");
  return report.status === "pass" ? 0 : 1;
}
