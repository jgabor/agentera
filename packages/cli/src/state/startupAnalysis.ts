import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { loadYamlMapping } from "../core/yaml.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";

/**
 * Contract, extraction, and reporting for Agentera startup state-access
 * analysis. Faithful TS port of scripts/startup_analysis_contract.py.
 *
 * NOTE: This is a large maintainer analysis/benchmark module ported in slices.
 * Slice 1 (this commit): contract loading, privacy redaction, canonical artifact
 * labels, and timestamp helpers. Remaining slices (threshold scanning, event
 * classification, metrics aggregation, report rendering, benchmark persistence,
 * corpus/runtime-store extraction) land in subsequent commits.
 */

type Dict = Record<string, any>;

export const TRANSCRIPT_KEYS = new Set([
  "content",
  "text",
  "prompt",
  "message",
  "preceding_context",
  "input_text",
  "output_text",
  "transcript",
]);
export const SESSION_KEYS = new Set(["session_id", "sessionID", "sessionId", "conversation_id"]);
export const PATH_KEYS = new Set(["path", "project_path", "store_path", "file_path", "cwd", "report_path"]);

export function contractPath(root: string = resolveSourceRoot()): string {
  return path.join(root, "references", "analysis", "startup-measurement-contract.yaml");
}

export function loadContract(p: string = contractPath()): Dict {
  return loadYamlMapping(fs.readFileSync(p, "utf8"));
}

export function hashLabel(kind: string, value: unknown, salt: string): string {
  if (!salt) {
    throw new Error("salt is required for private labels");
  }
  const digest = crypto
    .createHash("sha256")
    .update(`${salt}\0${pyStr(value)}`, "utf8")
    .digest("hex")
    .slice(0, 16);
  return `${kind}:${digest}`;
}

/** Approximate Python str() for the scalar/id values hashLabel receives. */
function pyStr(value: unknown): string {
  if (value === null) return "None";
  if (value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return String(value);
}

const FALLBACK_ARTIFACT_LABELS: Array<[string, string]> = [
  [".agentera/plan.yaml", "PLAN.md"],
  [".agentera/progress.yaml", "PROGRESS.md"],
  [".agentera/docs.yaml", "DOCS.md"],
  [".agentera/decisions.yaml", "DECISIONS.md"],
  [".agentera/health.yaml", "HEALTH.md"],
  [".agentera/vision.yaml", "VISION.md"],
  [".agentera/objective.yaml", "OBJECTIVE.md"],
  [".agentera/experiments.yaml", "EXPERIMENTS.md"],
];

export function canonicalArtifactLabel(value: unknown, contract: Dict | null = null): string | null {
  const text = String(value).replace(/\\/g, "/");
  const loaded = contract ?? loadContract();
  const labels = (loaded.privacy_boundary ?? {}).canonical_artifact_labels;
  if (labels && typeof labels === "object" && !Array.isArray(labels)) {
    for (const [suffix, label] of Object.entries(labels)) {
      const normalized = String(suffix).replace(/\\/g, "/");
      if (text === normalized || text.endsWith("/" + normalized) || text.includes(normalized)) {
        return String(label);
      }
    }
  }
  for (const [suffix, label] of FALLBACK_ARTIFACT_LABELS) {
    if (text === suffix || text.endsWith("/" + suffix) || text.includes(suffix)) {
      return label;
    }
  }
  if (text.includes(".agentera/")) {
    return "AGENTERA_ARTIFACTS";
  }
  return null;
}

export function redactForStartupOutput(value: any, salt: string, contract: Dict | null = null): any {
  const loaded = contract ?? loadContract();
  if (Array.isArray(value)) {
    return value.map((item) => redactForStartupOutput(item, salt, loaded));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const redacted: Dict = {};
  for (const [key, item] of Object.entries(value)) {
    const keyText = String(key);
    if (TRANSCRIPT_KEYS.has(keyText)) {
      redacted[keyText] = "<redacted:transcript_text>";
    } else if (SESSION_KEYS.has(keyText)) {
      redacted[keyText] = hashLabel("session", item, salt);
    } else if (PATH_KEYS.has(keyText)) {
      const label = canonicalArtifactLabel(item, loaded);
      redacted[keyText] = label || hashLabel("path", item, salt);
    } else {
      redacted[keyText] = redactForStartupOutput(item, salt, loaded);
    }
  }
  return redacted;
}

// --- Timestamp helpers -----------------------------------------------------

export function parseTimestamp(value: unknown): Date | null {
  if (typeof value !== "string" || !value) {
    return null;
  }
  const text = value.replace("Z", "+00:00");
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : new Date(ms);
}

export function formatTimestamp(value: Date | null): string | null {
  if (value === null) {
    return null;
  }
  // ISO 8601 UTC, seconds precision (mirrors Python isoformat(timespec="seconds")).
  return value.toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

// ===========================================================================
// Slice 2: threshold evidence scanning + classification + event classification
// ===========================================================================

export const THRESHOLD_EVIDENCE_ENVELOPE = "threshold_evidence_scan_v1";
export const THRESHOLD_CLASSIFICATION_ENVELOPE = "threshold_evidence_classification_v1";

export const STATE_EVENT_CLASSES = new Set([
  "cli_state_call",
  "raw_artifact_access",
  "capability_prose_read",
  "implementation_boundary",
  "non_state_context",
]);
export const BOUNDARY_DEGRADATION_REASONS = new Set([
  "pre_boundary_record",
  "missing_timestamp",
  "malformed_record",
  "missing_conversation_key",
  "no_agentera_state_sequence",
  "privacy_redaction_required",
]);
export const BOUNDED_RUNTIME_STATUSES = new Set([
  "ok",
  "available",
  "missing",
  "sparse",
  "degraded",
  "skipped",
]);
export const BOUNDED_RUNTIME_REASONS = new Set([
  "candidate_files_found",
  "disabled",
  "extractor_unimplemented",
  "no_candidate_files",
  "no_runtime_stores_approved",
  "no_matching_records",
  "records_extracted",
  "schema_divergent",
  "store_absent",
  "store_locked",
  "store_not_directory",
  "store_unreadable",
]);

export const STATE_CLI_COMMANDS = new Set([
  "hej",
  "prime",
  "plan",
  "progress",
  "health",
  "todo",
  "decisions",
  "docs",
  "objective",
  "experiments",
  "query",
]);
const CLI_COMMAND_ARTIFACTS: Record<string, Set<string>> = {
  plan: new Set(["PLAN.md"]),
  progress: new Set(["PROGRESS.md"]),
  health: new Set(["HEALTH.md"]),
  todo: new Set(["TODO.md"]),
  decisions: new Set(["DECISIONS.md"]),
  docs: new Set(["DOCS.md"]),
  objective: new Set(["OBJECTIVE.md"]),
  experiments: new Set(["EXPERIMENTS.md"]),
  hej: new Set(["PLAN.md", "PROGRESS.md", "HEALTH.md", "TODO.md", "DOCS.md", "DECISIONS.md"]),
  prime: new Set(["PLAN.md", "PROGRESS.md", "HEALTH.md", "TODO.md", "DOCS.md", "DECISIONS.md", "CHANGELOG.md"]),
};
const QUERY_ARTIFACTS: Record<string, string> = {
  plan: "PLAN.md",
  progress: "PROGRESS.md",
  health: "HEALTH.md",
  todo: "TODO.md",
  decisions: "DECISIONS.md",
  docs: "DOCS.md",
  vision: "VISION.md",
  objective: "OBJECTIVE.md",
  experiments: "EXPERIMENTS.md",
};
const PRIMARY_ROUTE_TO_CAPABILITY: Record<string, string> = {
  build: "realisera",
  plan: "planera",
  status: "hej",
  discuss: "resonera",
  research: "inspirera",
  optimize: "optimera",
  audit: "inspektera",
  document: "dokumentera",
  profile: "profilera",
  design: "visualisera",
  orchestrate: "orkestrera",
  vision: "visionera",
};
const CAPABILITIES_WITH_HEJ = new Set([...Object.values(PRIMARY_ROUTE_TO_CAPABILITY), "hej"]);

const MARKER_RE = /─{2,}\s+(\S)\s+([a-z]+era|hej)\s+·\s+([a-z]+(?:\s+\d+)?)\s+─{2,}/g;
const BARE_AGENTERA_ROUTE_RE = /^\s*\/agentera(?:\s+([A-Za-z0-9._:-]+))?/m;
const BARE_CAPABILITY_ROUTE_RE = /^\s*\/([a-z]+era|hej)(?:\s|$)/m;
const XML_ROUTE_RE = /<command-name>\s*\/(?:agentera\s+)?([A-Za-z0-9._:-]+)\s*<\/command-name>/;

const THRESHOLD_WARNING_PATTERNS: Array<[string, string, string, RegExp]> = [
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
const POST_AUDIT_FLAG_RE = /\[post-audit-flagged(?::[^\]]*)?\]/gi;
const BUDGET_PRESSURE_RE = THRESHOLD_WARNING_PATTERNS[0][3];
const FULL_PLAN_BUDGET_RE = /full[- ]plan|full plans?|PLAN\.md/i;
const DETAIL_ANCHOR_RE = /`[^`]+`|\b(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\b|:\d{2,}\b|\b[0-9a-fA-F]{7,}\b/g;

function inc(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}
function counterDict(counter: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(counter).sort()) out[key] = counter[key];
  return out;
}
function countMatches(re: RegExp, text: string): number {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let n = 0;
  while (g.exec(text) !== null) n += 1;
  return n;
}
function wordCount(text: string): number {
  return (text.match(/\S+/g) ?? []).length;
}

let _fallbackIdSeq = 0;
const _fallbackIds = new WeakMap<object, number>();
function recordLabel(record: Dict, salt: string): string {
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

function extractText(record: Dict): string {
  const data = record.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const value = data.content || data.text || data.message || data.prompt;
    return typeof value === "string" ? value : "";
  }
  return "";
}
function toolArguments(record: Dict): Dict {
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
function toolName(record: Dict): string {
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
function toolArgument(record: Dict, ...keys: string[]): string {
  const args = toolArguments(record);
  const candidates: unknown[] = keys.map((k) => args[k]);
  candidates.push(...keys.map((k) => record[k]));
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return "";
}
function pyJsonString(str: string): string {
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
      const hi = 0xd800 + (v >> 10);
      const lo = 0xdc00 + (v & 0x3ff);
      out += "\\u" + hi.toString(16).padStart(4, "0") + "\\u" + lo.toString(16).padStart(4, "0");
    } else {
      out += "\\u" + cp.toString(16).padStart(4, "0");
    }
  }
  return out + '"';
}
/** Mirror Python json.dumps(value, sort_keys=True) (separators ", "/": ", ensure_ascii). */
function pyJsonDumps(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (value instanceof Flt) return formatFloat(value.v);
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return pyJsonString(value);
  if (Array.isArray(value)) return "[" + value.map((v) => pyJsonDumps(v)).join(", ") + "]";
  if (typeof value === "object") {
    const keys = Object.keys(value as Dict).sort();
    return "{" + keys.map((k) => `${pyJsonString(k)}: ${pyJsonDumps((value as Dict)[k])}`).join(", ") + "}";
  }
  return "null";
}
function argumentsText(record: Dict): string {
  return pyJsonDumps(toolArguments(record));
}

function introCapability(text: string): string | null {
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
function routeCapability(text: string): string | null {
  let m = XML_ROUTE_RE.exec(text);
  if (m) {
    const route = m[1].toLowerCase();
    return CAPABILITIES_WITH_HEJ.has(route) ? route : (PRIMARY_ROUTE_TO_CAPABILITY[route] ?? null);
  }
  m = BARE_AGENTERA_ROUTE_RE.exec(text);
  if (m) {
    const route = (m[1] || "status").toLowerCase();
    return CAPABILITIES_WITH_HEJ.has(route) ? route : (PRIMARY_ROUTE_TO_CAPABILITY[route] ?? null);
  }
  m = BARE_CAPABILITY_ROUTE_RE.exec(text);
  if (m) {
    return m[1].toLowerCase();
  }
  return null;
}
function capabilityInvocation(text: string): string | null {
  const route = routeCapability(text);
  if (route) return route;
  const marker = introCapability(text);
  if (marker) return marker;
  const lowered = text.toLowerCase();
  for (const capability of [...CAPABILITIES_WITH_HEJ].sort()) {
    if (new RegExp(`\\b${capability.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(lowered)) {
      return capability;
    }
  }
  if (lowered.includes("agentera")) return "agentera";
  return null;
}

function recordThresholdText(record: Dict): string {
  const parts = [extractText(record)];
  if (record.source_kind === "tool_call") parts.push(argumentsText(record));
  return parts.filter((p) => p).join("\n");
}
function detailMetrics(text: string): { word_count: number; anchor_count: number } {
  return { word_count: wordCount(text), anchor_count: countMatches(DETAIL_ANCHOR_RE, text) };
}
function thresholdWarnings(text: string): Array<Dict> {
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
function detailLossStatus(before: { word_count: number; anchor_count: number }, after: { word_count: number; anchor_count: number }): string {
  if (before.word_count === 0 || after.word_count === 0) return "not_assessed";
  const wordDrop = after.word_count < before.word_count * 0.75;
  const anchorDrop = after.anchor_count < before.anchor_count;
  if (wordDrop && anchorDrop) return "possible_useful_detail_removed";
  if (wordDrop) return "possible_compression_without_anchor_loss";
  return "not_detected";
}

function boundedRuntimeStatus(status: Dict): Dict {
  const runtime = String(status.runtime ?? "unknown");
  const state = String(status.status ?? "degraded");
  const reason = String(status.reason ?? "schema_divergent");
  const item: Dict = {
    runtime,
    status: BOUNDED_RUNTIME_STATUSES.has(state) ? state : "degraded",
    reason: BOUNDED_RUNTIME_REASONS.has(reason) ? reason : "schema_divergent",
  };
  for (const key of ["candidate_count", "record_count", "error_count"]) {
    const value = status[key];
    if (typeof value === "number" && Number.isInteger(value)) item[key] = value;
  }
  if (Array.isArray(status.remediation_labels)) {
    item.remediation_labels = status.remediation_labels.map((l: unknown) => String(l));
  }
  return item;
}

function startupConversationKey(record: Dict): string | null {
  const key = record.conversation_key;
  if (typeof key === "string" && key) return key;
  const sid = record.session_id;
  if (typeof sid === "string" && sid) return sid;
  const data = record.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const dsid = data.session_id;
    if (typeof dsid === "string" && dsid) return dsid;
  }
  const ssid = record.source_id;
  if (typeof ssid === "string" && ssid) return ssid;
  return null;
}

function stateCliCommand(command: string): string | null {
  if (!command) return null;
  const tokens = command.replace(/"/g, " ").replace(/'/g, " ").split(/\s+/).filter((t) => t);
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i].endsWith("agentera") && STATE_CLI_COMMANDS.has(tokens[i + 1])) {
      return tokens[i + 1];
    }
  }
  return null;
}
function stateCliArtifacts(command: string, stateCommand: string): Set<string> {
  if (stateCommand === "query") {
    const tokens = command.replace(/"/g, " ").replace(/'/g, " ").split(/\s+/).filter((t) => t);
    for (let i = 0; i < tokens.length - 1; i++) {
      if (tokens[i].endsWith("agentera") && tokens[i + 1] === "query") {
        for (const arg of tokens.slice(i + 2)) {
          const label = QUERY_ARTIFACTS[arg.toLowerCase()];
          if (label) return new Set([label]);
        }
        return new Set();
      }
    }
  }
  return new Set(CLI_COMMAND_ARTIFACTS[stateCommand] ?? []);
}

export function classifyStartupEvent(record: Dict): [string, string | null, string | null, Set<string>] {
  if (!record || typeof record !== "object" || Array.isArray(record) || record.source_kind !== "tool_call") {
    return ["non_state_context", null, null, new Set()];
  }
  const tool = toolName(record).toLowerCase();
  const command = toolArgument(record, "command");
  if (tool === "bash") {
    const stateCommand = stateCliCommand(command);
    if (stateCommand) {
      return ["cli_state_call", null, stateCommand, stateCliArtifacts(command, stateCommand)];
    }
    return ["implementation_boundary", null, null, new Set()];
  }
  const argsText = argumentsText(record).replace(/\\/g, "/");
  if (
    ["read", "grep", "glob"].includes(tool) &&
    (argsText.includes("skills/agentera/capabilities/") ||
      argsText.includes("skills/agentera/SKILL.md") ||
      argsText.includes("skills/agentera/protocol.yaml"))
  ) {
    return ["capability_prose_read", argsText.includes("SKILL.md") ? "SKILL.md" : null, null, new Set()];
  }
  const artifactLabel = ["read", "grep", "glob"].includes(tool) ? canonicalArtifactLabel(argsText) : null;
  if (artifactLabel) {
    return ["raw_artifact_access", artifactLabel, null, new Set()];
  }
  if (["apply_patch", "edit", "write"].includes(tool)) {
    return ["implementation_boundary", null, null, new Set()];
  }
  return ["non_state_context", null, null, new Set()];
}

function eventWarningKeys(event: Dict): string[] {
  const keys: string[] = [];
  for (const warning of event.warnings ?? []) {
    if (!warning || typeof warning !== "object") continue;
    const family = warning.family;
    const category = warning.category;
    if (typeof family === "string" && typeof category === "string") keys.push(`${family}.${category}`);
  }
  return keys;
}
function eventClassification(event: Dict, coverageCaveated: boolean): string {
  const status = event.detail_loss_status;
  if (status === "possible_useful_detail_removed") return "likely_false_positive";
  if (status === "retained_artifact_false_positive_signal") return "likely_false_positive";
  if (status === "possible_compression_without_anchor_loss" || status === "not_detected") return "legitimate_pressure";
  if (coverageCaveated) return "unsupported_by_available_coverage";
  return "inconclusive";
}
function categoryClassification(counts: Record<string, number>): string {
  if (counts.likely_false_positive) return "likely_false_positive";
  if (counts.unsupported_by_available_coverage) return "unsupported_by_available_coverage";
  if (counts.inconclusive) return "inconclusive";
  return "legitimate_pressure";
}

function nowIsoSeconds(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

export function scanThresholdEvidence(
  corpus: Dict,
  opts: { salt: string; contract?: Dict | null },
): Dict {
  const salt = opts.salt;
  const loaded = opts.contract ?? loadContract();
  let records = corpus && typeof corpus === "object" && !Array.isArray(corpus) ? (corpus.records ?? []) : [];
  if (!Array.isArray(records)) records = [];
  let metadata = corpus && typeof corpus === "object" && !Array.isArray(corpus) ? (corpus.metadata ?? {}) : {};
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) metadata = {};
  let runtimeStatuses = metadata.runtime_statuses;
  if (!Array.isArray(runtimeStatuses)) runtimeStatuses = [];
  const runtimeCoverage = runtimeStatuses
    .filter((s: unknown) => s && typeof s === "object" && !Array.isArray(s))
    .map((s: Dict) => boundedRuntimeStatus(s));
  const coverageCaveats: string[] = [];
  if (runtimeCoverage.length === 0) {
    coverageCaveats.push("No runtime coverage metadata was available for threshold evidence scanning.");
  }
  if (runtimeCoverage.some((s: Dict) => ["missing", "sparse", "degraded", "skipped"].includes(s.status))) {
    coverageCaveats.push("Runtime coverage is incomplete or degraded; absence of warning evidence is not proof of absence.");
  }

  const groups = new Map<string, Dict[]>();
  const degradations: Dict[] = [];
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      degradations.push({ reason: "malformed_record" });
      continue;
    }
    const key = startupConversationKey(record);
    if (key === null) {
      degradations.push({ record: recordLabel(record, salt), reason: "missing_conversation_key" });
      continue;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(record);
  }

  const warningCounts: Record<string, number> = {};
  const artifactCounts: Record<string, number> = {};
  const capabilityCounts: Record<string, number> = {};
  const sourceCounts: Record<string, number> = {};
  const detailStatusCounts: Record<string, number> = {};
  const warningEvents: Dict[] = [];

  for (const [conversationKey, items] of groups) {
    items.sort((a, b) => {
      const ta = String(a.timestamp ?? "");
      const tb = String(b.timestamp ?? "");
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
    let capability = "unknown";
    let pending: Array<{ event: Dict; metrics: { word_count: number; anchor_count: number } }> = [];
    for (const record of items) {
      const text = recordThresholdText(record);
      const data = record.data && typeof record.data === "object" && !Array.isArray(record.data) ? record.data : {};
      const actor = data.actor;
      if (actor === "user") {
        capability = capabilityInvocation(text) || "unknown";
        pending = [];
        continue;
      }
      if (actor === "assistant") {
        capability = introCapability(text) || capability;
      }

      const warnings = thresholdWarnings(text);
      if (warnings.length > 0) {
        const artifactLabel = canonicalArtifactLabel(text, loaded) || "unknown";
        const beforeMetrics = detailMetrics(text);
        const event: Dict = {
          event_label: recordLabel(record, salt),
          conversation: hashLabel("session", conversationKey, salt),
          capability,
          artifact_label: artifactLabel,
          warnings,
          detail_loss_status: "not_assessed",
          rewrite_followup: null,
          observed_counts: {
            warning_word_count: beforeMetrics.word_count,
            warning_anchor_count: beforeMetrics.anchor_count,
          },
        };
        warningEvents.push(event);
        pending.push({ event, metrics: beforeMetrics });
        inc(artifactCounts, artifactLabel);
        inc(capabilityCounts, capability);
        for (const warning of warnings) {
          inc(warningCounts, `${warning.family}.${warning.category}`);
          inc(sourceCounts, warning.threshold_source);
        }
      }

      if (pending.length > 0 && record.source_kind === "tool_call") {
        const [eventClass] = classifyStartupEvent(record);
        if (eventClass === "implementation_boundary") {
          const afterMetrics = detailMetrics(text);
          for (const pendingItem of pending) {
            const event = pendingItem.event;
            if (event.rewrite_followup !== null) continue;
            const status = detailLossStatus(pendingItem.metrics, afterMetrics);
            event.detail_loss_status = status;
            event.rewrite_followup = {
              event_label: recordLabel(record, salt),
              event_class: eventClass,
              word_count_delta: afterMetrics.word_count - pendingItem.metrics.word_count,
              anchor_count_delta: afterMetrics.anchor_count - pendingItem.metrics.anchor_count,
            };
            inc(detailStatusCounts, status);
          }
          pending = [];
        }
      }
    }
    for (const pendingItem of pending) {
      inc(detailStatusCounts, pendingItem.event.detail_loss_status);
    }
  }

  if (degradations.length > 0) {
    coverageCaveats.push("One or more records were skipped because they were malformed or lacked conversation identity.");
  }
  return {
    output_envelope: THRESHOLD_EVIDENCE_ENVELOPE,
    contract_version: loaded.version,
    generated_at: nowIsoSeconds(),
    total_records: records.length,
    runtime_coverage: runtimeCoverage,
    coverage_caveats: [...new Set(coverageCaveats)],
    counts: {
      warning_events: warningEvents.length,
      by_warning: counterDict(warningCounts),
      by_artifact: counterDict(artifactCounts),
      by_capability: counterDict(capabilityCounts),
      by_threshold_source: counterDict(sourceCounts),
      by_detail_loss_status: counterDict(detailStatusCounts),
    },
    warning_events: warningEvents,
    degradations,
    privacy_redaction_summary: {
      raw_transcript_text: "not_emitted",
      raw_tool_arguments: "not_emitted",
      full_local_paths: "not_emitted",
      raw_store_paths: "not_emitted",
      session_ids: "salted_or_not_emitted",
      artifact_labels: "canonical_only",
    },
  };
}

export function scanRetainedThresholdEvidence(
  artifacts: Record<string, string>,
  opts: { salt: string; contract?: Dict | null },
): Dict {
  const salt = opts.salt;
  const loaded = opts.contract ?? loadContract();
  const warningCounts: Record<string, number> = {};
  const artifactCounts: Record<string, number> = {};
  const sourceCounts: Record<string, number> = {};
  const detailStatusCounts: Record<string, number> = {};
  const warningEvents: Dict[] = [];

  for (const sourceLabel of Object.keys(artifacts).sort()) {
    const text = artifacts[sourceLabel];
    if (typeof sourceLabel !== "string" || typeof text !== "string") continue;
    const artifactLabel =
      canonicalArtifactLabel(sourceLabel, loaded) || canonicalArtifactLabel(text, loaded) || "unknown";
    const warnings = thresholdWarnings(text);
    if (warnings.length === 0) continue;
    const postAuditMarkers = countMatches(POST_AUDIT_FLAG_RE, text);
    const budgetMentions = countMatches(BUDGET_PRESSURE_RE, text);
    const fullPlanBudgetPressure = artifactLabel === "PLAN.md" && budgetMentions > 0 && FULL_PLAN_BUDGET_RE.test(text);
    const detailStatus =
      postAuditMarkers && fullPlanBudgetPressure ? "retained_artifact_false_positive_signal" : "not_assessed";

    const event: Dict = {
      event_label: hashLabel("record", sourceLabel, salt),
      conversation: "retained_artifacts",
      capability: "agentera",
      artifact_label: artifactLabel,
      evidence_source: "retained_artifact",
      warnings,
      detail_loss_status: detailStatus,
      rewrite_followup: null,
      observed_counts: {
        post_audit_flag_markers: postAuditMarkers,
        budget_pressure_mentions: budgetMentions,
      },
    };
    warningEvents.push(event);
    inc(artifactCounts, artifactLabel);
    inc(detailStatusCounts, detailStatus);
    for (const warning of warnings) {
      inc(warningCounts, `${warning.family}.${warning.category}`);
      inc(sourceCounts, warning.threshold_source);
    }
  }

  return {
    output_envelope: THRESHOLD_EVIDENCE_ENVELOPE,
    contract_version: loaded.version,
    generated_at: nowIsoSeconds(),
    total_records: Object.keys(artifacts).length,
    runtime_coverage: [],
    coverage_caveats: [],
    counts: {
      warning_events: warningEvents.length,
      by_warning: counterDict(warningCounts),
      by_artifact: counterDict(artifactCounts),
      by_capability: warningEvents.length > 0 ? { agentera: warningEvents.length } : {},
      by_threshold_source: counterDict(sourceCounts),
      by_detail_loss_status: counterDict(detailStatusCounts),
    },
    warning_events: warningEvents,
    degradations: [],
    privacy_redaction_summary: {
      raw_artifact_text: "not_emitted",
      raw_transcript_text: "not_emitted",
      raw_tool_arguments: "not_emitted",
      full_local_paths: "not_emitted",
      artifact_labels: "canonical_only",
    },
  };
}

export function classifyThresholdEvidence(scan: Dict): Dict {
  let events = scan.warning_events;
  if (!Array.isArray(events)) events = [];
  let coverageCaveats = scan.coverage_caveats;
  if (!Array.isArray(coverageCaveats)) coverageCaveats = [];

  const byCategory = new Map<string, Dict>();
  const coverageCaveated = coverageCaveats.length > 0;
  const unsupported = coverageCaveats.length > 0 && events.length === 0;

  for (const event of events) {
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    const classification = eventClassification(event, coverageCaveated);
    const artifact = typeof event.artifact_label === "string" ? event.artifact_label : "unknown";
    const capability = typeof event.capability === "string" ? event.capability : "unknown";
    const detailStatus = typeof event.detail_loss_status === "string" ? event.detail_loss_status : "not_assessed";
    for (const key of eventWarningKeys(event)) {
      let entry = byCategory.get(key);
      if (!entry) {
        entry = {
          warning: key,
          event_count: 0,
          artifacts: new Set<string>(),
          capabilities: new Set<string>(),
          classification_counts: {} as Record<string, number>,
          detail_loss_status_counts: {} as Record<string, number>,
          event_labels: [] as string[],
        };
        byCategory.set(key, entry);
      }
      entry.event_count += 1;
      entry.artifacts.add(artifact);
      entry.capabilities.add(capability);
      inc(entry.classification_counts, classification);
      inc(entry.detail_loss_status_counts, detailStatus);
      if (typeof event.event_label === "string") entry.event_labels.push(event.event_label);
    }
  }

  const categories: Dict[] = [];
  let repeatedFalsePositive = false;
  const classificationCounts: Record<string, number> = {};
  for (const key of [...byCategory.keys()].sort()) {
    const entry = byCategory.get(key)!;
    const classification = categoryClassification(entry.classification_counts);
    inc(classificationCounts, classification);
    if (classification === "likely_false_positive" && entry.event_count >= 2) repeatedFalsePositive = true;
    categories.push({
      warning: key,
      classification,
      event_count: entry.event_count,
      artifacts: [...entry.artifacts].sort(),
      capabilities: [...entry.capabilities].sort(),
      event_classification_counts: counterDict(entry.classification_counts),
      detail_loss_status_counts: counterDict(entry.detail_loss_status_counts),
      event_labels: entry.event_labels,
    });
  }
  if (unsupported) inc(classificationCounts, "unsupported_by_available_coverage");

  let recommendation: Dict;
  if (repeatedFalsePositive) {
    recommendation = {
      action: "consider_minimal_threshold_or_diagnostic_change",
      reason: "At least one warning category has repeated redacted evidence of possible useful detail removal.",
    };
  } else if (unsupported) {
    recommendation = {
      action: "defer_without_threshold_change",
      reason: "Available runtime coverage cannot support a false-positive conclusion.",
    };
  } else {
    recommendation = {
      action: "no_threshold_change_yet",
      reason: "False-positive evidence is absent, single-instance, legitimate pressure, or inconclusive.",
    };
  }

  return {
    output_envelope: THRESHOLD_CLASSIFICATION_ENVELOPE,
    input_envelope: scan.output_envelope,
    generated_at: nowIsoSeconds(),
    categories,
    counts: {
      by_classification: counterDict(classificationCounts),
      category_count: categories.length,
      repeated_false_positive_categories: categories.filter(
        (c) => c.classification === "likely_false_positive" && c.event_count >= 2,
      ).length,
    },
    recommendation,
    coverage_caveats: coverageCaveats.map((c: unknown) => String(c)),
    privacy_redaction_summary: scan.privacy_redaction_summary || {
      raw_transcript_text: "not_emitted",
      raw_tool_arguments: "not_emitted",
    },
  };
}

// ===========================================================================
// Slice 3: startup record classification into state-gathering sequences
// ===========================================================================

function hasTranscriptBearingField(record: Dict): boolean {
  if ("transcript" in record) return true;
  const data = record.data;
  return Boolean(data && typeof data === "object" && !Array.isArray(data) && "transcript" in data);
}

function boundedReason(reason: string, contract: Dict): string {
  const allowed = new Set([...(contract.degradation_reasons ?? []), ...BOUNDARY_DEGRADATION_REASONS]);
  return allowed.has(reason) ? reason : "malformed_record";
}

function estimatedToolArgumentTokens(record: Dict): number {
  return Math.ceil(Buffer.byteLength(argumentsText(record), "utf8") / 4);
}

function timestampUtc(value: unknown): Date | null {
  return parseTimestamp(value);
}

function newSequence(conversationKey: string, capability: string | null, salt: string): Dict {
  const counts: Record<string, number> = {};
  for (const eventClass of [...STATE_EVENT_CLASSES].sort()) counts[eventClass] = 0;
  return {
    conversation: hashLabel("session", conversationKey, salt),
    capability: capability || "unknown",
    start_anchor: "first_cli_state_call_after_capability_invocation",
    events: [],
    counts,
    cli_artifact_labels: [],
    raw_artifact_labels_after_cli: [],
    redundant_raw_artifact_labels: [],
    estimated_raw_after_cli_tokens_by_artifact: {},
    estimated_redundant_raw_tokens_by_artifact: {},
    degradation_reasons: [],
  };
}

function eventOutput(
  record: Dict,
  opts: {
    eventClass: string;
    phase: string;
    salt: string;
    artifactLabel?: string | null;
    stateCommand?: string | null;
    redundantWithCli?: boolean | null;
  },
): Dict {
  const item: Dict = {
    record: recordLabel(record, opts.salt),
    event_class: STATE_EVENT_CLASSES.has(opts.eventClass) ? opts.eventClass : "non_state_context",
    phase: opts.phase,
  };
  if (opts.artifactLabel) item.artifact_label = opts.artifactLabel;
  if (opts.stateCommand) item.state_command = opts.stateCommand;
  if (opts.redundantWithCli !== undefined && opts.redundantWithCli !== null) {
    item.redundant_with_cli = opts.redundantWithCli;
  }
  return item;
}

export function classifyStartupRecords(corpus: Dict, opts: { salt: string; contract?: Dict | null }): Dict {
  const salt = opts.salt;
  const loaded = opts.contract ?? loadContract();
  const boundary = timestampUtc((loaded.boundary ?? {}).committed_at);
  const records = corpus && typeof corpus === "object" && !Array.isArray(corpus) ? (corpus.records ?? []) : [];
  const degradations: Dict[] = [];
  const groups = new Map<string, Dict[]>();
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      degradations.push({ reason: boundedReason("malformed_record", loaded) });
      continue;
    }
    if (hasTranscriptBearingField(record)) {
      degradations.push({ record: recordLabel(record, salt), reason: "privacy_redaction_required" });
      continue;
    }
    const timestamp = timestampUtc(record.timestamp);
    if (timestamp === null) {
      degradations.push({ record: recordLabel(record, salt), reason: "missing_timestamp" });
      continue;
    }
    if (boundary !== null && timestamp.getTime() <= boundary.getTime()) {
      degradations.push({ record: recordLabel(record, salt), reason: "pre_boundary_record" });
      continue;
    }
    const key = startupConversationKey(record);
    if (key === null) {
      degradations.push({ record: recordLabel(record, salt), reason: "missing_conversation_key" });
      continue;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(record);
  }

  const sequences: Dict[] = [];
  for (const [conversationKey, items] of groups) {
    items.sort((a, b) => {
      const ta = String(a.timestamp ?? "");
      const tb = String(b.timestamp ?? "");
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
    const state = {
      active: null as Dict | null,
      segmentCapability: null as string | null,
      segmentOpen: false,
      segmentHadStateSequence: false,
      cliArtifactsSeen: new Set<string>(),
    };

    const closeActive = (): void => {
      if (state.active !== null) {
        state.active.cli_artifact_labels = [...state.cliArtifactsSeen].sort();
        sequences.push(state.active);
        state.segmentHadStateSequence = true;
        state.active = null;
        state.cliArtifactsSeen = new Set();
      }
    };

    for (const record of items) {
      const text = extractText(record);
      const data = record.data && typeof record.data === "object" && !Array.isArray(record.data) ? record.data : {};
      const actor = data.actor;
      if (actor === "user") {
        closeActive();
        if (state.segmentOpen && !state.segmentHadStateSequence) {
          degradations.push({
            conversation: hashLabel("session", conversationKey, salt),
            reason: "no_agentera_state_sequence",
          });
        }
        state.segmentCapability = capabilityInvocation(text);
        state.segmentOpen = state.segmentCapability !== null;
        state.segmentHadStateSequence = false;
        continue;
      }

      if (!state.segmentOpen) {
        const introCap = actor === "assistant" ? introCapability(text) : null;
        if (introCap) {
          state.segmentCapability = introCap;
          state.segmentOpen = true;
        } else {
          continue;
        }
      }

      const [eventClass, artifactLabel, stateCommand, cliArtifactLabels] = classifyStartupEvent(record);
      if (eventClass === "non_state_context") continue;
      if (eventClass === "cli_state_call" && state.active === null) {
        state.active = newSequence(conversationKey, state.segmentCapability, salt);
      }
      if (state.active === null) continue;
      if (eventClass === "cli_state_call") {
        for (const label of cliArtifactLabels) state.cliArtifactsSeen.add(label);
      }
      const redundant =
        eventClass === "raw_artifact_access" && artifactLabel
          ? state.cliArtifactsSeen.has(artifactLabel)
          : null;
      const phase = eventClass === "implementation_boundary" ? "implementation_boundary" : "state_gathering";
      state.active.counts[eventClass] += 1;
      state.active.events.push(
        eventOutput(record, {
          eventClass,
          phase,
          salt,
          artifactLabel,
          stateCommand,
          redundantWithCli: redundant,
        }),
      );
      if (eventClass === "raw_artifact_access" && artifactLabel) {
        state.active.raw_artifact_labels_after_cli.push(artifactLabel);
        const estimatedTokens = estimatedToolArgumentTokens(record);
        const rawEstimates = state.active.estimated_raw_after_cli_tokens_by_artifact;
        rawEstimates[artifactLabel] = (rawEstimates[artifactLabel] ?? 0) + estimatedTokens;
        if (redundant) {
          state.active.redundant_raw_artifact_labels.push(artifactLabel);
          const redundantEstimates = state.active.estimated_redundant_raw_tokens_by_artifact;
          redundantEstimates[artifactLabel] = (redundantEstimates[artifactLabel] ?? 0) + estimatedTokens;
        }
      }
      if (eventClass === "implementation_boundary") {
        closeActive();
        state.segmentOpen = false;
        state.segmentCapability = null;
        state.segmentHadStateSequence = false;
      }
    }
    closeActive();
    if (state.segmentOpen && !state.segmentHadStateSequence) {
      degradations.push({
        conversation: hashLabel("session", conversationKey, salt),
        reason: "no_agentera_state_sequence",
      });
    }
  }
  return {
    contract_version: loaded.version,
    boundary_source: (loaded.boundary ?? {}).source,
    state_gathering_sequences: sequences,
    degradations,
  };
}

// ===========================================================================
// Slice 4: startup metrics aggregation + threshold derivation
// ===========================================================================

export const STARTUP_METRICS_ENVELOPE = "startup_state_metrics_v1";
export const TOKEN_ESTIMATOR_VERSION = "approx_bytes_div_4_v1";

/** Python round() — round half to even on IEEE-754 doubles. */
function pyRound(x: number, ndigits: number): number {
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
class Flt {
  constructor(public readonly v: number) {}
  valueOf(): number {
    return this.v;
  }
  toJSON(): number {
    return this.v;
  }
}
function flt(n: number): Flt {
  return new Flt(n);
}
function formatFloat(v: number): string {
  return Number.isInteger(v) ? `${v}.0` : String(v);
}
/** Python str()/f-string rendering for report scalars. */
function pyFmt(value: unknown): string {
  if (value instanceof Flt) return formatFloat(value.v);
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return String(value);
}

function safeInt(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}

function mergeTokenEstimates(counter: Record<string, number>, value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [label, estimate] of Object.entries(value)) {
    if (typeof label === "string" && typeof estimate === "number" && Number.isInteger(estimate)) {
      counter[label] = (counter[label] ?? 0) + estimate;
    }
  }
}

function sequenceCount(sequence: Dict, eventClass: string): number {
  const counts = sequence.counts;
  if (counts && typeof counts === "object" && typeof counts[eventClass] === "number") {
    return counts[eventClass];
  }
  return (sequence.events ?? []).filter(
    (event: Dict) => event && typeof event === "object" && event.event_class === eventClass,
  ).length;
}

function distribution(values: number[]): Dict {
  if (values.length === 0) {
    return { count: 0, min: 0, max: 0, mean: 0, p50: 0, p75: 0, histogram: {} };
  }
  const ordered = [...values].sort((a, b) => a - b);
  const percentile = (fraction: number): number => {
    const index = Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction - 1));
    return ordered[Math.max(index, 0)];
  };
  const histCounts: Record<string, number> = {};
  for (const v of ordered) histCounts[v] = (histCounts[v] ?? 0) + 1;
  const histogram: Record<string, number> = {};
  for (const key of Object.keys(histCounts).map(Number).sort((a, b) => a - b)) {
    histogram[String(key)] = histCounts[key];
  }
  return {
    count: ordered.length,
    min: ordered[0],
    max: ordered[ordered.length - 1],
    mean: flt(pyRound(ordered.reduce((a, b) => a + b, 0) / ordered.length, 2)),
    p50: percentile(0.5),
    p75: percentile(0.75),
    histogram,
  };
}

function unionAll(map: Record<string, Set<string>>): Set<string> {
  const out = new Set<string>();
  for (const s of Object.values(map)) for (const v of s) out.add(v);
  return out;
}

function deriveStateThresholds(args: {
  totalSequences: number;
  perCapability: Record<string, Dict>;
  rawAfterCliPerSequence: number[];
  redundantRawPerSequence: number[];
  redundantCounts: Record<string, number>;
  redundantCapabilities: Record<string, Set<string>>;
  confidenceCaveats: string[];
}): Dict {
  const capabilityCount = Object.keys(args.perCapability).length;
  const credibleDistribution = args.totalSequences >= 3;
  const rawDistribution = distribution(args.rawAfterCliPerSequence);
  const redundantDistribution = distribution(args.redundantRawPerSequence);
  const redundantArtifacts: Record<string, Dict> = {};
  for (const label of Object.keys(args.redundantCounts).sort()) {
    const count = args.redundantCounts[label];
    if (count > 0) {
      redundantArtifacts[label] = {
        count,
        capability_count: (args.redundantCapabilities[label] ?? new Set()).size,
      };
    }
  }
  const redundantSequenceCount = args.redundantRawPerSequence.filter((v) => v > 0).length;
  const aggregateRedundantCapabilities =
    Object.keys(args.redundantCapabilities).length > 0 ? unionAll(args.redundantCapabilities) : new Set<string>();

  let redundantSequenceThreshold: number | null;
  let thresholdReason: string;
  if (credibleDistribution) {
    redundantSequenceThreshold = Math.max(2, Math.ceil(args.totalSequences * 0.2));
    thresholdReason =
      "Selected from post-boundary state-gathering distribution: raw artifact " +
      "access after CLI state must recur in at least 20% of measured sequences, " +
      "with a floor of two sequences.";
  } else {
    redundantSequenceThreshold = null;
    thresholdReason = "No broad-envelope threshold: fewer than three state-gathering sequences were measured.";
  }

  let broadTrigger: Dict | null = null;
  if (credibleDistribution) {
    for (const [label, item] of Object.entries(redundantArtifacts)) {
      if (item.count >= (redundantSequenceThreshold as number) && item.capability_count >= 2) {
        broadTrigger = {
          event_class: "raw_artifact_access",
          artifact_label: label,
          count: item.count,
          capability_count: item.capability_count,
          threshold: redundantSequenceThreshold,
        };
        break;
      }
    }
    if (broadTrigger === null && redundantSequenceCount >= (redundantSequenceThreshold as number)) {
      broadTrigger = {
        event_class: "raw_artifact_access",
        artifact_label: "multiple",
        count: redundantSequenceCount,
        capability_count: aggregateRedundantCapabilities.size,
        threshold: redundantSequenceThreshold,
        aggregate: true,
      };
    }
  }

  let recommendation: Dict;
  if (broadTrigger !== null) {
    const trigger = broadTrigger.aggregate
      ? `redundant_raw_artifact_access in ${broadTrigger.count} of ${args.totalSequences} state sequences`
      : `raw_artifact_access_after_cli:${broadTrigger.artifact_label} repeated ` +
        `${broadTrigger.count} times across ${broadTrigger.capability_count} capabilities`;
    recommendation = {
      action: "plan_cli_startup_envelope",
      measured_trigger: trigger,
      rationale: "Raw artifact access after CLI state exceeded the broad startup-envelope threshold.",
    };
  } else if (Object.keys(redundantArtifacts).length > 0) {
    recommendation = {
      action: "targeted_capability_guidance_fixes",
      measured_trigger: "raw_artifact_access_after_cli_hotspot",
      rationale: "Raw artifact access follows CLI state, but evidence is narrow or below the broad-envelope gate.",
    };
  } else {
    recommendation = {
      action: "close_without_implementation",
      measured_trigger: "none",
      rationale: "No raw artifact access after overlapping CLI state was measured.",
    };
  }
  if (args.confidenceCaveats.includes("insufficient_post_2_3_state_sequences")) {
    recommendation = {
      action: "close_without_implementation",
      measured_trigger: "weak_evidence",
      rationale: "No post-boundary Agentera state-gathering sequences were available.",
    };
  }

  return {
    measured_distribution: {
      raw_after_cli_per_sequence: rawDistribution,
      redundant_raw_after_cli_per_sequence: redundantDistribution,
      redundant_sequence_count: redundantSequenceCount,
      redundant_artifacts: redundantArtifacts,
      capability_count: capabilityCount,
    },
    action_thresholds: {
      startup_envelope: {
        credible: credibleDistribution,
        redundant_sequence_threshold: redundantSequenceThreshold,
        selection_reason: thresholdReason,
      },
      targeted_guidance: {
        credible: Object.keys(redundantArtifacts).length > 0,
        selection_reason:
          "Selected when raw artifact access after CLI state is narrow or below the broad-envelope threshold.",
      },
    },
    recommendation,
  };
}

export function aggregateStartupMetrics(intermediateInput: Dict): Dict {
  const intermediate = intermediateInput && typeof intermediateInput === "object" && !Array.isArray(intermediateInput) ? intermediateInput : {};
  const sequences = Array.isArray(intermediate.state_gathering_sequences) ? intermediate.state_gathering_sequences : [];
  const degradations = Array.isArray(intermediate.degradations) ? intermediate.degradations : [];

  const perCapability: Record<string, Dict> = {};
  const cliCommandCounts: Record<string, number> = {};
  const rawAfterCliCounts: Record<string, number> = {};
  const redundantRawCounts: Record<string, number> = {};
  const rawAfterCliTokenEstimates: Record<string, number> = {};
  const redundantRawTokenEstimates: Record<string, number> = {};
  const proseCounts: Record<string, number> = {};
  const implementationCounts: Record<string, number> = {};
  const degradationCounts: Record<string, number> = {};
  const redundantCapabilities: Record<string, Set<string>> = {};
  const rawAfterCliPerSequence: number[] = [];
  const redundantRawPerSequence: number[] = [];

  for (const item of degradations) {
    if (item && typeof item === "object" && typeof item.reason === "string") {
      inc(degradationCounts, item.reason);
    }
  }

  for (const sequence of sequences) {
    if (!sequence || typeof sequence !== "object" || Array.isArray(sequence)) continue;
    let capability = sequence.capability;
    if (typeof capability !== "string" || !capability) capability = "unknown";
    if (!(capability in perCapability)) {
      perCapability[capability] = {
        state_sequences: 0,
        cli_state_call: 0,
        raw_artifact_access_after_cli: 0,
        redundant_raw_artifact_access: 0,
        capability_prose_read: 0,
        implementation_boundary: 0,
      };
    }
    const cc = perCapability[capability];
    cc.state_sequences += 1;
    const cliCount = sequenceCount(sequence, "cli_state_call");
    const rawCount = (sequence.raw_artifact_labels_after_cli ?? []).length;
    const redundantCount = (sequence.redundant_raw_artifact_labels ?? []).length;
    const proseCount = sequenceCount(sequence, "capability_prose_read");
    const implCount = sequenceCount(sequence, "implementation_boundary");
    cc.cli_state_call += cliCount;
    cc.raw_artifact_access_after_cli += rawCount;
    cc.redundant_raw_artifact_access += redundantCount;
    cc.capability_prose_read += proseCount;
    cc.implementation_boundary += implCount;
    proseCounts[capability] = (proseCounts[capability] ?? 0) + proseCount;
    implementationCounts[capability] = (implementationCounts[capability] ?? 0) + implCount;
    rawAfterCliPerSequence.push(rawCount);
    redundantRawPerSequence.push(redundantCount);
    mergeTokenEstimates(rawAfterCliTokenEstimates, sequence.estimated_raw_after_cli_tokens_by_artifact);
    mergeTokenEstimates(redundantRawTokenEstimates, sequence.estimated_redundant_raw_tokens_by_artifact);

    for (const event of sequence.events ?? []) {
      if (!event || typeof event !== "object") continue;
      const stateCommand = event.state_command;
      if (event.event_class === "cli_state_call" && typeof stateCommand === "string") {
        inc(cliCommandCounts, stateCommand);
      }
      const label = event.artifact_label;
      if (event.event_class === "raw_artifact_access" && typeof label === "string") {
        inc(rawAfterCliCounts, label);
        if (event.redundant_with_cli === true) {
          inc(redundantRawCounts, label);
          if (!(label in redundantCapabilities)) redundantCapabilities[label] = new Set();
          redundantCapabilities[label].add(capability);
        }
      }
    }
    for (const reason of sequence.degradation_reasons ?? []) {
      if (typeof reason === "string") inc(degradationCounts, reason);
    }
  }

  const totalSequences = sequences.filter((s: Dict) => s && typeof s === "object" && !Array.isArray(s)).length;
  let runtimeCoverage = Array.isArray(intermediate.runtime_coverage) ? intermediate.runtime_coverage : [];
  runtimeCoverage = runtimeCoverage
    .filter((s: unknown) => s && typeof s === "object" && !Array.isArray(s))
    .map((s: Dict) => boundedRuntimeStatus(s));
  const runtimeStatusCounts: Record<string, number> = {};
  for (const status of runtimeCoverage) {
    if (status && typeof status === "object" && typeof status.status === "string") inc(runtimeStatusCounts, status.status);
  }

  const confidenceCaveats: string[] = [];
  if (totalSequences === 0) confidenceCaveats.push("insufficient_post_2_3_state_sequences");
  if (runtimeCoverage.some((s: Dict) => s && typeof s === "object" && ["missing", "sparse", "degraded", "skipped"].includes(s.status))) {
    confidenceCaveats.push("runtime_coverage_incomplete_or_degraded");
  }
  if (Object.keys(degradationCounts).length > 0) confidenceCaveats.push("some_records_or_sequences_degraded");

  const thresholdDerivation = deriveStateThresholds({
    totalSequences,
    perCapability,
    rawAfterCliPerSequence,
    redundantRawPerSequence,
    redundantCounts: redundantRawCounts,
    redundantCapabilities,
    confidenceCaveats,
  });
  const sequencesWithRaw = rawAfterCliPerSequence.filter((v) => v > 0).length;
  const sequencesWithRedundant = redundantRawPerSequence.filter((v) => v > 0).length;
  const recommendation = thresholdDerivation.recommendation;

  const sortedPerCapability: Record<string, Dict> = {};
  for (const key of Object.keys(perCapability).sort()) sortedPerCapability[key] = perCapability[key];

  const sumValues = (o: Record<string, number>): number => Object.values(o).reduce((a, b) => a + b, 0);

  const result: Dict = {
    output_envelope: STARTUP_METRICS_ENVELOPE,
    input_envelope: intermediate.output_envelope ?? null,
    contract_version: intermediate.contract_version ?? null,
    generated_at: nowIsoSeconds(),
    boundary_source: intermediate.boundary_source ?? null,
    boundary_commit: intermediate.boundary_commit ?? null,
    boundary_committed_at: intermediate.boundary_committed_at ?? null,
    benchmark_mode: intermediate.benchmark_mode || "full_boundary_snapshot",
    benchmark_previous_watermark_at: intermediate.benchmark_previous_watermark_at ?? null,
    benchmark_window_started_after: intermediate.benchmark_window_started_after ?? null,
    benchmark_watermark_at: intermediate.benchmark_watermark_at ?? null,
    corpus_adapter_version: intermediate.corpus_adapter_version ?? null,
    runtime_coverage: runtimeCoverage,
    runtime_status_counts: counterDict(runtimeStatusCounts),
    runtime_record_counts: intermediate.runtime_record_counts || {},
    total_records: safeInt(intermediate.total_records_read),
    total_state_sequences: totalSequences,
    state_sequences_with_raw_after_cli: sequencesWithRaw,
    state_sequences_with_redundant_raw_access: sequencesWithRedundant,
    total_cli_state_calls: sumValues(cliCommandCounts),
    total_raw_artifact_access_after_cli: sumValues(rawAfterCliCounts),
    total_redundant_raw_artifact_accesses: sumValues(redundantRawCounts),
    raw_after_cli_sequence_rate: totalSequences ? flt(pyRound(sequencesWithRaw / totalSequences, 4)) : 0,
    redundant_raw_sequence_rate: totalSequences ? flt(pyRound(sequencesWithRedundant / totalSequences, 4)) : 0,
    per_capability_state_counts: sortedPerCapability,
    cli_state_command_counts: counterDict(cliCommandCounts),
    raw_artifact_access_after_cli_counts: counterDict(rawAfterCliCounts),
    redundant_raw_artifact_access_counts: counterDict(redundantRawCounts),
    token_estimator_version: TOKEN_ESTIMATOR_VERSION,
    estimated_raw_after_cli_tokens: sumValues(rawAfterCliTokenEstimates),
    estimated_redundant_raw_tokens: sumValues(redundantRawTokenEstimates),
    estimated_raw_after_cli_tokens_by_artifact: counterDict(rawAfterCliTokenEstimates),
    estimated_redundant_raw_tokens_by_artifact: counterDict(redundantRawTokenEstimates),
    estimated_tokens_saved_vs_previous: null,
    estimated_tokens_saved_vs_previous_null_reason: "previous_row_missing",
    capability_prose_read_counts: counterDict(proseCounts),
    implementation_boundary_counts: counterDict(implementationCounts),
    degradation_reason_counts: counterDict(degradationCounts),
    privacy_redaction_summary: {
      raw_transcript_text: "not_emitted",
      full_local_paths: "not_emitted",
      raw_store_paths: "not_emitted",
      session_ids: "salted_or_not_emitted",
      artifact_labels: "canonical_only",
    },
    confidence_caveats: confidenceCaveats,
    insufficient_evidence_reason: totalSequences === 0 ? "no_post_2_3_state_sequences" : null,
    threshold_derivation: thresholdDerivation,
    startup_recommendation: recommendation,
    implementation_recommended: recommendation.action === "plan_cli_startup_envelope",
    compatibility_note: "Section 22 corpus records are read-only; aggregation consumes only startup_state_analysis_v1.",
  };
  if (totalSequences) {
    result.recommendation_gate_input = thresholdDerivation.measured_distribution;
  }
  return result;
}

// ===========================================================================
// Slice 5: startup report rendering + writing
// ===========================================================================

export const STARTUP_REPORT_MARKDOWN = "startup-overhead-report.md";
export const STARTUP_REPORT_JSON = "startup-overhead-report.json";

/** Python json.dumps(value, indent=2, sort_keys=True) — multiline, ensure_ascii, Flt-aware. */
function pyJsonIndent(value: unknown, level = 0, indent = "  "): string {
  const pad = indent.repeat(level);
  const childPad = indent.repeat(level + 1);
  if (value === null || value === undefined) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (value instanceof Flt) return formatFloat(value.v);
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return pyJsonString(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((v) => childPad + pyJsonIndent(v, level + 1, indent));
    return "[\n" + items.join(",\n") + "\n" + pad + "]";
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Dict).sort();
    if (keys.length === 0) return "{}";
    const items = keys.map((k) => childPad + pyJsonString(k) + ": " + pyJsonIndent((value as Dict)[k], level + 1, indent));
    return "{\n" + items.join(",\n") + "\n" + pad + "}";
  }
  return "null";
}

function markdownTable(headers: string[], rows: Array<Array<unknown>>): string[] {
  const lines = [
    "| " + headers.join(" | ") + " |",
    "| " + headers.map(() => "---").join(" | ") + " |",
  ];
  if (rows.length === 0) {
    return [...lines, "| " + headers.map(() => "none").join(" | ") + " |"];
  }
  return [...lines, ...rows.map((row) => "| " + row.map((v) => pyFmt(v)).join(" | ") + " |")];
}

export function renderStartupReport(metrics: Dict): string {
  const threshold = (metrics.threshold_derivation ?? {}).action_thresholds ?? {};
  const envelopeThreshold = threshold.startup_envelope ?? {};
  const guidanceThreshold = threshold.targeted_guidance ?? {};
  const recommendation = metrics.startup_recommendation ?? {};
  const measuredDistribution = (metrics.threshold_derivation ?? {}).measured_distribution ?? {};
  const runtimeCoverage = Array.isArray(metrics.runtime_coverage) ? metrics.runtime_coverage : [];
  const capabilityCounts = metrics.per_capability_state_counts ?? {};

  const lines: string[] = [
    "# Agentera Startup State-Access Analysis",
    "",
    "This report is local-only and privacy-preserving. It measures raw Agentera artifact access after CLI state calls during capability startup/state gathering.",
    "",
    "## Boundary Source",
    "",
    `- Contract version: \`${pyFmt(metrics.contract_version)}\``,
    `- Boundary source: \`${pyFmt(metrics.boundary_source)}\``,
    `- Boundary commit: \`${pyFmt(metrics.boundary_commit)}\``,
    `- Boundary timestamp: \`${pyFmt(metrics.boundary_committed_at)}\``,
    `- Corpus adapter version: \`${pyFmt(metrics.corpus_adapter_version)}\``,
    "",
    "## Benchmark Window",
    "",
    `- Mode: \`${pyFmt(metrics.benchmark_mode)}\``,
    `- Previous watermark: \`${pyFmt(metrics.benchmark_previous_watermark_at)}\``,
    `- Window started after: \`${pyFmt(metrics.benchmark_window_started_after)}\``,
    `- Watermark: \`${pyFmt(metrics.benchmark_watermark_at)}\``,
    "",
    "## Runtime Coverage",
    "",
  ];
  const runtimeRows: Array<Array<unknown>> = [];
  for (const status of runtimeCoverage) {
    if (status && typeof status === "object" && !Array.isArray(status)) {
      runtimeRows.push([
        status.runtime ?? "unknown",
        status.status ?? "unknown",
        status.reason ?? "unknown",
        status.record_count ?? 0,
        status.candidate_count ?? 0,
        status.error_count ?? 0,
      ]);
    }
  }
  lines.push(...markdownTable(["Runtime", "Status", "Reason", "Records", "Candidates", "Errors"], runtimeRows));
  lines.push(
    "",
    "## Metrics",
    "",
    `- Total state-gathering sequences: \`${pyFmt(metrics.total_state_sequences)}\``,
    `- Sequences with raw artifact access after CLI: \`${pyFmt(metrics.state_sequences_with_raw_after_cli)}\``,
    `- Sequences with redundant raw artifact access: \`${pyFmt(metrics.state_sequences_with_redundant_raw_access)}\``,
    `- Raw-after-CLI sequence rate: \`${pyFmt(metrics.raw_after_cli_sequence_rate)}\``,
    `- Redundant raw sequence rate: \`${pyFmt(metrics.redundant_raw_sequence_rate)}\``,
    `- CLI state command counts: \`${pyJsonDumps(metrics.cli_state_command_counts ?? {})}\``,
    `- Raw artifact access after CLI counts: \`${pyJsonDumps(metrics.raw_artifact_access_after_cli_counts ?? {})}\``,
    `- Redundant raw artifact access counts: \`${pyJsonDumps(metrics.redundant_raw_artifact_access_counts ?? {})}\``,
    "",
    "## Estimated Token Impact",
    "",
    `- Token estimator version: \`${pyFmt(metrics.token_estimator_version)}\``,
    `- Estimated raw-after-CLI tokens: \`${pyFmt(metrics.estimated_raw_after_cli_tokens)}\``,
    `- Estimated redundant raw tokens: \`${pyFmt(metrics.estimated_redundant_raw_tokens)}\``,
    `- Estimated raw-after-CLI tokens by artifact: \`${pyJsonDumps(metrics.estimated_raw_after_cli_tokens_by_artifact ?? {})}\``,
    `- Estimated redundant raw tokens by artifact: \`${pyJsonDumps(metrics.estimated_redundant_raw_tokens_by_artifact ?? {})}\``,
    `- Estimated tokens saved vs previous: \`${pyFmt(metrics.estimated_tokens_saved_vs_previous)}\``,
    `- Estimated tokens saved null reason: \`${pyFmt(metrics.estimated_tokens_saved_vs_previous_null_reason)}\``,
    "",
  );
  const capabilityRows: Array<Array<unknown>> = [];
  for (const capability of Object.keys(capabilityCounts).sort()) {
    const counts = capabilityCounts[capability];
    if (counts && typeof counts === "object" && !Array.isArray(counts)) {
      capabilityRows.push([
        capability,
        counts.state_sequences ?? 0,
        counts.cli_state_call ?? 0,
        counts.raw_artifact_access_after_cli ?? 0,
        counts.redundant_raw_artifact_access ?? 0,
        counts.capability_prose_read ?? 0,
      ]);
    }
  }
  lines.push(
    ...markdownTable(
      ["Capability", "Sequences", "CLI Calls", "Raw After CLI", "Redundant Raw", "Prose Reads"],
      capabilityRows,
    ),
  );
  lines.push(
    "",
    "## Threshold Rationale",
    "",
    `- Startup envelope threshold credible: \`${pyFmt(envelopeThreshold.credible)}\``,
    `- Redundant-sequence threshold: \`${pyFmt(envelopeThreshold.redundant_sequence_threshold)}\``,
    `- Startup envelope selection reason: ${pyFmt(envelopeThreshold.selection_reason)}`,
    `- Targeted-guidance selection reason: ${pyFmt(guidanceThreshold.selection_reason)}`,
    `- Measured distribution: \`${pyJsonDumps(measuredDistribution)}\``,
    "",
    "## Recommendation",
    "",
    `- Action: \`${pyFmt(recommendation.action)}\``,
    `- Measured trigger: \`${pyFmt(recommendation.measured_trigger)}\``,
    `- Rationale: ${pyFmt(recommendation.rationale)}`,
    `- Implementation recommended: \`${pyFmt(metrics.implementation_recommended)}\``,
    "",
    "## Privacy Caveats",
    "",
    "- Raw transcript text is not emitted.",
    "- Full local paths and raw store paths are not emitted.",
    "- Session identifiers are salted or omitted.",
    "- Raw artifact accesses use canonical artifact labels such as `PLAN.md`, not filesystem paths.",
    "- Runtime coverage may be incomplete or degraded; inspect `confidence_caveats` before selecting follow-up work.",
    "",
  );
  return lines.join("\n");
}

export function writeStartupReports(metrics: Dict, outputDir: string): Record<string, string> {
  fs.mkdirSync(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, STARTUP_REPORT_JSON);
  const markdownPath = path.join(outputDir, STARTUP_REPORT_MARKDOWN);
  fs.writeFileSync(jsonPath, pyJsonIndent(metrics) + "\n");
  fs.writeFileSync(markdownPath, renderStartupReport(metrics));
  return { structured: jsonPath, human_readable: markdownPath };
}
