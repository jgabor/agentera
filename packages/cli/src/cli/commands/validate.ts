import path from "node:path";
import { readdirSync as fsReaddirSync, statSync as fsStatSync } from "node:fs";

import { resolvePath } from "../../core/paths.js";
import { resolveSourceRoot } from "../../core/sourceRoot.js";
import { validateAgentString, validatePathValue } from "../argvalidate.js";
import { validateCapability, validateContractSelf, validateProtocolSelf } from "../../validate/capability.js";
import { validateGraph } from "../../validate/crossCapability.js";
import { lifecycleMain } from "../../validate/lifecycleAdapters.js";
import { validate as validateAppHome } from "../../validate/appHomeContract.js";
import { emitStructured } from "../structured.js";

/** Port of scripts/agentera cmd_validate delegated-script family. */

type Dict = Record<string, any>;
type Io = { out?: (t: string) => void; err?: (t: string) => void };

interface ProcResult {
  stdout: string;
  stderr: string;
  returncode: number;
}

const VALIDATE_DELEGATED_SCRIPTS: Record<string, string> = {
  "cross-capability": "validate_cross_capability.py",
  "lifecycle-adapters": "validate_lifecycle_adapters.py",
  "app-home-contract": "validate_app_home_contract.py",
};

function pySplitlines(s: string): string[] {
  if (!s) return [];
  const parts = s.split(/\r\n|\r|\n/);
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function runCrossCapability(): ProcResult {
  const errors = validateGraph();
  if (errors.length > 0) {
    return { stdout: errors.map((e) => `FAIL: ${e}\n`).join(""), stderr: "", returncode: 1 };
  }
  return { stdout: "cross-capability artifact graph ok\n", stderr: "", returncode: 0 };
}

function runLifecycleAdapters(): ProcResult {
  const lines: string[] = [];
  const rc = lifecycleMain({ out: (line) => lines.push(line) });
  return { stdout: lines.map((l) => l + "\n").join(""), stderr: "", returncode: rc };
}

function runAppHomeContract(): ProcResult {
  const errors = validateAppHome(resolvePath(repoRoot()));
  if (errors.length > 0) {
    return {
      stdout: "",
      stderr: "App-home contract validation failed:\n" + errors.map((e) => `- ${e}\n`).join(""),
      returncode: 1,
    };
  }
  return { stdout: "OK: app-home contract terminology is release-ready\n", stderr: "", returncode: 0 };
}

function repoRoot(): string {
  // appHomeContract.validate resolves its own default root; pass the source root.
  return process.cwd();
}

const DELEGATED_RUNNERS: Record<string, () => ProcResult> = {
  "cross-capability": runCrossCapability,
  "lifecycle-adapters": runLifecycleAdapters,
  "app-home-contract": runAppHomeContract,
};

function validationProcessPayload(
  targetFamily: string,
  target: string,
  p: string | null,
  result: ProcResult,
): Dict {
  const lines = pySplitlines(result.stderr).map((l) => l.trim());
  const violations = lines.filter((l) => l.trim()).map((l) => (l.startsWith("  ") ? l.slice(2) : l));
  const payload: Dict = {
    command: "validate",
    status: result.returncode === 0 ? "pass" : "fail",
    target_family: targetFamily,
    target,
    violations,
    engine: {
      exit_code: result.returncode,
      stdout: pySplitlines(result.stdout),
      stderr: pySplitlines(result.stderr),
    },
  };
  if (p !== null) payload.path = resolvePath(p);
  return payload;
}

function delegatedValidationPayload(targetFamily: string, result: ProcResult, engineCommand: string): Dict {
  const payload = validationProcessPayload(targetFamily, targetFamily, null, result);
  payload.engine = { ...payload.engine, command: engineCommand };
  return payload;
}

export function cmdValidate(family: string, args: { format?: string }, io: Io): number {
  const out = io.out ?? ((t: string) => process.stdout.write(t));
  const err = io.err ?? ((t: string) => process.stderr.write(t));
  if (!(family in DELEGATED_RUNNERS)) {
    throw new Error(
      "unsupported validate target family; valid families: capability, artifact, descriptors, " +
        "cross-capability, lifecycle-adapters, app-home-contract, capability-contract.",
    );
  }
  const result = DELEGATED_RUNNERS[family]();
  if ((args.format ?? "text") === "json") {
    emitStructured(
      delegatedValidationPayload(family, result, VALIDATE_DELEGATED_SCRIPTS[family]),
      "json",
      out,
    );
  } else {
    if (result.stdout) out(result.stdout);
    if (result.stderr) err(result.stderr);
  }
  return result.returncode;
}

export function isDelegatedValidateFamily(family: string): boolean {
  return family in DELEGATED_RUNNERS;
}

// ── capability + capability-contract families ───────────────────────

const CAPABILITY_NAMES = [
  "hej", "visionera", "resonera", "inspirera", "planera", "realisera",
  "optimera", "inspektera", "dokumentera", "profilera", "visualisera", "orkestrera",
];
const CONTRACT_PATH = "skills/agentera/capability_schema_contract.yaml";
const PROTOCOL_PATH = "skills/agentera/protocol.yaml";

function pyRepr(value: string): string {
  return value.includes("'") && !value.includes('"') ? `"${value}"` : `'${value}'`;
}

function validateCapabilityTarget(target: string): string {
  validateAgentString(target, "capability target");
  const sourceRoot = resolveSourceRoot();
  if (CAPABILITY_NAMES.includes(target)) {
    return path.join(sourceRoot, "skills", "agentera", "capabilities", target);
  }
  if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(target)) {
    const valid = CAPABILITY_NAMES.join(", ");
    throw new Error(
      `unsupported capability target ${pyRepr(target)}; valid capability names: ${valid}. ` +
        "Syntax: agentera validate capability <capability-or-path> [--format text|json]. " +
        "Example: agentera validate capability hej",
    );
  }
  validatePathValue(target, "capability path");
  return target;
}

function capabilityResult(capDir: string): ProcResult {
  const resolved = resolvePath(capDir);
  let stdout = `Validating capability: ${resolved}\nUsing contract: ${CONTRACT_PATH}\n`;
  let errors: string[];
  try {
    errors = validateCapability(resolved, CONTRACT_PATH);
  } catch (exc) {
    errors = [(exc as Error).message];
  }
  let stderr = "";
  let returncode = 0;
  if (errors.length > 0) {
    stderr = "FAILED:\n" + errors.map((e) => `  ${e}\n`).join("");
    returncode = 1;
  } else {
    stdout += "PASS: capability directory is valid\n";
  }
  return { stdout, stderr, returncode };
}

function listDirsSorted(dir: string): string[] {
  let entries: string[];
  try {
    entries = fsReaddirSync(dir);
  } catch {
    return [];
  }
  return entries
    .map((e) => path.join(dir, e))
    .filter((p) => {
      try {
        return fsStatSync(p).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

export function cmdValidateCapability(target: string, args: { format?: string }, io: Io): number {
  const out = io.out ?? ((t: string) => process.stdout.write(t));
  const err = io.err ?? ((t: string) => process.stderr.write(t));
  const capDir = validateCapabilityTarget(target);
  const sourceRoot = resolveSourceRoot();
  const capabilityRoot = path.join(sourceRoot, "skills", "agentera", "capabilities");
  let targets = [capDir];
  if (resolvePath(capDir) === resolvePath(capabilityRoot)) {
    targets = listDirsSorted(capDir);
  }
  const format = args.format ?? "text";
  if (targets.length > 1) {
    const results = targets.map((t) => capabilityResult(t));
    const status = results.every((r) => r.returncode === 0) ? "pass" : "fail";
    if (format === "json") {
      const checks = targets.map((t, i) =>
        validationProcessPayload("capability", path.basename(t), t, results[i]),
      );
      emitStructured(
        {
          command: "validate",
          status,
          target_family: "capability-set",
          target,
          path: resolvePath(capDir),
          checks,
          violations: checks.flatMap((c) => c.violations as string[]),
          summary: {
            passed: checks.filter((c) => c.status === "pass").length,
            failed: checks.filter((c) => c.status === "fail").length,
          },
        },
        "json",
        out,
      );
    } else {
      for (const r of results) {
        if (r.stdout) out(r.stdout);
        if (r.stderr) err(r.stderr);
      }
    }
    return status === "pass" ? 0 : 1;
  }
  const result = capabilityResult(capDir);
  if (format === "json") {
    emitStructured(validationProcessPayload("capability", target, capDir, result), "json", out);
  } else {
    if (result.stdout) out(result.stdout);
    if (result.stderr) err(result.stderr);
  }
  return result.returncode;
}

function contractSelfResult(): ProcResult {
  let stdout = `Self-validating contract: ${CONTRACT_PATH}\n`;
  let errors: string[];
  try {
    errors = validateContractSelf(CONTRACT_PATH);
  } catch (exc) {
    errors = [(exc as Error).message];
  }
  let stderr = "";
  let returncode = 0;
  if (errors.length > 0) {
    stderr = "FAILED: contract does not pass its own rules:\n" + errors.map((e) => `  ${e}\n`).join("");
    returncode = 1;
  } else {
    stdout += "PASS: contract is self-referentially valid\n";
  }
  return { stdout, stderr, returncode };
}

function protocolSelfResult(): ProcResult {
  let stdout = `Validating protocol: ${PROTOCOL_PATH}\n`;
  let errors: string[];
  try {
    errors = validateProtocolSelf(PROTOCOL_PATH);
  } catch (exc) {
    errors = [(exc as Error).message];
  }
  let stderr = "";
  let returncode = 0;
  if (errors.length > 0) {
    stderr = "FAILED:\n" + errors.map((e) => `  ${e}\n`).join("");
    returncode = 1;
  } else {
    stdout += "PASS: protocol is internally consistent\n";
  }
  return { stdout, stderr, returncode };
}

export function cmdValidateCapabilityContract(args: { format?: string }, io: Io): number {
  const out = io.out ?? ((t: string) => process.stdout.write(t));
  const err = io.err ?? ((t: string) => process.stderr.write(t));
  const results: Array<[string, ProcResult]> = [
    ["capability-contract-self", contractSelfResult()],
    ["capability-protocol", protocolSelfResult()],
  ];
  if ((args.format ?? "text") === "json") {
    const checks = results.map(([name, result]) => delegatedValidationPayload(name, result, "validate_capability.py"));
    emitStructured(
      {
        command: "validate",
        status: results.every(([, r]) => r.returncode === 0) ? "pass" : "fail",
        target_family: "capability-contract",
        target: "capability-schema-contract-and-protocol",
        checks,
        violations: checks.flatMap((c) => c.violations as string[]),
        summary: {
          passed: results.filter(([, r]) => r.returncode === 0).length,
          failed: results.filter(([, r]) => r.returncode !== 0).length,
        },
      },
      "json",
      out,
    );
  } else {
    for (const [, result] of results) {
      if (result.stdout) out(result.stdout);
      if (result.stderr) err(result.stderr);
    }
  }
  return results.every(([, r]) => r.returncode === 0) ? 0 : 1;
}
