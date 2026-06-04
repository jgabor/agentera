import fs from "node:fs";

import { resolvePath } from "../../core/paths.js";
import {
  type Dict,
  MAX_SQLITE_ROWS,
  isoFromMtime,
  record,
  signalType,
  textFromContent,
} from "./core.js";
import { isPlainObject, rglob, isFilePath } from "./core.js";
import {
  type SqliteDb,
  PermissionDeniedError,
  openSqlite,
  sqliteTimestamp,
  tableColumns,
  firstColumn,
  qualified,
} from "./sqliteSessions.js";

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
