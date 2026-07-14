import fs from "node:fs";
import path from "node:path";

import { emitInvalidInput, type InvalidInputErrorBody } from "../errors.js";
import { emitStructured } from "../structured.js";
import type { Io } from "../dispatch/shared.js";
import { resolveSourceRoot } from "../../core/sourceRoot.js";
import {
  migrationModeFlags,
  migrationSelectorFlag,
  migrationFailure,
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
  formats: string[],
  formatFlag: string,
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

function candidatePathError(
  candidate: string,
  contract: StateMigrationContract,
  project: string = process.cwd(),
): string | null {
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
  const normalizedPath = parts.join("/");
  if (
    contract.inventory.excludedRelativePaths.some(
      (excluded) => normalizedPath === excluded || normalizedPath.startsWith(`${excluded}/`),
    )
  ) {
    return "candidate path is excluded by the authority inventory policy";
  }
  const inScanRoot = contract.inventory.roots.some((root) => {
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
  let projectRoot: string;
  try {
    projectRoot = fs.realpathSync(project);
  } catch {
    return "selected project must resolve to an existing project directory";
  }
  let current = projectRoot;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        return "candidate path violates the project boundary: symlink components are forbidden";
      }
    } catch {
      break;
    }
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
  const limitFlag = migrationSelectorFlag(contract, "limit");
  const dryRunFlag = migrationModeFlags(contract, "preview")[0];
  const applyFlags = migrationModeFlags(contract, "apply");
  const applyFlag = applyFlags.find((flag) => ![dryRunFlag].includes(flag)) ?? applyFlags[0];
  const forceFlag = applyFlags.find((flag) => flag !== applyFlag);
  const selectorValue = (selectorName: string): unknown => {
    if (selectorName === "project") return args.project;
    if (selectorName === "artifact") return args.artifact;
    if (selectorName === "number") return args.number;
    if (selectorName === "path") return args.path;
    if (selectorName === "limit") return args.limit;
    if (selectorName === "format") return args.format;
    return undefined;
  };
  const selectorFlag = (name: string): string => migrationSelectorFlag(contract, name);
  const activeModeFlags = new Set<string>();
  if (args.dryRun) activeModeFlags.add(dryRunFlag);
  if (args.apply) activeModeFlags.add(applyFlag);
  if (args.force && forceFlag) activeModeFlags.add(forceFlag);
  for (const combination of contract.invalidCombinations) {
    if (!combination.flags.every((flag) => activeModeFlags.has(flag))) continue;
    if (combination.requires && !activeModeFlags.has(combination.requires))
      return combination.message;
    if (!combination.requires) return combination.message;
  }
  const artifactValues = contract.selectorValidValues.artifact;
  if (args.artifact && !artifactValues.includes(args.artifact)) {
    return `unsupported artifact '${args.artifact}'`;
  }
  const numberRequires = contract.selectors.number.required_with;
  if (args.number !== undefined && typeof numberRequires === "string") {
    const requiredSelector = Object.keys(contract.selectors).find(
      (name) => selectorFlag(name) === numberRequires,
    );
    if (!requiredSelector || selectorValue(requiredSelector) === null || selectorValue(requiredSelector) === undefined) {
      return `argument ${selectorFlag("number")} requires ${numberRequires}`;
    }
  }
  if (
    args.limit !== undefined &&
    (args.limit < contract.minimumLimit || args.limit > contract.maximumLimit)
  ) {
    return `argument ${limitFlag} must be between ${contract.minimumLimit} and ${contract.maximumLimit}`;
  }
  if (args.path) {
    const pathError = candidatePathError(args.path, contract, args.project ?? process.cwd());
    if (pathError) return pathError;
  }
  const requiredApplySelectors = contract.requiredSelectors.apply ?? [];
  const missingApplySelectors = requiredApplySelectors.filter((required) => {
    const selectorName = Object.keys(contract.selectors).find((name) => selectorFlag(name) === required);
    return !selectorName || selectorValue(selectorName) === null || selectorValue(selectorName) === undefined;
  });
  if (args.apply && missingApplySelectors.length > 0) {
    return `${applyFlag} requires ${missingApplySelectors.join(" and ")} selector${missingApplySelectors.length === 1 ? "" : "s"}`;
  }
  return null;
}

function authorityFailure(
  contract: StateMigrationContract,
  failureClass: string,
): { example?: string; recovery?: string } {
  const failure = migrationFailure(contract, failureClass);
  return {
    example: typeof failure.example === "string" ? failure.example : undefined,
    recovery: typeof failure.recovery === "string" ? failure.recovery : undefined,
  };
}

function failureClassForMessage(contract: StateMigrationContract, message: string): string {
  const modeFailure = contract.invalidCombinations.find((combination) => combination.message === message);
  if (modeFailure) return modeFailure.failureClass;
  if (message.includes("project boundary") || message.includes("selected project"))
    return "project_boundary";
  if (message.includes("unsupported")) return "unsupported_candidate";
  return "invalid_selector";
}

function invalid(
  message: string,
  format: MigrationOutputFormat,
  contract?: StateMigrationContract,
  validValues?: string[],
  failureClass = "invalid_selector",
): { format: MigrationOutputFormat; body: InvalidInputErrorBody } {
  const failure = contract ? authorityFailure(contract, failureClass) : {};
  return {
    format,
    body: {
      class: message.startsWith("unsupported artifact") ? "invalid_choice" : "invalid_request",
      message,
      ...(contract ? { syntax: contract.command, example: authorityFailure(contract, failureClass).example } : {}),
      ...(validValues ? { valid_values: validValues } : {}),
      ...(failure.recovery ? { recovery: failure.recovery } : {}),
    },
  };
}

export function projectedEntries(
  entries: Array<Record<string, unknown>>,
  args: MigrateArgs,
  contract: StateMigrationContract,
): { entries: Array<Record<string, unknown>>; omittedCount: number } {
  const allowedFields = new Set(contract.resultEntryFields);
  const normalized = entries
    .map((entry) =>
      Object.fromEntries(
        Object.entries(entry).filter(([field]) => allowedFields.has(field)),
      ),
    )
    .sort((left, right) => {
      const leftPath = String(left.path ?? "").replaceAll("\\", "/");
      const rightPath = String(right.path ?? "").replaceAll("\\", "/");
      return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
    });
  const limit = args.limit ?? contract.maximumLimit;
  return {
    entries: normalized.slice(0, limit),
    omittedCount: Math.max(0, normalized.length - limit),
  };
}

export function resultCounts(
  entries: Array<Record<string, unknown>>,
  omittedCount: number,
  contract: StateMigrationContract,
): Record<string, number | null> {
  const counts: Record<string, number | null> = {};
  const visibleEntries = entries;
  const count = (predicate: (entry: Record<string, unknown>) => boolean): number =>
    visibleEntries.filter(predicate).length;
  const distinct = (field: string): number =>
    new Set(
      visibleEntries
        .map((entry) => entry[field])
        .filter((value): value is string | number => typeof value === "string" || typeof value === "number"),
    ).size;
  for (const field of contract.resultCountFields) {
    if (field === "omitted") counts[field] = omittedCount;
    else if (entries.length === 0) counts[field] = null;
    else if (field === "physical") counts[field] = entries.length + omittedCount;
    else if (field === "addressable") counts[field] = count((entry) => entry.addressable === true);
    else if (field === "addressable_ids") counts[field] = distinct("candidate_id");
    else if (field === "unaddressable")
      counts[field] = count((entry) => entry.addressable === false && entry.classification !== "ambiguous");
    else if (field === "ambiguous") counts[field] = count((entry) => entry.classification === "ambiguous");
    else if (field === "mirrored") counts[field] = count((entry) => entry.classification === "mirrored");
    else if (field === "duplicate") counts[field] = count((entry) => entry.classification === "duplicate");
    else if (field === "conflict") counts[field] = count((entry) => entry.classification === "conflict");
    else counts[field] = null;
  }
  return counts;
}

export function deferredResponse(
  args: MigrateArgs,
  contract: StateMigrationContract,
  entries: Array<Record<string, unknown>> = [],
): Record<string, unknown> {
  const mode = args.apply ? "apply" : args.dryRun ? "preview" : "inventory";
  const projected = projectedEntries(entries, args, contract);
  const values: Record<string, unknown> = {
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
    entries: projected.entries,
    counts: resultCounts(projected.entries, projected.omittedCount, contract),
    omitted: projected.omittedCount > 0,
    omitted_count: projected.omittedCount,
    omission_reason:
      projected.omittedCount > 0 ? contract.omission.boundedReason : contract.omission.completeReason,
    retrieval: {
      command: contract.omission.retrieval,
      retry: contract.omission.retry,
    },
    diagnostics: [
      {
        class: "implementation_deferred",
        message: `${String(contract.migration.implementation_boundary)} No state was changed.`,
      },
    ],
    source_contract: {
      authority: contract.authorityPath,
      schema_version: contract.schemaVersion,
      execution: "authority_and_dispatch_only",
      result: {
        required_fields: contract.resultRequiredFields,
        entry_fields: contract.resultEntryFields,
        count_fields: contract.resultCountFields,
        omission: contract.omission,
      },
      inventory: contract.inventory,
      git_required: false,
      remote_contact: "forbidden",
    },
  };
  return Object.fromEntries(
    contract.resultRequiredFields.map((field) => [field, values[field] ?? null]),
  );
}

export function renderText(response: Record<string, unknown>, out: (text: string) => void): void {
  const diagnostics = response.diagnostics as Array<{ message: string }>;
  const valueText = (value: unknown): string =>
    value !== null && typeof value === "object" ? JSON.stringify(value) : String(value);
  out(
    [
      ...Object.entries(response)
        .filter(([field]) => field !== "diagnostics")
        .map(([field, value]) => `${field}: ${valueText(value)}`),
      `diagnostic: ${diagnostics[0]?.message ?? "none"}`,
      `authority: ${(response.source_contract as { authority: string }).authority}`,
      "",
    ].join("\n"),
  );
}

export function runMigrate(argv: string[], io: Io, sourceRootOverride?: string): number {
  let format: MigrationOutputFormat = "text";
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
  if ("error" in parsed) {
    const validValues = parsed.error.includes("invalid choice")
      ? contract.selectorValidValues.format
      : undefined;
    return emitInvalidInput(
      io,
      invalid(parsed.error, format, contract, validValues, "invalid_selector"),
    );
  }
  const validation = validateMigrateArgs(parsed, contract);
  if (validation) {
    const validValues = validation.startsWith("unsupported artifact")
      ? contract.selectorValidValues.artifact
      : undefined;
    return emitInvalidInput(
      io,
      invalid(
        validation,
        format,
        contract,
        validValues,
        failureClassForMessage(contract, validation),
      ),
    );
  }

  const response = deferredResponse(parsed, contract);
  const out = io.out ?? ((text: string) => process.stdout.write(text));
  if (format === "text") renderText(response, out);
  else emitStructured(response, format, out);
  return 1;
}
