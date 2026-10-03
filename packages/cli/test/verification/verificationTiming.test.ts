import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { retainQualificationDiagnostics, writeVerificationTimingProfile } from "../../scripts/verification-timing.mjs";
import SourceDiagnosticReporter, { writeSourceDiagnostic } from "../../scripts/source-diagnostics.mjs";

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
    assertionResults: [
      {
        fullName: "PRIVATE_ASSERTION",
        duration: 12.75,
        status: "passed",
        failureMessages: ["PRIVATE_FAILURE"],
      },
    ],
  };
  fs.writeFileSync(resultFile, JSON.stringify(report ?? { testResults: [suite], environment: "PRIVATE_ENVIRONMENT" }));
  return {
    repoRoot,
    file,
    resultFile,
    suite,
    options: { resultFile, owner: "source", wallMs: 300, files: [file], repoRoot },
  };
}

describe("diagnostic verification timing profiles", () => {
  it("relays only complete inventory-native records while workers run, without replay or a final report", () => {
    vi.useFakeTimers();
    const setup = fixture();
    const output = path.join(setup.repoRoot, "source.progress.log");
    const environment = {
      AGENTERA_SOURCE_DIAGNOSTICS: "1",
      AGENTERA_SOURCE_DIAGNOSTIC_ROOT: setup.repoRoot,
      AGENTERA_SOURCE_DIAGNOSTIC_FILES: JSON.stringify([setup.file]),
      AGENTERA_SOURCE_DIAGNOSTIC_OUTPUT: output,
    };
    const lines: string[] = [];
    const original = fs.writeSync;
    vi.spyOn(fs, "writeSync").mockImplementation(((fd: number, ...args: unknown[]) => {
      if (fd === 2) {
        lines.push(String(args[0]));
        return String(args[0]).length;
      }
      return Reflect.apply(original, fs, [fd, ...args]);
    }) as typeof fs.writeSync);
    const reporter = new SourceDiagnosticReporter({ environment });
    const native = `AGENTERA_SOURCE_DIAGNOSTIC file=${setup.file} phase=native-child-start index=1 elapsedMs=0 durationMs=0 status=observed\n`;
    try {
      reporter.onInit();
      vi.advanceTimersByTime(500);
      fs.writeFileSync(output, "PRIVATE_CHILD_CONTENT\n" + native.slice(0, 60));
      vi.advanceTimersByTime(500);
      expect(lines).toEqual([]);
      fs.appendFileSync(output, native.slice(60));
      fs.appendFileSync(output, native.replace(setup.file, "packages/cli/test/unselected.test.ts"));
      fs.appendFileSync(output, native.replace("phase=native-child-start", "phase=native-start"));
      fs.appendFileSync(output, "x".repeat(70_000));
      vi.advanceTimersByTime(500);
      expect(lines).toEqual([native]);
      fs.appendFileSync(output, native + native);
      vi.advanceTimersByTime(500);
      expect(lines).toEqual([native, native]);
      vi.advanceTimersByTime(1000);
      expect(lines).toEqual([native, native]);
      expect(lines.join("")).not.toContain("PRIVATE");
      expect(lines.join("")).not.toContain("status=passed");
    } finally {
      reporter.onTestRunEnd();
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
    }
  });

  it("reports inventory-only preparation/execution and numeric cases without private names", () => {
    const setup = fixture();
    const output = path.join(setup.repoRoot, "source.progress.log");
    const environment = {
      AGENTERA_SOURCE_DIAGNOSTICS: "1",
      AGENTERA_SOURCE_DIAGNOSTIC_ROOT: setup.repoRoot,
      AGENTERA_SOURCE_DIAGNOSTIC_FILES: JSON.stringify([setup.file]),
      AGENTERA_SOURCE_DIAGNOSTIC_OUTPUT: output,
    };
    const writeSync = fs.writeSync;
    vi.spyOn(fs, "writeSync").mockImplementation(((fd: number, ...args: unknown[]) => (fd === 2 ? 1 : Reflect.apply(writeSync, fs, [fd, ...args]))) as typeof fs.writeSync);
    let now = 0;
    const reporter = new SourceDiagnosticReporter({ environment, now: () => now });
    const module = { moduleId: path.join(setup.repoRoot, setup.file), name: "PRIVATE_TITLE" };
    const test = {
      module,
      id: "PRIVATE_ID",
      name: "PRIVATE_TEST",
      result: () => ({ state: "failed", errors: ["PRIVATE_FAILURE"] }),
      diagnostic: () => ({ duration: 250 }),
    };
    reporter.onTestModuleQueued(module);
    now = 100;
    reporter.onTestModuleCollected(module);
    reporter.onTestModuleStart(module);
    reporter.onTestCaseReady(test);
    // Callback arrival has not advanced, but the worker measured 250 ms.
    reporter.onTestCaseResult(test);
    reporter.onTestModuleEnd(module);
    reporter.onTestModuleQueued({ moduleId: "/private/unselected.test.ts" });
    const text = fs.readFileSync(output, "utf8");
    expect(text).toContain("phase=collected index=0 elapsedMs=100 durationMs=100");
    expect(text).toContain("phase=case-end index=1 elapsedMs=100 durationMs=250 status=failed");
    expect(text).not.toContain("PRIVATE");
    expect(text).not.toContain(setup.repoRoot);
    expect(text.trim().split("\n")).toHaveLength(6);
  });

  it("ignores disabled, malformed and unwritable incremental diagnostics", () => {
    const setup = fixture();
    const write = vi.spyOn(fs, "writeSync").mockImplementation(() => {
      throw new Error("PRIVATE_SINK_FAILURE");
    });
    const append = vi.spyOn(fs, "appendFileSync").mockImplementation(() => {
      throw new Error("PRIVATE_SINK_FAILURE");
    });
    const record = { file: setup.file, phase: "queued" };
    writeSourceDiagnostic(record, { environment: {} });
    writeSourceDiagnostic({ ...record, file: "/private/path" }, { environment: { AGENTERA_SOURCE_DIAGNOSTICS: "1" } });
    expect(write).not.toHaveBeenCalled();
    expect(() =>
      writeSourceDiagnostic(record, {
        environment: {
          AGENTERA_SOURCE_DIAGNOSTICS: "1",
          AGENTERA_SOURCE_DIAGNOSTIC_OUTPUT: setup.resultFile,
        },
      }),
    ).not.toThrow();
    expect(append).toHaveBeenCalledTimes(1);
  });
  it("exports only settled owner logs and timing profiles before private-root cleanup", () => {
    const setup = fixture();
    const output = path.join(setup.repoRoot, "diagnostics");
    for (const name of ["source.log", "package.log", "source.json.profile.json", "package.json.timings.json", "receipt.json", "candidate.tgz"]) fs.writeFileSync(path.join(setup.repoRoot, name), name);
    fs.mkdirSync(path.join(setup.repoRoot, "private-build"));
    fs.writeFileSync(path.join(setup.repoRoot, "private-build", "private.log"), "private");
    fs.symlinkSync(setup.resultFile, path.join(setup.repoRoot, "symlink.log"));
    retainQualificationDiagnostics(setup.repoRoot, undefined);
    expect(fs.existsSync(output)).toBe(false);
    retainQualificationDiagnostics(setup.repoRoot, output);
    expect(fs.readdirSync(output).sort()).toEqual(["package.json.timings.json", "package.log", "source.json", "source.json.profile.json", "source.log"]);
    expect(fs.readFileSync(path.join(output, "source.log"), "utf8")).toBe("source.log");
    expect(fs.existsSync(path.join(setup.repoRoot, "private-build"))).toBe(true);
  });
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
      suites: [
        {
          file: setup.file,
          elapsedMs: 250,
          assertions: [{ index: 0, durationMs: 12.75, status: "passed" }],
        },
      ],
    });
    expect(text).not.toContain("PRIVATE");
    expect(text).not.toContain(setup.repoRoot);
    expect(fs.readFileSync(setup.resultFile, "utf8")).toBe(original);
  });

  it("excludes unknown suites and preserves assertion indices and unavailable timing", () => {
    const setup = fixture();
    const suite = {
      ...setup.suite,
      startTime: 1300,
      assertionResults: [{ status: "PRIVATE_STATUS", duration: 1 }, { status: "skipped" }, { status: "failed", duration: -1 }, { status: "todo", duration: "12" }],
    };
    fs.writeFileSync(
      setup.resultFile,
      JSON.stringify({
        testResults: [suite, { ...suite, name: "/private/unselected.test.ts" }, { ...suite, name: "packages/cli/test/unselected.test.ts" }],
      }),
    );
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
