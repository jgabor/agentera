import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { usageMain } from "../../analytics/usageStats.js";

type Io = { out?: (t: string) => void; err?: (t: string) => void };
type Env = Record<string, string | undefined>;
type Dict = Record<string, any>;

export interface ReportArgs {
  action?: string | null; // "refresh" or null
  format?: string;
  project?: string | null;
  dryRun?: boolean;
  consent?: string | null;
  projectRoot?: string[];
}

function usageSyntax(): string {
  return "agentera usage [--format text|json] [--corpus PATH] [--project VALUE]";
}
function usageExample(): string {
  return "agentera usage --format json --project agentera";
}

/** Faithful port of scripts/agentera `_validate_usage_request` (shared by usage/stats/report). */
function validateUsageRequest(format: string): string {
  if (format !== "text" && format !== "json") {
    throw new Error(
      `unsupported usage format '${format}'; valid formats: text, json. ` +
        `Syntax: ${usageSyntax()}. Example: ${usageExample()}`,
    );
  }
  return format;
}

/** Faithful port of `_stats_corpus_path`. */
export function statsCorpusPath(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  const override = env.PROFILERA_PROFILE_DIR;
  if (override) return path.join(override, "intermediate", "corpus.json");
  const appHome = env.AGENTERA_HOME;
  if (appHome) return path.join(appHome, "intermediate", "corpus.json");
  let base: string;
  if (platform === "darwin") {
    base = path.join(os.homedir(), "Library", "Application Support", "agentera");
  } else if (platform === "win32") {
    base = path.join(env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "agentera");
  } else {
    base = path.join(env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "agentera");
  }
  return path.join(base, "intermediate", "corpus.json");
}

/** Faithful port of `_stats_existing_corpus_status`. */
export function statsExistingCorpusStatus(corpusPath: string): Dict {
  if (!fs.existsSync(corpusPath)) {
    return { status: "missing", path: corpusPath, reason: "corpus file does not exist" };
  }
  let data: any;
  try {
    data = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
  } catch (exc) {
    return { status: "stale", path: corpusPath, reason: `corpus is not readable JSON: ${(exc as Error).message}` };
  }
  const records = data && typeof data === "object" && !Array.isArray(data) ? data.records ?? [] : [];
  const hasTurn =
    Array.isArray(records) &&
    records.some((r: any) => r && typeof r === "object" && r.source_kind === "conversation_turn");
  if (!hasTurn) {
    return { status: "stale", path: corpusPath, reason: "corpus has no conversation_turn records" };
  }
  const metadata = data.metadata && typeof data.metadata === "object" ? data.metadata : {};
  return {
    status: "ready",
    path: corpusPath,
    reason: "existing corpus has conversation_turn records",
    extracted_at: metadata.extracted_at ?? null,
    total_records: (records as any[]).length,
  };
}

const REFRESH_UNAVAILABLE =
  "corpus refresh is not available in the self-contained agentera package; the corpus " +
  "extractor reads local runtime history and is a maintainer tool that runs from a source checkout";

/**
 * Faithful port of scripts/agentera `cmd_stats` (canonical command is `report`;
 * `stats` is the deprecated alias and shares this logic). The plain read path
 * reuses the ported usage engine; corpus refresh (which would run the maintainer
 * extractor over local runtime history) is reported as unavailable in the
 * self-contained package.
 */
export function cmdReport(args: ReportArgs, io: Io = {}): number {
  const out = io.out ?? ((t: string) => process.stdout.write(t));
  const err = io.err ?? ((t: string) => process.stderr.write(t));

  let outputFormat: string;
  try {
    outputFormat = validateUsageRequest(String(args.format ?? "text"));
  } catch (exc) {
    err(`Error: ${(exc as Error).message}\n`);
    return 2;
  }

  const action = args.action ?? null;
  if (action === "refresh") {
    const dryRun = Boolean(args.dryRun);
    const consent = args.consent ?? null;
    if (dryRun && consent) {
      err("Error: agentera stats refresh accepts either --dry-run or --consent local-history, not both\n");
      return 2;
    }
    if (!dryRun && consent !== "local-history") {
      err(
        "Error: agentera stats refresh requires explicit --consent local-history to read local runtime history. " +
          "Preview first with agentera stats refresh --dry-run\n",
      );
      return 2;
    }
    // Self-contained package: the maintainer extractor is not bundled.
    if (outputFormat === "json") {
      out(
        JSON.stringify(
          {
            command: "stats refresh",
            status: "unavailable",
            mode: dryRun ? "dry_run" : "pending",
            reason: REFRESH_UNAVAILABLE,
            corpus_path: statsCorpusPath(),
          },
          null,
          2,
        ) + "\n",
      );
    } else {
      err(`stats refresh unavailable: ${REFRESH_UNAVAILABLE}\n`);
    }
    return 2;
  }

  if (action !== null) {
    err(
      `Error: unsupported stats action '${action}'. ` +
        "Syntax: agentera stats [--format text|json] [--project VALUE] | agentera stats refresh --dry-run|--consent local-history\n",
    );
    return 2;
  }

  const corpusPath = statsCorpusPath();
  const status = statsExistingCorpusStatus(corpusPath);
  if (status.status !== "ready") {
    if (outputFormat === "json") {
      out(
        JSON.stringify(
          {
            command: "stats",
            status: status.status,
            corpus_path: corpusPath,
            reason: status.reason,
            next: "agentera stats refresh --dry-run",
            privacy: { local_history_read: false, local_history_write: false },
          },
          null,
          2,
        ) + "\n",
      );
    } else {
      err(`stats data ${status.status}: ${status.reason}\n`);
      err(`corpus=${corpusPath}\n`);
      err("Next: agentera stats refresh --dry-run\n");
      err("Plain stats does not read local runtime history.\n");
    }
    return 2;
  }

  // Ready: run the usage engine over the existing corpus (passthrough).
  const engineArgs: string[] = ["--corpus", corpusPath];
  if (args.project) engineArgs.push("--project", args.project);
  if (outputFormat === "json") engineArgs.push("--json");
  return usageMain(engineArgs, {
    out: (t) => out(t + "\n"),
    err: (t) => err(t + "\n"),
  });
}
