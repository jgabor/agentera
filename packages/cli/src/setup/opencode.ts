import path from "node:path";

import { expanduser, resolvePath } from "../core/paths.js";
import { parseYaml } from "../core/yaml.js";

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
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return false;
  try {
    const frontmatter = parseYaml(match[1]);
    return typeof frontmatter === "object" && frontmatter !== null
      && (frontmatter as Record<string, unknown>).agentera_managed === true;
  } catch { return false; }
}
