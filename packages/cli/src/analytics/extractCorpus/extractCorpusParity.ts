import fs from "node:fs";
import path from "node:path";

import {
  ADAPTER_VERSION,
  COPILOT_SPARSE_REMEDIATION,
  FAMILIES,
  MAX_SQLITE_ROWS,
  MAX_SQLITE_SESSIONS,
  MAX_TOOL_ARG_TEXT,
  RUNTIME_STORE_GLOBS,
  discoverRuntimeStore,
} from "./core.js";
import { buildCorpus } from "./corpus.js";
import { runCoverageAudit } from "./coverageAudit.js";
import { extractOpencodeSessions } from "./sqliteSessions.js";

export const EXTRACT_CORPUS_PARITY_SCHEMA = "agentera-extract-corpus-parity-v1";

export interface ExtractCorpusParityManifest {
  schema_version: string;
  adapter_version: string;
  max_sqlite_sessions: number;
  max_sqlite_rows: number;
  max_tool_arg_text: number;
  copilot_sparse_remediation: string;
  runtime_store_globs: Record<string, string>;
  families: readonly string[];
}

export interface OpencodeProbeShape {
  record_count: number;
  earliest: string | null;
  latest: string | null;
}

export interface OpencodeParitySnapshot {
  record_count: number;
  earliest: string | null;
  latest: string | null;
  probe_shapes: {
    coverage: OpencodeProbeShape;
    extraction: OpencodeProbeShape;
    discovery: { status: string; file_count: number | null };
  };
}

export function buildExtractCorpusParityManifest(): ExtractCorpusParityManifest {
  return {
    schema_version: EXTRACT_CORPUS_PARITY_SCHEMA,
    adapter_version: ADAPTER_VERSION,
    max_sqlite_sessions: MAX_SQLITE_SESSIONS,
    max_sqlite_rows: MAX_SQLITE_ROWS,
    max_tool_arg_text: MAX_TOOL_ARG_TEXT,
    copilot_sparse_remediation: COPILOT_SPARSE_REMEDIATION,
    runtime_store_globs: { ...RUNTIME_STORE_GLOBS },
    families: [...FAMILIES],
  };
}

function trackEarliest(current: string | null, candidate: string | null): string | null {
  if (!candidate) return current;
  if (current === null) return candidate;
  return candidate < current ? candidate : current;
}

function trackLatest(current: string | null, candidate: string | null): string | null {
  if (!candidate) return current;
  if (current === null) return candidate;
  return candidate > current ? candidate : current;
}

function boundsFromRecords(records: Array<{ timestamp?: unknown }>): { earliest: string | null; latest: string | null } {
  let earliest: string | null = null;
  let latest: string | null = null;
  for (const item of records) {
    const ts = typeof item.timestamp === "string" ? item.timestamp : null;
    earliest = trackEarliest(earliest, ts);
    latest = trackLatest(latest, ts);
  }
  return { earliest, latest };
}

/** Canonical opencode parity snapshot used by TS and the generated Python wrapper. */
export function opencodeParitySnapshot(dbPath: string): OpencodeParitySnapshot {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`extract-corpus parity: missing opencode db at ${dbPath}`);
  }
  const audit = runCoverageAudit(
    {
      output: dbPath,
      projectRoot: [path.dirname(dbPath)],
      codexSessionsDir: path.join(path.dirname(dbPath), "unused-codex"),
      claudeProjectsDir: path.join(path.dirname(dbPath), "unused-claude"),
      opencodeConversationsDir: dbPath,
      copilotConversationsDir: null,
      cursorProjectsDir: null,
      cursorChatsDir: null,
      noCodex: true,
      noClaude: true,
      noOpencode: false,
      noCopilot: true,
      noCursor: true,
      acceptCoverageGap: false,
      coverageAuditOnly: false,
      format: "text",
    },
    {},
  );
  const coverageEntry = audit.runtimes.find((entry) => entry.runtime === "opencode");
  const coverageProbe: OpencodeProbeShape = {
    record_count: 0,
    earliest: coverageEntry?.earliest_session ?? null,
    latest: coverageEntry?.latest_session ?? null,
  };

  const errors: string[] = [];
  const extracted = extractOpencodeSessions(dbPath, errors);
  const extractionBounds = boundsFromRecords(extracted);
  const extractionProbe: OpencodeProbeShape = {
    record_count: extracted.length,
    earliest: extractionBounds.earliest,
    latest: extractionBounds.latest,
  };

  const corpus = buildCorpus({
    projectRoots: [],
    codexSessionsDir: null,
    claudeProjectsDir: null,
    opencodeConversationsDir: dbPath,
  });
  const runtimeStatus = (corpus.metadata.runtime_statuses as Array<{ runtime?: string; record_count?: number }>).find(
    (status) => status.runtime === "opencode",
  );
  const recordCount = runtimeStatus?.record_count ?? extracted.length;

  const discovery = discoverRuntimeStore("opencode", dbPath);
  const discoveryShape = {
    status: String(discovery.status),
    file_count: typeof discovery.file_count === "number" ? discovery.file_count : null,
  };

  return {
    record_count: recordCount,
    earliest: coverageProbe.earliest,
    latest: coverageProbe.latest,
    probe_shapes: {
      coverage: coverageProbe,
      extraction: extractionProbe,
      discovery: discoveryShape,
    },
  };
}
