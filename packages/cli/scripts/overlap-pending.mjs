import fs from "node:fs";
import path from "node:path";
import { inspect } from "node:util";

const FALLBACK_DIAGNOSTIC_BYTES = 8192;
const RENDER_CHARACTERS = 200;
const RENDER_ITEMS = 10;

function render(value, limit = RENDER_CHARACTERS) {
  const rendered = typeof value === "string"
    ? value
    : inspect(value, { depth: 2, maxArrayLength: 10, maxStringLength: 100, breakLength: Infinity, compact: true });
  return rendered.length > limit ? `${rendered.slice(0, limit - 14)}...<truncated>` : rendered;
}

function utf8Prefix(value, maxBytes) {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

function diagnostic(heading, issues, correction, maxBytes = FALLBACK_DIAGNOSTIC_BYTES) {
  const suffix = `; correction: ${render(correction, 1000)}`;
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const body = `${render(heading, 300)}: ${issues.slice(0, RENDER_ITEMS).join("; ")}`
    + `${issues.length > RENDER_ITEMS ? ` (+${issues.length - RENDER_ITEMS} more)` : ""}`;
  return `${utf8Prefix(body, Math.max(0, maxBytes - suffixBytes))}${suffix}`;
}

function bounded(values) {
  const shown = values.slice(0, RENDER_ITEMS).map((value) => render(value));
  return `${shown.join(", ")}${values.length > shown.length ? ` (+${values.length - shown.length} more)` : ""}`;
}

function identityPath(file, repoRoot) {
  if (typeof file !== "string" || file.length === 0) return `<invalid:${render(file, 160)}>`;
  const native = file.replaceAll("/", path.sep).replaceAll("\\", path.sep);
  const absolute = path.isAbsolute(native) ? native : path.resolve(repoRoot, native);
  return path.relative(repoRoot, absolute).split(path.sep).join("/");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function pendingAuthority(overlapAuthority) {
  const declaration = overlapAuthority?.allowed_pending_assertion;
  const maxDiagnosticBytes = overlapAuthority?.max_diagnostic_utf8_bytes;
  const fields = {
    owner: declaration?.owner,
    path: declaration?.path,
    suite: declaration?.suite,
    title: declaration?.title,
    status: declaration?.status,
    executesOn: declaration?.executes_when?.platform,
  };
  const invalid = Object.entries(fields)
    .filter(([, value]) => typeof value !== "string" || value.length === 0)
    .map(([field, value]) => `${field}=${render(value)}`);
  if (!Number.isSafeInteger(maxDiagnosticBytes) || maxDiagnosticBytes < 1024 || maxDiagnosticBytes > 65536) {
    invalid.push(`max_diagnostic_utf8_bytes=${render(maxDiagnosticBytes)}`);
  }
  if (invalid.length > 0) {
    throw new Error(diagnostic(
      "overlap authority is invalid",
      invalid,
      "define one complete overlap.allowed_pending_assertion and a diagnostic byte bound in references/analysis/verification-policy.yaml",
    ));
  }
  return Object.freeze({
    ...fields,
    name: `${fields.suite} ${fields.title}`,
    maxDiagnosticBytes,
  });
}

function pendingIdentity(authority) {
  return { path: authority.path, name: authority.name, status: authority.status };
}

function conditionalPattern(authority) {
  const platform = escapeRegExp(authority.executesOn);
  const title = escapeRegExp(authority.title);
  return new RegExp(`\\bit\\.runIf\\(\\s*process\\.platform\\s*===\\s*["']${platform}["']\\s*\\)\\(\\s*["']${title}["']`, "g");
}

function suitePattern(authority) {
  return new RegExp(`\\bdescribe\\(\\s*["']${escapeRegExp(authority.suite)}["']`, "g");
}

function matchCount(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

export function validatePendingAuthority(overlapAuthority, { repoRoot, expectedFiles }) {
  const authority = pendingAuthority(overlapAuthority);
  const files = Array.isArray(expectedFiles) ? expectedFiles.map((file) => identityPath(file, repoRoot)) : [];
  const issues = [];
  if (files.filter((file) => file === authority.path).length !== 1) {
    issues.push(`authority path inventory occurrences: expected 1, observed ${files.filter((file) => file === authority.path).length}`);
  }

  let declaredConditionalCount = 0;
  let declaredSuiteCount = 0;
  let totalConditionalCount = 0;
  for (const file of files) {
    let source;
    try {
      source = fs.readFileSync(path.join(repoRoot, file), "utf8");
    } catch (error) {
      issues.push(`cannot read ${render(file)}: ${render(error)}`);
      continue;
    }
    const conditionals = matchCount(source, conditionalPattern(authority));
    totalConditionalCount += conditionals;
    if (file === authority.path) {
      declaredConditionalCount = conditionals;
      declaredSuiteCount = matchCount(source, suitePattern(authority));
    }
  }
  if (declaredConditionalCount !== 1) {
    issues.push(`declared source ${render(authority.path)} conditional count: expected 1, observed ${declaredConditionalCount}`);
  }
  if (declaredSuiteCount !== 1) {
    issues.push(`declared source ${render(authority.path)} suite count: expected 1, observed ${declaredSuiteCount}`);
  }
  if (totalConditionalCount !== 1) {
    issues.push(`conditional inventory uniqueness: expected exactly one, observed ${totalConditionalCount}`);
  }
  if (issues.length > 0) {
    throw new Error(diagnostic(
      "overlap pending authority proof failed",
      issues,
      "update the single verification-policy declaration deliberately or restore exactly one matching conditional assertion at its declared source path",
      authority.maxDiagnosticBytes,
    ));
  }
  return pendingIdentity(authority);
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
    .sort((left, right) => render(left).localeCompare(render(right)));
}

function display(identities) {
  return `[${identities.slice(0, RENDER_ITEMS).map((identity) => ["path", "name", "status"]
    .map((field) => `${field}=${render(identity[field])}`).join(" ")).join(", ")}]`
    + `${identities.length > RENDER_ITEMS ? ` (+${identities.length - RENDER_ITEMS} more)` : ""}`;
}

function count(values, status) {
  return values.filter((value) => value?.status === status).length;
}

function aggregateMismatch(issues, result, field, expected) {
  const observed = result?.[field];
  if (!Number.isSafeInteger(observed) || observed < 0 || observed !== expected) {
    issues.push(`aggregate mismatch ${field}=${render(observed)}, expected ${expected}`);
  }
}

function identitiesMatch(left, right) {
  return left.length === right.length && left.every((identity, index) =>
    identity.path === right[index].path
    && identity.name === right[index].name
    && identity.status === right[index].status);
}

export function normalizeReporterSuiteAggregates(result) {
  const testResults = Array.isArray(result?.testResults) ? result.testResults : [];
  return {
    ...result,
    numTotalTestSuites: testResults.length,
    numPassedTestSuites: count(testResults, "passed"),
    numFailedTestSuites: count(testResults, "failed"),
    numPendingTestSuites: count(testResults, "pending"),
  };
}

export function expectedPendingTests(owner, platform, overlapAuthority) {
  const authority = pendingAuthority(overlapAuthority);
  return owner === authority.owner && platform !== authority.executesOn ? [pendingIdentity(authority)] : [];
}

export function validatePendingTests(owner, result, {
  platform,
  repoRoot,
  expectedFiles,
  overlapAuthority,
}) {
  const authority = pendingAuthority(overlapAuthority);
  const issues = [];
  const testResults = Array.isArray(result?.testResults) ? result.testResults : [];
  const expectedPaths = Array.isArray(expectedFiles)
    ? expectedFiles.map((file) => identityPath(file, repoRoot))
    : [];
  if (!Array.isArray(expectedFiles)) issues.push("exact owner inventory was not provided");
  if (owner === authority.owner) {
    try {
      validatePendingAuthority(overlapAuthority, { repoRoot, expectedFiles });
    } catch (error) {
      issues.push(render(error));
    }
  }

  const expectedCounts = new Map();
  for (const file of expectedPaths) expectedCounts.set(file, (expectedCounts.get(file) ?? 0) + 1);
  const duplicateExpected = [...expectedCounts].filter(([, occurrences]) => occurrences > 1).map(([file]) => file);
  if (duplicateExpected.length > 0) issues.push(`inventory duplicate expected files: ${bounded(duplicateExpected)}`);

  const resultPaths = testResults.map((testResult) => identityPath(testResult?.name, repoRoot));
  const resultCounts = new Map();
  for (const file of resultPaths) resultCounts.set(file, (resultCounts.get(file) ?? 0) + 1);
  const missing = [...expectedCounts.keys()].filter((file) => !resultCounts.has(file));
  const unexpected = [...resultCounts.keys()].filter((file) => !expectedCounts.has(file));
  const duplicate = [...resultCounts].filter(([, occurrences]) => occurrences > 1).map(([file]) => file);
  if (missing.length > 0) issues.push(`inventory missing result files: ${bounded(missing)}`);
  if (unexpected.length > 0) issues.push(`inventory unexpected result files: ${bounded(unexpected)}`);
  if (duplicate.length > 0) issues.push(`inventory duplicate result files: ${bounded(duplicate)}`);

  const validSuiteStatuses = new Set(["passed", "failed", "pending"]);
  const invalidSuiteStatuses = testResults
    .filter(({ status }) => !validSuiteStatuses.has(status))
    .map((testResult) => `${identityPath(testResult.name, repoRoot)} (${render(testResult.status, 80)})`);
  if (invalidSuiteStatuses.length > 0) issues.push(`invalid suite statuses: ${bounded(invalidSuiteStatuses)}`);
  const nonPassing = testResults
    .filter(({ status }) => status !== "passed")
    .map((testResult) => `${identityPath(testResult.name, repoRoot)} (${render(testResult.status, 80)})`);
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
  if (withoutExecutedAssertions.length > 0) issues.push(`no executed assertions in files: ${bounded(withoutExecutedAssertions)}`);

  const assertions = testResults.flatMap(({ assertionResults }) => Array.isArray(assertionResults) ? assertionResults : []);
  const validAssertionStatuses = new Set(["passed", "failed", "skipped", "todo"]);
  const invalidAssertionStatuses = assertions.filter(({ status }) => !validAssertionStatuses.has(status)).map(({ status }) => status);
  if (invalidAssertionStatuses.length > 0) issues.push(`invalid assertion statuses: ${bounded(invalidAssertionStatuses)}`);

  aggregateMismatch(issues, result, "numTotalTestSuites", testResults.length);
  aggregateMismatch(issues, result, "numPassedTestSuites", count(testResults, "passed"));
  aggregateMismatch(issues, result, "numFailedTestSuites", count(testResults, "failed"));
  aggregateMismatch(issues, result, "numPendingTestSuites", count(testResults, "pending"));
  aggregateMismatch(issues, result, "numTotalTests", assertions.length);
  aggregateMismatch(issues, result, "numPassedTests", count(assertions, "passed"));
  aggregateMismatch(issues, result, "numFailedTests", count(assertions, "failed"));
  aggregateMismatch(issues, result, "numPendingTests", count(assertions, "skipped"));
  aggregateMismatch(issues, result, "numTodoTests", count(assertions, "todo"));
  if (result?.numRuntimeErrorTestSuites !== undefined) {
    aggregateMismatch(issues, result, "numRuntimeErrorTestSuites", 0);
  }
  if (result?.success !== true) issues.push(`success=${render(result?.success)}; expected true`);

  const expected = expectedPendingTests(owner, platform, overlapAuthority);
  const observed = observedPendingTests(testResults, repoRoot);
  if (!identitiesMatch(observed, expected)) {
    issues.push(`assertion pending identity mismatch: expected ${display(expected)}, observed ${display(observed)}`);
  }

  if (issues.length > 0) {
    const rule = owner === authority.owner
      ? `on ${authority.executesOn} every ${authority.owner} assertion must execute; elsewhere only ${authority.path} :: ${authority.name} may be ${authority.status} inside an otherwise executed file`
      : `${owner} permits no pending suites or assertions`;
    throw new Error(diagnostic(
      `${owner} overlap execution contract failed on ${platform}`,
      issues,
      rule,
      authority.maxDiagnosticBytes,
    ));
  }
  return observed;
}
