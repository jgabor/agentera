import fs from "node:fs";
import path from "node:path";

import { expanduser, isFile, pathExists, resolvePath } from "../../core/paths.js";
import {
  configuredRootCheck,
  mkCheck,
  runtimeResult,
  diagnosticCheckNames,
  diagnosticMessages,
  diagnosticStatusLabels,
  diagnosticGapLabels,
  OPENCODE_COMMAND_DESCRIPTIONS,
  OPENCODE_SKILL_INSTALL_COMMAND,
  OPENCODE_SKILL_NAMES,
} from "./core.js";

type Dict = Record<string, any>;
type Env = Record<string, string | undefined>;

const OPENCODE_PLUGIN_CHECK = diagnosticCheckNames("opencode")[0];
const OPENCODE_HOME_CHECK = diagnosticCheckNames("opencode")[1];
const OPENCODE_COMMANDS_CHECK = diagnosticCheckNames("opencode")[2];
const OPENCODE_SKILL_PATHS_CHECK = diagnosticCheckNames("opencode")[3];
const OPENCODE_SUPPORT_CHECK = diagnosticCheckNames("opencode")[4];
const OPENCODE_PROFILE_DIR_CHECK = diagnosticCheckNames("opencode")[5];
const OC_MSG = diagnosticMessages("opencode");
const OPENCODE_COMMANDS_CURRENT_MESSAGE = OC_MSG[4];
const OPENCODE_COMMANDS_DRIFT_MESSAGE = OC_MSG[5];
const OPENCODE_SKILL_PATHS_CURRENT_MESSAGE = OC_MSG[6];
const OPENCODE_SKILL_PATHS_DRIFT_MESSAGE = OC_MSG[7];
const OPENCODE_SUPPORT_REFERENCES_PASS_MESSAGE = OC_MSG[8];
const OPENCODE_SUPPORT_REFERENCES_DRIFT_MESSAGE = OC_MSG[9];
const OPENCODE_PROFILE_DIR_CURRENT_MESSAGE = OC_MSG[10];
const OPENCODE_PROFILE_DIR_DEPRECATED_MESSAGE = OC_MSG[11];
const OPENCODE_PASS_STATUS = diagnosticStatusLabels("opencode")[0];
const OPENCODE_WARN_STATUS = diagnosticStatusLabels("opencode")[1];
const OC_GAP = diagnosticGapLabels("opencode");
const OPENCODE_COMMAND_DRIFT_GAP = OC_GAP[2];
const OPENCODE_SKILL_PATH_DRIFT_GAP = OC_GAP[3];
const OPENCODE_VALIDATION_DRIFT_GAP = OC_GAP[4];
const OPENCODE_USER_ENVIRONMENT_GAP = OC_GAP[1];

export function opencodeConfigDir(home: string, env: Env): string {
  const explicit = env.OPENCODE_CONFIG_DIR;
  if (explicit) {
    return resolvePath(expanduser(explicit));
  }
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg) {
    return path.join(resolvePath(expanduser(xdg)), "opencode");
  }
  return path.join(home, ".config", "opencode");
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

const OPENCODE_PLUGIN_PRESENT_MESSAGE = OC_MSG[0];
const OPENCODE_PLUGIN_MISSING_MESSAGE = OC_MSG[1];
const OPENCODE_HOME_MISSING_MESSAGE = OC_MSG[3];
const OPENCODE_RUNTIME_CONFIG_GAP = OC_GAP[0];

export function diagnoseOpencodeProfileDir(installRoot: string, home: string, env: Env): Dict {
  if (env.PROFILERA_PROFILE_DIR) {
    return mkCheck(OPENCODE_PROFILE_DIR_CHECK, OPENCODE_WARN_STATUS, OPENCODE_PROFILE_DIR_DEPRECATED_MESSAGE, {
      gap: OPENCODE_USER_ENVIRONMENT_GAP,
    });
  }
  return mkCheck(OPENCODE_PROFILE_DIR_CHECK, OPENCODE_PASS_STATUS, OPENCODE_PROFILE_DIR_CURRENT_MESSAGE, {});
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
  checks.push(diagnoseOpencodeProfileDir(installRoot, home, env));
  return runtimeResult("opencode", env, checks);
}

