import fs from "node:fs";
import path from "node:path";

import { expanduser, isFile, pathExists, resolvePath } from "../../core/paths.js";
import { parseToml as parseTomlLocal } from "../../core/toml.js";
import {
  mkCheck,
  runtimeResult,
  configuredRootCheck,
  diagnosticCheckNames,
  diagnosticMessages,
  diagnosticStatusLabels,
  diagnosticGapLabels,
  COPILOT_MARKER,
} from "./core.js";
import { diagnoseOpencode } from "./opencode.js";

type Dict = Record<string, any>;
type Env = Record<string, string | undefined>;

const CLAUDE_ROOT_CHECK = diagnosticCheckNames("claude")[0];
const CLAUDE_MISSING_ENV_MESSAGE = diagnosticMessages("claude")[1];
const CLAUDE_WARN_STATUS = diagnosticStatusLabels("claude")[1];
const CLAUDE_USER_ENVIRONMENT_GAP = diagnosticGapLabels("claude")[1];

// Copilot
const COPILOT_HOME_CHECK = diagnosticCheckNames("copilot")[0];
const CO_MSG = diagnosticMessages("copilot");
const COPILOT_MISSING_MESSAGE = CO_MSG[1];
const COPILOT_RC_CONFIGURED_MESSAGE = CO_MSG[2];
const COPILOT_PASS_STATUS = diagnosticStatusLabels("copilot")[0];
const COPILOT_WARN_STATUS = diagnosticStatusLabels("copilot")[1];
const COPILOT_RUNTIME_CONFIG_GAP = diagnosticGapLabels("copilot")[0];

// Codex
export const CODEX_HOME_CHECK = diagnosticCheckNames("codex")[0];
const CODEX_CONFIG_ERROR_MESSAGE = diagnosticMessages("codex")[1];
const CODEX_WARN_STATUS = diagnosticStatusLabels("codex")[1];
const CODEX_FAIL_STATUS = diagnosticStatusLabels("codex")[2];
export const CODEX_RUNTIME_CONFIG_GAP = diagnosticGapLabels("codex")[0];

// Cursor
const CURSOR_HOME_CHECK = diagnosticCheckNames("cursor")[0];
const CURSOR_HOOKS_CHECK = diagnosticCheckNames("cursor")[1];
const CURSOR_AGENTS_CHECK = diagnosticCheckNames("cursor")[2];
const CURSOR_HELPER_MESSAGE = diagnosticMessages("cursor")[0];
const CURSOR_PASS_STATUS = diagnosticStatusLabels("cursor")[0];
const CURSOR_WARN_STATUS = diagnosticStatusLabels("cursor")[1];
const CURSOR_FAIL_STATUS = diagnosticStatusLabels("cursor")[2];
const CURSOR_USER_ENVIRONMENT_GAP = diagnosticGapLabels("cursor")[1];
const CURSOR_HOOK_DRIFT_GAP = diagnosticGapLabels("cursor")[2];
const CURSOR_AGENT_DRIFT_GAP = diagnosticGapLabels("cursor")[3];

// Cursor-agent
const CURSOR_AGENT_HOME_CHECK = diagnosticCheckNames("cursor-agent")[0];
const CURSOR_AGENT_WARN_STATUS = diagnosticStatusLabels("cursor-agent")[1];
const CURSOR_AGENT_USER_ENVIRONMENT_GAP = diagnosticGapLabels("cursor-agent")[1];

export function diagnoseClaude(installRoot: string, _home: string, env: Env): Dict {
  const value = env.CLAUDE_PLUGIN_ROOT;
  let checks: Dict[];
  if (!value) {
    checks = [
      mkCheck(CLAUDE_ROOT_CHECK, CLAUDE_WARN_STATUS, CLAUDE_MISSING_ENV_MESSAGE, {
        source: "environment",
        gap: CLAUDE_USER_ENVIRONMENT_GAP,
      }),
    ];
  } else {
    checks = [
      configuredRootCheck("claude", CLAUDE_ROOT_CHECK, resolvePath(expanduser(value)), installRoot, "environment"),
    ];
  }
  return runtimeResult("claude", env, checks);
}

function copilotRcPaths(home: string): string[] {
  return [
    path.join(home, ".bashrc"),
    path.join(home, ".zshrc"),
    path.join(home, ".config", "fish", "config.fish"),
  ];
}

function extractCopilotMarkerRoot(text: string): string | null {
  const lines = text.split(/\r\n|\r|\n/);
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].replace(/\s+$/, "") !== COPILOT_MARKER) continue;
    if (index + 1 >= lines.length) return null;
    const exportLine = lines[index + 1].trim();
    for (const prefix of ['export AGENTERA_HOME="', 'set -x AGENTERA_HOME "']) {
      if (exportLine.startsWith(prefix) && exportLine.endsWith('"')) {
        return exportLine.slice(prefix.length, -1);
      }
    }
  }
  return null;
}

function copilotShellManualBoundaryMessage(prefix = ""): string {
  const lead = prefix ? `${prefix} ` : "";
  return (
    `${lead}Agentera will not edit shell startup files; cleanup is a ` +
    "user-owned manual boundary. For Copilot app context, pass " +
    "AGENTERA_HOME for a single invocation or use runtime-native " +
    "environment support when available."
  );
}

export function diagnoseCopilot(installRoot: string, home: string, env: Env): Dict {
  const value = env.AGENTERA_HOME;
  if (value) {
    const checks = [
      configuredRootCheck("copilot", COPILOT_HOME_CHECK, resolvePath(expanduser(value)), installRoot, "environment"),
    ];
    return runtimeResult("copilot", env, checks);
  }

  for (const rcPath of copilotRcPaths(home)) {
    if (!isFile(rcPath)) continue;
    const rcText = fs.readFileSync(rcPath, "utf8");
    const markerRoot = extractCopilotMarkerRoot(rcText);
    if (markerRoot === null) continue;
    const check = configuredRootCheck(
      "copilot",
      COPILOT_HOME_CHECK,
      resolvePath(expanduser(markerRoot)),
      installRoot,
      rcPath,
    );
    if (check.status === COPILOT_PASS_STATUS) {
      check.message = COPILOT_RC_CONFIGURED_MESSAGE;
    }
    check.message = copilotShellManualBoundaryMessage(check.message);
    return runtimeResult("copilot", env, [check]);
  }

  const checks = [
    mkCheck(COPILOT_HOME_CHECK, COPILOT_WARN_STATUS, COPILOT_MISSING_MESSAGE, {
      source: "environment/rc",
      gap: COPILOT_RUNTIME_CONFIG_GAP,
    }),
  ];
  return runtimeResult("copilot", env, checks);
}

export function readCodexAgenteraHome(configPath: string): [string | null, string | null] {
  if (!isFile(configPath)) return [null, "missing"];
  let data: Dict;
  try {
    data = parseTomlLocal(fs.readFileSync(configPath, "utf8"));
  } catch (exc) {
    return [null, `invalid TOML: ${(exc as Error).message}`];
  }
  const policy = data.shell_environment_policy;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return [null, "missing shell_environment_policy.set.AGENTERA_HOME"];
  }
  const setTable = (policy as Dict).set;
  if (!setTable || typeof setTable !== "object" || Array.isArray(setTable)) {
    return [null, "missing shell_environment_policy.set.AGENTERA_HOME"];
  }
  const value = (setTable as Dict).AGENTERA_HOME;
  if (typeof value !== "string" || !value) {
    return [null, "missing shell_environment_policy.set.AGENTERA_HOME"];
  }
  return [value, null];
}

export function diagnoseCodex(installRoot: string, home: string, env: Env): Dict {
  const config = path.join(home, ".codex", "config.toml");
  const [value, error] = readCodexAgenteraHome(config);
  let checks: Dict[];
  if (error !== null) {
    const status = error === "missing" || error.startsWith("missing ") ? CODEX_WARN_STATUS : CODEX_FAIL_STATUS;
    checks = [
      mkCheck(CODEX_HOME_CHECK, status, `${CODEX_CONFIG_ERROR_MESSAGE}: ${error}`, {
        source: config,
        path: config,
        gap: CODEX_RUNTIME_CONFIG_GAP,
      }),
    ];
  } else {
    checks = [
      configuredRootCheck("codex", CODEX_HOME_CHECK, resolvePath(expanduser(value as string)), installRoot, config),
    ];
  }
  return runtimeResult("codex", env, checks);
}

function globMdFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries.filter((e) => e.endsWith(".md") && isFile(path.join(dir, e))).sort();
}

export function diagnoseCursor(installRoot: string, home: string, env: Env): Dict {
  const checks: Dict[] = [];
  const value = env.AGENTERA_HOME;
  if (value) {
    checks.push(
      configuredRootCheck("cursor", CURSOR_HOME_CHECK, resolvePath(expanduser(value)), installRoot, "environment"),
    );
  } else {
    checks.push(
      mkCheck(CURSOR_HOME_CHECK, CURSOR_WARN_STATUS, CURSOR_HELPER_MESSAGE, {
        source: "environment",
        gap: CURSOR_USER_ENVIRONMENT_GAP,
      }),
    );
  }

  const hooksPath = path.join(installRoot, ".cursor", "hooks.json");
  if (isFile(hooksPath)) {
    const text = fs.readFileSync(hooksPath, "utf8");
    if (text.includes("cursor_session_start.py") && text.includes("cursor_pre_tool_use.py")) {
      checks.push(
        mkCheck(CURSOR_HOOKS_CHECK, CURSOR_PASS_STATUS, "Cursor hooks.json is present and references Agentera helpers", {
          path: hooksPath,
        }),
      );
    } else {
      checks.push(
        mkCheck(CURSOR_HOOKS_CHECK, CURSOR_WARN_STATUS, "Cursor hooks.json is present but missing Agentera hook references", {
          path: hooksPath,
          gap: CURSOR_HOOK_DRIFT_GAP,
        }),
      );
    }
  } else {
    checks.push(
      mkCheck(CURSOR_HOOKS_CHECK, CURSOR_FAIL_STATUS, "Cursor hooks.json is missing", {
        path: hooksPath,
        gap: CURSOR_HOOK_DRIFT_GAP,
      }),
    );
  }

  const agentsDir = path.join(installRoot, ".cursor", "agents");
  const managed = globMdFiles(agentsDir);
  if (managed.length >= 12) {
    checks.push(
      mkCheck(CURSOR_AGENTS_CHECK, CURSOR_PASS_STATUS, "Cursor managed capability agents are current", {
        path: agentsDir,
        details: managed,
      }),
    );
  } else if (managed.length > 0) {
    checks.push(
      mkCheck(CURSOR_AGENTS_CHECK, CURSOR_WARN_STATUS, `Cursor managed agents incomplete (${managed.length}/12)`, {
        path: agentsDir,
        gap: CURSOR_AGENT_DRIFT_GAP,
      }),
    );
  } else {
    checks.push(
      mkCheck(CURSOR_AGENTS_CHECK, CURSOR_FAIL_STATUS, "Cursor managed capability agents are missing", {
        path: agentsDir,
        gap: CURSOR_AGENT_DRIFT_GAP,
      }),
    );
  }
  return runtimeResult("cursor", env, checks);
}

export function diagnoseCursorAgent(installRoot: string, _home: string, env: Env): Dict {
  const checks: Dict[] = [];
  const value = env.AGENTERA_HOME;
  if (value) {
    checks.push(
      configuredRootCheck("cursor-agent", CURSOR_AGENT_HOME_CHECK, resolvePath(expanduser(value)), installRoot, "environment"),
    );
  } else {
    checks.push(
      mkCheck(
        CURSOR_AGENT_HOME_CHECK,
        CURSOR_AGENT_WARN_STATUS,
        "cursor-agent helper access depends on AGENTERA_HOME or shell rc configuration",
        { source: "environment", gap: CURSOR_AGENT_USER_ENVIRONMENT_GAP },
      ),
    );
  }
  return runtimeResult("cursor-agent", env, checks);
}

export const DIAGNOSTICS: Record<string, (installRoot: string, home: string, env: Env) => Dict> = {
  claude: diagnoseClaude,
  opencode: diagnoseOpencode,
  copilot: diagnoseCopilot,
  codex: diagnoseCodex,
  cursor: diagnoseCursor,
  "cursor-agent": diagnoseCursorAgent,
};
