import path from "node:path";
import os from "node:os";

import { resolvePath, pathExists } from "../../core/paths.js";
import { classifyResolvedRoot } from "../../state/installRoot.js";
import { CANONICAL_ENTRIES } from "./constants.js";

type Env = Record<string, string | undefined>;
const ENV_FALLBACKS = ["AGENTERA_HOME", "CLAUDE_PLUGIN_ROOT"] as const;

export const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".codex", "config.toml");

export function defaultConfigPath(home: string = os.homedir()): string {
  return path.join(home, ".codex", "config.toml");
}

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
  return CANONICAL_ENTRIES.filter((entry) => !pathExists(path.join(root, entry)));
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
  let current = resolvePath(start === null ? process.cwd() : start);
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
    throw new InstallRootError(
      "could not auto-detect the Agentera directory. " +
        "Pass --install-root PATH where PATH contains " +
        `${CANONICAL_ENTRIES.join(", ")}.`,
    );
  }
  return detected;
}
