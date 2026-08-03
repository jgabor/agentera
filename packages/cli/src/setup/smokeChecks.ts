import fs from "node:fs";
import path from "node:path";

import { resolvePath } from "../core/paths.js";
import { validateCapability } from "../validate/capability.js";
import type { JsonObject } from "../core/jsonValue.js";

type Env = Record<string, string | undefined>;

function smokeCheck(name: string, status: "pass" | "fail", message: string, fields: JsonObject): JsonObject {
  return { name, category: "helper", status, message, ...fields };
}

function summarizeStatuses(checks: JsonObject[]): JsonObject {
  const summary: JsonObject = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const check of checks) {
    const status = String(check.status);
    summary[status] = Number(summary[status] ?? 0) + 1;
  }
  return summary;
}

function runCapabilitySmoke(sourceRoot: string): JsonObject {
  const contract = path.join(sourceRoot, "skills", "agentera", "capability_schema_contract.yaml");
  const statusDir = path.join(sourceRoot, "skills", "agentera", "capabilities", "status");
  const command = ["node", "agentera", "check", "validate", "capability", "status"];
  if (!fs.existsSync(statusDir)) {
    return smokeCheck("npm.validate_capability", "fail", "status capability directory is missing", {
      command,
      path: statusDir,
      details: ["bundle_packaging"],
    });
  }
  const errors = validateCapability(statusDir, contract);
  if (errors.length > 0) {
    return smokeCheck("npm.validate_capability", "fail", "status capability validation failed", {
      command,
      path: statusDir,
      details: errors.slice(0, 5),
    });
  }
  return smokeCheck("npm.validate_capability", "pass", "status capability validation passed", {
    command,
    path: statusDir,
  });
}

export function runNpmSmokeChecks(
  sourceRoot: string,
  _env: Env,
  opts: { liveModelAllowed?: boolean } = {},
): JsonObject {
  const root = resolvePath(sourceRoot);
  const checks = [runCapabilitySmoke(root)];
  return {
    enabled: true,
    liveModelAllowed: Boolean(opts.liveModelAllowed),
    modelCallsAttempted: false,
    summary: summarizeStatuses(checks),
    checks,
  };
}
