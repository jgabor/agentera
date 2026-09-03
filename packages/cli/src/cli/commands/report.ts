import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveProfileDirOverride, resolveXdgDataHome } from "../../core/envPaths.js";
import { expanduser } from "../../core/paths.js";

import { usageMain, corpusTooLargeReason } from "../../analytics/usageStats.js";
import { extractCorpusMain } from "../../analytics/extractCorpus.js";
import { acquirePersonalGlossaryRefreshCommitLock, PersonalGlossaryRefreshCommitLockError, produceCurrentPersonalGlossaryProjection, releasePersonalGlossaryRefreshCommitLock } from "../../analytics/personalGlossaryRefreshProjection.js";
import { tiersDirForCorpusPath, assessTiers, readBoundedMetadata, readCurrentGeneration } from "../../analytics/extractCorpus/index.js";
import type { JsonObject } from "../../core/jsonValue.js";

type Io = { out?: (t: string) => void; err?: (t: string) => void };
type Env = Record<string, string | undefined>;

export interface ReportArgs {
  action?: string | null; // "refresh" or null
  format?: string;
  project?: string | null;
  sources?: "active" | "all";
  dryRun?: boolean;
  consent?: string | null;
  projectRoot?: string[];
  // Resolves the canonical intermediate path used to derive the tiers
  // directory (`dirname(output)/tiers`) and to display `corpus_path`. The
  // extract engine writes bounded tiers there; the monolithic corpus is no
  // longer written. Null falls back to `statsCorpusPath()`.
  output?: string | null;
  codexSessionsDir?: string | null;
  claudeProjectsDir?: string | null;
  importSources?: string[];
  opencodeConversationsDir?: string | null;
  copilotConversationsDir?: string | null;
  cursorProjectsDir?: string | null;
  cursorChatsDir?: string | null;
  noCodex?: boolean;
  noOpencode?: boolean;
  noCopilot?: boolean;
  noCursor?: boolean;
  acceptCoverageGap?: boolean;
  coverageAuditOnly?: boolean;
}

function buildExtractArgv(args: ReportArgs, corpusPath: string): string[] {
  // Refresh publishes bounded evidence tiers to the directory co-located with
  // the canonical corpus path (`<dir>/tiers`); the extract engine no longer
  // accepts the monolithic `--output corpusPath` write target (tiers are the
  // only canonical output). Passing `--tier-output` makes the displayed
  // `corpus_path`/`tier_path` truthful: tiers land at `dirname(corpusPath)/tiers`.
  const argv: string[] = ["--tier-output", tiersDirForCorpusPath(corpusPath)];
  for (const root of args.projectRoot ?? []) argv.push("--project-root", root);
  if (args.codexSessionsDir) argv.push("--codex-sessions-dir", args.codexSessionsDir);
  if (args.claudeProjectsDir) argv.push("--claude-projects-dir", args.claudeProjectsDir);
  for (const source of args.importSources ?? []) argv.push("--import-source", source);
  if (args.opencodeConversationsDir) argv.push("--opencode-conversations-dir", args.opencodeConversationsDir);
  if (args.copilotConversationsDir) argv.push("--copilot-conversations-dir", args.copilotConversationsDir);
  if (args.cursorProjectsDir) argv.push("--cursor-projects-dir", args.cursorProjectsDir);
  if (args.cursorChatsDir) argv.push("--cursor-chats-dir", args.cursorChatsDir);
  if (args.noCodex) argv.push("--no-codex");
  if (args.noOpencode) argv.push("--no-opencode");
  if (args.noCopilot) argv.push("--no-copilot");
  if (args.noCursor) argv.push("--no-cursor");
  if (args.acceptCoverageGap) argv.push("--accept-coverage-gap");
  if (args.coverageAuditOnly) argv.push("--coverage-audit-only");
  return argv;
}

function usageSyntax(): string {
  return "agentera usage [--format text|json] [--corpus PATH] [--project VALUE] [--sources active|all]";
}
function usageExample(): string {
  return "agentera usage --project agentera";
}

/** Faithful port of scripts/agentera `_validate_usage_request` (shared by usage/stats/report). */
function validateUsageRequest(format: string): string {
  if (format !== "text" && format !== "json") {
    throw new Error(`unsupported usage format '${format}'; valid formats: text, json. ` + `Syntax: ${usageSyntax()}. Example: ${usageExample()}`);
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
export function statsExistingCorpusStatus(corpusPath: string): JsonObject {
  // Bounded tier path: when tiers are published, report readiness from the
  // manifest + retained corpus metadata without reading full evidence. The
  // documented `tier_state`/`tier_path` fields extend the legacy shape;
  // existing `status`/`reason`/`extracted_at`/`total_records` are preserved.
  const tiersDir = tiersDirForCorpusPath(corpusPath);
  const assessment = assessTiers(tiersDir, corpusPath);
  if (assessment.analyzable) {
    const meta = readBoundedMetadata(tiersDir);
    const manifest = meta.manifest;
    const extractedAt = meta.corpusMetadata?.extracted_at ?? null;
    return {
      status: "ready",
      path: corpusPath,
      tier_path: tiersDir,
      tier_state: assessment.state,
      reason: "bounded evidence tier published",
      extracted_at: extractedAt ?? manifest?.published_at ?? null,
      total_records: manifest?.total_records ?? 0,
    };
  }
  if (assessment.state === "oversized" || assessment.state === "corrupt") {
    return {
      status: "stale",
      path: corpusPath,
      tier_path: tiersDir,
      tier_state: assessment.state,
      reason: assessment.recovery ?? `${assessment.state} evidence tier`,
      ...(assessment.artifact ? { artifact: assessment.artifact } : {}),
    };
  }
  // Legacy or missing: preserve the corpus-envelope status behavior.
  if (!fs.existsSync(corpusPath)) {
    return { status: "missing", path: corpusPath, reason: "corpus file does not exist" };
  }
  const tooLarge = corpusTooLargeReason(corpusPath);
  if (tooLarge) {
    return { status: "stale", path: corpusPath, tier_state: "legacy", reason: tooLarge };
  }
  let data: any;
  try {
    data = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
  } catch (exc) {
    return {
      status: "stale",
      path: corpusPath,
      tier_state: "legacy",
      reason: `corpus is not readable JSON: ${(exc as Error).message}`,
    };
  }
  const records = data && typeof data === "object" && !Array.isArray(data) ? (data.records ?? []) : [];
  const hasTurn = Array.isArray(records) && records.some((r: any) => r && typeof r === "object" && r.source_kind === "conversation_turn");
  if (!hasTurn) {
    return {
      status: "stale",
      path: corpusPath,
      tier_state: "legacy",
      reason: "corpus has no conversation_turn records",
    };
  }
  const metadata = data.metadata && typeof data.metadata === "object" ? data.metadata : {};
  return {
    status: "ready",
    path: corpusPath,
    tier_state: "legacy",
    reason: "existing corpus has conversation_turn records",
    extracted_at: metadata.extracted_at ?? null,
    total_records: (records as any[]).length,
  };
}

/**
 * Faithful port of scripts/agentera `cmd_stats` (canonical command is `report`;
 * `stats` is the deprecated alias and shares this logic). The plain read path
 * reuses the ported usage engine over bounded tiers (with a legacy
 * corpus.json fallback when no tiers are published). `stats refresh` publishes
 * bounded tiers from local runtime history under explicit consent.
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
      const recovery = "agentera report refresh --consent local-history";
      const message = "Error: agentera stats refresh requires explicit --consent local-history to read local runtime history. " + "Preview first with agentera stats refresh --dry-run";
      if (outputFormat === "json") {
        out(
          JSON.stringify(
            {
              command: "stats refresh",
              status: "degraded_consent_required",
              recovery,
              privacy: {
                local_history_read: false,
                local_history_write: false,
                tier_write: false,
                required_consent: "local-history",
                provided_consent: consent,
              },
            },
            null,
            2,
          ) + "\n",
        );
      }
      err(`${message}\nRecovery: ${recovery}\n`);
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
          tier_write: false,
          required_consent: "local-history",
          provided_consent: null,
        },
        corpus_path: corpusPath,
        tier_path: tiersDirForCorpusPath(corpusPath),
        engine: { command: engineCommand },
        diagnostics: [
          "dry-run does not read runtime history or write tier files",
          "published tiers are internal state for stats at $AGENTERA_PROFILE_DIR/intermediate/tiers",
          ...(args.importSources?.includes("claude") ? ["Claude historical import can contain secrets, file contents, and command output; apply stays local and read-only"] : []),
        ],
      };
      if (outputFormat === "json") {
        out(JSON.stringify(payload, null, 2) + "\n");
      } else {
        out(`agentera stats refresh: dry_run\ncorpus=${corpusPath}\ntiers=${tiersDirForCorpusPath(corpusPath)}\nengine=${engineCommand.join(" ")}\n`);
        out("privacy=local_history_read=false, tier_write=false, required_consent=local-history\n");
      }
      return 0;
    }
    // consent === "local-history": extract local history into bounded tiers.
    const tiersDir = tiersDirForCorpusPath(corpusPath);
    let refreshLock;
    try {
      refreshLock = acquirePersonalGlossaryRefreshCommitLock();
    } catch (error) {
      if (!(error instanceof PersonalGlossaryRefreshCommitLockError)) throw error;
      const recovery = error.recovery;
      const currentGeneration = readCurrentGeneration(tiersDir);
      const projection = {
        status: "failed",
        reason: error.message,
        recovery,
      };
      const payload = {
        command: "stats refresh",
        status: "fail",
        exit_signal: null,
        privacy: {
          local_history_read: false,
          local_history_write: false,
          tier_write: false,
          projection_write: false,
          required_consent: "local-history",
          provided_consent: "local-history",
          historical_imports: args.importSources ?? [],
          historical_import_warning: args.importSources?.includes("claude") ? "Claude transcripts can contain secrets, file contents, and command output. Import is local and read-only." : null,
        },
        corpus_path: corpusPath,
        tier_path: tiersDir,
        evidence: {
          status: currentGeneration ? "readable" : "unavailable",
          ...(currentGeneration
            ? {
                generation: currentGeneration.manifest.generation,
                published_at: currentGeneration.manifest.published_at,
              }
            : {}),
        },
        projection,
        engine: { command: engineCommand, exit_code: null, stdout: [], stderr: [] },
      };
      if (outputFormat === "json") {
        out(JSON.stringify(payload, null, 2) + "\n");
      } else {
        out(`agentera stats refresh: fail\ncorpus=${corpusPath}\ntiers=${tiersDir}\n`);
        err(`candidate projection failed: ${projection.reason}\nRecovery: ${recovery}\n`);
      }
      return 1;
    }
    let engineOut = "";
    let engineErr = "";
    let rc: number;
    let projection: Record<string, unknown> = { status: "not_attempted" };
    let finalRc: number;
    let currentGeneration;
    try {
      rc = extractCorpusMain(engineArgv, {
        out: (t) => (engineOut += t + "\n"),
        err: (t) => (engineErr += t + "\n"),
      });
      finalRc = rc;
      currentGeneration = rc === 0 ? readCurrentGeneration(tiersDir) : null;
      if (rc === 0) {
        try {
          const produced = produceCurrentPersonalGlossaryProjection({ tiersDir });
          projection = { ...produced, write_status: produced.status, status: "published" };
        } catch (error) {
          finalRc = 1;
          projection = {
            status: "failed",
            reason: (error as Error).message,
            recovery: "npx -y agentera@next report refresh --consent local-history",
          };
        }
      }
    } finally {
      releasePersonalGlossaryRefreshCommitLock(refreshLock);
    }
    const refreshStatus = finalRc === 0 ? "pass" : rc === 4 ? "flagged" : "fail";
    const payload = {
      command: "stats refresh",
      status: refreshStatus,
      exit_signal: rc === 4 ? "EX2" : null,
      privacy: {
        local_history_read: true,
        local_history_write: false,
        tier_write: rc === 0,
        projection_write: projection.status === "published",
        required_consent: "local-history",
        provided_consent: "local-history",
        historical_imports: args.importSources ?? [],
        historical_import_warning: args.importSources?.includes("claude") ? "Claude transcripts can contain secrets, file contents, and command output. Import is local and read-only." : null,
      },
      corpus_path: corpusPath,
      tier_path: tiersDir,
      evidence: {
        status: rc === 0 ? "published" : "failed",
        ...(currentGeneration
          ? {
              generation: currentGeneration.manifest.generation,
              published_at: currentGeneration.manifest.published_at,
            }
          : {}),
      },
      projection,
      engine: {
        command: engineCommand,
        exit_code: rc,
        stdout: engineOut.split("\n").filter((l) => l),
        stderr: engineErr.split("\n").filter((l) => l),
      },
    };
    if (outputFormat === "json") {
      out(JSON.stringify(payload, null, 2) + "\n");
    } else {
      out(`agentera stats refresh: ${payload.status}\ncorpus=${corpusPath}\ntiers=${tiersDirForCorpusPath(corpusPath)}\n`);
      if (engineOut) out(engineOut);
      if (engineErr) err(engineErr);
      if (projection.status === "failed") {
        err(`candidate projection failed: ${String(projection.reason)}\nRecovery: ${String(projection.recovery)}\n`);
      }
    }
    return finalRc;
  }

  if (action !== null) {
    err(`Error: unsupported stats action '${action}'. ` + "Syntax: agentera stats [--format text|json] [--project VALUE] | agentera stats refresh --dry-run|--consent local-history\n");
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
  if (args.sources) engineArgs.push("--sources", args.sources);
  if (outputFormat === "json") engineArgs.push("--json");
  return usageMain(engineArgs, {
    out: (t) => out(t + "\n"),
    err: (t) => err(t + "\n"),
  });
}
