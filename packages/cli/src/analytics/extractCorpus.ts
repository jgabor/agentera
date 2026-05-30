/**
 * Section 22 corpus extractor — faithful TypeScript port of
 * scripts/extract_corpus.py (git 1389867~1).
 *
 * Reads local AI runtime history (JSONL files + SQLite stores via node:sqlite)
 * across Codex / Claude Code / Cursor / Cursor-agent / OpenCode / GitHub Copilot,
 * plus instruction documents and project config signals, and emits the
 * corpus.json envelope that profilera synthesizes PROFILE.md from and that
 * `report`/`stats` analytics read.
 *
 * SQLite uses Node's built-in node:sqlite (DatabaseSync), imported lazily so the
 * one experimental warning only appears when a SQLite store is actually read.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

type Dict = Record<string, any>;
type Env = Record<string, string | undefined>;

export const ADAPTER_VERSION = "agentera-v2-corpus-1";
export const FAMILIES = [
  "instruction_document",
  "history_prompt",
  "conversation_turn",
  "tool_call",
  "project_config_signal",
] as const;

export const RUNTIME_STORE_GLOBS: Record<string, string> = {
  codex: "*.jsonl",
  "claude-code": "*.jsonl",
  cursor: "*.jsonl",
  "cursor-agent": "store.db",
  opencode: "opencode.db",
  "github-copilot": "session-store.db",
};
const MAX_TOOL_ARG_TEXT = 500;
const MAX_SQLITE_ROWS = 100_000;
const MAX_SQLITE_SESSIONS = 60;
const COPILOT_SPARSE_REMEDIATION = "/chronicle reindex";

const DECISION_RE =
  /\b(decide|decision|prefer|preference|instead|avoid|don't|do not|should|trade[- ]?off|scope|plan|commit|review|fix|why|question|blocked|stuck|approve|reject|change|keep|remove)\b/i;
const CORRECTION_RE =
  /\b(no|not quite|actually|rather|instead|wrong|correction|that's not|that is not|don't|do not)\b/i;
const QUESTION_RE = /\?|^\s*(why|what|how|should|can|could|would)\b/i;

// ── core helpers ───────────────────────────────────────────────────

export function isoNow(): string {
  // Python datetime.now(utc).isoformat() -> microseconds + "+00:00" -> "Z".
  // JS gives milliseconds; corpus extracted_at is a wall-clock stamp, not a
  // parity-critical record value.
  return new Date().toISOString().replace(/Z$/, "Z");
}

export function isoFromMtime(p: string): string {
  const ms = fs.statSync(p).mtimeMs;
  return new Date(ms).toISOString().replace(/Z$/, "Z");
}

export function stableId(...parts: unknown[]): string {
  const raw = parts.map((p) => pyStr(p)).join("\0");
  return crypto.createHash("sha256").update(raw, "utf-8").digest("hex").slice(0, 24);
}

/** Python str() for the scalar/None values stable_id receives. */
function pyStr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return String(value);
}

export function projectIdFromPath(p: string | null): string {
  if (p === null) return "global";
  const name = path.basename(p) || p;
  const slug = name
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .toLowerCase();
  return slug || "global";
}

export function defaultAgenteraHome(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  const override = env.AGENTERA_HOME;
  if (override) return override;
  if (platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "agentera");
  if (platform === "win32") {
    const appdata = env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appdata, "agentera");
  }
  const xdg = env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(xdg, "agentera");
}

export function defaultProfileDir(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  const override = env.PROFILERA_PROFILE_DIR;
  if (override) return override;
  return defaultAgenteraHome(env, platform);
}

export function defaultOutputPath(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  return path.join(defaultProfileDir(env, platform), "intermediate", "corpus.json");
}

export interface RuntimeStatusOpts {
  status: string;
  reason: string;
  storePath: string | null;
  candidateCount?: number | null;
  recordCount?: number | null;
  errorCount?: number | null;
  remediationLabels?: string[] | null;
}

export function runtimeStatus(runtime: string, opts: RuntimeStatusOpts): Dict {
  const item: Dict = { runtime, status: opts.status, reason: opts.reason };
  if (opts.storePath !== null && opts.storePath !== undefined) item.store_path = opts.storePath;
  if (opts.candidateCount !== null && opts.candidateCount !== undefined) item.candidate_count = opts.candidateCount;
  if (opts.recordCount !== null && opts.recordCount !== undefined) item.record_count = opts.recordCount;
  if (opts.errorCount !== null && opts.errorCount !== undefined) item.error_count = opts.errorCount;
  if (opts.remediationLabels && opts.remediationLabels.length > 0) item.remediation_labels = opts.remediationLabels;
  return item;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function isFilePath(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Recursive glob for a simple pattern ("*.jsonl" or an exact filename). */
function rglob(root: string, pattern: string): string[] {
  const out: string[] = [];
  const matchesExt = pattern.startsWith("*.") ? pattern.slice(1) : null; // ".jsonl"
  const exact = matchesExt ? null : pattern;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        if (matchesExt ? e.name.endsWith(matchesExt) : e.name === exact) out.push(full);
      }
    }
  };
  walk(root);
  return out.sort();
}

export function discoverRuntimeStore(runtime: string, storePath: string | null): Dict {
  if (storePath === null) {
    return runtimeStatus(runtime, { status: "skipped", reason: "disabled", storePath: null });
  }
  if (!fs.existsSync(storePath)) {
    return runtimeStatus(runtime, {
      status: "missing",
      reason: "store_absent",
      storePath,
      remediationLabels: runtime === "github-copilot" ? [COPILOT_SPARSE_REMEDIATION] : null,
    });
  }
  if ((runtime === "opencode" || runtime === "github-copilot") && isFilePath(storePath)) {
    return runtimeStatus(runtime, {
      status: "available",
      reason: "candidate_files_found",
      storePath,
      candidateCount: 1,
    });
  }
  if (!isDir(storePath)) {
    return runtimeStatus(runtime, { status: "degraded", reason: "store_not_directory", storePath });
  }
  let candidates: string[];
  try {
    candidates = rglob(storePath, RUNTIME_STORE_GLOBS[runtime]);
  } catch {
    return runtimeStatus(runtime, { status: "degraded", reason: "store_unreadable", storePath });
  }
  if (candidates.length === 0) {
    return runtimeStatus(runtime, {
      status: "sparse",
      reason: "no_candidate_files",
      storePath,
      candidateCount: 0,
      remediationLabels: runtime === "github-copilot" ? [COPILOT_SPARSE_REMEDIATION] : null,
    });
  }
  return runtimeStatus(runtime, {
    status: "available",
    reason: "candidate_files_found",
    storePath,
    candidateCount: candidates.length,
  });
}

// ── record builders + content helpers ──────────────────────────────

import { resolvePath } from "../core/paths.js";

function splitLines(text: string): string[] {
  const parts = text.split(/\r\n|\r|\n/);
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

export interface RecordOpts {
  sourceKind: string;
  timestamp: string;
  projectPath: string | null;
  runtime: string;
  data: Dict;
  sourceParts: unknown[];
  sessionId?: string | null;
}

export function record(opts: RecordOpts): Dict {
  const item: Dict = {
    source_id: stableId(opts.sourceKind, ...opts.sourceParts),
    timestamp: opts.timestamp,
    project_id: projectIdFromPath(opts.projectPath),
    source_kind: opts.sourceKind,
    runtime: opts.runtime,
    adapter_version: ADAPTER_VERSION,
    data: opts.data,
  };
  if (opts.projectPath !== null && opts.projectPath !== undefined) item.project_path = opts.projectPath;
  if (opts.sessionId) {
    item.session_id = opts.sessionId;
    item.conversation_key = opts.sessionId;
  }
  return item;
}

function isPlainObject(v: unknown): v is Dict {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function payloadItem(event: Dict): Dict {
  const payload = event.payload;
  if (isPlainObject(payload)) {
    const nested = payload.item;
    if (isPlainObject(nested)) return nested;
    return payload;
  }
  return event;
}

export function eventKind(event: Dict): string {
  for (const key of ["type", "event", "name"]) {
    const value = event[key];
    if (typeof value === "string") return value;
  }
  return "";
}

export function eventTimestamp(item: Dict, fallback: string): string {
  const payload = isPlainObject(item.payload) ? item.payload : {};
  const nested = isPlainObject(payload.item) ? payload.item : {};
  for (const source of [item, payload, nested]) {
    for (const key of ["timestamp", "created_at", "createdAt", "time"]) {
      const value = (source as Dict)[key];
      if (typeof value === "string" && value) return value;
      if (typeof value === "number") {
        return new Date(value * 1000).toISOString();
      }
    }
  }
  return fallback;
}

export function textFromContent(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value.map((it) => textFromContent(it));
    return parts.filter((p) => p).join("\n");
  }
  if (isPlainObject(value)) {
    for (const key of ["text", "input_text", "output_text", "message", "content"]) {
      const text = textFromContent(value[key]);
      if (text) return text;
    }
    return "";
  }
  return pyStr(value);
}

export function claudeContentItems(event: Dict): Dict[] {
  const items: Dict[] = [];
  const msg = isPlainObject(event.message) ? event.message : null;
  for (const source of [event, msg]) {
    if (!isPlainObject(source)) continue;
    const content = source.content;
    if (Array.isArray(content)) {
      for (const it of content) if (isPlainObject(it)) items.push(it);
    } else if (isPlainObject(content)) {
      items.push(content);
    }
  }
  return items;
}

export function* iterJsonl(p: string, errors: string[]): Generator<Dict> {
  let text: string;
  try {
    text = fs.readFileSync(p, "utf-8");
  } catch (exc) {
    errors.push(`${p}: cannot read: ${(exc as Error).message}`);
    return;
  }
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim();
    if (!stripped) continue;
    let item: unknown;
    try {
      item = JSON.parse(stripped);
    } catch (exc) {
      errors.push(`${p}:${i + 1}: invalid jsonl: ${(exc as Error).message}`);
      continue;
    }
    if (isPlainObject(item)) yield item;
  }
}

export function signalType(text: string): string | null {
  if (!text || !DECISION_RE.test(text)) return null;
  if (CORRECTION_RE.test(text)) return "correction";
  if (QUESTION_RE.test(text)) return "question";
  return "decision";
}

function toolCallRecordFromItem(args: {
  item: Dict;
  event: Dict;
  fallbackTimestamp: string;
  projectPath: string | null;
  runtime: string;
  sourcePath: string;
  index: number;
  sessionId: string;
}): Dict | null {
  const { item, event } = args;
  const kind = eventKind(event);
  const itemType = item.type;
  if (
    !["tool_call", "function_call"].includes(kind) &&
    !["tool_call", "function_call", "tool_use"].includes(itemType as string)
  ) {
    return null;
  }
  const toolName = item.tool_name || item.name || item.tool;
  if (typeof toolName !== "string" || !toolName) return null;
  let argumentsVal: unknown = item.arguments || item.input || item.args || {};
  if (typeof argumentsVal === "string") {
    try {
      argumentsVal = JSON.parse(argumentsVal);
    } catch {
      argumentsVal = { raw: argumentsVal };
    }
  }
  if (!isPlainObject(argumentsVal)) argumentsVal = { value: argumentsVal };
  return record({
    sourceKind: "tool_call",
    timestamp: eventTimestamp(event, args.fallbackTimestamp),
    projectPath: args.projectPath,
    runtime: args.runtime,
    sourceParts: [resolvePath(args.sourcePath), args.index, "tool", toolName],
    sessionId: args.sessionId,
    data: { tool_name: toolName, arguments: argumentsVal },
  });
}

function toolCallRecord(args: {
  event: Dict;
  fallbackTimestamp: string;
  projectPath: string | null;
  runtime: string;
  sourcePath: string;
  index: number;
  sessionId: string;
}): Dict | null {
  return toolCallRecordFromItem({ ...args, item: payloadItem(args.event) });
}

// ── instruction documents + project config signals ─────────────────

export function extractInstructionDocuments(projectRoots: string[], errors: string[]): Dict[] {
  const records: Dict[] = [];
  const docNames: Array<[string, string]> = [
    ["AGENTS.md", "agents_md"],
    ["CLAUDE.md", "claude_md"],
  ];
  for (const root of projectRoots) {
    for (const [filename, docType] of docNames) {
      const p = path.join(root, filename);
      if (!fs.existsSync(p)) continue;
      let content: string;
      try {
        content = fs.readFileSync(p, "utf-8");
      } catch (exc) {
        errors.push(`${p}: cannot read instruction document: ${(exc as Error).message}`);
        continue;
      }
      records.push(
        record({
          sourceKind: "instruction_document",
          timestamp: isoFromMtime(p),
          projectPath: root,
          runtime: "filesystem",
          sourceParts: [resolvePath(p)],
          data: { doc_type: docType, name: filename, content, scope: "project" },
        }),
      );
    }
  }
  return records;
}

function packageJsonSignals(p: string): string[] {
  const data = JSON.parse(fs.readFileSync(p, "utf-8"));
  if (!isPlainObject(data)) return [];
  const signals: string[] = [];
  const name = data.name;
  if (typeof name === "string" && name) signals.push(`name=${name}`);
  for (const section of ["scripts", "dependencies", "devDependencies"]) {
    const sectionData = data[section];
    if (!isPlainObject(sectionData)) continue;
    for (const key of Object.keys(sectionData).sort().slice(0, 30)) {
      signals.push(`${section}:${key}`);
    }
  }
  return signals;
}

function textConfigSignals(p: string, configType: string): string[] {
  let lines: string[];
  try {
    lines = splitLines(fs.readFileSync(p, "utf-8"));
  } catch {
    return [];
  }
  const signals: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    if (configType === "gomod" && (line.startsWith("module ") || line.startsWith("go ") || line.startsWith("require "))) {
      signals.push(line);
    } else if (
      configType === "pyproject" &&
      (line.startsWith("[") || line.startsWith("requires-python") || line.startsWith("dependencies") || line.startsWith("name"))
    ) {
      signals.push(line);
    } else if (configType === "cargo_toml" && (line.startsWith("[") || line.startsWith("name") || line.startsWith("edition"))) {
      signals.push(line);
    } else if (configType === "lefthook" && line.includes(":")) {
      signals.push(line);
    }
    if (signals.length >= 40) break;
  }
  return signals;
}

export function extractProjectConfigSignals(projectRoots: string[], errors: string[]): Dict[] {
  const records: Dict[] = [];
  const configFiles: Array<[string, string, (p: string) => string[]]> = [
    ["package.json", "package_json", packageJsonSignals],
    ["pyproject.toml", "pyproject", (p) => textConfigSignals(p, "pyproject")],
    ["go.mod", "gomod", (p) => textConfigSignals(p, "gomod")],
    ["Cargo.toml", "cargo_toml", (p) => textConfigSignals(p, "cargo_toml")],
    [".lefthook.yml", "lefthook", (p) => textConfigSignals(p, "lefthook")],
    ["lefthook.yml", "lefthook", (p) => textConfigSignals(p, "lefthook")],
  ];
  for (const root of projectRoots) {
    for (const [filename, configType, extractor] of configFiles) {
      const p = path.join(root, filename);
      if (!fs.existsSync(p)) continue;
      let signals: string[];
      try {
        signals = extractor(p);
      } catch (exc) {
        errors.push(`${p}: cannot extract config signals: ${(exc as Error).message}`);
        continue;
      }
      if (signals.length === 0) continue;
      records.push(
        record({
          sourceKind: "project_config_signal",
          timestamp: isoFromMtime(p),
          projectPath: root,
          runtime: "filesystem",
          sourceParts: [resolvePath(p), configType],
          data: { config_type: configType, file_path: path.relative(root, p), signals },
        }),
      );
    }
  }
  return records;
}

// ── JSONL session extractors (codex, claude-code) ──────────────────

function pathStem(p: string): string {
  const base = path.basename(p);
  const ext = path.extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

export function extractCodexSessions(sessionsDir: string | null, errors: string[]): Dict[] {
  if (sessionsDir === null || !fs.existsSync(sessionsDir)) return [];
  const records: Dict[] = [];
  for (const p of rglob(sessionsDir, "*.jsonl")) {
    const fallbackTimestamp = isoFromMtime(p);
    let sessionId = pathStem(p);
    let projectPath: string | null = null;
    let previousAssistant = "";
    let index = 0;
    for (const event of iterJsonl(p, errors)) {
      index += 1;
      const kind = eventKind(event);
      const payload = isPlainObject(event.payload) ? event.payload : {};
      if (kind === "session_meta") {
        const sid = payload.id || event.id;
        if (typeof sid === "string" && sid) sessionId = sid;
        const cwd = payload.cwd || payload.working_directory;
        if (typeof cwd === "string" && cwd) projectPath = cwd;
        continue;
      }
      if (kind === "turn_context") {
        const cwd = payload.cwd || payload.working_directory;
        if (typeof cwd === "string" && cwd) projectPath = cwd;
        continue;
      }
      const toolRecord = toolCallRecord({ event, fallbackTimestamp, projectPath, runtime: "codex", sourcePath: p, index, sessionId });
      if (toolRecord !== null) {
        records.push(toolRecord);
        continue;
      }
      const item = payloadItem(event);
      const itemType = item.type;
      let role = item.role || item.actor;
      if (kind === "user_msg") role = "user";
      if (role !== "user" && role !== "assistant") continue;
      const skipType = itemType !== undefined && itemType !== null && itemType !== "message";
      if (skipType && !["response_item", "user_msg"].includes(kind)) continue;

      const content = textFromContent(item.content || item.text || item.message);
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
          runtime: "codex",
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
              runtime: "codex",
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

export function extractClaudeProjectSessions(projectsDir: string | null, errors: string[]): Dict[] {
  if (projectsDir === null || !fs.existsSync(projectsDir)) return [];
  const records: Dict[] = [];
  for (const p of rglob(projectsDir, "*.jsonl")) {
    const fallbackTimestamp = isoFromMtime(p);
    let sessionId = pathStem(p);
    let projectPath: string | null = null;
    let previousAssistant = "";
    let index = 0;
    for (const event of iterJsonl(p, errors)) {
      index += 1;
      const sid = event.sessionId || event.session_id || event.sessionID;
      if (typeof sid === "string" && sid) sessionId = sid;
      const cwd = event.cwd || event.workingDirectory || event.working_directory;
      if (typeof cwd === "string" && cwd) projectPath = cwd;

      const toolRecord = toolCallRecord({ event, fallbackTimestamp, projectPath, runtime: "claude-code", sourcePath: p, index, sessionId });
      if (toolRecord !== null) {
        records.push(toolRecord);
        continue;
      }
      let contentIndex = 0;
      for (const item of claudeContentItems(event)) {
        contentIndex += 1;
        const tr = toolCallRecordFromItem({
          item,
          event,
          fallbackTimestamp,
          projectPath,
          runtime: "claude-code",
          sourcePath: p,
          index: index * 1000 + contentIndex,
          sessionId,
        });
        if (tr !== null) records.push(tr);
      }

      let role = event.role || event.type;
      if (role !== "user" && role !== "assistant") {
        const message = event.message;
        if (isPlainObject(message)) role = message.role;
      }
      if (role !== "user" && role !== "assistant") continue;
      const content = textFromContent(event.content || event.text || (isPlainObject(event.message) ? event.message : null));
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
          runtime: "claude-code",
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
              runtime: "claude-code",
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

// ── SQLite (node:sqlite, lazy) ──────────────────────────────────────

import { createRequire } from "node:module";
const requireCjs = createRequire(import.meta.url);

interface SqliteDb {
  prepare(sql: string): { all(...params: unknown[]): Dict[]; get(...params: unknown[]): Dict | undefined };
  close(): void;
}
/** Lazy open a read-only SQLite db via node:sqlite (warning only fires here). */
function openSqlite(p: string): SqliteDb {
  const { DatabaseSync } = requireCjs("node:sqlite");
  return new DatabaseSync(resolvePath(p), { readOnly: true }) as SqliteDb;
}

function sqliteTimestamp(value: unknown, fallback: string): string {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number") {
    let numeric = value;
    if (numeric > 10_000_000_000) numeric /= 1000;
    return new Date(numeric * 1000).toISOString();
  }
  return fallback;
}

function jsonDict(value: unknown): Dict {
  if (isPlainObject(value)) return value;
  if (typeof value === "string" && value) {
    try {
      const parsed = JSON.parse(value);
      return isPlainObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function nestedTimeCreated(data: Dict): unknown {
  const timeData = data.time;
  if (isPlainObject(timeData)) return timeData.created || timeData.start;
  return data.time_created || data.timestamp;
}

function tableColumns(conn: SqliteDb, table: string): Set<string> {
  const rows = conn.prepare(`PRAGMA table_info(${table})`).all();
  return new Set(rows.map((r) => String(r.name)));
}
function firstColumn(columns: Set<string>, candidates: string[]): string | null {
  for (const c of candidates) if (columns.has(c)) return c;
  return null;
}
function qualified(alias: string, column: string | null, label: string): string {
  if (column === null) return `NULL AS ${label}`;
  const escaped = column.replace(/"/g, '""');
  return `${alias}."${escaped}" AS ${label}`;
}

function opencodeRows(conn: SqliteDb): Dict[] {
  const tables = new Set(
    conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => String(r.name)),
  );
  for (const t of ["session", "message", "part"]) {
    if (!tables.has(t)) {
      const missing = ["session", "message", "part"].filter((x) => !tables.has(x)).sort().join(",");
      throw new Error(`missing opencode tables: ${missing}`);
    }
  }
  const sessionCols = tableColumns(conn, "session");
  const messageCols = tableColumns(conn, "message");
  const partCols = tableColumns(conn, "part");
  const sessionId = firstColumn(sessionCols, ["id", "session_id", "sessionID"]);
  const messageId = firstColumn(messageCols, ["id", "message_id", "messageID"]);
  const messageSession = firstColumn(messageCols, ["sessionID", "session_id", "session", "sessionId"]);
  const partMessage = firstColumn(partCols, ["messageID", "message_id", "message", "messageId"]);
  if (!(sessionId && messageId && messageSession && partMessage)) throw new Error("missing opencode join columns");
  const messageData = firstColumn(messageCols, ["data"]);
  const partData = firstColumn(partCols, ["data"]);
  const roleCol = firstColumn(messageCols, ["role", "actor", "author"]);
  if (roleCol === null && messageData === null) throw new Error("missing opencode message role column");
  const messageTime = firstColumn(messageCols, ["time_created", "time", "timestamp", "created_at", "createdAt"]);
  const partTime = firstColumn(partCols, ["time_created", "time", "timestamp", "created_at", "createdAt"]);
  const sessionTime = firstColumn(sessionCols, ["time_created", "time", "timestamp", "created_at", "createdAt"]);
  const sessionUpdated = firstColumn(sessionCols, ["time_updated", "updated_at", "updatedAt", "time_created", "time"]);
  const projectCol = firstColumn(sessionCols, ["cwd", "project_path", "projectPath", "directory", "path"]);
  const messageText = firstColumn(messageCols, ["content", "text", "message"]);
  const partText = firstColumn(partCols, ["text", "content", "input", "output"]);
  const partType = firstColumn(partCols, ["type", "kind"]);
  const partId = firstColumn(partCols, ["id", "part_id", "partID"]);

  const sortExpr = `COALESCE(m."${messageTime || messageId}", p."${partTime || partMessage}", s."${sessionTime || sessionId}")`;
  const recentSessionExpr = `s."${sessionUpdated || sessionTime || sessionId}"`;
  const query = `
        WITH recent_sessions AS (
            SELECT s."${sessionId}" AS recent_session_id
            FROM session s
            ORDER BY ${recentSessionExpr} DESC,
                     s."${sessionId}" DESC
            LIMIT ?
        ),
        recent AS (
            SELECT
                ${qualified("s", sessionId, "session_id")},
                ${qualified("s", projectCol, "project_path")},
                ${qualified("m", messageId, "message_id")},
                ${qualified("m", roleCol, "role")},
                ${qualified("m", messageTime, "message_time")},
                ${qualified("m", messageText, "message_text")},
                ${qualified("m", messageData, "message_data")},
                ${qualified("p", partId, "part_id")},
                ${qualified("p", partTime, "part_time")},
                ${qualified("p", partType, "part_type")},
                ${qualified("p", partText, "part_text")},
                ${qualified("p", partData, "part_data")},
                ${sortExpr} AS sort_time
            FROM message m
            JOIN session s ON m."${messageSession}" = s."${sessionId}"
            JOIN recent_sessions rs ON rs.recent_session_id = s."${sessionId}"
            LEFT JOIN part p ON p."${partMessage}" = m."${messageId}"
            ORDER BY sort_time DESC,
                     m."${messageId}" DESC,
                     p."${partId || partMessage}" DESC
            LIMIT ?
        )
        SELECT
            session_id, project_path, message_id, role, message_time,
            message_text, message_data, part_id, part_time, part_type,
            part_text, part_data
        FROM recent
        ORDER BY sort_time, message_id, part_id
    `;
  return conn.prepare(query).all(MAX_SQLITE_SESSIONS, MAX_SQLITE_ROWS);
}

function opencodeDbCandidates(storePath: string): string[] {
  if (isFilePath(storePath)) return [storePath];
  return rglob(storePath, "opencode.db");
}

export function extractOpencodeSessions(storePath: string | null, errors: string[]): Dict[] {
  if (storePath === null || !fs.existsSync(storePath)) return [];
  const records: Dict[] = [];
  for (const dbPath of opencodeDbCandidates(storePath).slice(0, 1)) {
    const fallbackTimestamp = isoFromMtime(dbPath);
    let rows: Dict[];
    let conn: SqliteDb | null = null;
    try {
      conn = openSqlite(dbPath);
      rows = opencodeRows(conn);
    } catch (exc) {
      const msg = (exc as Error).message || "";
      if (/lock|busy/i.test(msg)) throw new PermissionDeniedError(msg);
      errors.push(`${dbPath}: opencode sqlite read failed: ${(exc as Error).name || "Error"}`);
      continue;
    } finally {
      try {
        conn?.close();
      } catch {
        /* ignore */
      }
    }

    const messages = new Map<string, Dict>();
    for (const row of rows) {
      const messageData = jsonDict(row.message_data);
      const partData = jsonDict(row.part_data);
      const messageId = String(row.message_id);
      const role = row.role || messageData.role;
      const messageTime = row.message_time || nestedTimeCreated(messageData);
      let item = messages.get(messageId);
      if (item === undefined) {
        item = {
          role,
          session_id: String(row.session_id),
          project_path: row.project_path,
          timestamp: sqliteTimestamp(messageTime, fallbackTimestamp),
          parts: [] as string[],
          tools: [] as Dict[],
        };
        messages.set(messageId, item);
      }
      const partType = row.part_type || partData.type;
      const partText = textFromContent(row.part_text || partData.text);
      if (partText) item.parts.push(partText);
      else if (row.message_text) item.parts.push(textFromContent(row.message_text));
      if (partType === "tool" || partData.tool) {
        const state = isPlainObject(partData.state) ? partData.state : {};
        const argumentsVal = isPlainObject(state.input) ? state.input : {};
        const toolName = partData.tool || partData.name;
        if (typeof toolName === "string" && toolName) {
          item.tools.push({
            part_id: row.part_id,
            tool_name: toolName,
            arguments: argumentsVal,
            timestamp: sqliteTimestamp(row.part_time || nestedTimeCreated(partData), item.timestamp),
          });
        }
      }
    }

    let previousAssistant = "";
    let index = 0;
    for (const item of messages.values()) {
      index += 1;
      const role = String(item.role).toLowerCase();
      if (role !== "user" && role !== "assistant") continue;
      const content = (item.parts as string[]).filter((p: string) => p).join("\n");
      if (!content && item.tools.length === 0) continue;
      const projectPath = item.project_path ? String(item.project_path) : null;
      if (content) {
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
            timestamp: item.timestamp,
            projectPath,
            runtime: "opencode",
            sourceParts: [resolvePath(dbPath), index, role, content.slice(0, 80)],
            sessionId: item.session_id,
            data,
          }),
        );
      }
      let toolIndex = 0;
      for (const toolItem of item.tools as Dict[]) {
        toolIndex += 1;
        records.push(
          record({
            sourceKind: "tool_call",
            timestamp: toolItem.timestamp,
            projectPath,
            runtime: "opencode",
            sourceParts: [resolvePath(dbPath), index, toolIndex, "tool", toolItem.tool_name, toolItem.part_id],
            sessionId: item.session_id,
            data: { tool_name: toolItem.tool_name, arguments: toolItem.arguments },
          }),
        );
      }
      if (role === "user" && content) {
        const sig = signalType(content);
        if (sig) {
          records.push(
            record({
              sourceKind: "history_prompt",
              timestamp: item.timestamp,
              projectPath,
              runtime: "opencode",
              sourceParts: [resolvePath(dbPath), index, "history", content.slice(0, 120)],
              sessionId: item.session_id,
              data: { prompt: content, signal_type: sig },
            }),
          );
        }
      }
    }
  }
  return records;
}

/** Mirrors Python raising PermissionError on a locked/busy store. */
export class PermissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionDeniedError";
  }
}

// ── Copilot SQLite extractor ────────────────────────────────────────

function copilotDbCandidates(storePath: string): string[] {
  if (isFilePath(storePath)) return [storePath];
  return rglob(storePath, "session-store.db");
}

function copilotRows(conn: SqliteDb): Dict[] {
  const tables = new Set(
    conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => String(r.name)),
  );
  for (const t of ["sessions", "turns"]) {
    if (!tables.has(t)) {
      const missing = ["sessions", "turns"].filter((x) => !tables.has(x)).sort().join(",");
      throw new Error(`missing copilot tables: ${missing}`);
    }
  }
  const sessionCols = tableColumns(conn, "sessions");
  const turnCols = tableColumns(conn, "turns");
  const sessionId = firstColumn(sessionCols, ["id", "session_id", "sessionID"]);
  const turnId = firstColumn(turnCols, ["id", "turn_id", "turnID"]);
  const turnSession = firstColumn(turnCols, ["session_id", "sessionID", "session", "sessionId"]);
  if (!(sessionId && turnSession)) throw new Error("missing copilot join columns");
  const roleCol = firstColumn(turnCols, ["role", "actor", "author"]);
  const textCol = firstColumn(turnCols, ["content", "text", "message", "prompt", "response"]);
  if (roleCol === null) throw new Error("missing copilot turn role column");
  if (textCol === null) throw new Error("missing copilot turn text column");
  const sessionTime = firstColumn(sessionCols, ["time", "timestamp", "created_at", "createdAt"]);
  const turnTime = firstColumn(turnCols, ["time", "timestamp", "created_at", "createdAt"]);
  const turnOrder = firstColumn(turnCols, ["turn_index", "turnIndex", "idx", "position", "sequence"]);
  const projectCol = firstColumn(sessionCols, ["cwd", "project_path", "projectPath", "directory", "path"]);
  const turnData = firstColumn(turnCols, ["data", "payload", "json"]);
  const turnType = firstColumn(turnCols, ["type", "kind"]);
  const toolNameCol = firstColumn(turnCols, ["tool_name", "toolName", "tool", "name", "command_name", "commandName"]);
  const toolArgs = firstColumn(turnCols, [
    "arguments", "args", "input", "tool_input", "toolInput", "command", "command_line", "commandLine",
  ]);

  const orderExpr = turnOrder ? `t."${turnOrder}"` : `t."${turnTime || turnSession}"`;
  const idExpr = turnId ? `t."${turnId}"` : "t.rowid";
  const query = `
        SELECT
            ${qualified("s", sessionId, "session_id")},
            ${qualified("s", projectCol, "project_path")},
            ${qualified("t", turnId, "turn_id")},
            ${qualified("t", roleCol, "role")},
            ${qualified("t", turnTime, "turn_time")},
            ${qualified("s", sessionTime, "session_time")},
            ${qualified("t", textCol, "turn_text")},
            ${qualified("t", turnData, "turn_data")},
            ${qualified("t", turnType, "turn_type")},
            ${qualified("t", toolNameCol, "tool_name")},
            ${qualified("t", toolArgs, "tool_args")}
        FROM turns t
        JOIN sessions s ON t."${turnSession}" = s."${sessionId}"
        ORDER BY COALESCE(${orderExpr}, t."${turnSession}"),
                 CASE LOWER(t."${roleCol}") WHEN 'user' THEN 0 WHEN 'assistant' THEN 1 ELSE 2 END,
                 ${idExpr}
        LIMIT ?
    `;
  return conn.prepare(query).all(MAX_SQLITE_ROWS);
}

function copilotArgumentDict(value: unknown): Dict {
  if (isPlainObject(value)) {
    const stateInput = value.input;
    if (isPlainObject(stateInput) && !("command" in value)) return stateInput;
    return value;
  }
  if (typeof value === "string" && value) {
    try {
      const parsed = JSON.parse(value);
      return isPlainObject(parsed) ? parsed : { value: parsed };
    } catch {
      return { command: value };
    }
  }
  return {};
}

function copilotJsonTools(value: unknown, errors?: string[], malformedLabel?: string): Dict[] {
  if (typeof value === "string" && value) {
    const raw = value;
    try {
      value = JSON.parse(value);
    } catch {
      if (errors && malformedLabel && /^\s*[{[]/.test(raw)) errors.push(malformedLabel);
      return [];
    }
  }
  if (Array.isArray(value)) {
    const tools: Dict[] = [];
    for (const item of value) tools.push(...copilotJsonTools(item, errors, malformedLabel));
    return tools;
  }
  if (!isPlainObject(value)) return [];
  const toolName = value.tool_name || value.toolName || value.tool || value.name;
  const valueType = String(value.type || value.kind || "").toLowerCase();
  if (
    typeof toolName === "string" &&
    toolName &&
    ["", "tool", "tool_call", "function_call", "tool_use", "command"].includes(valueType)
  ) {
    return [
      {
        tool_name: toolName,
        arguments: copilotArgumentDict(value.arguments || value.args || value.input || value.state || {}),
      },
    ];
  }
  const tools: Dict[] = [];
  for (const key of ["tool_calls", "toolCalls", "tools", "content", "parts", "items"]) {
    const nested = value[key];
    if (isPlainObject(nested) || Array.isArray(nested)) tools.push(...copilotJsonTools(nested, errors, malformedLabel));
  }
  return tools;
}

function copilotRowTools(row: Dict, errors: string[]): Dict[] {
  const tools = copilotJsonTools(row.turn_data, errors, "copilot malformed json tool payload");
  tools.push(...copilotJsonTools(row.turn_text));
  const toolName = row.tool_name;
  if (typeof toolName === "string" && toolName) {
    tools.push({ tool_name: toolName, arguments: copilotArgumentDict(row.tool_args) });
  } else if (String(row.turn_type || "").toLowerCase() === "command") {
    const command = row.tool_args || row.turn_text;
    if (typeof command === "string" && command) tools.push({ tool_name: "bash", arguments: { command } });
  }
  return tools.filter((t) => typeof t.tool_name === "string" && t.tool_name);
}

export function extractCopilotSessions(storePath: string | null, errors: string[]): Dict[] {
  if (storePath === null || !fs.existsSync(storePath)) return [];
  const records: Dict[] = [];
  for (const dbPath of copilotDbCandidates(storePath).slice(0, 1)) {
    const fallbackTimestamp = isoFromMtime(dbPath);
    let rows: Dict[];
    let conn: SqliteDb | null = null;
    try {
      conn = openSqlite(dbPath);
      rows = copilotRows(conn);
    } catch (exc) {
      const msg = (exc as Error).message || "";
      if (/lock|busy/i.test(msg)) throw new PermissionDeniedError(msg);
      errors.push(`${dbPath}: copilot sqlite read failed: ${(exc as Error).name || "Error"}`);
      continue;
    } finally {
      try {
        conn?.close();
      } catch {
        /* ignore */
      }
    }

    let previousAssistant = "";
    let index = 0;
    for (const row of rows) {
      index += 1;
      const role = String(row.role).toLowerCase();
      if (role !== "user" && role !== "assistant") continue;
      const content = textFromContent(row.turn_text);
      const toolItems = copilotRowTools(row, errors);
      if (!content && toolItems.length === 0) continue;
      const projectPath = row.project_path ? String(row.project_path) : null;
      const timestamp = sqliteTimestamp(row.turn_time || row.session_time, fallbackTimestamp);
      if (content) {
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
            runtime: "github-copilot",
            sourceParts: [resolvePath(dbPath), index, role, content.slice(0, 80)],
            sessionId: String(row.session_id),
            data,
          }),
        );
      }
      let toolIndex = 0;
      for (const toolItem of toolItems) {
        toolIndex += 1;
        records.push(
          record({
            sourceKind: "tool_call",
            timestamp,
            projectPath,
            runtime: "github-copilot",
            sourceParts: [resolvePath(dbPath), index, toolIndex, "tool", toolItem.tool_name, row.turn_id],
            sessionId: String(row.session_id),
            data: { tool_name: String(toolItem.tool_name), arguments: toolItem.arguments || {} },
          }),
        );
      }
      if (role === "user") {
        const sig = signalType(content);
        if (sig) {
          records.push(
            record({
              sourceKind: "history_prompt",
              timestamp,
              projectPath,
              runtime: "github-copilot",
              sourceParts: [resolvePath(dbPath), index, "history", content.slice(0, 120)],
              sessionId: String(row.session_id),
              data: { prompt: content, signal_type: sig },
            }),
          );
        }
      }
    }
  }
  return records;
}

// ── runtime path resolvers ──────────────────────────────────────────

import { execFileSync } from "node:child_process";
import { expanduser } from "../core/paths.js";

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

// ── dispatch + envelope + main ──────────────────────────────────────

import { pyJsonIndent } from "../core/pyjson.js";

export class ExtractionNotImplementedError extends Error {}

type Extractor = (storePath: string | null, errors: string[]) => Dict[];

function extractRuntimeStore(
  runtime: string,
  storePath: string | null,
  errors: string[],
  extractor: Extractor,
): [Dict[], Dict] {
  const discovery = discoverRuntimeStore(runtime, storePath);
  if (discovery.status !== "available") return [[], discovery];
  const errorStart = errors.length;
  let records: Dict[];
  try {
    records = extractor(storePath, errors);
  } catch (exc) {
    const cc = discovery.candidate_count ?? null;
    if (exc instanceof ExtractionNotImplementedError) {
      return [[], runtimeStatus(runtime, { status: "degraded", reason: "extractor_unimplemented", storePath, candidateCount: cc, recordCount: 0, errorCount: 0 })];
    }
    if (exc instanceof PermissionDeniedError) {
      return [[], runtimeStatus(runtime, { status: "degraded", reason: "store_locked", storePath, candidateCount: cc })];
    }
    return [[], runtimeStatus(runtime, { status: "degraded", reason: "store_unreadable", storePath, candidateCount: cc })];
  }
  const cc = discovery.candidate_count ?? null;
  const errorCount = errors.length - errorStart;
  if (errorCount) {
    return [records, runtimeStatus(runtime, { status: "degraded", reason: "schema_divergent", storePath, candidateCount: cc, recordCount: records.length, errorCount })];
  }
  if (records.length === 0) {
    return [records, runtimeStatus(runtime, {
      status: "sparse",
      reason: "no_matching_records",
      storePath,
      candidateCount: cc,
      recordCount: 0,
      remediationLabels: runtime === "github-copilot" ? [COPILOT_SPARSE_REMEDIATION] : null,
    })];
  }
  return [records, runtimeStatus(runtime, { status: "ok", reason: "records_extracted", storePath, candidateCount: cc, recordCount: records.length, errorCount: 0 })];
}

export function dedupeRecords(records: Dict[]): Dict[] {
  const byId = new Map<string, Dict>();
  for (const item of records) byId.set(item.source_id, item);
  const actorOrder = (item: Dict): number => {
    const actor = isPlainObject(item.data) ? item.data.actor : null;
    return actor === "user" ? 0 : actor === "assistant" ? 1 : 2;
  };
  return Array.from(byId.values()).sort((a, b) => {
    const at = (a.timestamp ?? "") as string;
    const bt = (b.timestamp ?? "") as string;
    if (at !== bt) return at < bt ? -1 : 1;
    const ak = (a.source_kind ?? "") as string;
    const bk = (b.source_kind ?? "") as string;
    if (ak !== bk) return ak < bk ? -1 : 1;
    const ao = actorOrder(a);
    const bo = actorOrder(b);
    if (ao !== bo) return ao - bo;
    const ai = (a.source_id ?? "") as string;
    const bi = (b.source_id ?? "") as string;
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });
}

export function buildMetadata(records: Dict[], errors: string[], runtimeStatuses: Dict[]): Dict {
  const counts = new Map<string, number>();
  for (const item of records) {
    const sk = item.source_kind;
    if ((FAMILIES as readonly string[]).includes(sk)) counts.set(sk, (counts.get(sk) ?? 0) + 1);
  }
  const families: Dict = {};
  for (const family of FAMILIES) {
    const count = counts.get(family) ?? 0;
    families[family] = { count, status: count ? "ok" : "missing" };
    if (count === 0) families[family].error = "no records extracted for this family";
  }
  const runtimes = Array.from(new Set(records.filter((i) => i.runtime).map((i) => String(i.runtime)))).sort();
  return {
    extracted_at: isoNow(),
    runtimes,
    adapter_version: ADAPTER_VERSION,
    families,
    runtime_statuses: runtimeStatuses,
    total_records: records.length,
    errors,
  };
}

export interface BuildCorpusOpts {
  projectRoots: string[];
  codexSessionsDir: string | null;
  claudeProjectsDir: string | null;
  opencodeConversationsDir?: string | null;
  copilotConversationsDir?: string | null;
  cursorProjectsDir?: string | null;
  cursorChatsDir?: string | null;
}

export function buildCorpus(opts: BuildCorpusOpts): Dict {
  const errors: string[] = [];
  const normalizedRoots: string[] = [];
  for (const root of opts.projectRoots) {
    if (fs.existsSync(root)) normalizedRoots.push(resolvePath(root));
    else errors.push(`${root}: project root does not exist`);
  }
  const records: Dict[] = [];
  records.push(...extractInstructionDocuments(normalizedRoots, errors));
  records.push(...extractProjectConfigSignals(normalizedRoots, errors));
  const runtimeStatuses: Dict[] = [];
  const runtimes: Array<[string, string | null, Extractor]> = [
    ["codex", opts.codexSessionsDir, extractCodexSessions],
    ["claude-code", opts.claudeProjectsDir, extractClaudeProjectSessions],
    ["cursor", opts.cursorProjectsDir ?? null, (sp, err) => extractCursorSessions(sp, err, normalizedRoots)],
    [
      "cursor-agent",
      opts.cursorChatsDir ?? null,
      (sp, err) => extractCursorAgentSessions(sp, err, normalizedRoots, opts.cursorProjectsDir ?? null),
    ],
    ["opencode", opts.opencodeConversationsDir ?? null, extractOpencodeSessions],
    ["github-copilot", opts.copilotConversationsDir ?? null, extractCopilotSessions],
  ];
  for (const [runtime, storePath, extractor] of runtimes) {
    const [runtimeRecords, status] = extractRuntimeStore(runtime, storePath, errors, extractor);
    records.push(...runtimeRecords);
    runtimeStatuses.push(status);
  }
  const deduped = dedupeRecords(records);
  return { metadata: buildMetadata(deduped, errors, runtimeStatuses), records: deduped };
}

export interface ExtractArgs {
  output: string;
  projectRoot: string[];
  codexSessionsDir: string;
  claudeProjectsDir: string;
  opencodeConversationsDir: string | null;
  copilotConversationsDir: string | null;
  cursorProjectsDir: string | null;
  cursorChatsDir: string | null;
  noCodex: boolean;
  noClaude: boolean;
  noOpencode: boolean;
  noCopilot: boolean;
  noCursor: boolean;
}

export function parseExtractArgs(argv: string[], env: Env = process.env, platform: NodeJS.Platform = process.platform): ExtractArgs {
  const home = os.homedir();
  const args: ExtractArgs = {
    output: defaultOutputPath(env, platform),
    projectRoot: [],
    codexSessionsDir: path.join(home, ".codex", "sessions"),
    claudeProjectsDir: path.join(home, ".claude", "projects"),
    opencodeConversationsDir: null,
    copilotConversationsDir: null,
    cursorProjectsDir: null,
    cursorChatsDir: null,
    noCodex: false,
    noClaude: false,
    noOpencode: false,
    noCopilot: false,
    noCursor: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = (name: string): string | null => {
      if (a === name) return argv[++i] ?? null;
      if (a.startsWith(name + "=")) return a.slice(name.length + 1);
      return null;
    };
    let v: string | null;
    if ((v = val("--output")) !== null) args.output = v;
    else if ((v = val("--project-root")) !== null) args.projectRoot.push(v);
    else if ((v = val("--codex-sessions-dir")) !== null) args.codexSessionsDir = v;
    else if ((v = val("--claude-projects-dir")) !== null) args.claudeProjectsDir = v;
    else if ((v = val("--opencode-conversations-dir")) !== null) args.opencodeConversationsDir = v;
    else if ((v = val("--copilot-conversations-dir")) !== null) args.copilotConversationsDir = v;
    else if ((v = val("--cursor-projects-dir")) !== null) args.cursorProjectsDir = v;
    else if ((v = val("--cursor-chats-dir")) !== null) args.cursorChatsDir = v;
    else if (a === "--no-codex") args.noCodex = true;
    else if (a === "--no-claude") args.noClaude = true;
    else if (a === "--no-opencode") args.noOpencode = true;
    else if (a === "--no-copilot") args.noCopilot = true;
    else if (a === "--no-cursor") args.noCursor = true;
    else throw new Error(`extract-corpus: unrecognized argument: ${a}`);
  }
  return args;
}

export interface ExtractMainIo {
  out?: (text: string) => void;
  err?: (text: string) => void;
  env?: Env;
  platform?: NodeJS.Platform;
  cwd?: string;
}

/** Engine entry point mirroring scripts/extract_corpus.py main(). */
export function extractCorpusMain(argv: string[], io: ExtractMainIo = {}): number {
  const out = io.out ?? ((t: string) => process.stdout.write(t + "\n"));
  const err = io.err ?? ((t: string) => process.stderr.write(t + "\n"));
  const env = io.env ?? process.env;
  const platform = io.platform ?? process.platform;
  const cwd = io.cwd ?? process.cwd();
  let args: ExtractArgs;
  try {
    args = parseExtractArgs(argv, env, platform);
  } catch (exc) {
    err((exc as Error).message);
    return 2;
  }
  const projectRoots = args.projectRoot.length > 0 ? args.projectRoot : [cwd];
  const skipCursor = args.noCursor;
  const corpus = buildCorpus({
    projectRoots,
    codexSessionsDir: args.noCodex ? null : args.codexSessionsDir,
    claudeProjectsDir: args.noClaude ? null : args.claudeProjectsDir,
    opencodeConversationsDir: args.noOpencode ? null : args.opencodeConversationsDir || resolveOpencodeDbPath(env),
    copilotConversationsDir: args.noCopilot ? null : args.copilotConversationsDir || resolveCopilotStorePath(env),
    cursorProjectsDir: skipCursor ? null : args.cursorProjectsDir || resolveCursorProjectsPath(env),
    cursorChatsDir: skipCursor ? null : args.cursorChatsDir || resolveCursorChatsPath(env),
  });
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, pyJsonIndent(corpus) + "\n", "utf-8");
  const total = corpus.metadata.total_records;
  const familyBits = Object.entries(corpus.metadata.families)
    .map(([name, summary]) => `${name}=${(summary as Dict).count}`)
    .join(", ");
  out(`wrote corpus: ${args.output} (${total} records; ${familyBits})`);
  return 0;
}
