import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";
import { describe, expect, it } from "vitest";

import {
  expectedPendingTests,
  normalizeReporterSuiteAggregates,
  pendingAuthority,
  validatePendingAuthority,
  validatePendingTests,
} from "../../scripts/overlap-pending.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const POLICY = YAML.parse(fs.readFileSync(path.join(REPO_ROOT, "references/analysis/verification-policy.yaml"), "utf8"));
const OVERLAP_AUTHORITY = POLICY.overlap;
const PENDING_AUTHORITY = pendingAuthority(OVERLAP_AUTHORITY);
const PENDING_TEST = expectedPendingTests("source", "linux", OVERLAP_AUTHORITY)[0];
const SOURCE_FILES = [
  "packages/cli/test/verification/overlapPending.test.ts",
  PENDING_TEST.path,
];
const PACKAGE_FILES = ["packages/cli/test/packaging/example.test.ts"];

type Assertion = { fullName: unknown; status: unknown; title: string };
type Suite = { name: unknown; status: unknown; assertionResults: Assertion[] };

function assertion(fullName: unknown, status: unknown = "passed"): Assertion {
  return { fullName, status, title: typeof fullName === "string" ? fullName.split(" ").at(-1) ?? fullName : "malformed" };
}

function suite(file: unknown, assertions: Assertion[] = [assertion(`${String(file)} passes`)], status: unknown = "passed"): Suite {
  return {
    name: typeof file === "string" ? path.join(REPO_ROOT, file) : file,
    status,
    assertionResults: assertions,
  };
}

function result(testResults: Suite[], overrides: Record<string, unknown> = {}) {
  const assertions = testResults.flatMap(({ assertionResults }) => assertionResults);
  const count = (values: Array<{ status: unknown }>, status: string) => values.filter((entry) => entry.status === status).length;
  return {
    success: count(testResults, "failed") === 0,
    numTotalTestSuites: testResults.length,
    numPassedTestSuites: count(testResults, "passed"),
    numFailedTestSuites: count(testResults, "failed"),
    numPendingTestSuites: count(testResults, "pending"),
    numTotalTests: assertions.length,
    numPassedTests: count(assertions, "passed"),
    numFailedTests: count(assertions, "failed"),
    numPendingTests: count(assertions, "skipped"),
    numTodoTests: count(assertions, "todo"),
    testResults,
    ...overrides,
  };
}

function sourceResult(platform: "linux" | "darwin") {
  const conditional = assertion(PENDING_TEST.name, platform === "linux" ? "skipped" : "passed");
  return result([
    suite(SOURCE_FILES[0]),
    suite(SOURCE_FILES[1], [assertion("generated generation publication always executes"), conditional]),
  ]);
}

function validate(owner: "source" | "package", report: ReturnType<typeof result>, platform = "linux") {
  return validatePendingTests(owner, report, {
    platform,
    repoRoot: REPO_ROOT,
    expectedFiles: owner === "source" ? SOURCE_FILES : PACKAGE_FILES,
    overlapAuthority: OVERLAP_AUTHORITY,
  });
}

function conditionalSource(title = PENDING_AUTHORITY.title) {
  return [
    `describe(${JSON.stringify(PENDING_AUTHORITY.suite)}, () => {`,
    ["it.runIf(", `process.platform === ${JSON.stringify(PENDING_AUTHORITY.executesOn)}`, `)(${JSON.stringify(title)}, () => {});`].join(""),
    "});",
  ].join("\n");
}

function authorityFixture(declaredSource: string, otherSources: string[] = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-overlap-authority-"));
  const files = [PENDING_TEST.path, ...otherSources.map((_, index) => `packages/cli/test/other-${index}.test.ts`)];
  for (const [index, file] of files.entries()) {
    const absolute = path.join(root, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, index === 0 ? declaredSource : otherSources[index - 1]);
  }
  return { root, files };
}

function policy(): Record<string, any> {
  return structuredClone(OVERLAP_AUTHORITY);
}

function expectContractFailure(run: () => unknown, correction: RegExp = /correction:/) {
  let error: Error | undefined;
  try {
    run();
  } catch (caught) {
    error = caught as Error;
  }
  expect(error).toBeInstanceOf(Error);
  expect(Buffer.byteLength(error?.message ?? "", "utf8")).toBeLessThanOrEqual(8192);
  expect(error?.message).toMatch(correction);
  return error?.message ?? "";
}

function sparseArray(length: number) {
  const value: unknown[] = [];
  value.length = length;
  return value;
}

describe("full-overlap suite and assertion execution contract", () => {
  it("accepts valid Linux, Darwin, and package reports", () => {
    expect(validate("source", sourceResult("linux"))).toEqual([PENDING_TEST]);
    expect(validate("source", sourceResult("darwin"), "darwin")).toEqual([]);
    expect(validate("package", result(PACKAGE_FILES.map((file) => suite(file))))).toEqual([]);
  });

  it("rejects zero suite aggregates for one passing result", () => {
    const report = result([suite(PACKAGE_FILES[0])], {
      numTotalTestSuites: 0,
      numPassedTestSuites: 0,
    });
    expect(() => validate("package", report)).toThrow(/numTotalTestSuites=0, expected 1.*numPassedTestSuites=0, expected 1/);
  });

  it("adapts upstream nested-suite aggregates to the file-suite result contract", () => {
    const raw = result([suite(PACKAGE_FILES[0])], {
      numTotalTestSuites: 2,
      numPassedTestSuites: 2,
    });
    expect(validate("package", normalizeReporterSuiteAggregates(raw))).toEqual([]);
  });

  it.each([
    ["failed", { numFailedTestSuites: 1 }],
    ["pending", { numPendingTestSuites: 1 }],
    ["runtime failure", { numRuntimeErrorTestSuites: 1 }],
  ])("rejects raw %s suite evidence before projection", (_, overrides) => {
    const raw = result([suite(PACKAGE_FILES[0])], overrides);
    expectContractFailure(
      () => normalizeReporterSuiteAggregates(raw),
      /correction: rerun the owner and fix its raw success, suite statuses, suite failure\/pending aggregates/,
    );
  });

  it.each([false, "true", 1, null, undefined])("rejects raw success=%s before projection", (success) => {
    expect(() => normalizeReporterSuiteAggregates(result([suite(PACKAGE_FILES[0])], { success })))
      .toThrow(/raw success=.*expected true before suite projection/);
  });

  it.each(["failed", "pending", "unknown"])('rejects contradictory raw suite status "%s" before projection', (status) => {
    const raw = result([suite(PACKAGE_FILES[0])], {
      success: true,
      numFailedTestSuites: 0,
      numPendingTestSuites: 0,
    });
    raw.testResults[0].status = status;
    expect(() => normalizeReporterSuiteAggregates(raw)).toThrow(/raw suite status evidence is adverse/);
  });

  it("rejects contradictory raw total and passing suite aggregates", () => {
    expect(() => normalizeReporterSuiteAggregates(result([suite(PACKAGE_FILES[0])], {
      numTotalTestSuites: 3,
      numPassedTestSuites: 2,
    }))).toThrow(/raw suite aggregates contradict/);
  });

  it("preserves exact assertion aggregates while projecting only valid nested suite counts", () => {
    const raw = result([suite(PACKAGE_FILES[0])], {
      numTotalTestSuites: 2,
      numPassedTestSuites: 2,
      numTotalTests: 2,
    });
    expect(() => normalizeReporterSuiteAggregates(raw)).toThrow(/aggregate mismatch numTotalTests=2, expected 1/);
  });

  it.each([
    ["numTotalTestSuites", 0],
    ["numPassedTestSuites", 0],
    ["numFailedTestSuites", 1],
    ["numPendingTestSuites", 1],
    ["numTotalTests", 0],
    ["numPassedTests", 0],
    ["numFailedTests", 1],
    ["numPendingTests", 1],
    ["numTodoTests", 1],
  ])("rejects mismatched %s", (field, value) => {
    expect(() => validate("package", result([suite(PACKAGE_FILES[0])], { [field]: value }))).toThrow(new RegExp(`${field}=.*expected`));
  });

  it.each([
    ["negative", -1],
    ["noninteger", 1.5],
    ["nonnumeric", "1"],
  ])("rejects a %s aggregate", (_, value) => {
    expect(() => validate("package", result([suite(PACKAGE_FILES[0])], { numTotalTestSuites: value }))).toThrow(/numTotalTestSuites=.*expected 1/);
  });

  it.each([
    "numTotalTestSuites",
    "numPassedTestSuites",
    "numFailedTestSuites",
    "numPendingTestSuites",
    "numTotalTests",
    "numPassedTests",
    "numFailedTests",
    "numPendingTests",
    "numTodoTests",
  ])("rejects missing %s", (field) => {
    const report: Record<string, unknown> = result([suite(PACKAGE_FILES[0])]);
    delete report[field];
    expect(() => validate("package", report as ReturnType<typeof result>)).toThrow(new RegExp(`${field}=undefined`));
  });

  it("rejects missing success and suite status fields", () => {
    const report: Record<string, unknown> = result([suite(PACKAGE_FILES[0])]);
    delete report.success;
    delete (report.testResults as Suite[])[0].status;
    expect(() => validate("package", report as ReturnType<typeof result>)).toThrow(/invalid suite statuses.*undefined.*success=undefined/);
  });

  it("rejects nonzero runtime-error suite aggregates", () => {
    expect(() => validate("package", result([suite(PACKAGE_FILES[0])], {
      numRuntimeErrorTestSuites: 1,
    }))).toThrow(/numRuntimeErrorTestSuites=1, expected 0/);
  });

  it.each(["pending", "skipped", "todo", "failed", "unknown"])("rejects a %s suite and reconciles its exact status", (status) => {
    const report = result([suite(PACKAGE_FILES[0], [assertion("package assertion")], status)]);
    expect(() => validate("package", report)).toThrow(new RegExp(`package.*\\(${status}\\)`));
  });

  it("rejects pending suites with empty assertions while preserving the exact Linux assertion skip", () => {
    const hidden = "packages/cli/test/hiddenPending.test.ts";
    const report = result([...sourceResult("linux").testResults, suite(hidden, [], "pending")]);
    expect(() => validatePendingTests("source", report, {
      platform: "linux",
      repoRoot: REPO_ROOT,
      expectedFiles: [...SOURCE_FILES, hidden],
      overlapAuthority: OVERLAP_AUTHORITY,
    })).toThrow(/hiddenPending\.test\.ts \(pending\).*empty assertionResults/);
  });

  it.each([
    ["missing", [suite(SOURCE_FILES[0])]],
    ["duplicate", [suite(SOURCE_FILES[0]), suite(SOURCE_FILES[1]), suite(SOURCE_FILES[1])]],
    ["renamed", [suite(SOURCE_FILES[0]), suite("packages/cli/test/build/renamed.test.ts")]],
    ["empty", [suite(SOURCE_FILES[0]), suite(SOURCE_FILES[1], [])]],
    ["all skipped", [suite(SOURCE_FILES[0]), suite(SOURCE_FILES[1], [assertion(PENDING_TEST.name, "skipped")])]],
  ])("rejects %s file execution evidence", (_, suites) => {
    expect(() => validate("source", result(suites))).toThrow(/inventory|empty assertionResults|no executed assertions/);
  });

  it("normalizes absolute, repository-relative, and reporter separator paths", () => {
    const report = sourceResult("linux");
    report.testResults[0].name = SOURCE_FILES[0];
    report.testResults[1].name = path.join(REPO_ROOT, SOURCE_FILES[1]).replaceAll("/", "\\");
    expect(validate("source", report)).toEqual([PENDING_TEST]);
  });

  it("proves the authoritative conditional exists exactly once in the declared source file", () => {
    expect(validatePendingAuthority(OVERLAP_AUTHORITY, { repoRoot: REPO_ROOT, expectedFiles: SOURCE_FILES })).toEqual(PENDING_TEST);
  });

  it("accepts formatting variants of the exact executable declaration", () => {
    const source = `describe(\n  '${PENDING_AUTHORITY.suite}',\n  function () {\n    it\n      .runIf(\n        process.platform\n          === '${PENDING_AUTHORITY.executesOn}',\n      )(\n        '${PENDING_AUTHORITY.title}',\n        () => {},\n      );\n  },\n);`;
    const fixture = authorityFixture(source);
    expect(validatePendingAuthority(OVERLAP_AUTHORITY, {
      repoRoot: fixture.root,
      expectedFiles: fixture.files,
    })).toEqual(PENDING_TEST);
  });

  it.each([
    ["comment", `describe(${JSON.stringify(PENDING_AUTHORITY.suite)}, () => { /* ${conditionalSource()} */ });`],
    ["string", `describe(${JSON.stringify(PENDING_AUTHORITY.suite)}, () => { const text = ${JSON.stringify(conditionalSource())}; });`],
    ["template", `describe(${JSON.stringify(PENDING_AUTHORITY.suite)}, () => { const text = \`${conditionalSource()}\`; });`],
    ["wrapper", `describe(${JSON.stringify(PENDING_AUTHORITY.suite)}, () => { const runIf = it.runIf; runIf(process.platform === "darwin")(${JSON.stringify(PENDING_AUTHORITY.title)}, () => {}); });`],
    ["alias", `describe(${JSON.stringify(PENDING_AUTHORITY.suite)}, () => { const runner = it; runner.runIf(process.platform === "darwin")(${JSON.stringify(PENDING_AUTHORITY.title)}, () => {}); });`],
    ["template title", `describe(${JSON.stringify(PENDING_AUTHORITY.suite)}, () => { it.runIf(process.platform === "darwin")(\`${PENDING_AUTHORITY.title}\`, () => {}); });`],
  ])("rejects %s text or indirection as the authoritative declaration", (_, source) => {
    const fixture = authorityFixture(source);
    expect(() => validatePendingAuthority(OVERLAP_AUTHORITY, {
      repoRoot: fixture.root,
      expectedFiles: fixture.files,
    })).toThrow(/authoritative conditional count: expected 1, observed 0/);
  });

  it("rejects a duplicate matching conditional assertion", () => {
    const fixture = authorityFixture(conditionalSource(), [conditionalSource()]);
    expect(() => validatePendingAuthority(OVERLAP_AUTHORITY, {
      repoRoot: fixture.root,
      expectedFiles: fixture.files,
    })).toThrow(/expected exactly one.*observed 2/);
  });

  it.each([
    ["renamed", conditionalSource("renamed conditional"), []],
    ["moved", "describe(\"generated generation publication\", () => {});", [conditionalSource()]],
  ])("rejects a %s conditional without an authority update", (_, declared, others) => {
    const fixture = authorityFixture(declared, others);
    expect(() => validatePendingAuthority(OVERLAP_AUTHORITY, {
      repoRoot: fixture.root,
      expectedFiles: fixture.files,
    })).toThrow(/declared source.*expected 1, observed 0/);
  });

  it("rejects a renamed authoritative suite", () => {
    const fixture = authorityFixture(conditionalSource().replace(PENDING_AUTHORITY.suite, "renamed suite"));
    expect(() => validatePendingAuthority(OVERLAP_AUTHORITY, {
      repoRoot: fixture.root,
      expectedFiles: fixture.files,
    })).toThrow(/suite count: expected 1, observed 0/);
  });

  it("rejects malformed TypeScript instead of scanning its text", () => {
    const fixture = authorityFixture(`${conditionalSource()}\nconst broken = ;`);
    expect(() => validatePendingAuthority(OVERLAP_AUTHORITY, {
      repoRoot: fixture.root,
      expectedFiles: fixture.files,
    })).toThrow(/malformed TypeScript syntax/);
  });

  it.each([
    ["missing overlap key", (value: any) => { delete value.max_diagnostic_utf8_bytes; }],
    ["extra overlap key", (value: any) => { value.extra = true; }],
    ["symbol overlap key", (value: any) => { value[Symbol("extra")] = true; }],
    ["array declaration", (value: any) => { value.allowed_pending_assertion = [value.allowed_pending_assertion]; }],
    ["missing declaration key", (value: any) => { delete value.allowed_pending_assertion.title; }],
    ["extra declaration key", (value: any) => { value.allowed_pending_assertion.extra = true; }],
    ["extra execution key", (value: any) => { value.allowed_pending_assertion.executes_when.extra = true; }],
    ["unsafe large cap", (value: any) => { value.max_diagnostic_utf8_bytes = 8193; }],
    ["unsafe small cap", (value: any) => { value.max_diagnostic_utf8_bytes = 1023; }],
    ["malformed cap", (value: any) => { value.max_diagnostic_utf8_bytes = "8192"; }],
    ["unsupported platform", (value: any) => { value.allowed_pending_assertion.executes_when.platform = "linux"; }],
    ["unsupported status", (value: any) => { value.allowed_pending_assertion.status = "todo"; }],
    ["unsupported owner", (value: any) => { value.allowed_pending_assertion.owner = "package"; }],
    ["outside path", (value: any) => { value.allowed_pending_assertion.path = "../outside.test.ts"; }],
    ["malformed path", (value: any) => { value.allowed_pending_assertion.path = "packages/cli/test/../outside.test.ts"; }],
    ["renamed title", (value: any) => { value.allowed_pending_assertion.title = "another title"; }],
    ["oversized title", (value: any) => { value.allowed_pending_assertion.title = "x".repeat(100_000); }],
  ])("fails closed for policy with %s", (_, mutate) => {
    const value = policy();
    mutate(value);
    expectContractFailure(() => pendingAuthority(value), /correction: restore the closed overlap schema/);
  });

  it.each([
    "max_diagnostic_utf8_bytes",
    "allowed_pending_assertion",
  ])("does not execute an overlap.%s getter", (field) => {
    const value = policy();
    let invoked = false;
    Object.defineProperty(value, field, { get() { invoked = true; throw new Error("getter executed"); } });
    expectContractFailure(() => pendingAuthority(value));
    expect(invoked).toBe(false);
  });

  it.each(["owner", "path", "suite", "title", "status", "executes_when"])("does not execute an allowed_pending_assertion.%s getter", (field) => {
    const value = policy();
    let invoked = false;
    Object.defineProperty(value.allowed_pending_assertion, field, { get() { invoked = true; throw new Error("getter executed"); } });
    expectContractFailure(() => pendingAuthority(value));
    expect(invoked).toBe(false);
  });

  it("does not execute the platform getter", () => {
    const value = policy();
    let invoked = false;
    Object.defineProperty(value.allowed_pending_assertion.executes_when, "platform", { get() { invoked = true; throw new Error("getter executed"); } });
    expectContractFailure(() => pendingAuthority(value));
    expect(invoked).toBe(false);
  });

  it("fails safely when a policy proxy rejects inspection", () => {
    const hostile = new Proxy({}, { ownKeys() { throw new Error("proxy trap"); } });
    expectContractFailure(() => pendingAuthority(hostile));
  });

  it("honors a safe smaller diagnostic cap without allowing expansion", () => {
    const value = policy();
    value.max_diagnostic_utf8_bytes = 1024;
    expect(pendingAuthority(value).maxDiagnosticBytes).toBe(1024);
    const report = result([suite("x".repeat(100_000))]);
    const message = expectContractFailure(() => validatePendingTests("package", report, {
      platform: "linux",
      repoRoot: REPO_ROOT,
      expectedFiles: PACKAGE_FILES,
      overlapAuthority: value,
    }));
    expect(Buffer.byteLength(message, "utf8")).toBeLessThanOrEqual(1024);
  });

  it.each([
    "success",
    "numTotalTestSuites",
    "numPassedTestSuites",
    "numFailedTestSuites",
    "numPendingTestSuites",
    "numTotalTests",
    "numPassedTests",
    "numFailedTests",
    "numPendingTests",
    "numTodoTests",
    "numRuntimeErrorTestSuites",
    "testResults",
  ])("does not execute a report.%s getter", (field) => {
    const report = result([suite(PACKAGE_FILES[0])]);
    let invoked = false;
    Object.defineProperty(report, field, { get() { invoked = true; throw new Error("getter executed"); } });
    expectContractFailure(() => normalizeReporterSuiteAggregates(report));
    expectContractFailure(() => validate("package", report));
    expect(invoked).toBe(false);
  });

  it.each(["name", "status", "assertionResults"])("does not execute a suite.%s getter", (field) => {
    const report = result([suite(PACKAGE_FILES[0])]);
    let invoked = false;
    Object.defineProperty(report.testResults[0], field, { get() { invoked = true; throw new Error("getter executed"); } });
    expectContractFailure(() => normalizeReporterSuiteAggregates(report));
    expectContractFailure(() => validate("package", report));
    expect(invoked).toBe(false);
  });

  it.each(["fullName", "status"])("does not execute an assertion.%s getter", (field) => {
    const report = result([suite(PACKAGE_FILES[0])]);
    let invoked = false;
    Object.defineProperty(report.testResults[0].assertionResults[0], field, { get() { invoked = true; throw new Error("getter executed"); } });
    expectContractFailure(() => normalizeReporterSuiteAggregates(report));
    expectContractFailure(() => validate("package", report));
    expect(invoked).toBe(false);
  });

  it.each([
    ["null report", null],
    ["symbol report", Symbol("report")],
    ["bigint report", 1n],
    ["malformed suite", { ...result([]), numTotalTestSuites: 1, testResults: [null] }],
    ["malformed assertion", {
      ...result([]),
      numTotalTestSuites: 1,
      numPassedTestSuites: 1,
      numTotalTests: 1,
      testResults: [{ name: PACKAGE_FILES[0], status: "passed", assertionResults: [null] }],
    }],
    ["sparse suites", { ...result([]), testResults: sparseArray(2) }],
    ["oversized suites", { ...result([]), testResults: sparseArray(10_001) }],
  ])("returns one bounded actionable diagnostic for %s", (_, hostile) => {
    expectContractFailure(() => validate("package", hostile as ReturnType<typeof result>), /correction:/);
  });

  it("returns one bounded actionable diagnostic for circular, invalid-Unicode, symbol, and bigint fields", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const report = result([suite(circular, [assertion("\ud800", Symbol("status"))], 1n)]);
    const message = expectContractFailure(() => validate("package", report));
    expect(message).toContain("�");
    expect(message).toContain("correction:");
  });

  it("fails safely when a report proxy rejects property inspection", () => {
    const hostile = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("proxy trap"); } });
    expectContractFailure(() => validate("package", hostile as ReturnType<typeof result>));
  });

  it.each([
    ["scalar", "x".repeat(100_000)],
    ["object", { payload: "x".repeat(100_000) }],
    ["lone surrogate", "\ud800".repeat(100_000)],
  ])("bounds 100KB malformed %s diagnostics", (_, malformed) => {
    const report = result([suite(malformed, [assertion(malformed, malformed)], malformed)], {
      success: malformed,
      numTotalTestSuites: malformed,
      numTotalTests: malformed,
    });
    let error: Error | undefined;
    try {
      validate("package", report);
    } catch (caught) {
      error = caught as Error;
    }
    expect(error).toBeDefined();
    expect(Buffer.byteLength(error?.message ?? "", "utf8")).toBeLessThanOrEqual(OVERLAP_AUTHORITY.max_diagnostic_utf8_bytes);
    expect(error?.message).toContain("correction: package permits no pending suites or assertions");
  });
});
