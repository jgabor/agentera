import { SemanticFixture, loadFixture, pyRepr } from "./semanticFixtures.js";
import { pyJsonIndent } from "../core/pyjson.js";

/**
 * Offline semantic eval runner for captured skill fixtures. Faithful TS port of
 * scripts/semantic_eval.py. Never invokes a model runtime.
 */

type Dict = Record<string, any>;

export interface CheckedFact {
  fact: string;
  status: string;
  detail: string;
}

function utcTimestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function evaluateFixture(fixture: SemanticFixture, source = "<fixture>"): Dict {
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

export function evaluateFixtureFile(path: string): Dict {
  const [fixture, errors] = loadFixture(path);
  if (errors.length > 0) {
    const failing: CheckedFact = { fact: "fixture_contract", status: "fail", detail: errors.join("; ") };
    return {
      fixture: path,
      status: "fail",
      checked_facts: [failing],
      failing_fact: failing,
    };
  }
  return evaluateFixture(fixture!, path);
}

export function buildReport(results: Dict[]): Dict {
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
  (expected.required_output ?? []).forEach((text: string, index: number) => {
    const found = fixture.capturedOutput.includes(text);
    facts.push({
      fact: `required_output[${index}]`,
      status: found ? "pass" : "fail",
      detail: `captured output ${found ? "contains" : "does not contain"} ${pyRepr(text)}`,
    });
  });
  (expected.forbidden_output ?? []).forEach((text: string, index: number) => {
    const found = fixture.capturedOutput.includes(text);
    facts.push({
      fact: `forbidden_output[${index}]`,
      status: found ? "fail" : "pass",
      detail: `captured output ${found ? "contains forbidden" : "omits forbidden"} ${pyRepr(text)}`,
    });
  });

  const writes = expected.artifact_expectations?.writes;
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
  const callList: string[] = fixture.toolTrace.calls ?? [];
  const calls = callList.join("\n");
  (expected.required_tool_calls ?? []).forEach((text: string, index: number) => {
    const found = calls.includes(text);
    facts.push({
      fact: `required_tool_calls[${index}]`,
      status: found ? "pass" : "fail",
      detail: `tool trace ${found ? "contains" : "does not contain"} ${pyRepr(text)}`,
    });
  });
  (expected.forbidden_tool_calls ?? []).forEach((text: string, index: number) => {
    const found = calls.includes(text);
    facts.push({
      fact: `forbidden_tool_calls[${index}]`,
      status: found ? "fail" : "pass",
      detail: `tool trace ${found ? "contains forbidden" : "omits forbidden"} ${pyRepr(text)}`,
    });
  });
  for (const [text, expectedCount] of Object.entries(expected.tool_call_counts ?? {})) {
    const actual = callList.filter((call) => call.includes(text)).length;
    facts.push({
      fact: `tool_call_counts[${text}]`,
      status: actual === expectedCount ? "pass" : "fail",
      detail: `tool trace contains ${actual} call(s) matching ${pyRepr(text)}; expected ${expectedCount}`,
    });
  }
  return facts;
}

function checkSeededArtifactFacts(fixture: SemanticFixture): CheckedFact[] {
  const facts: CheckedFact[] = [];
  const byPath: Record<string, string> = {};
  for (const item of fixture.seededState.files ?? []) {
    if (item && typeof item === "object" && typeof item.path === "string") {
      byPath[item.path] = item.content;
    }
  }

  (fixture.expectedFacts.required_artifacts ?? []).forEach((expected: any, index: number) => {
    const factName = `required_artifacts[${index}]`;
    if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
      facts.push({ fact: factName, status: "fail", detail: "expected artifact fact must be an object" });
      return;
    }
    const path = expected.path;
    if (typeof path !== "string" || !path.trim()) {
      facts.push({ fact: factName, status: "fail", detail: "expected artifact fact must name a path" });
      return;
    }
    const content = byPath[path];
    if (content === undefined) {
      facts.push({ fact: factName, status: "fail", detail: `seeded artifact ${pyRepr(path)} is missing` });
      return;
    }
    const missing = (expected.contains ?? []).filter((text: string) => !content.includes(text));
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
