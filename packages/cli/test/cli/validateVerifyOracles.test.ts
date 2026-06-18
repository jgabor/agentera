import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { cleanupFixtureProject, useFixtureProject } from "../helpers/useFixtureProject.js";

import {
  cmdValidate,
  cmdValidateArtifact,
  cmdValidateCapability,
  cmdValidateCapabilityContract,
  cmdValidateDescriptors,
} from "../../src/cli/commands/validate.js";
import { cmdVerify } from "../../src/cli/commands/verify.js";
import { main } from "../../src/cli/dispatch.js";

const VALIDATE_FAMILY_ORACLE_PATH = path.join(
  __dirname,
  "fixtures",
  "oracle",
  "validate-family.json",
);
const VERIFY_EVAL_FAMILY_ORACLE_PATH = path.join(
  __dirname,
  "fixtures",
  "oracle",
  "verify-eval-family.json",
);

const VALIDATE_FAMILY_ORACLE = JSON.parse(fs.readFileSync(VALIDATE_FAMILY_ORACLE_PATH, "utf8")) as {
  format: "json";
  commandValue: "validate";
  statusUnion: ["pass", "fail"];
  violationsValueType: "array<string>";
  families: Record<
    string,
    {
      argv: string[];
      exitCode: number;
      requiredTopLevelKeys: string[];
      targetFamilyValue: string;
      targetValueType: "string";
      engine?: {
        requiredKeys: string[];
        commandValueType?: "string";
        commandValue?: string;
        exitCodeValueType?: "number";
        stdoutValueType?: "array<string>";
        stderrValueType?: "array<string>";
      };
      altShape?: {
        targetFamilyValue: string;
        requiredTopLevelKeys: string[];
        summaryRequiredKeys?: string[];
        failExitCode?: number;
        failStatusValue?: "fail";
      };
    }
  >;
};

const VERIFY_EVAL_FAMILY_ORACLE = JSON.parse(fs.readFileSync(VERIFY_EVAL_FAMILY_ORACLE_PATH, "utf8")) as {
  format: "json";
  commandValue: "verify";
  familyValue: "eval";
  statusUnion: ["pass", "fail"];
  formatValueUnion: ["text", "json"];
  requiredTopLevelKeys: string[];
  engine: {
    requiredKeys: string[];
    commandValueType: "array<string>";
    exitCodeValueType: "number";
  };
  diagnostics: {
    requiredKeys: string[];
    stdoutValueType: "array<string>";
    stderrValueType: "array<string>";
    lineLimitValueType: "number";
    lineLimitValue: number;
  };
  safety: {
    requiredKeys: string[];
    modeValueUnion: string[];
    summaryValueType: "string";
    liveValueType: "boolean";
    longRunningDefaultValueType: "boolean";
  };
  targets: Record<
    string,
    {
      argv: string[];
      exitCode: number;
      targetValueType: "string";
      targetValue: string;
      safetyMode: string;
      live: boolean;
    }
  >;
};

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
const SEMANTIC_FIXTURE = path.join(REPO_ROOT, "fixtures", "semantic", "hej-bare-message.md");
const ARTIFACT_VALIDATE_TARGET = "PLAN.md";

const fixtureRoots: string[] = [];
afterEach(() => {
  while (fixtureRoots.length) cleanupFixtureProject(fixtureRoots.pop()!);
});

function capture(
  fn: (io: { out: (t: string) => void; err: (t: string) => void }) => number,
): { rc: number; out: string; err: string } {
  let out = "";
  let err = "";
  const rc = fn({ out: (t) => (out += t), err: (t) => (err += t) });
  return { rc, out, err };
}

function readJson(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

function assertRequiredKeys(
  payload: Record<string, unknown>,
  required: string[],
  family: string,
  oraclePath: string,
): void {
  for (const key of required) {
    if (!(key in payload)) {
      throw new Error(
        `oracle contract drift on family '${family}': required top-level key '${key}' is missing from the live envelope. Update ${oraclePath} with an intentional key addition or revert the field change.`,
      );
    }
    expect(payload, `family '${family}' envelope`).toHaveProperty(key);
  }
}

function assertValueTypes(
  payload: Record<string, unknown>,
  expected: Record<string, "string" | "number" | "boolean" | "array" | "object">,
  family: string,
  oraclePath: string,
): void {
  for (const [key, type] of Object.entries(expected)) {
    const v = payload[key];
    const actual = Array.isArray(v) ? "array" : typeof v;
    if (actual !== type) {
      throw new Error(
        `oracle contract drift on family '${family}': key '${key}' expected type '${type}' but live envelope has '${actual}'. Update ${oraclePath} with an intentional type change or revert the field.`,
      );
    }
  }
}

/**
 * Drift detection: assert that the live envelope's top-level key set is exactly
 * the union of the family's required keys and any alt-shape keys. If a new
 * field is added to the live envelope, this test fails with a clear diff naming
 * the extra key, requiring the developer to update the oracle (or revert).
 *
 * The altShape is only consulted when the live envelope's target_family matches
 * the altShape's targetFamilyValue; otherwise only the base required keys apply
 * (this is how capability's single-target vs. capability-set cases are kept
 * separate).
 */
function assertExactTopLevelKeys(
  payload: Record<string, unknown>,
  required: string[],
  altShape: { targetFamilyValue?: string; requiredTopLevelKeys?: string[] } | undefined,
  family: string,
  oraclePath: string,
): void {
  const expected = new Set<string>(required);
  if (
    altShape?.targetFamilyValue !== undefined &&
    altShape.requiredTopLevelKeys !== undefined &&
    payload.target_family === altShape.targetFamilyValue
  ) {
    for (const key of altShape.requiredTopLevelKeys) expected.add(key);
  }
  const actual = new Set(Object.keys(payload));
  const missing: string[] = [...expected].filter((k) => !actual.has(k)).sort();
  const extra: string[] = [...actual].filter((k) => !expected.has(k)).sort();
  if (missing.length > 0 || extra.length > 0) {
    const lines: string[] = [
      `oracle contract drift on family '${family}': top-level key set does not match the frozen contract.`,
    ];
    if (missing.length > 0) {
      lines.push(
        `  missing keys: [${missing.join(", ")}] (the oracle requires these but the live envelope does not emit them — likely a regression).`,
      );
    }
    if (extra.length > 0) {
      lines.push(
        `  extra keys: [${extra.join(", ")}] (the live envelope emits these but the oracle does not declare them — update ${oraclePath} with an intentional key addition or revert the field).`,
      );
    }
    throw new Error(lines.join("\n"));
  }
}

function runDispatch(argv: string[]): { rc: number; payload: Record<string, unknown> } {
  const { rc, out } = capture((io) => main(["node", "agentera", ...argv], io));
  return { rc, payload: readJson(out) };
}

describe("validate family envelope (oracle parity)", () => {
  const familyNames = Object.keys(VALIDATE_FAMILY_ORACLE.families);

  it("declares the seven families in the oracle", () => {
    // The seven pinned families must stay in lockstep with `check validate` routing.
    expect(new Set(familyNames)).toEqual(
      new Set([
        "cross-capability",
        "lifecycle-adapters",
        "app-home-contract",
        "capability",
        "capability-contract",
        "descriptors",
        "artifact",
      ]),
    );
  });

  // The per-family live envelope is captured by calling the cmd* functions
  // directly, matching the existing validate.test.ts pattern (process.cwd()
  // resolves to packages/cli at vitest time; the cmd* helpers walk up to the
  // repo source root). The dispatch wiring is covered separately below.
  function capturePassEnvelope(family: string): { rc: number; payload: Record<string, unknown> } {
    if (family === "cross-capability" || family === "lifecycle-adapters" || family === "app-home-contract") {
      const { rc, out } = capture((io) => cmdValidate(family, { format: "json" }, io));
      return { rc, payload: readJson(out) };
    }
    if (family === "capability") {
      const { rc, out } = capture((io) => cmdValidateCapability("realisera", { format: "json" }, io));
      return { rc, payload: readJson(out) };
    }
    if (family === "capability-contract") {
      const { rc, out } = capture((io) => cmdValidateCapabilityContract({ format: "json" }, io));
      return { rc, payload: readJson(out) };
    }
    if (family === "descriptors") {
      const { rc, out } = capture((io) => cmdValidateDescriptors({ format: "json" }, io));
      return { rc, payload: readJson(out) };
    }
    if (family === "artifact") {
      const root = useFixtureProject("ok");
      fixtureRoots.push(root);
      const { rc, out } = capture((io) =>
        cmdValidateArtifact({ artifact: ARTIFACT_VALIDATE_TARGET, cwd: root, format: "json" }, io),
      );
      return { rc, payload: readJson(out) };
    }
    throw new Error(`unknown family '${family}' in capturePassEnvelope`);
  }

  it.each(familyNames)("family '%s' pass envelope matches the oracle", (family) => {
    const spec = VALIDATE_FAMILY_ORACLE.families[family];
    const { rc, payload } = capturePassEnvelope(family);
    expect(rc, `rc for family '${family}'`).toBe(spec.exitCode);
    // Top-level literal pins.
    expect(payload.command, `command for family '${family}'`).toBe(VALIDATE_FAMILY_ORACLE.commandValue);
    expect(VALIDATE_FAMILY_ORACLE.statusUnion, "status union is fixed").toContain(payload.status as string);
    expect(payload.target_family, `target_family for family '${family}'`).toBe(spec.targetFamilyValue);
    // Required keys per family.
    assertRequiredKeys(payload, spec.requiredTopLevelKeys, family, "validate-family.json");
    // Strict drift detection: the live envelope must not add undeclared keys.
    assertExactTopLevelKeys(
      payload,
      spec.requiredTopLevelKeys,
      spec.altShape,
      family,
      "validate-family.json",
    );
    // Generic value types shared across families.
    assertValueTypes(
      payload,
      {
        command: "string",
        status: "string",
        target_family: "string",
        target: "string",
        violations: "array",
      },
      family,
      "validate-family.json",
    );
  });

  it("delegated families expose the engine.command script name", () => {
    for (const family of ["cross-capability", "lifecycle-adapters", "app-home-contract"]) {
      const spec = VALIDATE_FAMILY_ORACLE.families[family];
      const { payload } = capturePassEnvelope(family);
      const engine = payload.engine as Record<string, unknown>;
      for (const key of spec.engine!.requiredKeys) {
        expect(engine, `engine key '${key}' for '${family}'`).toHaveProperty(key);
      }
      expect(engine.command, `engine.command for '${family}'`).toBe(spec.engine!.commandValue);
      expect(typeof engine.exit_code, `engine.exit_code type for '${family}'`).toBe("number");
      expect(Array.isArray(engine.stdout), `engine.stdout array for '${family}'`).toBe(true);
      expect(Array.isArray(engine.stderr), `engine.stderr array for '${family}'`).toBe(true);
    }
  });

  it("capability family does not embed engine.command (delegated runner is not a script)", () => {
    const spec = VALIDATE_FAMILY_ORACLE.families["capability"];
    const { payload } = capturePassEnvelope("capability");
    const engine = payload.engine as Record<string, unknown>;
    for (const key of spec.engine!.requiredKeys) {
      expect(engine, `engine key '${key}' for 'capability'`).toHaveProperty(key);
    }
    expect(typeof engine.exit_code, "engine.exit_code is numeric").toBe("number");
    expect(Array.isArray(engine.stdout), "engine.stdout is an array").toBe(true);
    expect(Array.isArray(engine.stderr), "engine.stderr is an array").toBe(true);
    // The path field carries the resolved capability directory.
    expect(typeof payload.path, "path field is a string").toBe("string");
  });

  it("capability-contract family exposes checks[] and summary { passed, failed }", () => {
    const spec = VALIDATE_FAMILY_ORACLE.families["capability-contract"];
    const { rc, payload } = capturePassEnvelope("capability-contract");
    expect(rc).toBe(spec.exitCode);
    const checks = payload.checks as Array<Record<string, unknown>>;
    const summary = payload.summary as Record<string, unknown>;
    expect(Array.isArray(checks), "checks is an array").toBe(true);
    expect(summary, "summary has passed and failed").toHaveProperty("passed");
    expect(summary, "summary has passed and failed").toHaveProperty("failed");
    expect(typeof summary.passed, "summary.passed is numeric").toBe("number");
    expect(typeof summary.failed, "summary.failed is numeric").toBe("number");
    // Each check has the delegated envelope shape.
    for (const check of checks) {
      expect(check.command, "check.command").toBe("validate");
      const engine = check.engine as Record<string, unknown>;
      expect(engine.command, "check.engine.command").toBe("validate_capability.py");
      expect(typeof engine.exit_code, "check.engine.exit_code").toBe("number");
    }
  });

  it("descriptors family has runtime x capability checks and a 24-check count", () => {
    const spec = VALIDATE_FAMILY_ORACLE.families["descriptors"];
    const { rc, payload } = capturePassEnvelope("descriptors");
    expect(rc).toBe(spec.exitCode);
    const checks = payload.checks as Array<Record<string, unknown>>;
    const summary = payload.summary as Record<string, unknown>;
    expect(checks.length, "descriptors check count is 24").toBe(24);
    expect(
      checks.length,
      "descriptors summary.passed + summary.failed equals checks.length",
    ).toBe(Number(summary.passed) + Number(summary.failed));
    for (const check of checks) {
      expect(["codex", "opencode"], "descriptors check runtime").toContain(check.runtime as string);
      expect(typeof check.capability, "descriptors check capability is a string").toBe("string");
      expect(typeof check.path, "descriptors check path is a string").toBe("string");
      expect(["pass", "fail"], "descriptors check status").toContain(check.status as string);
    }
  });

  it("artifact family exposes engine.command='validate-artifact' and the resolved file", () => {
    const spec = VALIDATE_FAMILY_ORACLE.families["artifact"];
    const { rc, payload } = capturePassEnvelope("artifact");
    expect(rc).toBe(spec.exitCode);
    const engine = payload.engine as Record<string, unknown>;
    expect(engine.command, "artifact engine.command").toBe("validate-artifact");
    expect(typeof engine.exit_code, "artifact engine.exit_code is numeric").toBe("number");
    expect(typeof payload.artifact, "artifact field is a string").toBe("string");
    expect(typeof payload.file, "file field is a string").toBe("string");
    expect(typeof payload.docs_mapped_default, "docs_mapped_default is a string").toBe("string");
    expect(typeof payload.path_source, "path_source is a string").toBe("string");
  });

  it("artifact fail envelope (rc 2) populates violations and engine.exit_code=2", () => {
    // Reuse the wired dispatch path: emitInvalidInput is the canonical fail envelope
    // for unsupported_target, and cmdValidateArtifact returns rc 2 when the engine
    // reports a violation. The structural contract is owned by the invalid-input oracle.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "va-"));
    const badFile = path.join(dir, "bad.yaml");
    fs.writeFileSync(badFile, "x");
    try {
      const { rc, out } = capture((io) =>
        cmdValidateArtifact({ artifact: "PLAN.md", file: badFile, format: "json" }, io),
      );
      const payload = readJson(out);
      expect(rc, "artifact fail envelope returns rc 2").toBe(2);
      expect(payload.status, "artifact fail envelope status is 'fail'").toBe("fail");
      const violations = payload.violations as string[];
      expect(Array.isArray(violations), "fail envelope has a violations array").toBe(true);
      expect(violations.length, "fail envelope has at least one violation").toBeGreaterThan(0);
      const engine = payload.engine as Record<string, unknown>;
      expect(engine.exit_code, "fail engine.exit_code is 2").toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dispatch wiring: unsupported family returns the canonical invalid-input envelope (rc 2)", () => {
    // Cross-check that the validate family oracle does not duplicate the
    // invalid-input contract: the unsupported_target case is owned by
    // invalid-input-envelope.json and enforced by invalidInputEnvelope.test.ts.
    const { rc, payload } = runDispatch(["check", "validate", "bogus", "--format", "json"]);
    expect(rc).toBe(2);
    expect(payload.status).toBe("fail");
    const error = payload.error as Record<string, unknown>;
    expect(error.class, "unsupported family class").toBe("unsupported_target");
  });

  it("dispatch wiring: missing family returns the canonical invalid-input envelope (rc 2)", () => {
    const { rc, payload } = runDispatch(["check", "validate", "--format", "json"]);
    expect(rc).toBe(2);
    expect(payload.status).toBe("fail");
    const error = payload.error as Record<string, unknown>;
    expect(error.class, "missing family class").toBe("missing_argument");
  });
});

describe("verify eval family envelope (oracle parity)", () => {
  const targetNames = Object.keys(VERIFY_EVAL_FAMILY_ORACLE.targets).filter(
    (t) =>
      Array.isArray(VERIFY_EVAL_FAMILY_ORACLE.targets[t].argv) &&
      VERIFY_EVAL_FAMILY_ORACLE.targets[t].argv.length > 0,
  );

  it("declares the eval target entries in the oracle", () => {
    // The semantic + skills_dry_run targets must stay pinned. The skills_run
    // entry is documentation-only (no argv pinned, see oracle note).
    expect(new Set(targetNames)).toEqual(new Set(["semantic", "skills_dry_run"]));
  });

  function captureEvalPassEnvelope(target: string): { rc: number; payload: Record<string, unknown> } {
    if (target === "semantic") {
      const { rc, out } = capture((io) =>
        cmdVerify(
          { family: "eval", target: "semantic", fixtures: [SEMANTIC_FIXTURE], format: "json" },
          io,
        ),
      );
      return { rc, payload: readJson(out) };
    }
    if (target === "skills_dry_run") {
      const { rc, out } = capture((io) =>
        cmdVerify({ family: "eval", target: "skills", dryRun: true, format: "json" }, io),
      );
      return { rc, payload: readJson(out) };
    }
    throw new Error(`unknown target '${target}' in captureEvalPassEnvelope`);
  }

  it.each(targetNames)("target '%s' pass envelope matches the oracle", (target) => {
    const spec = VERIFY_EVAL_FAMILY_ORACLE.targets[target];
    const { rc, payload } = captureEvalPassEnvelope(target);
    expect(rc, `rc for verify eval '${target}'`).toBe(spec.exitCode);
    expect(payload.command, `command for verify eval '${target}'`).toBe(
      VERIFY_EVAL_FAMILY_ORACLE.commandValue,
    );
    expect(payload.family, `family for verify eval '${target}'`).toBe(
      VERIFY_EVAL_FAMILY_ORACLE.familyValue,
    );
    expect(payload.target, `target for verify eval '${target}'`).toBe(spec.targetValue);
    expect(VERIFY_EVAL_FAMILY_ORACLE.statusUnion).toContain(payload.status as string);
    expect(VERIFY_EVAL_FAMILY_ORACLE.formatValueUnion).toContain(payload.format as string);
    // Top-level required keys.
    assertRequiredKeys(
      payload,
      VERIFY_EVAL_FAMILY_ORACLE.requiredTopLevelKeys,
      `eval ${target}`,
      "verify-eval-family.json",
    );
    // Strict drift detection: the live envelope must not add undeclared keys.
    assertExactTopLevelKeys(
      payload,
      VERIFY_EVAL_FAMILY_ORACLE.requiredTopLevelKeys,
      undefined,
      `eval ${target}`,
      "verify-eval-family.json",
    );
  });

  it("engine, diagnostics, and safety sub-objects match the pinned shape", () => {
    for (const target of targetNames) {
      const spec = VERIFY_EVAL_FAMILY_ORACLE.targets[target];
      const { payload } = captureEvalPassEnvelope(target);
      const engine = payload.engine as Record<string, unknown>;
      for (const key of VERIFY_EVAL_FAMILY_ORACLE.engine.requiredKeys) {
        expect(engine, `engine key '${key}' for '${target}'`).toHaveProperty(key);
      }
      expect(Array.isArray(engine.command), `engine.command is an array for '${target}'`).toBe(true);
      expect(typeof engine.exit_code, `engine.exit_code is numeric for '${target}'`).toBe("number");

      const diagnostics = payload.diagnostics as Record<string, unknown>;
      for (const key of VERIFY_EVAL_FAMILY_ORACLE.diagnostics.requiredKeys) {
        expect(diagnostics, `diagnostics key '${key}' for '${target}'`).toHaveProperty(key);
      }
      expect(Array.isArray(diagnostics.stdout), `diagnostics.stdout is an array for '${target}'`).toBe(
        true,
      );
      expect(Array.isArray(diagnostics.stderr), `diagnostics.stderr is an array for '${target}'`).toBe(
        true,
      );
      expect(diagnostics.line_limit, `diagnostics.line_limit for '${target}'`).toBe(
        VERIFY_EVAL_FAMILY_ORACLE.diagnostics.lineLimitValue,
      );

      const safety = payload.safety as Record<string, unknown>;
      for (const key of VERIFY_EVAL_FAMILY_ORACLE.safety.requiredKeys) {
        expect(safety, `safety key '${key}' for '${target}'`).toHaveProperty(key);
      }
      expect(VERIFY_EVAL_FAMILY_ORACLE.safety.modeValueUnion, `safety.mode union for '${target}'`).toContain(
        safety.mode as string,
      );
      expect(typeof safety.summary, `safety.summary is a string for '${target}'`).toBe("string");
      expect(typeof safety.live, `safety.live is boolean for '${target}'`).toBe("boolean");
      expect(
        typeof safety.long_running_default,
        `safety.long_running_default is boolean for '${target}'`,
      ).toBe("boolean");
      expect(safety.live, `safety.live for '${target}'`).toBe(spec.live);
      expect(safety.mode, `safety.mode for '${target}'`).toBe(spec.safetyMode);
    }
  });

  it("documents the verify unsupported-target text-mode gap (pre-existing, see verify.test.ts:63-67)", () => {
    // Pre-existing gap: cmdVerify catches validateVerifyRequest errors and writes
    // a text-mode `Error: ...` line to stderr instead of routing through
    // emitInvalidInput. The pass envelope oracle (this file) freezes the
    // canonical eval envelope; the text-mode error path is owned by
    // verify.test.ts and is intentionally out of scope for this cycle (it
    // would require a dispatch-level fix in runVerify, which the plan
    // defers to a future cycle).
    const { rc } = capture((io) => main(["node", "agentera", "check", "verify", "eval", "bogus", "--format", "json"], io));
    expect(rc).toBe(2);
  });
});

describe("oracle pinning", () => {
  it("validate-family oracle pins the cross-cutting constants", () => {
    expect(VALIDATE_FAMILY_ORACLE.format).toBe("json");
    expect(VALIDATE_FAMILY_ORACLE.commandValue).toBe("validate");
    expect(VALIDATE_FAMILY_ORACLE.statusUnion).toEqual(["pass", "fail"]);
    expect(VALIDATE_FAMILY_ORACLE.violationsValueType).toBe("array<string>");
  });

  it("validate-family oracle references the invalid-input envelope oracle for the fail path", () => {
    expect(VALIDATE_FAMILY_ORACLE.failEnvelope.referencedOracle).toBe("invalid-input-envelope.json");
    expect(VALIDATE_FAMILY_ORACLE.failEnvelope.referencedOraclePath).toBe(
      "packages/cli/test/cli/fixtures/oracle/invalid-input-envelope.json",
    );
    expect(VALIDATE_FAMILY_ORACLE.relatedOracles.invalidInputEnvelope).toBe(
      "packages/cli/test/cli/fixtures/oracle/invalid-input-envelope.json",
    );
  });

  it("verify-eval-family oracle pins the cross-cutting constants", () => {
    expect(VERIFY_EVAL_FAMILY_ORACLE.format).toBe("json");
    expect(VERIFY_EVAL_FAMILY_ORACLE.commandValue).toBe("verify");
    expect(VERIFY_EVAL_FAMILY_ORACLE.familyValue).toBe("eval");
    expect(VERIFY_EVAL_FAMILY_ORACLE.statusUnion).toEqual(["pass", "fail"]);
    expect(VERIFY_EVAL_FAMILY_ORACLE.diagnostics.lineLimitValue).toBe(20);
  });

  it("verify-eval-family oracle references the invalid-input envelope oracle for the fail path", () => {
    expect(VERIFY_EVAL_FAMILY_ORACLE.failEnvelope.referencedOracle).toBe("invalid-input-envelope.json");
    expect(VERIFY_EVAL_FAMILY_ORACLE.relatedOracles.invalidInputEnvelope).toBe(
      "packages/cli/test/cli/fixtures/oracle/invalid-input-envelope.json",
    );
  });

  it("drift detector fails with a named diff when a new field is added (AC3)", () => {
    // The drift detector is the AC3 enforcement: a new field in the live
    // envelope must surface a diff naming the extra key so the developer is
    // forced to update the oracle (or revert). Sanity-check the helper here
    // so the contract is self-tested.
    const baseRequired = ["command", "status", "target_family", "target", "violations"];
    const matching = { command: "validate", status: "pass", target_family: "x", target: "x", violations: [] };
    expect(() => assertExactTopLevelKeys(matching, baseRequired, undefined, "x", "oracle.json")).not.toThrow();
    const extra = { ...matching, brand_new_field: "x" };
    expect(() => assertExactTopLevelKeys(extra, baseRequired, undefined, "x", "oracle.json")).toThrow(
      /brand_new_field/,
    );
    const missing = { command: "validate", status: "pass", target_family: "x", target: "x" };
    expect(() => assertExactTopLevelKeys(missing, baseRequired, undefined, "x", "oracle.json")).toThrow(
      /violations/,
    );
  });

  it("drift detector consults altShape only when the live target_family matches", () => {
    // The capability family has an altShape for the root-target 'capability-set'
    // case. The detector must only apply the altShape keys when the live
    // envelope's target_family actually matches.
    const required = ["command", "status", "target_family", "target", "violations", "engine", "path"];
    const altShape = { targetFamilyValue: "capability-set", requiredTopLevelKeys: ["checks", "summary"] };
    // single-capability target: altShape must NOT be applied.
    const single = { command: "validate", status: "pass", target_family: "capability", target: "x", violations: [], engine: {}, path: "x" };
    expect(() => assertExactTopLevelKeys(single, required, altShape, "capability", "oracle.json")).not.toThrow();
    // capability-set target: altShape keys are required.
    const set = { ...single, target_family: "capability-set", checks: [], summary: {} };
    expect(() => assertExactTopLevelKeys(set, required, altShape, "capability", "oracle.json")).not.toThrow();
    // capability-set target missing checks/summary: drift detector names the missing keys.
    const setMissing = { ...single, target_family: "capability-set" };
    expect(() => assertExactTopLevelKeys(setMissing, required, altShape, "capability", "oracle.json")).toThrow(
      /checks/,
    );
  });
});
