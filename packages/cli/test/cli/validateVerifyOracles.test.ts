import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { cmdValidateArtifact, cmdValidateCapability } from "../../src/cli/commands/validate.js";
import { main } from "../../src/cli/dispatch.js";
import { cleanupFixtureProject, useFixtureProject } from "../helpers/useFixtureProject.js";

interface AlternateShape {
  targetFamilyValue: string;
  requiredTopLevelKeys: string[];
}

interface ValidateFamilySpec {
  argv: string[];
  exitCode: number;
  requiredTopLevelKeys: string[];
  targetFamilyValue: string;
  engine?: {
    requiredKeys: string[];
    commandValue?: string;
  };
  altShape?: AlternateShape;
}

interface ValidateFamilyOracle {
  format: "json";
  commandValue: "validate";
  families: Record<string, ValidateFamilySpec>;
}

interface VerifyEvalOracle {
  commandValue: "verify";
  familyValue: "eval";
  requiredTopLevelKeys: string[];
  engine: { requiredKeys: string[] };
  diagnostics: { requiredKeys: string[]; lineLimitValue: number };
  safety: { requiredKeys: string[] };
  targets: Record<
    string,
    {
      argv?: string[];
      exitCode?: number;
      targetValue?: string;
      safetyMode: string;
      live: boolean;
    }
  >;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const ORACLE_ROOT = path.join(import.meta.dirname, "fixtures", "oracle");
const VALIDATE_FAMILY_ORACLE = JSON.parse(fs.readFileSync(path.join(ORACLE_ROOT, "validate-family.json"), "utf8")) as ValidateFamilyOracle;
const VERIFY_EVAL_FAMILY_ORACLE = JSON.parse(fs.readFileSync(path.join(ORACLE_ROOT, "verify-eval-family.json"), "utf8")) as VerifyEvalOracle;
const fixtureRoots: string[] = [];
afterEach(() => {
  while (fixtureRoots.length) cleanupFixtureProject(fixtureRoots.pop()!);
});

function capture(fn: (io: { out: (text: string) => void; err: (text: string) => void }) => number): {
  rc: number;
  payload: Record<string, unknown>;
} {
  let out = "";
  const rc = fn({ out: (text) => (out += text), err: () => {} });
  return { rc, payload: JSON.parse(out) as Record<string, unknown> };
}

function captureFromRepoRoot(fn: (io: { out: (text: string) => void; err: (text: string) => void }) => number): {
  rc: number;
  payload: Record<string, unknown>;
} {
  const previous = process.cwd();
  try {
    process.chdir(REPO_ROOT);
    return capture(fn);
  } finally {
    process.chdir(previous);
  }
}

function expectExactTopLevelKeys(payload: Record<string, unknown>, required: string[], family: string, altShape?: AlternateShape): void {
  const expected = altShape && altShape.targetFamilyValue === payload.target_family ? altShape.requiredTopLevelKeys : required;
  expect(Object.keys(payload).sort(), `${family} top-level keys`).toEqual([...expected].sort());
}

function expectEngine(payload: Record<string, unknown>, spec: ValidateFamilySpec, family: string): void {
  if (!spec.engine) return;
  const engine = payload.engine as Record<string, unknown>;
  for (const key of spec.engine.requiredKeys) {
    expect(engine, `${family} engine key '${key}'`).toHaveProperty(key);
  }
  if (spec.engine.commandValue !== undefined) {
    expect(engine.command, `${family} engine command`).toBe(spec.engine.commandValue);
  }
  expect(typeof engine.exit_code, `${family} engine exit code`).toBe("number");
  if (spec.engine.requiredKeys.includes("stdout")) expect(Array.isArray(engine.stdout)).toBe(true);
  if (spec.engine.requiredKeys.includes("stderr")) expect(Array.isArray(engine.stderr)).toBe(true);
}

function captureValidateFamily(family: string, spec: ValidateFamilySpec): { rc: number; payload: Record<string, unknown> } {
  if (family === "artifact") {
    const root = useFixtureProject("ok");
    fixtureRoots.push(root);
    const artifactIndex = spec.argv.indexOf("--artifact");
    const artifact = spec.argv[artifactIndex + 1];
    return capture((io) => cmdValidateArtifact({ artifact, cwd: root, format: VALIDATE_FAMILY_ORACLE.format }, io));
  }
  return capture((io) => main(["node", "agentera", ...spec.argv], io));
}

describe("validate family envelope oracle", () => {
  const familyNames = Object.keys(VALIDATE_FAMILY_ORACLE.families);

  it("declares the oracle-covered families", () => {
    expect(new Set(familyNames)).toEqual(new Set(["cross-capability", "app-home-contract", "capability", "capability-contract", "artifact"]));
  });

  it.each(familyNames)("family '%s' matches its complete pass-envelope contract", (family) => {
    const spec = VALIDATE_FAMILY_ORACLE.families[family];
    const { rc, payload } = captureValidateFamily(family, spec);

    expect(rc).toBe(spec.exitCode);
    expect(payload.command).toBe(VALIDATE_FAMILY_ORACLE.commandValue);
    expect(payload.status).toBe("pass");
    expect(payload.target_family).toBe(spec.targetFamilyValue);
    expect(typeof payload.target).toBe("string");
    expect(Array.isArray(payload.violations)).toBe(true);
    expectExactTopLevelKeys(payload, spec.requiredTopLevelKeys, family, spec.altShape);
    expectEngine(payload, spec, family);

    if (family === "capability") expect(typeof payload.path).toBe("string");
    if (family === "capability-contract") {
      const checks = payload.checks as Array<Record<string, unknown>>;
      const summary = payload.summary as Record<string, unknown>;
      expect(Array.isArray(checks)).toBe(true);
      expect(typeof summary.passed).toBe("number");
      expect(typeof summary.failed).toBe("number");
      for (const check of checks) {
        expect(check.command).toBe("validate");
        expect((check.engine as Record<string, unknown>).command).toBe("validate_capability.py");
      }
    }
    if (family === "artifact") {
      expect(typeof payload.artifact).toBe("string");
      expect(typeof payload.file).toBe("string");
      expect(typeof payload.docs_mapped_default).toBe("string");
      expect(typeof payload.path_source).toBe("string");
    }
  });

  it("matches the real capability-set alternate envelope", () => {
    const spec = VALIDATE_FAMILY_ORACLE.families.capability;
    const target = path.join(REPO_ROOT, "skills", "agentera", "capabilities");
    const { rc, payload } = capture((io) => cmdValidateCapability(target, { format: "json" }, io));
    const checks = payload.checks as Array<Record<string, unknown>>;
    const summary = payload.summary as Record<string, number>;

    expect(rc).toBe(0);
    expect(payload.target_family).toBe("capability-set");
    expectExactTopLevelKeys(payload, spec.requiredTopLevelKeys, "capability-set", spec.altShape);
    expect(checks.length).toBeGreaterThan(0);
    expect(summary.passed + summary.failed).toBe(checks.length);
  });
});

describe("verify eval pass-envelope oracle", () => {
  const targetNames = Object.keys(VERIFY_EVAL_FAMILY_ORACLE.targets).filter((target) => (VERIFY_EVAL_FAMILY_ORACLE.targets[target].argv?.length ?? 0) > 0);

  it("declares the oracle-covered eval targets", () => {
    expect(new Set(targetNames)).toEqual(new Set(["semantic", "routing", "skills_dry_run"]));
  });

  it.each(targetNames)("target '%s' matches its complete pass-envelope contract", (target) => {
    const spec = VERIFY_EVAL_FAMILY_ORACLE.targets[target];
    const { rc, payload } = captureFromRepoRoot((io) => main(["node", "agentera", ...(spec.argv ?? [])], io));

    expect(rc).toBe(spec.exitCode);
    expect(payload.command).toBe(VERIFY_EVAL_FAMILY_ORACLE.commandValue);
    expect(payload.family).toBe(VERIFY_EVAL_FAMILY_ORACLE.familyValue);
    expect(payload.target).toBe(spec.targetValue);
    expect(payload.status).toBe("pass");
    expect(payload.format).toBe("json");
    expectExactTopLevelKeys(payload, VERIFY_EVAL_FAMILY_ORACLE.requiredTopLevelKeys, `eval ${target}`);

    const engine = payload.engine as Record<string, unknown>;
    for (const key of VERIFY_EVAL_FAMILY_ORACLE.engine.requiredKeys) expect(engine).toHaveProperty(key);
    expect(Array.isArray(engine.command)).toBe(true);
    expect(typeof engine.exit_code).toBe("number");

    const diagnostics = payload.diagnostics as Record<string, unknown>;
    for (const key of VERIFY_EVAL_FAMILY_ORACLE.diagnostics.requiredKeys) expect(diagnostics).toHaveProperty(key);
    expect(Array.isArray(diagnostics.stdout)).toBe(true);
    expect(Array.isArray(diagnostics.stderr)).toBe(true);
    expect(diagnostics.line_limit).toBe(VERIFY_EVAL_FAMILY_ORACLE.diagnostics.lineLimitValue);

    const safety = payload.safety as Record<string, unknown>;
    for (const key of VERIFY_EVAL_FAMILY_ORACLE.safety.requiredKeys) expect(safety).toHaveProperty(key);
    expect(typeof safety.summary).toBe("string");
    expect(typeof safety.live).toBe("boolean");
    expect(typeof safety.long_running_default).toBe("boolean");
    expect(safety.live).toBe(spec.live);
    expect(safety.mode).toBe(spec.safetyMode);
  });
});
