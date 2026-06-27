import os from "node:os";
import path from "node:path";

import { expanduser } from "./paths.js";

export type Env = Record<string, string | undefined>;

/** Canonical profile-dir env var (v3). Matches artifact-registry-interface-model.yaml profile.path_template.env_precedence[0]. */
export const AGENTERA_PROFILE_DIR_ENV = "AGENTERA_PROFILE_DIR";
/** Deprecated v2 alias. Matches artifact-registry-interface-model.yaml profile.path_template.env_precedence[1]. */
export const PROFILERA_PROFILE_DIR_ENV = "PROFILERA_PROFILE_DIR";

/** v3 name wins; v2 name is the migration-window fallback only. */
export function resolveProfileDirOverride(env: Env): string | undefined {
  return env[AGENTERA_PROFILE_DIR_ENV] ?? env[PROFILERA_PROFILE_DIR_ENV];
}

/** True when source text references the legacy name without the canonical v3 name (unmigrated schema literal). */
export function pluginSourceHasUnmigratedProfileDirSchema(text: string): boolean {
  return text.includes(PROFILERA_PROFILE_DIR_ENV) && !text.includes(AGENTERA_PROFILE_DIR_ENV);
}

/** Expand XDG_DATA_HOME the same way installRoot.ts does. */
export function resolveXdgDataHome(env: Env, home: string = os.homedir()): string {
  const xdg = env.XDG_DATA_HOME;
  return xdg ? expanduser(xdg) : path.join(expanduser(home), ".local", "share");
}
