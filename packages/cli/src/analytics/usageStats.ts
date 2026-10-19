import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveProfileDirOverride, resolveXdgDataHome } from "../core/envPaths.js";
import { expanduser } from "../core/paths.js";
import type { JsonObject } from "../core/jsonValue.js";
import { tiersDirForCorpusPath, assessTiers, iterBoundedRecords, readTierCorpusMetadata } from "./extractCorpus/index.js";

/**
 * Suite usage analytics: detect skill invocations from a Section 22 corpus.
 * Faithful TS port of scripts/usage_stats.py. env/home/platform are injectable.
 */
type Env = Record<string, string | undefined>;

export const EXIT_STATUSES = new Set(["complete", "flagged", "stuck", "waiting"]);
export const TRIGGER_SLASH = "slash";
export const TRIGGER_NATURAL = "natural";

const MARKER_RE = /─{2,}\s+(\S)\s+(status|vision|discuss|research|plan|build|optimize|audit|document|profile|design|orchestrate)\s+·\s+([a-z]+(?:\s+\d+)?)\s+─{2,}/g;

export interface Marker {
  kind: string;
  skill: string;
  glyph: string;
  word: string;
  line: string;
}

export interface Invocation {
  skill: string;
  glyph: string;
  intro_word: string;
  intro_source_id: string;
  intro_timestamp: string;
  completed: boolean;
  exit_status: string | null;
  exit_source_id: string | null;
  exit_timestamp: string | null;
  trigger: string;
  project_id: string;
  source_class: string;
  source_product: string;
  active_runtime: boolean;
}

function newInvocation(init: Partial<Invocation> & { skill: string; glyph: string }): Invocation {
  return {
    skill: init.skill,
    glyph: init.glyph,
    intro_word: init.intro_word ?? "",
    intro_source_id: init.intro_source_id ?? "",
    intro_timestamp: init.intro_timestamp ?? "",
    completed: init.completed ?? false,
    exit_status: init.exit_status ?? null,
    exit_source_id: init.exit_source_id ?? null,
    exit_timestamp: init.exit_timestamp ?? null,
    trigger: init.trigger ?? TRIGGER_NATURAL,
    project_id: init.project_id ?? "",
    source_class: init.source_class ?? "active_runtime",
    source_product: init.source_product ?? "unknown",
    active_runtime: init.active_runtime ?? true,
  };
}

export function findMarkers(text: string): Marker[] {
  if (!text) {
    return [];
  }
  const markers: Marker[] = [];
  MARKER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MARKER_RE.exec(text)) !== null) {
    const word = match[3];
    const kind = EXIT_STATUSES.has(word) ? "exit" : "intro";
    markers.push({ kind, skill: match[2], glyph: match[1], word, line: match[0] });
  }
  return markers;
}

function isMapping(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isAssistantConversationTurn(record: unknown): boolean {
  if (!isMapping(record)) return false;
  if (record.source_kind !== "conversation_turn") return false;
  const data = record.data;
  if (!isMapping(data)) return false;
  return data.actor === "assistant";
}

function conversationKey(record: JsonObject): string | null {
  const sid = record.session_id;
  if (typeof sid === "string" && sid) return sid;
  const data = record.data;
  if (isMapping(data)) {
    const dsid = data.session_id;
    if (typeof dsid === "string" && dsid) return dsid;
  }
  const ssid = record.source_id;
  if (typeof ssid === "string" && ssid) return ssid;
  return null;
}

export function groupByConversation(records: Iterable<JsonObject>): Map<string, JsonObject[]> {
  const buckets = new Map<string, JsonObject[]>();
  for (const record of records) {
    if (!isAssistantConversationTurn(record)) continue;
    const key = conversationKey(record);
    if (key === null) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(record);
  }
  for (const items of buckets.values()) {
    stableSortByTimestamp(items);
  }
  return buckets;
}

function stableSortByTimestamp(items: JsonObject[]): void {
  items
    .map((item, index) => [item, index] as [JsonObject, number])
    .sort((a, b) => {
      const ta = String(a[0].timestamp ?? "");
      const tb = String(b[0].timestamp ?? "");
      if (ta < tb) return -1;
      if (ta > tb) return 1;
      return a[1] - b[1];
    })
    .forEach(([item], i) => {
      items[i] = item;
    });
}

export function pairInvocations(turns: Iterable<JsonObject>): Invocation[] {
  const pending = new Map<string, Invocation[]>();
  const completed: Invocation[] = [];
  for (const turn of turns) {
    const sid = String(turn.source_id ?? "");
    const ts = String(turn.timestamp ?? "");
    const text = ((isMapping(turn.data) ? turn.data.content : "") || "") as string; // cast: corpus record content from JSON.parse IO boundary
    for (const marker of findMarkers(text)) {
      if (marker.kind === "intro") {
        if (!pending.has(marker.skill)) pending.set(marker.skill, []);
        pending.get(marker.skill)!.push(
          newInvocation({
            skill: marker.skill,
            glyph: marker.glyph,
            intro_word: marker.word,
            intro_source_id: sid,
            intro_timestamp: ts,
            completed: false,
            source_class: String(turn.source_class ?? "active_runtime"),
            source_product: String(turn.source_product ?? turn.runtime ?? "unknown"),
            active_runtime: turn.active_runtime !== false && turn.source_class !== "historical_import",
          }),
        );
      } else {
        const queue = pending.get(marker.skill);
        if (!queue || queue.length === 0) continue;
        const inv = queue.pop()!;
        inv.completed = true;
        inv.exit_status = marker.word;
        inv.exit_source_id = sid;
        inv.exit_timestamp = ts;
        completed.push(inv);
      }
    }
  }
  const incomplete: Invocation[] = [];
  for (const queue of pending.values()) {
    incomplete.push(...queue);
  }
  return stableSort(completed.concat(incomplete), (inv) => [inv.intro_timestamp, inv.intro_source_id]);
}

function stableSort<T>(items: T[], key: (item: T) => Array<string | number>): T[] {
  return items
    .map((item, index) => [item, index] as [T, number])
    .sort((a, b) => {
      const ka = key(a[0]);
      const kb = key(b[0]);
      for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
        if (ka[i] < kb[i]) return -1;
        if (ka[i] > kb[i]) return 1;
      }
      return a[1] - b[1];
    })
    .map(([item]) => item);
}

// Retained only to classify command markup in consent-gated historical imports.
const HISTORICAL_COMMAND_XML_RE = /<command-name>\s*\/[A-Za-z0-9._:-]+\s*<\/command-name>/;
const BARE_SLASH_RE = /^\s*\/[A-Za-z0-9._:-]+(?:\s|$)/m;

export function classifyTrigger(userTurnText: string | null): string {
  if (!userTurnText) return TRIGGER_NATURAL;
  if (HISTORICAL_COMMAND_XML_RE.test(userTurnText)) return TRIGGER_SLASH;
  if (BARE_SLASH_RE.test(userTurnText)) return TRIGGER_SLASH;
  return TRIGGER_NATURAL;
}

function projectMatch(recordProjectId: string, requested: string): boolean {
  if (!recordProjectId || !requested) return false;
  return recordProjectId.includes(requested) || requested.includes(recordProjectId);
}

export function filterRecordsByProject(records: Iterable<JsonObject>, requested: string | null): JsonObject[] {
  if (requested === null) {
    return [...records];
  }
  const out: JsonObject[] = [];
  for (const record of records) {
    if (!isMapping(record)) continue;
    const pid = record.project_id ?? "";
    if (typeof pid === "string" && projectMatch(pid, requested)) {
      out.push(record);
    }
  }
  return out;
}

function precedingUserTurn(userTurns: JsonObject[], assistantTimestamp: string): JsonObject | null {
  let candidate: JsonObject | null = null;
  for (const turn of userTurns) {
    const ts = String(turn.timestamp ?? "");
    if (ts < assistantTimestamp) {
      candidate = turn;
    } else {
      break;
    }
  }
  return candidate;
}

export interface CorpusAnalysis {
  invocations: Invocation[];
  skills: Record<string, Record<string, number>>;
  project_filter: string | null;
  per_project: Record<string, Record<string, Record<string, number>>>;
  source_view: "active" | "all";
  source_provenance: Array<{
    source_class: string;
    source_product: string;
    active_runtime: boolean;
    records: number;
  }>;
}

function emptySkillBucket(): Record<string, number> {
  return { total: 0, completed: 0, incomplete: 0, trigger_slash: 0, trigger_natural: 0 };
}

function accumulate(bucket: Record<string, number>, inv: Invocation): void {
  bucket.total += 1;
  bucket[inv.completed ? "completed" : "incomplete"] += 1;
  bucket[inv.trigger === TRIGGER_SLASH ? "trigger_slash" : "trigger_natural"] += 1;
}

function activeAnalyticsRecord(record: JsonObject): boolean {
  if (record.active_runtime === false || record.source_class === "historical_import") return false;
  return record.runtime !== "claude" && record.runtime !== "claude-code";
}

export function analyzeCorpus(corpus: JsonObject, projectFilter: string | null = null, sourceView: "active" | "all" = "active"): CorpusAnalysis {
  const rawRecords = (isMapping(corpus) ? (corpus.records ?? []) : []) as unknown as Iterable<JsonObject>; // cast: corpus records from JSON.parse IO boundary
  return analyzeRecords(rawRecords, projectFilter, sourceView);
}

/**
 * Single-pass analysis over a record iterable. Bounded consumers feed the
 * tiered shard iterator here so non-conversation records (instruction documents,
 * project config signals, tool calls) are counted for provenance and discarded
 * rather than materialized; only conversation turns are retained as the analysis
 * working set. Mirrors `analyzeCorpus` exactly when given the full record array.
 */
export function analyzeRecords(records: Iterable<JsonObject>, projectFilter: string | null = null, sourceView: "active" | "all" = "active"): CorpusAnalysis {
  const provenanceCounts = new Map<string, { source_class: string; source_product: string; active_runtime: boolean; records: number }>();
  const userTurnsByConv = new Map<string, JsonObject[]>();
  const assistantByConv = new Map<string, JsonObject[]>();
  for (const record of records) {
    if (!isMapping(record)) continue;
    const isActive = activeAnalyticsRecord(record);
    if (sourceView === "active" && !isActive) continue;
    if (projectFilter !== null) {
      const pid = record.project_id ?? "";
      if (!(typeof pid === "string" && projectMatch(pid, projectFilter))) continue;
    }
    const sourceClass = String(record.source_class ?? (isActive ? "active_runtime" : "historical_import"));
    const sourceProduct = String(record.source_product ?? record.runtime ?? "unknown");
    const activeRuntime = isActive;
    const key = `${sourceClass}\0${sourceProduct}\0${activeRuntime}`;
    const current = provenanceCounts.get(key) ?? {
      source_class: sourceClass,
      source_product: sourceProduct,
      active_runtime: activeRuntime,
      records: 0,
    };
    current.records += 1;
    provenanceCounts.set(key, current);

    if (record.source_kind !== "conversation_turn") continue;
    const data = record.data;
    if (!isMapping(data)) continue;
    const ckey = conversationKey(record);
    if (ckey === null) continue;
    const actor = data.actor;
    if (actor === "user") {
      if (!userTurnsByConv.has(ckey)) userTurnsByConv.set(ckey, []);
      userTurnsByConv.get(ckey)!.push(record);
    } else if (actor === "assistant") {
      if (!assistantByConv.has(ckey)) assistantByConv.set(ckey, []);
      assistantByConv.get(ckey)!.push(record);
    }
  }
  for (const items of userTurnsByConv.values()) stableSortByTimestamp(items);
  for (const items of assistantByConv.values()) stableSortByTimestamp(items);

  const invocations: Invocation[] = [];
  for (const [sid, turns] of assistantByConv) {
    const tsToProject = new Map<string, string>();
    for (const t of turns) {
      tsToProject.set(String(t.timestamp ?? ""), String(t.project_id ?? ""));
    }
    for (const inv of pairInvocations(turns)) {
      inv.project_id = tsToProject.get(inv.intro_timestamp) ?? "";
      const preceding = precedingUserTurn(userTurnsByConv.get(sid) ?? [], inv.intro_timestamp);
      let precedingText = "";
      if (preceding !== null) {
        const data = isMapping(preceding.data) ? preceding.data : ({} as JsonObject);
        precedingText = (data.content || "") as string; // cast: corpus record content from JSON.parse IO boundary
      }
      inv.trigger = classifyTrigger(precedingText);
      invocations.push(inv);
    }
  }

  const sorted = stableSort(invocations, (inv) => [inv.intro_timestamp, inv.intro_source_id, inv.skill]);

  const skills: Record<string, Record<string, number>> = {};
  const perProject: Record<string, Record<string, Record<string, number>>> = {};
  for (const inv of sorted) {
    if (!(inv.skill in skills)) skills[inv.skill] = emptySkillBucket();
    accumulate(skills[inv.skill], inv);
    if (projectFilter === null && inv.project_id) {
      if (!(inv.project_id in perProject)) perProject[inv.project_id] = {};
      if (!(inv.skill in perProject[inv.project_id])) perProject[inv.project_id][inv.skill] = emptySkillBucket();
      accumulate(perProject[inv.project_id][inv.skill], inv);
    }
  }

  return {
    invocations: sorted,
    skills,
    project_filter: projectFilter,
    per_project: perProject,
    source_view: sourceView,
    source_provenance: [...provenanceCounts.values()].sort((a, b) => `${a.source_class}:${a.source_product}`.localeCompare(`${b.source_class}:${b.source_product}`)),
  };
}

// --- Paths -----------------------------------------------------------------

export const CORPUS_GUIDANCE = "Publish bounded tiers with `agentera stats refresh --consent local-history`; `--corpus PATH` points at a legacy corpus.json whose sibling `tiers/` is preferred when published.";

function homeDir(env: Env): string {
  return env.HOME ?? os.homedir();
}

export function defaultCorpusPath(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  const profileOverride = resolveProfileDirOverride(env);
  if (profileOverride) return path.join(expanduser(profileOverride), "intermediate", "corpus.json");
  const home = homeDir(env);
  let base: string;
  if (platform === "darwin") {
    base = path.join(home, "Library", "Application Support", "agentera");
  } else if (platform === "win32") {
    const appdata = env.APPDATA ?? path.join(home, "AppData", "Roaming");
    base = path.join(expanduser(appdata), "agentera");
  } else {
    base = path.join(resolveXdgDataHome(env, home), "agentera");
  }
  return path.join(base, "intermediate", "corpus.json");
}

export class CorpusUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorpusUnavailable";
  }
}

export const MAX_CORPUS_READ_BYTES = 64 * 1024 * 1024;

export function corpusTooLargeReason(corpusPath: string): string | null {
  try {
    const size = fs.statSync(corpusPath).size;
    if (size <= MAX_CORPUS_READ_BYTES) return null;
    return `corpus is too large to load (${size} bytes; max ${MAX_CORPUS_READ_BYTES}). Refresh bounded tiers with agentera stats refresh --consent local-history, or pass --corpus PATH to a smaller legacy extract (its sibling tiers/ is preferred when published).`;
  } catch {
    return null;
  }
}

export function loadCorpusOrRaise(corpusPath: string): JsonObject {
  if (!fs.existsSync(corpusPath)) {
    throw new CorpusUnavailable(`corpus.json not found at ${corpusPath}. ${CORPUS_GUIDANCE}`);
  }
  const tooLarge = corpusTooLargeReason(corpusPath);
  if (tooLarge) {
    throw new CorpusUnavailable(`corpus at ${corpusPath} ${tooLarge}`);
  }
  let corpus: unknown;
  try {
    corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
  } catch (exc) {
    throw new CorpusUnavailable(`corpus is not readable JSON: ${(exc as Error).message}`);
  }
  const records = (isMapping(corpus) ? (corpus.records ?? []) : []) as unknown[]; // cast: corpus records from JSON.parse IO boundary
  const hasTurn = Array.isArray(records) && records.some((r: unknown) => isMapping(r) && r.source_kind === "conversation_turn");
  if (!hasTurn) {
    throw new CorpusUnavailable(`corpus at ${corpusPath} contains no conversation_turn records. ${CORPUS_GUIDANCE}`);
  }
  return corpus as JsonObject; // cast: corpus from JSON.parse IO boundary
}

export function buildJsonPayload(analysis: CorpusAnalysis, opts: { generatedAt: string; extractedAt: string | null }): JsonObject {
  return {
    generated_at: opts.generatedAt,
    extracted_at: opts.extractedAt,
    project_filter: analysis.project_filter,
    source_view: analysis.source_view,
    source_provenance: analysis.source_provenance,
    skills: analysis.skills,
    per_project: analysis.per_project,
    invocations: analysis.invocations.map((inv) => ({ ...inv })),
  };
}

export function renderJson(analysis: CorpusAnalysis, opts: { generatedAt: string; extractedAt: string | null }): string {
  return JSON.stringify(buildJsonPayload(analysis, opts), null, 2);
}

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export interface UsageMainIo {
  out?: (text: string) => void;
  err?: (text: string) => void;
  env?: Env;
  platform?: NodeJS.Platform;
}

/**
 * Usage analytics engine: emit the JSON analytics document on stdout from
 * bounded evidence tiers, or from a legacy corpus when no tiers are published.
 * Returns 2 when the evidence is unavailable.
 */
export function usageMain(argv: string[], io: UsageMainIo = {}): number {
  const out = io.out ?? ((t: string) => process.stdout.write(t + "\n"));
  const err = io.err ?? ((t: string) => process.stderr.write(t + "\n"));
  const env = io.env ?? process.env;
  const platform = io.platform ?? process.platform;

  let corpus: string | null = null;
  let project: string | null = null;
  let sourceView: "active" | "all" = "active";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--corpus") corpus = argv[++i] ?? null;
    else if (a.startsWith("--corpus=")) corpus = a.slice("--corpus=".length);
    else if (a === "--project") project = argv[++i] ?? null;
    else if (a.startsWith("--project=")) project = a.slice("--project=".length);
    else if (a === "--sources" || a.startsWith("--sources=")) {
      const value = a === "--sources" ? argv[++i] : a.slice("--sources=".length);
      if (value !== "active" && value !== "all") {
        err(`usage_stats: unsupported --sources '${value}'; choose active or all`);
        return 2;
      }
      sourceView = value;
    }
  }

  const corpusPath = corpus ?? defaultCorpusPath(env, platform);

  // Bounded tier path: analyze real-scale evidence by streaming one bounded
  // shard at a time instead of materializing the monolithic corpus envelope.
  // Falls back to the legacy corpus.json read only when no tiers were published
  // (legacy state) so existing small-envelope consumers keep working.
  const tiersDir = tiersDirForCorpusPath(corpusPath);
  const assessment = assessTiers(tiersDir, corpusPath);

  let analysis: CorpusAnalysis;
  let extractedAt: string | null = null;

  if (assessment.analyzable) {
    const records = iterBoundedRecords(tiersDir);
    if (records === null) {
      err(tierUnavailableMessage(assessment, corpusPath));
      return 2;
    }
    analysis = analyzeRecords(records, project, sourceView);
    const metadata = readTierCorpusMetadata(tiersDir);
    extractedAt = metadata?.extracted_at ?? null;
  } else if (assessment.state === "corrupt" || assessment.state === "oversized") {
    // Tier-level failure: the published tier is unreadable or a shard exceeds the
    // reader cap. Project actionable recovery from the authority contract rather
    // than silently falling back to the corpus envelope.
    err(tierUnavailableMessage(assessment, corpusPath));
    return 2;
  } else {
    // Legacy or missing: delegate to the corpus-envelope reader, which preserves
    // the existing too-large / not-found degradation and message contract.
    let corpusData: JsonObject;
    try {
      corpusData = loadCorpusOrRaise(corpusPath);
    } catch (e) {
      if (e instanceof CorpusUnavailable) {
        err(String(e.message));
        return 2;
      }
      throw e;
    }
    analysis = analyzeCorpus(corpusData, project, sourceView);
    const md = (corpusData as JsonObject).metadata;
    extractedAt = md && typeof md === "object" && !Array.isArray(md) ? ((md.extracted_at as string) ?? null) : null;
  }

  out(renderJson(analysis, { generatedAt: nowIso(), extractedAt }));
  return 0;
}

/** Compose the degrade message for a non-analyzable tier state. */
function tierUnavailableMessage(assessment: ReturnType<typeof assessTiers>, corpusPath: string): string {
  const recovery = assessment.recovery;
  const where = `tiers at ${assessment.tiersDir}${corpusPath ? ` (corpus=${corpusPath})` : ""}`;
  if (assessment.state === "oversized") {
    return `evidence tier is oversized at ${assessment.artifact ?? where}. ${recovery ?? ""}`.trim();
  }
  if (assessment.state === "corrupt") {
    return `evidence tier is unreadable at ${where}. ${recovery ?? ""}`.trim();
  }
  return `evidence tier is ${assessment.state} at ${where}. ${recovery ?? ""}`.trim();
}
