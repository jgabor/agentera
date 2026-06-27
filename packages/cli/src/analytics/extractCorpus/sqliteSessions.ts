import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { resolvePath } from "../../core/paths.js";
import type { JsonValue } from "../../core/jsonValue.js";
import {
  type Dict,
  isoFromMtime,
  record,
  signalType,
  textFromContent,
} from "./core.js";
import { isPlainObject, isFilePath, rglob } from "./core.js";
import {
  type SqliteCaps,
  type SqliteTruncationInfo,
  resolveSqliteCaps,
} from "./sqliteCaps.js";

const requireCjs = createRequire(import.meta.url);

export interface SqliteDb {
  prepare(sql: string): { all(...params: unknown[]): Dict[]; get(...params: unknown[]): Dict | undefined };
  close(): void;
}

/** Mirrors Python raising PermissionError on a locked/busy store. */
export class PermissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionDeniedError";
  }
}

export interface ExtractorContext {
  sqliteCaps?: SqliteCaps;
  truncation?: SqliteTruncationInfo | null;
}

/** Lazy open a read-only SQLite db via node:sqlite (warning only fires here). */
export function openSqlite(p: string): SqliteDb {
  const { DatabaseSync } = requireCjs("node:sqlite");
  return new DatabaseSync(resolvePath(p), { readOnly: true }) as SqliteDb;
}

export function sqliteTimestamp(value: unknown, fallback: string): string {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number") {
    let numeric = value;
    if (numeric > 10_000_000_000) numeric /= 1000;
    return new Date(numeric * 1000).toISOString();
  }
  return fallback;
}

export function jsonDict(value: unknown): Dict {
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

export function tableColumns(conn: SqliteDb, table: string): Set<string> {
  const rows = conn.prepare(`PRAGMA table_info(${table})`).all();
  return new Set(rows.map((r) => String(r.name)));
}
export function firstColumn(columns: Set<string>, candidates: string[]): string | null {
  for (const c of candidates) if (columns.has(c)) return c;
  return null;
}
export function qualified(alias: string, column: string | null, label: string): string {
  if (column === null) return `NULL AS ${label}`;
  const escaped = column.replace(/"/g, '""');
  return `${alias}."${escaped}" AS ${label}`;
}

interface OpencodeSchema {
  sessionId: string;
  messageId: string;
  messageSession: string;
  partMessage: string;
  messageData: string | null;
  partData: string | null;
  roleCol: string | null;
  messageTime: string | null;
  partTime: string | null;
  sessionTime: string | null;
  sessionUpdated: string | null;
  projectCol: string | null;
  messageText: string | null;
  partText: string | null;
  partType: string | null;
  partId: string | null;
  sortExpr: string;
  recentSessionExpr: string;
}

interface OpencodeMessage {
  role: JsonValue;
  session_id: string;
  project_path: JsonValue;
  timestamp: string;
  parts: string[];
  tools: OpencodeTool[];
}

interface OpencodeTool {
  part_id: JsonValue;
  tool_name: string;
  arguments: Dict;
  timestamp: string;
}

function resolveOpencodeSchema(conn: SqliteDb): OpencodeSchema {
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
  return {
    sessionId,
    messageId,
    messageSession,
    partMessage,
    messageData,
    partData,
    roleCol,
    messageTime,
    partTime,
    sessionTime,
    sessionUpdated,
    projectCol,
    messageText,
    partText,
    partType,
    partId,
    sortExpr,
    recentSessionExpr,
  };
}

function opencodeRows(conn: SqliteDb, caps: SqliteCaps, schema: OpencodeSchema): Dict[] {
  const {
    sessionId,
    messageId,
    messageSession,
    partMessage,
    messageData,
    partData,
    roleCol,
    messageTime,
    partTime,
    sessionTime,
    projectCol,
    messageText,
    partText,
    partType,
    partId,
    sortExpr,
    recentSessionExpr,
  } = schema;
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
  return conn.prepare(query).all(caps.maxSessions, caps.maxRows);
}

export function probeOpencodeTruncation(
  conn: SqliteDb,
  caps: SqliteCaps,
  fallback: string,
): SqliteTruncationInfo | null {
  const schema = resolveOpencodeSchema(conn);
  const { sessionId, sessionTime, sessionUpdated, recentSessionExpr } = schema;
  const sessionTimeCol = sessionTime || sessionId;
  const sessionCount = Number(conn.prepare("SELECT COUNT(*) AS c FROM session").get()?.c ?? 0);
  if (sessionCount > caps.maxSessions) {
    const query = `
      SELECT MIN(session_ts) AS truncated_at
      FROM (
        SELECT s."${sessionTimeCol}" AS session_ts
        FROM session s
        ORDER BY ${recentSessionExpr} DESC,
                 s."${sessionId}" DESC
        LIMIT -1 OFFSET ?
      )
    `;
    const row = conn.prepare(query).get(caps.maxSessions);
    const truncatedAt = sqliteTimestamp(row?.truncated_at, fallback);
    return { truncatedAt, cap: "sessions", limit: caps.maxSessions };
  }

  const {
    messageId,
    messageSession,
    partMessage,
    roleCol,
    messageTime,
    partTime,
    messageData,
    partData,
    messageText,
    partText,
    partType,
    partId,
    sortExpr,
  } = schema;
  const rowCountQuery = `
    WITH recent_sessions AS (
      SELECT s."${sessionId}" AS recent_session_id
      FROM session s
      ORDER BY ${recentSessionExpr} DESC,
               s."${sessionId}" DESC
      LIMIT ?
    )
    SELECT COUNT(*) AS c
    FROM message m
    JOIN session s ON m."${messageSession}" = s."${sessionId}"
    JOIN recent_sessions rs ON rs.recent_session_id = s."${sessionId}"
    LEFT JOIN part p ON p."${partMessage}" = m."${messageId}"
  `;
  const rowCount = Number(conn.prepare(rowCountQuery).get(caps.maxSessions)?.c ?? 0);
  if (rowCount > caps.maxRows) {
    const query = `
      WITH recent_sessions AS (
        SELECT s."${sessionId}" AS recent_session_id
        FROM session s
        ORDER BY ${recentSessionExpr} DESC,
                 s."${sessionId}" DESC
        LIMIT ?
      ),
      ranked AS (
        SELECT ${sortExpr} AS sort_time
        FROM message m
        JOIN session s ON m."${messageSession}" = s."${sessionId}"
        JOIN recent_sessions rs ON rs.recent_session_id = s."${sessionId}"
        LEFT JOIN part p ON p."${partMessage}" = m."${messageId}"
        ORDER BY sort_time DESC,
                 m."${messageId}" DESC,
                 p."${partId || partMessage}" DESC
        LIMIT -1 OFFSET ?
      )
      SELECT MIN(sort_time) AS truncated_at FROM ranked
    `;
    const row = conn.prepare(query).get(caps.maxSessions, caps.maxRows);
    const truncatedAt = sqliteTimestamp(row?.truncated_at, fallback);
    return { truncatedAt, cap: "rows", limit: caps.maxRows };
  }
  return null;
}

function opencodeDbCandidates(storePath: string): string[] {
  if (isFilePath(storePath)) return [storePath];
  return rglob(storePath, "opencode.db");
}

export function extractOpencodeSessions(
  storePath: string | null,
  errors: string[],
  ctx?: ExtractorContext,
): Dict[] {
  if (storePath === null || !fs.existsSync(storePath)) return [];
  const caps = ctx?.sqliteCaps ?? resolveSqliteCaps();
  const records: Dict[] = [];
  for (const dbPath of opencodeDbCandidates(storePath).slice(0, 1)) {
    const fallbackTimestamp = isoFromMtime(dbPath);
    let rows: Dict[];
    let conn: SqliteDb | null = null;
    try {
      conn = openSqlite(dbPath);
      const truncation = probeOpencodeTruncation(conn, caps, fallbackTimestamp);
      if (truncation && ctx) ctx.truncation = truncation;
      const schema = resolveOpencodeSchema(conn);
      rows = opencodeRows(conn, caps, schema);
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

    const messages = new Map<string, OpencodeMessage>();
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
          tools: [] as OpencodeTool[],
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
      const content = item.parts.filter((p: string) => p).join("\n");
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
      for (const toolItem of item.tools) {
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
