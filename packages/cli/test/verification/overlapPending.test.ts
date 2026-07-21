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

  it.each([
    ["scalar", "x".repeat(100_000)],
    ["object", { payload: "x".repeat(100_000) }],
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
