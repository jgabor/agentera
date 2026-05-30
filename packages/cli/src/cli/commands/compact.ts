import { resolvePath } from "../../core/paths.js";
import { runCompaction, CompactionOperation } from "../../hooks/compaction.js";
import { emitStructured } from "../structured.js";

/** Port of scripts/agentera cmd_compact and its _compaction_* helpers. */

type Dict = Record<string, any>;

function pyStr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return String(value);
}
type Io = { out?: (t: string) => void; err?: (t: string) => void };

export interface CompactArgs {
  project?: string | null;
  mode?: string;
  format?: string;
}

function compactionOperationPayload(op: CompactionOperation): Dict {
  const status = op.status;
  const payload: Dict = {
    artifact: status.artifact,
    path: status.path,
    exists: status.exists,
    classification: status.classification,
    active_count: status.active_count,
    archive_count: status.archive_count,
    total_count: status.total_count,
    over_limit_count: status.over_limit_count,
    protected_overflow_count: status.protected_overflow_count ?? 0,
    mode: op.mode,
    action: op.action,
    changed: op.changed,
    message: op.message,
    reason: status.reason,
  };
  if (op.result !== null) {
    payload.result = {
      active_before: op.result.full_before,
      archive_before: op.result.oneline_before,
      active_after: op.result.full_after,
      archive_after: op.result.oneline_after,
      dropped: op.result.dropped,
      changed: op.result.changed,
    };
  }
  return payload;
}

function compactionGuidance(mode: string, operations: CompactionOperation[]): string {
  const over = operations.filter((op) => op.action === "over_limit" || op.action === "pending_fix");
  const protectedOps = operations.filter((op) => op.action === "protected_overflow");
  const errors = operations.filter((op) => op.action === "error");
  const checkCommand = "uv run scripts/agentera compact --mode check --format json";
  const fixCommand = "uv run scripts/agentera compact --mode fix --format json";
  if (errors.length > 0) {
    return `Inspect the reported errors, repair invalid artifacts, then rerun \`${checkCommand}\`.`;
  }
  if (protectedOps.length > 0) {
    const artifacts = protectedOps.map((op) => op.status.artifact).join(", ");
    return (
      `Protected-overflow review pressure blocks compaction for: ${artifacts}. ` +
      "Resolve or explicitly confirm protected decision satisfaction before rerunning."
    );
  }
  if (mode === "check" && over.length > 0) {
    const artifacts = over.map((op) => op.status.artifact).join(", ");
    return `Over-limit compactable artifacts: ${artifacts}. ` + `Safe check: \`${checkCommand}\`. ` + `Safe fix: \`${fixCommand}\`.`;
  }
  if (mode === "fix" && over.length > 0) {
    return "Some artifacts remain over limit; inspect skipped or unsupported artifacts before manual remediation.";
  }
  return "No repair needed. Compactable artifacts are within uniform_10_40_50 limits.";
}

function compactionSummary(mode: string, operations: CompactionOperation[]): Dict {
  const counts: Record<string, number> = {};
  for (const op of operations) counts[op.action] = (counts[op.action] ?? 0) + 1;
  const overLimit = operations.filter((op) => op.action === "over_limit" || op.action === "pending_fix").length;
  const protectedOverflow = operations.filter((op) => op.action === "protected_overflow").length;
  const errors = operations.filter((op) => op.action === "error").length;
  const changed = operations.filter((op) => op.changed).length;
  const status = errors || protectedOverflow || (mode === "check" && overLimit) ? "fail" : "pass";
  return {
    status,
    mode,
    artifact_count: operations.length,
    over_limit_count: overLimit,
    protected_overflow_count: protectedOverflow,
    error_count: errors,
    changed_count: changed,
    action_counts: counts,
    guidance: compactionGuidance(mode, operations),
  };
}

function compactionExitCode(mode: string, operations: CompactionOperation[]): number {
  if (operations.some((op) => op.action === "error")) return 2;
  if (operations.some((op) => op.action === "protected_overflow")) return 1;
  if (mode === "check" && operations.some((op) => op.action === "over_limit")) return 1;
  return 0;
}

function compactionPayload(command: string, project: string, mode: string, operations: CompactionOperation[]): Dict {
  const summary = compactionSummary(mode, operations);
  return {
    command,
    status: summary.status,
    project,
    summary,
    operations: operations.map((op) => compactionOperationPayload(op)),
  };
}

function emitCompactionPayload(payload: Dict, mode: string, format: string, out: (t: string) => void): void {
  const summary = payload.summary as Dict;
  const project = payload.project;
  if (format === "json") {
    emitStructured(payload, "json", out);
    return;
  }
  out(`status=${summary.status} | mode=${mode} | project=${project}\n`);
  out(
    "counts=" +
      `artifacts:${summary.artifact_count} ` +
      `over_limit:${summary.over_limit_count} ` +
      `protected_overflow:${summary.protected_overflow_count} ` +
      `errors:${summary.error_count} ` +
      `changed:${summary.changed_count}\n`,
  );
  for (const item of payload.operations as Dict[]) {
    out(
      `- artifact=${item.artifact} | action=${item.action} | ` +
        `classification=${item.classification} | path=${item.path} | ` +
        `active=${pyStr(item.active_count)} | archive=${pyStr(item.archive_count)} | ` +
        `total=${pyStr(item.total_count)} | over=${pyStr(item.over_limit_count)} | ` +
        `protected_overflow=${item.protected_overflow_count} | ` +
        `message=${item.message}\n`,
    );
  }
  out(`guidance=${summary.guidance}\n`);
}

export function cmdCompact(args: CompactArgs, io: Io = {}): number {
  const out = io.out ?? ((t: string) => process.stdout.write(t));
  const mode = args.mode ?? "check";
  const project = resolvePath(args.project ?? process.cwd());
  const operations = runCompaction(project, mode);
  const payload = compactionPayload("compact", project, mode, operations);
  emitCompactionPayload(payload, mode, args.format ?? "text", out);
  return compactionExitCode(mode, operations);
}
