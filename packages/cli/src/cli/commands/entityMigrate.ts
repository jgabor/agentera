import path from "node:path";

import { emitStructured } from "../structured.js";
import type { Io } from "../dispatch/shared.js";
import { resolveSourceRoot } from "../../core/sourceRoot.js";
import { EntityMigrationContinuationError, previewEntityMigration } from "../../state/entityMigrationPreview.js";

type Format = "text" | "json" | "yaml";

interface Args {
  project: string;
  limit?: number;
  after?: string;
  dryRun: boolean;
  sourceFingerprint?: string;
  previewDigest?: string;
  format: Format;
}

const SYNTAX = "agentera state migrate entities [--project PATH] [--after SOURCE_IDENTITY --source-fingerprint SHA256 --preview-digest SHA256] [--limit N] --dry-run [--format {text,json,yaml}]";

export function entityMigrateHelp(): string {
  return [
    `usage: ${SYNTAX}`,
    "",
    "Inventory the complete Decision 94 entity migration graph without writing state.",
    "Entity publication is available only through one full development-channel upgrade --yes.",
    "",
    "options:",
    "  -h, --help                 Show this dedicated help message and exit",
    "  --project PATH             Existing real project directory to inventory",
    "  --after SOURCE_IDENTITY --source-fingerprint SHA256 --preview-digest SHA256",
    "                              Continue the bound snapshot from a prior page",
    "  --limit 1..1000            Bound logical identities returned on one preview page (default 100)",
    "  --dry-run                  Read-only inventory and preview",
    "  --format {text,json,yaml}  Output format (default text)",
  ].join("\n");
}

function parse(argv: string[], cwd: string): Args | string {
  const args: Args = { project: cwd, dryRun: false, format: "text" };
  const values = new Map([
    ["--project", "project"], ["--after", "after"], ["--limit", "limit"], ["--source-fingerprint", "sourceFingerprint"], ["--preview-digest", "previewDigest"], ["--format", "format"],
  ] as const);
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--dry-run") {
      if (seen.has(token)) return `${token} may only be supplied once`;
      seen.add(token);
      args.dryRun = true;
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
  if (!args.dryRun) return "--dry-run is required; entity apply is owned by one full development-channel upgrade --yes";
  if (args.after && (!/^[a-f0-9]{64}$/.test(args.sourceFingerprint ?? "") || !/^[a-f0-9]{64}$/.test(args.previewDigest ?? ""))) return "--after requires the prior page's --source-fingerprint SHA256 and --preview-digest SHA256";
  if (!args.after && (args.sourceFingerprint || args.previewDigest)) return "--source-fingerprint and --preview-digest are only valid with --after";
  return args;
}

function output(value: Record<string, unknown>, format: Format, io: Io): void {
  const out = io.out ?? ((text: string) => process.stdout.write(text));
  if (format !== "text") {
    emitStructured(value, format, out);
    return;
  }
  const counts = value.counts as Record<string, number> | undefined;
  const error = value.error as Record<string, unknown> | undefined;
  const diagnostics = Array.isArray(value.diagnostics) ? value.diagnostics as Array<Record<string, unknown>> : [];
  const classes = counts ? ["verified_full", "recoverable_degraded_full_projection", "valid_compacted_summary", "duplicate", "conflict", "corrupt", "unsupported"].map((name) => `${name}=${counts[name] ?? 0}`).join(", ") : "unavailable";
  const sink = error ? io.err ?? ((text: string) => process.stderr.write(text)) : out;
  sink([
    `status: ${String(value.status)}`,
    `command: ${String(value.command)}`,
    `classes: ${classes}`,
    `physical_records: ${counts?.physical_records ?? "unavailable"}; logical_identities: ${counts?.logical_identities ?? "unavailable"}; mirrors: ${counts?.mirrors ?? "unavailable"}; duplicates: ${counts?.duplicates ?? "unavailable"}; conflicts: ${counts?.conflicts ?? "unavailable"}`,
    `relationships: ${counts?.relationships ?? "unavailable"}; unresolved_relationships: ${counts?.unresolved_relationships ?? "unavailable"}; root_blockers: ${counts?.root_blockers ?? "unavailable"}; dependent_blockers: ${counts?.dependent_blockers ?? "unavailable"}; blockers: ${counts?.blockers ?? "unavailable"}`,
    `omission: omitted=${String(value.omitted ?? false)}, entries=${String(value.omitted_count ?? 0)}, diagnostics=${String(value.diagnostics_omitted_count ?? 0)}, reason=${String(value.omission_reason ?? "none")}`,
    `source_fingerprint: ${String(value.source_fingerprint ?? "unavailable")}`,
    `preview_digest: ${String(value.preview_digest ?? "unavailable")}`,
    ...diagnostics.map((diagnostic) => [
      `blocker ${String(diagnostic.classification)} ${String(diagnostic.source_identity)}`,
      diagnostic.root_source_identity === undefined ? "" : ` root_source_identity=${String(diagnostic.root_source_identity)}`,
      `: ${String(diagnostic.message)}; recovery: ${String(diagnostic.recovery)}`,
    ].join("")),
    `recovery: ${String(error?.recovery ?? (value.retrieval as Record<string, unknown> | undefined)?.command ?? "none")}`,
    "",
  ].join("\n"));
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
  try {
    const preview = previewEntityMigration(path.resolve(parsed.project), sourceRoot, { limit: parsed.limit, after: parsed.after, sourceFingerprint: parsed.sourceFingerprint, previewDigest: parsed.previewDigest });
    output(preview as unknown as Record<string, unknown>, parsed.format, io);
    return preview.status === "ready" ? 0 : 1;
  } catch (error) {
    const continuation = error instanceof EntityMigrationContinuationError;
    const body = { schemaVersion: "agentera.entityMigrationFailure.v1", command: "state migrate entities", status: "fail", read_only: true, mutation_performed: false, error: { class: continuation ? error.classification : "inventory_failed", message: (error as Error).message, recovery: continuation ? error.restartCommand : "Choose an existing, real directory inside the intended checkout, repair the reported source, then rerun agentera state migrate entities --project PATH --dry-run --format json; no state was changed." } };
    output(body, parsed.format, io);
    return 1;
  }
}
