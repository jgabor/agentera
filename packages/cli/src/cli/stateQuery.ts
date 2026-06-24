import fs from "node:fs";
import path from "node:path";

import { parseYaml } from "../core/yaml.js";
import { loadYamlMapping } from "../core/yaml.js";
import { activeAppModel, discoverSchemasDir, SchemaInfo } from "./appContext.js";
import { validateAgentString, validateIdentifier } from "./argvalidate.js";
import { emitStructured } from "./structured.js";

/** Shared state-query infrastructure ported from scripts/agentera. */

type Dict = Record<string, any>;

export const REQUIRED_SPARSE_CONTEXT_FIELDS = ["command", "status"];
export const ROUTINE_STRUCTURED_FIELDS = [
  "command",
  "status",
  "entries",
  "counts",
  "source",
  "filters",
  "summary",
  "source_contract",
];

export const COMMAND_FILTERS: Record<string, string[]> = {
  prime: [],
  plan: ["status"],
  progress: ["topic", "status", "limit"],
  health: ["dimension"],
  todo: ["severity", "status"],
  decisions: ["topic"],
  docs: ["topic", "status"],
  objective: ["status"],
  experiments: ["topic", "status", "limit"],
  query: ["list_artifacts", "topic", "severity", "dimension", "status", "limit"],
};

export function appModelPayload(model: Dict = activeAppModel()): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(model)) out[k] = String(v);
  return out;
}

export function surfaceMissingMessage(surface: string, p: string, model: Dict = activeAppModel()): string {
  const payload = appModelPayload(model);
  return (
    `${surface} is missing. Agentera cannot find it at ${p}. ` +
    `Agentera directory: ${payload.appHome}. ` +
    `App files directory: ${payload.managedAppRoot}. ` +
    "Run `agentera doctor` to preview the repair; run " +
    "`agentera doctor --format json` for structured details. " +
    `Technical details: appHome=${payload.appHome} managedAppRoot=${payload.managedAppRoot} ` +
    `skillRoot=${payload.skillRoot} runtimeRoot=${payload.runtimeRoot}.`
  );
}

export function missingSchemaError(schemaName: string): string {
  const model = activeAppModel();
  const schemasDir = discoverSchemasDir(model);
  return surfaceMissingMessage(`${schemaName} schema`, path.join(schemasDir, `${schemaName}.yaml`), model);
}

export function loadArtifact(p: string): unknown {
  if (!fs.existsSync(p)) return null;
  try {
    const content = fs.readFileSync(p, "utf8");
    const suffix = path.extname(p).toLowerCase();
    if (suffix === ".yaml" || suffix === ".yml") return loadYamlMapping(content);
    return parseYaml(content);
  } catch (exc) {
    if (path.extname(p).toLowerCase() !== ".md") {
      process.stderr.write(`warning: failed to parse artifact ${p}: ${(exc as Error).message}\n`);
    }
    return null;
  }
}

export function extractEntries(data: unknown): Dict[] {
  if (data === null || data === undefined) return [];
  if (Array.isArray(data)) return data.filter((e) => e && typeof e === "object" && !Array.isArray(e));
  if (typeof data === "object") {
    for (const [key, val] of Object.entries(data as Dict)) {
      if (key === "archive") continue;
      if (Array.isArray(val) && val.length > 0 && val[0] && typeof val[0] === "object" && !Array.isArray(val[0])) {
        return val as Dict[];
      }
    }
    return [data as Dict];
  }
  return [];
}

/** Python str() of a value (used for scalar/collection rendering). */
function pyStr(val: unknown): string {
  if (val === null || val === undefined) return "None";
  if (val === true) return "True";
  if (val === false) return "False";
  if (Array.isArray(val)) return "[" + val.map((v) => pyReprInner(v)).join(", ") + "]";
  if (typeof val === "object") {
    return "{" + Object.entries(val as Dict).map(([k, v]) => `${pyReprInner(k)}: ${pyReprInner(v)}`).join(", ") + "}";
  }
  return String(val);
}

function pyReprInner(val: unknown): string {
  if (typeof val === "string") return `'${val}'`;
  return pyStr(val);
}

export function formatScalar(val: unknown): string {
  if (Array.isArray(val) || (val !== null && typeof val === "object")) {
    const s = pyStr(val);
    return s.length > 80 ? s.slice(0, 80) + "..." : s;
  }
  return pyStr(val);
}

export function truncate(value: unknown, limit = 110): string {
  const text = formatScalar(value).replace(/\n/g, " ");
  return text.length > limit ? text.slice(0, limit - 3) + "..." : text;
}

export function asList(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

export function firstPresent(entry: Dict, names: string[], deflt: unknown = ""): unknown {
  for (const name of names) {
    const value = entry[name];
    if (value !== null && value !== undefined && value !== "") return value;
  }
  return deflt;
}

export function printStatusCounts(prefix: string, counts: Record<string, number>, out: (t: string) => void): void {
  const keys = Object.keys(counts);
  if (keys.length > 0) {
    const body = keys
      .sort()
      .map((name) => `${name}=${counts[name]}`)
      .join(", ");
    out(`${prefix}: ${body}\n`);
  }
}

export function stringFieldNames(fields: Dict): string[] {
  return Object.entries(fields)
    .filter(([, d]) => (d as Dict)?.type === "string")
    .map(([n]) => n);
}

export function filterByTopic(entries: Dict[], topic: string, fields: Dict): Dict[] {
  const t = topic.toLowerCase();
  const fnames = stringFieldNames(fields);
  return entries.filter((e) => fnames.some((fn) => String(e[fn] ?? "").toLowerCase().includes(t)));
}

export function filterByFieldValue(entries: Dict[], fieldName: string, value: string, substring = false): Dict[] {
  const vl = value.toLowerCase();
  const result: Dict[] = [];
  for (const e of entries) {
    const v = e[fieldName];
    if (v === null || v === undefined) continue;
    if (typeof v === "string") {
      if ((substring && v.toLowerCase().includes(vl)) || (!substring && v.toLowerCase() === vl)) result.push(e);
    } else if (Array.isArray(v)) {
      const strs = v.map((x) => String(x).toLowerCase());
      if (strs.includes(vl) || (substring && strs.some((s) => s.includes(vl)))) result.push(e);
    } else if (v && typeof v === "object") {
      const keys = Object.keys(v as Dict);
      if (keys.includes(value) || (substring && keys.some((k) => k.toLowerCase().includes(vl)))) result.push(e);
    }
  }
  return result;
}

function cycleSortKey(entry: Dict): [number, number | string] {
  const number = entry.number;
  if (typeof number === "number" && Number.isInteger(number)) return [1, number];
  if (typeof number === "string" && /^\d+$/.test(number)) return [1, parseInt(number, 10)];
  const timestamp = entry.timestamp;
  if (typeof timestamp === "string") return [0, timestamp];
  return [0, ""];
}

export function omitProgressCommit(entry: Dict): Dict {
  const { commit: _commit, ...rest } = entry;
  return rest;
}

export function progressEntriesForOutput(entries: Dict[]): Dict[] {
  return entries.map(omitProgressCommit);
}

export function recentCycles(entries: Dict[], limit: number): Dict[] {
  const sorted = [...entries].sort((a, b) => {
    const ka = cycleSortKey(a);
    const kb = cycleSortKey(b);
    if (ka[0] !== kb[0]) return kb[0] - ka[0];
    if (ka[1] < kb[1]) return 1;
    if (ka[1] > kb[1]) return -1;
    return 0;
  });
  return sorted.slice(0, limit);
}

export function formatEntry(entry: Dict, fields: string[]): string {
  const parts: string[] = [];
  for (const field of fields) {
    const value = entry[field];
    if (value !== null && value !== undefined && value !== "" && !Array.isArray(value) && typeof value !== "object") {
      parts.push(`${field}=${truncate(value)}`);
    }
  }
  return parts.join(" | ");
}

export function statusCounts(entries: Dict[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    const raw = "status" in entry ? entry.status : "unknown";
    const status = String(raw || "unknown");
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

export function sourceMetadata(command: string, p: string | null, schema: string | null = null): Dict {
  return {
    artifact: schema ?? command,
    path: p !== null ? p : null,
    exists: Boolean(p && fs.existsSync(p)),
    kind: p && path.extname(p).toLowerCase() === ".md" ? "markdown" : "yaml",
  };
}

export function structuredState(
  command: string,
  entries: Dict[],
  source: Dict,
  opts: { filters?: Dict; summary?: Dict; sourceContract?: Dict } = {},
): Dict {
  const payload: Dict = {
    command,
    status: entries.length > 0 || source.exists ? "ok" : "empty",
    entries,
    counts: { entries: entries.length, status: statusCounts(entries) },
    source,
    filters: Object.fromEntries(Object.entries(opts.filters ?? {}).filter(([, v]) => v !== null && v !== undefined)),
    summary: opts.summary ?? {},
  };
  if (opts.sourceContract !== undefined) payload.source_contract = opts.sourceContract;
  return payload;
}

export function requestedFields(fieldsArg: string | null | undefined): string[] {
  if (!fieldsArg) return [];
  validateAgentString(String(fieldsArg), "fields");
  const fields: string[] = [];
  for (const part of String(fieldsArg).split(",")) {
    const field = part.trim();
    if (field && !fields.includes(field)) {
      validateIdentifier(field, "field");
      fields.push(field);
    }
  }
  return fields;
}

function availableStructuredFields(command: string): string[] {
  // State commands only; prime/capability handled by their own commands.
  return ROUTINE_STRUCTURED_FIELDS;
}

export function selectStructuredFields(
  command: string,
  value: Dict,
  fieldsArg: string | null | undefined,
  err: (t: string) => void,
): Dict | null {
  const requested = requestedFields(fieldsArg);
  const working = value;
  if (requested.length === 0) return working;
  const available = availableStructuredFields(command);
  const unsupported = requested.filter((f) => !available.includes(f));
  if (unsupported.length > 0) {
    err(`Error: unsupported field '${unsupported[0]}' for ${command}. Available fields: ${available.join(", ")}\n`);
    return null;
  }
  const selected: Dict = {};
  for (const field of [...REQUIRED_SPARSE_CONTEXT_FIELDS, ...requested]) {
    if (field in working && !(field in selected)) selected[field] = working[field];
  }
  return selected;
}

export function emitStateStructured(
  command: string,
  value: Dict,
  format: string,
  fieldsArg: string | null | undefined,
  out: (t: string) => void,
  err: (t: string) => void,
): number {
  const selected = selectStructuredFields(command, value, fieldsArg, err);
  if (selected === null) return 1;
  emitStructured(selected, format, out);
  return 0;
}

export function validateFilterValues(args: Dict, names: string[]): void {
  for (const name of names) {
    const value = args[name];
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (item !== null && item !== undefined) {
        validateAgentString(String(item), name.replace(/_/g, " "));
      }
    }
  }
}

export type { SchemaInfo };
