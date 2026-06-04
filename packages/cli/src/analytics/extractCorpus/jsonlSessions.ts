import fs from "node:fs";
import path from "node:path";

import { resolvePath } from "../../core/paths.js";
import {
  type Dict,
  claudeContentItems,
  eventKind,
  eventTimestamp,
  isPlainObject,
  isoFromMtime,
  iterJsonl,
  payloadItem,
  record,
  rglob,
  signalType,
  textFromContent,
  toolCallRecord,
  toolCallRecordFromItem,
} from "./core.js";

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
