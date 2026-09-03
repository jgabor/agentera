import { type Env, discoverRuntimeStore, eventTimestamp, isoFromMtime, iterJsonl, rglob } from "./core.js";
import type { JsonObject } from "../../core/jsonValue.js";
import { isFilePath, isDir } from "./core.js";
import { resolveCopilotStorePath, resolveCursorChatsPath, resolveCursorProjectsPath, resolveOpencodeDbPath } from "./cursorSessions.js";
import type { ExtractArgs } from "./cli.js";
import { openSqlite, PermissionDeniedError, sqliteTimestamp, tableColumns, firstColumn } from "./sqliteSessions.js";

export const COVERAGE_EXIT_FLAGGED = 4;

export interface RuntimeStoreConfig {
  runtime: string | null;
  sourceProduct: string;
  sourceClass: "active_runtime" | "historical_import";
  activeRuntime: boolean;
  pattern?: string;
  storePath: string | null;
  selected: boolean;
  skipReason: string | null;
}

export interface RuntimeCoverageEntry {
  runtime: string | null;
  source_product: string;
  source_class: "active_runtime" | "historical_import";
  active_runtime: boolean;
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

export function resolveRuntimeStoreConfigs(args: ExtractArgs, env: Env = process.env, _platform: NodeJS.Platform = process.platform): RuntimeStoreConfig[] {
  const configs: RuntimeStoreConfig[] = [
    {
      runtime: "codex",
      sourceProduct: "codex",
      sourceClass: "active_runtime",
      activeRuntime: true,
      storePath: args.codexSessionsDir,
      selected: !args.noCodex,
      skipReason: args.noCodex ? "disabled_by_flag" : null,
    },
    {
      runtime: "cursor",
      sourceProduct: "cursor",
      sourceClass: "active_runtime",
      activeRuntime: true,
      storePath: args.cursorProjectsDir || resolveCursorProjectsPath(env),
      selected: !args.noCursor,
      skipReason: args.noCursor ? "disabled_by_flag" : null,
    },
    {
      runtime: "cursor",
      sourceProduct: "cursor-agent",
      sourceClass: "active_runtime",
      activeRuntime: true,
      pattern: "store.db",
      storePath: args.cursorChatsDir || resolveCursorChatsPath(env),
      selected: !args.noCursor,
      skipReason: args.noCursor ? "disabled_by_flag" : null,
    },
    {
      runtime: "opencode",
      sourceProduct: "opencode",
      sourceClass: "active_runtime",
      activeRuntime: true,
      storePath: args.opencodeConversationsDir || resolveOpencodeDbPath(env),
      selected: !args.noOpencode,
      skipReason: args.noOpencode ? "disabled_by_flag" : null,
    },
    {
      runtime: "copilot",
      sourceProduct: "github-copilot",
      sourceClass: "active_runtime",
      activeRuntime: true,
      storePath: args.copilotConversationsDir || resolveCopilotStorePath(env),
      selected: !args.noCopilot,
      skipReason: args.noCopilot ? "disabled_by_flag" : null,
    },
  ];
  if ((args.importSources ?? []).includes("claude")) {
    configs.push({
      runtime: null,
      sourceProduct: "claude-code",
      sourceClass: "historical_import",
      activeRuntime: false,
      pattern: "*.jsonl",
      storePath: args.claudeProjectsDir,
      selected: true,
      skipReason: null,
    });
  }
  return configs.map((config) => ({ ...config, storePath: config.storePath ?? null }));
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

function probeJsonlTimestamps(storePath: string): {
  earliest: string | null;
  latest: string | null;
} {
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

function probeSqliteTimestamps(storePath: string, sourceProduct: string): { earliest: string | null; latest: string | null } {
  const dbPaths = sourceProduct === "opencode" ? [storePath] : sourceProduct === "github-copilot" ? (isFilePath(storePath) ? [storePath] : rglob(storePath, "session-store.db")) : rglob(storePath, "store.db");
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
      if (sourceProduct === "opencode") {
        const cols = tableColumns(conn, "session");
        const timeCol = firstColumn(cols, ["time_created", "time", "timestamp", "created_at", "createdAt"]);
        if (timeCol) {
          const row = conn.prepare(`SELECT MIN("${timeCol.replace(/"/g, '""')}") AS min_ts, MAX("${timeCol.replace(/"/g, '""')}") AS max_ts FROM session`).get();
          if (row) {
            const minTs = sqliteTimestamp(row.min_ts, fallback);
            const maxTs = sqliteTimestamp(row.max_ts, fallback);
            earliest = trackEarliest(earliest, minTs);
            latest = trackLatest(latest, maxTs);
          }
        }
      } else if (sourceProduct === "github-copilot") {
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
      } else if (sourceProduct === "cursor-agent") {
        const rows = conn.prepare("SELECT data FROM blobs ORDER BY id").all();
        for (const row of rows) {
          const payload = row.data;
          let raw = "";
          if (payload instanceof Uint8Array) raw = Buffer.from(payload).toString("utf-8");
          else if (typeof payload === "string") raw = payload;
          if (!raw) continue;
          try {
            const parsed = JSON.parse(raw) as JsonObject; // cast: IO boundary — parsed subprocess stdout JSON
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

function probeRuntimeTimestamps(sourceProduct: string, storePath: string): { earliest: string | null; latest: string | null } {
  if (sourceProduct === "opencode" || sourceProduct === "github-copilot" || sourceProduct === "cursor-agent") {
    return probeSqliteTimestamps(storePath, sourceProduct);
  }
  if (isDir(storePath)) return probeJsonlTimestamps(storePath);
  if (isFilePath(storePath)) return probeSqliteTimestamps(storePath, sourceProduct);
  return { earliest: null, latest: null };
}

export function runCoverageAudit(args: ExtractArgs, env: Env = process.env, platform: NodeJS.Platform = process.platform, acceptCoverageGap = false): CoverageAuditResult {
  const runtimes: RuntimeCoverageEntry[] = [];
  const skippedAvailable: CoverageAuditResult["skipped_available"] = [];
  for (const config of resolveRuntimeStoreConfigs(args, env, platform)) {
    const discovery = discoverRuntimeStore(config.runtime, config.storePath, {
      sourceProduct: config.sourceProduct,
      sourceClass: config.sourceClass,
      activeRuntime: config.activeRuntime,
      pattern: config.pattern,
    });
    const available = discovery.status === "available";
    let earliest: string | null = null;
    let latest: string | null = null;
    if (available && config.storePath) {
      const bounds = probeRuntimeTimestamps(config.sourceProduct, config.storePath);
      earliest = bounds.earliest;
      latest = bounds.latest;
    }
    const skipReason = available && !config.selected ? (config.skipReason ?? "disabled_by_flag") : null;
    if (skipReason && config.storePath) {
      skippedAvailable.push({
        runtime: config.runtime as string,
        reason: skipReason,
        store_path: config.storePath,
      });
    }
    runtimes.push({
      runtime: config.runtime,
      source_product: config.sourceProduct,
      source_class: config.sourceClass,
      active_runtime: config.activeRuntime,
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
  const availableRuntimes = [...new Set(runtimes.filter((r) => r.active_runtime && r.available).map((r) => r.runtime as string))];
  const selectedRuntimes = [...new Set(runtimes.filter((r) => r.active_runtime && r.selected).map((r) => r.runtime as string))];
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
      const span = entry.earliest_session && entry.latest_session ? `${entry.earliest_session} .. ${entry.latest_session}` : "timestamps unavailable";
      const label = entry.active_runtime ? entry.runtime : `${entry.source_product} [historical import]`;
      lines.push(`  ${label}: available store=${store} sessions=${span} selected=${entry.selected ? "yes" : "no"}`);
    } else {
      lines.push(`  ${entry.active_runtime ? entry.runtime : `${entry.source_product} [historical import]`}: ${entry.discovery_status} (${entry.discovery_reason}) store=${store} selected=${entry.selected ? "yes" : "no"}`);
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
