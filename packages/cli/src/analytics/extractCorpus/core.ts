import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveProfileDirOverride, resolveXdgDataHome } from "../../core/envPaths.js";
import { expanduser } from "../../core/paths.js";
import crypto from "node:crypto";

import type { JsonObject, JsonValue } from "../../core/jsonValue.js";
import { resolvePath } from "../../core/paths.js";

export type Env = Record<string, string | undefined>;

export const ADAPTER_VERSION = "agentera-v3-corpus-3";
export const FAMILIES = [
  "instruction_document",
  "history_prompt",
  "conversation_turn",
  "tool_call",
  "project_config_signal",
] as const;

export const RUNTIME_STORE_GLOBS: Record<string, string> = {
  codex: "*.jsonl",
  cursor: "*.jsonl",
  opencode: "opencode.db",
  copilot: "session-store.db",
};
export const HISTORICAL_IMPORT_STORE_GLOBS: Record<string, string> = {
  "claude-code": "*.jsonl",
};
const ACTIVE_ANALYTICS_RUNTIMES = new Set(["opencode", "codex", "cursor", "copilot"]);
export const MAX_TOOL_ARG_TEXT = 500;
export const MAX_SQLITE_ROWS = 100_000;
export const MAX_SQLITE_SESSIONS = 60;
export const COPILOT_SPARSE_REMEDIATION = "/chronicle reindex";

const ORIGIN_ID_RE = /^[a-f0-9]{64}$/;
const CONTENT_FINGERPRINT_RE = /^[a-f0-9]{64}$/;
const CONVERSATION_SOURCE_KINDS = new Set(["conversation_turn", "history_prompt"]);
const PROVENANCE_NESTED_KEYS = ["payload", "item", "metadata", "meta", "provenance", "source"] as const;
const PROVENANCE_ORIGIN_KEYS = [
  "origin_id",
  "original_origin_id",
  "original_origin",
  "origin",
  "source_origin",
  "instruction_origin",
] as const;
const PROVENANCE_AUTHOR_KEYS = ["author_class", "authorClass", "author"] as const;

const DECISION_RE =
  /\b(decide|decision|prefer|preference|instead|avoid|don't|do not|should|trade[- ]?off|scope|plan|commit|review|fix|why|question|blocked|stuck|approve|reject|change|keep|remove)\b/i;
const CORRECTION_RE =
  /\b(no|not quite|actually|rather|instead|wrong|correction|that's not|that is not|don't|do not)\b/i;
const QUESTION_RE = /\?|^\s*(why|what|how|should|can|could|would)\b/i;

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

/** A bounded, deterministic identity for the source that originally supplied a record. */
export function originIdentity(origin: string): string {
  if (typeof origin !== "string" || origin.length === 0) {
    throw new TypeError("origin must be a non-empty string");
  }
  return crypto
    .createHash("sha256")
    .update("agentera.corpus.origin.v1\0", "utf-8")
    .update(origin, "utf-8")
    .digest("hex");
}

/** A lowercase SHA-256 of the exact source text, without normalization or truncation. */
export function contentFingerprint(content: string): string {
  if (typeof content !== "string") throw new TypeError("content must be a string");
  return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function provenanceObjects(sources: unknown[]): JsonObject[] {
  const out: JsonObject[] = [];
  const pending = sources.slice();
  const seen = new Set<object>();
  while (pending.length > 0 && out.length < 24) {
    const value = pending.shift();
    if (!isPlainObject(value) || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    for (const key of PROVENANCE_NESTED_KEYS) {
      const nested = value[key];
      if (isPlainObject(nested)) pending.push(nested);
    }
  }
  return out;
}

export interface TransportProvenance {
  originId: string | null;
  authorClass: string | null;
}

/**
 * Read only explicit transport metadata. Content is never inspected to infer
 * either ownership or origin. An adapter may provide an origin digest directly,
 * or a bounded source label that is converted to one.
 */
export function transportProvenance(...sources: unknown[]): TransportProvenance {
  let origin: string | null = null;
  let authorClass: string | null = null;
  for (const source of provenanceObjects(sources)) {
    if (origin === null) {
      for (const key of PROVENANCE_ORIGIN_KEYS) {
        const value = source[key];
        if (nonEmptyString(value)) {
          origin = ORIGIN_ID_RE.test(value) && key.endsWith("_id") ? value : originIdentity(value);
          break;
        }
      }
    }
    if (authorClass === null) {
      for (const key of PROVENANCE_AUTHOR_KEYS) {
        const value = source[key];
        if (nonEmptyString(value)) {
          authorClass = value;
          break;
        }
      }
    }
    if (origin !== null && authorClass !== null) break;
  }
  return { originId: origin, authorClass };
}

/**
 * Map a transport role to a source-author class without examining its text.
 * A claimed transported origin requires the original author to be explicit;
 * the envelope role is not evidence for the source that was transported.
 */
export function authorClassForRole(
  role: unknown,
  explicitAuthorClass: string | null = null,
  transportedOriginId: string | null = null,
): string | null {
  const explicit = nonEmptyString(explicitAuthorClass);
  if (!explicit && nonEmptyString(transportedOriginId)) return null;
  const value = explicit ? explicitAuthorClass : nonEmptyString(role) ? role : null;
  if (value === null) return null;
  switch (value.toLowerCase()) {
    case "user":
      return "user";
    case "assistant":
    case "model":
    case "tool":
      return "agent";
    case "system":
    case "developer":
    case "instruction":
      return "injected_instruction";
    default:
      return explicit ? value : null;
  }
}

export interface ProvenanceCoverage {
  complete: boolean;
  missingFields: string[];
  missingRecords: number;
}

/** Return the bounded provenance fields missing from one retained record. */
export function missingProvenanceFields(item: JsonObject): string[] {
  const missing: string[] = [];
  const required: Array<[string, boolean]> = [
    ["source_id", nonEmptyString(item.source_id)],
    ["source_kind", nonEmptyString(item.source_kind)],
    ["timestamp", nonEmptyString(item.timestamp)],
    ["project_id", nonEmptyString(item.project_id)],
    ["source_class", nonEmptyString(item.source_class)],
    ["source_product", nonEmptyString(item.source_product)],
    ["adapter_version", nonEmptyString(item.adapter_version)],
    ["data", isPlainObject(item.data)],
  ];
  for (const [field, present] of required) if (!present) missing.push(field);
  if (typeof item.runtime !== "string" && item.runtime !== null) missing.push("runtime");
  if (typeof item.active_runtime !== "boolean") missing.push("active_runtime");

  if (CONVERSATION_SOURCE_KINDS.has(String(item.source_kind))) {
    if (!ORIGIN_ID_RE.test(String(item.origin_id ?? ""))) missing.push("origin_id");
    if (!nonEmptyString(item.author_class)) missing.push("author_class");
    if (!CONTENT_FINGERPRINT_RE.test(String(item.content_fingerprint ?? ""))) {
      missing.push("content_fingerprint");
    }
    if (!nonEmptyString(item.session_id)) missing.push("session_id");
  }
  return [...new Set(missing)];
}

export function assessProvenance(records: readonly JsonObject[]): ProvenanceCoverage {
  const fields = new Set<string>();
  let missingRecords = 0;
  for (const record of records) {
    const missing = missingProvenanceFields(record);
    if (missing.length === 0) continue;
    missingRecords += 1;
    for (const field of missing) fields.add(field);
  }
  return { complete: missingRecords === 0, missingFields: [...fields].sort(), missingRecords };
}

/**
 * Count independent conversation origins without using record IDs or copy
 * counts. Repeated transport of one origin and fingerprint contributes once;
 * a different origin remains independent even when its text is identical.
 */
export function countIndependentOrigins(records: readonly JsonObject[]): number {
  const identities = new Set<string>();
  for (const record of records) {
    if (!CONVERSATION_SOURCE_KINDS.has(String(record.source_kind))) continue;
    const originId = record.origin_id;
    const fingerprint = record.content_fingerprint;
    if (!ORIGIN_ID_RE.test(String(originId ?? "")) || !CONTENT_FINGERPRINT_RE.test(String(fingerprint ?? ""))) continue;
    identities.add(`${originId}\0${fingerprint}`);
  }
  return identities.size;
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
  if (override) return expanduser(override);
  if (platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "agentera");
  if (platform === "win32") {
    const appdata = env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(expanduser(appdata), "agentera");
  }
  return path.join(resolveXdgDataHome(env), "agentera");
}

export function defaultProfileDir(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  const override = resolveProfileDirOverride(env);
  if (override) return expanduser(override);
  return defaultAgenteraHome(env, platform);
}

export function defaultOutputPath(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  return path.join(defaultProfileDir(env, platform), "intermediate", "corpus.json");
}

export interface RuntimeStatusOpts {
  status: string;
  reason: string;
  storePath: string | null;
  fileCount?: number | null;
  recordCount?: number | null;
  errorCount?: number | null;
  remediationLabels?: string[] | null;
  truncatedAt?: string | null;
  truncationCap?: "sessions" | "rows" | null;
  truncationLimit?: number | null;
  provenanceMissingFields?: string[] | null;
  provenanceMissingRecords?: number | null;
  sourceClass?: "active_runtime" | "historical_import";
  sourceProduct?: string;
  activeRuntime?: boolean;
}

export function runtimeStatus(runtime: string | null, opts: RuntimeStatusOpts): JsonObject {
  const activeRuntime = opts.activeRuntime ?? (runtime !== null && ACTIVE_ANALYTICS_RUNTIMES.has(runtime));
  const item: JsonObject = {
    runtime,
    source_class: opts.sourceClass ?? (activeRuntime ? "active_runtime" : "historical_import"),
    source_product: opts.sourceProduct ?? runtime ?? "unknown",
    active_runtime: activeRuntime,
    status: opts.status,
    reason: opts.reason,
  };
  if (opts.storePath !== null && opts.storePath !== undefined) item.store_path = opts.storePath;
  if (opts.fileCount !== null && opts.fileCount !== undefined) item.file_count = opts.fileCount;
  if (opts.recordCount !== null && opts.recordCount !== undefined) item.record_count = opts.recordCount;
  if (opts.errorCount !== null && opts.errorCount !== undefined) item.error_count = opts.errorCount;
  if (opts.remediationLabels && opts.remediationLabels.length > 0) item.remediation_labels = opts.remediationLabels;
  if (opts.truncatedAt) item.truncated_at = opts.truncatedAt;
  if (opts.truncationCap) item.truncation_cap = opts.truncationCap;
  if (opts.truncationLimit !== null && opts.truncationLimit !== undefined) item.truncation_limit = opts.truncationLimit;
  if (opts.provenanceMissingFields && opts.provenanceMissingFields.length > 0) {
    item.provenance_missing_fields = opts.provenanceMissingFields;
  }
  if (opts.provenanceMissingRecords !== null && opts.provenanceMissingRecords !== undefined) {
    item.provenance_missing_records = opts.provenanceMissingRecords;
  }
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

export function discoverRuntimeStore(
  runtime: string | null,
  storePath: string | null,
  opts: { sourceProduct?: string; sourceClass?: "active_runtime" | "historical_import"; activeRuntime?: boolean; pattern?: string } = {},
): JsonObject {
  const statusOpts = {
    sourceProduct: opts.sourceProduct,
    sourceClass: opts.sourceClass,
    activeRuntime: opts.activeRuntime,
  };
  if (storePath === null) {
    return runtimeStatus(runtime, { status: "skipped", reason: "disabled", storePath: null, ...statusOpts });
  }
  if (!fs.existsSync(storePath)) {
    return runtimeStatus(runtime, {
      status: "missing",
      reason: "store_absent",
      storePath,
      remediationLabels: runtime === "copilot" ? [COPILOT_SPARSE_REMEDIATION] : null,
      ...statusOpts,
    });
  }
  if (isFilePath(storePath)) {
    return runtimeStatus(runtime, {
      status: "available",
      reason: "candidate_files_found",
      storePath,
      fileCount: 1,
      ...statusOpts,
    });
  }
  if (!isDir(storePath)) {
    return runtimeStatus(runtime, { status: "degraded", reason: "store_not_directory", storePath, ...statusOpts });
  }
  let candidates: string[];
  try {
    const pattern = opts.pattern ?? (runtime === null ? undefined : RUNTIME_STORE_GLOBS[runtime]);
    if (!pattern) throw new Error("no declared store pattern");
    candidates = rglob(storePath, pattern);
  } catch {
    return runtimeStatus(runtime, { status: "degraded", reason: "store_unreadable", storePath, ...statusOpts });
  }
  if (candidates.length === 0) {
    return runtimeStatus(runtime, {
      status: "sparse",
      reason: "no_candidate_files",
      storePath,
      fileCount: 0,
      remediationLabels: runtime === "copilot" ? [COPILOT_SPARSE_REMEDIATION] : null,
      ...statusOpts,
    });
  }
  return runtimeStatus(runtime, {
    status: "available",
    reason: "candidate_files_found",
    storePath,
    fileCount: candidates.length,
    ...statusOpts,
  });
}

// ── record builders + content helpers ──────────────────────────────

export function splitLines(text: string): string[] {
  const parts = text.split(/\r\n|\r|\n/);
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

export interface RecordOpts {
  sourceKind: string;
  timestamp: string;
  projectPath: string | null;
  runtime: string | null;
  sourceClass?: "active_runtime" | "historical_import" | "project";
  sourceProduct?: string;
  activeRuntime?: boolean;
  data: JsonObject;
  sourceParts: unknown[];
  sessionId?: string | null;
  origin?: string | null;
  originId?: string | null;
  authorClass?: string | null;
  content?: string | null;
}

export function record(opts: RecordOpts): JsonObject {
  const activeRuntime = opts.activeRuntime ?? (opts.runtime !== null && ACTIVE_ANALYTICS_RUNTIMES.has(opts.runtime));
  const item: JsonObject = {
    source_id: stableId(opts.sourceKind, ...opts.sourceParts),
    timestamp: opts.timestamp,
    project_id: projectIdFromPath(opts.projectPath),
    source_kind: opts.sourceKind,
    runtime: opts.runtime,
    source_class: opts.sourceClass ?? (activeRuntime ? "active_runtime" : "project"),
    source_product: opts.sourceProduct ?? opts.runtime ?? "unknown",
    active_runtime: activeRuntime,
    adapter_version: ADAPTER_VERSION,
    data: opts.data,
  };
  if (opts.projectPath !== null && opts.projectPath !== undefined) item.project_path = opts.projectPath;
  if (opts.sessionId) {
    item.session_id = opts.sessionId;
    item.conversation_key = opts.sessionId;
  }
  if (opts.originId) item.origin_id = opts.originId;
  else if (opts.origin) item.origin_id = originIdentity(opts.origin);
  else if (opts.sessionId) item.origin_id = originIdentity(`session:${opts.sessionId}`);
  if (opts.authorClass) item.author_class = opts.authorClass;
  if (typeof opts.content === "string") item.content_fingerprint = contentFingerprint(opts.content);
  return item;
}

function isPlainObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function payloadItem(event: JsonObject): JsonObject {
  const payload = event.payload;
  if (isPlainObject(payload)) {
    const nested = payload.item;
    if (isPlainObject(nested)) return nested;
    return payload;
  }
  return event;
}

export function eventKind(event: JsonObject): string {
  for (const key of ["type", "event", "name"]) {
    const value = event[key];
    if (typeof value === "string") return value;
  }
  return "";
}

export function eventTimestamp(item: JsonObject, fallback: string): string {
  const payload = isPlainObject(item.payload) ? item.payload : {};
  const nested = isPlainObject(payload.item) ? payload.item : {};
  for (const source of [item, payload, nested]) {
    for (const key of ["timestamp", "created_at", "createdAt", "time"]) {
      const value = (source as JsonObject)[key];
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

export function claudeContentItems(event: JsonObject): JsonObject[] {
  const items: JsonObject[] = [];
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

export function* iterJsonl(p: string, errors: string[]): Generator<JsonObject> {
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

export function toolCallRecordFromItem(args: {
  item: JsonObject;
  event: JsonObject;
  fallbackTimestamp: string;
  projectPath: string | null;
  runtime: string | null;
  sourceClass?: RecordOpts["sourceClass"];
  sourceProduct?: string;
  activeRuntime?: boolean;
  sourcePath: string;
  index: number;
  sessionId: string;
}): JsonObject | null {
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
    sourceClass: args.sourceClass,
    sourceProduct: args.sourceProduct,
    activeRuntime: args.activeRuntime,
    sourceParts: [resolvePath(args.sourcePath), args.index, "tool", toolName],
    sessionId: args.sessionId,
    originId: transportProvenance(args.event, args.item).originId,
    authorClass: "agent",
    data: { tool_name: toolName, arguments: argumentsVal as JsonValue }, // cast: parsed JSON IO boundary
  });
}

export function toolCallRecord(args: {
  event: JsonObject;
  fallbackTimestamp: string;
  projectPath: string | null;
  runtime: string | null;
  sourceClass?: RecordOpts["sourceClass"];
  sourceProduct?: string;
  activeRuntime?: boolean;
  sourcePath: string;
  index: number;
  sessionId: string;
}): JsonObject | null {
  return toolCallRecordFromItem({ ...args, item: payloadItem(args.event) });
}

export { isPlainObject, rglob, isDir, isFilePath };
