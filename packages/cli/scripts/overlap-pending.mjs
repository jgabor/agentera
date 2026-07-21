import path from "node:path";

export const DARWIN_PENDING_TEST_SUITE = "generated generation publication";
export const DARWIN_PENDING_TEST_TITLE = "reads one real Darwin process identity independently of caller locale and timezone";
export const DARWIN_PENDING_TEST = Object.freeze({
  path: "packages/cli/test/build/generatedOutputPublication.test.ts",
  name: `${DARWIN_PENDING_TEST_SUITE} ${DARWIN_PENDING_TEST_TITLE}`,
  status: "skipped",
});

function identityPath(file, repoRoot) {
  const absolute = path.isAbsolute(file) ? file : path.resolve(repoRoot, file);
  return path.relative(repoRoot, absolute).split(path.sep).join("/");
}

function observedPendingTests(result, repoRoot) {
  return (result.testResults ?? []).flatMap((testResult) =>
    (testResult.assertionResults ?? [])
      .filter(({ status }) => status !== "passed")
      .map(({ fullName, status }) => ({
        path: identityPath(testResult.name, repoRoot),
        name: fullName,
        status,
      })))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function display(identities) {
  const bounded = identities.slice(0, 10).map((identity) => Object.fromEntries(
    Object.entries(identity).map(([key, value]) => [key, String(value).slice(0, 200)]),
  ));
  return `${JSON.stringify(bounded)}${identities.length > bounded.length ? ` (+${identities.length - bounded.length} more)` : ""}`;
}

export function expectedPendingTests(owner, platform) {
  return owner === "source" && platform !== "darwin" ? [DARWIN_PENDING_TEST] : [];
}

export function validatePendingTests(owner, result, { platform, repoRoot }) {
  const expected = expectedPendingTests(owner, platform);
  const observed = observedPendingTests(result, repoRoot);
  const summary = {
    total: result.numTotalTests,
    passed: result.numPassedTests,
    pending: result.numPendingTests,
    todo: result.numTodoTests,
    failed: result.numFailedTests,
  };
  const countsAreExact = result.numTotalTests === result.numPassedTests + result.numPendingTests;
  if (
    result.success !== true
    || result.numFailedTests !== 0
    || result.numTodoTests !== 0
    || !countsAreExact
    || result.numPendingTests !== expected.length
    || JSON.stringify(observed) !== JSON.stringify(expected)
  ) {
    const rule = owner === "source"
      ? `on Darwin every source test must execute; off Darwin only ${DARWIN_PENDING_TEST.path} :: ${DARWIN_PENDING_TEST.name} may be skipped`
      : `${owner} permits no pending tests on any platform`;
    throw new Error(
      `${owner} overlap pending contract failed on ${platform}: ${JSON.stringify(summary)}; `
      + `expected ${display(expected)}, observed ${display(observed)}; correction: ${rule}`,
    );
  }
  return observed;
}
