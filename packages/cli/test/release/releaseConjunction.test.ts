import { describe, expect, it } from "vitest";

import {
  RELEASE_CONTRACT,
  runSourceConjunction,
  sourceQualificationGateIdentity,
} from "../../scripts/release-qualification.mjs";

describe("no-receipt release verification", () => {
  it("shares the exact eleven-gate DAG identity and reports no authority side effects", async () => {
    const gates = RELEASE_CONTRACT.qualification.source.gates;
    const result = await runSourceConjunction({
      gates,
      runDag: async () => ({
        gates: gates.map(({ name }: any) => ({
          name,
          phase: RELEASE_CONTRACT.qualification.source.dag.barrierB.includes(name)
            ? "barrier-b"
            : name === "performance"
              ? "performance-barrier"
              : name === "capacity"
                ? "capacity-barrier"
                : "batch-a",
          outcome: "passed",
          elapsedMs: 1,
          origin: name,
        })),
        execution: { generation: "fresh", elapsedMs: 10, reconciled: true },
      }),
    });
    expect(gates).toHaveLength(11);
    expect(result.gate_identity).toBe(sourceQualificationGateIdentity());
    expect(result.gates.map(({ name }: any) => name)).toEqual(gates.map(({ name }: any) => name));
    expect(result.side_effects).toEqual({ receipt: false, candidate: false, registry: false, activation: false, publication: false });
  });

  it("normalizes the first owner failure to an exact owner and runnable correction", async () => {
    const error = Object.assign(new Error("bounded failure"), { owner: "activation-conjunction" });
    const result = await runSourceConjunction({ runDag: async () => { throw error; } });
    expect(result).toMatchObject({
      status: "fail",
      first_failure: "activation-conjunction",
      owner: "packages/cli/src/validate/activationConjunction.ts#activationConjunctionMain",
      correction: expect.stringMatching(/^node /),
    });
  });

  it("keeps the bounded diagnostic tail without losing exact owner and correction", async () => {
    const error = Object.assign(new Error(`${"x".repeat(1500)}TAIL`), { owner: "activation-conjunction" });
    const result = await runSourceConjunction({ runDag: async () => { throw error; } });
    expect(result.violation).toHaveLength(1000);
    expect(result.violation).toMatch(/TAIL$/);
    expect(result).toMatchObject({
      owner: "packages/cli/src/validate/activationConjunction.ts#activationConjunctionMain",
      correction: "node packages/cli/dist/bin/agentera.js check validate activation-conjunction",
    });
  });
});
