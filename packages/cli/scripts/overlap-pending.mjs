import path from "node:path";

export const DARWIN_PENDING_TEST_SUITE = "generated generation publication";
export const DARWIN_PENDING_TEST_TITLE = "reads one real Darwin process identity independently of caller locale and timezone";
export const DARWIN_PENDING_TEST = Object.freeze({
  path: "packages/cli/test/build/generatedOutputPublication.test.ts",
  name: `${DARWIN_PENDING_TEST_SUITE} ${DARWIN_PENDING_TEST_TITLE}`,
  status: "skipped",
});

function identityPath(file, repoRoot) {
  if (typeof file !== "string" || file.length === 0) return "<missing>";
  const native = file.replaceAll("/", path.sep).replaceAll("\\", path.sep);
  const absolute = path.isAbsolute(native) ? native : path.resolve(repoRoot, native);
  return path.relative(repoRoot, absolute).split(path.sep).join("/");
}

function observedPendingTests(testResults, repoRoot) {
  return testResults.flatMap((testResult) =>
    (Array.isArray(testResult.assertionResults) ? testResult.assertionResults : [])
      .filter(({ status }) => status !== "passed")
      .map(({ fullName, status }) => ({
        path: identityPath(testResult.name, repoRoot),
        name: fullName,
        status,
      })))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function bounded(values) {
  const shown = values.slice(0, 10).map((value) => String(value).slice(0, 200));
  return `${shown.join(", ")}${values.length > shown.length ? ` (+${values.length - shown.length} more)` : ""}`;
}

function display(identities) {
  const boundedIdentities = identities.slice(0, 10).map((identity) => Object.fromEntries(
    Object.entries(identity).map(([key, value]) => [key, String(value).slice(0, 200)]),
  ));
  return `${JSON.stringify(boundedIdentities)}${identities.length > boundedIdentities.length ? ` (+${identities.length - boundedIdentities.length} more)` : ""}`;
}

function count(values, status) {
  return values.filter((value) => value.status === status).length;
}

function aggregateMismatch(issues, result, field, expected) {
  const observed = result[field];
  if (!Number.isSafeInteger(observed) || observed < 0 || observed !== expected) {
    issues.push(`aggregate mismatch ${field}=${JSON.stringify(observed)}, expected ${expected}`);
  }
}

export function expectedPendingTests(owner, platform) {
  return owner === "source" && platform !== "darwin" ? [DARWIN_PENDING_TEST] : [];
}

export function validatePendingTests(owner, result, { platform, repoRoot, expectedFiles }) {
  const issues = [];
  const testResults = Array.isArray(result.testResults) ? result.testResults : [];
  const expectedPaths = Array.isArray(expectedFiles)
    ? expectedFiles.map((file) => identityPath(file, repoRoot))
    : [];
  if (!Array.isArray(expectedFiles)) issues.push("exact owner inventory was not provided");

  const expectedCounts = new Map();
  for (const file of expectedPaths) expectedCounts.set(file, (expectedCounts.get(file) ?? 0) + 1);
  const duplicateExpected = [...expectedCounts].filter(([, occurrences]) => occurrences > 1).map(([file]) => file);
  if (duplicateExpected.length > 0) issues.push(`inventory duplicate expected files: ${bounded(duplicateExpected)}`);

  const resultPaths = testResults.map((testResult) => identityPath(testResult.name, repoRoot));
  const resultCounts = new Map();
  for (const file of resultPaths) resultCounts.set(file, (resultCounts.get(file) ?? 0) + 1);
  const missing = [...expectedCounts.keys()].filter((file) => !resultCounts.has(file));
  const unexpected = [...resultCounts.keys()].filter((file) => !expectedCounts.has(file));
  const duplicate = [...resultCounts].filter(([, occurrences]) => occurrences > 1).map(([file]) => file);
  if (missing.length > 0) issues.push(`inventory missing result files: ${bounded(missing)}`);
  if (unexpected.length > 0) issues.push(`inventory unexpected result files: ${bounded(unexpected)}`);
  if (duplicate.length > 0) issues.push(`inventory duplicate result files: ${bounded(duplicate)}`);

  const nonPassing = testResults
    .filter(({ status }) => status !== "passed")
    .map((testResult) => `${identityPath(testResult.name, repoRoot)} (${String(testResult.status ?? "missing").slice(0, 80)})`);
  if (nonPassing.length > 0) issues.push(`nonexecuted suite results: ${bounded(nonPassing)}`);

  const empty = testResults
    .filter(({ assertionResults }) => !Array.isArray(assertionResults) || assertionResults.length === 0)
    .map((testResult) => identityPath(testResult.name, repoRoot));
  if (empty.length > 0) issues.push(`empty assertionResults files: ${bounded(empty)}`);

  const withoutExecutedAssertions = testResults
    .filter(({ assertionResults }) => Array.isArray(assertionResults)
      && assertionResults.length > 0
      && !assertionResults.some(({ status }) => status === "passed"))
    .map((testResult) => identityPath(testResult.name, repoRoot));
  if (withoutExecutedAssertions.length > 0) {
    issues.push(`no executed assertions in files: ${bounded(withoutExecutedAssertions)}`);
  }

  const assertions = testResults.flatMap(({ assertionResults }) => Array.isArray(assertionResults) ? assertionResults : []);
  aggregateMismatch(issues, result, "numTotalTests", assertions.length);
  aggregateMismatch(issues, result, "numPassedTests", count(assertions, "passed"));
  aggregateMismatch(issues, result, "numFailedTests", count(assertions, "failed"));
  aggregateMismatch(issues, result, "numPendingTests", count(assertions, "skipped"));
  aggregateMismatch(issues, result, "numTodoTests", count(assertions, "todo"));

  for (const field of ["numTotalTestSuites", "numPassedTestSuites", "numFailedTestSuites", "numPendingTestSuites"]) {
    const value = result[field];
    if (!Number.isSafeInteger(value) || value < 0) issues.push(`aggregate mismatch ${field}=${JSON.stringify(value)}, expected a nonnegative integer`);
  }
  if (
    Number.isSafeInteger(result.numTotalTestSuites)
    && Number.isSafeInteger(result.numPassedTestSuites)
    && Number.isSafeInteger(result.numFailedTestSuites)
    && Number.isSafeInteger(result.numPendingTestSuites)
    && result.numTotalTestSuites !== result.numPassedTestSuites + result.numFailedTestSuites + result.numPendingTestSuites
  ) {
    issues.push(`aggregate mismatch numTotalTestSuites=${result.numTotalTestSuites}, expected ${result.numPassedTestSuites + result.numFailedTestSuites + result.numPendingTestSuites}`);
  }
  if (result.numPendingTestSuites !== 0) issues.push(`numPendingTestSuites=${JSON.stringify(result.numPendingTestSuites)}; expected 0`);
  if (result.numFailedTestSuites !== 0) issues.push(`numFailedTestSuites=${JSON.stringify(result.numFailedTestSuites)}; expected 0`);
  if (result.numRuntimeErrorTestSuites !== undefined && result.numRuntimeErrorTestSuites !== 0) {
    issues.push(`numRuntimeErrorTestSuites=${JSON.stringify(result.numRuntimeErrorTestSuites)}; expected 0`);
  }
  if (result.success !== true) issues.push(`success=${JSON.stringify(result.success)}; expected true`);

  const expected = expectedPendingTests(owner, platform);
  const observed = observedPendingTests(testResults, repoRoot);
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    issues.push(`assertion pending identity mismatch: expected ${display(expected)}, observed ${display(observed)}`);
  }

  if (issues.length > 0) {
    const rule = owner === "source"
      ? `on Darwin every source assertion must execute; off Darwin only ${DARWIN_PENDING_TEST.path} :: ${DARWIN_PENDING_TEST.name} may be skipped inside an otherwise executed file`
      : `${owner} permits no pending suites or assertions on any platform`;
    throw new Error(
      `${owner} overlap execution contract failed on ${platform}: ${issues.slice(0, 10).join("; ")}`
      + `${issues.length > 10 ? ` (+${issues.length - 10} more)` : ""}; `
      + `expected ${display(expected)}, observed ${display(observed)}; correction: ${rule}`,
    );
  }
  return observed;
}
