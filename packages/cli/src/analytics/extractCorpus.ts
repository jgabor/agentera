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
