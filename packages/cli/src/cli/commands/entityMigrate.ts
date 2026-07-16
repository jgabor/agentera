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
  dryRun: boolean;
  apply: boolean;
  force: boolean;
  sourceFingerprint?: string;
  previewDigest?: string;
  format: Format;
}

const SYNTAX = "agentera state migrate entities [--project PATH] [--limit 1..1000] --dry-run --format {text,json,yaml}";

function parse(argv: string[], cwd: string): Args | string {
  const args: Args = { project: cwd, dryRun: false, apply: false, force: false, format: "text" };
  const values = new Map([
    ["--project", "project"], ["--limit", "limit"], ["--source-fingerprint", "sourceFingerprint"], ["--preview-digest", "previewDigest"], ["--format", "format"],
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
    else if (field === "sourceFingerprint") args.sourceFingerprint = value;
    else args.previewDigest = value;
  }
  if (args.dryRun === args.apply) return "choose exactly one of --dry-run or --apply";
  if (args.apply && !args.force) return "--apply requires --force";
  if (args.force && !args.apply) return "--force requires --apply";
  if (args.apply && (!/^[a-f0-9]{64}$/.test(args.sourceFingerprint ?? "") || !/^[a-f0-9]{64}$/.test(args.previewDigest ?? ""))) return "--apply requires --source-fingerprint SHA256 and --preview-digest SHA256";
  return args;
}

function output(value: Record<string, unknown>, format: Format, io: Io): void {
  const out = io.out ?? ((text: string) => process.stdout.write(text));
  if (format === "text") out(`${value.status}: ${value.command}\nsource_fingerprint: ${value.source_fingerprint ?? "unavailable"}\npreview_digest: ${value.preview_digest ?? "unavailable"}\n`);
  else emitStructured(value, format, out);
}

export function runEntityMigrate(argv: string[], io: Io, cwd = process.cwd(), sourceRoot = resolveSourceRoot()): number {
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
    preview = previewEntityMigration(path.resolve(parsed.project), sourceRoot, { limit: parsed.limit });
  } catch (error) {
    const body = { schemaVersion: "agentera.entityMigrationFailure.v1", command: "state migrate entities", status: "fail", read_only: true, mutation_performed: false, error: { class: "inventory_failed", message: (error as Error).message, recovery: "Repair the reported project boundary or source and rerun the dry-run; no state was changed." } };
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
