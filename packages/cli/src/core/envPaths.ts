import os from "node:os";
import path from "node:path";

import { expanduser } from "./paths.js";

export type Env = Record<string, string | undefined>;

/** v3 name wins; v2 name is the migration-window fallback only. */
export function resolveProfileDirOverride(env: Env): string | undefined {
  return env.AGENTERA_PROFILE_DIR ?? env.PROFILERA_PROFILE_DIR;
}

/** Expand XDG_DATA_HOME the same way installRoot.ts does. */
export function resolveXdgDataHome(env: Env, home: string = os.homedir()): string {
  const xdg = env.XDG_DATA_HOME;
  return xdg ? expanduser(xdg) : path.join(expanduser(home), ".local", "share");
}
