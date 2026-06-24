import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { cmdPrime } from "../../src/cli/commands/prime.js";
import { instructions as orchestrateInstructions } from "../../src/capabilities/orchestrate/instructions.js";
import {
  loadEvaluatorHandoffContract,
  validateEvaluationReportRow,
} from "../../src/registries/evaluatorHandoffContract.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

function capture(fn: (io: { out: (t: string) => void; err: (t: string) => void }) => number): {
  rc: number;
  out: string;
  err: string;
} {
  let out = "";
  let err = "";
  const rc = fn({ out: (t) => (out += t), err: (t) => (err += t) });
  return { rc, out, err };
}

describe("orkestrera evaluator handoff citation contract", () => {
  it("emits output_requirements on evaluator_handoff from prime --context orchestrate", () => {
    const { rc, out } = capture((io) => cmdPrime({ command: "prime", context: "orchestrate", format: "json" }, io));
    expect(rc).toBe(0);
    const handoff = JSON.parse(out).capability_context.context.orchestration_context.evaluator_handoff;
    expect(handoff.output_requirements).toBeTruthy();
    expect(handoff.output_requirements.citation_required_for).toEqual(["WARN", "FAIL"]);
    expect(handoff.output_requirements.warn_verify_command_required).toBe(true);
    expect(handoff.output_requirements.schema_authority).toContain("evaluator_handoff");
  });

  it("orkestrera Step 3 Surface 2 delegation template requires citation field", () => {
    expect(orchestrateInstructions).toContain("citation: `<file>:<line>` OR `not-applicable: <reason>`");
    expect(orchestrateInstructions).toContain("verify_command");
    expect(orchestrateInstructions).toContain("evaluator_handoff.output_requirements");
  });

  it("evaluator-handoff schema in capability-instruction-contract.yaml rejects WARN/FAIL without citation", () => {
    const contract = loadEvaluatorHandoffContract(
      path.join(REPO_ROOT, "references", "cli", "capability-instruction-contract.yaml"),
    );
    const errors = contract.citationRequiredFor.flatMap((status) =>
      validateEvaluationReportRow({ criterion: "x", status, evidence: "y" }, 0, contract),
    );
    expect(errors.every((e: string) => e.includes("missing citation"))).toBe(true);
  });
});
