import {
  type Env,
  MAX_SQLITE_ROWS,
  MAX_SQLITE_SESSIONS,
} from "./core.js";
import type { JsonObject } from "../../core/jsonValue.js";

export interface SqliteCaps {
  maxSessions: number;
  maxRows: number;
}

export interface SqliteTruncationInfo {
  truncatedAt: string;
  cap: "sessions" | "rows";
  limit: number;
}

function parsePositiveCap(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`extract-corpus: invalid ${label}: ${value}`);
  }
  return parsed;
}

export function resolveSqliteCaps(
  env: Env = process.env,
  cliOverrides?: { maxSessions?: number; maxRows?: number },
): SqliteCaps {
  return {
    maxSessions:
      cliOverrides?.maxSessions ??
      parsePositiveCap(env.AGENTERA_EXTRACT_MAX_SQLITE_SESSIONS, MAX_SQLITE_SESSIONS, "max sqlite sessions cap"),
    maxRows:
      cliOverrides?.maxRows ??
      parsePositiveCap(env.AGENTERA_EXTRACT_MAX_SQLITE_ROWS, MAX_SQLITE_ROWS, "max sqlite rows cap"),
  };
}

export function formatTruncationWarnings(runtimeStatuses: JsonObject[]): string {
  const lines: string[] = [];
  for (const status of runtimeStatuses) {
    const truncatedAt = status.truncated_at;
    if (typeof truncatedAt !== "string" || !truncatedAt) continue;
    const runtime = typeof status.runtime === "string" ? status.runtime : "unknown";
    const cap = typeof status.truncation_cap === "string" ? status.truncation_cap : "cap";
    const limit = status.truncation_limit ?? "?";
    lines.push(`  ${runtime}: truncated at ${truncatedAt} (${cap} limit=${limit})`);
  }
  if (lines.length === 0) return "";
  return ["SQLite extraction truncated (history beyond cap omitted):", ...lines].join("\n");
}

export function applyTruncationToStatus(status: JsonObject, truncation: SqliteTruncationInfo | null | undefined): JsonObject {
  if (!truncation) return status;
  return {
    ...status,
    truncated_at: truncation.truncatedAt,
    truncation_cap: truncation.cap,
    truncation_limit: truncation.limit,
  };
}
