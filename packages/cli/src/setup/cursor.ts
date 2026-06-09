import fs from "node:fs";
import path from "node:path";

import { isFile, pathExists, resolvePath } from "../core/paths.js";
import { SETUP_EVIDENCE, classifyResolvedRoot } from "../state/installRoot.js";

/**
 * Diagnose Cursor AGENTERA_HOME setup without editing shell startup files.
 * Faithful TS port of scripts/setup_cursor.py. env is injectable for testing.
 */

type Env = Record<string, string | undefined>;

export const MANAGED_KEY = "AGENTERA_HOME";
export const MARKER_COMMENT = `# agentera: ${MANAGED_KEY} (managed)`;
const ENV_FALLBACKS = ["AGENTERA_HOME", "CLAUDE_PLUGIN_ROOT"] as const;

export class InstallRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallRootError";
  }
}

export function verifyInstallRoot(root: string): string[] {
  const classification = classifyResolvedRoot(root, { source: "explicit" });
  if (classification.kind === "managed_fresh") {
    return [];
  }
  return SETUP_EVIDENCE.filter((entry) => !pathExists(path.join(root, entry)));
}

export function autoDetectInstallRoot(start: string | null = null, env: Env = process.env): string | null {
  for (const variable of ENV_FALLBACKS) {
    const candidate = env[variable];
    if (candidate) {
      const p = resolvePath(candidate);
      if (verifyInstallRoot(p).length === 0) {
        return p;
      }
    }
  }
  const startDir = start === null ? process.cwd() : start;
  let current = resolvePath(startDir);
  for (;;) {
    if (verifyInstallRoot(current).length === 0) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function resolveInstallRoot(explicit: string | null, env: Env = process.env): string {
  if (explicit !== null && explicit !== undefined) {
    const root = resolvePath(explicit);
    if (classifyResolvedRoot(root, { source: "explicit" }).kind !== "managed_fresh") {
      const missing = verifyInstallRoot(root);
      throw new InstallRootError(
        `--install-root ${root} is not a valid Agentera directory: ` +
          `missing canonical entries: ${missing.join(", ")}`,
      );
    }
    return root;
  }
  const detected = autoDetectInstallRoot(null, env);
  if (detected === null) {
    throw new InstallRootError("could not auto-detect the Agentera directory; pass --install-root PATH");
  }
  return detected;
}

function rcPaths(home: string): string[] {
  return [
    path.join(home, ".bashrc"),
    path.join(home, ".zshrc"),
    path.join(home, ".config", "fish", "config.fish"),
  ];
}

function findMarker(text: string): string | null {
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line.trim() === MARKER_COMMENT) {
      return line;
    }
  }
  return null;
}

export interface DoctorCheck {
  name: string;
  status: string;
  message: string;
}

export interface CursorReport {
  runtime: string;
  status: string;
  install_root: string;
  checks: DoctorCheck[];
  guidance: string;
}

export function diagnose(installRoot: string, home: string, env: Env = process.env): CursorReport {
  const checks: DoctorCheck[] = [];
  const envValue = env[MANAGED_KEY];
  if (envValue) {
    checks.push({
      name: MANAGED_KEY,
      status: resolvePath(envValue) === resolvePath(installRoot) ? "pass" : "warn",
      message: `${MANAGED_KEY}=${envValue}`,
    });
  } else {
    checks.push({
      name: MANAGED_KEY,
      status: "warn",
      message:
        `${MANAGED_KEY} is unset in this process; Cursor sessionStart hook ` +
        "should export it for IDE sessions",
    });
  }

  const hooksPath = path.join(installRoot, ".cursor", "hooks.json");
  if (isFile(hooksPath)) {
    checks.push({ name: "cursor.hooks", status: "pass", message: hooksPath });
  } else {
    checks.push({
      name: "cursor.hooks",
      status: "fail",
      message: "missing repo-native .cursor/hooks.json",
    });
  }

  for (const rc of rcPaths(home)) {
    if (!isFile(rc)) {
      continue;
    }
    const text = fs.readFileSync(rc, "utf8");
    if (findMarker(text)) {
      checks.push({
        name: `rc.${path.basename(rc)}`,
        status: "warn",
        message: `legacy managed ${MANAGED_KEY} marker found in ${rc}; Agentera will not edit it automatically`,
      });
    }
  }

  const overall = checks.some((item) => item.status === "fail") ? "fail" : "pass";
  return {
    runtime: "cursor",
    status: overall,
    install_root: installRoot,
    checks,
    guidance:
      "Prefer Cursor sessionStart env export. Use per-invocation " +
      `export ${MANAGED_KEY}=${installRoot} for cursor-agent when shell smoke fails.`,
  };
}
