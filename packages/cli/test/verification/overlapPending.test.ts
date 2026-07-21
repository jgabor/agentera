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

type PendingIdentity = {
  path: string;
  name: string;
  status: string;
};

function assertion(identity: PendingIdentity) {
  return {
    fullName: identity.name,
    status: identity.status,
    title: identity.name.split(" ").at(-1),
  };
}

function result(identities: PendingIdentity[] = [], overrides: Record<string, unknown> = {}) {
  const assertionCount = identities.length + 1;
  const failed = identities.filter(({ status }) => status === "failed").length;
  const todo = identities.filter(({ status }) => status === "todo").length;
  const pending = identities.filter(({ status }) => status === "skipped").length;
  return {
    success: failed === 0,
    numTotalTests: assertionCount,
    numPassedTests: assertionCount - failed - todo - pending,
    numFailedTests: failed,
    numPendingTests: pending,
    numTodoTests: todo,
    testResults: [
      {
        name: path.join(REPO_ROOT, "packages/cli/test/example.test.ts"),
        assertionResults: [{ fullName: "ordinary passing test", status: "passed", title: "ordinary passing test" }],
      },
      ...identities.map((identity) => ({
        name: path.join(REPO_ROOT, identity.path),
        assertionResults: [assertion(identity)],
      })),
    ],
    ...overrides,
  };
}

describe("full-overlap pending identity contract", () => {
  it("accepts exactly the known Darwin-only pending identity off Darwin", () => {
    expect(validatePendingTests("source", result([DARWIN_PENDING_TEST]), {
      platform: "linux",
      repoRoot: REPO_ROOT,
    })).toEqual([DARWIN_PENDING_TEST]);
    expect(expectedPendingTests("source", "win32")).toEqual([DARWIN_PENDING_TEST]);
  });

  it("requires every source test to execute on Darwin", () => {
    expect(validatePendingTests("source", result(), {
      platform: "darwin",
      repoRoot: REPO_ROOT,
    })).toEqual([]);
    expect(() => validatePendingTests("source", result([DARWIN_PENDING_TEST]), {
      platform: "darwin",
      repoRoot: REPO_ROOT,
    })).toThrow(/expected \[\], observed/);
  });

  it.each([
    ["zero or missing", []],
    ["extra .skip or false runIf", [DARWIN_PENDING_TEST, { path: "packages/cli/test/extra.test.ts", name: "extra skipped test", status: "skipped" }]],
    ["wrong path", [{ ...DARWIN_PENDING_TEST, path: "packages/cli/test/wrong.test.ts" }]],
    ["wrong name", [{ ...DARWIN_PENDING_TEST, name: "changed Darwin test" }]],
    ["todo", [{ ...DARWIN_PENDING_TEST, status: "todo" }]],
  ])("rejects %s pending evidence with expected and observed identities", (_, identities) => {
    expect(() => validatePendingTests("source", result(identities), {
      platform: "linux",
      repoRoot: REPO_ROOT,
    })).toThrow(/expected .*generatedOutputPublication\.test\.ts.* observed/);
  });

  it("rejects failures even when the pending identity remains exact", () => {
    const failed = { path: "packages/cli/test/failure.test.ts", name: "failed overlap test", status: "failed" };
    expect(() => validatePendingTests("source", result([DARWIN_PENDING_TEST, failed]), {
      platform: "linux",
      repoRoot: REPO_ROOT,
    })).toThrow(/"failed":1/);
  });

  it("permits no package pending tests on any platform", () => {
    expect(validatePendingTests("package", result(), {
      platform: "linux",
      repoRoot: REPO_ROOT,
    })).toEqual([]);
    expect(() => validatePendingTests("package", result([DARWIN_PENDING_TEST]), {
      platform: "linux",
      repoRoot: REPO_ROOT,
    })).toThrow(/package.*expected \[\]/);
  });

  it("keeps the structured identity synchronized with the real conditional test", () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, DARWIN_PENDING_TEST.path), "utf8");
    expect(source).toContain(`describe("${DARWIN_PENDING_TEST_SUITE}"`);
    expect(source).toContain(`it.runIf(process.platform === "darwin")("${DARWIN_PENDING_TEST_TITLE}"`);
  });
});
