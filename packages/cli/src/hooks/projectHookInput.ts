import { resolvePath } from "../core/paths.js";
import type { JsonObject } from "../core/jsonValue.js";

export type ProjectBoundHookName = "session-start" | "session-stop" | "cursor-session-start";

export interface ParsedProjectHookInput {
  raw: string;
  payload: JsonObject;
  projectRoot: string;
}

export function isProjectBoundHook(name: string): name is ProjectBoundHookName {
  return name === "session-start" || name === "session-stop" || name === "cursor-session-start";
}

export function parseProjectHookInput(
  name: ProjectBoundHookName,
  raw: string,
  fallback = process.cwd(),
): ParsedProjectHookInput {
  let payload: JsonObject = {};
  if (raw.trim()) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as JsonObject;
    } catch {
      payload = {};
    }
  }
  const roots = payload.workspace_roots;
  const candidate = name === "cursor-session-start"
    ? payload.cwd || (Array.isArray(roots) && roots.length > 0 ? roots[0] : fallback)
    : payload.cwd ?? fallback;
  const projectRoot = name === "cursor-session-start"
    ? resolvePath(String(candidate))
    : resolvePath(candidate as string);
  return { raw, payload, projectRoot };
}
