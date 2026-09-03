import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildVerifyPayload, cmdVerify, validateVerifyRequest, VerifyArgs } from "../../src/cli/commands/verify.js";
import { requiresCompletedEntityCutover } from "../../src/cli/migrationRequired.js";
import { main } from "../../src/cli/dispatch.js";
import { setGlossaryEvaluationRunnerForTest } from "../../src/eval/glossaryEvaluationProcess.js";
import { sourceGlossaryEvaluationRunnerPath } from "../helpers/sourceSubprocess.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
setGlossaryEvaluationRunnerForTest(sourceGlossaryEvaluationRunnerPath());
const SEMANTIC_FIXTURE = path.join(repoRoot, "fixtures", "semantic", "status-bare-message.md");
const GLOSSARY_METRICS_SHA256 = "de930e006d6cfc7392a1b54ec014e843d59793e790709f9136364b8bda5512cc";

function run(args: VerifyArgs): { rc: number; out: string; err: string } {
  let out = "";
  let err = "";
  const rc = cmdVerify(args, { out: (t) => (out += t), err: (t) => (err += t) });
  return { rc, out, err };
}

describe("verify request validation", () => {
  it("rejects an unknown family", () => {
    expect(() => validateVerifyRequest({ family: "bogus", target: "x" })).toThrow(/unsupported verify family 'bogus'/);
  });
  it("retires smoke with npm maintainer guidance", () => {
    expect(() => validateVerifyRequest({ family: "smoke", target: "installed-skills" })).toThrow(/verify smoke is retired on the npm self-contained CLI/);
  });
  it("rejects an unknown target for a family", () => {
    expect(() => validateVerifyRequest({ family: "eval", target: "bogus" })).toThrow(/unsupported verify target 'bogus' for family 'eval'/);
  });
  it("rejects semantic without fixtures", () => {
    expect(() => validateVerifyRequest({ family: "eval", target: "semantic", fixtures: [] })).toThrow(/semantic verify requires explicit fixture/);
  });
  it("rejects eval skills combining --run and --dry-run", () => {
    expect(() => validateVerifyRequest({ family: "eval", target: "skills", run: true, dryRun: true })).toThrow(/combines --run and --dry-run/);
  });
  it("rejects an unknown eval skills runtime", () => {
    expect(() => validateVerifyRequest({ family: "eval", target: "skills", runtime: "bogus" })).toThrow(/unsupported eval skills runtime 'bogus'/);
  });
});

describe("verify dispatch output", () => {
  it("defaults to JSON and rejects text selectors with JSON", () => {
    let out = "";
    let err = "";
    expect(
      main(["node", "agentera", "check", "verify", "eval", "skills", "--dry-run"], {
        out: (text) => (out += text),
        err: (text) => (err += text),
      }),
    ).toBe(0);
    expect(JSON.parse(out).status).toBe("pass");
    out = "";
    expect(
      main(["node", "agentera", "check", "verify", "eval", "skills", "--dry-run", "--format", "text"], {
        out: (text) => (out += text),
        err: (text) => (err += text),
      }),
    ).toBe(2);
    expect(JSON.parse(out).error.valid_values).toEqual(["json"]);
    expect(err).toBe("");
  });
});

describe("cmdVerify", () => {
  it("retires smoke verify on npm CLI", () => {
    const { rc, out, err } = run({ family: "smoke", target: "installed-skills", format: "json" });
    expect(rc).toBe(2);
    expect(JSON.parse(out).error.message).toContain("verify smoke is retired on the npm self-contained CLI");
    expect(err).toBe("");
  });

  it("emits an Error and rc 2 for an invalid request", () => {
    const { rc, out, err } = run({ family: "eval", target: "bogus", format: "json" });
    expect(rc).toBe(2);
    expect(JSON.parse(out).error.message).toContain("unsupported verify target 'bogus' for family 'eval'");
    expect(err).toBe("");
  });

  it("runs the semantic eval engine in-process and passes a valid fixture", () => {
    const { rc, out } = run({
      family: "eval",
      target: "semantic",
      fixtures: [SEMANTIC_FIXTURE],
      format: "json",
    });
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.status).toBe("pass");
    expect(payload.family).toBe("eval");
    expect(payload.target).toBe("semantic");
    expect(payload.engine.exit_code).toBe(0);
    expect(payload).not.toHaveProperty("glossary_evaluation");
    // diagnostics capture the engine's JSON report (ensure_ascii escaped)
    expect(payload.diagnostics.stdout.join("\n")).toContain('"status": "pass"');
  });

  it("runs eval skills --dry-run in-process", () => {
    const { rc, out } = run({ family: "eval", target: "skills", dryRun: true, format: "json" });
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.status).toBe("pass");
    expect(payload.safety.mode).toBe("dry-run");
  });

  it("runs the frozen personal glossary product evaluation gate in-process", () => {
    expect(requiresCompletedEntityCutover(["check", "verify", "eval", "glossary"])).toBe(false);
    const { rc, out } = run({
      family: "eval",
      target: "glossary",
      format: "json",
    });
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.status).toBe("pass");
    expect(payload.target).toBe("glossary");
    expect(payload.safety.mode).toBe("offline-frozen-holdout");
    expect(payload.safety.summary).toContain("current glossary discovery");
    expect(payload.glossary_evaluation).toMatchObject({
      metrics_sha256: GLOSSARY_METRICS_SHA256,
      metrics: [
        {
          metric: "discovery_recall",
          numerator: 20,
          denominator: 20,
          point_estimate: 1,
          status: "pass",
        },
        {
          metric: "scope_accuracy",
          numerator: 20,
          denominator: 20,
          point_estimate: 1,
          status: "pass",
        },
        {
          metric: "inferred_review_precision",
          numerator: 19,
          denominator: 20,
          point_estimate: 0.95,
          status: "pass",
        },
        {
          metric: "explicit_admission_precision",
          numerator: 99,
          denominator: 100,
          point_estimate: 0.99,
          status: "pass",
        },
      ],
    });
    expect(payload.glossary_evaluation.metrics).toHaveLength(4);
    expect(payload.diagnostics.stdout.join("\n")).toContain('"status": "pass"');
  });

  it("does not allow a caller-supplied fixture to replace the frozen holdout", () => {
    expect(() => validateVerifyRequest({ family: "eval", target: "glossary", fixtures: ["other.yaml"] })).toThrow(/uses the contract-owned frozen holdout/);
  });
});

describe("buildVerifyPayload", () => {
  it("bounds diagnostics output to the line limit", () => {
    const manyLines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const payload = buildVerifyPayload("eval", "semantic", "json", { command: ["x"], returncode: 0, stdout: manyLines, stderr: "" }, { mode: "offline-fixtures", summary: "s", live: false, long_running_default: false });
    expect(payload.diagnostics.stdout.length).toBe(21); // 20 + truncation marker
    expect(payload.diagnostics.stdout[20]).toContain("truncated 30 line(s)");
  });

  it("fails closed when a successful glossary engine report is invalid", () => {
    const payload = buildVerifyPayload(
      "eval",
      "glossary",
      "json",
      {
        command: ["x"],
        returncode: 0,
        stdout: JSON.stringify({
          schemaVersion: "agentera.personalGlossaryEvaluation.v1",
          status: "pass",
        }),
        stderr: "",
      },
      { mode: "offline-frozen-holdout", summary: "s", live: false, long_running_default: false },
    );
    expect(payload.status).toBe("fail");
    expect(payload.engine.exit_code).toBe(1);
    expect(payload).not.toHaveProperty("glossary_evaluation");
    expect(payload.diagnostics.stderr).toEqual(["invalid glossary evaluation success report"]);
  });
});
