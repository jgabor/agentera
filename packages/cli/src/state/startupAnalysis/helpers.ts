import { pyJsonDumps as pyJsonDumpsCore, pyJsonString as pyJsonStringCore } from "../../core/pyjson.js";
import { type Dict, hashLabel } from "./contract.js";

export const CLI_COMMAND_ARTIFACTS: Record<string, Set<string>> = {
  plan: new Set(["plan"]),
  progress: new Set(["progress"]),
  health: new Set(["health"]),
  todo: new Set(["todo"]),
  decisions: new Set(["decisions"]),
  docs: new Set(["docs"]),
  objective: new Set(["objective"]),
  experiments: new Set(["experiments"]),
  hej: new Set(["plan", "progress", "health", "todo", "docs", "decisions"]),
  prime: new Set(["plan", "progress", "health", "todo", "docs", "decisions", "changelog"]),
};
export const QUERY_ARTIFACTS: Record<string, string> = {
  plan: "plan",
  progress: "progress",
  health: "health",
  todo: "todo",
  decisions: "decisions",
  docs: "docs",
  vision: "vision",
  objective: "objective",
  experiments: "experiments",
};
const PRIMARY_ROUTE_TO_CAPABILITY: Record<string, string> = {
  build: "build",
  plan: "plan",
  status: "status",
  discuss: "discuss",
  research: "research",
  optimize: "optimize",
  audit: "audit",
  document: "document",
  profile: "profile",
  design: "design",
  orchestrate: "orchestrate",
  vision: "vision",
};
const CAPABILITIES_WITH_STATUS = new Set([...Object.values(PRIMARY_ROUTE_TO_CAPABILITY)]);
const MARKER_RE = /─{2,}\s+(\S)\s+(status|vision|discuss|research|plan|build|optimize|audit|document|profile|design|orchestrate)\s+·\s+([a-z]+(?:\s+\d+)?)\s+─{2,}/g;
const BARE_AGENTERA_ROUTE_RE = /^\s*\/agentera(?:\s+([A-Za-z0-9._:-]+))?/m;
const BARE_CAPABILITY_ROUTE_RE = /^\s*\/(status|vision|discuss|research|plan|build|optimize|audit|document|profile|design|orchestrate)(?:\s|$)/m;
const XML_ROUTE_RE = /<command-name>\s*\/(?:agentera\s+)?([A-Za-z0-9._:-]+)\s*<\/command-name>/;

export const THRESHOLD_WARNING_PATTERNS: Array<[string, string, string, RegExp]> = [
  [
    "self_audit",
    "verbosity",
    "self_audit.verbosity",
    /verbosity(?: mismatch)?|exceeds(?: the)?(?: advisory| compact)?(?: prose| word| entry)? budget|\b\d+\s+words?\s+exceeds\s+\d+\s+budget\b|full plans? exceed/i,
  ],
  ["self_audit", "abstraction", "self_audit.abstraction", /abstraction creep/i],
  ["self_audit", "filler", "self_audit.filler", /\bfiller\s*:/i],
  ["compaction", "over_limit", "compaction.uniform_10_40_50", /over(?:\s+|_)limit|uniform_10_40_50/i],
  ["compaction", "protected_overflow", "compaction.protected_overflow", /protected[-_ ]overflow/i],
];
export const POST_AUDIT_FLAG_RE = /\[post-audit-flagged(?::[^\]]*)?\]/gi;
export const BUDGET_PRESSURE_RE = THRESHOLD_WARNING_PATTERNS[0][3];
export const FULL_PLAN_BUDGET_RE = /full[- ]plan|full plans?|\bplan\b/i;
const DETAIL_ANCHOR_RE = /`[^`]+`|\b(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\b|:\d{2,}\b|\b[0-9a-fA-F]{7,}\b/g;
export function inc(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}
export function counterDict(counter: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(counter).sort()) out[key] = counter[key];
  return out;
}
export function countMatches(re: RegExp, text: string): number {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let n = 0;
  while (g.exec(text) !== null) n += 1;
  return n;
}
export function wordCount(text: string): number {
  return (text.match(/\S+/g) ?? []).length;
}

let _fallbackIdSeq = 0;
const _fallbackIds = new WeakMap<object, number>();
export function recordLabel(record: Dict, salt: string): string {
  let key: unknown = record.source_id;
  if (key === null || key === undefined || key === "") {
    let id = _fallbackIds.get(record);
    if (id === undefined) {
      id = ++_fallbackIdSeq;
      _fallbackIds.set(record, id);
    }
    key = id;
  }
  return hashLabel("record", key, salt);
}

export function extractText(record: Dict): string {
  const data = record.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const value = data.content || data.text || data.message || data.prompt;
    return typeof value === "string" ? value : "";
  }
  return "";
}
export function toolArguments(record: Dict): Dict {
  const data = record.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const args = data.arguments;
    if (args && typeof args === "object" && !Array.isArray(args)) return args;
    if (typeof args === "string") {
      try {
        const parsed = JSON.parse(args);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { value: parsed };
      } catch {
        return { raw: args };
      }
    }
    return data;
  }
  return record;
}
export function toolName(record: Dict): string {
  const data = record.data;
  const values = [record.tool, record.tool_name, record.name];
  if (data && typeof data === "object" && !Array.isArray(data)) {
    values.push(data.tool, data.tool_name, data.name);
  }
  for (const value of values) {
    if (typeof value === "string" && value) return value;
  }
  return "";
}
export function toolArgument(record: Dict, ...keys: string[]): string {
  const args = toolArguments(record);
  const candidates: unknown[] = keys.map((k) => args[k]);
  candidates.push(...keys.map((k) => record[k]));
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return "";
}
export const pyJsonString = pyJsonStringCore;

function startupJsonScalar(value: unknown): string | undefined {
  if (value instanceof Flt) return formatFloat(value.v);
  return undefined;
}

/** Mirror Python json.dumps(value, sort_keys=True) (separators ", "/": ", ensure_ascii). */
export function pyJsonDumps(value: unknown): string {
  return pyJsonDumpsCore(value, startupJsonScalar);
}
export function argumentsText(record: Dict): string {
  return pyJsonDumps(toolArguments(record));
}

export function introCapability(text: string): string | null {
  const g = new RegExp(MARKER_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = g.exec(text)) !== null) {
    const word = m[3];
    if (!["complete", "flagged", "stuck", "waiting"].includes(word)) {
      return m[2];
    }
  }
  return null;
}
export function routeCapability(text: string): string | null {
  let m = XML_ROUTE_RE.exec(text);
  if (m) {
    const route = m[1].toLowerCase();
    return CAPABILITIES_WITH_STATUS.has(route) ? route : (PRIMARY_ROUTE_TO_CAPABILITY[route] ?? null);
  }
  m = BARE_AGENTERA_ROUTE_RE.exec(text);
  if (m) {
    const route = (m[1] || "status").toLowerCase();
    return CAPABILITIES_WITH_STATUS.has(route) ? route : (PRIMARY_ROUTE_TO_CAPABILITY[route] ?? null);
  }
  m = BARE_CAPABILITY_ROUTE_RE.exec(text);
  if (m) {
    return m[1].toLowerCase();
  }
  return null;
}
export function capabilityInvocation(text: string): string | null {
  const route = routeCapability(text);
  if (route) return route;
  const marker = introCapability(text);
  if (marker) return marker;
  const lowered = text.toLowerCase();
  for (const capability of [...CAPABILITIES_WITH_STATUS].sort()) {
    if (new RegExp(`\\b${capability.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(lowered)) {
      return capability;
    }
  }
  if (lowered.includes("agentera")) return "agentera";
  return null;
}
export function recordThresholdText(record: Dict): string {
  const parts = [extractText(record)];
  if (record.source_kind === "tool_call") parts.push(argumentsText(record));
  return parts.filter((p) => p).join("\n");
}
export function detailMetrics(text: string): { word_count: number; anchor_count: number } {
  return { word_count: wordCount(text), anchor_count: countMatches(DETAIL_ANCHOR_RE, text) };
}
export function thresholdWarnings(text: string): Array<Dict> {
  const warnings: Dict[] = [];
  const seen = new Set<string>();
  for (const [family, category, source, pattern] of THRESHOLD_WARNING_PATTERNS) {
    if (pattern.test(text)) {
      const key = `${family}\0${category}\0${source}`;
      if (!seen.has(key)) {
        warnings.push({ family, category, threshold_source: source });
        seen.add(key);
      }
    }
  }
  return warnings;
}
export function detailLossStatus(
  before: { word_count: number; anchor_count: number },
  after: { word_count: number; anchor_count: number },
): string {
  if (before.word_count === 0 || after.word_count === 0) return "not_assessed";
  const wordDrop = after.word_count < before.word_count * 0.75;
  const anchorDrop = after.anchor_count < before.anchor_count;
  if (wordDrop && anchorDrop) return "possible_useful_detail_removed";
  if (wordDrop) return "possible_compression_without_anchor_loss";
  return "not_detected";
}

/** Python round() — round half to even on IEEE-754 doubles. */
export function pyRound(x: number, ndigits: number): number {
  const m = 10 ** ndigits;
  const v = x * m;
  const f = Math.floor(v);
  const diff = v - f;
  let r: number;
  if (diff > 0.5) r = f + 1;
  else if (diff < 0.5) r = f;
  else r = f % 2 === 0 ? f : f + 1;
  return r / m;
}

/** Python float marker: serializes with a trailing .0 for whole numbers. */
export class Flt {
  constructor(public readonly v: number) {}
  valueOf(): number {
    return this.v;
  }
  toJSON(): number {
    return this.v;
  }
}
export function flt(n: number): Flt {
  return new Flt(n);
}
export function formatFloat(v: number): string {
  return Number.isInteger(v) ? `${v}.0` : String(v);
}
/** Python str()/f-string rendering for report scalars. */
export function pyFmt(value: unknown): string {
  if (value instanceof Flt) return formatFloat(value.v);
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return String(value);
}

export function safeInt(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}
export function nowIsoSeconds(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
}
