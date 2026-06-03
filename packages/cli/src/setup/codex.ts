import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expanduser, isFile, pathExists, resolvePath } from "../core/paths.js";
import { splitLinesKeepEnds, unifiedDiff } from "../core/difflib.js";
import { parseToml } from "../core/toml.js";
import { SETUP_EVIDENCE, classifyResolvedRoot } from "../state/installRoot.js";

/**
 * Idempotently inject AGENTERA_HOME into Codex's shell-tool environment.
 * Faithful TS port of scripts/setup_codex.py (slice 1: install-root resolution,
 * TOML classification/emission/render, Codex hook trust-hash). The line-based
 * config mutation + plan/apply + CLI land in subsequent slices.
 *
 * NOTE: CODEX_HOOK_COMMAND uses the current uv-run form; the node-form rewiring
 * happens in the Phase 9 cutover.
 */

type Dict = Record<string, any>;
type Env = Record<string, string | undefined>;

export const CANONICAL_ENTRIES = SETUP_EVIDENCE;
export const MANAGED_KEY = "AGENTERA_HOME";
export const SECTION_NAME = "shell_environment_policy";
export const DEFAULT_AGENT_LIMITS: Record<string, number> = { max_depth: 1 };
export const CAPABILITY_AGENT_NAMES = [
  "hej",
  "visionera",
  "resonera",
  "inspirera",
  "planera",
  "realisera",
  "optimera",
  "inspektera",
  "dokumentera",
  "profilera",
  "visualisera",
  "orkestrera",
] as const;
const ENV_FALLBACKS = ["AGENTERA_HOME", "CLAUDE_PLUGIN_ROOT"] as const;

export const CODEX_HOOK_COMMAND = "npx -y agentera@next hook validate-artifact";
export const CODEX_PLUGIN_ID = "agentera@agentera";
export const CODEX_PLUGIN_HOOKS_PATH = "hooks/codex-plugin-hooks.json";
export const CODEX_PLUGIN_HOOK_SOURCE = `${CODEX_PLUGIN_ID}:${CODEX_PLUGIN_HOOKS_PATH}`;
export const CODEX_PLUGIN_HOOK_COMMAND = "npx -y agentera@next hook validate-artifact";
export const CODEX_HOOK_MATCHER = "^apply_patch$";
export const CODEX_HOOK_TIMEOUT = 10;
export const CODEX_HOOK_STATUS_MESSAGE = "validating artifact";

export function defaultConfigPath(home: string = os.homedir()): string {
  return path.join(home, ".codex", "config.toml");
}

export class InstallRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallRootError";
  }
}

export function verifyInstallRoot(root: string): string[] {
  const classification = classifyResolvedRoot(root, { source: "explicit" });
  if (classification.kind === "managed_fresh") {
    return [];
  }
  return SETUP_EVIDENCE.filter((entry) => !pathExists(path.join(root, entry)));
}

export function autoDetectInstallRoot(start: string | null = null, env: Env = process.env): string | null {
  for (const variable of ENV_FALLBACKS) {
    const candidate = env[variable];
    if (candidate) {
      const p = resolvePath(candidate);
      if (verifyInstallRoot(p).length === 0) {
        return p;
      }
    }
  }
  let current = resolvePath(start === null ? process.cwd() : start);
  for (;;) {
    if (verifyInstallRoot(current).length === 0) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function resolveInstallRoot(explicit: string | null, env: Env = process.env): string {
  if (explicit !== null && explicit !== undefined) {
    const root = resolvePath(explicit);
    if (classifyResolvedRoot(root, { source: "explicit" }).kind !== "managed_fresh") {
      const missing = verifyInstallRoot(root);
      throw new InstallRootError(
        `--install-root ${root} is not a valid Agentera directory: ` +
          `missing canonical entries: ${missing.join(", ")}`,
      );
    }
    return root;
  }
  const detected = autoDetectInstallRoot(null, env);
  if (detected === null) {
    throw new InstallRootError(
      "could not auto-detect the Agentera directory. " +
        "Pass --install-root PATH where PATH contains " +
        `${CANONICAL_ENTRIES.join(", ")}.`,
    );
  }
  return detected;
}

// ── TOML state classification ──────────────────────────────────────

export interface TomlState {
  sectionPresent: boolean;
  setPresent: boolean;
  setTable: Record<string, string>;
  sectionLevelHome: string | null;
}

export const SET_SUBTABLE_NAME = `${SECTION_NAME}.set`;

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
  const parsed = parseToml(text) as Dict;
  const section = parsed[SECTION_NAME];
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    return { sectionPresent: false, setPresent: false, setTable: {}, sectionLevelHome: null };
  }
  const sectionDict = section as Dict;
  const sectionHome = sectionDict[MANAGED_KEY];
  const sectionLevelHome =
    typeof sectionHome === "string" && sectionHome ? sectionHome : null;
  const setValue = sectionDict.set;
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

export function managedHomeInSet(section: Dict): string | null {
  const setValue = section.set;
  if (!setValue || typeof setValue !== "object" || Array.isArray(setValue)) return null;
  const value = (setValue as Dict)[MANAGED_KEY];
  return typeof value === "string" && value ? value : null;
}

export function codexManagedHomeConfigured(text: string | null): boolean {
  if (!text || !text.trim()) return false;
  const parsed = parseToml(text) as Dict;
  const section = parsed[SECTION_NAME];
  if (!section || typeof section !== "object" || Array.isArray(section)) return false;
  return managedHomeInSet(section as Dict) !== null;
}

export function needsShellEnvNormalize(state: TomlState, text: string): boolean {
  if (state.sectionLevelHome !== null) return true;
  if (state.setPresent && !hasInlineSetLine(text)) return true;
  if (hasSetSubtableHeader(text)) return true;
  return false;
}

export function mergeSetPairs(section: Dict, installRoot: string): Record<string, string> {
  const pairs: Record<string, string> = {};
  const setValue = section.set;
  if (setValue && typeof setValue === "object" && !Array.isArray(setValue)) {
    for (const [key, value] of Object.entries(setValue as Dict)) {
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
  const parsed = parseToml(text) as Dict;
  const section = parsed[SECTION_NAME];
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    throw new Error(`normalize_shell_environment_policy: [${SECTION_NAME}] missing`);
  }
  const pairs = mergeSetPairs(section as Dict, installRoot);
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
    const keys = Object.keys(value as Dict).sort();
    return "{" + keys.map((k) => `${jsonStringAscii(k)}:${canonicalJson((value as Dict)[k])}`).join(",") + "}";
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
  const handler: Dict = { type: "command", command, timeout, async: false };
  if (statusMessage !== null) handler.statusMessage = statusMessage;
  const identity: Dict = { event_name: eventLabel, hooks: [handler] };
  if (matcher !== null) identity.matcher = matcher;
  const payload = canonicalJson(identity);
  return "sha256:" + crypto.createHash("sha256").update(payload, "utf8").digest("hex");
}

export function codexValidatorCommand(installRoot: string): string {
  const candidates = [
    path.join(installRoot, "app", "hooks", "validate_artifact.py"),
    path.join(installRoot, "hooks", "validate_artifact.py"),
  ];
  const validator = candidates.find((c) => isFile(c)) ?? candidates[0];
  return `uv run "${validator}"`;
}

export function renderCodexHooksConfig(command: string): string {
  const hooks: Dict = {};
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
  const parsed = parseToml(text) as Dict;
  const plugins = parsed.plugins;
  if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) return false;
  const agentera = (plugins as Dict)[CODEX_PLUGIN_ID];
  return Boolean(agentera && typeof agentera === "object" && agentera.enabled === true);
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

function tomlLoadOrEmpty(text: string): Dict {
  return text.trim() ? (parseToml(text) as Dict) : {};
}

function ensureFeatureEnabled(text: string, key: string): string {
  const parsed = tomlLoadOrEmpty(text);
  const features = parsed.features;
  if (features && typeof features === "object" && !Array.isArray(features) && (features as Dict)[key] === true) {
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

function codexMultiAgentThreadLimit(parsed: Dict): number {
  const agents = parsed.agents;
  if (agents && typeof agents === "object" && !Array.isArray(agents) && "max_threads" in agents) {
    const n = Number((agents as Dict).max_threads);
    if (Number.isInteger(n)) return n;
  }
  const features = parsed.features;
  if (features && typeof features === "object" && !Array.isArray(features)) {
    const multi = (features as Dict).multi_agent_v2;
    if (multi && typeof multi === "object" && "max_concurrent_threads_per_session" in multi) {
      const n = Number((multi as Dict).max_concurrent_threads_per_session);
      if (Number.isInteger(n)) return n;
    }
  }
  return 6;
}

function ensureCodexMultiAgentV2(text: string, maxThreadsVal: number): string {
  const parsed = tomlLoadOrEmpty(text);
  const features = parsed.features;
  let multi: Dict = {};
  if (features && typeof features === "object" && !Array.isArray(features)) {
    const m = (features as Dict).multi_agent_v2;
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
    Object.entries(DEFAULT_AGENT_LIMITS).every(([k, v]) => (agents as Dict)[k] === v);
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
  let state: Dict = {};
  if (hooks && typeof hooks === "object" && !Array.isArray(hooks)) {
    const s = (hooks as Dict).state;
    if (s && typeof s === "object" && !Array.isArray(s)) state = s;
  }
  const allPresent = Object.entries(entries).every(([key, trustedHash]) => {
    const e = state[key];
    return e && typeof e === "object" && e.trusted_hash === trustedHash && e.enabled === true;
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
  const p = payload as Dict;
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
    if (!entry || typeof entry !== "object" || entry.matcher !== CODEX_HOOK_MATCHER) return false;
    const handlers = entry.hooks;
    if (!Array.isArray(handlers) || handlers.length !== 1) return false;
    const handler = handlers[0];
    if (!handler || typeof handler !== "object") return false;
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

// ===========================================================================
// Slice 3: plan/apply orchestration, agent descriptors, CLI
// ===========================================================================

export const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".codex", "config.toml");

export interface Outcome {
  action: string;
  newText: string;
  message: string;
  diff: string;
}

function unifiedDiffText(before: string, after: string): string {
  return unifiedDiff(
    splitLinesKeepEnds(before),
    splitLinesKeepEnds(after),
    "config.toml (current)",
    "config.toml (proposed)",
    "",
    "",
    3,
  ).join("");
}

function conflictDiffText(currentTable: Record<string, string>, mergedTable: Record<string, string>): string {
  const currentInline = emitSetInlineTable(currentTable);
  const mergedInline = emitSetInlineTable(mergedTable);
  return `current:  set = ${currentInline}\nproposed: set = ${mergedInline}\n`;
}

function withCodexHookTrust(
  outcome: Outcome,
  beforeText: string | null,
  hooksPath: string | null,
  hookCommand: string = CODEX_HOOK_COMMAND,
  pluginHooks = false,
): Outcome {
  if (outcome.action === "conflict") return outcome;
  const before = beforeText || "";

  let newText: string;
  try {
    newText = ensureCodexAgentLimits(outcome.newText);
  } catch (exc) {
    return {
      action: "conflict",
      newText: "",
      message: `cannot safely update Codex agent dispatch settings: ${(exc as Error).message}`,
      diff: "",
    };
  }

  if (newText !== outcome.newText) {
    const action = outcome.action !== "noop" ? outcome.action : "insert";
    const message =
      outcome.action === "noop"
        ? "would configure Codex agent dispatch limits"
        : `${outcome.message}; would configure Codex agent dispatch limits`;
    outcome = { action, newText, message, diff: unifiedDiffText(before, newText) };
  }

  if (hooksPath === null && !pluginHooks) return outcome;

  try {
    if (pluginHooks) {
      newText = ensureCodexPluginHookTrust(outcome.newText, CODEX_PLUGIN_HOOK_COMMAND, hooksPath);
    } else if (hooksPath !== null) {
      newText = ensureCodexHookTrust(outcome.newText, hooksPath, hookCommand);
    } else {
      newText = outcome.newText;
    }
  } catch (exc) {
    return {
      action: "conflict",
      newText: "",
      message: `cannot safely update Codex hook trust state: ${(exc as Error).message}`,
      diff: "",
    };
  }

  if (newText === outcome.newText) return outcome;

  const action = outcome.action !== "noop" ? outcome.action : "insert";
  let message: string;
  if (outcome.action === "noop") {
    message = pluginHooks
      ? "would trust Codex plugin apply_patch hooks in config.toml"
      : "would trust Codex apply_patch hooks in config.toml";
  } else {
    const hookLabel = pluginHooks ? "Codex plugin apply_patch hooks" : "Codex apply_patch hooks";
    message = `${outcome.message}; would trust ${hookLabel}`;
  }
  return { action, newText, message, diff: unifiedDiffText(before, newText) };
}

export function planChange(
  currentText: string | null,
  installRoot: string,
  opts: { force: boolean; hooksPath?: string | null; hookCommand?: string; pluginHooks?: boolean },
): Outcome {
  const force = opts.force;
  const hooksPath = opts.hooksPath ?? null;
  const hookCommand = opts.hookCommand ?? CODEX_HOOK_COMMAND;
  const pluginHooks = opts.pluginHooks ?? false;
  const desiredPath = installRoot;

  // Branch 1: file absent (or empty) -> write fresh config.
  if (currentText === null || !currentText.trim()) {
    const newText = renderFreshConfig(installRoot);
    return withCodexHookTrust(
      {
        action: "fresh",
        newText,
        message: `would write fresh config with ${SECTION_NAME}.set.${MANAGED_KEY} = ${desiredPath}`,
        diff: unifiedDiffText("", newText),
      },
      currentText,
      hooksPath,
      hookCommand,
      pluginHooks,
    );
  }

  const state = classifyToml(currentText);
  const parsed = parseToml(currentText) as Dict;
  const section = parsed[SECTION_NAME];
  const sectionDict =
    section && typeof section === "object" && !Array.isArray(section) ? (section as Dict) : {};

  if (needsShellEnvNormalize(state, currentText)) {
    const canonical =
      state.sectionLevelHome === null &&
      hasInlineSetLine(currentText) &&
      !hasSetSubtableHeader(currentText) &&
      state.setTable[MANAGED_KEY] === desiredPath;
    if (!canonical) {
      try {
        const newText = normalizeShellEnvironmentPolicy(currentText, installRoot);
        if (newText !== currentText) {
          return withCodexHookTrust(
            {
              action: "normalize",
              newText,
              message: `would normalize [${SECTION_NAME}] to inline set = { ${MANAGED_KEY} = ${desiredPath} }`,
              diff: unifiedDiffText(currentText, newText),
            },
            currentText,
            hooksPath,
            hookCommand,
            pluginHooks,
          );
        }
      } catch (exc) {
        return {
          action: "conflict",
          newText: "",
          message: `cannot normalize [${SECTION_NAME}] layout: ${(exc as Error).message}. Edit ~/.codex/config.toml manually.`,
          diff: "",
        };
      }
    }
  }

  // Branch 2: section absent -> append a fresh section at EOF.
  if (!state.sectionPresent) {
    let prefix = currentText;
    if (!prefix.endsWith("\n")) prefix += "\n";
    if (!prefix.endsWith("\n\n")) prefix += "\n";
    const newText = prefix + renderFreshConfig(installRoot);
    return withCodexHookTrust(
      {
        action: "fresh",
        newText,
        message: `would append [${SECTION_NAME}] section with ${MANAGED_KEY} = ${desiredPath}`,
        diff: unifiedDiffText(currentText, newText),
      },
      currentText,
      hooksPath,
      hookCommand,
      pluginHooks,
    );
  }

  // Branch 3a: section present, no set key -> insert set line.
  if (!state.setPresent) {
    const newText = insertSetLine(currentText, installRoot);
    return withCodexHookTrust(
      {
        action: "insert",
        newText,
        message: `would insert set = { ${MANAGED_KEY} = ${desiredPath} } into [${SECTION_NAME}]`,
        diff: unifiedDiffText(currentText, newText),
      },
      currentText,
      hooksPath,
      hookCommand,
      pluginHooks,
    );
  }

  // Branch 3b: AGENTERA_HOME already correct -> noop.
  const currentValue = state.setTable[MANAGED_KEY];
  if (currentValue === desiredPath) {
    return withCodexHookTrust(
      {
        action: "noop",
        newText: currentText,
        message: `${MANAGED_KEY} already set to ${desiredPath}; nothing to do`,
        diff: "",
      },
      currentText,
      hooksPath,
      hookCommand,
      pluginHooks,
    );
  }

  // Branch 3c: wrong value or sibling keys.
  const siblings: Record<string, string> = {};
  for (const [k, v] of Object.entries(state.setTable)) {
    if (k !== MANAGED_KEY) siblings[k] = v;
  }
  const merged: Record<string, string> = { ...state.setTable, [MANAGED_KEY]: desiredPath };

  if (MANAGED_KEY in state.setTable && Object.keys(siblings).length === 0) {
    let newText: string;
    try {
      newText = rewriteSetLine(currentText, merged);
    } catch (exc) {
      return {
        action: "conflict",
        newText: "",
        message: `${MANAGED_KEY} present but cannot be safely updated: ${(exc as Error).message}. Edit ~/.codex/config.toml manually.`,
        diff: "",
      };
    }
    return withCodexHookTrust(
      {
        action: "insert",
        newText,
        message: `would update ${MANAGED_KEY} from ${state.setTable[MANAGED_KEY]} to ${desiredPath}`,
        diff: unifiedDiffText(currentText, newText),
      },
      currentText,
      hooksPath,
      hookCommand,
      pluginHooks,
    );
  }

  if (Object.keys(siblings).length === 0 && !(MANAGED_KEY in state.setTable)) {
    let newText: string;
    try {
      newText = hasInlineSetLine(currentText)
        ? rewriteSetLine(currentText, merged)
        : normalizeShellEnvironmentPolicy(currentText, installRoot);
    } catch (exc) {
      return {
        action: "conflict",
        newText: "",
        message: `cannot add ${MANAGED_KEY} to [${SECTION_NAME}]: ${(exc as Error).message}. Edit ~/.codex/config.toml manually.`,
        diff: "",
      };
    }
    return withCodexHookTrust(
      {
        action: "insert",
        newText,
        message: `would set ${MANAGED_KEY} = ${desiredPath} in [${SECTION_NAME}].set`,
        diff: unifiedDiffText(currentText, newText),
      },
      currentText,
      hooksPath,
      hookCommand,
      pluginHooks,
    );
  }

  if (!force) {
    return {
      action: "conflict",
      newText: "",
      message: `[${SECTION_NAME}].set has sibling keys (${Object.keys(siblings).sort().join(", ")}). Re-run with --force to merge ${MANAGED_KEY} = ${desiredPath} alongside them.`,
      diff: conflictDiffText(state.setTable, merged),
    };
  }

  let newText: string;
  try {
    newText = rewriteSetLine(currentText, merged);
  } catch (exc) {
    return {
      action: "conflict",
      newText: "",
      message: `--force requested but cannot safely merge: ${(exc as Error).message}. Edit ~/.codex/config.toml manually.`,
      diff: "",
    };
  }
  return withCodexHookTrust(
    {
      action: "force-merge",
      newText,
      message: `would merge ${MANAGED_KEY} = ${desiredPath} into existing set (siblings preserved: ${Object.keys(siblings).sort().join(", ")})`,
      diff: unifiedDiffText(currentText, newText),
    },
    currentText,
    hooksPath,
    hookCommand,
    pluginHooks,
  );
}

// ── Agent descriptors ──────────────────────────────────────────────

export interface AgentDescriptorChange {
  action: string;
  name: string;
  source: string;
  target: string;
  message: string;
  content: string;
}

export function codexAgentSourceDir(installRoot: string): string {
  const candidates = [
    path.join(installRoot, "app", "skills", "agentera", "agents"),
    path.join(installRoot, "skills", "agentera", "agents"),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      /* not a dir */
    }
  }
  return candidates[0];
}

export function defaultAgentsDirForConfig(configPath: string): string {
  const expanded = expanduser(configPath);
  if (path.basename(expanded) === "config.toml" && path.basename(path.dirname(expanded)) === ".codex") {
    return path.join(path.dirname(expanded), "agents");
  }
  throw new Error(
    "Codex agent descriptors can be inferred only for documented config layouts: " +
      "~/.codex/config.toml or <project>/.codex/config.toml. " +
      "Pass --agents-dir for nonstandard --config-file paths.",
  );
}

function codexDescriptorManaged(text: string): boolean {
  const lines = text.split(/\r\n|\r|\n/).slice(0, 5);
  return lines.some((line) => line.trim() === "# agentera_managed: true");
}

export function planAgentDescriptorChanges(
  installRoot: string,
  agentsDir: string,
  opts: { force: boolean },
): AgentDescriptorChange[] {
  const sourceDir = codexAgentSourceDir(installRoot);
  const changes: AgentDescriptorChange[] = [];
  for (const name of CAPABILITY_AGENT_NAMES) {
    const source = path.join(sourceDir, `${name}.toml`);
    const target = path.join(agentsDir, `${name}.toml`);
    let sourceText: string;
    try {
      sourceText = fs.readFileSync(source, "utf8");
    } catch {
      changes.push({ action: "blocked", name, source, target, message: "source descriptor is missing", content: "" });
      continue;
    }
    if (!pathExists(target)) {
      changes.push({ action: "pending", name, source, target, message: "would install Codex agent descriptor", content: sourceText });
      continue;
    }
    if (!isFile(target)) {
      changes.push({ action: "blocked", name, source, target, message: "target exists but is not a regular file", content: sourceText });
      continue;
    }
    let targetText: string;
    try {
      targetText = fs.readFileSync(target, "utf8");
    } catch (exc) {
      changes.push({ action: "blocked", name, source, target, message: `cannot read target descriptor: ${(exc as Error).message}`, content: sourceText });
      continue;
    }
    if (targetText === sourceText) {
      changes.push({ action: "noop", name, source, target, message: "Codex agent descriptor is current", content: sourceText });
    } else if (opts.force || codexDescriptorManaged(targetText)) {
      changes.push({ action: "pending", name, source, target, message: "would refresh Codex agent descriptor", content: sourceText });
    } else {
      changes.push({
        action: "blocked",
        name,
        source,
        target,
        message: "target exists without Agentera ownership proof; treating it as user-owned",
        content: sourceText,
      });
    }
  }
  return changes;
}

export function writeAgentDescriptorChanges(changes: AgentDescriptorChange[]): void {
  for (const change of changes) {
    if (change.action !== "pending") continue;
    fs.mkdirSync(path.dirname(change.target), { recursive: true });
    fs.writeFileSync(change.target, change.content, "utf8");
  }
}

function readTextOrNull(p: string): string | null {
  if (!pathExists(p)) return null;
  return fs.readFileSync(p, "utf8");
}

// ── CLI ─────────────────────────────────────────────────────────────

export interface CodexCliIo {
  /** Raw stdout sink; receives exact strings (including any newlines). */
  out?: (text: string) => void;
  /** Raw stderr sink; receives exact strings (including any newlines). */
  err?: (text: string) => void;
  env?: Env;
}

export function codexMain(argv: string[] = [], io: CodexCliIo = {}): number {
  const writeOut = io.out ?? ((text: string) => process.stdout.write(text));
  const writeErr = io.err ?? ((text: string) => process.stderr.write(text));
  const out = (line: string) => writeOut(line + "\n");
  const err = (line: string) => writeErr(line + "\n");
  const env = io.env ?? process.env;

  const args = {
    installRoot: null as string | null,
    configFile: DEFAULT_CONFIG_PATH,
    agentsDir: null as string | null,
    dryRun: false,
    force: false,
    enableAgents: false,
  };

  const valueFlag = (a: string, name: string): string | null => {
    if (a === name) return "__NEXT__";
    if (a.startsWith(name + "=")) return a.slice(name.length + 1);
    return null;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    let v: string | null;
    if ((v = valueFlag(a, "--install-root")) !== null) {
      args.installRoot = v === "__NEXT__" ? argv[++i] : v;
    } else if ((v = valueFlag(a, "--config-file")) !== null) {
      args.configFile = v === "__NEXT__" ? argv[++i] : v;
    } else if ((v = valueFlag(a, "--agents-dir")) !== null) {
      args.agentsDir = v === "__NEXT__" ? argv[++i] : v;
    } else if (a === "--dry-run") {
      args.dryRun = true;
    } else if (a === "--force") {
      args.force = true;
    } else if (a === "--enable-agents") {
      args.enableAgents = true;
    } else {
      err(`setup_codex: error: unrecognized arguments: ${a}`);
      return 2;
    }
  }

  // Step 1: resolve and verify the Agentera directory.
  let installRoot: string;
  try {
    installRoot = resolveInstallRoot(args.installRoot, env);
  } catch (errx) {
    if (errx instanceof InstallRootError) {
      err(errx.message);
      return 2;
    }
    throw errx;
  }

  // Step 2: read current config (None if absent).
  const configPath = args.configFile;
  let currentText: string | null;
  try {
    currentText = readTextOrNull(configPath);
  } catch (errx) {
    err(`error reading ${configPath}: ${(errx as Error).message}`);
    return 2;
  }

  // Step 3: parse-check existing content.
  if (currentText !== null && currentText.trim()) {
    try {
      parseToml(currentText);
    } catch (errx) {
      err(
        `error: ${configPath} is not valid TOML (${(errx as Error).message}). ` +
          "Repair it manually before running this helper.",
      );
      return 2;
    }
  }

  // Step 4: plan the AGENTERA_HOME change and runtime-native descriptors.
  const outcome = planChange(currentText, installRoot, { force: args.force });
  let agentsDir: string;
  try {
    agentsDir = args.agentsDir ?? defaultAgentsDirForConfig(configPath);
  } catch (errx) {
    err(`error: ${(errx as Error).message}`);
    return 2;
  }
  const descriptorChanges = planAgentDescriptorChanges(installRoot, agentsDir, { force: args.force });
  const pendingDescriptors = descriptorChanges.filter((c) => c.action === "pending");
  const blockedDescriptors = descriptorChanges.filter((c) => c.action === "blocked");

  if (args.enableAgents) {
    err(
      "--enable-agents is deprecated in Agentera v2; no [agents.*] " +
        "blocks will be written; runtime-native descriptor files are managed separately.",
    );
  }

  // Step 5: dispatch on the outcome.
  if (outcome.action === "conflict") {
    err(outcome.message);
    if (outcome.diff) err(outcome.diff);
    return 2;
  }

  if (blockedDescriptors.length > 0) {
    for (const change of blockedDescriptors) {
      err(`error: ${change.target}: ${change.message}`);
    }
    return 2;
  }

  if (outcome.action === "noop" && pendingDescriptors.length === 0) {
    out(outcome.message);
    return 0;
  }

  if (args.dryRun) {
    out(outcome.message);
    if (outcome.diff) {
      writeOut(outcome.diff);
      if (!outcome.diff.endsWith("\n")) out("");
    }
    for (const change of pendingDescriptors) {
      out(`${change.message}: ${change.target}`);
    }
    return 1;
  }

  try {
    if (outcome.action !== "noop") {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, outcome.newText, "utf8");
    }
    writeAgentDescriptorChanges(pendingDescriptors);
  } catch (errx) {
    err(`error writing Codex setup targets: ${(errx as Error).message}`);
    return 2;
  }

  if (outcome.action !== "noop") {
    out(`wrote ${configPath}: ${outcome.message.replaceAll("would ", "")}`);
  } else {
    out(outcome.message);
  }
  for (const change of pendingDescriptors) {
    out(`wrote ${change.target}: ${change.message.replaceAll("would ", "")}`);
  }
  return 0;
}
