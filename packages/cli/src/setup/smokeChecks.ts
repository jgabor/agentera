import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolvePath } from "../core/paths.js";
import { HookCliAdapter } from "../hooks/validateArtifact/index.js";
import { validateCapability } from "../validate/capability.js";
import { smokeCheck, summarizeStatuses } from "./doctor.js";
import type { JsonObject } from "../core/jsonValue.js";

type Env = Record<string, string | undefined>;

const RUNTIME_BINARIES: Record<string, string> = {
  claude: "claude",
  opencode: "opencode",
  copilot: "copilot",
  codex: "codex",
  cursor: "cursor",
  "cursor-agent": "cursor-agent",
};

function which(binary: string, env: Env): string | null {
  const pathEnv = env.PATH ?? process.env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    const candidate = path.join(dir, binary);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // continue
    }
  }
  return null;
}

function runCapabilitySmoke(sourceRoot: string): JsonObject {
  const contract = path.join(sourceRoot, "skills", "agentera", "capability_schema_contract.yaml");
  const statusDir = path.join(sourceRoot, "skills", "agentera", "capabilities", "status");
  const command = ["node", "agentera", "check", "validate", "capability", "status"];
  if (!fs.existsSync(statusDir)) {
    return smokeCheck("npm.validate_capability", "helper", "fail", "status capability directory is missing", {
      command,
      path: statusDir,
      details: ["bundle_packaging"],
    });
  }
  const errors = validateCapability(statusDir, contract);
  if (errors.length > 0) {
    return smokeCheck("npm.validate_capability", "helper", "fail", "status capability validation failed", {
      command,
      path: statusDir,
      details: errors.slice(0, 5),
    });
  }
  return smokeCheck("npm.validate_capability", "helper", "pass", "status capability validation passed", {
    command,
    path: statusDir,
  });
}

function runHookSmoke(): JsonObject {
  const command = ["node", "agentera", "hook", "validate-artifact"];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-doctor-smoke-"));
  try {
    const todoPath = path.join(tmp, "TODO.md");
    fs.writeFileSync(todoPath, "# TODO\n\n## Missing required severity sections\n");
    const payload = JSON.stringify({
      runtime: "opencode",
      hook_event_name: "tool.execute.before",
      cwd: tmp,
      tool_input: {
        file_path: todoPath,
        content: fs.readFileSync(todoPath, "utf8"),
      },
    });
    const [rc, violations] = new HookCliAdapter().run(payload, tmp);
    if (rc === 2 && violations.length > 0) {
      return smokeCheck(
        "npm.hook.validate_artifact",
        "hook",
        "pass",
        "validate-artifact hook denied an invalid TODO.md candidate as expected",
        { command, path: todoPath, details: violations.slice(0, 3) },
      );
    }
    return smokeCheck("npm.hook.validate_artifact", "hook", "fail", `validate-artifact hook exited ${rc}`, {
      command,
      path: todoPath,
      details: violations,
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function runRuntimeHostSmokes(env: Env, runtimes: string[], liveModelAllowed: boolean): JsonObject[] {
  return runtimes.map((runtime) => {
    const binary = RUNTIME_BINARIES[runtime];
    const found = which(binary, env);
    if (!found) {
      return smokeCheck(
        `host.${runtime}`,
        "runtime_host",
        "skip",
        `${binary} executable not found on PATH`,
        { path: binary, details: ["no live model call attempted"] },
      );
    }
    return smokeCheck(
      `host.${runtime}`,
      "runtime_host",
      "pass",
      `${binary} executable found; bounded doctor smoke does not invoke live model hosts`,
      {
        path: found,
        details: [
          liveModelAllowed ? "live model permission supplied" : "no live model permission supplied",
          "no live model call attempted",
        ],
      },
    );
  });
}

export function runNpmSmokeChecks(
  sourceRoot: string,
  env: Env,
  opts: { liveModelAllowed?: boolean; runtimes?: string[] } = {},
): JsonObject {
  const runtimes = opts.runtimes ?? Object.keys(RUNTIME_BINARIES);
  const root = resolvePath(sourceRoot);
  const checks = [runCapabilitySmoke(root), runHookSmoke(), ...runRuntimeHostSmokes(env, runtimes, Boolean(opts.liveModelAllowed))];
  return {
    enabled: true,
    liveModelAllowed: Boolean(opts.liveModelAllowed),
    modelCallsAttempted: false,
    summary: summarizeStatuses(checks),
    checks,
  };
}
