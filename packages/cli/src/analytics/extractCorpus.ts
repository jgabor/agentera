/**
 * Section 22 corpus extractor — faithful TypeScript port of
 * scripts/extract_corpus.py (git 1389867~1).
 *
 * Reads local AI runtime history (JSONL files + SQLite stores via node:sqlite)
 * across Codex / Claude Code / Cursor / Cursor-agent / OpenCode / GitHub Copilot,
 * plus instruction documents and project config signals, and emits the
 * corpus.json envelope that profilera synthesizes PROFILE.md from and that
 * `report`/`stats` analytics read.
 *
 * SQLite uses Node's built-in node:sqlite (DatabaseSync), imported lazily so the
 * one experimental warning only appears when a SQLite store is actually read.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

type Dict = Record<string, any>;
type Env = Record<string, string | undefined>;

export const ADAPTER_VERSION = "agentera-v2-corpus-1";
export const FAMILIES = [
  "instruction_document",
  "history_prompt",
  "conversation_turn",
  "tool_call",
  "project_config_signal",
] as const;

export const RUNTIME_STORE_GLOBS: Record<string, string> = {
  codex: "*.jsonl",
  "claude-code": "*.jsonl",
  cursor: "*.jsonl",
  "cursor-agent": "store.db",
  opencode: "opencode.db",
  "github-copilot": "session-store.db",
};
const MAX_TOOL_ARG_TEXT = 500;
const MAX_SQLITE_ROWS = 100_000;
const MAX_SQLITE_SESSIONS = 60;
const COPILOT_SPARSE_REMEDIATION = "/chronicle reindex";

const DECISION_RE =
  /\b(decide|decision|prefer|preference|instead|avoid|don't|do not|should|trade[- ]?off|scope|plan|commit|review|fix|why|question|blocked|stuck|approve|reject|change|keep|remove)\b/i;
const CORRECTION_RE =
  /\b(no|not quite|actually|rather|instead|wrong|correction|that's not|that is not|don't|do not)\b/i;
const QUESTION_RE = /\?|^\s*(why|what|how|should|can|could|would)\b/i;

// ── core helpers ───────────────────────────────────────────────────

export function isoNow(): string {
  // Python datetime.now(utc).isoformat() -> microseconds + "+00:00" -> "Z".
  // JS gives milliseconds; corpus extracted_at is a wall-clock stamp, not a
  // parity-critical record value.
  return new Date().toISOString().replace(/Z$/, "Z");
}

export function isoFromMtime(p: string): string {
  const ms = fs.statSync(p).mtimeMs;
  return new Date(ms).toISOString().replace(/Z$/, "Z");
}

export function stableId(...parts: unknown[]): string {
  const raw = parts.map((p) => pyStr(p)).join("\0");
  return crypto.createHash("sha256").update(raw, "utf-8").digest("hex").slice(0, 24);
}

/** Python str() for the scalar/None values stable_id receives. */
function pyStr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return String(value);
}

export function projectIdFromPath(p: string | null): string {
  if (p === null) return "global";
  const name = path.basename(p) || p;
  const slug = name
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .toLowerCase();
  return slug || "global";
}

export function defaultAgenteraHome(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  const override = env.AGENTERA_HOME;
  if (override) return override;
  if (platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "agentera");
  if (platform === "win32") {
    const appdata = env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appdata, "agentera");
  }
  const xdg = env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(xdg, "agentera");
}

export function defaultProfileDir(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  const override = env.PROFILERA_PROFILE_DIR;
  if (override) return override;
  return defaultAgenteraHome(env, platform);
}

export function defaultOutputPath(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  return path.join(defaultProfileDir(env, platform), "intermediate", "corpus.json");
}

export interface RuntimeStatusOpts {
  status: string;
  reason: string;
  storePath: string | null;
  candidateCount?: number | null;
  recordCount?: number | null;
  errorCount?: number | null;
  remediationLabels?: string[] | null;
}

export function runtimeStatus(runtime: string, opts: RuntimeStatusOpts): Dict {
  const item: Dict = { runtime, status: opts.status, reason: opts.reason };
  if (opts.storePath !== null && opts.storePath !== undefined) item.store_path = opts.storePath;
  if (opts.candidateCount !== null && opts.candidateCount !== undefined) item.candidate_count = opts.candidateCount;
  if (opts.recordCount !== null && opts.recordCount !== undefined) item.record_count = opts.recordCount;
  if (opts.errorCount !== null && opts.errorCount !== undefined) item.error_count = opts.errorCount;
  if (opts.remediationLabels && opts.remediationLabels.length > 0) item.remediation_labels = opts.remediationLabels;
  return item;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function isFilePath(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Recursive glob for a simple pattern ("*.jsonl" or an exact filename). */
function rglob(root: string, pattern: string): string[] {
  const out: string[] = [];
  const matchesExt = pattern.startsWith("*.") ? pattern.slice(1) : null; // ".jsonl"
  const exact = matchesExt ? null : pattern;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        if (matchesExt ? e.name.endsWith(matchesExt) : e.name === exact) out.push(full);
      }
    }
  };
  walk(root);
  return out.sort();
}

export function discoverRuntimeStore(runtime: string, storePath: string | null): Dict {
  if (storePath === null) {
    return runtimeStatus(runtime, { status: "skipped", reason: "disabled", storePath: null });
  }
  if (!fs.existsSync(storePath)) {
    return runtimeStatus(runtime, {
      status: "missing",
      reason: "store_absent",
      storePath,
      remediationLabels: runtime === "github-copilot" ? [COPILOT_SPARSE_REMEDIATION] : null,
    });
  }
  if ((runtime === "opencode" || runtime === "github-copilot") && isFilePath(storePath)) {
    return runtimeStatus(runtime, {
      status: "available",
      reason: "candidate_files_found",
      storePath,
      candidateCount: 1,
    });
  }
  if (!isDir(storePath)) {
    return runtimeStatus(runtime, { status: "degraded", reason: "store_not_directory", storePath });
  }
  let candidates: string[];
  try {
    candidates = rglob(storePath, RUNTIME_STORE_GLOBS[runtime]);
  } catch {
    return runtimeStatus(runtime, { status: "degraded", reason: "store_unreadable", storePath });
  }
  if (candidates.length === 0) {
    return runtimeStatus(runtime, {
      status: "sparse",
      reason: "no_candidate_files",
      storePath,
      candidateCount: 0,
      remediationLabels: runtime === "github-copilot" ? [COPILOT_SPARSE_REMEDIATION] : null,
    });
  }
  return runtimeStatus(runtime, {
    status: "available",
    reason: "candidate_files_found",
    storePath,
    candidateCount: candidates.length,
  });
}
