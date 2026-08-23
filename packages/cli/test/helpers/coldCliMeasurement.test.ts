import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import {
  collectGarbageThenReadBaseline,
  coldCliFailureEvidence,
  EFFECTIVE_NODE_OPTIONS_UTF8_LIMIT as MEASUREMENT_NODE_OPTIONS_LIMIT,
  measureColdCli,
  measureColdCliWithRetainedAllocation,
} from "./coldCliMeasurement.js";
import { createEntityAuthorityFixture } from "./entityAuthorityFixture.js";
import {
  effectiveChildFlagsAreComplete,
  EFFECTIVE_NODE_OPTIONS_UTF8_LIMIT as EVIDENCE_NODE_OPTIONS_LIMIT,
  performanceRunnerAuthority,
} from "../../scripts/performance-evidence.mjs";

const temporaryDirectories: string[] = [];
const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const AUTHORITY_PATH = path.join(REPO_ROOT, "references/artifacts/state-storage-authority.yaml");
const VERIFICATION_POLICY_PATH = path.join(REPO_ROOT, "references/analysis/verification-policy.yaml");

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("cold CLI heap measurement", () => {
  it("reports bounded process-boundary evidence without environment values", () => {
    const evidence = coldCliFailureEvidence({
      operation: "prime --dashboard",
      stdout: "x".repeat(5_000),
      stderr: "debugger output",
      childArgs: ["--inspect-brk=127.0.0.1:0", "--eval", "<inline-runner>"],
      env: { NODE_OPTIONS: "secret option", NODE_INSPECT_RESUME_ON_START: "secret control" },
      exitCode: 1,
    });
    expect(Buffer.byteLength(evidence, "utf8")).toBeLessThan(5_000);
    expect(JSON.parse(evidence)).toMatchObject({
      operation: "prime --dashboard",
      exitCode: 1,
      stderr: "debugger output",
      childArgs: ["--inspect-brk=127.0.0.1:0", "--eval", "<inline-runner>"],
      presentDebugEnvNames: ["NODE_INSPECT_RESUME_ON_START", "NODE_OPTIONS"],
    });
    expect(evidence).toContain("<truncated>");
    expect(evidence).not.toContain("secret option");
    expect(evidence).not.toContain("secret control");
  });

  it("distinguishes local diagnostic evidence from the pinned remote runner identity", () => {
    const definition = YAML.parse(fs.readFileSync(VERIFICATION_POLICY_PATH, "utf8")).owners.performance;
    const runtime = { platform: "linux", architecture: "x64" };
    expect(performanceRunnerAuthority({ AGENTERA_VERIFICATION_WORKERS: "1" }, definition, runtime)).toEqual({
      authoritative: false,
      provider: "unmanaged",
      class: null,
      identity: null,
      actions: false,
      workers: 1,
    });

    const contract = definition.execution.authoritative_runner;
    const environment = {
      AGENTERA_VERIFICATION_WORKERS: "1",
      [contract.actions_environment]: "true",
      [contract.runner_class_environment]: contract.runner_class,
      [contract.runner_identity_environment]: "GitHub Actions 1",
    };
    expect(performanceRunnerAuthority(environment, definition, runtime)).toEqual({
      authoritative: true,
      provider: "github_actions",
      class: "github-hosted-ubuntu-24.04",
      identity: "GitHub Actions 1",
      actions: true,
      workers: 1,
    });
    expect(performanceRunnerAuthority({ ...environment, [contract.runner_class_environment]: "ubuntu-latest" }, definition, runtime))
      .toMatchObject({ authoritative: false, provider: "unmanaged" });
  });

  it("awaits inspector garbage collection before reading the baseline", async () => {
    const calls: string[] = [];
    const baseline = await collectGarbageThenReadBaseline(async (method) => {
      calls.push(method);
      return method === "Runtime.getHeapUsage" ? { usedSize: 1234 } : {};
    });

    expect(calls).toEqual(["HeapProfiler.collectGarbage", "Runtime.getHeapUsage"]);
    expect(baseline).toEqual({ usedSize: 1234 });
  });

  it("rejects NODE_OPTIONS that cannot be recorded completely", () => {
    expect(MEASUREMENT_NODE_OPTIONS_LIMIT).toBe(EVIDENCE_NODE_OPTIONS_LIMIT);
    const previousNodeOptions = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = "é".repeat(Math.floor(MEASUREMENT_NODE_OPTIONS_LIMIT / 2) + 1);
    try {
      expect(() =>
        measureColdCli({
          args: ["prime", "--dashboard", "--format", "json"],
          project: process.cwd(),
          home: process.cwd(),
          repoRoot: REPO_ROOT,
        }),
      ).toThrow(`evidence limit ${MEASUREMENT_NODE_OPTIONS_LIMIT}`);
    } finally {
      if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previousNodeOptions;
    }
  });

  it("rejects truncated or over-limit NODE_OPTIONS evidence", () => {
    const flags = {
      execArgv: ["--inspect-brk=127.0.0.1:0"],
      nodeOptionsUtf8Limit: EVIDENCE_NODE_OPTIONS_LIMIT,
      nodeOptions: {
        value: "--trace-gc",
        truncated: false,
        utf8Bytes: Buffer.byteLength("--trace-gc", "utf8"),
      },
    };
    expect(effectiveChildFlagsAreComplete(flags)).toBe(true);
    expect(
      effectiveChildFlagsAreComplete({
        ...flags,
        nodeOptions: { ...flags.nodeOptions, truncated: true },
      }),
    ).toBe(false);
    expect(
      effectiveChildFlagsAreComplete({
        ...flags,
        nodeOptions: { ...flags.nodeOptions, utf8Bytes: flags.nodeOptions.utf8Bytes - 1 },
      }),
    ).toBe(false);
    const overLimit = "x".repeat(EVIDENCE_NODE_OPTIONS_LIMIT + 1);
    expect(
      effectiveChildFlagsAreComplete({
        ...flags,
        nodeOptions: {
          value: overLimit,
          truncated: false,
          utf8Bytes: Buffer.byteLength(overLimit, "utf8"),
        },
      }),
    ).toBe(false);
  });

  it("still measures a retained allocation above the 64 MiB heap budget", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cold-heap-sensitivity-"));
    temporaryDirectories.push(root);
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    fs.mkdirSync(project);
    fs.mkdirSync(home);
    const authority = YAML.parse(fs.readFileSync(AUTHORITY_PATH, "utf8"));
    createEntityAuthorityFixture(project, 100, authority);
    const measured = await measureColdCliWithRetainedAllocation({
      args: ["prime", "--dashboard", "--format", "json"],
      project,
      home,
      repoRoot: REPO_ROOT,
      elements: 10_000_000,
    });

    expect(measured.baselineNormalization).toBe("HeapProfiler.collectGarbage");
    expect(measured.heapDeltaBytes).toBeGreaterThan(64 * 1024 * 1024);
    expect(measured.peakHeapBytes - measured.baselineHeapBytes).toBe(measured.heapDeltaBytes);
  }, 40_000);
});
