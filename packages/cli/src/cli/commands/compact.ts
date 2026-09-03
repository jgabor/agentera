import fs from "node:fs";
import path from "node:path";

import YAML, { isMap, isScalar, isSeq } from "yaml";

import { resolvePath } from "../../core/paths.js";
import { runCompaction, CompactionOperation } from "../../hooks/compaction/index.js";
import { emitStructured } from "../structured.js";
import type { JsonObject } from "../../core/jsonValue.js";
import { boundStructuredProjection } from "../../state/projectionPolicy.js";

/** Port of scripts/agentera cmd_compact and its _compaction_* helpers. */

// Locally-typed payload shape for compaction output (typed construction;
// JsonObject remains the canonical JSON-shape source of truth).
interface CompactionSummary {
  status: string;
  mode: string;
  artifact_count: number;
  over_limit_count: number;
  formatting_count: number;
  protected_overflow_count: number;
  projection_count: number;
  error_count: number;
  changed_count: number;
  action_counts: Record<string, number>;
  guidance: string;
}

interface CompactionPayload {
  command: string;
  status: string;
  project: string;
  summary: CompactionSummary;
  operations: JsonObject[];
}

const TODO_REFERENCE_DIAGNOSTIC_LIMIT = 20;

interface TodoReferenceDiagnostic {
  path: string;
  reference: string;
}

interface TodoReferenceMatch extends TodoReferenceDiagnostic {
  order: number;
}

interface GateCompactionOperation extends CompactionOperation {
  diagnostics?: TodoReferenceDiagnostic[];
  omitted_count?: number;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isDirectory(directory: string): boolean {
  try {
    const stat = fs.lstatSync(directory);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function yamlFilesBelow(directory: string): string[] {
  if (!isDirectory(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => compareText(left.name, right.name))
    .flatMap((entry) => {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) return yamlFilesBelow(candidate);
      return entry.isFile() && path.extname(entry.name) === ".yaml" ? [candidate] : [];
    });
}

function activeStateYamlFiles(project: string): string[] {
  const stateRoot = path.join(project, ".agentera");
  if (!isDirectory(stateRoot)) return [];
  const topLevel = fs
    .readdirSync(stateRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && path.extname(entry.name) === ".yaml")
    .map((entry) => path.join(stateRoot, entry.name));
  return [...topLevel, ...yamlFilesBelow(path.join(stateRoot, "entities"))].sort(compareText);
}

function stringScalarValues(node: unknown): string[] {
  if (isScalar(node)) return typeof node.value === "string" ? [node.value] : [];
  if (isMap(node)) return node.items.flatMap((pair) => stringScalarValues(pair.value));
  if (isSeq(node)) return node.items.flatMap(stringScalarValues);
  return [];
}

function volatileTodoReferenceDiagnostics(project: string): {
  diagnostics: TodoReferenceDiagnostic[];
  omitted_count: number;
} {
  const matches: TodoReferenceMatch[] = [];
  for (const file of activeStateYamlFiles(project)) {
    const relativePath = path.relative(project, file).split(path.sep).join("/");
    const contents = fs.readFileSync(file, "utf8");
    let order = 0;
    for (const document of YAML.parseAllDocuments(contents)) {
      for (const value of stringScalarValues(document.contents)) {
        for (const match of value.matchAll(/TODO line \d+|TODO\.md:\d+/g)) {
          matches.push({ path: relativePath, reference: match[0], order: order++ });
        }
      }
    }
  }
  matches.sort((left, right) => compareText(left.path, right.path) || left.order - right.order);
  return {
    diagnostics: matches.slice(0, TODO_REFERENCE_DIAGNOSTIC_LIMIT).map(({ path, reference }) => ({ path, reference })),
    omitted_count: Math.max(0, matches.length - TODO_REFERENCE_DIAGNOSTIC_LIMIT),
  };
}

function volatileTodoReferenceGate(project: string, mode: string): GateCompactionOperation | null {
  const { diagnostics, omitted_count } = volatileTodoReferenceDiagnostics(project);
  if (!diagnostics.length) return null;
  const count = diagnostics.length + omitted_count;
  return {
    status: {
      artifact: "state_todo_references",
      path: path.join(project, ".agentera"),
      classification: "hygiene",
      active_count: count,
      archive_count: 0,
      total_count: count,
      over_limit_count: 0,
      protected_overflow_count: 0,
      exists: true,
      reason: `${count} active state TODO reference${count === 1 ? "" : "s"} use volatile line syntax`,
    },
    mode,
    action: "volatile_todo_reference",
    changed: false,
    result: null,
    message: "replace TODO line references with stable TODO anchors",
    diagnostics,
    omitted_count,
  };
}

function gatedCompactionOperations(project: string, mode: string): GateCompactionOperation[] {
  const hygiene = volatileTodoReferenceGate(project, mode);
  if (mode === "fix" && hygiene) return [hygiene];
  const operations = runCompaction(project, mode);
  return hygiene ? [...operations, hygiene] : operations;
}

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

function compactionOperationPayload(op: GateCompactionOperation): JsonObject {
  const status = op.status;
  const payload: JsonObject = {
    artifact: status.artifact,
    path: status.path,
    exists: status.exists,
    classification: status.classification,
    active_count: status.active_count,
    archive_count: status.archive_count,
    total_count: status.total_count,
    over_limit_count: status.over_limit_count,
    ...(status.pending_summarization_count !== undefined ? { pending_summarization_count: status.pending_summarization_count } : {}),
    ...(status.projection_state ? { projection_state: status.projection_state } : {}),
    protected_overflow_count: status.protected_overflow_count ?? 0,
    mode: op.mode,
    action: op.action,
    changed: op.changed,
    message: op.message,
    reason: status.reason,
    ...(status.projection_recovery ? { recovery: status.projection_recovery as unknown as JsonObject } : {}),
    ...(op.diagnostics
      ? {
          diagnostics: op.diagnostics.map(({ path, reference }) => ({ path, reference })),
          omitted_count: op.omitted_count ?? 0,
        }
      : {}),
  };
  if (op.result !== null) {
    const recovery = op.result.recovery as unknown as JsonObject | undefined;
    payload.result = {
      active_before: op.result.full_before,
      archive_before: op.result.oneline_before,
      active_after: op.result.full_after,
      archive_after: op.result.oneline_after,
      dropped: op.result.dropped,
      omitted_count: op.result.omitted_count ?? 0,
      ...(op.result.omission_reason ? { omission_reason: op.result.omission_reason } : {}),
      changed: op.result.changed,
      ...(recovery ? { recovery } : {}),
    };
  }
  return payload;
}

function compactionGuidance(mode: string, operations: GateCompactionOperation[]): string {
  const over = operations.filter((op) => op.action === "over_limit" || op.action === "pending_fix");
  const projections = operations.filter((op) => op.action === "projection" || op.action === "pending_projection");
  const formatting = operations.filter((op) => op.action === "formatting" || op.action === "pending_formatting");
  const protectedOps = operations.filter((op) => op.action === "protected_overflow");
  const errors = operations.filter((op) => op.action === "error");
  const refused = operations.filter((op) => op.action === "refused");
  const volatileTodoReferences = operations.filter((op) => op.action === "volatile_todo_reference");
  const checkCommand = "npx -y agentera check compact --mode check";
  const fixCommand = "npx -y agentera check compact --mode fix";
  if (errors.length > 0) {
    return `Inspect the reported errors, repair invalid artifacts, then rerun \`${checkCommand}\`.`;
  }
  if (volatileTodoReferences.length > 0) {
    return `Replace volatile TODO line references in active state with stable anchors, then rerun \`${checkCommand}\`.`;
  }
  if (refused.length > 0) {
    return "Projection changes were safely refused until each full entry has a verified numbered archive; inspect recovery metadata and retry after recovery.";
  }
  if (protectedOps.length > 0) {
    const artifacts = protectedOps.map((op) => op.status.artifact).join(", ");
    return `Protected-overflow review pressure blocks compaction for: ${artifacts}. ` + "Resolve or explicitly confirm protected decision satisfaction before rerunning.";
  }
  if (mode === "check" && over.length > 0) {
    const artifacts = over.map((op) => op.status.artifact).join(", ");
    return `Over-limit compactable artifacts: ${artifacts}. ` + `Safe check: \`${checkCommand}\`. ` + `Safe fix: \`${fixCommand}\`.`;
  }
  if (mode === "fix" && over.length > 0) {
    return "Some artifacts remain over limit; inspect skipped or unsupported artifacts before manual remediation.";
  }
  if (formatting.length > 0) {
    const artifacts = formatting.map((op) => op.status.artifact).join(", ");
    return mode === "check" ? `Summary formatting is pending for: ${artifacts}. Safe fix: \`${fixCommand}\`.` : `Summary formatting remains pending for: ${artifacts}; inspect the artifact diagnostics.`;
  }
  if (projections.length > 0) {
    return "Projection defaults are bounded; numbered archive records remain complete and authoritative.";
  }
  return "No repair needed. Compactable artifacts are within the configured projection defaults.";
}

function compactionSummary(mode: string, operations: GateCompactionOperation[]): CompactionSummary {
  const counts: Record<string, number> = {};
  for (const op of operations) counts[op.action] = (counts[op.action] ?? 0) + 1;
  const overLimit = operations.filter((op) => op.action === "over_limit" || op.action === "pending_fix").length;
  const projections = operations.filter((op) => op.action === "projection" || op.action === "pending_projection").length;
  const formatting = operations.filter((op) => op.action === "formatting" || op.action === "pending_formatting").length;
  const protectedOverflow = operations.filter((op) => op.action === "protected_overflow").length;
  const errors = operations.filter((op) => op.action === "error").length;
  const volatileTodoReferences = operations.filter((op) => op.action === "volatile_todo_reference").length;
  const changed = operations.filter((op) => op.changed).length;
  const status = errors || volatileTodoReferences || (mode === "check" && (overLimit || formatting)) ? "fail" : "pass";
  return {
    status,
    mode,
    artifact_count: operations.length,
    over_limit_count: overLimit,
    formatting_count: formatting,
    protected_overflow_count: protectedOverflow,
    projection_count: projections,
    error_count: errors,
    changed_count: changed,
    action_counts: counts,
    guidance: compactionGuidance(mode, operations),
  };
}

function compactionExitCode(mode: string, operations: GateCompactionOperation[]): number {
  if (operations.some((op) => op.action === "error")) return 2;
  if (operations.some((op) => op.action === "volatile_todo_reference")) return 1;
  if (mode === "check" && operations.some((op) => op.action === "over_limit" || op.action === "formatting")) return 1;
  return 0;
}

function compactionPayload(command: string, project: string, mode: string, operations: GateCompactionOperation[]): CompactionPayload {
  const summary = compactionSummary(mode, operations);
  return {
    command,
    status: summary.status,
    project,
    summary,
    operations: operations.map((op) => compactionOperationPayload(op)),
  };
}

function emitCompactionPayload(payload: CompactionPayload, mode: string, format: string, out: (t: string) => void): void {
  const summary = payload.summary;
  const project = payload.project;
  if (format === "json") {
    emitStructured(boundStructuredProjection(payload as unknown as JsonObject, "compact", "json"), "json", out);
    return;
  }
  out(`status=${summary.status} | mode=${mode} | project=${project}\n`);
  out("counts=" + `artifacts:${summary.artifact_count} ` + `over_limit:${summary.over_limit_count} ` + `formatting:${summary.formatting_count} ` + `protected_overflow:${summary.protected_overflow_count} ` + `errors:${summary.error_count} ` + `changed:${summary.changed_count}\n`);
  for (const item of payload.operations) {
    out(
      `- artifact=${item.artifact} | action=${item.action} | ` +
        `classification=${item.classification} | path=${item.path} | ` +
        `active=${pyStr(item.active_count)} | archive=${pyStr(item.archive_count)} | ` +
        `total=${pyStr(item.total_count)} | over=${pyStr(item.over_limit_count)} | ` +
        `pending_summarization=${pyStr(item.pending_summarization_count)} | ` +
        `protected_overflow=${item.protected_overflow_count} | ` +
        `message=${item.message}\n`,
    );
    if (Array.isArray(item.diagnostics)) {
      for (const diagnostic of item.diagnostics) {
        if (!diagnostic || typeof diagnostic !== "object" || Array.isArray(diagnostic)) continue;
        out(`  diagnostic=${String(diagnostic.path)}: ${String(diagnostic.reference)}\n`);
      }
      out(`  omitted_count=${pyStr(item.omitted_count)}\n`);
    }
  }
  out(`guidance=${summary.guidance}\n`);
}

export function cmdCompact(args: CompactArgs, io: Io = {}): number {
  const out = io.out ?? ((t: string) => process.stdout.write(t));
  const mode = args.mode ?? "check";
  const project = resolvePath(args.project ?? process.cwd());
  const operations = gatedCompactionOperations(project, mode);
  const payload = compactionPayload("check compact", project, mode, operations);
  emitCompactionPayload(payload, mode, args.format ?? "text", out);
  return compactionExitCode(mode, operations);
}

export function cmdGate(args: CompactArgs, io: Io = {}): number {
  const out = io.out ?? ((t: string) => process.stdout.write(t));
  const project = resolvePath(args.project ?? process.cwd());
  const operations = gatedCompactionOperations(project, "check");
  const payload = compactionPayload("check compact", project, "check", operations);
  emitCompactionPayload(payload, "check", args.format ?? "text", out);
  return compactionExitCode("check", operations);
}
