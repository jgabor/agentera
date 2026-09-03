import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import * as overlap from "../../scripts/overlap-pending.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const POLICY_PATH = path.join(REPO_ROOT, "references/analysis/verification-policy.yaml");
const POLICY_BYTES = fs.readFileSync(POLICY_PATH);
const VERIFY_LANE = path.join(REPO_ROOT, "packages/cli/scripts/verify-lane.mjs");
const PENDING_PATH = "packages/cli/test/build/generatedOutputPublication.test.ts";
const PENDING_NAME = "generated generation publication reads one real Darwin process identity independently of caller locale and timezone";
const PACKAGE_FILE = "packages/cli/test/packaging/example.test.ts";

type Assertion = { fullName: string; status: string };
type Suite = { name: string; status: string; assertionResults: Assertion[] };
type Policy = Record<string, unknown>;

function bytes(value: unknown) {
  return Buffer.from(JSON.stringify(value));
}

function assertion(fullName: string, status = "passed"): Assertion {
  return { fullName, status };
}

function suite(file: string, assertions: Assertion[] = [assertion(`${file} passes`)], status = "passed", root = REPO_ROOT): Suite {
  return { name: path.join(root, file), status, assertionResults: assertions };
}

function result(testResults: Suite[], overrides: Record<string, unknown> = {}) {
  const assertions = testResults.flatMap(({ assertionResults }) => assertionResults);
  const count = (values: Array<{ status: string }>, status: string) => values.filter((entry) => entry.status === status).length;
  return {
    success: true,
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

function sourceFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-overlap-authority-"));
  const file = path.join(root, PENDING_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, ['describe("generated generation publication", () => {', '  it.runIf(process.platform === "darwin")("reads one real Darwin process identity independently of caller locale and timezone", () => {});', "});"].join("\n"));
  const overlapTest = path.join(root, "packages/cli/test/verification/overlapPending.test.ts");
  fs.mkdirSync(path.dirname(overlapTest), { recursive: true });
  fs.writeFileSync(overlapTest, "// source fixture\n");
  return root;
}

function expectContractFailure(run: () => unknown) {
  let error: Error | undefined;
  try {
    run();
  } catch (caught) {
    error = caught as Error;
  }
  expect(error).toBeInstanceOf(Error);
  expect(Buffer.byteLength(error?.message ?? "", "utf8")).toBeLessThanOrEqual(8192);
  expect(error?.message).toContain("correction:");
  return error?.message ?? "";
}

function validate(owner: "source" | "package", report: Buffer, ownerFiles: string[], root = REPO_ROOT, platform = "linux") {
  return overlap.validatePendingTests(owner, report, bytes(ownerFiles), POLICY_BYTES, root, platform);
}

function serializedPolicy(mutate: (policy: Policy) => void) {
  const document = YAML.parseDocument(POLICY_BYTES.toString("utf8"), {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  expect(document.errors).toEqual([]);
  const policy = document.toJS({ maxAliasCount: 0 }) as Policy;
  mutate(policy);
  const serialized = Buffer.from(YAML.stringify(policy));
  const reparsed = YAML.parseDocument(serialized.toString("utf8"), {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  expect(reparsed.errors).toEqual([]);
  return serialized;
}

function nestedPolicy(policy: Policy, key: string) {
  return policy[key] as Policy;
}

function expectConsumedPolicyFailure(policyBytes: Buffer) {
  const message = expectContractFailure(() => overlap.loadVerificationPolicy(policyBytes));
  expect(message).toContain("verification policy consumed schema is invalid");
  expect(message).not.toContain("verification policy boundary is invalid");
  expect(message).not.toMatch(/(?:Syntax|Type)Error|\n\s+at\s/);
}

function expectLanePolicyFailure(policyBytes: Buffer, expected: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-overlap-policy-"));
  const policyPath = path.join(directory, "verification-policy.yaml");
  fs.writeFileSync(policyPath, policyBytes);
  const result = spawnSync(process.execPath, [VERIFY_LANE, "validate"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, AGENTERA_VERIFICATION_CONTRACT: policyPath },
  });
  expect(result.status).toBe(2);
  expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThanOrEqual(8192);
  expect(result.stderr).toContain("verification policy could not be read:");
  expect(result.stderr).toContain(expected);
  expect(result.stderr).toContain("correction:");
  expect(result.stderr).not.toMatch(/(?:Syntax|Type)Error|\n\s+at\s/);
}

function expectUnknownOwnerFailure(policyBytes: Buffer) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-overlap-policy-"));
  const policyPath = path.join(directory, "verification-policy.yaml");
  fs.writeFileSync(policyPath, policyBytes);
  const result = spawnSync(process.execPath, [VERIFY_LANE, "validate"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, AGENTERA_VERIFICATION_CONTRACT: policyPath },
  });
  expect(result.status).toBe(2);
  expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThanOrEqual(8192);
  expect(result.stderr).toContain("verification policy: policy 'targeted' names invalid owner 'unknown'");
  expect(result.stderr).toContain("correction:");
  expect(result.stderr).not.toMatch(/(?:Syntax|Type)Error|\n\s+at\s/);
}

describe("serialized overlap evidence boundary", () => {
  it("exports only serialized-boundary operations", () => {
    expect(Object.keys(overlap).sort()).toEqual(["loadVerificationPolicy", "normalizeReporterSuiteAggregates", "validatePendingAuthority", "validatePendingTests"]);
  });

  it("accepts governed YAML and parent-owned JSON result bytes", () => {
    const root = sourceFixture();
    const sourceReport = result([suite("packages/cli/test/verification/overlapPending.test.ts", undefined, "passed", root), suite(PENDING_PATH, [assertion("generation always executes"), assertion(PENDING_NAME, "skipped")], "passed", root)]);
    expect(validate("source", bytes(sourceReport), ["packages/cli/test/verification/overlapPending.test.ts", PENDING_PATH], root)).toEqual([{ path: PENDING_PATH, name: PENDING_NAME, status: "skipped" }]);
    expect(validate("package", bytes(result([suite(PACKAGE_FILE)])), [PACKAGE_FILE])).toEqual([]);
  });

  it("normalizes only validated reporter JSON bytes", () => {
    const raw = result([suite(PACKAGE_FILE)], { numTotalTestSuites: 2, numPassedTestSuites: 2 });
    const normalized = overlap.normalizeReporterSuiteAggregates(bytes(raw));
    expect(JSON.parse(normalized.toString("utf8"))).toMatchObject({
      numTotalTestSuites: 1,
      numPassedTestSuites: 1,
      testResults: [{ name: path.join(REPO_ROOT, PACKAGE_FILE) }],
    });
  });

  it.each([
    ["malformed YAML", Buffer.from("overlap: [")],
    ["duplicate YAML key", Buffer.from(`${POLICY_BYTES.toString("utf8")}\noverlap: {}\n`)],
    ["aliased YAML", Buffer.from(POLICY_BYTES.toString("utf8").replace("  allowed_pending_assertion:\n", "  allowed_pending_assertion: &pending\n").replace("    owner: source\n", "    owner: source\n  copied: *pending\n"))],
    ["cyclic YAML", Buffer.from(POLICY_BYTES.toString("utf8").replace("      platform: darwin", "      platform: &loop { self: *loop }"))],
    ["oversized YAML", Buffer.alloc(2 * 1024 * 1024 + 1, "x")],
    ["structurally invalid YAML", Buffer.from(POLICY_BYTES.toString("utf8").replace("  max_diagnostic_utf8_bytes: 8192", "  unexpected: true\n  max_diagnostic_utf8_bytes: 8192"))],
  ])("fails closed before policy consumption for %s", (_, policyBytes) => {
    expectContractFailure(() => overlap.loadVerificationPolicy(policyBytes));
  });

  it.each([
    [
      "null inventory",
      serializedPolicy((policy) => {
        policy.inventory = null;
      }),
    ],
    [
      "inventory rules object",
      serializedPolicy((policy) => {
        nestedPolicy(policy, "inventory").rules = {};
      }),
    ],
    [
      "null owner definition",
      serializedPolicy((policy) => {
        nestedPolicy(policy, "owners").source = null;
      }),
    ],
    [
      "mixed-files object",
      serializedPolicy((policy) => {
        policy.mixed_files = {};
      }),
    ],
    [
      "policy owner scalar",
      serializedPolicy((policy) => {
        nestedPolicy(policy, "policies").targeted = [0];
      }),
    ],
    [
      "routing scalar",
      serializedPolicy((policy) => {
        nestedPolicy(policy, "conservative_routing").exact = [null];
      }),
    ],
  ])("rejects valid serialized consumed %s before verify-lane can use it", (_, policyBytes) => {
    expectConsumedPolicyFailure(policyBytes);
    expectLanePolicyFailure(policyBytes, "verification policy consumed schema is invalid");
  });

  it("rejects an unknown policy owner after the consumed schema accepts valid YAML", () => {
    const policyBytes = serializedPolicy((policy) => {
      nestedPolicy(policy, "policies").targeted = ["unknown"];
    });
    expect(overlap.loadVerificationPolicy(policyBytes)).toBeDefined();
    expectUnknownOwnerFailure(policyBytes);
  });

  it.each([
    ["malformed JSON", Buffer.from("{")],
    ["oversized JSON", Buffer.alloc(2 * 1024 * 1024 + 1, "x")],
    ["structurally invalid JSON", bytes({ testResults: { $ref: "#" } })],
    ["accessor-like JSON shape", bytes({ get: "success", testResults: [] })],
    ["alias/cycle-like JSON shape", bytes({ testResults: [{ $ref: "#/testResults/0" }] })],
  ])("fails closed before report normalization for %s", (_, reporterBytes) => {
    expectContractFailure(() => overlap.normalizeReporterSuiteAggregates(reporterBytes));
  });

  it("rejects object values rather than treating them as runtime evidence", () => {
    expectContractFailure(() => overlap.loadVerificationPolicy({ overlap: {} } as never));
    expectContractFailure(() => overlap.normalizeReporterSuiteAggregates({ testResults: [] } as never));
    expectContractFailure(() => overlap.validatePendingTests("package", { testResults: [] } as never, bytes([PACKAGE_FILE]), POLICY_BYTES, REPO_ROOT, "linux"));
  });

  it("proves the canonical source declaration from serialized policy and inventory", () => {
    const root = sourceFixture();
    expect(overlap.validatePendingAuthority(POLICY_BYTES, bytes([PENDING_PATH]), root)).toMatchObject({
      path: PENDING_PATH,
      status: "skipped",
    });
  });
});
