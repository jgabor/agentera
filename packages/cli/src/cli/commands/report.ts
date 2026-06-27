import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveProfileDirOverride, resolveXdgDataHome } from "../../core/envPaths.js";
import { expanduser } from "../../core/paths.js";

import { usageMain, corpusTooLargeReason } from "../../analytics/usageStats.js";
import { extractCorpusMain } from "../../analytics/extractCorpus.js";

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
  // corpus-refresh passthrough to the extract engine (used by profile)
  output?: string | null;
  codexSessionsDir?: string | null;
  claudeProjectsDir?: string | null;
  opencodeConversationsDir?: string | null;
  copilotConversationsDir?: string | null;
  cursorProjectsDir?: string | null;
  cursorChatsDir?: string | null;
  noCodex?: boolean;
  noClaude?: boolean;
  noOpencode?: boolean;
  noCopilot?: boolean;
  noCursor?: boolean;
  acceptCoverageGap?: boolean;
  coverageAuditOnly?: boolean;
}

function buildExtractArgv(args: ReportArgs, corpusPath: string): string[] {
  const argv: string[] = ["--output", corpusPath];
  for (const root of args.projectRoot ?? []) argv.push("--project-root", root);
  if (args.codexSessionsDir) argv.push("--codex-sessions-dir", args.codexSessionsDir);
  if (args.claudeProjectsDir) argv.push("--claude-projects-dir", args.claudeProjectsDir);
  if (args.opencodeConversationsDir) argv.push("--opencode-conversations-dir", args.opencodeConversationsDir);
  if (args.copilotConversationsDir) argv.push("--copilot-conversations-dir", args.copilotConversationsDir);
  if (args.cursorProjectsDir) argv.push("--cursor-projects-dir", args.cursorProjectsDir);
  if (args.cursorChatsDir) argv.push("--cursor-chats-dir", args.cursorChatsDir);
  if (args.noCodex) argv.push("--no-codex");
  if (args.noClaude) argv.push("--no-claude");
  if (args.noOpencode) argv.push("--no-opencode");
  if (args.noCopilot) argv.push("--no-copilot");
  if (args.noCursor) argv.push("--no-cursor");
  if (args.acceptCoverageGap) argv.push("--accept-coverage-gap");
  if (args.coverageAuditOnly) argv.push("--coverage-audit-only");
  return argv;
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
  const profileOverride = resolveProfileDirOverride(env);
  if (profileOverride) return path.join(expanduser(profileOverride), "intermediate", "corpus.json");
  const appHome = env.AGENTERA_HOME;
  if (appHome) return path.join(expanduser(appHome), "intermediate", "corpus.json");
  let base: string;
  if (platform === "darwin") {
    base = path.join(os.homedir(), "Library", "Application Support", "agentera");
  } else if (platform === "win32") {
    base = path.join(expanduser(env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")), "agentera");
  } else {
    base = path.join(resolveXdgDataHome(env), "agentera");
  }
  return path.join(base, "intermediate", "corpus.json");
}

/** Faithful port of `_stats_existing_corpus_status`. */
export function statsExistingCorpusStatus(corpusPath: string): Dict {
  if (!fs.existsSync(corpusPath)) {
    return { status: "missing", path: corpusPath, reason: "corpus file does not exist" };
  }
  const tooLarge = corpusTooLargeReason(corpusPath);
  if (tooLarge) {
    return { status: "stale", path: corpusPath, reason: tooLarge };
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
    const corpusPath = args.output || statsCorpusPath();
    const engineArgv = buildExtractArgv(args, corpusPath);
    const engineCommand = ["npx", "-y", "agentera", "report", "refresh", "--consent", "local-history", ...engineArgv];
    if (dryRun) {
      const payload = {
        command: "stats refresh",
        status: "dry_run",
        privacy: {
          local_history_read: false,
          local_history_write: false,
          corpus_write: false,
          required_consent: "local-history",
          provided_consent: null,
        },
        corpus_path: corpusPath,
        engine: { command: engineCommand },
        diagnostics: [
          "dry-run does not read runtime history or write corpus files",
          "generated corpus is internal state for stats at $AGENTERA_PROFILE_DIR/intermediate/corpus.json",
        ],
      };
      if (outputFormat === "json") {
        out(JSON.stringify(payload, null, 2) + "\n");
      } else {
        out(`agentera stats refresh: dry_run\ncorpus=${corpusPath}\nengine=${engineCommand.join(" ")}\n`);
        out("privacy=local_history_read=false, corpus_write=false, required_consent=local-history\n");
      }
      return 0;
    }
    // consent === "local-history": run the corpus extractor over local history.
    let engineOut = "";
    let engineErr = "";
    const rc = extractCorpusMain(engineArgv, {
      out: (t) => (engineOut += t + "\n"),
      err: (t) => (engineErr += t + "\n"),
    });
    const refreshStatus = rc === 0 ? "pass" : rc === 4 ? "flagged" : "fail";
    const payload = {
      command: "stats refresh",
      status: refreshStatus,
      exit_signal: rc === 4 ? "EX2" : null,
      privacy: { local_history_read: true, local_history_write: false, corpus_write: rc === 0, required_consent: "local-history", provided_consent: "local-history" },
      corpus_path: corpusPath,
      engine: { command: engineCommand, exit_code: rc, stdout: engineOut.split("\n").filter((l) => l), stderr: engineErr.split("\n").filter((l) => l) },
    };
    if (outputFormat === "json") {
      out(JSON.stringify(payload, null, 2) + "\n");
    } else {
      out(`agentera stats refresh: ${payload.status}\ncorpus=${corpusPath}\n`);
      if (engineOut) out(engineOut);
      if (engineErr) err(engineErr);
    }
    return rc;
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
