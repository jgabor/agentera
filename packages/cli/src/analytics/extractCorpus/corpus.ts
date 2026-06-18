import fs from "node:fs";

import {
  type Dict,
  ADAPTER_VERSION,
  FAMILIES,
  isoNow,
  runtimeStatus,
  discoverRuntimeStore,
  COPILOT_SPARSE_REMEDIATION,
} from "./core.js";
import { isPlainObject } from "./core.js";
import { extractInstructionDocuments, extractProjectConfigSignals } from "./filesystemSources.js";
import { extractCodexSessions, extractClaudeProjectSessions } from "./jsonlSessions.js";
import { extractOpencodeSessions, PermissionDeniedError } from "./sqliteSessions.js";
import { extractCopilotSessions } from "./copilotSessions.js";
import {
  extractCursorSessions,
  extractCursorAgentSessions,
  resolveOpencodeDbPath,
  resolveCopilotStorePath,
  resolveCursorProjectsPath,
  resolveCursorChatsPath,
} from "./cursorSessions.js";
import { resolvePath } from "../../core/paths.js";
import type { CorpusEnvelopeCoverage } from "./coverageAudit.js";
import type { SqliteCaps } from "./sqliteCaps.js";
import { applyTruncationToStatus } from "./sqliteCaps.js";
import type { ExtractorContext } from "./sqliteSessions.js";

export class ExtractionNotImplementedError extends Error {}

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

type Extractor = (storePath: string | null, errors: string[], ctx?: ExtractorContext) => Dict[];

function extractRuntimeStore(
  runtime: string,
  storePath: string | null,
  errors: string[],
  extractor: Extractor,
  sqliteCaps?: SqliteCaps,
): [Dict[], Dict] {
  const discovery = discoverRuntimeStore(runtime, storePath);
  if (discovery.status !== "available") return [[], discovery];
  const errorStart = errors.length;
  const ctx: ExtractorContext = { sqliteCaps };
  let records: Dict[];
  try {
    records = extractor(storePath, errors, ctx);
  } catch (exc) {
    const fc = discovery.file_count ?? null;
    if (exc instanceof ExtractionNotImplementedError) {
      return [[], runtimeStatus(runtime, { status: "degraded", reason: "extractor_unimplemented", storePath, fileCount: fc, recordCount: 0, errorCount: 0 })];
    }
    if (exc instanceof PermissionDeniedError) {
      return [[], runtimeStatus(runtime, { status: "degraded", reason: "store_locked", storePath, fileCount: fc })];
    }
    return [[], runtimeStatus(runtime, { status: "degraded", reason: "store_unreadable", storePath, fileCount: fc })];
  }
  const fc = discovery.file_count ?? null;
  const errorCount = errors.length - errorStart;
  if (errorCount) {
    return [records, runtimeStatus(runtime, { status: "degraded", reason: "schema_divergent", storePath, fileCount: fc, recordCount: records.length, errorCount })];
  }
  if (records.length === 0) {
    return [records, runtimeStatus(runtime, {
      status: "sparse",
      reason: "no_matching_records",
      storePath,
      fileCount: fc,
      recordCount: 0,
      remediationLabels: runtime === "github-copilot" ? [COPILOT_SPARSE_REMEDIATION] : null,
    })];
  }
  return [
    records,
    applyTruncationToStatus(
      runtimeStatus(runtime, { status: "ok", reason: "records_extracted", storePath, fileCount: fc, recordCount: records.length, errorCount: 0 }),
      ctx.truncation,
    ),
  ];
}

export function dedupeRecords(records: Dict[]): Dict[] {
  const byId = new Map<string, Dict>();
  for (const item of records) byId.set(item.source_id, item);
  const actorOrder = (item: Dict): number => {
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

export function buildMetadata(
  records: Dict[],
  errors: string[],
  runtimeStatuses: Dict[],
  coverage?: CorpusEnvelopeCoverage,
): Dict {
  const counts = new Map<string, number>();
  for (const item of records) {
    const sk = item.source_kind;
    if ((FAMILIES as readonly string[]).includes(sk)) counts.set(sk, (counts.get(sk) ?? 0) + 1);
  }
  const families: Dict = {};
  for (const family of FAMILIES) {
    const count = counts.get(family) ?? 0;
    families[family] = { count, status: count ? "ok" : "missing" };
    if (count === 0) families[family].error = "no records extracted for this family";
  }
  const runtimes = Array.from(new Set(records.filter((i) => i.runtime).map((i) => String(i.runtime)))).sort();
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
  };
}

export function buildCorpus(opts: BuildCorpusOpts): Dict {
  const errors: string[] = [];
  const normalizedRoots: string[] = [];
  for (const root of opts.projectRoots) {
    if (fs.existsSync(root)) normalizedRoots.push(resolvePath(root));
    else errors.push(`${root}: project root does not exist`);
  }
  const records: Dict[] = [];
  records.push(...extractInstructionDocuments(normalizedRoots, errors));
  records.push(...extractProjectConfigSignals(normalizedRoots, errors));
  const runtimeStatuses: Dict[] = [];
  const runtimes: Array<[string, string | null, Extractor]> = [
    ["codex", opts.codexSessionsDir, extractCodexSessions],
    ["claude-code", opts.claudeProjectsDir, extractClaudeProjectSessions],
    ["cursor", opts.cursorProjectsDir ?? null, (sp, err) => extractCursorSessions(sp, err, normalizedRoots)],
    [
      "cursor-agent",
      opts.cursorChatsDir ?? null,
      (sp, err) => extractCursorAgentSessions(sp, err, normalizedRoots, opts.cursorProjectsDir ?? null),
    ],
    ["opencode", opts.opencodeConversationsDir ?? null, extractOpencodeSessions],
    ["github-copilot", opts.copilotConversationsDir ?? null, extractCopilotSessions],
  ];
  for (const [runtime, storePath, extractor] of runtimes) {
    const [runtimeRecords, status] = extractRuntimeStore(runtime, storePath, errors, extractor, opts.sqliteCaps);
    records.push(...runtimeRecords);
    runtimeStatuses.push(status);
  }
  const deduped = dedupeRecords(records);
  return { metadata: buildMetadata(deduped, errors, runtimeStatuses, opts.coverage), records: deduped };
}
