import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeVerificationTimingProfile } from "../../scripts/verification-timing.mjs";

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture(report?: unknown) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-verification-timing-"));
  directories.push(repoRoot);
  const file = "packages/cli/test/example.test.ts";
  const resultFile = path.join(repoRoot, "source.json");
  const suite = {
    name: path.join(repoRoot, file),
    startTime: 1000,
    endTime: 1250,
    assertionResults: [{ fullName: "PRIVATE_ASSERTION", duration: 12.75, status: "passed", failureMessages: ["PRIVATE_FAILURE"] }],
  };
  fs.writeFileSync(resultFile, JSON.stringify(report ?? { testResults: [suite], environment: "PRIVATE_ENVIRONMENT" }));
  return { repoRoot, file, resultFile, suite, options: { resultFile, owner: "source", wallMs: 300, files: [file], repoRoot } };
}

describe("diagnostic verification timing profiles", () => {
  it.each(["source", "package"])("retains %s durations without names, content or absolute paths", (owner) => {
    const setup = fixture();
    const original = fs.readFileSync(setup.resultFile, "utf8");
    expect(writeVerificationTimingProfile({ ...setup.options, owner })).toBe(true);
    const text = fs.readFileSync(`${setup.resultFile}.profile.json`, "utf8");
    expect(JSON.parse(text)).toEqual({
      schemaVersion: "agentera.verificationTimingProfile.v1",
      diagnosticOnly: true,
      owner,
      wallMs: 300,
      suites: [{ file: setup.file, elapsedMs: 250, assertions: [{ index: 0, durationMs: 12.75, status: "passed" }] }],
    });
    expect(text).not.toContain("PRIVATE");
    expect(text).not.toContain(setup.repoRoot);
    expect(fs.readFileSync(setup.resultFile, "utf8")).toBe(original);
  });

  it("excludes unknown suites and preserves assertion indices and unavailable timing", () => {
    const setup = fixture();
    const suite = { ...setup.suite, startTime: 1300, assertionResults: [{ status: "PRIVATE_STATUS", duration: 1 }, { status: "skipped" }, { status: "failed", duration: -1 }, { status: "todo", duration: "12" }] };
    fs.writeFileSync(setup.resultFile, JSON.stringify({ testResults: [suite, { ...suite, name: "/private/unselected.test.ts" }, { ...suite, name: "packages/cli/test/unselected.test.ts" }] }));
    expect(writeVerificationTimingProfile(setup.options)).toBe(true);
    expect(JSON.parse(fs.readFileSync(`${setup.resultFile}.profile.json`, "utf8")).suites).toEqual([
      {
        file: setup.file,
        elapsedMs: null,
        assertions: [
          { index: 1, durationMs: null, status: "skipped" },
          { index: 2, durationMs: null, status: "failed" },
          { index: 3, durationMs: null, status: "todo" },
        ],
      },
    ]);
  });

  it.each(["null", "[]", "{}", "invalid: [", '{"testResults":{}}', '{"testResults":[]}'.padEnd(2 * 1024 * 1024 + 1)])("ignores malformed or oversized reporter data (%#)", (raw) => {
    const setup = fixture();
    fs.writeFileSync(setup.resultFile, raw);
    expect(writeVerificationTimingProfile(setup.options)).toBe(false);
    expect(fs.existsSync(`${setup.resultFile}.profile.json`)).toBe(false);
    expect(fs.readFileSync(setup.resultFile, "utf8")).toBe(raw);
  });

  it.each([NaN, Infinity, -1, "300", null])("ignores an invalid owner wall time (%#)", (wallMs) => {
    const setup = fixture();
    expect(writeVerificationTimingProfile({ ...setup.options, wallMs })).toBe(false);
    expect(fs.existsSync(`${setup.resultFile}.profile.json`)).toBe(false);
  });

  it.each(["statSync", "readFileSync", "writeFileSync"] as const)("does not throw or change the original report when %s fails", (operation) => {
    const setup = fixture();
    const original = fs.readFileSync(setup.resultFile, "utf8");
    const spy = vi.spyOn(fs, operation).mockImplementation(() => {
      throw new Error("PRIVATE_DIAGNOSTIC_ERROR");
    });
    expect(writeVerificationTimingProfile(setup.options)).toBe(false);
    spy.mockRestore();
    expect(fs.readFileSync(setup.resultFile, "utf8")).toBe(original);
  });
});
