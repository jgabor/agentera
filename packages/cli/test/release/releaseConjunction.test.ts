import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { issueSourceReceipt, qualificationGates, RELEASE_CONTRACT, runNoReceiptVerificationCommand, runSourceConjunction, sourceQualificationGateIdentity } from "../../scripts/release-qualification.mjs";
import { performanceObservationFixture } from "../helpers/performanceEvidence.js";

describe("no-receipt release verification", () => {
  it("selects a distinct no-receipt development command without certifying omitted gates", async () => {
    const runDag = vi.fn(async ({ gates }: any) => ({
      gates: gates.map(({ name }: any) => ({
        name,
        phase: "fixture",
        outcome: "passed",
        elapsedMs: 1,
        origin: name,
        observation: performanceObservationFixture(),
      })),
      execution: { generation: "fixture" },
    }));
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const result = await runNoReceiptVerificationCommand(
        new Map([
          ["--profile", "development"],
          ["--json", true],
        ]),
        { runDag },
      );
      expect(runDag.mock.calls[0][0].profile).toBe("development");
      expect(result.status).toBe("pass");
      expect(result.schemaVersion).toBe("agentera.developmentConjunction.v1");
      expect(result.profile).toBe("development");
      expect(result.gate_identity).not.toBe(sourceQualificationGateIdentity());
      expect(result.gates.some(({ name }: any) => name === "certification")).toBe(false);
      expect(
        qualificationGates("development")
          .find(({ name }: any) => name === "performance")
          .command.at(-1),
      ).toBe("test:development-resource");
      expect(
        qualificationGates()
          .find(({ name }: any) => name === "performance")
          .command.at(-1),
      ).toBe("test:performance");
      expect(Object.values(result.side_effects).every((value) => value === false)).toBe(true);
      await expect(issueSourceReceipt({ profile: "development" })).rejects.toThrow(/require full/);
      await expect(runSourceConjunction({ profile: "fast", runDag })).rejects.toThrow(/unknown measurement profile/);
    } finally {
      write.mockRestore();
    }
  });
  it.each([true, false])("emits bounded advisory overruns from the actual command entry (json=%s)", async (json) => {
    const observation: any = performanceObservationFixture();
    observation.evidence.maxima.exact_get.maxElapsedMs = 1330.53;
    observation.evidence.latencyAdvisory.exact_get = {
      targetMs: 1000,
      maxObservedMs: 1330.53,
      exceededRepetitions: 1,
    };
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const result = await runNoReceiptVerificationCommand(new Map(json ? [["--json", true]] : []), {
        runDag: async () => ({
          gates: RELEASE_CONTRACT.qualification.source.gates.map(({ name }: any) => ({
            name,
            phase: "fixture",
            outcome: "passed",
            elapsedMs: 1,
            origin: name,
            ...(name === "performance" ? { observation } : {}),
          })),
          execution: { generation: "fixture" },
        }),
      });
      const output = write.mock.calls.map(([value]) => value).join("");
      expect(result.status).toBe("pass");
      expect(Object.keys(result.performance.latencyAdvisory)).toHaveLength(7);
      expect(output).not.toContain('"samples"');
      expect(output.length).toBeLessThan(10000);
      if (json) expect(JSON.parse(output).performance.latencyAdvisory.exact_get).toEqual(observation.evidence.latencyAdvisory.exact_get);
      else {
        expect(output).toContain("not latency target compliance");
        expect(output).toContain("latency advisory exact_get: targetMs=1000; maxObservedMs=1330.53; exceededRepetitions=1");
      }
    } finally {
      write.mockRestore();
    }
  });
  it("preserves a real uncolored Vitest over-budget failure through conjunction", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-measurement-diagnostic-"));
    try {
      fs.writeFileSync(path.join(root, "vite.config.mjs"), "export default { test: { globals: true, maxWorkers: 1 } };");
      fs.writeFileSync(
        path.join(root, "measurement.test.js"),
        `it('known over-budget fixture', () => { expect(1234, 'exact_get repetition 3: ' + JSON.stringify({elapsedMs:1234,runtime:{node:process.version,v8:process.versions.v8,effectiveChildFlags:{execArgv:[],nodeOptions:null,nodeOptionsUtf8Limit:512}}})).toBeLessThanOrEqual(1000); });`,
      );
      const rendered = spawnSync("vp", ["test", "run", "--root", root, "--config", path.join(root, "vite.config.mjs")], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", GITHUB_ACTIONS: "false" },
      });
      expect(rendered.error).toBeUndefined();
      expect(rendered.status).toBe(1);
      expect(rendered.stderr).toContain("AssertionError");
      const error = Object.assign(new Error(`${rendered.stderr}\n${"    at /private/fixture.ts:151:1\n".repeat(50)}cleanup failed`), { owner: "performance" });
      const result = await runSourceConjunction({
        runDag: async () => {
          throw error;
        },
      });
      expect(result.status).toBe("fail");
      expect(result.first_failure).toBe("performance");
      expect(result.violation.length).toBeLessThanOrEqual(1000);
      for (const value of ["exact_get", "repetition 3", "1234", "1000", process.version]) expect(result.violation).toContain(value);
      expect(result.violation).not.toContain("\u001b");
      expect(result.violation).not.toContain(root);
      expect(result.violation).not.toContain("/private/fixture.ts");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains assertion measurements before colored frames and cleanup cascades", async () => {
    const assertion = "AssertionError: exact_get repetition 3: elapsedMs=1234 runtime=v24.19.0: expected 1234 to be less than or equal to 1000";
    const error = Object.assign(new Error(`\u001b[31m${assertion}\u001b[39m\n${"\u001b[90m  151 | expect(measured.elapsedMs).toBeLessThanOrEqual(1000)\u001b[39m\n".repeat(40)}${"    at /private/fixture.ts:151:1\n".repeat(40)}cleanup failed\n`), { owner: "performance" });
    const result = await runSourceConjunction({
      runDag: async () => {
        throw error;
      },
    });
    expect(result.status).toBe("fail");
    expect(result.first_failure).toBe("performance");
    expect(result.violation.length).toBeLessThanOrEqual(1000);
    expect(result.violation).toContain(assertion);
    expect(result.violation).not.toContain("\u001b");
    expect(result.violation).not.toContain("/private/fixture.ts");
  });

  it("shares the exact twelve-gate DAG identity and reports no authority side effects", async () => {
    const gates = RELEASE_CONTRACT.qualification.source.gates;
    const result = await runSourceConjunction({
      gates,
      runDag: async () => ({
        gates: gates.map(({ name }: any) => ({
          name,
          phase: RELEASE_CONTRACT.qualification.source.dag.barrierB.includes(name) ? "barrier-b" : name === "performance" ? "performance-barrier" : name === "capacity" ? "capacity-barrier" : "batch-a",
          outcome: "passed",
          elapsedMs: 1,
          origin: name,
          ...(name === "performance" ? { observation: performanceObservationFixture() } : {}),
        })),
        execution: { generation: "fresh", elapsedMs: 10, reconciled: true },
      }),
    });
    expect(gates).toHaveLength(12);
    expect(result.gate_identity).toBe(sourceQualificationGateIdentity());
    expect(result.gates.map(({ name }: any) => name)).toEqual(gates.map(({ name }: any) => name));
    expect(result.side_effects).toEqual({
      receipt: false,
      candidate: false,
      registry: false,
      activation: false,
      publication: false,
    });
  });

  it.each(["full", "development"])("uses the %s correction for coordinator failures", async (profile) => {
    const result = await runSourceConjunction({
      profile,
      runDag: async () => {
        throw new Error("injected coordinator failure");
      },
    });
    expect(result).toMatchObject({
      status: "fail",
      profile,
      first_failure: "full-qualification",
      owner: "packages/cli/scripts/release-qualification.mjs#full-qualification",
      violation: "injected coordinator failure",
      correction: `pnpm -C packages/cli run verify:${profile === "development" ? "development" : "release"}`,
    });
  });

  it.each(["full", "development"])("normalizes the first owner failure to an exact owner and runnable correction (%s)", async (profile) => {
    const error = Object.assign(new Error("bounded failure"), {
      owner: "activation-conjunction",
    });
    const result = await runSourceConjunction({
      profile,
      runDag: async () => {
        throw error;
      },
    });
    expect(result).toMatchObject({
      status: "fail",
      first_failure: "activation-conjunction",
      owner: "packages/cli/src/validate/activationConjunction.ts#activationConjunctionMain",
      correction: "node packages/cli/dist/bin/agentera.js check validate activation-conjunction",
    });
  });

  it("keeps the bounded diagnostic tail without losing exact owner and correction", async () => {
    const error = Object.assign(new Error(`${"x".repeat(1500)}TAIL`), {
      owner: "activation-conjunction",
    });
    const result = await runSourceConjunction({
      runDag: async () => {
        throw error;
      },
    });
    expect(result.violation).toHaveLength(1000);
    expect(result.violation).toMatch(/TAIL$/);
    expect(result).toMatchObject({
      owner: "packages/cli/src/validate/activationConjunction.ts#activationConjunctionMain",
      correction: "node packages/cli/dist/bin/agentera.js check validate activation-conjunction",
    });
  });
});
