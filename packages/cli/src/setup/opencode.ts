import path from "node:path";

import { expanduser, resolvePath } from "../core/paths.js";

type Env = Record<string, string | undefined>;

/** Migration-only resolver for previously installed OpenCode resources. */
export function opencodeConfigDir(home: string, env: Env): string {
  const explicit = env.OPENCODE_CONFIG_DIR;
  if (explicit) return resolvePath(expanduser(explicit));
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg) return path.join(resolvePath(expanduser(xdg)), "opencode");
  return path.join(home, ".config", "opencode");
}

/** Migration-only ownership marker reader. */
export function hasManagedMarker(text: string): boolean {
  const lines = text.split("\n");
  if (lines[0] !== "---") return false;
  const closing = lines.indexOf("---", 1);
  return closing !== -1 && lines.slice(1, closing).some((line) => line.trim() === "agentera_managed: true");
}
