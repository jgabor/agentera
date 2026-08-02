import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  formatPublicationReceipt,
  runQualificationBenchmark,
  runQualifiedPublication,
} from "../../scripts/release-benchmark.mjs";
import { canonicalJson, sha256 } from "../../scripts/release-qualification.mjs";

function phases(timings: Record<string, number>) {
  return {
    runPreflight: () => ({ elapsedMs: timings.preflight, owners: [{ name: "preflight", elapsedMs: timings.preflight }]}),
    runSource: () => ({
      elapsedMs: timings.source,
      owners: [
        { name: "source", elapsedMs: Math.floor(timings.source / 2), executed: "ordered", reused: false },
        { name: "stress", elapsedMs: Math.ceil(timings.source / 2), executed: "ordered", reused: false },
      ],
    }),
    runCandidate: () => ({
      elapsedMs: timings.candidate,
      owners: [{ name: "local-exact-artifact-smoke", elapsedMs: timings.candidate, executed: "ordered", reused: false }],
    }),
  };
}

describe("release qualification benchmark coordinator", () => {
  it("records three cold repetitions, owner execution, reconciled totals, and medians", async () => {
    let repetition = 0;
    const report = await runQualificationBenchmark({
      runPreflight: () => ({ elapsedMs: [8, 5, 11][repetition], owners: [{ name: "preflight", elapsedMs: [8, 5, 11][repetition] }]}),
      runSource: () => ({ elapsedMs: [100, 120, 110][repetition], owners: [{ name: "source", elapsedMs: [100, 120, 110][repetition] }]}),
      runCandidate: () => ({
        elapsedMs: [40, 30, 50][repetition++],
        owners: [{ name: "local-exact-artifact-smoke", elapsedMs: [40, 30, 50][repetition - 1] }],
      }),
    });

    expect(report.repetitions).toHaveLength(3);
    expect(report.repetitions.every((run) => run.coldCache)).toBe(true);
    expect(report.repetitions.every((run) => run.preflight.reconciled && run.source.reconciled && run.candidate.reconciled)).toBe(true);
    expect(report.medianElapsedMs).toEqual({ preflight: 8, fullQualification: 150 });
  });

  it("emits a solo performance failure immediately and does not run candidate work", async () => {
    const events: unknown[] = [];
    let candidates = 0;
    await expect(runQualificationBenchmark({
      ...phases({ preflight: 1, source: 1, candidate: 1 }),
      runSource: () => {
        const error = new Error("performance fixture exceeded its remaining deadline");
        (error as Error & { owner?: string }).owner = "performance";
        throw error;
      },
      runCandidate: () => {
        candidates += 1;
        return { elapsedMs: 1 };
      },
      emit: (event: unknown) => events.push(event),
    })).rejects.toMatchObject({
      firstFailure: {
        owner: "performance",
        phase: "source-qualification",
        detail: "performance fixture exceeded its remaining deadline",
      },
    });
    expect(candidates).toBe(0);
    expect(events.at(-1)).toEqual({
      event: "failed",
      repetition: 1,
      firstFailure: {
        owner: "performance",
        phase: "source-qualification",
        detail: "performance fixture exceeded its remaining deadline",
      },
    });
  });

  it("reconciles parallel batch A plus the ordered solo performance barrier", async () => {
    const report = await runQualificationBenchmark({
      runPreflight: () => ({ elapsedMs: 1, owners: [{ name: "preflight", elapsedMs: 1 }] }),
      runSource: () => ({
        elapsedMs: 60,
        ownerElapsedMs: 60,
        owners: [
          { name: "generated-overlap", phase: "batch-a", elapsedMs: 40 },
          { name: "stress", phase: "batch-a", elapsedMs: 40 },
          { name: "typecheck", phase: "batch-a", elapsedMs: 40 },
          { name: "performance", phase: "performance-barrier", elapsedMs: 20 },
        ],
      }),
      runCandidate: () => ({ elapsedMs: 10, owners: [{ name: "candidate", elapsedMs: 10 }] }),
    });

    expect(report.repetitions[0].source).toMatchObject({
      elapsedMs: 60,
      ownerDurationTotalMs: 140,
      ownerElapsedMs: 60,
      unattributedElapsedMs: 0,
      reconciled: true,
    });
    expect(report.repetitions[0].source.owners.find(({ name }) => name === "performance"))
      .toMatchObject({ phase: "performance-barrier", elapsedMs: 20 });
  });

  it("fails closed on a full qualification budget overrun", async () => {
    await expect(runQualificationBenchmark(phases({ preflight: 1, source: 299_999, candidate: 1 }))).rejects.toThrow(
      "full-qualification",
    );
  });
});

const candidate = {
  receiptSha256: "a".repeat(64),
  metadataCommit: "b".repeat(40),
  package: "agentera",
  version: "3.0.0-dev.41",
  artifact: {
    integrity: "sha512-candidate",
    sha256: "c".repeat(64),
  },
};

function transactionOutput(phase: string, reused: boolean) {
  return {
    stdout: `${JSON.stringify({
      phase,
      outcome: "passed",
      elapsedMs: 1,
      executed: "candidate transaction",
      reused,
    })}\n`,
    stderr: "",
  };
}

describe("qualified publication timing coordinator", () => {
  it("measures the actual stage, independent L2, and promote commands under 120 seconds", async () => {
    let now = 0;
    const durations = new Map([["stage", 11], ["exact-version-l2", 23], ["promote", 17]]);
    const calls: string[] = [];
    const tokenVisibility: boolean[] = [];
    let l2ConfigRoot = "";
    const receipt = await runQualifiedPublication({
      adapterName: "development",
      candidateDirectory: "/retained/candidate",
      candidate,
      environment: {
        PATH: process.env.PATH,
        NPM_TOKEN: "secret",
        NODE_AUTH_TOKEN: "secret",
        NPM_CONFIG_USERCONFIG: "/host/user.npmrc",
        NPM_CONFIG_GLOBALCONFIG: "/host/global.npmrc",
        npm_config_registry: "https://host.invalid/",
      },
      clock: () => now,
      runCommand: (command: { name: string; env: NodeJS.ProcessEnv }) => {
        calls.push(command.name);
        tokenVisibility.push(Boolean(command.env.NPM_TOKEN));
        if (command.name === "exact-version-l2") {
          const userConfig = command.env.NPM_CONFIG_USERCONFIG!;
          const globalConfig = command.env.NPM_CONFIG_GLOBALCONFIG!;
          l2ConfigRoot = path.dirname(userConfig);
          expect(path.dirname(globalConfig)).toBe(l2ConfigRoot);
          expect(command.env.HOME).toBe(path.join(l2ConfigRoot, "home"));
          expect(command.env.NPM_CONFIG_CACHE).toBe(path.join(l2ConfigRoot, "cache"));
          expect(command.env.NPM_TOKEN).toBeUndefined();
          expect(command.env.NODE_AUTH_TOKEN).toBeUndefined();
          expect(command.env.npm_config_registry).toBeUndefined();
          expect(fs.readFileSync(userConfig, "utf8")).toBe("registry=https://registry.npmjs.org/\n");
          expect(fs.readFileSync(globalConfig, "utf8")).toBe("registry=https://registry.npmjs.org/\n");
          expect(fs.statSync(userConfig).mode & 0o777).toBe(0o600);
          expect(fs.statSync(globalConfig).mode & 0o777).toBe(0o600);
        }
        now += durations.get(command.name)!;
        return command.name === "exact-version-l2"
          ? { stdout: "L2 passed", stderr: "" }
          : transactionOutput(command.name, false);
      },
    });

    expect(calls).toEqual(["stage", "exact-version-l2", "promote"]);
    expect(tokenVisibility).toEqual([true, false, true]);
    expect(l2ConfigRoot).toContain("agentera-qualified-l2-");
    expect(fs.existsSync(l2ConfigRoot)).toBe(false);
    expect(receipt).toMatchObject({
      outcome: "passed",
      elapsedMs: 51,
      budgetMs: 120_000,
      withinBudget: true,
      ownerElapsedMs: 51,
      unattributedElapsedMs: 0,
      reconciled: true,
      reused: false,
    });
    expect(receipt.phases.map((phase: { elapsedMs: number }) => phase.elapsedMs)).toEqual([11, 23, 17]);
    expect(receipt.receiptSha256).toMatch(/^[0-9a-f]{64}$/);
    const { receiptSha256, ...content } = receipt;
    expect(receiptSha256).toBe(sha256(canonicalJson(content)));
    expect(formatPublicationReceipt(receipt)).toContain("total 51ms < 120000ms; reconciled true");
    expect(JSON.parse(JSON.stringify(receipt))).toMatchObject({ elapsedMs: 51, withinBudget: true });
  });

  it("fails at the measured timeout and never starts a later phase", async () => {
    let now = 0;
    const calls: string[] = [];
    await expect(runQualifiedPublication({
      adapterName: "development",
      candidateDirectory: "/retained/candidate",
      candidate,
      clock: () => now,
      runCommand: (command: { name: string }) => {
        calls.push(command.name);
        now += 120_000;
        return transactionOutput("stage", false);
      },
    })).rejects.toMatchObject({
      firstFailure: { owner: "stage", phase: "qualified-publication" },
      publicationReceipt: {
        outcome: "failed",
        elapsedMs: 120_000,
        withinBudget: false,
        reconciled: true,
      },
    });
    expect(calls).toEqual(["stage"]);
  });

  it("preserves the first child failure label and stops before promotion", async () => {
    let now = 0;
    const calls: string[] = [];
    await expect(runQualifiedPublication({
      adapterName: "development",
      candidateDirectory: "/private/candidate",
      candidate,
      clock: () => now,
      runCommand: (command: { name: string }) => {
        calls.push(command.name);
        now += 5;
        if (command.name === "exact-version-l2") {
          const error = new Error("consumer failed in /private/candidate");
          (error as Error & { owner?: string }).owner = "consumer-smoke";
          throw error;
        }
        return transactionOutput(command.name, false);
      },
    })).rejects.toMatchObject({
      firstFailure: {
        owner: "consumer-smoke",
        detail: "consumer failed in <private>",
      },
    });
    expect(calls).toEqual(["stage", "exact-version-l2"]);
  });

  it("reconciles measured components with unattributed coordinator time", async () => {
    let now = 0;
    let clockReads = 0;
    const receipt = await runQualifiedPublication({
      adapterName: "development",
      candidateDirectory: "/retained/candidate",
      candidate,
      clock: () => {
        clockReads += 1;
        if (clockReads === 8) now += 4;
        return now;
      },
      runCommand: (command: { name: string }) => {
        now += 5;
        return command.name === "exact-version-l2"
          ? { stdout: "L2 passed", stderr: "" }
          : transactionOutput(command.name, false);
      },
    });

    expect(receipt.ownerElapsedMs).toBe(15);
    expect(receipt.unattributedElapsedMs).toBe(4);
    expect(receipt.ownerElapsedMs + receipt.unattributedElapsedMs).toBe(receipt.elapsedMs);
    expect(receipt.reconciled).toBe(true);
  });

  it("replays without source qualification or registry mutation", async () => {
    let now = 0;
    const commands: Array<{ name: string; args: string[] }> = [];
    const receipt = await runQualifiedPublication({
      adapterName: "development",
      candidateDirectory: "/retained/candidate",
      candidate,
      clock: () => now,
      runCommand: (command: { name: string; args: string[] }) => {
        commands.push(command);
        now += 7;
        return command.name === "exact-version-l2"
          ? { stdout: "L2 replay verification passed", stderr: "" }
          : transactionOutput(command.name, true);
      },
    });

    expect(receipt.reused).toBe(true);
    expect(commands.map((command) => command.name)).toEqual(["stage", "exact-version-l2", "promote"]);
    expect(JSON.stringify(commands)).not.toContain("release-qualification.mjs");
    expect(JSON.stringify(commands)).not.toContain("source-qualification");
  });
});
