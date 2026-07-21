import fs from "node:fs";
import path from "node:path";

import ts from "typescript";

const MAX_DIAGNOSTIC_BYTES = 8192;
const MIN_DIAGNOSTIC_BYTES = 1024;
const MAX_RENDER_BYTES = 400;
const MAX_RENDER_ITEMS = 10;
const MAX_ARRAY_ITEMS = 10_000;
const MAX_ISSUES = 100;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const REPORT_AGGREGATES = [
  "numTotalTestSuites",
  "numPassedTestSuites",
  "numFailedTestSuites",
  "numPendingTestSuites",
  "numTotalTests",
  "numPassedTests",
  "numFailedTests",
  "numPendingTests",
  "numTodoTests",
];
const FIXED_PENDING = Object.freeze({
  owner: "source",
  path: "packages/cli/test/build/generatedOutputPublication.test.ts",
  suite: "generated generation publication",
  title: "reads one real Darwin process identity independently of caller locale and timezone",
  status: "skipped",
  executesOn: "darwin",
});
const POLICY_KEYS = ["max_diagnostic_utf8_bytes", "allowed_pending_assertion"];
const PENDING_KEYS = ["owner", "path", "suite", "title", "status", "executes_when"];
const EXECUTION_KEYS = ["platform"];

class OverlapContractError extends Error {}

function validUnicode(value) {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value[index] + value[index + 1];
        index += 1;
      } else result += "�";
    } else if (code >= 0xdc00 && code <= 0xdfff) result += "�";
    else result += value[index];
  }
  return result;
}

function utf8Prefix(value, maxBytes) {
  let result = "";
  let bytes = 0;
  for (const character of validUnicode(value)) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

function truncateUtf8(value, maxBytes) {
  const normalized = validUnicode(value);
  if (Buffer.byteLength(normalized, "utf8") <= maxBytes) return normalized;
  const suffix = "...<truncated>";
  return `${utf8Prefix(normalized, Math.max(0, maxBytes - Buffer.byteLength(suffix)))}${suffix}`;
}

function render(value, maxBytes = MAX_RENDER_BYTES, seen = new WeakSet()) {
  try {
    if (typeof value === "string") return truncateUtf8(value, maxBytes);
    if (value === null) return "null";
    if (["undefined", "boolean", "number", "bigint", "symbol"].includes(typeof value)) {
      return truncateUtf8(String(value), maxBytes);
    }
    if (typeof value === "function") return "[function]";
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    let keys;
    try {
      keys = Reflect.ownKeys(value);
    } catch {
      return "[uninspectable object]";
    }
    const shown = [];
    for (const key of keys.slice(0, MAX_RENDER_ITEMS)) {
      let descriptor;
      try {
        descriptor = Object.getOwnPropertyDescriptor(value, key);
      } catch {
        shown.push(`${render(key, 60, seen)}=[unreadable]`);
        continue;
      }
      const rendered = descriptor && "value" in descriptor
        ? render(descriptor.value, Math.floor(maxBytes / 2), seen)
        : "[accessor]";
      shown.push(`${render(key, 60, seen)}=${rendered}`);
    }
    if (keys.length > shown.length) shown.push(`+${keys.length - shown.length} more`);
    return truncateUtf8(`{${shown.join(", ")}}`, maxBytes);
  } catch {
    return "[unrenderable value]";
  }
}

function diagnostic(heading, issues, correction, maxBytes = MAX_DIAGNOSTIC_BYTES) {
  const safeLimit = Number.isSafeInteger(maxBytes)
    ? Math.min(MAX_DIAGNOSTIC_BYTES, Math.max(MIN_DIAGNOSTIC_BYTES, maxBytes))
    : MAX_DIAGNOSTIC_BYTES;
  const shown = issues.slice(0, MAX_RENDER_ITEMS).map((issue) => render(issue, 600));
  const omitted = issues.length > shown.length ? ` (+${issues.length - shown.length} more)` : "";
  const suffix = `; correction: ${render(correction, 1600)}`;
  const body = `${render(heading, 400)}: ${shown.join("; ")}${omitted}`;
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  return `${utf8Prefix(body, Math.max(0, safeLimit - suffixBytes))}${suffix}`;
}

function contractError(heading, issues, correction, maxBytes) {
  return new OverlapContractError(diagnostic(heading, issues, correction, maxBytes));
}

function addIssue(issues, issue) {
  if (issues.length < MAX_ISSUES) issues.push(issue);
}

function isObject(value) {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function isArray(value) {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function dataProperty(object, key, issues, label, { optional = false } = {}) {
  if (!isObject(object)) {
    addIssue(issues, `${label} must be an object`);
    return undefined;
  }
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(object, key);
  } catch (error) {
    addIssue(issues, `${label}.${String(key)} cannot be inspected: ${render(error)}`);
    return undefined;
  }
  if (!descriptor) {
    if (!optional) addIssue(issues, `${label}.${String(key)} is missing`);
    return undefined;
  }
  if (!("value" in descriptor)) {
    addIssue(issues, `${label}.${String(key)} must be an own data property, not an accessor`);
    return undefined;
  }
  return descriptor.value;
}

function ownKeys(object, issues, label) {
  if (!isObject(object) || isArray(object)) {
    addIssue(issues, `${label} must be one object, not ${isArray(object) ? "an array" : render(object)}`);
    return [];
  }
  try {
    return Reflect.ownKeys(object);
  } catch (error) {
    addIssue(issues, `${label} keys cannot be inspected: ${render(error)}`);
    return [];
  }
}

function exactKeys(object, expected, issues, label) {
  const keys = ownKeys(object, issues, label);
  const expectedSet = new Set(expected);
  for (const key of keys) {
    if (typeof key !== "string" || !expectedSet.has(key)) addIssue(issues, `${label} has unsupported key ${render(key)}`);
  }
  for (const key of expected) {
    if (!keys.includes(key)) addIssue(issues, `${label}.${key} is missing`);
  }
}

function dataArray(value, issues, label) {
  if (!isArray(value)) {
    addIssue(issues, `${label} must be an array`);
    return [];
  }
  const length = dataProperty(value, "length", issues, label);
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_ARRAY_ITEMS) {
    addIssue(issues, `${label}.length=${render(length)} must be a safe integer from 0 through ${MAX_ARRAY_ITEMS}`);
    return [];
  }
  const result = [];
  for (let index = 0; index < length; index += 1) {
    const entry = dataProperty(value, String(index), issues, label);
    if (entry !== undefined) result.push(entry);
  }
  return result;
}

function stringArray(value, issues, label) {
  return dataArray(value, issues, label).flatMap((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0) {
      addIssue(issues, `${label}[${index}]=${render(entry)} must be a nonempty string`);
      return [];
    }
    return [entry];
  });
}

function parseReporter(result, issues) {
  if (!isObject(result) || isArray(result)) addIssue(issues, `report must be one object, observed ${render(result)}`);
  const parsed = {
    success: dataProperty(result, "success", issues, "report"),
    testResults: [],
  };
  for (const field of REPORT_AGGREGATES) parsed[field] = dataProperty(result, field, issues, "report");
  parsed.numRuntimeErrorTestSuites = dataProperty(result, "numRuntimeErrorTestSuites", issues, "report", { optional: true });
  const suites = dataArray(dataProperty(result, "testResults", issues, "report"), issues, "report.testResults");
  parsed.testResults = suites.map((suite, suiteIndex) => {
    const label = `report.testResults[${suiteIndex}]`;
    if (!isObject(suite) || isArray(suite)) addIssue(issues, `${label} must be an object`);
    const assertions = dataArray(dataProperty(suite, "assertionResults", issues, label), issues, `${label}.assertionResults`);
    return {
      name: dataProperty(suite, "name", issues, label),
      status: dataProperty(suite, "status", issues, label),
      assertionResults: assertions.map((assertion, assertionIndex) => {
        const assertionLabel = `${label}.assertionResults[${assertionIndex}]`;
        if (!isObject(assertion) || isArray(assertion)) addIssue(issues, `${assertionLabel} must be an object`);
        return {
          fullName: dataProperty(assertion, "fullName", issues, assertionLabel),
          status: dataProperty(assertion, "status", issues, assertionLabel),
        };
      }),
    };
  });
  return parsed;
}

function identityPath(file, repoRoot) {
  if (typeof file !== "string" || file.length === 0) return `<invalid:${render(file, 160)}>`;
  try {
    const native = file.replaceAll("/", path.sep).replaceAll("\\", path.sep);
    const absolute = path.isAbsolute(native) ? native : path.resolve(repoRoot, native);
    return path.relative(repoRoot, absolute).split(path.sep).join("/");
  } catch (error) {
    return `<invalid:${render(error, 160)}>`;
  }
}

function pendingIdentity(authority) {
  return { path: authority.path, name: authority.name, status: authority.status };
}

function parsePendingAuthority(overlapAuthority) {
  const issues = [];
  exactKeys(overlapAuthority, POLICY_KEYS, issues, "overlap");
  const maxDiagnosticBytes = dataProperty(overlapAuthority, "max_diagnostic_utf8_bytes", issues, "overlap");
  const declaration = dataProperty(overlapAuthority, "allowed_pending_assertion", issues, "overlap");
  exactKeys(declaration, PENDING_KEYS, issues, "overlap.allowed_pending_assertion");
  const execution = dataProperty(declaration, "executes_when", issues, "overlap.allowed_pending_assertion");
  exactKeys(execution, EXECUTION_KEYS, issues, "overlap.allowed_pending_assertion.executes_when");
  const fields = {
    owner: dataProperty(declaration, "owner", issues, "overlap.allowed_pending_assertion"),
    path: dataProperty(declaration, "path", issues, "overlap.allowed_pending_assertion"),
    suite: dataProperty(declaration, "suite", issues, "overlap.allowed_pending_assertion"),
    title: dataProperty(declaration, "title", issues, "overlap.allowed_pending_assertion"),
    status: dataProperty(declaration, "status", issues, "overlap.allowed_pending_assertion"),
    executesOn: dataProperty(execution, "platform", issues, "overlap.allowed_pending_assertion.executes_when"),
  };
  if (!Number.isSafeInteger(maxDiagnosticBytes)
    || maxDiagnosticBytes < MIN_DIAGNOSTIC_BYTES
    || maxDiagnosticBytes > MAX_DIAGNOSTIC_BYTES) {
    addIssue(issues, `overlap.max_diagnostic_utf8_bytes=${render(maxDiagnosticBytes)} must be a safe integer from ${MIN_DIAGNOSTIC_BYTES} through ${MAX_DIAGNOSTIC_BYTES}`);
  }
  for (const [field, expected] of Object.entries(FIXED_PENDING)) {
    if (fields[field] !== expected) addIssue(issues, `${field}=${render(fields[field])}; expected ${render(expected)}`);
  }
  if (fields.path === FIXED_PENDING.path
    && (path.isAbsolute(fields.path) || path.posix.normalize(fields.path) !== fields.path || fields.path.includes(".."))) {
    addIssue(issues, `path=${render(fields.path)} must be the canonical repository-relative source path`);
  }
  if (issues.length > 0) {
    throw contractError(
      "overlap authority is invalid",
      issues,
      "restore the closed overlap schema with the one canonical source/Darwin/skipped declaration and max_diagnostic_utf8_bytes no greater than 8192 in references/analysis/verification-policy.yaml",
    );
  }
  return Object.freeze({
    ...fields,
    name: `${fields.suite} ${fields.title}`,
    maxDiagnosticBytes,
  });
}

export function pendingAuthority(overlapAuthority) {
  try {
    return parsePendingAuthority(overlapAuthority);
  } catch (error) {
    if (error instanceof OverlapContractError) throw error;
    throw contractError(
      "overlap authority is invalid",
      [`policy boundary could not be inspected: ${render(error)}`],
      "restore the closed overlap schema in references/analysis/verification-policy.yaml",
    );
  }
}

function isString(node, value) {
  return ts.isStringLiteral(node) && node.text === value;
}

function isRunIfDeclaration(node, authority) {
  if (!ts.isCallExpression(node) || node.arguments.length < 2 || !isString(node.arguments[0], authority.title)) return false;
  const configured = node.expression;
  if (!ts.isCallExpression(configured) || configured.arguments.length !== 1) return false;
  const runIf = configured.expression;
  if (!ts.isPropertyAccessExpression(runIf)
    || !ts.isIdentifier(runIf.expression)
    || runIf.expression.text !== "it"
    || runIf.name.text !== "runIf") return false;
  const condition = configured.arguments[0];
  return ts.isBinaryExpression(condition)
    && condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
    && ts.isPropertyAccessExpression(condition.left)
    && ts.isIdentifier(condition.left.expression)
    && condition.left.expression.text === "process"
    && condition.left.name.text === "platform"
    && isString(condition.right, authority.executesOn);
}

function exactSuiteCallbacks(sourceFile, authority) {
  const callbacks = [];
  function visit(node) {
    if (ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "describe"
      && node.arguments.length >= 2
      && isString(node.arguments[0], authority.suite)
      && (ts.isArrowFunction(node.arguments[1]) || ts.isFunctionExpression(node.arguments[1]))) {
      callbacks.push(node.arguments[1]);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return callbacks;
}

function countRunIf(root, authority) {
  let count = 0;
  function visit(node) {
    if (isRunIfDeclaration(node, authority)) count += 1;
    ts.forEachChild(node, visit);
  }
  visit(root);
  return count;
}

export function validatePendingAuthority(overlapAuthority, { repoRoot, expectedFiles } = {}) {
  const authority = pendingAuthority(overlapAuthority);
  const issues = [];
  const files = stringArray(expectedFiles, issues, "expectedFiles").map((file) => identityPath(file, repoRoot));
  const authorityOccurrences = files.filter((file) => file === authority.path).length;
  if (authorityOccurrences !== 1) addIssue(issues, `authority path inventory occurrences: expected 1, observed ${authorityOccurrences}`);

  let declaredConditionalCount = 0;
  let declaredSuiteCount = 0;
  let totalConditionalCount = 0;
  for (const file of files) {
    if (file.startsWith("../") || path.isAbsolute(file)) {
      addIssue(issues, `source inventory path escapes the repository: ${render(file)}`);
      continue;
    }
    let source;
    try {
      const absolute = path.join(repoRoot, file);
      const size = fs.statSync(absolute).size;
      if (size > MAX_SOURCE_BYTES) {
        addIssue(issues, `source ${render(file)} is ${size} bytes; maximum ${MAX_SOURCE_BYTES}`);
        continue;
      }
      source = fs.readFileSync(absolute, "utf8");
    } catch (error) {
      addIssue(issues, `cannot read ${render(file)}: ${render(error)}`);
      continue;
    }
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    if (sourceFile.parseDiagnostics.length > 0) {
      addIssue(issues, `source ${render(file)} has malformed TypeScript syntax: ${sourceFile.parseDiagnostics.length} parse diagnostic(s)`);
      continue;
    }
    const conditionals = countRunIf(sourceFile, authority);
    totalConditionalCount += conditionals;
    if (file === authority.path) {
      const suites = exactSuiteCallbacks(sourceFile, authority);
      declaredSuiteCount = suites.length;
      declaredConditionalCount = suites.reduce((total, callback) => total + countRunIf(callback, authority), 0);
    }
  }
  if (declaredConditionalCount !== 1) {
    addIssue(issues, `declared source ${render(authority.path)} authoritative conditional count: expected 1, observed ${declaredConditionalCount}`);
  }
  if (declaredSuiteCount !== 1) {
    addIssue(issues, `declared source ${render(authority.path)} suite count: expected 1, observed ${declaredSuiteCount}`);
  }
  if (totalConditionalCount !== 1) addIssue(issues, `executable conditional inventory uniqueness: expected exactly one, observed ${totalConditionalCount}`);
  if (issues.length > 0) {
    throw contractError(
      "overlap pending authority proof failed",
      issues,
      "restore exactly one executable it.runIf(process.platform === \"darwin\") declaration with the canonical title inside the canonical describe suite at the declared source path",
      authority.maxDiagnosticBytes,
    );
  }
  return pendingIdentity(authority);
}

function count(values, status) {
  return values.filter((value) => value.status === status).length;
}

function assertionsFor(testResults) {
  return testResults.flatMap((testResult) => testResult.assertionResults);
}

function aggregateMismatch(issues, result, field, expected) {
  const observed = result[field];
  if (!Number.isSafeInteger(observed) || observed < 0 || observed !== expected) {
    addIssue(issues, `aggregate mismatch ${field}=${render(observed)}, expected ${expected}`);
  }
}

function validateRawStatusShape(result, issues) {
  const validSuiteStatuses = new Set(["passed", "failed", "pending"]);
  const validAssertionStatuses = new Set(["passed", "failed", "skipped", "todo"]);
  for (const suite of result.testResults) {
    if (typeof suite.name !== "string" || suite.name.length === 0) addIssue(issues, `suite name=${render(suite.name)} must be a nonempty string`);
    if (!validSuiteStatuses.has(suite.status)) addIssue(issues, `invalid suite status ${render(suite.status)}`);
    for (const assertion of suite.assertionResults) {
      if (typeof assertion.fullName !== "string" || assertion.fullName.length === 0) addIssue(issues, `assertion fullName=${render(assertion.fullName)} must be a nonempty string`);
      if (!validAssertionStatuses.has(assertion.status)) addIssue(issues, `invalid assertion status ${render(assertion.status)}`);
    }
  }
}

export function normalizeReporterSuiteAggregates(result) {
  try {
    const issues = [];
    const parsed = parseReporter(result, issues);
    validateRawStatusShape(parsed, issues);
    const assertions = assertionsFor(parsed.testResults);
    for (const field of REPORT_AGGREGATES) {
      if (!Number.isSafeInteger(parsed[field]) || parsed[field] < 0) addIssue(issues, `raw ${field}=${render(parsed[field])} must be a nonnegative safe integer`);
    }
    if (parsed.success !== true) addIssue(issues, `raw success=${render(parsed.success)}; expected true before suite projection`);
    if (parsed.numFailedTestSuites !== 0) addIssue(issues, `raw numFailedTestSuites=${render(parsed.numFailedTestSuites)}; expected 0 before suite projection`);
    if (parsed.numPendingTestSuites !== 0) addIssue(issues, `raw numPendingTestSuites=${render(parsed.numPendingTestSuites)}; expected 0 before suite projection`);
    if (parsed.numRuntimeErrorTestSuites !== undefined && parsed.numRuntimeErrorTestSuites !== 0) {
      addIssue(issues, `raw numRuntimeErrorTestSuites=${render(parsed.numRuntimeErrorTestSuites)}; expected 0 before suite projection`);
    }
    const adverseSuites = parsed.testResults.filter(({ status }) => status !== "passed");
    if (adverseSuites.length > 0) addIssue(issues, `raw suite status evidence is adverse: ${adverseSuites.map(({ status }) => render(status, 80)).join(", ")}`);
    if (parsed.numTotalTestSuites !== parsed.numPassedTestSuites) {
      addIssue(issues, `raw suite aggregates contradict: total=${render(parsed.numTotalTestSuites)}, passed=${render(parsed.numPassedTestSuites)}`);
    }
    if (Number.isSafeInteger(parsed.numTotalTestSuites) && parsed.numTotalTestSuites < parsed.testResults.length) {
      addIssue(issues, `raw numTotalTestSuites=${parsed.numTotalTestSuites} cannot cover ${parsed.testResults.length} file-suite result(s)`);
    }
    aggregateMismatch(issues, parsed, "numTotalTests", assertions.length);
    aggregateMismatch(issues, parsed, "numPassedTests", count(assertions, "passed"));
    aggregateMismatch(issues, parsed, "numFailedTests", count(assertions, "failed"));
    aggregateMismatch(issues, parsed, "numPendingTests", count(assertions, "skipped"));
    aggregateMismatch(issues, parsed, "numTodoTests", count(assertions, "todo"));
    if (issues.length > 0) {
      throw contractError(
        "reporter suite normalization rejected adverse or malformed raw evidence",
        issues,
        "rerun the owner and fix its raw success, suite statuses, suite failure/pending aggregates, and exact assertion aggregates before file-suite projection",
      );
    }
    return {
      success: parsed.success,
      numTotalTestSuites: parsed.testResults.length,
      numPassedTestSuites: count(parsed.testResults, "passed"),
      numFailedTestSuites: count(parsed.testResults, "failed"),
      numPendingTestSuites: count(parsed.testResults, "pending"),
      numTotalTests: parsed.numTotalTests,
      numPassedTests: parsed.numPassedTests,
      numFailedTests: parsed.numFailedTests,
      numPendingTests: parsed.numPendingTests,
      numTodoTests: parsed.numTodoTests,
      ...(parsed.numRuntimeErrorTestSuites === undefined ? {} : { numRuntimeErrorTestSuites: parsed.numRuntimeErrorTestSuites }),
      testResults: parsed.testResults,
    };
  } catch (error) {
    if (error instanceof OverlapContractError) throw error;
    throw contractError(
      "reporter suite normalization failed safely",
      [`report boundary could not be inspected: ${render(error)}`],
      "provide one plain JSON reporter object with own data properties and exact non-adverse aggregates",
    );
  }
}

export function expectedPendingTests(owner, platform, overlapAuthority) {
  const authority = pendingAuthority(overlapAuthority);
  return owner === authority.owner && platform !== authority.executesOn ? [pendingIdentity(authority)] : [];
}

function bounded(values) {
  const shown = values.slice(0, MAX_RENDER_ITEMS).map((value) => render(value));
  return `${shown.join(", ")}${values.length > shown.length ? ` (+${values.length - shown.length} more)` : ""}`;
}

function observedPendingTests(testResults, repoRoot) {
  return testResults.flatMap((testResult) => testResult.assertionResults
    .filter(({ status }) => status !== "passed")
    .map(({ fullName, status }) => ({
      path: identityPath(testResult.name, repoRoot),
      name: fullName,
      status,
    })))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function display(identities) {
  return `[${identities.slice(0, MAX_RENDER_ITEMS).map((identity) => ["path", "name", "status"]
    .map((field) => `${field}=${render(identity[field])}`).join(" ")).join(", ")}]`
    + `${identities.length > MAX_RENDER_ITEMS ? ` (+${identities.length - MAX_RENDER_ITEMS} more)` : ""}`;
}

function identitiesMatch(left, right) {
  return left.length === right.length && left.every((identity, index) =>
    identity.path === right[index].path
    && identity.name === right[index].name
    && identity.status === right[index].status);
}

export function validatePendingTests(owner, result, {
  platform,
  repoRoot,
  expectedFiles,
  overlapAuthority,
} = {}) {
  const authority = pendingAuthority(overlapAuthority);
  try {
    const issues = [];
    const parsed = parseReporter(result, issues);
    validateRawStatusShape(parsed, issues);
    const testResults = parsed.testResults;
    const expectedPaths = stringArray(expectedFiles, issues, "expectedFiles").map((file) => identityPath(file, repoRoot));
    if (owner === authority.owner) {
      try {
        validatePendingAuthority(overlapAuthority, { repoRoot, expectedFiles });
      } catch (error) {
        addIssue(issues, render(error, 1000));
      }
    }

    const expectedCounts = new Map();
    for (const file of expectedPaths) expectedCounts.set(file, (expectedCounts.get(file) ?? 0) + 1);
    const duplicateExpected = [...expectedCounts].filter(([, occurrences]) => occurrences > 1).map(([file]) => file);
    if (duplicateExpected.length > 0) addIssue(issues, `inventory duplicate expected files: ${bounded(duplicateExpected)}`);

    const resultPaths = testResults.map((testResult) => identityPath(testResult.name, repoRoot));
    const resultCounts = new Map();
    for (const file of resultPaths) resultCounts.set(file, (resultCounts.get(file) ?? 0) + 1);
    const missing = [...expectedCounts.keys()].filter((file) => !resultCounts.has(file));
    const unexpected = [...resultCounts.keys()].filter((file) => !expectedCounts.has(file));
    const duplicate = [...resultCounts].filter(([, occurrences]) => occurrences > 1).map(([file]) => file);
    if (missing.length > 0) addIssue(issues, `inventory missing result files: ${bounded(missing)}`);
    if (unexpected.length > 0) addIssue(issues, `inventory unexpected result files: ${bounded(unexpected)}`);
    if (duplicate.length > 0) addIssue(issues, `inventory duplicate result files: ${bounded(duplicate)}`);

    const invalidSuiteStatuses = testResults
      .filter(({ status }) => !new Set(["passed", "failed", "pending"]).has(status))
      .map((testResult) => `${identityPath(testResult.name, repoRoot)} (${render(testResult.status, 80)})`);
    if (invalidSuiteStatuses.length > 0) addIssue(issues, `invalid suite statuses: ${bounded(invalidSuiteStatuses)}`);
    const nonPassing = testResults
      .filter(({ status }) => status !== "passed")
      .map((testResult) => `${identityPath(testResult.name, repoRoot)} (${render(testResult.status, 80)})`);
    if (nonPassing.length > 0) addIssue(issues, `nonexecuted suite results: ${bounded(nonPassing)}`);

    const empty = testResults.filter(({ assertionResults }) => assertionResults.length === 0)
      .map((testResult) => identityPath(testResult.name, repoRoot));
    if (empty.length > 0) addIssue(issues, `empty assertionResults files: ${bounded(empty)}`);
    const withoutExecutedAssertions = testResults
      .filter(({ assertionResults }) => assertionResults.length > 0 && !assertionResults.some(({ status }) => status === "passed"))
      .map((testResult) => identityPath(testResult.name, repoRoot));
    if (withoutExecutedAssertions.length > 0) addIssue(issues, `no executed assertions in files: ${bounded(withoutExecutedAssertions)}`);

    const assertions = assertionsFor(testResults);
    const invalidAssertionStatuses = assertions.filter(({ status }) => !new Set(["passed", "failed", "skipped", "todo"]).has(status))
      .map(({ status }) => status);
    if (invalidAssertionStatuses.length > 0) addIssue(issues, `invalid assertion statuses: ${bounded(invalidAssertionStatuses)}`);

    aggregateMismatch(issues, parsed, "numTotalTestSuites", testResults.length);
    aggregateMismatch(issues, parsed, "numPassedTestSuites", count(testResults, "passed"));
    aggregateMismatch(issues, parsed, "numFailedTestSuites", count(testResults, "failed"));
    aggregateMismatch(issues, parsed, "numPendingTestSuites", count(testResults, "pending"));
    aggregateMismatch(issues, parsed, "numTotalTests", assertions.length);
    aggregateMismatch(issues, parsed, "numPassedTests", count(assertions, "passed"));
    aggregateMismatch(issues, parsed, "numFailedTests", count(assertions, "failed"));
    aggregateMismatch(issues, parsed, "numPendingTests", count(assertions, "skipped"));
    aggregateMismatch(issues, parsed, "numTodoTests", count(assertions, "todo"));
    if (parsed.numRuntimeErrorTestSuites !== undefined) aggregateMismatch(issues, parsed, "numRuntimeErrorTestSuites", 0);
    if (parsed.success !== true) addIssue(issues, `success=${render(parsed.success)}; expected true`);

    const expected = expectedPendingTests(owner, platform, overlapAuthority);
    const observed = observedPendingTests(testResults, repoRoot);
    if (!identitiesMatch(observed, expected)) {
      addIssue(issues, `assertion pending identity mismatch: expected ${display(expected)}, observed ${display(observed)}`);
    }

    if (issues.length > 0) {
      const rule = owner === authority.owner
        ? `on ${authority.executesOn} every ${authority.owner} assertion must execute; elsewhere only ${authority.path} :: ${authority.name} may be ${authority.status} inside an otherwise executed file`
        : `${owner} permits no pending suites or assertions`;
      throw contractError(`${owner} overlap execution contract failed on ${render(platform, 80)}`, issues, rule, authority.maxDiagnosticBytes);
    }
    return observed;
  } catch (error) {
    if (error instanceof OverlapContractError) throw error;
    throw contractError(
      `${render(owner, 80)} overlap execution contract failed safely`,
      [`report boundary could not be inspected: ${render(error)}`],
      "provide plain JSON reporter data with own data properties, exact aggregates, and the fixed pending identity",
      authority.maxDiagnosticBytes,
    );
  }
}
