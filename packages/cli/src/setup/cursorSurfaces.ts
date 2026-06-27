import fs from "node:fs";
import path from "node:path";

import { expanduser, isFile, pathExists, resolvePath } from "../core/paths.js";

type Env = Record<string, string | undefined>;

export const CURSOR_MANAGED_AGENT = "agentera.md";

export function resolveCursorProject(env: Env = process.env): string {
  const explicit = env.AGENTERA_PROJECT;
  return resolvePath(expanduser(explicit ?? process.cwd()));
}

export function cursorHooksCandidates(project: string, home: string): string[] {
  return [
    path.join(project, ".cursor", "hooks.json"),
    path.join(home, ".cursor", "hooks.json"),
  ];
}

export function cursorAgentsCandidates(project: string, home: string): string[] {
  return [
    path.join(project, ".cursor", "agents"),
    path.join(home, ".cursor", "agents"),
  ];
}

export function findExistingCursorHooks(project: string, home: string): string | null {
  for (const candidate of cursorHooksCandidates(project, home)) {
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/** Human-readable probe locations for doctor failure messages. */
export function formatCursorProbePaths(project: string, home: string, leaf: string): string {
  const projectLabel = path.join(project, ".cursor", leaf);
  const userLabel = path.join(home, ".cursor", leaf);
  return `${projectLabel} and ${userLabel}`;
}

export function hasAgenteraHookReferences(text: string): boolean {
  const v2 =
    text.includes("cursor_session_start.py") && text.includes("cursor_pre_tool_use.py");
  const v3 =
    text.includes("hook cursor-session-start") && text.includes("hook cursor-pre-tool-use");
  return v2 || v3;
}

function globCursorAgentMdFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.endsWith(".md") && isFile(path.join(dir, entry))).sort();
}

export function findCursorAgentsSurface(
  project: string,
  home: string,
): { dir: string | null; managed: string[]; hasManagedAgent: boolean } {
  for (const dir of cursorAgentsCandidates(project, home)) {
    if (!pathExists(dir)) continue;
    const managed = globCursorAgentMdFiles(dir);
    const hasManagedAgent = isFile(path.join(dir, CURSOR_MANAGED_AGENT));
    if (hasManagedAgent || managed.length > 0) {
      return { dir, managed, hasManagedAgent };
    }
  }
  return { dir: null, managed: [], hasManagedAgent: false };
}

export const V3_CURSOR_HOOKS_FIXTURE = JSON.stringify({
  hooks: {
    sessionStart: [{ command: "npx -y agentera@next hook cursor-session-start" }],
    preToolUse: [{ command: "npx -y agentera@next hook cursor-pre-tool-use", matcher: "Write|Edit" }],
  },
});
