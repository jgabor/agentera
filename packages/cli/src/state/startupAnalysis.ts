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
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(value);
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
