import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DARWIN_PENDING_TEST,
  DARWIN_PENDING_TEST_SUITE,
  DARWIN_PENDING_TEST_TITLE,
  expectedPendingTests,
  validatePendingTests,
} from "../../scripts/overlap-pending.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const SOURCE_FILES = [
  "packages/cli/test/example.test.ts",
  DARWIN_PENDING_TEST.path,
];
const PACKAGE_FILES = ["packages/cli/test/packaging/example.test.ts"];

type AssertionStatus = "passed" | "skipped" | "todo" | "failed";
type Assertion = { fullName: string; status: AssertionStatus; title: string };
type Suite = { name: string; status: string; assertionResults: Assertion[] };

function assertion(fullName: string, status: AssertionStatus = "passed"): Assertion {
  return { fullName, status, title: fullName.split(" ").at(-1) ?? fullName };
}

function suite(file: string, assertions: Assertion[] = [assertion(`${file} passes`)], status = "passed"): Suite {
  return {
    name: path.join(REPO_ROOT, file),
    status,
    assertionResults: assertions,
  };
}

function result(testResults: Suite[], overrides: Record<string, unknown> = {}) {
  const assertions = testResults.flatMap(({ assertionResults }) => assertionResults);
  const statusCount = (status: AssertionStatus) => assertions.filter((entry) => entry.status === status).length;
  const suiteStatusCount = (status: string) => testResults.filter((entry) => entry.status === status).length;
  return {
    success: suiteStatusCount("failed") === 0,
    numTotalTestSuites: testResults.length,
    numPassedTestSuites: suiteStatusCount("passed"),
    numFailedTestSuites: suiteStatusCount("failed"),
    numPendingTestSuites: suiteStatusCount("pending") + suiteStatusCount("skipped") + suiteStatusCount("todo"),
    numTotalTests: assertions.length,
    numPassedTests: statusCount("passed"),
    numFailedTests: statusCount("failed"),
    numPendingTests: statusCount("skipped"),
    numTodoTests: statusCount("todo"),
    testResults,
    ...overrides,
  };
}

function sourceResult(platform: "linux" | "darwin") {
  const conditional = assertion(DARWIN_PENDING_TEST.name, platform === "linux" ? "skipped" : "passed");
  return result([
    suite(SOURCE_FILES[0]),
    suite(SOURCE_FILES[1], [assertion("generated generation publication always executes"), conditional]),
  ]);
}

function validateSource(report: ReturnType<typeof result>, platform = "linux") {
  return validatePendingTests("source", report, {
    platform,
    repoRoot: REPO_ROOT,
    expectedFiles: SOURCE_FILES,
  });
}

describe("full-overlap suite and assertion execution contract", () => {
  it("accepts exactly one conditional assertion skip on Linux inside an executed file", () => {
    expect(validateSource(sourceResult("linux"))).toEqual([DARWIN_PENDING_TEST]);
    expect(expectedPendingTests("source", "win32")).toEqual([DARWIN_PENDING_TEST]);
  });

  it("executes the conditional assertion on Darwin", () => {
    expect(validateSource(sourceResult("darwin"), "darwin")).toEqual([]);
    expect(() => validateSource(sourceResult("linux"), "darwin")).toThrow(/expected \[\], observed/);
  });

  it("executes every package assertion and suite on every platform", () => {
    const packageResult = result(PACKAGE_FILES.map((file) => suite(file)));
    expect(validatePendingTests("package", packageResult, {
      platform: "linux",
      repoRoot: REPO_ROOT,
      expectedFiles: PACKAGE_FILES,
    })).toEqual([]);

    const pendingPackage = result([
      suite(PACKAGE_FILES[0], [assertion("package assertion", "skipped")]),
    ]);
    expect(() => validatePendingTests("package", pendingPackage, {
      platform: "linux",
      repoRoot: REPO_ROOT,
      expectedFiles: PACKAGE_FILES,
    })).toThrow(/package permits no pending suites or assertions/);
  });

  it("rejects a pending inventory suite with no assertions even when assertion aggregates balance", () => {
    const hiddenPendingFile = "packages/cli/test/hiddenPending.test.ts";
    const report = result([
      ...sourceResult("linux").testResults,
      suite(hiddenPendingFile, [], "pending"),
    ]);
    expect(() => validatePendingTests("source", report, {
      platform: "linux",
      repoRoot: REPO_ROOT,
      expectedFiles: [...SOURCE_FILES, hiddenPendingFile],
    })).toThrow(/hiddenPending\.test\.ts \(pending\).*empty assertionResults/);
  });

  it.each(["skipped", "todo", "failed", "unknown"])("rejects a %s suite result", (status) => {
    const report = result([
      suite(SOURCE_FILES[0]),
      suite(SOURCE_FILES[1], [assertion("generated suite assertion")], status),
    ]);
    expect(() => validateSource(report)).toThrow(new RegExp(`generatedOutputPublication\\.test\\.ts \\(${status}\\)`));
  });

  it.each([
    ["missing", [suite(SOURCE_FILES[0])]],
    ["duplicate", [suite(SOURCE_FILES[0]), suite(SOURCE_FILES[1]), suite(SOURCE_FILES[1])]],
    ["renamed", [suite(SOURCE_FILES[0]), suite("packages/cli/test/build/renamed.test.ts")]],
  ])("rejects %s owner inventory files", (_, suites) => {
    expect(() => validateSource(result(suites))).toThrow(/inventory (?:missing|duplicate|unexpected)/);
  });

  it("rejects an executed suite with an empty assertion array", () => {
    expect(() => validateSource(result([
      suite(SOURCE_FILES[0]),
      suite(SOURCE_FILES[1], []),
    ]))).toThrow(/empty assertionResults.*generatedOutputPublication\.test\.ts/);
  });

  it("rejects a file whose assertions are all skipped", () => {
    expect(() => validateSource(result([
      suite(SOURCE_FILES[0]),
      suite(SOURCE_FILES[1], [assertion(DARWIN_PENDING_TEST.name, "skipped")]),
    ]))).toThrow(/no executed assertions.*generatedOutputPublication\.test\.ts/);
  });

  it("rejects a nonzero pending-suite aggregate", () => {
    const report = sourceResult("linux");
    expect(() => validateSource({
      ...report,
      numPassedTestSuites: report.numPassedTestSuites - 1,
      numPendingTestSuites: 1,
    })).toThrow(/numPendingTestSuites=1/);
  });

  it.each([
    ["suite total", { numTotalTestSuites: 3 }],
    ["assertion total", { numTotalTests: 4 }],
    ["passed assertions", { numPassedTests: 1 }],
    ["pending assertions", { numPendingTests: 0 }],
  ])("rejects inconsistent %s aggregates", (_, overrides) => {
    expect(() => validateSource({ ...sourceResult("linux"), ...overrides })).toThrow(/aggregate mismatch/);
  });

  it("normalizes absolute, repository-relative, and reporter separator paths", () => {
    const report = sourceResult("linux");
    report.testResults[0].name = SOURCE_FILES[0];
    report.testResults[1].name = path.join(REPO_ROOT, SOURCE_FILES[1]).replaceAll("/", "\\");
    expect(validateSource(report)).toEqual([DARWIN_PENDING_TEST]);
  });

  it.each([
    ["zero or missing", sourceResult("darwin")],
    ["extra skip", result([
      suite(SOURCE_FILES[0], [assertion("ordinary passing test"), assertion("extra skipped test", "skipped")]),
      sourceResult("linux").testResults[1],
    ])],
    ["wrong name", result([
      suite(SOURCE_FILES[0]),
      suite(SOURCE_FILES[1], [assertion("generated suite assertion"), assertion("changed Darwin test", "skipped")]),
    ])],
    ["todo", result([
      suite(SOURCE_FILES[0]),
      suite(SOURCE_FILES[1], [assertion("generated suite assertion"), assertion(DARWIN_PENDING_TEST.name, "todo")]),
    ])],
  ])("rejects %s assertion-level pending evidence", (_, report) => {
    expect(() => validateSource(report)).toThrow(/expected .*generatedOutputPublication\.test\.ts.* observed/);
  });

  it("keeps the structured identity synchronized with the real conditional test", () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, DARWIN_PENDING_TEST.path), "utf8");
    expect(source).toContain(`describe("${DARWIN_PENDING_TEST_SUITE}"`);
    expect(source).toContain(`it.runIf(process.platform === "darwin")("${DARWIN_PENDING_TEST_TITLE}"`);
  });
});
