import fs from "node:fs";

import { ADAPTER_VERSION, FAMILIES, isoNow, runtimeStatus, discoverRuntimeStore, COPILOT_SPARSE_REMEDIATION, assessProvenance } from "./core.js";
import type { JsonObject } from "../../core/jsonValue.js";
import { isPlainObject } from "./core.js";
import { extractInstructionDocuments, extractProjectConfigSignals } from "./filesystemSources.js";
import { extractCodexSessions, extractClaudeProjectSessions } from "./jsonlSessions.js";
import { extractOpencodeSessions, PermissionDeniedError } from "./sqliteSessions.js";
import { extractCopilotSessions } from "./copilotSessions.js";
import { extractCursorSessions, extractCursorAgentSessions } from "./cursorSessions.js";
import { resolvePath } from "../../core/paths.js";
import type { CorpusEnvelopeCoverage } from "./coverageAudit.js";
import type { SqliteCaps } from "./sqliteCaps.js";
import { applyTruncationToStatus } from "./sqliteCaps.js";
import type { ExtractorContext } from "./sqliteSessions.js";

export class ExtractionNotImplementedError extends Error {}

export interface CorpusMetadata {
  extracted_at: string;
  runtimes: string[];
  adapter_version: string;
  families: JsonObject;
  runtime_statuses: JsonObject[];
  available_runtimes: string[];
  selected_runtimes: string[];
  available_but_not_selected: Array<{ runtime: string; reason: string; store_path: string }>;
  total_records: number;
  errors: string[];
  source_classes: string[];
  source_products: string[];
}

export interface CorpusEnvelope {
  metadata: CorpusMetadata;
  records: JsonObject[];
}

export interface BuildCorpusOpts {
  projectRoots: string[];
  codexSessionsDir: string | null;
  claudeProjectsDir: string | null;
  opencodeConversationsDir?: string | null;
  copilotConversationsDir?: string | null;
  cursorProjectsDir?: string | null;
  cursorChatsDir?: string | null;
  coverage?: CorpusEnvelopeCoverage;
  sqliteCaps?: SqliteCaps;
}

type Extractor = (storePath: string | null, errors: string[], ctx?: ExtractorContext) => JsonObject[];

function extractRuntimeStore(
  runtime: string | null,
  storePath: string | null,
  errors: string[],
  extractor: Extractor,
  sqliteCaps?: SqliteCaps,
  provenance: {
    sourceProduct: string;
    sourceClass: "active_runtime" | "historical_import";
    activeRuntime: boolean;
    pattern?: string;
  } = {
    sourceProduct: runtime ?? "unknown",
    sourceClass: "active_runtime",
    activeRuntime: true,
  },
): [JsonObject[], JsonObject] {
  const discovery = discoverRuntimeStore(runtime, storePath, provenance);
  if (discovery.status !== "available") return [[], discovery];
  const errorStart = errors.length;
  const ctx: ExtractorContext = { sqliteCaps };
  let records: JsonObject[];
  try {
    records = extractor(storePath, errors, ctx);
  } catch (exc) {
    const fc = (discovery.file_count ?? null) as number | null; // cast: discovery payload IO boundary
    if (exc instanceof ExtractionNotImplementedError) {
      return [
        [],
        runtimeStatus(runtime, {
          status: "degraded",
          reason: "extractor_unimplemented",
          storePath,
          fileCount: fc,
          recordCount: 0,
          errorCount: 0,
          ...provenance,
        }),
      ];
    }
    if (exc instanceof PermissionDeniedError) {
      return [
        [],
        runtimeStatus(runtime, {
          status: "degraded",
          reason: "store_locked",
          storePath,
          fileCount: fc,
          ...provenance,
        }),
      ];
    }
    return [
      [],
      runtimeStatus(runtime, {
        status: "degraded",
        reason: "store_unreadable",
        storePath,
        fileCount: fc,
        ...provenance,
      }),
    ];
  }
  const fc = (discovery.file_count ?? null) as number | null; // cast: discovery payload IO boundary
  const errorCount = errors.length - errorStart;
  const recordProvenance = assessProvenance(records);
  if (!recordProvenance.complete) {
    return [
      records,
      runtimeStatus(runtime, {
        status: "degraded",
        reason: "provenance_missing",
        storePath,
        fileCount: fc,
        recordCount: records.length,
        errorCount,
        provenanceMissingFields: recordProvenance.missingFields,
        provenanceMissingRecords: recordProvenance.missingRecords,
        ...provenance,
      }),
    ];
  }
  if (errorCount) {
    return [
      records,
      runtimeStatus(runtime, {
        status: "degraded",
        reason: "schema_divergent",
        storePath,
        fileCount: fc,
        recordCount: records.length,
        errorCount,
        ...provenance,
      }),
    ];
  }
  if (records.length === 0) {
    return [
      records,
      runtimeStatus(runtime, {
        status: "sparse",
        reason: "no_matching_records",
        storePath,
        fileCount: fc,
        recordCount: 0,
        remediationLabels: runtime === "copilot" ? [COPILOT_SPARSE_REMEDIATION] : null,
        ...provenance,
      }),
    ];
  }
  return [
    records,
    applyTruncationToStatus(
      runtimeStatus(runtime, {
        status: "ok",
        reason: "records_extracted",
        storePath,
        fileCount: fc,
        recordCount: records.length,
        errorCount: 0,
        ...provenance,
      }),
      ctx.truncation,
    ),
  ];
}

export function dedupeRecords(records: JsonObject[]): JsonObject[] {
  const byId = new Map<string, JsonObject>();
  for (const item of records) byId.set(item.source_id as string, item);
  const actorOrder = (item: JsonObject): number => {
    const actor = isPlainObject(item.data) ? item.data.actor : null;
    return actor === "user" ? 0 : actor === "assistant" ? 1 : 2;
  };
  return Array.from(byId.values()).sort((a, b) => {
    const at = (a.timestamp ?? "") as string;
    const bt = (b.timestamp ?? "") as string;
    if (at !== bt) return at < bt ? -1 : 1;
    const ak = (a.source_kind ?? "") as string;
    const bk = (b.source_kind ?? "") as string;
    if (ak !== bk) return ak < bk ? -1 : 1;
    const ao = actorOrder(a);
    const bo = actorOrder(b);
    if (ao !== bo) return ao - bo;
    const ai = (a.source_id ?? "") as string;
    const bi = (b.source_id ?? "") as string;
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });
}

export function buildMetadata(records: JsonObject[], errors: string[], runtimeStatuses: JsonObject[], coverage?: CorpusEnvelopeCoverage): CorpusMetadata {
  const counts = new Map<string, number>();
  for (const item of records) {
    const sk = item.source_kind as string;
    if ((FAMILIES as readonly string[]).includes(sk)) counts.set(sk, (counts.get(sk) ?? 0) + 1);
  }
  const families: JsonObject = {};
  for (const family of FAMILIES) {
    const count = counts.get(family) ?? 0;
    families[family] = { count, status: count ? "ok" : "missing" };
    if (count === 0) families[family].error = "no records extracted for this family";
  }
  const runtimes = Array.from(new Set(records.filter((item) => item.active_runtime === true && item.runtime).map((item) => String(item.runtime)))).sort();
  const sourceClasses = Array.from(new Set(records.map((item) => String(item.source_class)))).sort();
  const sourceProducts = Array.from(new Set(records.map((item) => String(item.source_product)))).sort();
  const coverageFields = coverage ?? {
    available_runtimes: [],
    selected_runtimes: [],
    available_but_not_selected: [],
  };
  return {
    extracted_at: isoNow(),
    runtimes,
    adapter_version: ADAPTER_VERSION,
    families,
    runtime_statuses: runtimeStatuses,
    available_runtimes: coverageFields.available_runtimes,
    selected_runtimes: coverageFields.selected_runtimes,
    available_but_not_selected: coverageFields.available_but_not_selected,
    total_records: records.length,
    errors,
    source_classes: sourceClasses,
    source_products: sourceProducts,
  };
}

export function buildCorpus(opts: BuildCorpusOpts): CorpusEnvelope {
  const errors: string[] = [];
  const normalizedRoots: string[] = [];
  for (const root of opts.projectRoots) {
    if (fs.existsSync(root)) normalizedRoots.push(resolvePath(root));
    else errors.push(`${root}: project root does not exist`);
  }
  const records: JsonObject[] = [];
  records.push(...extractInstructionDocuments(normalizedRoots, errors));
  records.push(...extractProjectConfigSignals(normalizedRoots, errors));
  const runtimeStatuses: JsonObject[] = [];
  const runtimes: Array<[string | null, string, "active_runtime" | "historical_import", boolean, string | null, Extractor, string | undefined]> = [
    ["codex", "codex", "active_runtime", true, opts.codexSessionsDir, extractCodexSessions, undefined],
    ["cursor", "cursor", "active_runtime", true, opts.cursorProjectsDir ?? null, (sp, err) => extractCursorSessions(sp, err, normalizedRoots), undefined],
    ["cursor", "cursor-agent", "active_runtime", true, opts.cursorChatsDir ?? null, (sp, err) => extractCursorAgentSessions(sp, err, normalizedRoots, opts.cursorProjectsDir ?? null), "store.db"],
    ["opencode", "opencode", "active_runtime", true, opts.opencodeConversationsDir ?? null, extractOpencodeSessions, undefined],
    ["copilot", "github-copilot", "active_runtime", true, opts.copilotConversationsDir ?? null, extractCopilotSessions, undefined],
  ];
  if (opts.claudeProjectsDir !== null) {
    runtimes.push([null, "claude-code", "historical_import", false, opts.claudeProjectsDir, extractClaudeProjectSessions, "*.jsonl"]);
  }
  for (const [runtime, sourceProduct, sourceClass, activeRuntime, storePath, extractor, pattern] of runtimes) {
    const [runtimeRecords, status] = extractRuntimeStore(runtime, storePath, errors, extractor, opts.sqliteCaps, {
      sourceProduct,
      sourceClass,
      activeRuntime,
      pattern,
    });
    records.push(...runtimeRecords);
    runtimeStatuses.push(status);
  }
  const deduped = dedupeRecords(records);
  return {
    metadata: buildMetadata(deduped, errors, runtimeStatuses, opts.coverage),
    records: deduped,
  };
}
