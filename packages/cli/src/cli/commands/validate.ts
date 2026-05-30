import path from "node:path";

import { resolvePath } from "../../core/paths.js";
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
