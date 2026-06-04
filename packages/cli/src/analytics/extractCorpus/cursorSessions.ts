import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

import { expanduser, resolvePath } from "../../core/paths.js";
import {
  type Dict,
  type Env,
  MAX_TOOL_ARG_TEXT,
  eventTimestamp,
  isFilePath,
  isoFromMtime,
  iterJsonl,
  record,
  signalType,
  textFromContent,
  toolCallRecordFromItem,
} from "./core.js";
import { isPlainObject, rglob, isDir } from "./core.js";
import {
  type SqliteDb,
  openSqlite,
  jsonDict,
} from "./sqliteSessions.js";

function pathStem(p: string): string {
  const base = path.basename(p);
  const ext = path.extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

export function resolveOpencodeDbPath(env: Env = process.env): string | null {
  let out: string;
  try {
    out = execFileSync("opencode", ["db", "path"], { encoding: "utf-8", timeout: 2000 });
  } catch {
    return null;
  }
  const trimmed = out.trim();
  if (!trimmed) return null;
  const candidate = trimmed.split(/\r\n|\r|\n/)[0];
  return candidate ? expanduser(candidate) : null;
}

export function resolveCopilotStorePath(env: Env = process.env): string {
  return expanduser(env.COPILOT_HOME || path.join(os.homedir(), ".copilot"));
}
export function resolveCursorProjectsPath(env: Env = process.env): string {
  return path.join(expanduser(env.CURSOR_HOME || path.join(os.homedir(), ".cursor")), "projects");
}
export function resolveCursorChatsPath(env: Env = process.env): string {
  const configHome = env.CURSOR_CONFIG_HOME;
  if (configHome) return path.join(expanduser(configHome), "chats");
  return path.join(os.homedir(), ".config", "cursor", "chats");
}

// ── cursor helpers ──────────────────────────────────────────────────

function pathParents(p: string): string[] {
  const parents: string[] = [];
  let cur = p;
  for (;;) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    parents.push(parent);
    cur = parent;
  }
  return parents;
}

export function cursorWorkspaceHash(projectRoot: string): string {
  return crypto.createHash("md5").update(resolvePath(projectRoot), "utf-8").digest("hex");
}

export function cursorProjectDirSlug(projectRoot: string): string {
  const resolved = resolvePath(projectRoot);
  // Python Path.parts: ("/", "a", "b") for absolute; drop the leading "/" anchor.
  let segs = resolved.split(path.sep).filter((s) => s !== "");
  // (leading-"/" anchor already dropped by filtering empties)
  const slug = segs.join("-").toLowerCase();
  const cleaned = slug.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
  return cleaned || "global";
}

function cursorProjectPathFromDir(projectDir: string): string | null {
  const name = path.basename(projectDir);
  if (!name || /^\d+$/.test(name) || name === "empty-window") return null;
  const parts = name.split("-");
  if (parts.length > 1 && parts[0] === "home") return "/" + parts.join("/");
  return null;
}

function boundToolArguments(args: Dict): Dict {
  const bounded: Dict = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && value.length > MAX_TOOL_ARG_TEXT) {
      bounded[key] = value.slice(0, MAX_TOOL_ARG_TEXT) + "…";
    } else if (isPlainObject(value)) {
      bounded[key] = boundToolArguments(value);
    } else if (Array.isArray(value)) {
      bounded[key] = value.map((it) =>
        typeof it === "string" && it.length > MAX_TOOL_ARG_TEXT ? it.slice(0, MAX_TOOL_ARG_TEXT) + "…" : it,
      );
    } else {
      bounded[key] = value;
    }
  }
  return bounded;
}

function cursorContentItems(event: Dict): Dict[] {
  const message = event.message;
  if (!isPlainObject(message)) return [];
  const content = message.content;
  if (Array.isArray(content)) return content.filter((it) => isPlainObject(it));
  if (isPlainObject(content)) return [content];
  return [];
}

function iterCursorTranscriptPaths(projectsDir: string, projectRoots: string[]): string[] {
  if (!isDir(projectsDir)) return [];
  let searchDirs: string[];
  if (projectRoots.length > 0) {
    searchDirs = [];
    for (const root of projectRoots) {
      const candidate = path.join(projectsDir, cursorProjectDirSlug(root));
      if (isDir(candidate)) searchDirs.push(candidate);
    }
  } else {
    searchDirs = fs
      .readdirSync(projectsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(projectsDir, e.name));
  }
  const paths: string[] = [];
  for (const projectDir of searchDirs) {
    const transcriptsDir = path.join(projectDir, "agent-transcripts");
    if (!isDir(transcriptsDir)) continue;
    paths.push(...rglob(transcriptsDir, "*.jsonl"));
  }
  return paths;
}

export function extractCursorSessions(
  projectsDir: string | null,
  errors: string[],
  projectRoots: string[] | null = null,
): Dict[] {
  if (projectsDir === null || !fs.existsSync(projectsDir)) return [];
  const roots = projectRoots || [];
  const slugToRoot = new Map<string, string>();
  for (const root of roots) slugToRoot.set(cursorProjectDirSlug(root), root);
  const records: Dict[] = [];
  for (const p of iterCursorTranscriptPaths(projectsDir, roots)) {
    const fallbackTimestamp = isoFromMtime(p);
    const sessionId = path.basename(path.dirname(p)) || pathStem(p);
    const parents = pathParents(p);
    const projectDir = parents.length > 2 ? parents[2] : null;
    let projectPath: string | null = null;
    if (projectDir) {
      projectPath = slugToRoot.get(path.basename(projectDir)) || cursorProjectPathFromDir(projectDir);
    }
    let previousAssistant = "";
    let index = 0;
    for (const event of iterJsonl(p, errors)) {
      index += 1;
      const role = event.role;
      if (role !== "user" && role !== "assistant") continue;
      let contentIndex = 0;
      for (const item of cursorContentItems(event)) {
        contentIndex += 1;
        const tr = toolCallRecordFromItem({
          item,
          event,
          fallbackTimestamp,
          projectPath,
          runtime: "cursor",
          sourcePath: p,
          index: index * 1000 + contentIndex,
          sessionId,
        });
        if (tr !== null) {
          if (isPlainObject(tr.data) && isPlainObject(tr.data.arguments)) {
            tr.data.arguments = boundToolArguments(tr.data.arguments);
          }
          records.push(tr);
        }
      }
      const items = cursorContentItems(event);
      const content = textFromContent(items.length > 0 ? items : event.message);
      if (!content) continue;
      const timestamp = eventTimestamp(event, fallbackTimestamp);
      const data: Dict = { actor: role, content };
      if (role === "user") {
        if (previousAssistant) data.preceding_context = previousAssistant.slice(-2000);
        const sig = signalType(content);
        if (sig) data.signal_type = sig;
      } else {
        previousAssistant = content;
      }
      records.push(
        record({
          sourceKind: "conversation_turn",
          timestamp,
          projectPath,
          runtime: "cursor",
          sourceParts: [resolvePath(p), index, role, content.slice(0, 80)],
          sessionId,
          data,
        }),
      );
      if (role === "user") {
        const sig = signalType(content);
        if (sig) {
          records.push(
            record({
              sourceKind: "history_prompt",
              timestamp,
              projectPath,
              runtime: "cursor",
              sourceParts: [resolvePath(p), index, "history", content.slice(0, 120)],
              sessionId,
              data: { prompt: content, signal_type: sig },
            }),
          );
        }
      }
    }
  }
  return records;
}

function cursorJsonlSessionIds(projectsDir: string | null, projectRoots: string[]): Set<string> {
  if (projectsDir === null) return new Set();
  const ids = new Set<string>();
  for (const p of iterCursorTranscriptPaths(projectsDir, projectRoots)) {
    ids.add(path.basename(path.dirname(p)) || pathStem(p));
  }
  return ids;
}

function cursorAgentMessageText(message: Dict): string {
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (!isPlainObject(item)) continue;
      if (item.type === "text") {
        const text = item.text;
        if (typeof text === "string" && text.trim()) parts.push(text.trim());
      }
    }
    return parts.join("\n");
  }
  return textFromContent(content);
}

function cursorAgentToolItems(message: Dict): Dict[] {
  const items: Dict[] = [];
  const content = message.content;
  if (!Array.isArray(content)) return items;
  for (const item of content) {
    if (!isPlainObject(item)) continue;
    if (item.type !== "tool-call") continue;
    const toolName = item.toolName || item.tool_name || item.name;
    if (typeof toolName !== "string" || !toolName) continue;
    const args = item.args || item.arguments || item.input || {};
    items.push({ type: "tool_use", name: toolName, input: isPlainObject(args) ? args : { value: args } });
  }
  return items;
}

function iterCursorAgentStorePaths(
  chatsDir: string,
  projectRoots: string[],
  jsonlSessionIds: Set<string>,
): Array<[string, string | null, string]> {
  if (!isDir(chatsDir)) return [];
  const workspaceDirs: Array<[string, string | null]> = [];
  if (projectRoots.length > 0) {
    for (const root of projectRoots) {
      const workspace = path.join(chatsDir, cursorWorkspaceHash(root));
      if (isDir(workspace)) workspaceDirs.push([workspace, resolvePath(root)]);
    }
  } else {
    for (const name of fs.readdirSync(chatsDir).sort()) {
      const workspace = path.join(chatsDir, name);
      if (isDir(workspace)) workspaceDirs.push([workspace, null]);
    }
  }
  const items: Array<[string, string | null, string]> = [];
  for (const [workspace, projectPath] of workspaceDirs) {
    for (const name of fs.readdirSync(workspace).sort()) {
      const sessionDir = path.join(workspace, name);
      if (!isDir(sessionDir)) continue;
      const sessionId = name;
      if (jsonlSessionIds.has(sessionId)) continue;
      const storeDb = path.join(sessionDir, "store.db");
      if (isFilePath(storeDb)) items.push([storeDb, projectPath, sessionId]);
    }
  }
  return items;
}

function cursorAgentBlobMessages(storeDb: string, errors: string[]): Array<[string, Dict]> {
  const messages: Array<[string, Dict]> = [];
  let conn: SqliteDb | null = null;
  let rows: Dict[];
  try {
    conn = openSqlite(storeDb);
  } catch (exc) {
    errors.push(`${storeDb}: cursor-agent sqlite open failed: ${(exc as Error).name || "Error"}`);
    return messages;
  }
  try {
    rows = conn.prepare("SELECT id, data FROM blobs ORDER BY id").all();
  } catch (exc) {
    errors.push(`${storeDb}: cursor-agent sqlite read failed: ${(exc as Error).name || "Error"}`);
    conn.close();
    return messages;
  }
  conn.close();
  for (const row of rows) {
    const blobId = row.id;
    const payload = row.data;
    let raw: Buffer;
    if (payload instanceof Uint8Array) raw = Buffer.from(payload);
    else if (typeof payload === "string") raw = Buffer.from(payload, "utf-8");
    else {
      errors.push(`${storeDb}: cursor-agent blob payload not bytes: ${blobId}`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf-8"));
    } catch {
      errors.push(`${storeDb}: cursor-agent blob not json: ${blobId}`);
      continue;
    }
    if (isPlainObject(parsed)) messages.push([String(blobId), parsed]);
  }
  return messages;
}

export function extractCursorAgentSessions(
  chatsDir: string | null,
  errors: string[],
  projectRoots: string[] | null = null,
  cursorProjectsDir: string | null = null,
): Dict[] {
  if (chatsDir === null || !fs.existsSync(chatsDir)) return [];
  const roots = projectRoots || [];
  const jsonlSessionIds = cursorJsonlSessionIds(cursorProjectsDir, roots);
  const records: Dict[] = [];
  for (const [storeDb, projectPath, sessionId] of iterCursorAgentStorePaths(chatsDir, roots, jsonlSessionIds)) {
    const fallbackTimestamp = isoFromMtime(storeDb);
    let previousAssistant = "";
    let index = 0;
    for (const [blobId, message] of cursorAgentBlobMessages(storeDb, errors)) {
      index += 1;
      const role = message.role;
      let toolIndex = 0;
      for (const toolItem of cursorAgentToolItems(message)) {
        toolIndex += 1;
        const tr = toolCallRecordFromItem({
          item: toolItem,
          event: message,
          fallbackTimestamp,
          projectPath,
          runtime: "cursor-agent",
          sourcePath: storeDb,
          index: index * 1000 + toolIndex,
          sessionId,
        });
        if (tr !== null) {
          if (isPlainObject(tr.data) && isPlainObject(tr.data.arguments)) {
            tr.data.arguments = boundToolArguments(tr.data.arguments);
          }
          records.push(tr);
        }
      }
      if (role !== "user" && role !== "assistant") continue;
      const content = cursorAgentMessageText(message);
      if (!content) continue;
      const timestamp = eventTimestamp(message, fallbackTimestamp);
      const data: Dict = { actor: role, content };
      if (role === "user") {
        if (previousAssistant) data.preceding_context = previousAssistant.slice(-2000);
        const sig = signalType(content);
        if (sig) data.signal_type = sig;
      } else {
        previousAssistant = content;
      }
      records.push(
        record({
          sourceKind: "conversation_turn",
          timestamp,
          projectPath,
          runtime: "cursor-agent",
          sourceParts: [resolvePath(storeDb), blobId, role, content.slice(0, 80)],
          sessionId,
          data,
        }),
      );
      if (role === "user") {
        const sig = signalType(content);
        if (sig) {
          records.push(
            record({
              sourceKind: "history_prompt",
              timestamp,
              projectPath,
              runtime: "cursor-agent",
              sourceParts: [resolvePath(storeDb), blobId, "history", content.slice(0, 120)],
              sessionId,
              data: { prompt: content, signal_type: sig },
            }),
          );
        }
      }
    }
  }
  return records;
}
