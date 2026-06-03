import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  cmdValidate,
  cmdValidateCapability,
  cmdValidateCapabilityContract,
  isDelegatedValidateFamily,
} from "../../src/cli/commands/validate.js";
import { main } from "../../src/cli/dispatch.js";
import {
  classifyDrift,
  expectedShapeLiteralPins,
  expectedShapeRequiredKeys,
  normalizeEnvelope,
} from "./parityOracle.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const PARITY_ORACLE = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures/oracle/parity-remaining-families.json"), "utf8"),
) as {
  normalizeEnvelope: { rules: unknown };
  families: {
    artifact_validation: {
      argv: string[];
      exitCode: number;
      expectedShape: Record<string, unknown>;
      forbiddenSubstrings: string[];
    };
  };
};
const VALIDATE_FAMILY_ORACLE = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures/oracle/validate-family.json"), "utf8"),
) as {
  commandValue: "validate";
  statusUnion: ["pass", "fail"];
  families: Record<
    string,
    {
      exitCode: number;
      requiredTopLevelKeys: string[];
      targetFamilyValue: string;
      engine?: { commandValue?: string };
    }
  >;
};

const D56_SUBCOMMANDS = [
  "capability",
  "capability-contract",
  "cross-capability",
  "lifecycle-adapters",
  "app-home-contract",
  "vocabularyAuthority",
  "selfAudit",
] as const;

const DELEGATED_ENGINE_COMMANDS: Record<string, string> = {
  "cross-capability": "validate_cross_capability.py",
  "lifecycle-adapters": "validate_lifecycle_adapters.py",
  "app-home-contract": "validate_app_home_contract.py",
  vocabularyAuthority: "validate_vocabulary_authority.py",
  selfAudit: "self_audit.py",
};

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

function runDispatch(argv: string[]): { rc: number; payload: Record<string, unknown> } {
  const { rc, out } = capture((io) => main(["node", "agentera", ...argv], io));
  return { rc, payload: JSON.parse(out) as Record<string, unknown> };
}

function passEnvelope(subcommand: (typeof D56_SUBCOMMANDS)[number]): {
  rc: number;
  payload: Record<string, unknown>;
} {
  if (subcommand === "capability") {
    const { rc, out } = capture((io) => cmdValidateCapability("realisera", { format: "json" }, io));
    return { rc, payload: JSON.parse(out) };
  }
  if (subcommand === "capability-contract") {
    const { rc, out } = capture((io) => cmdValidateCapabilityContract({ format: "json" }, io));
    return { rc, payload: JSON.parse(out) };
  }
  const { rc, out } = capture((io) => cmdValidate(subcommand, { format: "json" }, io));
  return { rc, payload: JSON.parse(out) };
}

describe("validateParity (D56 artifact-validation surface)", () => {
  it("hosts all seven validate subcommands in delegated routing", () => {
    for (const family of [
      "cross-capability",
      "lifecycle-adapters",
      "app-home-contract",
      "vocabularyAuthority",
      "selfAudit",
    ]) {
      expect(isDelegatedValidateFamily(family)).toBe(true);
    }
    expect(D56_SUBCOMMANDS).toHaveLength(7);
  });

  it.each(D56_SUBCOMMANDS.map((name) => [name, name] as const))(
    "pass: check validate %s --format json matches the validate oracle envelope",
    (subcommand) => {
      const { rc, payload } = passEnvelope(subcommand);
      expect(rc).toBe(0);
      expect(payload.command).toBe("validate");
      expect(VALIDATE_FAMILY_ORACLE.statusUnion).toContain(payload.status);

      if (subcommand === "capability") {
        const spec = VALIDATE_FAMILY_ORACLE.families.capability;
        expect(payload.target_family).toBe(spec.targetFamilyValue);
        for (const key of spec.requiredTopLevelKeys) {
          expect(payload).toHaveProperty(key);
        }
        return;
      }

      if (subcommand === "capability-contract") {
        const spec = VALIDATE_FAMILY_ORACLE.families["capability-contract"];
        expect(payload.target_family).toBe(spec.targetFamilyValue);
        expect(Array.isArray(payload.checks)).toBe(true);
        expect((payload.checks as unknown[]).length).toBe(2);
        for (const key of spec.requiredTopLevelKeys) {
          expect(payload).toHaveProperty(key);
        }
        return;
      }

      const engineCommand = DELEGATED_ENGINE_COMMANDS[subcommand];
      expect(payload.target_family).toBe(subcommand);
      expect(payload.target).toBe(subcommand);
      expect(payload.violations).toEqual([]);
      const engine = payload.engine as Record<string, unknown>;
      expect(engine.command).toBe(engineCommand);
      expect(engine.exit_code).toBe(0);
      expect(Array.isArray(engine.stdout)).toBe(true);
      expect(Array.isArray(engine.stderr)).toBe(true);
    },
  );

  it.each(D56_SUBCOMMANDS.map((name) => [name, name] as const))(
    "fail: check validate %s rejects invalid input with the canonical envelope (rc 2)",
    (subcommand) => {
      if (subcommand === "capability") {
        const { rc, payload } = runDispatch(["check", "validate", "capability", "--format", "json"]);
        expect(rc).toBe(2);
        expect(payload.status).toBe("fail");
        expect((payload.error as Record<string, unknown>).class).toBe("missing_argument");
        return;
      }

      const { rc, payload } = runDispatch([
        "check",
        "validate",
        subcommand,
        "--format",
        "json",
        "--bogus",
      ]);
      expect(rc).toBe(2);
      expect(payload.status).toBe("fail");
      expect((payload.error as Record<string, unknown>).class).toBe("unrecognized_argument");
    },
  );

  it("artifact_validation family row is equal against the parity-remaining-families oracle", () => {
    const spec = PARITY_ORACLE.families.artifact_validation;
    const { rc, payload } = runDispatch(spec.argv);
    expect(rc).toBe(spec.exitCode);

    const normalized = normalizeEnvelope(
      payload,
      null,
      PARITY_ORACLE.normalizeEnvelope.rules as Parameters<typeof normalizeEnvelope>[2],
    ) as Record<string, unknown>;
    const classification = classifyDrift(
      normalized,
      expectedShapeRequiredKeys(spec.expectedShape),
      expectedShapeLiteralPins(spec.expectedShape),
      spec.forbiddenSubstrings,
    );
    expect(classification.direction).toBe("equal");
  });

  it("routes vocabularyAuthority and selfAudit through check validate dispatch", () => {
    for (const family of ["vocabularyAuthority", "selfAudit"] as const) {
      const { rc, payload } = runDispatch(["check", "validate", family, "--format", "json"]);
      expect(rc).toBe(0);
      expect(payload.target_family).toBe(family);
      expect(payload.status).toBe("pass");
    }
  });

  it("runs from repo checkout with canonical vocabulary authorities present", () => {
    expect(fs.existsSync(path.join(REPO_ROOT, "references/cli/app-lifecycle-vocabulary.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(REPO_ROOT, "references/cli/capability-instruction-contract.yaml"))).toBe(true);
  });
});
