import path from "node:path";

import { resolvePath } from "../core/paths.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { classifyResolvedRoot } from "../state/installRoot.js";
import { buildDigest } from "./sessionStart.js";

/**
 * Cursor sessionStart hook: export AGENTERA_HOME and preload session context.
 * Faithful TS port of hooks/cursor_session_start.py.
 */

type Env = Record<string, string | undefined>;

export function pluginRootDefault(): string {
  return resolveSourceRoot();
}

export function resolveInstallRoot(
  cwd: string,
  opts: { env?: Env; pluginRoot?: string } = {},
): string | null {
  const env = opts.env ?? process.env;
  const pluginRoot = opts.pluginRoot ?? pluginRootDefault();

  const envRoot = env.AGENTERA_HOME;
  if (envRoot) {
    const candidate = resolvePath(envRoot);
    if (classifyResolvedRoot(candidate, { source: "env" }).kind === "managed_fresh") {
      return candidate;
    }
  }

  let current = resolvePath(cwd);
  for (;;) {
    if (classifyResolvedRoot(current, { source: "walk" }).kind === "managed_fresh") {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  if (classifyResolvedRoot(pluginRoot, { source: "plugin" }).kind === "managed_fresh") {
    return resolvePath(pluginRoot);
  }
  return null;
}

export interface CursorSessionStartOptions {
  env?: Env;
  out?: (text: string) => void;
  pluginRoot?: string;
}

export function runCursorSessionStart(rawStdin: string, opts: CursorSessionStartOptions = {}): number {
  const env = opts.env ?? process.env;
  const out = opts.out ?? ((text: string) => process.stdout.write(text + "\n"));
  let cwd: string = ".";
  if (rawStdin.trim()) {
    let hookInput: unknown = {};
    try {
      hookInput = JSON.parse(rawStdin);
    } catch {
      hookInput = {};
    }
    if (hookInput && typeof hookInput === "object" && !Array.isArray(hookInput)) {
      const hi = hookInput as Record<string, unknown>;
      const roots = hi.workspace_roots;
      cwd =
        (hi.cwd as string) ||
        (Array.isArray(roots) && roots.length > 0 ? String(roots[0]) : ".");
    }
  }

  const projectRoot = resolvePath(String(cwd));
  const installRoot = resolveInstallRoot(projectRoot, { env, pluginRoot: opts.pluginRoot });
  const payload: Record<string, unknown> = {};
  if (installRoot !== null) {
    payload.env = { AGENTERA_HOME: installRoot };
  }

  const digest = buildDigest(projectRoot, env);
  if (digest) {
    payload.additional_context = digest;
  }

  if (Object.keys(payload).length > 0) {
    out(JSON.stringify(payload));
  }
  return 0;
}
