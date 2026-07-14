import path from "node:path";

import { emitInvalidInput, type InvalidInputErrorBody } from "../errors.js";
import { emitStructured } from "../structured.js";
import type { Io } from "../dispatch/shared.js";
import { resolveSourceRoot } from "../../core/sourceRoot.js";
import {
  migrationModeFlags,
  migrationSelectorFlag,
  stateMigrationContract,
  type StateMigrationContract,
} from "../../state/migrationAuthority.js";

export type MigrateFormat = string;

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

type MigrationOutputFormat = "text" | "json" | "yaml";

function requestedFormat(
  argv: string[],
  formats?: string[],
  formatFlag = "--format",
): MigrationOutputFormat {
  let requested: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === formatFlag) {
      requested = argv[index + 1];
    }
    if (argv[index].startsWith(`${formatFlag}=`)) {
      requested = argv[index].slice(formatFlag.length + 1);
    }
  }
  if (!requested || (formats && !formats.includes(requested))) return "text";
  return requested as MigrationOutputFormat;
}

function parseInteger(flag: string, value: string, pattern?: string): number | string {
  if (pattern && !new RegExp(pattern).test(value)) {
    return `argument ${flag}: invalid int value: '${value}'`;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : `argument ${flag}: invalid int value: '${value}'`;
}

function candidatePathError(candidate: string, contract: StateMigrationContract): string | null {
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
  const inScanRoot = contract.scanRoots.some((root) => {
    const rootParts = root.path === "." ? [] : root.path.split("/").filter(Boolean);
    const relativeParts = parts.slice(rootParts.length);
    return (
      rootParts.every((part, index) => parts[index] === part) &&
      relativeParts.length > 0 &&
      relativeParts.length <= root.maximumDepth
    );
  });
  if (!inScanRoot) return "candidate path must remain within a declared project-local scan root";
  if (!new RegExp(contract.candidatePattern).test(parts[parts.length - 1])) {
    return "candidate path is unsupported by the authority candidate pattern";
  }
  return null;
}

export function parseMigrateArgs(
  argv: string[],
  contract: StateMigrationContract = stateMigrationContract(),
): MigrateArgs | { error: string } {
  const selectorFlags = new Map(
    Object.keys(contract.selectors).map((name) => [migrationSelectorFlag(contract, name), name]),
  );
  const formatFlag = migrationSelectorFlag(contract, "format");
  const previewFlags = migrationModeFlags(contract, "preview");
  const applyFlags = migrationModeFlags(contract, "apply");
  const dryRunFlag = previewFlags[0];
  const applyFlag = applyFlags.find((flag) => !previewFlags.includes(flag)) ?? applyFlags[0];
  const forceFlag = applyFlags.find((flag) => flag !== applyFlag);
  const args: MigrateArgs = {
    project: null,
    artifact: null,
    dryRun: false,
    apply: false,
    force: false,
    format: contract.formats[0],
    limit: contract.defaultLimit,
  };
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const flag = [...selectorFlags.keys()].find(
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
      const selector = selectorFlags.get(flag);
      if (selector === "format") {
        if (!contract.formats.includes(value)) {
          return {
            error: `argument ${formatFlag}: invalid choice: '${value}' (choose from ${contract.formats.map((item) => `'${item}'`).join(", ")})`,
          };
        }
        args.format = value;
      } else if (selector === "project") args.project = value;
      else if (selector === "artifact") args.artifact = value;
      else if (selector === "path") args.path = value;
      else {
        const pattern = selector === "number" ? contract.numberPattern : undefined;
        const parsed = parseInteger(flag, value, pattern);
        if (typeof parsed === "string") return { error: parsed };
        if (selector === "number") args.number = parsed;
        else if (selector === "limit") args.limit = parsed;
      }
    } else if (token === dryRunFlag) {
      if (args.dryRun) return { error: `${dryRunFlag} may only be supplied once` };
      args.dryRun = true;
    } else if (token === applyFlag) {
      if (args.apply) return { error: `${applyFlag} may only be supplied once` };
      args.apply = true;
    } else if (token === forceFlag) {
      if (args.force) return { error: `${forceFlag} may only be supplied once` };
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
  const artifactFlag = migrationSelectorFlag(contract, "artifact");
  const numberFlag = migrationSelectorFlag(contract, "number");
  const limitFlag = migrationSelectorFlag(contract, "limit");
  const dryRunFlag = migrationModeFlags(contract, "preview")[0];
  const applyFlags = migrationModeFlags(contract, "apply");
  const applyFlag = applyFlags.find((flag) => ![dryRunFlag].includes(flag)) ?? applyFlags[0];
  const forceFlag = applyFlags.find((flag) => flag !== applyFlag);
  if (args.artifact && !contract.supportedArtifacts.includes(args.artifact)) {
    return `unsupported artifact '${args.artifact}'`;
  }
  if (args.number !== undefined && !args.artifact) {
    return `argument ${numberFlag} requires ${artifactFlag}`;
  }
  if (
    args.limit !== undefined &&
    (args.limit < contract.minimumLimit || args.limit > contract.maximumLimit)
  ) {
    return `argument ${limitFlag} must be between ${contract.minimumLimit} and ${contract.maximumLimit}`;
  }
  if (args.path) {
    const pathError = candidatePathError(args.path, contract);
    if (pathError) return pathError;
  }
  if (args.apply && args.dryRun) return `${applyFlag} and ${dryRunFlag} are mutually exclusive`;
  if (args.apply && !args.force) return `${applyFlag} requires explicit ${forceFlag} intent`;
  if (args.force && !args.apply) return `${forceFlag} requires ${applyFlag}`;
  if (args.apply && (args.artifact === null || args.number === undefined)) {
    return `${applyFlag} requires exactly one ${artifactFlag} and ${numberFlag} selector`;
  }
  return null;
}

function authorityExample(contract: StateMigrationContract): string | undefined {
  const failures = contract.migration.failures as { classes?: unknown };
  if (!Array.isArray(failures.classes)) return undefined;
  const example = failures.classes.find(
    (failure): failure is { example: string } =>
      failure !== null &&
      typeof failure === "object" &&
      !Array.isArray(failure) &&
      typeof (failure as { example?: unknown }).example === "string",
  );
  return example?.example;
}

function invalid(
  message: string,
  format: MigrationOutputFormat,
  contract?: StateMigrationContract,
  validValues?: string[],
): { format: MigrationOutputFormat; body: InvalidInputErrorBody } {
  return {
    format,
    body: {
      class: message.startsWith("unsupported artifact") ? "invalid_choice" : "invalid_request",
      message,
      ...(contract ? { syntax: contract.command, example: authorityExample(contract) } : {}),
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
    schemaVersion: contract.resultSchemaVersion,
    command: contract.command,
    status: contract.resultStatuses[contract.resultStatuses.length - 1],
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
      schema_version: contract.schemaVersion,
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
  let format = requestedFormat(argv);
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
  format = requestedFormat(argv, contract.formats, migrationSelectorFlag(contract, "format"));
  const parsed = parseMigrateArgs(argv, contract);
  if ("error" in parsed) return emitInvalidInput(io, invalid(parsed.error, format, contract));
  const validation = validateMigrateArgs(parsed, contract);
  if (validation) {
    return emitInvalidInput(io, invalid(validation, format, contract, contract.supportedArtifacts));
  }

  const response = deferredResponse(parsed, contract);
  const out = io.out ?? ((text: string) => process.stdout.write(text));
  if (format === "text") renderText(response, out);
  else emitStructured(response, format, out);
  return 1;
}
