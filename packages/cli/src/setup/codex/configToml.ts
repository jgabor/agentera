import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isFile, pathExists, resolvePath } from "../../core/paths.js";
import { parseToml } from "../../core/toml.js";
import type { JsonObject } from "../../core/jsonValue.js";
import {
  CODEX_HOOK_COMMAND,
  CODEX_HOOK_MATCHER,
  CODEX_HOOK_STATUS_MESSAGE,
  CODEX_HOOK_TIMEOUT,
  CODEX_PLUGIN_HOOK_COMMAND,
  CODEX_PLUGIN_HOOK_SOURCE,
  CODEX_PLUGIN_ID,
  DEFAULT_AGENT_LIMITS,
  MANAGED_KEY,
  SECTION_NAME,
  SET_SUBTABLE_NAME,
} from "./constants.js";


export interface TomlState {
  sectionPresent: boolean;
  setPresent: boolean;
  setTable: Record<string, string>;
  sectionLevelHome: string | null;
}

/** Python repr() for a scalar, used to display non-string sibling set values. */
function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string") {
    return value.includes("'") && !value.includes('"') ? `"${value}"` : `'${value}'`;
  }
  return String(value);
}

export function classifyToml(text: string): TomlState {
  if (!text.trim()) {
    return { sectionPresent: false, setPresent: false, setTable: {}, sectionLevelHome: null };
  }
  const parsed = parseToml(text) as JsonObject;
  const section = parsed[SECTION_NAME];
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    return { sectionPresent: false, setPresent: false, setTable: {}, sectionLevelHome: null };
  }
  const sectionJsonObject = section as JsonObject;
  const sectionHome = sectionJsonObject[MANAGED_KEY];
  const sectionLevelHome =
    typeof sectionHome === "string" && sectionHome ? sectionHome : null;
  const setValue = sectionJsonObject.set;
  if (!setValue || typeof setValue !== "object" || Array.isArray(setValue)) {
    return { sectionPresent: true, setPresent: false, setTable: {}, sectionLevelHome };
  }
  const coerced: Record<string, string> = {};
  for (const [key, value] of Object.entries(setValue)) {
    coerced[String(key)] = typeof value === "string" ? value : pyRepr(value);
  }
  return { sectionPresent: true, setPresent: true, setTable: coerced, sectionLevelHome };
}

export function hasInlineSetLine(text: string): boolean {
  const plainLines = splitKeepEnds(text).map(rstripEol);
  const sectionIdx = findSectionHeaderIndex(plainLines);
  if (sectionIdx === null) return false;
  return findSetLineIndex(plainLines, sectionIdx) !== null;
}

export function hasSetSubtableHeader(text: string): boolean {
  const plainLines = splitKeepEnds(text).map(rstripEol);
  return findTableHeaderIndex(plainLines, SET_SUBTABLE_NAME) !== null;
}

export function managedHomeInSet(section: JsonObject): string | null {
  const setValue = section.set;
  if (!setValue || typeof setValue !== "object" || Array.isArray(setValue)) return null;
  const value = (setValue as JsonObject)[MANAGED_KEY];
  return typeof value === "string" && value ? value : null;
}

export function codexManagedHomeConfigured(text: string | null): boolean {
  if (!text || !text.trim()) return false;
  const parsed = parseToml(text) as JsonObject;
  const section = parsed[SECTION_NAME];
  if (!section || typeof section !== "object" || Array.isArray(section)) return false;
  return managedHomeInSet(section as JsonObject) !== null;
}

export function needsShellEnvNormalize(state: TomlState, text: string): boolean {
  if (state.sectionLevelHome !== null) return true;
  if (state.setPresent && !hasInlineSetLine(text)) return true;
  if (hasSetSubtableHeader(text)) return true;
  return false;
}

export function mergeSetPairs(section: JsonObject, installRoot: string): Record<string, string> {
  const pairs: Record<string, string> = {};
  const setValue = section.set;
  if (setValue && typeof setValue === "object" && !Array.isArray(setValue)) {
    for (const [key, value] of Object.entries(setValue as JsonObject)) {
      if (key === MANAGED_KEY) continue;
      pairs[String(key)] = typeof value === "string" ? value : pyRepr(value);
    }
  }
  pairs[MANAGED_KEY] = installRoot;
  return pairs;
}

function shellPolicySectionEnd(plainLines: string[], sectionIdx: number): number {
  let idx = sectionIdx + 1;
  while (idx < plainLines.length) {
    const line = plainLines[idx];
    if (SECTION_HEADER_RE.test(line)) return idx;
    if (tableHeaderRe(SET_SUBTABLE_NAME).test(line)) {
      idx += 1;
      while (idx < plainLines.length && !/^\s*\[/.test(plainLines[idx])) idx += 1;
      continue;
    }
    if (/^\s*\[/.test(line)) return idx;
    idx += 1;
  }
  return plainLines.length;
}

export function normalizeShellEnvironmentPolicy(text: string, installRoot: string): string {
  const parsed = parseToml(text) as JsonObject;
  const section = parsed[SECTION_NAME];
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    throw new Error(`normalize_shell_environment_policy: [${SECTION_NAME}] missing`);
  }
  const pairs = mergeSetPairs(section as JsonObject, installRoot);
  const linesWithEnds = splitKeepEnds(text);
  const plainLines = linesWithEnds.map(rstripEol);
  const sectionIdx = findSectionHeaderIndex(plainLines);
  if (sectionIdx === null) {
    throw new Error(`normalize_shell_environment_policy: [${SECTION_NAME}] header not found`);
  }
  const endIdx = shellPolicySectionEnd(plainLines, sectionIdx);
  const terminator = lineTerminator(linesWithEnds[sectionIdx]);
  const setLine = `set = ${emitSetInlineTable(pairs)}${terminator}`;
  return [...linesWithEnds.slice(0, sectionIdx + 1), setLine, ...linesWithEnds.slice(endIdx)].join("");
}

// ── TOML emission ──────────────────────────────────────────────────

const BASIC_STRING_ESCAPE: Record<string, string> = {
  "\\": "\\\\",
  '"': '\\"',
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

export function tomlBasicString(value: string): string {
  const escapedChars: string[] = [];
  for (const char of value) {
    if (char in BASIC_STRING_ESCAPE) {
      escapedChars.push(BASIC_STRING_ESCAPE[char]);
    } else if (char.charCodeAt(0) < 0x20) {
      escapedChars.push("\\u" + char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0"));
    } else {
      escapedChars.push(char);
    }
  }
  return '"' + escapedChars.join("") + '"';
}

export function emitSetInlineTable(pairs: Record<string, string>): string {
  const entries = Object.entries(pairs);
  const rendered = entries.map(([key, value]) => `${key} = ${tomlBasicString(value)}`).join(", ");
  return entries.length > 0 ? `{ ${rendered} }` : "{ }";
}

export function renderAgentsConfigSection(): string {
  return "[agents]\n" + Object.entries(DEFAULT_AGENT_LIMITS).map(([k, v]) => `${k} = ${v}`).join("\n") + "\n";
}

export function renderFreshConfig(installRoot: string): string {
  const setValue = emitSetInlineTable({ [MANAGED_KEY]: installRoot });
  return (
    `[${SECTION_NAME}]\nset = ${setValue}\n\n` +
    `${renderAgentsConfigSection()}\n` +
    `[features.multi_agent_v2]\n` +
    `max_concurrent_threads_per_session = 6\n`
  );
}

// ── Codex hook trust hashing ───────────────────────────────────────

/** Compact canonical JSON: sort_keys=True, separators=(",",":"), ensure_ascii. */
function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return jsonStringAscii(value);
  if (Array.isArray(value)) return "[" + value.map((v) => canonicalJson(v)).join(",") + "]";
  if (typeof value === "object") {
    const keys = Object.keys(value as JsonObject).sort();
    return "{" + keys.map((k) => `${jsonStringAscii(k)}:${canonicalJson((value as JsonObject)[k])}`).join(",") + "}";
  }
  return "null";
}

function jsonStringAscii(str: string): string {
  let out = '"';
  for (const ch of str) {
    const cp = ch.codePointAt(0) as number;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (cp === 0x08) out += "\\b";
    else if (cp === 0x09) out += "\\t";
    else if (cp === 0x0a) out += "\\n";
    else if (cp === 0x0c) out += "\\f";
    else if (cp === 0x0d) out += "\\r";
    else if (cp < 0x20) out += "\\u" + cp.toString(16).padStart(4, "0");
    else if (cp < 0x80) out += ch;
    else if (cp > 0xffff) {
      const v = cp - 0x10000;
      out += "\\u" + (0xd800 + (v >> 10)).toString(16).padStart(4, "0");
      out += "\\u" + (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, "0");
    } else {
      out += "\\u" + cp.toString(16).padStart(4, "0");
    }
  }
  return out + '"';
}

export function codexHookTrustedHash(
  eventLabel: string,
  matcher: string | null,
  command: string = CODEX_HOOK_COMMAND,
  timeout: number = CODEX_HOOK_TIMEOUT,
  statusMessage: string | null = CODEX_HOOK_STATUS_MESSAGE,
): string {
  const handler: JsonObject = { type: "command", command, timeout, async: false };
  if (statusMessage !== null) handler.statusMessage = statusMessage;
  const identity: JsonObject = { event_name: eventLabel, hooks: [handler] };
  if (matcher !== null) identity.matcher = matcher;
  const payload = canonicalJson(identity);
  return "sha256:" + crypto.createHash("sha256").update(payload, "utf8").digest("hex");
}

export function codexValidatorCommand(_installRoot: string): string {
  return CODEX_HOOK_COMMAND;
}

export function renderCodexHooksConfig(command: string): string {
  const hooks: JsonObject = {};
  for (const event of ["PreToolUse", "PostToolUse"]) {
    hooks[event] = [
      {
        matcher: CODEX_HOOK_MATCHER,
        hooks: [
          { type: "command", command, timeout: CODEX_HOOK_TIMEOUT, statusMessage: CODEX_HOOK_STATUS_MESSAGE },
        ],
      },
    ];
  }
  const payload = {
    description: "agentera v2 Codex hooks: schema-backed apply_patch artifact validation",
    hooks,
  };
  return JSON.stringify(payload, null, 2) + "\n";
}

export function codexHookStateEntries(hooksPath: string, command: string = CODEX_HOOK_COMMAND): Record<string, string> {
  const resolved = resolvePath(hooksPath);
  return {
    [`${resolved}:pre_tool_use:0:0`]: codexHookTrustedHash("pre_tool_use", CODEX_HOOK_MATCHER, command),
    [`${resolved}:post_tool_use:0:0`]: codexHookTrustedHash("post_tool_use", CODEX_HOOK_MATCHER, command),
  };
}

export function codexPluginHookStateEntries(command: string = CODEX_PLUGIN_HOOK_COMMAND): Record<string, string> {
  return {
    [`${CODEX_PLUGIN_HOOK_SOURCE}:pre_tool_use:0:0`]: codexHookTrustedHash("pre_tool_use", CODEX_HOOK_MATCHER, command),
    [`${CODEX_PLUGIN_HOOK_SOURCE}:post_tool_use:0:0`]: codexHookTrustedHash("post_tool_use", CODEX_HOOK_MATCHER, command),
  };
}

export function codexPluginHooksEnabled(text: string | null): boolean {
  if (!text || !text.trim()) return false;
  const parsed = parseToml(text) as JsonObject;
  const plugins = parsed.plugins;
  if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) return false;
  const agentera = (plugins as JsonObject)[CODEX_PLUGIN_ID];
  return Boolean(agentera && typeof agentera === "object" && !Array.isArray(agentera) && (agentera as JsonObject).enabled === true);
}

// ===========================================================================
// Slice 2: line-based TOML mutation engine
// ===========================================================================

function splitKeepEnds(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

function rstripEol(line: string): string {
  return line.replace(/[\r\n]+$/, "");
}

function lineTerminator(lineWithEnd: string): string {
  if (lineWithEnd.endsWith("\r\n")) return "\r\n";
  if (lineWithEnd.endsWith("\n")) return "\n";
  return "\n";
}

const SECTION_HEADER_RE = new RegExp(`^\\s*\\[\\s*${SECTION_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\]\\s*$`);
const SET_LINE_RE = /^\s*set\s*=\s*/;

export function findSectionHeaderIndex(lines: string[]): number | null {
  for (let idx = 0; idx < lines.length; idx++) {
    if (SECTION_HEADER_RE.test(lines[idx])) return idx;
  }
  return null;
}

export function findSetLineIndex(lines: string[], sectionIdx: number): number | null {
  for (let idx = sectionIdx + 1; idx < lines.length; idx++) {
    const line = lines[idx];
    if (SECTION_HEADER_RE.test(line)) return null;
    if (/^\s*\[/.test(line)) return null;
    if (SET_LINE_RE.test(line)) return idx;
  }
  return null;
}

export function insertSetLine(text: string, installRoot: string): string {
  const linesWithEnds = splitKeepEnds(text);
  const plainLines = linesWithEnds.map(rstripEol);
  const sectionIdx = findSectionHeaderIndex(plainLines);
  if (sectionIdx === null) {
    throw new Error(`insert_set_line called but [${SECTION_NAME}] header not found`);
  }
  const terminator = lineTerminator(linesWithEnds[sectionIdx]);
  const setValue = emitSetInlineTable({ [MANAGED_KEY]: installRoot });
  const insertedLine = `set = ${setValue}${terminator}`;
  return [...linesWithEnds.slice(0, sectionIdx + 1), insertedLine, ...linesWithEnds.slice(sectionIdx + 1)].join("");
}

export function rewriteSetLine(text: string, mergedPairs: Record<string, string>): string {
  const linesWithEnds = splitKeepEnds(text);
  const plainLines = linesWithEnds.map(rstripEol);
  const sectionIdx = findSectionHeaderIndex(plainLines);
  if (sectionIdx === null) {
    throw new Error(`rewrite_set_line called but [${SECTION_NAME}] header not found`);
  }
  const setIdx = findSetLineIndex(plainLines, sectionIdx);
  if (setIdx === null) {
    throw new Error(`rewrite_set_line called but no set line found in [${SECTION_NAME}]`);
  }
  const setLine = plainLines[setIdx];
  if (setLine.includes("{") && !setLine.includes("}")) {
    throw new Error("existing set value spans multiple lines; cannot safely merge");
  }
  const setLineWithEnd = linesWithEnds[setIdx];
  const terminator = setLineWithEnd.endsWith("\r\n") ? "\r\n" : setLineWithEnd.endsWith("\n") ? "\n" : "";
  const setValue = emitSetInlineTable(mergedPairs);
  const newLine = `set = ${setValue}${terminator}`;
  return [...linesWithEnds.slice(0, setIdx), newLine, ...linesWithEnds.slice(setIdx + 1)].join("");
}

function tableHeaderRe(table: string): RegExp {
  const dotted = table
    .split(".")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s*\\.\\s*");
  return new RegExp(`^\\s*\\[\\s*${dotted}\\s*\\]\\s*$`);
}

function findTableHeaderIndex(lines: string[], table: string): number | null {
  const pattern = tableHeaderRe(table);
  for (let idx = 0; idx < lines.length; idx++) {
    if (pattern.test(lines[idx])) return idx;
  }
  return null;
}

function findTableKeyIndex(lines: string[], tableIdx: number, keyLiteral: string): number | null {
  const keyRe = new RegExp(`^\\s*${keyLiteral.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`);
  for (let idx = tableIdx + 1; idx < lines.length; idx++) {
    const line = lines[idx];
    if (/^\s*\[/.test(line)) return null;
    if (keyRe.test(line)) return idx;
  }
  return null;
}

function insertTableKeyLine(text: string, table: string, line: string): string {
  const linesWithEnds = splitKeepEnds(text);
  const plainLines = linesWithEnds.map(rstripEol);
  const tableIdx = findTableHeaderIndex(plainLines, table);
  if (tableIdx === null) throw new Error(`[${table}] header not found`);
  const terminator = lineTerminator(linesWithEnds[tableIdx]);
  return [...linesWithEnds.slice(0, tableIdx + 1), line + terminator, ...linesWithEnds.slice(tableIdx + 1)].join("");
}

function replaceTableKeyLine(text: string, table: string, keyLiteral: string, line: string): string {
  const linesWithEnds = splitKeepEnds(text);
  const plainLines = linesWithEnds.map(rstripEol);
  const tableIdx = findTableHeaderIndex(plainLines, table);
  if (tableIdx === null) throw new Error(`[${table}] header not found`);
  const keyIdx = findTableKeyIndex(plainLines, tableIdx, keyLiteral);
  if (keyIdx === null) throw new Error(`${keyLiteral} not found in [${table}]`);
  if (plainLines[keyIdx].includes("{") && !plainLines[keyIdx].includes("}")) {
    throw new Error(`${keyLiteral} spans multiple lines in [${table}]`);
  }
  const terminator = lineTerminator(linesWithEnds[keyIdx]);
  return [...linesWithEnds.slice(0, keyIdx), line + terminator, ...linesWithEnds.slice(keyIdx + 1)].join("");
}

function appendTable(text: string, table: string, lines: string[]): string {
  let prefix = text;
  if (!prefix.endsWith("\n")) prefix += "\n";
  if (!prefix.endsWith("\n\n")) prefix += "\n";
  return prefix + `[${table}]\n` + lines.join("\n") + "\n";
}

function tomlLoadOrEmpty(text: string): JsonObject {
  return text.trim() ? (parseToml(text) as JsonObject) : {};
}

function ensureFeatureEnabled(text: string, key: string): string {
  const parsed = tomlLoadOrEmpty(text);
  const features = parsed.features;
  if (features && typeof features === "object" && !Array.isArray(features) && (features as JsonObject)[key] === true) {
    return text;
  }
  const lines = splitKeepEnds(text).map(rstripEol);
  const tableIdx = findTableHeaderIndex(lines, "features");
  if (tableIdx === null) {
    if (features && typeof features === "object" && !Array.isArray(features)) {
      if (lines.some((line) => /^\s*features\s*=/.test(line))) {
        throw new Error("[features] uses an unsupported inline or dotted-table form");
      }
    }
    return appendTable(text, "features", [`${key} = true`]);
  }
  const keyIdx = findTableKeyIndex(lines, tableIdx, key);
  if (keyIdx === null) return insertTableKeyLine(text, "features", `${key} = true`);
  return replaceTableKeyLine(text, "features", key, `${key} = true`);
}

function ensureFeaturesHooksEnabled(text: string): string {
  return ensureFeatureEnabled(text, "hooks");
}

function ensureFeaturesPluginHooksEnabled(text: string): string {
  return ensureFeatureEnabled(ensureFeaturesHooksEnabled(text), "plugin_hooks");
}

function removeTableKeyLine(text: string, table: string, key: string): string {
  const linesWithEnds = splitKeepEnds(text);
  const plainLines = linesWithEnds.map(rstripEol);
  const tableIdx = findTableHeaderIndex(plainLines, table);
  if (tableIdx === null) return text;
  const keyLiteral = tomlBasicString(key);
  let keyIdx = findTableKeyIndex(plainLines, tableIdx, keyLiteral);
  if (keyIdx === null) keyIdx = findTableKeyIndex(plainLines, tableIdx, key);
  if (keyIdx === null) return text;
  return [...linesWithEnds.slice(0, keyIdx), ...linesWithEnds.slice(keyIdx + 1)].join("");
}

function codexMultiAgentThreadLimit(parsed: JsonObject): number {
  const agents = parsed.agents;
  if (agents && typeof agents === "object" && !Array.isArray(agents) && "max_threads" in agents) {
    const n = Number((agents as JsonObject).max_threads);
    if (Number.isInteger(n)) return n;
  }
  const features = parsed.features;
  if (features && typeof features === "object" && !Array.isArray(features)) {
    const multi = (features as JsonObject).multi_agent_v2;
    if (multi && typeof multi === "object" && "max_concurrent_threads_per_session" in multi) {
      const n = Number((multi as JsonObject).max_concurrent_threads_per_session);
      if (Number.isInteger(n)) return n;
    }
  }
  return 6;
}

function ensureCodexMultiAgentV2(text: string, maxThreadsVal: number): string {
  const parsed = tomlLoadOrEmpty(text);
  const features = parsed.features;
  let multi: JsonObject = {};
  if (features && typeof features === "object" && !Array.isArray(features)) {
    const m = (features as JsonObject).multi_agent_v2;
    if (m && typeof m === "object" && !Array.isArray(m)) multi = m;
  }
  if (multi.max_concurrent_threads_per_session === maxThreadsVal) return text;
  const lines = splitKeepEnds(text).map(rstripEol);
  const tableIdx = findTableHeaderIndex(lines, "features.multi_agent_v2");
  const key = "max_concurrent_threads_per_session";
  const line = `${key} = ${maxThreadsVal}`;
  if (tableIdx === null) return appendTable(text, "features.multi_agent_v2", [line]);
  const keyIdx = findTableKeyIndex(lines, tableIdx, key);
  if (keyIdx === null) return insertTableKeyLine(text, "features.multi_agent_v2", line);
  return replaceTableKeyLine(text, "features.multi_agent_v2", key, line);
}

export function ensureCodexAgentLimits(text: string): string {
  let parsed = tomlLoadOrEmpty(text);
  const maxThreadsVal = codexMultiAgentThreadLimit(parsed);
  text = removeTableKeyLine(text, "agents", "max_threads");
  parsed = tomlLoadOrEmpty(text);
  const agents = parsed.agents;
  const agentsMatches =
    agents && typeof agents === "object" && !Array.isArray(agents) &&
    Object.entries(DEFAULT_AGENT_LIMITS).every(([k, v]) => (agents as JsonObject)[k] === v);
  if (!agentsMatches) {
    const lines = splitKeepEnds(text).map(rstripEol);
    const tableIdx = findTableHeaderIndex(lines, "agents");
    if (tableIdx === null) {
      if (agents && typeof agents === "object" && !Array.isArray(agents) && Object.keys(agents).length > 0) {
        throw new Error("[agents] uses an unsupported inline or child-table-only form");
      }
      text = appendTable(text, "agents", Object.entries(DEFAULT_AGENT_LIMITS).map(([k, v]) => `${k} = ${v}`));
    } else {
      for (const [key, value] of Object.entries(DEFAULT_AGENT_LIMITS)) {
        const line = `${key} = ${value}`;
        const curLines = splitKeepEnds(text).map(rstripEol);
        const curTableIdx = findTableHeaderIndex(curLines, "agents");
        if (curTableIdx === null) throw new Error("[agents] header disappeared during update");
        if (findTableKeyIndex(curLines, curTableIdx, key) === null) {
          text = insertTableKeyLine(text, "agents", line);
        } else {
          text = replaceTableKeyLine(text, "agents", key, line);
        }
      }
    }
  }
  return ensureCodexMultiAgentV2(text, maxThreadsVal);
}

function hookStateLine(key: string, trustedHash: string): string {
  return `${tomlBasicString(key)} = { trusted_hash = ${tomlBasicString(trustedHash)}, enabled = true }`;
}

function ensureCodexHookStateEntries(text: string, entries: Record<string, string>): string {
  const parsed = tomlLoadOrEmpty(text);
  const hooks = parsed.hooks;
  let state: JsonObject = {};
  if (hooks && typeof hooks === "object" && !Array.isArray(hooks)) {
    const s = (hooks as JsonObject).state;
    if (s && typeof s === "object" && !Array.isArray(s)) state = s;
  }
  const allPresent = Object.entries(entries).every(([key, trustedHash]) => {
    const e = state[key];
    return e && typeof e === "object" && !Array.isArray(e) && e.trusted_hash === trustedHash && e.enabled === true;
  });
  if (allPresent) return text;

  const lines = splitKeepEnds(text).map(rstripEol);
  const tableIdx = findTableHeaderIndex(lines, "hooks.state");
  if (tableIdx === null) {
    if (Object.keys(state).length > 0) {
      throw new Error("[hooks.state] uses an unsupported inline or dotted-table form");
    }
    return appendTable(
      text,
      "hooks.state",
      Object.entries(entries).map(([key, trustedHash]) => hookStateLine(key, trustedHash)),
    );
  }
  for (const [key, trustedHash] of Object.entries(entries)) {
    const keyLiteral = tomlBasicString(key);
    const line = hookStateLine(key, trustedHash);
    const curLines = splitKeepEnds(text).map(rstripEol);
    const curTableIdx = findTableHeaderIndex(curLines, "hooks.state");
    if (curTableIdx === null) throw new Error("[hooks.state] header disappeared during update");
    if (findTableKeyIndex(curLines, curTableIdx, keyLiteral) === null) {
      text = insertTableKeyLine(text, "hooks.state", line);
    } else {
      text = replaceTableKeyLine(text, "hooks.state", keyLiteral, line);
    }
  }
  return text;
}

export function ensureCodexHookTrust(text: string, hooksPath: string, command: string = CODEX_HOOK_COMMAND): string {
  return ensureCodexHookStateEntries(ensureFeaturesHooksEnabled(text), codexHookStateEntries(hooksPath, command));
}

export function codexCopiedHooksAreAgenteraOnly(text: string): boolean {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return false;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const p = payload as JsonObject;
  if (typeof p.description !== "string" || !p.description.includes("agentera v2 Codex hooks")) return false;
  const hooks = p.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return false;
  const keys = Object.keys(hooks);
  if (keys.length === 0) return false;
  for (const key of keys) {
    if (key !== "PreToolUse" && key !== "PostToolUse") return false;
  }
  for (const [event, entries] of Object.entries(hooks)) {
    if (event !== "PreToolUse" && event !== "PostToolUse") return false;
    if (!Array.isArray(entries) || entries.length !== 1) return false;
    const entry = entries[0];
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || entry.matcher !== CODEX_HOOK_MATCHER) return false;
    const handlers = entry.hooks;
    if (!Array.isArray(handlers) || handlers.length !== 1) return false;
    const handler = handlers[0];
    if (!handler || typeof handler !== "object" || Array.isArray(handler)) return false;
    const command = handler.command;
    if (handler.type !== "command" || typeof command !== "string") return false;
    if (!command.includes("hooks/validate_artifact.py") && !command.includes("hook validate-artifact")) return false;
    if (handler.timeout !== undefined && handler.timeout !== CODEX_HOOK_TIMEOUT) return false;
    if (handler.statusMessage !== undefined && handler.statusMessage !== CODEX_HOOK_STATUS_MESSAGE) return false;
  }
  return true;
}

export function retireCodexCopiedHookTrust(text: string, hooksPath: string): string {
  if (pathExists(hooksPath)) {
    let hooksText: string;
    try {
      hooksText = fs.readFileSync(hooksPath, "utf8");
    } catch {
      return text;
    }
    if (!codexCopiedHooksAreAgenteraOnly(hooksText)) return text;
  }
  const resolved = resolvePath(hooksPath);
  text = removeTableKeyLine(text, "hooks.state", `${resolved}:pre_tool_use:0:0`);
  text = removeTableKeyLine(text, "hooks.state", `${resolved}:post_tool_use:0:0`);
  return text;
}

export function ensureCodexPluginHookTrust(
  text: string,
  command: string = CODEX_PLUGIN_HOOK_COMMAND,
  hooksPath: string | null = null,
): string {
  text = ensureCodexHookStateEntries(ensureFeaturesPluginHooksEnabled(text), codexPluginHookStateEntries(command));
  const target = hooksPath ?? path.join(os.homedir(), ".codex", "hooks.json");
  return retireCodexCopiedHookTrust(text, target);
}
