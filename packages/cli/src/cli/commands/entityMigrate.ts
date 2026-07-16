import path from "node:path";

import { emitStructured } from "../structured.js";
import type { Io } from "../dispatch/shared.js";
import { resolveSourceRoot } from "../../core/sourceRoot.js";
import {
  EntityMigrationBindingError,
  assertEntityMigrationBinding,
  previewEntityMigration,
} from "../../state/entityMigrationPreview.js";

type Format = "text" | "json" | "yaml";

interface Args {
  project: string;
  limit?: number;
  after?: string;
  dryRun: boolean;
  apply: boolean;
  force: boolean;
  sourceFingerprint?: string;
  previewDigest?: string;
  format: Format;
}

const SYNTAX = "agentera state migrate entities [--project PATH] [--after SOURCE_IDENTITY] [--limit 1..1000] --dry-run [--format {text,json,yaml}]";

export function entityMigrateHelp(): string {
  return [
    `usage: ${SYNTAX}`,
    "       agentera state migrate entities --project PATH --apply --force --source-fingerprint SHA256 --preview-digest SHA256 [--format {text,json,yaml}]",
    "",
    "Inventory the complete Decision 94 entity migration graph without writing state.",
    "",
    "options:",
    "  -h, --help                 Show this dedicated help message and exit",
    "  --project PATH             Existing real project directory to inventory",
    "  --after SOURCE_IDENTITY    Continue after the last identity returned by the prior page",
    "  --limit 1..1000            Bound logical identities returned on one preview page (default 100)",
    "  --dry-run                  Read-only inventory and preview",
    "  --apply --force            Binding preflight only; durable apply is not implemented",
    "  --source-fingerprint SHA256  Approved project-source fingerprint",
    "  --preview-digest SHA256      Approved inventory and migration-authority digest",
    "  --format {text,json,yaml}    Output format (default text)",
  ].join("\n");
}

function parse(argv: string[], cwd: string): Args | string {
  const args: Args = { project: cwd, dryRun: false, apply: false, force: false, format: "text" };
  const values = new Map([
    ["--project", "project"], ["--after", "after"], ["--limit", "limit"], ["--source-fingerprint", "sourceFingerprint"], ["--preview-digest", "previewDigest"], ["--format", "format"],
  ] as const);
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--dry-run" || token === "--apply" || token === "--force") {
      if (seen.has(token)) return `${token} may only be supplied once`;
      seen.add(token);
      if (token === "--dry-run") args.dryRun = true;
      if (token === "--apply") args.apply = true;
      if (token === "--force") args.force = true;
      continue;
    }
    const pair = [...values].find(([flag]) => token === flag || token.startsWith(`${flag}=`));
    if (!pair) return `unrecognized argument '${token}'`;
    const [flag, field] = pair;
    if (seen.has(flag)) return `${flag} may only be supplied once`;
    seen.add(flag);
    const value = token.startsWith(`${flag}=`) ? token.slice(flag.length + 1) : argv[++index];
    if (!value || value.startsWith("--")) return `${flag} requires a value`;
    if (field === "limit") {
      if (!/^[1-9][0-9]*$/.test(value) || Number(value) > 1000) return "--limit must be between 1 and 1000";
      args.limit = Number(value);
    } else if (field === "format") {
      if (!(["text", "json", "yaml"] as string[]).includes(value)) return "--format must be text, json, or yaml";
      args.format = value as Format;
    } else if (field === "project") args.project = value;
    else if (field === "after") args.after = value;
    else if (field === "sourceFingerprint") args.sourceFingerprint = value;
    else args.previewDigest = value;
  }
  if (args.dryRun === args.apply) return "choose exactly one of --dry-run or --apply";
  if (args.apply && !args.force) return "--apply requires --force";
  if (args.force && !args.apply) return "--force requires --apply";
  if (args.after && args.apply) return "--after is only valid with --dry-run";
  if (args.apply && (!/^[a-f0-9]{64}$/.test(args.sourceFingerprint ?? "") || !/^[a-f0-9]{64}$/.test(args.previewDigest ?? ""))) return "--apply requires --source-fingerprint SHA256 and --preview-digest SHA256";
  return args;
}

function output(value: Record<string, unknown>, format: Format, io: Io): void {
  const out = io.out ?? ((text: string) => process.stdout.write(text));
  if (format === "text") {
    const counts = value.counts as Record<string, number> | undefined;
    const error = value.error as Record<string, unknown> | undefined;
    const diagnostics = Array.isArray(value.diagnostics) ? value.diagnostics as Array<Record<string, unknown>> : [];
    const classes = counts ? ["verified_full", "recoverable_degraded_full_projection", "irrecoverable_summary_only", "duplicate", "conflict", "corrupt", "unsupported"].map((name) => `${name}=${counts[name] ?? 0}`).join(", ") : "unavailable";
    out([
      `status: ${String(value.status)}`,
      `command: ${String(value.command)}`,
      `classes: ${classes}`,
      `physical_records: ${counts?.physical_records ?? "unavailable"}; logical_identities: ${counts?.logical_identities ?? "unavailable"}; mirrors: ${counts?.mirrors ?? "unavailable"}; duplicates: ${counts?.duplicates ?? "unavailable"}; conflicts: ${counts?.conflicts ?? "unavailable"}`,
      `relationships: ${counts?.relationships ?? "unavailable"}; unresolved_relationships: ${counts?.unresolved_relationships ?? "unavailable"}; blockers: ${counts?.blockers ?? "unavailable"}`,
      `omission: omitted=${String(value.omitted ?? false)}, entries=${String(value.omitted_count ?? 0)}, diagnostics=${String(value.diagnostics_omitted_count ?? 0)}, reason=${String(value.omission_reason ?? "none")}`,
      `source_fingerprint: ${String(value.source_fingerprint ?? "unavailable")}`,
      `preview_digest: ${String(value.preview_digest ?? "unavailable")}`,
      ...diagnostics.map((diagnostic) => `blocker ${String(diagnostic.classification)} ${String(diagnostic.source_identity)}: ${String(diagnostic.recovery)}`),
      `recovery: ${String(error?.recovery ?? (value.retrieval as Record<string, unknown> | undefined)?.command ?? "none")}`,
      "",
    ].join("\n"));
  }
  else emitStructured(value, format, out);
}

export function runEntityMigrate(argv: string[], io: Io, cwd = process.cwd(), sourceRoot = resolveSourceRoot()): number {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    (io.out ?? ((text: string) => process.stdout.write(text)))(`${entityMigrateHelp()}\n`);
    return 0;
  }
  const parsed = parse(argv, cwd);
  const requested = argv.includes("--format") ? argv[argv.indexOf("--format") + 1] : argv.find((item) => item.startsWith("--format="))?.slice(9);
  const format: Format = requested === "json" || requested === "yaml" ? requested : "text";
  if (typeof parsed === "string") {
    const body = { schemaVersion: "agentera.invalidInputEnvelope.v2", command: "state migrate entities", status: "fail", error: { class: "invalid_request", message: parsed, syntax: SYNTAX, example: "agentera state migrate entities --dry-run --format json", recovery: "Correct the command and retry; no state was changed." } };
    if (format === "text") (io.err ?? ((text: string) => process.stderr.write(text)))(`${parsed}\nSyntax: ${SYNTAX}\n`);
    else output(body, format, io);
    return 2;
  }
  let preview;
  try {
    preview = previewEntityMigration(path.resolve(parsed.project), sourceRoot, { limit: parsed.limit, after: parsed.after });
  } catch (error) {
    const body = { schemaVersion: "agentera.entityMigrationFailure.v1", command: "state migrate entities", status: "fail", read_only: true, mutation_performed: false, error: { class: "inventory_failed", message: (error as Error).message, recovery: "Choose an existing, real directory inside the intended checkout, repair any reported source, then rerun agentera state migrate entities --project PATH --dry-run --format json; no state was changed." } };
    output(body, parsed.format, io);
    return 1;
  }
  if (parsed.dryRun) {
    output(preview as unknown as Record<string, unknown>, parsed.format, io);
    return preview.status === "ready" ? 0 : 1;
  }
  try {
    return assertEntityMigrationBinding(parsed.sourceFingerprint as string, parsed.previewDigest as string, preview, () => {
      output({ ...preview, status: "blocked", mode: "apply_preflight", read_only: true, mutation_intent: true, mutation_performed: false, error: { class: "apply_not_implemented", message: "Entity migration apply is Task 10 and is not implemented.", recovery: "Keep this preview evidence and complete Task 10 before requesting apply." } }, parsed.format, io);
      return 1;
    });
  } catch (error) {
    if (!(error instanceof EntityMigrationBindingError)) throw error;
    output({ ...preview, status: "blocked", mode: "apply_preflight", read_only: true, mutation_intent: true, mutation_performed: false, error: { class: error.classification, message: error.message, recovery: preview.retrieval.command } }, parsed.format, io);
    return 1;
  }
}
