import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch.js";
import { GAP_IDS, isGapClosed } from "../upgrade/gapRegistry.js";
import {
  classifyDrift,
  expectedShapeLiteralPins,
  expectedShapeRequiredKeys,
  normalizeEnvelope,
} from "./parityOracle.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REMAINING_FAMILIES = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures/oracle/parity-remaining-families.json"), "utf8"),
) as {
  families: Record<
    string,
    {
      argv: string[];
      exitCode: number;
      expectedShape: Record<string, unknown>;
      forbiddenSubstrings: string[];
    }
  >;
};

const VERIFY_EVAL_SPEC = REMAINING_FAMILIES.families.verify_eval;

function capture(argv: string[]): { rc: number; out: string; err: string } {
  let out = "";
  let err = "";
  const rc = main(["node", "agentera", ...argv], {
    out: (t) => (out += t),
    err: (t) => (err += t),
  });
  return { rc, out, err };
}

describe("verify_eval parity (D56 T5)", () => {
  it("gap registry marks verify_eval family closed", () => {
    expect(isGapClosed(GAP_IDS.VERIFY_EVAL_FAMILY)).toBe(true);
  });

  it("eval skills dry-run envelope matches the verify_eval oracle pin (pass)", () => {
    const { rc, out } = capture(VERIFY_EVAL_SPEC.argv);
    expect(rc).toBe(VERIFY_EVAL_SPEC.exitCode);
    const payload = JSON.parse(out) as Record<string, unknown>;
    const normalized = normalizeEnvelope(payload) as Record<string, unknown>;
    const classification = classifyDrift(
      normalized,
      expectedShapeRequiredKeys(VERIFY_EVAL_SPEC.expectedShape),
      expectedShapeLiteralPins(VERIFY_EVAL_SPEC.expectedShape),
      VERIFY_EVAL_SPEC.forbiddenSubstrings,
    );
    expect(classification.direction).toBe("equal");
    expect(payload.safety).toMatchObject({ mode: "dry-run", live: false });
  });

  it("eval success JSON must not emit smoke-retired sentinel (fail guard)", () => {
    const { out } = capture(VERIFY_EVAL_SPEC.argv);
    const serialized = JSON.stringify(JSON.parse(out));
    for (const forbidden of VERIFY_EVAL_SPEC.forbiddenSubstrings) {
      expect(serialized, `forbidden sentinel '${forbidden}'`).not.toContain(forbidden);
    }
  });

  it("smoke family returns npm-retired guidance (pass)", () => {
    const { rc, err } = capture(["check", "verify", "smoke", "installed-skills", "--format", "json"]);
    expect(rc).toBe(2);
    expect(err).toContain("verify smoke is retired on the npm self-contained CLI");
    expect(err).toContain("agentera check verify eval skills");
  });

  it("smoke family must not invoke eval engine stdout (fail guard)", () => {
    const { out, err } = capture(["check", "verify", "smoke", "installed-skills", "--format", "json"]);
    expect(out.trim()).toBe("");
    expect(err).not.toContain('"command": "verify"');
  });
});
