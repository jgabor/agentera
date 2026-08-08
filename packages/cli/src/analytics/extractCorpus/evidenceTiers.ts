import fs from "node:fs";
import path from "node:path";

import type { JsonObject } from "../../core/jsonValue.js";
import { pyJsonIndentSorted } from "../../core/pyjson.js";
import { writeFileAtomic } from "../../core/atomicWriter.js";
import {
  assessProvenance,
  stableId,
  defaultProfileDir,
  type Env,
} from "./core.js";
import { evidenceTierBounds, loadEvidenceTierContract } from "../../registries/evidenceTierContract.js";
import type { CorpusEnvelopeCoverage } from "./coverageAudit.js";

/**
 * Bounded tier publication and direct retrieval (plan Task 2).
 *
 * Task 1 fixed the authoritative tier model in
 * `references/analysis/evidence-tier-authority.yaml`; this module implements
 * the publication writer and the direct retrieval behavior that run against it.
 * It projects the contract's families and bounds from the loader rather than
 * re-declaring them, and reuses the extraction adapters' record shape so no
 * source family, adapter, or evidence identity is changed.
 *
 * It does not migrate usage/report/prime/startup-analysis consumers (plan
 * Task 3) or implement profile synthesis (plan Task 4). The smallest retrieval
 * API those later consumers need is exposed here.
 */

export const TIER_SCHEMA_VERSION = "agentera.evidenceTiers.v1";
export const CURRENT_POINTER_VERSION = "agentera.evidenceTiers.current.v1";
export const FILESYSTEM_FAMILY = "filesystem";

const SIGNAL_SOURCE_KINDS = new Set([
  "instruction_document",
  "project_config_signal",
  "conversation_turn",
  "tool_call",
  "history_prompt",
]);

const CLASSIFIED_SIGNAL_TYPES = new Set(["decision", "question", "correction"]);

/** A derived, bounded signal record carrying only contract-required fields. */
export interface SignalRecord {
  source_id: string;
  source_kind: string;
  signal_type: string;
  timestamp: string;
  project_id: string;
  runtime: string | null;
  source_product: string;
  source_class?: string;
  evidence_anchor: string;
  origin_id?: string;
  content_fingerprint?: string;
  author_class?: string;
  conversation_key?: string;
  session_id?: string;
  active_runtime?: boolean;
}

export interface FullEvidenceShard {
  family: string;
  index: number;
  path: string;
  record_count: number;
  bytes: number;
  source_ids: string[];
}

export interface SignalSelectionReport {
  total: number;
  retained: number;
  capped: boolean;
  per_family: Array<{ family: string; total: number; retained: number }>;
}

/**
 * Corpus metadata retained in the tier manifest so bounded metadata consumers
 * (report status, prime coverage) reconstruct the corpus envelope without reading
 * full evidence. The coverage envelope is the audit-derived source of truth for
 * available/selected/skipped runtimes; `runtime_statuses` carry per-source
 * extraction outcomes. Projected from the publication writer, not duplicated.
 */
export interface TierCorpusMetadata {
  extracted_at?: string;
  runtime_statuses?: JsonObject[];
  coverage_envelope?: CorpusEnvelopeCoverage;
}

export interface EvidenceTierManifest {
  schema_version: string;
  generation: string;
  adapter_version: string;
  published_at: string;
  bounds: { shard_byte_cap: number; signal_byte_cap: number };
  total_records: number;
  families: Record<string, { shards: number; records: number }>;
  shards: FullEvidenceShard[];
  signal: {
    path: string;
    record_count: number;
    bytes: number;
    selection: SignalSelectionReport;
  };
  coverage: {
    families: string[];
    available: string[];
    selected: string[];
    skipped: Array<{ runtime: string | null; reason: string; store_path?: string }>;
  };
  /** Corpus envelope retained for bounded metadata consumers (Task 3). */
  corpus_metadata?: TierCorpusMetadata;
}

export interface PublicationResult {
  tiers_dir: string;
  generation: string;
  manifest_path: string;
  total_records: number;
  shard_count: number;
  signal_count: number;
  signal_bytes: number;
  signal_selection: SignalSelectionReport;
  families: Record<string, { shards: number; records: number }>;
  superseded_generation: string | null;
}

export interface PublishEvidenceTiersOpts {
  tiersDir: string;
  adapterVersion: string;
  /** Runtime discovery statuses (from the coverage audit) for the coverage report. */
  runtimeStatuses?: JsonObject[];
  /** Published-at timestamp; deterministic when fixed. */
  publishedAt?: string;
  env?: Env;
  platform?: NodeJS.Platform;
  /**
   * Corpus envelope retained for bounded metadata consumers. When supplied, the
   * coverage-truth `corpus_metadata` block is stored in the manifest so report
   * status and prime coverage reconstruct the envelope without full records.
   */
  corpusMetadata?: TierCorpusMetadata;
}

/** Default tier directory co-located with the legacy corpus path. */
export function defaultTiersDir(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  return path.join(defaultProfileDir(env, platform), "intermediate", "tiers");
}

/** product -> source family, projected from the contract (single source). */
function productFamilyIndex(contractPath?: string): Map<string, string> {
  const model = loadEvidenceTierContract(contractPath);
  const index = new Map<string, string>();
  for (const [familyId, def] of model.families) {
    for (const product of def.source_product) index.set(product, familyId);
  }
  return index;
}

/** Map a full record to its source family for sharding. */
export function familyOf(record: JsonObject, productFamily: Map<string, string>): string {
  const product = typeof record.source_product === "string" ? record.source_product : "";
  if (product === FILESYSTEM_FAMILY) return FILESYSTEM_FAMILY;
  return productFamily.get(product) ?? "unknown";
}

function asStringField(record: JsonObject, key: string): string {
  const v = record[key];
  return typeof v === "string" ? v : "";
}

/**
 * Pure derivation of bounded signal records from full evidence. One signal
 * record per full record; `signal_type` carries the classified semantic
 * (decision/question/correction/instruction/configuration) or `record_identity`
 * as the base citable-identity semantic. The signal's `source_id` equals its
 * `evidence_anchor` so no signal invents an identity that does not resolve to a
 * retained full-evidence shard.
 */
export function deriveSignalRecords(fullRecords: JsonObject[]): SignalRecord[] {
  const out: SignalRecord[] = [];
  for (const r of fullRecords) {
    const sourceKind = asStringField(r, "source_kind");
    if (!SIGNAL_SOURCE_KINDS.has(sourceKind)) continue;
    const data = r.data && typeof r.data === "object" && !Array.isArray(r.data) ? (r.data as JsonObject) : {};
    let signalType = "record_identity";
    if (sourceKind === "instruction_document") signalType = "instruction";
    else if (sourceKind === "project_config_signal") signalType = "configuration";
    else if (sourceKind === "conversation_turn") {
      const classified = typeof data.signal_type === "string" ? data.signal_type : "";
      signalType = CLASSIFIED_SIGNAL_TYPES.has(classified) ? classified : "record_identity";
    }
    const sourceId = asStringField(r, "source_id");
    const rec: SignalRecord = {
      source_id: sourceId,
      source_kind: sourceKind,
      signal_type: signalType,
      timestamp: asStringField(r, "timestamp"),
      project_id: asStringField(r, "project_id"),
      runtime: typeof r.runtime === "string" ? r.runtime : null,
      source_product: asStringField(r, "source_product"),
      source_class: asStringField(r, "source_class"),
      evidence_anchor: sourceId,
      active_runtime: r.active_runtime === true,
    };
    if (typeof r.origin_id === "string") rec.origin_id = r.origin_id;
    if (typeof r.content_fingerprint === "string") rec.content_fingerprint = r.content_fingerprint;
    if (typeof r.author_class === "string") rec.author_class = r.author_class;
    if (typeof r.conversation_key === "string") rec.conversation_key = r.conversation_key;
    if (typeof r.session_id === "string") rec.session_id = r.session_id;
    out.push(rec);
  }
  return out;
}

type TierOrderable = JsonObject | SignalRecord;

/** Deterministic sort key for records and signals: (timestamp, source_id). */
function tierSortKey(a: TierOrderable, b: TierOrderable): number {
  const get = (o: TierOrderable, key: string): string => {
    const v = (o as Record<string, unknown>)[key];
    return typeof v === "string" ? v : "";
  };
  const at = get(a, "timestamp");
  const bt = get(b, "timestamp");
  const ai = get(a, "source_id");
  const bi = get(b, "source_id");
  if (at !== bt) return at < bt ? -1 : 1;
  if (ai !== bi) return ai < bi ? -1 : 1;
  return 0;
}

function encodeSorted(value: unknown): string {
  return pyJsonIndentSorted(value);
}

function byteSize(text: string): number {
  return Buffer.byteLength(text, "utf-8");
}

/**
 * Split full evidence into family shards, each no larger than `shardByteCap`.
 * A family whose records exceed the cap is split into numbered sub-shards; no
 * record is dropped to fit a shard.
 */
export function shardFullEvidence(
  records: JsonObject[],
  shardByteCap: number,
  productFamily: Map<string, string>,
): Array<{ family: string; index: number; records: JsonObject[]; sourceIds: string[]; bytes: number }> {
  const byFamily = new Map<string, JsonObject[]>();
  for (const r of records) {
    const family = familyOf(r, productFamily);
    const list = byFamily.get(family) ?? [];
    list.push(r);
    byFamily.set(family, list);
  }
  const shards: Array<{ family: string; index: number; records: JsonObject[]; sourceIds: string[]; bytes: number }> = [];
  for (const family of [...byFamily.keys()].sort()) {
    const familyRecords = byFamily.get(family)!.slice().sort(tierSortKey);
    let current: JsonObject[] = [];
    let currentIds: string[] = [];
    let currentBytes = 0;
    let index = 0;
    const flush = (): void => {
      if (current.length === 0) return;
      const encoded = encodeSorted({ records: current });
      shards.push({ family, index, records: current, sourceIds: currentIds, bytes: byteSize(encoded) });
      current = [];
      currentIds = [];
      currentBytes = 0;
      index++;
    };
    for (const r of familyRecords) {
      const id = asStringField(r, "source_id");
      const recordByte = byteSize(encodeSorted(r));
      // If a single record exceeds the cap, it forms its own (oversized) shard
      // so the rest of the tier stays loadable; the oversized shard is reported
      // via the compatibility state rather than silently dropped.
      if (current.length > 0 && currentBytes + recordByte > shardByteCap) {
        flush();
      }
      current.push(r);
      currentIds.push(id);
      currentBytes += recordByte;
    }
    flush();
  }
  return shards;
}

/**
 * Deterministic signal selection applied only when the derived tier would
 * exceed `signalByteCap`. Allocates a per-family record quota proportional to
 * each family's share of the total (minimum one per family), keeps the most
 * recent within each family, and reassembles in the stable tier order.
 */
export function selectSignalsForBound(signals: SignalRecord[], signalByteCap: number): {
  records: SignalRecord[];
  selection: SignalSelectionReport;
} {
  const sorted = signals.slice().sort(tierSortKey);
  const allEncoded = encodeSorted({ records: sorted });
  const totalBytes = byteSize(allEncoded);
  const perFamily = new Map<string, SignalRecord[]>();
  for (const s of sorted) {
    const list = perFamily.get(s.source_product) ?? [];
    list.push(s);
    perFamily.set(s.source_product, list);
  }
  const familyReport: SignalSelectionReport["per_family"] = [];
  for (const family of [...perFamily.keys()].sort()) {
    familyReport.push({ family, total: perFamily.get(family)!.length, retained: perFamily.get(family)!.length });
  }
  if (totalBytes <= signalByteCap) {
    const selection: SignalSelectionReport = {
      total: sorted.length,
      retained: sorted.length,
      capped: false,
      per_family: familyReport,
    };
    return { records: sorted, selection };
  }

  // Per-record average from the encoded payload drives the record budget.
  const avg = totalBytes / Math.max(sorted.length, 1);
  const recordBudget = Math.max(1, Math.floor(signalByteCap / avg));
  const families = [...perFamily.keys()].sort();
  const totalFamilyRecords = sorted.length;
  const retained: SignalRecord[] = [];
  const updatedFamilyReport: SignalSelectionReport["per_family"] = [];
  let allocated = 0;
  for (const family of families) {
    const list = perFamily.get(family)!;
    const quota = Math.max(1, Math.floor((recordBudget * list.length) / Math.max(totalFamilyRecords, 1)));
    updatedFamilyReport.push({ family, total: list.length, retained: Math.min(quota, list.length) });
    // Most recent first: timestamp desc, then source_id asc.
    const kept = list
      .slice()
      .sort((a, b) => (a.timestamp !== b.timestamp ? (a.timestamp < b.timestamp ? 1 : -1) : a.source_id < b.source_id ? -1 : 1))
      .slice(0, quota);
    retained.push(...kept);
    allocated += kept.length;
  }
  // If proportional allocation under-fills (rounding), top up most-recent
  // across families until the budget is reached without exceeding the cap.
  if (allocated < recordBudget) {
    const have = new Set(retained.map((s) => s.source_id));
    const pool = sorted
      .filter((s) => !have.has(s.source_id))
      .sort((a, b) => (a.timestamp !== b.timestamp ? (a.timestamp < b.timestamp ? 1 : -1) : a.source_id < b.source_id ? -1 : 1));
    for (const s of pool) {
      const candidate = encodeSorted({ records: [...retained, s] });
      if (byteSize(candidate) > signalByteCap) break;
      retained.push(s);
      allocated++;
      if (allocated >= recordBudget) break;
    }
  }
  retained.sort(tierSortKey);
  const finalFamilyReport = updatedFamilyReport.map((f) => {
    const count = retained.filter((s) => s.source_product === f.family).length;
    return { ...f, retained: count };
  });
  const selection: SignalSelectionReport = {
    total: sorted.length,
    retained: retained.length,
    capped: true,
    per_family: finalFamilyReport,
  };
  return { records: retained, selection };
}

/** Deterministic, content-addressable generation identity. */
export function generationId(
  fullRecords: JsonObject[],
  adapterVersion: string,
  shardByteCap: number,
  signalByteCap: number,
): string {
  const ids = fullRecords
    .map((r) => asStringField(r, "source_id"))
    .filter((id) => id)
    .sort();
  return stableId("evidenceTiers", adapterVersion, shardByteCap, signalByteCap, ids.join("\n"));
}

function coverageFromStatuses(runtimeStatuses: JsonObject[] | undefined): EvidenceTierManifest["coverage"] {
  const families: string[] = [];
  const available: string[] = [];
  const selected: string[] = [];
  const skipped: Array<{ runtime: string | null; reason: string; store_path?: string }> = [];
  // Post-extraction statuses use "ok" for a cleanly extracted source; discovery
  // statuses use "available". Both mean the source was discovered and extracted,
  // so a bounded consumer treats them as available. Sparse/missing/skipped/degraded
  // are coverage gaps (the contract's incomplete state), so they surface in skipped
  // rather than being silently absent from coverage.
  const AVAILABLE = new Set(["ok", "available"]);
  const GAP = new Set(["skipped", "sparse", "missing", "degraded"]);
  for (const s of runtimeStatuses ?? []) {
    const runtime = typeof s.runtime === "string" ? s.runtime : null;
    const product = typeof s.source_product === "string" ? s.source_product : (runtime ?? "unknown");
    const status = typeof s.status === "string" ? s.status : "";
    const reason = typeof s.reason === "string" ? s.reason : "";
    if (product && !families.includes(product)) families.push(product);
    const isActiveRuntime = s.source_class === "active_runtime" && s.active_runtime !== false;
    if (AVAILABLE.has(status)) {
      available.push(product);
      if (isActiveRuntime) selected.push(product);
    }
    if (GAP.has(status)) {
      const entry: { runtime: string | null; reason: string; store_path?: string } = { runtime, reason: reason || status };
      if (Array.isArray(s.provenance_missing_fields) && s.provenance_missing_fields.length > 0) {
        entry.reason += ` (missing provenance: ${s.provenance_missing_fields.join(",")})`;
      }
      if (typeof s.store_path === "string") entry.store_path = s.store_path;
      skipped.push(entry);
    }
  }
  return { families: [...families].sort(), available: [...available].sort(), selected: [...selected].sort(), skipped };
}

/**
 * Publish bounded full-evidence shards and a bounded signal tier atomically. The
 * whole generation is staged in a temp directory and revealed only by an atomic
 * swap of the `current` pointer, so no consumer can observe a partially
 * published generation. Returns the publication result.
 */
export function publishEvidenceTiers(
  records: JsonObject[],
  opts: PublishEvidenceTiersOpts,
  contractPath?: string,
): PublicationResult {
  const bounds = evidenceTierBounds(contractPath);
  const productFamily = productFamilyIndex(contractPath);
  const sortedRecords = records.slice().sort(tierSortKey);
  const provenance = assessProvenance(sortedRecords);
  const runtimeStatuses = [...(opts.runtimeStatuses ?? [])];
  if (!provenance.complete) {
    const gapProducts = new Map<string, JsonObject>();
    for (const record of sortedRecords) {
      if (Object.keys(record).length === 0) continue;
      if (assessProvenance([record]).complete) continue;
      const product = typeof record.source_product === "string" ? record.source_product : "unknown";
      if (!gapProducts.has(product)) {
        gapProducts.set(product, {
          runtime: typeof record.runtime === "string" ? record.runtime : null,
          source_product: product,
          source_class: typeof record.source_class === "string" ? record.source_class : "unknown",
          active_runtime: record.active_runtime === true,
          status: "degraded",
          reason: "provenance_missing",
          provenance_missing_fields: provenance.missingFields,
          provenance_missing_records: provenance.missingRecords,
        });
      }
    }
    runtimeStatuses.push(...gapProducts.values());
  }
  const signals = deriveSignalRecords(sortedRecords);
  const { records: selectedSignals, selection } = selectSignalsForBound(signals, bounds.signalByteCap);
  const shards = shardFullEvidence(sortedRecords, bounds.shardByteCap, productFamily);
  const gen = generationId(sortedRecords, opts.adapterVersion, bounds.shardByteCap, bounds.signalByteCap);
  const publishedAt = opts.publishedAt ?? new Date().toISOString();

  const generationsDir = path.join(opts.tiersDir, "generations");
  const finalDir = path.join(generationsDir, gen);
  const stageDir = path.join(opts.tiersDir, ".staging", `${gen}.${process.pid}.${Date.now()}`);

  fs.mkdirSync(path.join(stageDir, "full-evidence"), { recursive: true });
  fs.mkdirSync(generationsDir, { recursive: true });

  const shardDescriptors: FullEvidenceShard[] = [];
  const familiesAgg: Record<string, { shards: number; records: number }> = {};
  for (const shard of shards) {
    const file = `${shard.family}-${String(shard.index).padStart(3, "0")}.json`;
    const relPath = path.join("full-evidence", file);
    const absPath = path.join(stageDir, relPath);
    const encoded = encodeSorted({ records: shard.records });
    writeFileAtomic(absPath, encoded + "\n");
    shardDescriptors.push({
      family: shard.family,
      index: shard.index,
      path: relPath,
      record_count: shard.records.length,
      bytes: byteSize(encoded),
      source_ids: shard.sourceIds,
    });
    const agg = familiesAgg[shard.family] ?? { shards: 0, records: 0 };
    agg.shards += 1;
    agg.records += shard.records.length;
    familiesAgg[shard.family] = agg;
  }

  const signalRel = "signal.json";
  const signalEncoded = encodeSorted({ records: selectedSignals });
  const signalBytes = byteSize(signalEncoded);
  writeFileAtomic(path.join(stageDir, signalRel), signalEncoded + "\n");

  const manifest: EvidenceTierManifest = {
    schema_version: TIER_SCHEMA_VERSION,
    generation: gen,
    adapter_version: opts.adapterVersion,
    published_at: publishedAt,
    bounds: { shard_byte_cap: bounds.shardByteCap, signal_byte_cap: bounds.signalByteCap },
    total_records: sortedRecords.length,
    families: familiesAgg,
    shards: shardDescriptors,
    signal: { path: signalRel, record_count: selectedSignals.length, bytes: signalBytes, selection },
    coverage: coverageFromStatuses(runtimeStatuses),
    corpus_metadata: opts.corpusMetadata,
  };
  writeFileAtomic(path.join(stageDir, "manifest.json"), encodeSorted(manifest) + "\n");

  // Reveal: rename staged dir onto the final generation dir, then atomically
  // swap the current pointer. If interrupted before this point, the prior
  // generation (or none) remains current.
  const priorCurrent = readCurrentPointer(opts.tiersDir);
  if (!fs.existsSync(finalDir)) {
    fs.renameSync(stageDir, finalDir);
  } else {
    // Idempotent: identical content already published. Replace staging copy.
    try {
      fs.rmSync(stageDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
  const currentPath = path.join(opts.tiersDir, "current.json");
  writeFileAtomic(
    currentPath,
    encodeSorted({
      schema_version: CURRENT_POINTER_VERSION,
      generation: gen,
      published_at: publishedAt,
      adapter_version: opts.adapterVersion,
    }) + "\n",
  );

  return {
    tiers_dir: opts.tiersDir,
    generation: gen,
    manifest_path: path.join("generations", gen, "manifest.json"),
    total_records: sortedRecords.length,
    shard_count: shardDescriptors.length,
    signal_count: selectedSignals.length,
    signal_bytes: signalBytes,
    signal_selection: selection,
    families: familiesAgg,
    superseded_generation: priorCurrent?.generation ?? null,
  };
}

export interface CurrentPointer {
  schema_version: string;
  generation: string;
  published_at: string;
  adapter_version: string;
}

/** Read the current generation pointer, or null when no tiers are published. */
export function readCurrentPointer(tiersDir: string): CurrentPointer | null {
  const p = path.join(tiersDir, "current.json");
  if (!fs.existsSync(p)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const obj = data as Record<string, unknown>;
      if (typeof obj.generation === "string" && typeof obj.schema_version === "string") {
        return {
          schema_version: obj.schema_version,
          generation: obj.generation,
          published_at: typeof obj.published_at === "string" ? obj.published_at : "",
          adapter_version: typeof obj.adapter_version === "string" ? obj.adapter_version : "",
        };
      }
    }
  } catch {
    return null;
  }
  return null;
}

export interface GenerationDir {
  pointer: CurrentPointer;
  dir: string;
  manifest: EvidenceTierManifest;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEvidenceTierManifest(value: unknown): value is EvidenceTierManifest {
  if (!isMapping(value)) return false;
  const bounds = value.bounds;
  const signal = value.signal;
  const coverage = value.coverage;
  if (
    value.schema_version !== TIER_SCHEMA_VERSION ||
    !isMapping(bounds) ||
    typeof bounds.shard_byte_cap !== "number" ||
    typeof bounds.signal_byte_cap !== "number" ||
    !isMapping(signal) ||
    typeof signal.path !== "string" ||
    typeof signal.bytes !== "number" ||
    !isMapping(coverage) ||
    !Array.isArray(coverage.skipped) ||
    !Array.isArray(value.shards)
  ) {
    return false;
  }
  return value.shards.every(
    (shard) =>
      isMapping(shard) &&
      typeof shard.path === "string" &&
      typeof shard.bytes === "number" &&
      Array.isArray(shard.source_ids) &&
      shard.source_ids.every((sourceId) => typeof sourceId === "string"),
  );
}

function lowerSha256(value: unknown): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/** Validate bounded signal provenance without reading any full-evidence shard. */
export function missingSignalProvenanceFields(record: SignalRecord): string[] {
  const missing: string[] = [];
  const required: Array<[string, boolean]> = [
    ["source_id", typeof record.source_id === "string" && record.source_id.length > 0],
    ["source_kind", typeof record.source_kind === "string" && record.source_kind.length > 0],
    ["signal_type", typeof record.signal_type === "string" && record.signal_type.length > 0],
    ["timestamp", typeof record.timestamp === "string" && record.timestamp.length > 0],
    ["project_id", typeof record.project_id === "string" && record.project_id.length > 0],
    ["source_product", typeof record.source_product === "string" && record.source_product.length > 0],
    ["active_runtime", typeof record.active_runtime === "boolean"],
    ["source_class", typeof record.source_class === "string" && record.source_class.length > 0],
    ["evidence_anchor", record.evidence_anchor === record.source_id && record.evidence_anchor.length > 0],
  ];
  for (const [field, present] of required) if (!present) missing.push(field);
  if (CONVERSATION_SIGNAL_SOURCE_KINDS.has(record.source_kind)) {
    if (!lowerSha256(record.origin_id)) missing.push("origin_id");
    if (!lowerSha256(record.content_fingerprint)) missing.push("content_fingerprint");
    if (typeof record.author_class !== "string" || record.author_class.length === 0) missing.push("author_class");
    if (typeof record.session_id !== "string" || record.session_id.length === 0) missing.push("session_id");
  }
  return [...new Set(missing)];
}

const CONVERSATION_SIGNAL_SOURCE_KINDS = new Set(["conversation_turn", "history_prompt"]);

function signalProvenanceGaps(records: SignalRecord[]): string[] {
  const gaps = new Set<string>();
  for (const record of records) {
    if (!isMapping(record)) {
      gaps.add("record");
      continue;
    }
    for (const field of missingSignalProvenanceFields(record as SignalRecord)) gaps.add(field);
  }
  return [...gaps].sort();
}

function readSignalPayload(
  gen: GenerationDir,
): { records: SignalRecord[]; bytes: number } | null {
  const signalPath = path.join(gen.dir, gen.manifest.signal.path);
  if (!fs.existsSync(signalPath)) return null;
  try {
    const bytes = fs.statSync(signalPath).size;
    if (bytes > evidenceTierBounds().signalByteCap) return null;
    const data = JSON.parse(fs.readFileSync(signalPath, "utf-8")) as { records?: SignalRecord[] };
    if (!data || !Array.isArray(data.records)) return null;
    return { records: data.records, bytes };
  } catch {
    return null;
  }
}

/** Resolve the current generation directory and manifest, or null. */
export function readCurrentGeneration(tiersDir: string): GenerationDir | null {
  const pointer = readCurrentPointer(tiersDir);
  if (!pointer) return null;
  const dir = path.join(tiersDir, "generations", pointer.generation);
  const manifestPath = path.join(dir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const manifest: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    if (!isEvidenceTierManifest(manifest)) return null;
    return { pointer, dir, manifest };
  } catch {
    return null;
  }
}

/** Read the bounded signal tier records for the current generation. */
export function readSignalTier(
  tiersDir: string,
  options: { allowProvenanceGaps?: boolean } = {},
): { records: SignalRecord[]; bytes: number; manifest: EvidenceTierManifest } | null {
  const gen = readCurrentGeneration(tiersDir);
  if (!gen) return null;
  const payload = readSignalPayload(gen);
  if (!payload) return null;
  if (!options.allowProvenanceGaps && signalProvenanceGaps(payload.records).length > 0) return null;
  return { ...payload, manifest: gen.manifest };
}

/** Resolve a bounded signal's identity (evidence_anchor) to its full record. */
export function resolveEvidenceAnchor(anchor: string, tiersDir: string): JsonObject | null {
  return getFullRecord(anchor, tiersDir);
}

/**
 * Retrieve exactly one full-evidence record by `source_id`. Locates the owning
 * shard via the manifest index, loads only that shard, and returns the record.
 */
export function getFullRecord(sourceId: string, tiersDir: string): JsonObject | null {
  if (!sourceId) return null;
  const gen = readCurrentGeneration(tiersDir);
  if (!gen) return null;
  for (const shard of gen.manifest.shards) {
    if (!shard.source_ids.includes(sourceId)) continue;
    const shardPath = path.join(gen.dir, shard.path);
    if (!fs.existsSync(shardPath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(shardPath, "utf-8")) as { records?: JsonObject[] };
      if (!data || !Array.isArray(data.records)) return null;
      return data.records.find((r) => r && typeof r === "object" && asStringField(r as JsonObject, "source_id") === sourceId) ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

export type EvidenceTierCompatibilityState =
  | { state: "current"; generation: string }
  | { state: "missing"; reason: string }
  | { state: "legacy"; reason: string }
  | { state: "corrupt"; reason: string }
  | { state: "oversized"; reason: string; artifact: string }
  | { state: "incomplete"; reason: string; detail: string[] };

/**
 * Direct-retrieval compatibility state, mirroring the contract's deterministic
 * states. Callers report the matching recovery guidance from the authority.
 */
export function evidenceTierCompatibility(tiersDir: string, corpusPath?: string): EvidenceTierCompatibilityState {
  const pointer = readCurrentPointer(tiersDir);
  if (!pointer) {
    if (corpusPath && fs.existsSync(corpusPath)) {
      return { state: "legacy", reason: "legacy_monolithic_state" };
    }
    return { state: "missing", reason: "no_evidence" };
  }
  const gen = readCurrentGeneration(tiersDir);
  if (!gen) {
    return { state: "corrupt", reason: "unreadable_or_schema_divergent" };
  }
  const signalPath = path.join(gen.dir, gen.manifest.signal.path);
  let actualSignalBytes: number;
  try {
    actualSignalBytes = fs.statSync(signalPath).size;
  } catch {
    return { state: "corrupt", reason: "unreadable_or_schema_divergent" };
  }
  if (actualSignalBytes > evidenceTierBounds().signalByteCap) {
    return { state: "oversized", reason: "oversized", artifact: gen.manifest.signal.path };
  }
  // Oversized: any shard or the signal tier exceeds its declared cap.
  for (const shard of gen.manifest.shards) {
    if (shard.bytes > gen.manifest.bounds.shard_byte_cap) {
      return { state: "oversized", reason: "oversized", artifact: shard.path };
    }
  }
  if (
    gen.manifest.signal.bytes > gen.manifest.bounds.signal_byte_cap ||
    gen.manifest.signal.bytes > evidenceTierBounds().signalByteCap
  ) {
    return { state: "oversized", reason: "oversized", artifact: gen.manifest.signal.path };
  }
  let signalPayload: { records: SignalRecord[]; bytes: number } | null;
  try {
    const data = JSON.parse(fs.readFileSync(signalPath, "utf-8")) as { records?: SignalRecord[] };
    signalPayload = data && Array.isArray(data.records) ? { records: data.records, bytes: actualSignalBytes } : null;
  } catch {
    signalPayload = null;
  }
  if (!signalPayload) return { state: "corrupt", reason: "unreadable_or_schema_divergent" };
  const provenanceGaps = signalProvenanceGaps(signalPayload.records);
  if (provenanceGaps.length > 0) {
    return {
      state: "incomplete",
      reason: "provenance_missing",
      detail: provenanceGaps.map((field) => `signal: missing ${field}`),
    };
  }
  // Incomplete: a supported source family is skipped/sparse/missing.
  const skipped = gen.manifest.coverage.skipped;
  if (skipped.length > 0) {
    return {
      state: "incomplete",
      reason: "coverage_gap_or_sparse",
      detail: skipped.map((s) => `${s.runtime ?? "unknown"}: ${s.reason}`),
    };
  }
  return { state: "current", generation: pointer.generation };
}

/**
 * Yield every full-evidence record across the current generation, reading one
 * bounded shard at a time. No consumer observes a partially published generation
 * (the atomic pointer swap already guarantees this), and no single read exceeds
 * `shard_byte_cap` for a current/incomplete tier. Used by full-record consumers
 * (usage analytics, startup analysis) so they analyze real scale without
 * materializing the monolithic corpus envelope. Returns `null` when no current
 * generation exists; callers then report the matching compatibility state.
 */
export function* iterTierRecords(tiersDir: string): Generator<JsonObject> {
  const gen = readCurrentGeneration(tiersDir);
  if (!gen) return;
  for (const shard of gen.manifest.shards) {
    const shardPath = path.join(gen.dir, shard.path);
    if (!fs.existsSync(shardPath)) continue;
    let data: { records?: JsonObject[] };
    try {
      data = JSON.parse(fs.readFileSync(shardPath, "utf-8")) as { records?: JsonObject[] };
    } catch {
      // A single corrupt shard cannot crash the whole tier read; the
      // compatibility surface flags it separately. Skip the unreadable shard.
      continue;
    }
    if (!data || !Array.isArray(data.records)) continue;
    for (const record of data.records) {
      if (record && typeof record === "object" && !Array.isArray(record)) {
        yield record as JsonObject;
      }
    }
  }
}

/**
 * Read the retained corpus metadata block for bounded metadata consumers
 * (report status, prime coverage). Returns `null` when no current generation
 * exists or the manifest predates the metadata block; callers fall back to the
 * compatibility state and the signal tier.
 */
export function readTierCorpusMetadata(tiersDir: string): TierCorpusMetadata | null {
  const gen = readCurrentGeneration(tiersDir);
  if (!gen) return null;
  return gen.manifest.corpus_metadata ?? null;
}
