import fs from "node:fs";
import path from "node:path";

import {
  type Dict,
  type Env,
  discoverRuntimeStore,
  eventTimestamp,
  isoFromMtime,
  iterJsonl,
  rglob,
} from "./core.js";
import { isFilePath, isDir } from "./core.js";
import {
  resolveCopilotStorePath,
  resolveCursorChatsPath,
  resolveCursorProjectsPath,
  resolveOpencodeDbPath,
} from "./cursorSessions.js";
import type { ExtractArgs } from "./cli.js";
import {
  openSqlite,
  PermissionDeniedError,
  sqliteTimestamp,
  tableColumns,
  firstColumn,
} from "./sqliteSessions.js";

export const COVERAGE_EXIT_FLAGGED = 4;

export interface RuntimeStoreConfig {
  runtime: string;
  storePath: string | null;
  selected: boolean;
  skipReason: string | null;
}

export interface RuntimeCoverageEntry {
  runtime: string;
  store_path: string | null;
  selected: boolean;
  discovery_status: string;
  discovery_reason: string;
  available: boolean;
  earliest_session: string | null;
  latest_session: string | null;
  skip_reason: string | null;
}

export interface CorpusEnvelopeCoverage {
  available_runtimes: string[];
  selected_runtimes: string[];
  available_but_not_selected: Array<{ runtime: string; reason: string; store_path: string }>;
}

export interface CoverageAuditResult {
  runtimes: RuntimeCoverageEntry[];
  available_runtimes: string[];
  selected_runtimes: string[];
  skipped_available: Array<{ runtime: string; reason: string; store_path: string }>;
  coverage_gap_flagged: boolean;
  exit_signal: "complete" | "flagged" | null;
}

export function corpusEnvelopeCoverage(audit: CoverageAuditResult): CorpusEnvelopeCoverage {
  return {
    available_runtimes: [...audit.available_runtimes],
    selected_runtimes: [...audit.selected_runtimes],
    available_but_not_selected: audit.skipped_available.map((item) => ({
      runtime: item.runtime,
      reason: item.reason,
      store_path: item.store_path,
    })),
  };
}

export function resolveRuntimeStoreConfigs(
  args: ExtractArgs,
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
): RuntimeStoreConfig[] {
  const configs: Array<[string, string | null, boolean, string | null]> = [
    ["codex", args.codexSessionsDir, !args.noCodex, args.noCodex ? "disabled_by_flag" : null],
    ["claude-code", args.claudeProjectsDir, !args.noClaude, args.noClaude ? "disabled_by_flag" : null],
    ["cursor", args.cursorProjectsDir || resolveCursorProjectsPath(env), !args.noCursor, args.noCursor ? "disabled_by_flag" : null],
    [
      "cursor-agent",
      args.cursorChatsDir || resolveCursorChatsPath(env),
      !args.noCursor,
      args.noCursor ? "disabled_by_flag" : null,
    ],
    [
      "opencode",
      args.opencodeConversationsDir || resolveOpencodeDbPath(env),
      !args.noOpencode,
      args.noOpencode ? "disabled_by_flag" : null,
    ],
    [
      "github-copilot",
      args.copilotConversationsDir || resolveCopilotStorePath(env),
      !args.noCopilot,
      args.noCopilot ? "disabled_by_flag" : null,
    ],
  ];
  return configs.map(([runtime, storePath, selected, skipReason]) => ({
    runtime,
    storePath: storePath ?? null,
    selected,
    skipReason,
  }));
}

function trackEarliest(current: string | null, candidate: string): string | null {
  if (!candidate) return current;
  if (current === null) return candidate;
  return candidate < current ? candidate : current;
}

function trackLatest(current: string | null, candidate: string): string | null {
  if (!candidate) return current;
  if (current === null) return candidate;
  return candidate > current ? candidate : current;
}

function probeJsonlTimestamps(storePath: string): { earliest: string | null; latest: string | null } {
  let earliest: string | null = null;
  let latest: string | null = null;
  for (const filePath of rglob(storePath, "*.jsonl")) {
    const fallback = isoFromMtime(filePath);
    let sawEvent = false;
    for (const event of iterJsonl(filePath, [])) {
      sawEvent = true;
      const ts = eventTimestamp(event, fallback);
      earliest = trackEarliest(earliest, ts);
      latest = trackLatest(latest, ts);
    }
    if (!sawEvent) {
      earliest = trackEarliest(earliest, fallback);
      latest = trackLatest(latest, fallback);
    }
  }
  return { earliest, latest };
}

function probeSqliteTimestamps(storePath: string, runtime: string): { earliest: string | null; latest: string | null } {
  const dbPaths =
    runtime === "opencode"
      ? [storePath]
      : runtime === "github-copilot"
        ? isFilePath(storePath)
          ? [storePath]
          : rglob(storePath, "session-store.db")
        : rglob(storePath, "store.db");
  let earliest: string | null = null;
  let latest: string | null = null;
  for (const dbPath of dbPaths) {
    if (!isFilePath(dbPath)) continue;
    const fallback = isoFromMtime(dbPath);
    let conn;
    try {
      conn = openSqlite(dbPath);
    } catch (exc) {
      if (exc instanceof PermissionDeniedError) continue;
      continue;
    }
    try {
      if (runtime === "opencode") {
        const cols = tableColumns(conn, "session");
        const timeCol = firstColumn(cols, ["time_created", "time", "timestamp", "created_at", "createdAt"]);
        if (timeCol) {
          const row = conn
            .prepare(`SELECT MIN("${timeCol.replace(/"/g, '""')}") AS min_ts, MAX("${timeCol.replace(/"/g, '""')}") AS max_ts FROM session`)
            .get();
          if (row) {
            const minTs = sqliteTimestamp(row.min_ts, fallback);
            const maxTs = sqliteTimestamp(row.max_ts, fallback);
            earliest = trackEarliest(earliest, minTs);
            latest = trackLatest(latest, maxTs);
          }
        }
      } else if (runtime === "github-copilot") {
        const sessionCols = tableColumns(conn, "sessions");
        const turnCols = tableColumns(conn, "turns");
        const sessionTime = firstColumn(sessionCols, ["time", "timestamp", "created_at", "createdAt"]);
        const turnTime = firstColumn(turnCols, ["time", "timestamp", "created_at", "createdAt"]);
        const timeCol = turnTime ?? sessionTime;
        const table = turnTime ? "turns" : sessionTime ? "sessions" : null;
        if (timeCol && table) {
          const escaped = timeCol.replace(/"/g, '""');
          const row = conn.prepare(`SELECT MIN("${escaped}") AS min_ts, MAX("${escaped}") AS max_ts FROM ${table}`).get();
          if (row) {
            const minTs = sqliteTimestamp(row.min_ts, fallback);
            const maxTs = sqliteTimestamp(row.max_ts, fallback);
            earliest = trackEarliest(earliest, minTs);
            latest = trackLatest(latest, maxTs);
          }
        }
      } else if (runtime === "cursor-agent") {
        const rows = conn.prepare("SELECT data FROM blobs ORDER BY id").all();
        for (const row of rows) {
          const payload = row.data;
          let raw = "";
          if (payload instanceof Uint8Array) raw = Buffer.from(payload).toString("utf-8");
          else if (typeof payload === "string") raw = payload;
          if (!raw) continue;
          try {
            const parsed = JSON.parse(raw) as Dict;
            const ts = eventTimestamp(parsed, fallback);
            earliest = trackEarliest(earliest, ts);
            latest = trackLatest(latest, ts);
          } catch {
            earliest = trackEarliest(earliest, fallback);
            latest = trackLatest(latest, fallback);
          }
        }
        if (rows.length === 0) {
          earliest = trackEarliest(earliest, fallback);
          latest = trackLatest(latest, fallback);
        }
      }
    } catch {
      earliest = trackEarliest(earliest, fallback);
      latest = trackLatest(latest, fallback);
    } finally {
      conn.close();
    }
  }
  return { earliest, latest };
}

function probeRuntimeTimestamps(runtime: string, storePath: string): { earliest: string | null; latest: string | null } {
  if (runtime === "opencode" || runtime === "github-copilot" || runtime === "cursor-agent") {
    return probeSqliteTimestamps(storePath, runtime);
  }
  if (isDir(storePath)) return probeJsonlTimestamps(storePath);
  if (isFilePath(storePath)) return probeSqliteTimestamps(storePath, runtime);
  return { earliest: null, latest: null };
}

export function runCoverageAudit(
  args: ExtractArgs,
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
  acceptCoverageGap = false,
): CoverageAuditResult {
  const runtimes: RuntimeCoverageEntry[] = [];
  const skippedAvailable: CoverageAuditResult["skipped_available"] = [];
  for (const config of resolveRuntimeStoreConfigs(args, env, platform)) {
    const discovery = discoverRuntimeStore(config.runtime, config.storePath);
    const available = discovery.status === "available";
    let earliest: string | null = null;
    let latest: string | null = null;
    if (available && config.storePath) {
      const bounds = probeRuntimeTimestamps(config.runtime, config.storePath);
      earliest = bounds.earliest;
      latest = bounds.latest;
    }
    const skipReason = available && !config.selected ? (config.skipReason ?? "disabled_by_flag") : null;
    if (skipReason && config.storePath) {
      skippedAvailable.push({ runtime: config.runtime, reason: skipReason, store_path: config.storePath });
    }
    runtimes.push({
      runtime: config.runtime,
      store_path: config.storePath,
      selected: config.selected,
      discovery_status: String(discovery.status),
      discovery_reason: String(discovery.reason),
      available,
      earliest_session: earliest,
      latest_session: latest,
      skip_reason: skipReason,
    });
  }
  const availableRuntimes = runtimes.filter((r) => r.available).map((r) => r.runtime);
  const selectedRuntimes = runtimes.filter((r) => r.selected).map((r) => r.runtime);
  const coverageGapFlagged = skippedAvailable.length > 0 && !acceptCoverageGap;
  return {
    runtimes,
    available_runtimes: availableRuntimes,
    selected_runtimes: selectedRuntimes,
    skipped_available: skippedAvailable,
    coverage_gap_flagged: coverageGapFlagged,
    exit_signal: skippedAvailable.length > 0 ? (acceptCoverageGap ? "complete" : "flagged") : "complete",
  };
}

export function formatCoverageSummaryText(audit: CoverageAuditResult): string {
  const lines = ["Coverage Audit (pre-extraction)"];
  for (const entry of audit.runtimes) {
    const store = entry.store_path ?? "(none)";
    if (entry.available) {
      const span =
        entry.earliest_session && entry.latest_session
          ? `${entry.earliest_session} .. ${entry.latest_session}`
          : "timestamps unavailable";
      lines.push(`  ${entry.runtime}: available store=${store} sessions=${span} selected=${entry.selected ? "yes" : "no"}`);
    } else {
      lines.push(
        `  ${entry.runtime}: ${entry.discovery_status} (${entry.discovery_reason}) store=${store} selected=${entry.selected ? "yes" : "no"}`,
      );
    }
  }
  if (audit.skipped_available.length > 0) {
    lines.push("Skipped available runtimes:");
    for (const item of audit.skipped_available) {
      lines.push(`  - ${item.runtime}: ${item.reason} (${item.store_path})`);
    }
    if (audit.coverage_gap_flagged) {
      lines.push("Coverage gap flagged (EX2): pass --accept-coverage-gap to proceed with partial extraction.");
    } else {
      lines.push("Coverage gap accepted: proceeding with selected runtimes only.");
    }
  } else if (audit.available_runtimes.length > 0) {
    lines.push("All available runtimes are selected; no coverage gap.");
  } else {
    lines.push("No available runtime stores detected on this host.");
  }
  return lines.join("\n");
}
