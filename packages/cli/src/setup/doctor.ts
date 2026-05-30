import { fileURLToPath } from "node:url";
import path from "node:path";

import { expanduser, isFile, pathExists, resolvePath } from "../core/paths.js";
import {
  SETUP_EVIDENCE,
  classifyResolvedRoot,
} from "../state/installRoot.js";
import { loadRegistry } from "../registries/runtimeAdapterRegistry.js";
import { parseToml as parseTomlLocal } from "../core/toml.js";

/**
 * Setup diagnosis and confirmed installation for an Agentera suite bundle.
 *
 * Faithful TS port of scripts/setup_doctor.py (slice 1: registry-derived
 * constants, install-root classification, and the generic check/aggregate
 * helpers). Per-runtime diagnostics, smoke checks, installer, and CLI land in
 * subsequent slices.
 */

type Dict = Record<string, any>;
type Env = Record<string, string | undefined>;

export const SCHEMA_VERSION = "agentera.setupDoctor.v1";
export const STATUSES = ["pass", "warn", "fail", "skip"] as const;

const REGISTRY = loadRegistry();
export const DOCTOR_RUNTIME_VIEWS: Record<string, Dict> = Object.fromEntries(
  REGISTRY.runtimeIds.map((runtime) => [runtime, REGISTRY.consumerView("doctor", runtime)]),
);
export const RUNTIMES: string[] = REGISTRY.runtimeIds;
export const WRITABLE_RUNTIMES = ["copilot", "codex"] as const;
export const RUNTIME_BINARIES: Record<string, string> = Object.fromEntries(
  RUNTIMES.map((runtime) => [runtime, DOCTOR_RUNTIME_VIEWS[runtime].host_detection.binary_names[0]]),
);

export const OPENCODE_SKILL_INSTALL_COMMAND =
  "npx skills add jgabor/agentera -g -a opencode --skill agentera -y";
export const OPENCODE_SKILL_NAMES = ["agentera"] as const;
export const OPENCODE_COMMAND_DESCRIPTIONS: Record<string, string> = {
  agentera: "Compound agent orchestration suite: 12 capabilities in one bundled skill",
};

export const CANONICAL_ENTRIES = SETUP_EVIDENCE;
export const HELPER_ENTRIES = ["scripts/validate_capability.py", "hooks/validate_artifact.py"] as const;
export const SMOKE_TIMEOUT_SECONDS = 30;
export const ENV_FALLBACKS = ["AGENTERA_HOME", "CLAUDE_PLUGIN_ROOT"] as const;
export const COPILOT_MARKER = "# agentera: AGENTERA_HOME (managed)";
export const INSTALLER_SCHEMA_VERSION = "agentera.setupInstaller.v1";
export const SUPPORT_PATH_RE = /(?<![\w/.$-])(?<path>references\/[A-Za-z0-9][A-Za-z0-9_./-]*)/;

// ── registry-view accessors (mirror the Python helpers) ─────────────

export function diagnosticCheckNames(runtime: string): string[] {
  return DOCTOR_RUNTIME_VIEWS[runtime].diagnostics.check_names as string[];
}
export function diagnosticMessages(runtime: string): string[] {
  return DOCTOR_RUNTIME_VIEWS[runtime].diagnostics.primary_messages as string[];
}
export function diagnosticStatusLabels(runtime: string): string[] {
  return DOCTOR_RUNTIME_VIEWS[runtime].diagnostics.status_labels as string[];
}
export function diagnosticGapLabels(runtime: string): string[] {
  return DOCTOR_RUNTIME_VIEWS[runtime].diagnostics.gap_labels as string[];
}
export function availabilityProbeLabel(runtime: string): string {
  return String(DOCTOR_RUNTIME_VIEWS[runtime].host_detection.availability_probe_label);
}

export const AVAILABILITY_CHECKS: Record<string, string> = Object.fromEntries(
  RUNTIMES.map((rt) => [rt, availabilityProbeLabel(rt)]),
);
export const PASS_STATUSES: Record<string, string> = Object.fromEntries(
  RUNTIMES.map((rt) => [rt, diagnosticStatusLabels(rt)[0]]),
);
export const WARN_STATUSES: Record<string, string> = Object.fromEntries(
  RUNTIMES.map((rt) => [rt, diagnosticStatusLabels(rt)[1]]),
);
export const FAIL_STATUSES: Record<string, string> = Object.fromEntries(
  RUNTIMES.map((rt) => [rt, diagnosticStatusLabels(rt)[2]]),
);
export const SKIP_STATUSES: Record<string, string> = Object.fromEntries(
  RUNTIMES.map((rt) => [rt, diagnosticStatusLabels(rt)[3]]),
);
export const USER_ENVIRONMENT_GAPS: Record<string, string> = Object.fromEntries(
  RUNTIMES.map((rt) => [rt, diagnosticGapLabels(rt)[1]]),
);
export const RUNTIME_CONFIG_GAPS: Record<string, string> = Object.fromEntries(
  RUNTIMES.map((rt) => [rt, diagnosticGapLabels(rt)[0]]),
);
export const INSTALLER_FIXABLE_GAPS: Record<string, [string, string]> = {
  copilot: [RUNTIME_CONFIG_GAPS.copilot, USER_ENVIRONMENT_GAPS.copilot],
  codex: [RUNTIME_CONFIG_GAPS.codex, USER_ENVIRONMENT_GAPS.codex],
};

// ── install-root classification ─────────────────────────────────────

export function verifyInstallRoot(root: string): string[] {
  const classification = classifyResolvedRoot(root, { source: "explicit" });
  if (classification.kind === "managed_fresh") return [];
  return SETUP_EVIDENCE.filter((entry) => !pathExists(path.join(root, entry)));
}

export function verifyHelperAccess(root: string): string[] {
  return HELPER_ENTRIES.filter((entry) => !isFile(path.join(root, entry)));
}

function moduleDir(): string {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

export function autoDetectInstallRoot(env: Env, start: string | null = null): string | null {
  for (const variable of ENV_FALLBACKS) {
    const value = env[variable];
    if (value) {
      const candidate = resolvePath(value);
      if (verifyInstallRoot(candidate).length === 0) return candidate;
    }
  }
  let current = resolvePath(start ?? moduleDir());
  for (;;) {
    if (verifyInstallRoot(current).length === 0) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function setupMissing(root: string): string[] {
  return SETUP_EVIDENCE.filter((entry) => !pathExists(path.join(root, entry)));
}

export function classifyInstallRoot(explicitRoot: string | null, env: Env): Dict {
  const source = explicitRoot !== null ? "argument" : "auto";
  const root = explicitRoot !== null ? resolvePath(expanduser(explicitRoot)) : autoDetectInstallRoot(env);
  if (root === null) {
    return {
      status: "fail",
      path: null,
      source,
      kind: null,
      gap: "user_environment",
      message:
        "could not resolve an Agentera install root; pass --install-root or set AGENTERA_HOME",
      missing: [...SETUP_EVIDENCE],
    };
  }

  const classification = classifyResolvedRoot(root, { source: explicitRoot !== null ? "explicit" : "default" });
  if (classification.kind !== "managed_fresh") {
    return {
      status: "fail",
      path: root,
      source,
      kind: null,
      gap: "bundle_packaging",
      message: "install root is missing canonical Agentera entries",
      missing: setupMissing(root),
    };
  }

  const helperMissing = verifyHelperAccess(root);
  const status = helperMissing.length === 0 ? "pass" : "fail";
  return {
    status,
    path: root,
    source,
    kind: pathExists(path.join(root, ".git")) ? "local-clone" : "installed-bundle",
    gap: status === "pass" ? null : "bundle_packaging",
    message:
      status === "pass"
        ? "install root is valid"
        : "install root is valid but shared helper scripts are missing",
    missing: helperMissing,
  };
}

// ── generic check / aggregation helpers ─────────────────────────────

export function mkCheck(
  name: string,
  status: string,
  message: string,
  opts: { source?: string | null; path?: string | null; gap?: string | null; details?: string[] | null } = {},
): Dict {
  return {
    name,
    status,
    message,
    source: opts.source ?? null,
    path: opts.path ?? null,
    gap: opts.gap ?? null,
    details: opts.details ?? [],
  };
}

export function aggregateStatus(checks: Dict[]): string {
  const statuses = checks.map((c) => c.status);
  if (statuses.length > 0 && statuses.every((s) => s === "skip")) return "skip";
  if (statuses.includes("fail")) return "fail";
  if (statuses.includes("warn")) return "warn";
  if (statuses.includes("pass")) return "pass";
  return "skip";
}

export function summarizeStatuses(items: Record<string, Dict> | Dict[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const status of STATUSES) counts[status] = 0;
  const values = Array.isArray(items) ? items : Object.values(items);
  for (const item of values) counts[item.status] += 1;
  return counts;
}

export function tail(text: string, limit = 5): string[] {
  const lines = text.split(/\r\n|\r|\n/).filter((line) => line.trim());
  return lines.slice(-limit);
}

// ===========================================================================
// Slice 2: runtime scaffolding, OpenCode diagnostics, reference validation
// ===========================================================================

import fs from "node:fs";

import { classifyResolvedRoot as _classifyResolvedRoot } from "../state/installRoot.js";

function rootClassification(root: string, source: string): Dict {
  return _classifyResolvedRoot(root, { source });
}

/** shutil.which: first PATH entry whose `${dir}/${cmd}` is an executable file. */
export function which(cmd: string, pathStr: string | undefined): string | null {
  const accessCheck = (fn: string): boolean => {
    try {
      const st = fs.statSync(fn);
      if (st.isDirectory()) return false;
      fs.accessSync(fn, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (cmd.includes("/")) {
    return accessCheck(cmd) ? cmd : null;
  }
  const entries = (pathStr ?? "").split(path.delimiter);
  const seen = new Set<string>();
  for (const dir of entries) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const fn = path.join(dir, cmd);
    if (accessCheck(fn)) return fn;
  }
  return null;
}

export function runtimeSkip(runtime: string, env: Env): Dict {
  const binary = RUNTIME_BINARIES[runtime];
  return {
    runtime,
    status: SKIP_STATUSES[runtime],
    available: false,
    binary: null,
    checks: [
      mkCheck(AVAILABILITY_CHECKS[runtime], SKIP_STATUSES[runtime], `${binary} executable not found on PATH`, {
        source: "PATH",
        gap: USER_ENVIRONMENT_GAPS[runtime],
        details: [env.PATH ?? ""],
      }),
    ],
  };
}

export function configuredRootCheck(
  runtime: string,
  name: string,
  candidate: string,
  installRoot: string,
  source: string,
): Dict {
  const classification = rootClassification(candidate, "environment");
  if (String(classification.kind).startsWith("missing_")) {
    return mkCheck(name, FAIL_STATUSES[runtime], "configured Agentera root does not exist", {
      source,
      path: candidate,
      gap: RUNTIME_CONFIG_GAPS[runtime],
    });
  }
  if (classification.kind !== "managed_fresh") {
    return mkCheck(name, FAIL_STATUSES[runtime], "configured Agentera root is not a valid suite bundle", {
      source,
      path: candidate,
      gap: "bundle_packaging",
      details: setupMissing(candidate),
    });
  }
  const helperMissing = verifyHelperAccess(candidate);
  if (helperMissing.length > 0) {
    return mkCheck(name, FAIL_STATUSES[runtime], "configured Agentera root cannot reach shared helper scripts", {
      source,
      path: candidate,
      gap: "bundle_packaging",
      details: helperMissing,
    });
  }
  if (resolvePath(candidate) !== resolvePath(installRoot)) {
    return mkCheck(name, WARN_STATUSES[runtime], "runtime points at a different valid Agentera install root", {
      source,
      path: candidate,
      gap: RUNTIME_CONFIG_GAPS[runtime],
    });
  }
  return mkCheck(name, PASS_STATUSES[runtime], HELPER_ACCESS_MESSAGE, { source, path: candidate });
}

export function binaryPath(runtime: string, env: Env): string | null {
  return which(RUNTIME_BINARIES[runtime], env.PATH);
}

export function runtimeHostPathProblem(runtime: string, env: Env): [string, string] | null {
  const binary = RUNTIME_BINARIES[runtime];
  for (const entry of (env.PATH ?? "").split(path.delimiter)) {
    if (!entry) continue;
    const candidate = path.join(entry, binary);
    try {
      if (fs.statSync(candidate).isDirectory()) {
        return [candidate, `${binary} PATH candidate is a directory, not an executable`];
      }
    } catch {
      /* not present */
    }
    if (pathExists(candidate)) {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
      } catch {
        return [candidate, `${binary} PATH candidate is not executable`];
      }
    }
  }
  return null;
}

export function runtimeResult(runtime: string, env: Env, checks: Dict[]): Dict {
  const binary = binaryPath(runtime, env);
  if (binary === null) return runtimeSkip(runtime, env);
  const binaryCheck = mkCheck(
    AVAILABILITY_CHECKS[runtime],
    PASS_STATUSES[runtime],
    `${RUNTIME_BINARIES[runtime]} executable found`,
    { source: "PATH", path: binary },
  );
  const allChecks = [binaryCheck, ...checks];
  return {
    runtime,
    status: aggregateStatus(allChecks),
    available: true,
    binary,
    checks: allChecks,
  };
}

// HELPER_ACCESS_MESSAGE mirrors COPILOT_HELPER_MESSAGE (registry-derived).
export const HELPER_ACCESS_MESSAGE = diagnosticMessages("copilot")[0];

// ── OpenCode diagnostics ────────────────────────────────────────────

const OPENCODE_PLUGIN_CHECK = diagnosticCheckNames("opencode")[0];
const OPENCODE_HOME_CHECK = diagnosticCheckNames("opencode")[1];
const OPENCODE_COMMANDS_CHECK = diagnosticCheckNames("opencode")[2];
const OPENCODE_SKILL_PATHS_CHECK = diagnosticCheckNames("opencode")[3];
const OPENCODE_SUPPORT_CHECK = diagnosticCheckNames("opencode")[4];
const OC_MSG = diagnosticMessages("opencode");
const OPENCODE_COMMANDS_CURRENT_MESSAGE = OC_MSG[4];
const OPENCODE_COMMANDS_DRIFT_MESSAGE = OC_MSG[5];
const OPENCODE_SKILL_PATHS_CURRENT_MESSAGE = OC_MSG[6];
const OPENCODE_SKILL_PATHS_DRIFT_MESSAGE = OC_MSG[7];
const OPENCODE_SUPPORT_REFERENCES_PASS_MESSAGE = OC_MSG[8];
const OPENCODE_SUPPORT_REFERENCES_DRIFT_MESSAGE = OC_MSG[9];
const OPENCODE_PASS_STATUS = diagnosticStatusLabels("opencode")[0];
const OPENCODE_WARN_STATUS = diagnosticStatusLabels("opencode")[1];
const OC_GAP = diagnosticGapLabels("opencode");
const OPENCODE_COMMAND_DRIFT_GAP = OC_GAP[2];
const OPENCODE_SKILL_PATH_DRIFT_GAP = OC_GAP[3];
const OPENCODE_VALIDATION_DRIFT_GAP = OC_GAP[4];

export function opencodeConfigDir(home: string, env: Env): string {
  const value = env.OPENCODE_CONFIG_DIR;
  return value ? resolvePath(expanduser(value)) : path.join(home, ".config", "opencode");
}

export function opencodeCommandTemplate(name: string): string {
  return (
    "---\n" +
    `description: "${OPENCODE_COMMAND_DESCRIPTIONS[name]}"\n` +
    "agentera_managed: true\n" +
    "---\n" +
    `Load and execute the ${name} skill for this project.\n`
  );
}

export function hasManagedMarker(text: string): boolean {
  const lines = text.split("\n");
  if (lines.length === 0 || lines[0] !== "---") return false;
  const closing = lines.indexOf("---", 1);
  if (closing === -1) return false;
  return lines.slice(1, closing).some((line) => line.trim() === "agentera_managed: true");
}

export function diagnoseOpencodeCommands(home: string, env: Env): Dict {
  const commandsDir = path.join(opencodeConfigDir(home, env), "commands");
  const missing: string[] = [];
  const stale: string[] = [];
  const userOwned: string[] = [];
  for (const name of OPENCODE_SKILL_NAMES) {
    const command = path.join(commandsDir, `${name}.md`);
    const expected = opencodeCommandTemplate(name);
    let actual: string;
    try {
      actual = fs.readFileSync(command, "utf8");
    } catch {
      missing.push(name);
      continue;
    }
    if (actual === expected) continue;
    if (hasManagedMarker(actual)) stale.push(name);
    else userOwned.push(name);
  }
  if (missing.length === 0 && stale.length === 0) {
    const details = userOwned.map((name) => `user-owned command preserved: ${name}`);
    return mkCheck(OPENCODE_COMMANDS_CHECK, OPENCODE_PASS_STATUS, OPENCODE_COMMANDS_CURRENT_MESSAGE, {
      path: commandsDir,
      details,
    });
  }
  const details = [...missing.map((n) => `missing: ${n}`), ...stale.map((n) => `stale: ${n}`)];
  if (userOwned.length > 0) details.push(...userOwned.map((n) => `user-owned command preserved: ${n}`));
  details.push("action: start OpenCode with the Agentera plugin to restore managed commands");
  return mkCheck(OPENCODE_COMMANDS_CHECK, OPENCODE_WARN_STATUS, OPENCODE_COMMANDS_DRIFT_MESSAGE, {
    path: commandsDir,
    gap: OPENCODE_COMMAND_DRIFT_GAP,
    details,
  });
}

function isAgenteraManagedSkillPath(target: string, name: string): boolean {
  let linkTarget: string;
  try {
    linkTarget = fs.readlinkSync(target);
  } catch {
    return false;
  }
  const normalized = linkTarget.toLowerCase();
  return normalized.includes("agentera") || path.basename(linkTarget) === name;
}

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

export function diagnoseOpencodeSkillPaths(installRoot: string, home: string, env: Env): Dict {
  const skillsDir = path.join(opencodeConfigDir(home, env), "skills");
  const missing: string[] = [];
  const broken: string[] = [];
  const userOwned: string[] = [];
  const missingSource: string[] = [];
  for (const name of OPENCODE_SKILL_NAMES) {
    const source = path.join(installRoot, "skills", name, "SKILL.md");
    const target = path.join(skillsDir, name);
    if (!isFile(source)) {
      missingSource.push(name);
      continue;
    }
    if (!pathExists(target) && !isSymlink(target)) {
      missing.push(name);
      continue;
    }
    if (isFile(path.join(target, "SKILL.md"))) continue;
    if (isAgenteraManagedSkillPath(target, name)) broken.push(name);
    else userOwned.push(name);
  }
  if (missing.length === 0 && broken.length === 0 && missingSource.length === 0) {
    const details = userOwned.map((name) => `user-owned skill path preserved: ${name}`);
    return mkCheck(OPENCODE_SKILL_PATHS_CHECK, OPENCODE_PASS_STATUS, OPENCODE_SKILL_PATHS_CURRENT_MESSAGE, {
      path: skillsDir,
      details,
    });
  }
  const details = [...missing.map((n) => `missing: ${n}`), ...broken.map((n) => `broken: ${n}`)];
  if (missingSource.length > 0) {
    details.push(...missingSource.map((n) => `missing install source: ${n}`));
    details.push(`action: ${OPENCODE_SKILL_INSTALL_COMMAND}`);
  } else {
    details.push("action: start OpenCode with the Agentera plugin to restore managed skill paths");
  }
  if (userOwned.length > 0) details.push(...userOwned.map((n) => `user-owned skill path preserved: ${n}`));
  return mkCheck(OPENCODE_SKILL_PATHS_CHECK, OPENCODE_WARN_STATUS, OPENCODE_SKILL_PATHS_DRIFT_MESSAGE, {
    path: skillsDir,
    gap: OPENCODE_SKILL_PATH_DRIFT_GAP,
    details,
  });
}

// ── bundled reference validation ────────────────────────────────────

function trimChars(s: string, chars: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && chars.includes(s[start])) start++;
  while (end > start && chars.includes(s[end - 1])) end--;
  return s.slice(start, end);
}

export function normalizeReference(raw: string): string | null {
  const candidate = trimChars(raw, "`'\"()[]{}.,:;");
  if (!candidate || path.isAbsolute(candidate) || candidate.includes("\\")) return null;
  const parts = candidate.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  return candidate;
}

export function extractReferencePaths(text: string): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  const re = /(?<![\w/.$-])(?<path>references\/[A-Za-z0-9][A-Za-z0-9_./-]*)/g;
  for (const match of text.matchAll(re)) {
    const ref = normalizeReference(match.groups!.path);
    if (ref !== null && !seen.has(ref)) {
      refs.push(ref);
      seen.add(ref);
    }
  }
  return refs;
}

function globSkillFiles(skillsDir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(skillsDir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const skillFile = path.join(skillsDir, entry, "SKILL.md");
    if (isFile(skillFile)) out.push(skillFile);
  }
  return out.sort();
}

export function diagnoseBundledReferenceValidation(installRoot: string): Dict {
  const skillsDir = path.join(installRoot, "skills");
  const missing: string[] = [];
  for (const skillFile of globSkillFiles(skillsDir)) {
    const text = fs.readFileSync(skillFile, "utf8");
    const parentName = path.basename(path.dirname(skillFile));
    for (const ref of extractReferencePaths(text)) {
      if (!pathExists(path.join(path.dirname(skillFile), ref))) {
        missing.push(`${parentName}: ${ref}`);
      }
    }
  }
  if (missing.length === 0) {
    return mkCheck(OPENCODE_SUPPORT_CHECK, OPENCODE_PASS_STATUS, OPENCODE_SUPPORT_REFERENCES_PASS_MESSAGE, {
      path: skillsDir,
    });
  }
  return mkCheck(OPENCODE_SUPPORT_CHECK, OPENCODE_WARN_STATUS, OPENCODE_SUPPORT_REFERENCES_DRIFT_MESSAGE, {
    path: skillsDir,
    gap: OPENCODE_VALIDATION_DRIFT_GAP,
    details: missing,
  });
}

export function smokeCheck(
  name: string,
  category: string,
  status: string,
  message: string,
  opts: { command?: string[] | null; path?: string | null; details?: string[] | null } = {},
): Dict {
  return {
    name,
    category,
    status,
    message,
    command: opts.command ?? [],
    path: opts.path ?? null,
    details: opts.details ?? [],
  };
}

// ===========================================================================
// Slice 3: per-runtime diagnostics
// ===========================================================================

// Claude
const CLAUDE_ROOT_CHECK = diagnosticCheckNames("claude")[0];
const CLAUDE_MISSING_ENV_MESSAGE = diagnosticMessages("claude")[1];
const CLAUDE_WARN_STATUS = diagnosticStatusLabels("claude")[1];
const CLAUDE_USER_ENVIRONMENT_GAP = diagnosticGapLabels("claude")[1];

// OpenCode (additional to slice 2)
const OPENCODE_PLUGIN_PRESENT_MESSAGE = OC_MSG[0];
const OPENCODE_PLUGIN_MISSING_MESSAGE = OC_MSG[1];
const OPENCODE_HOME_MISSING_MESSAGE = OC_MSG[3];
const OPENCODE_RUNTIME_CONFIG_GAP = OC_GAP[0];

// Copilot
const COPILOT_HOME_CHECK = diagnosticCheckNames("copilot")[0];
const CO_MSG = diagnosticMessages("copilot");
const COPILOT_MISSING_MESSAGE = CO_MSG[1];
const COPILOT_RC_CONFIGURED_MESSAGE = CO_MSG[2];
const COPILOT_PASS_STATUS = diagnosticStatusLabels("copilot")[0];
const COPILOT_WARN_STATUS = diagnosticStatusLabels("copilot")[1];
const COPILOT_RUNTIME_CONFIG_GAP = diagnosticGapLabels("copilot")[0];

// Codex
const CODEX_HOME_CHECK = diagnosticCheckNames("codex")[0];
const CODEX_CONFIG_ERROR_MESSAGE = diagnosticMessages("codex")[1];
const CODEX_WARN_STATUS = diagnosticStatusLabels("codex")[1];
const CODEX_FAIL_STATUS = diagnosticStatusLabels("codex")[2];
const CODEX_RUNTIME_CONFIG_GAP = diagnosticGapLabels("codex")[0];

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

export function diagnoseOpencode(installRoot: string, home: string, env: Env): Dict {
  const checks: Dict[] = [];
  const configDir = opencodeConfigDir(home, env);
  const plugin = path.join(configDir, "plugins", "agentera.js");
  if (isFile(plugin)) {
    checks.push(mkCheck(OPENCODE_PLUGIN_CHECK, OPENCODE_PASS_STATUS, OPENCODE_PLUGIN_PRESENT_MESSAGE, { path: plugin }));
  } else {
    checks.push(
      mkCheck(OPENCODE_PLUGIN_CHECK, OPENCODE_WARN_STATUS, OPENCODE_PLUGIN_MISSING_MESSAGE, {
        path: plugin,
        gap: OPENCODE_RUNTIME_CONFIG_GAP,
      }),
    );
  }

  if (env.AGENTERA_HOME) {
    const p = resolvePath(expanduser(env.AGENTERA_HOME));
    checks.push(configuredRootCheck("opencode", OPENCODE_HOME_CHECK, p, installRoot, "environment"));
  } else {
    const candidates: Array<[string, string]> = [
      ["default-install-root", path.join(home, ".agents", "agentera")],
      ["default-skill-root", path.join(home, ".agents", "skills", "agentera")],
    ];
    const existing = candidates.filter(([, p]) => pathExists(p));
    if (existing.length > 0) {
      const [source, p] = existing[0];
      checks.push(configuredRootCheck("opencode", OPENCODE_HOME_CHECK, resolvePath(p), installRoot, source));
    } else {
      checks.push(
        mkCheck(OPENCODE_HOME_CHECK, OPENCODE_WARN_STATUS, OPENCODE_HOME_MISSING_MESSAGE, {
          source: "environment/defaults",
          gap: OPENCODE_RUNTIME_CONFIG_GAP,
        }),
      );
    }
  }

  checks.push(diagnoseOpencodeCommands(home, env));
  checks.push(diagnoseOpencodeSkillPaths(installRoot, home, env));
  checks.push(diagnoseBundledReferenceValidation(installRoot));
  return runtimeResult("opencode", env, checks);
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
