import path from "node:path";

import { emitInvalidInput, type InvalidInputErrorBody } from "../errors.js";
import { emitStructured } from "../structured.js";
import type { Io } from "../dispatch/shared.js";
import { resolveSourceRoot } from "../../core/sourceRoot.js";
import {
  stateMigrationContract,
  type StateMigrationContract,
} from "../../state/migrationAuthority.js";

const MIGRATE_SYNTAX =
  "agentera state migrate [--project PATH] [--artifact ARTIFACT] [--number N] [--path PATH] [--limit N] [--dry-run|--apply --force] --format {text,json,yaml}";

export type MigrateFormat = "text" | "json" | "yaml";

export interface MigrateArgs {
  project: string | null;
  artifact: string | null;
  number?: number;
  path?: string | null;
  limit?: number;
  dryRun: boolean;
  apply: boolean;
  force: boolean;
  format: MigrateFormat;
}

function requestedFormat(argv: string[]): MigrateFormat {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--format") {
      const value = argv[index + 1];
      if (value === "json" || value === "yaml") return value;
    }
    if (argv[index].startsWith("--format=")) {
      const value = argv[index].slice("--format=".length);
      if (value === "json" || value === "yaml") return value;
    }
  }
  return "text";
}

function parsePositiveInteger(flag: string, value: string): number | string {
  if (!/^[1-9][0-9]*$/.test(value)) return `argument ${flag}: invalid int value: '${value}'`;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : `argument ${flag}: invalid int value: '${value}'`;
}

function candidatePathError(candidate: string): string | null {
  if (
    candidate.includes("\0") ||
    candidate.includes("\\") ||
    path.isAbsolute(candidate) ||
    path.win32.isAbsolute(candidate)
  ) {
    return "candidate path violates the project boundary: use a project-local relative path";
  }
  let decoded = candidate;
  try {
    decoded = decodeURIComponent(candidate);
  } catch {
    return "candidate path contains invalid percent encoding";
  }
  const normalized = decoded.replaceAll("\\", "/");
  const parts = normalized.split("/").filter((part) => part !== "" && part !== ".");
  if (
    parts.some((part) => part === "..") ||
    decoded.includes("://") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(decoded)
  ) {
    return "candidate path violates the project boundary: traversal and URI paths are forbidden";
  }
  if (parts.length === 0 || parts.length > 2 || (parts.length === 2 && parts[0] !== ".agentera")) {
    return "candidate path must be a direct project file or a direct .agentera file";
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(md|yaml|yml)$/.test(parts[parts.length - 1])) {
    return "candidate path is unsupported: use an ASCII .md, .yaml, or .yml candidate";
  }
  return null;
}

export function parseMigrateArgs(argv: string[]): MigrateArgs | { error: string } {
  const args: MigrateArgs = {
    project: null,
    artifact: null,
    dryRun: false,
    apply: false,
    force: false,
    format: "text",
  };
  const valueFlags = ["--project", "--artifact", "--number", "--path", "--limit", "--format"];
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const flag = valueFlags.find(
      (candidate) => token === candidate || token.startsWith(`${candidate}=`),
    );
    if (flag) {
      if (seen.has(flag)) return { error: `${flag} may only be supplied once` };
      seen.add(flag);
      const inline = token.startsWith(`${flag}=`);
      const value = inline ? token.slice(flag.length + 1) : argv[++index];
      if (value === undefined || value === "" || (!inline && value.startsWith("--"))) {
        return { error: `argument ${flag}: expected a value` };
      }
      if (flag === "--project") args.project = value;
      else if (flag === "--artifact") args.artifact = value;
      else if (flag === "--path") args.path = value;
      else if (flag === "--format") {
        if (value !== "text" && value !== "json" && value !== "yaml") {
          return {
            error: `argument --format: invalid choice: '${value}' (choose from 'text', 'json', 'yaml')`,
          };
        }
        args.format = value;
      } else {
        const parsed = parsePositiveInteger(flag, value);
        if (typeof parsed === "string") return { error: parsed };
        if (flag === "--number") args.number = parsed;
        else args.limit = parsed;
      }
    } else if (token === "--dry-run") {
      if (args.dryRun) return { error: "--dry-run may only be supplied once" };
      args.dryRun = true;
    } else if (token === "--apply") {
      if (args.apply) return { error: "--apply may only be supplied once" };
      args.apply = true;
    } else if (token === "--force") {
      if (args.force) return { error: "--force may only be supplied once" };
      args.force = true;
    } else {
      return { error: `unrecognized arguments: ${token}` };
    }
  }
  return args;
}

export function validateMigrateArgs(
  args: MigrateArgs,
  contract: StateMigrationContract,
): string | null {
  if (args.artifact && !contract.supportedArtifacts.includes(args.artifact)) {
    return `unsupported artifact '${args.artifact}'`;
  }
  if (args.number !== undefined && !args.artifact) return "argument --number requires --artifact";
  if (args.limit !== undefined && (args.limit < 1 || args.limit > contract.maximumLimit)) {
    return `argument --limit must be between 1 and ${contract.maximumLimit}`;
  }
  if (args.path) {
    const pathError = candidatePathError(args.path);
    if (pathError) return pathError;
  }
  if (args.apply && args.dryRun) return "--apply and --dry-run are mutually exclusive";
  if (args.apply && !args.force) return "--apply requires explicit --force intent";
  if (args.force && !args.apply) return "--force requires --apply";
  if (args.apply && (args.artifact === null || args.number === undefined)) {
    return "--apply requires exactly one --artifact and --number selector";
  }
  return null;
}

function invalid(
  message: string,
  format: MigrateFormat,
  validValues?: string[],
): { format: "text" | "json"; body: InvalidInputErrorBody } {
  return {
    format: format === "yaml" ? "text" : format,
    body: {
      class: message.startsWith("unsupported artifact") ? "invalid_choice" : "invalid_request",
      message,
      syntax: MIGRATE_SYNTAX,
      example: "agentera state migrate --artifact progress --number 1 --dry-run --format json",
      ...(validValues ? { valid_values: validValues } : {}),
    },
  };
}

function deferredResponse(
  args: MigrateArgs,
  contract: StateMigrationContract,
): Record<string, unknown> {
  const mode = args.apply ? "apply" : args.dryRun ? "preview" : "inventory";
  return {
    schemaVersion: "agentera.stateMigrationResult.v1",
    command: contract.command,
    status: "unavailable",
    mode,
    project: args.project ?? process.cwd(),
    read_only: !args.apply,
    mutation_intent: args.apply,
    mutation_performed: false,
    remote_contact: false,
    inventory_performed: false,
    entries: [],
    counts: {
      physical: null,
      addressable: null,
      addressable_ids: null,
      unaddressable: null,
      ambiguous: null,
      mirrored: null,
      duplicate: null,
      conflict: null,
      omitted: 0,
    },
    diagnostics: [
      {
        class: "implementation_deferred",
        message:
          "Local migration inventory and mutation execution are not part of this authority publication; no state was changed.",
      },
    ],
    source_contract: {
      authority: contract.authorityPath,
      schema_version: "agentera.stateStorageAuthority.v1",
      execution: "authority_and_dispatch_only",
      git_required: false,
      remote_contact: "forbidden",
    },
  };
}

function renderText(response: Record<string, unknown>, out: (text: string) => void): void {
  const diagnostics = response.diagnostics as Array<{ message: string }>;
  out(
    [
      `command: ${response.command}`,
      `status: ${response.status}`,
      `mode: ${response.mode}`,
      `project: ${response.project}`,
      `read_only: ${response.read_only}`,
      `mutation_intent: ${response.mutation_intent}`,
      `remote_contact: ${response.remote_contact}`,
      `diagnostic: ${diagnostics[0]?.message ?? "none"}`,
      `authority: ${(response.source_contract as { authority: string }).authority}`,
      "",
    ].join("\n"),
  );
}

export function runMigrate(argv: string[], io: Io, sourceRootOverride?: string): number {
  const format = requestedFormat(argv);
  const sourceRoot = sourceRootOverride ?? resolveSourceRoot();
  let contract: StateMigrationContract;
  try {
    contract = stateMigrationContract(sourceRoot);
  } catch (error) {
    return emitInvalidInput(
      io,
      invalid(`Local migration authority could not be loaded: ${(error as Error).message}`, format),
    );
  }
  const parsed = parseMigrateArgs(argv);
  if ("error" in parsed) return emitInvalidInput(io, invalid(parsed.error, format));
  const validation = validateMigrateArgs(parsed, contract);
  if (validation)
    return emitInvalidInput(io, invalid(validation, format, contract.supportedArtifacts));

  const response = deferredResponse(parsed, contract);
  const out = io.out ?? ((text: string) => process.stdout.write(text));
  if (format === "text") renderText(response, out);
  else emitStructured(response, format, out);
  return 1;
}
