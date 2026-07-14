import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";
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
import {
  applyLegacyMigration,
  inspectLegacyMigration,
  type LegacyMigrationApplyResult,
  type LegacyMigrationInspection,
} from "../../state/legacyMigration.js";
import { migrationEnrichmentContract } from "../../state/migrationEnrichment.js";

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

export interface MigrationInventory {
  project: string;
  entries: Array<Record<string, unknown>>;
  omittedCount: number;
  status: string;
}

class MigrationInventoryError extends Error {
  constructor(
    message: string,
    readonly failureClass: string,
  ) {
    super(message);
    this.name = "MigrationInventoryError";
  }
}

interface CandidateObservation {
  relativePath: string;
  sizeBytes: number;
  symbolicLink: boolean;
  regularFile: boolean;
}

function normalizedRelativePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function pathIsExcluded(relativePath: string, contract: StateMigrationContract): boolean {
  return contract.inventory.excludedRelativePaths.some(
    (excluded) => relativePath === excluded || relativePath.startsWith(`${excluded}/`),
  );
}

function inventoryEntry(
  observation: CandidateObservation,
  project: string,
  contract: StateMigrationContract,
): Record<string, unknown> {
  const artifactId = contract.fixedNames[observation.relativePath] ?? null;
  const entry: Record<string, unknown> = {
    candidate_id: observation.relativePath,
    path: observation.relativePath,
    artifact_id: artifactId,
    entry_number: null,
    classification: "unaddressable",
    detail_availability: "candidate_metadata_only",
    compatibility: "legacy",
    source: "project_local",
    addressable: false,
    size_bytes: observation.sizeBytes,
  };
  const pathError = candidatePathError(observation.relativePath, contract, project);
  if (observation.symbolicLink || pathError?.includes("boundary")) {
    entry.classification = "project_boundary";
    entry.compatibility = "blocked";
    entry.rejection = observation.symbolicLink ? "symlink_escape" : "outside_project";
  } else if (!observation.regularFile || pathError) {
    entry.classification = "unsupported";
    entry.compatibility = "unsupported";
    entry.rejection = observation.regularFile ? "unsupported_path" : "non_regular";
  }
  return entry;
}

function inventoryStatus(
  entries: Array<Record<string, unknown>>,
  omittedCount: number,
  contract: StateMigrationContract,
): string {
  const preferred =
    omittedCount > 0
      ? "degraded"
      : entries.some((entry) => entry.rejection !== undefined)
        ? "blocked"
        : "complete";
  return contract.resultStatuses.includes(preferred) ? preferred : contract.resultStatuses[0];
}

/** Inventory candidate metadata only; this function never reads bytes or mutates state. */
export function inventoryCandidates(
  selectedProject: string,
  contract: StateMigrationContract,
): MigrationInventory {
  let project: string;
  try {
    project = fs.realpathSync(selectedProject);
    if (!fs.statSync(project).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new MigrationInventoryError(
      "selected project must resolve to an existing project directory",
      "project_boundary",
    );
  }

  const observations: CandidateObservation[] = [];
  const seen = new Set<string>();
  const candidatePattern = new RegExp(contract.candidatePattern);
  const collect = (
    rootPath: string,
    rootRelative: string,
    maximumDepth: number,
    depth: number,
  ): void => {
    let directoryEntries: fs.Dirent[];
    try {
      directoryEntries = fs.readdirSync(rootPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const directoryEntry of directoryEntries) {
      const relativePath = normalizedRelativePath(path.join(rootRelative, directoryEntry.name));
      if (pathIsExcluded(relativePath, contract)) continue;
      const absolutePath = path.join(project, relativePath);
      if (directoryEntry.isDirectory()) {
        if (depth + 1 < maximumDepth) collect(absolutePath, relativePath, maximumDepth, depth + 1);
        continue;
      }
      if (!candidatePattern.test(directoryEntry.name) || seen.has(relativePath)) continue;
      seen.add(relativePath);
      let sizeBytes = 0;
      try {
        sizeBytes = fs.lstatSync(absolutePath).size;
      } catch {
        sizeBytes = 0;
      }
      observations.push({
        relativePath,
        sizeBytes,
        symbolicLink: directoryEntry.isSymbolicLink(),
        regularFile: directoryEntry.isFile(),
      });
    }
  };

  for (const root of contract.inventory.roots) {
    const rootRelative = normalizedRelativePath(root.path === "." ? "" : root.path);
    const rootPath = path.resolve(project, rootRelative || ".");
    try {
      const rootStat = fs.lstatSync(rootPath);
      if (rootStat.isSymbolicLink()) {
        throw new MigrationInventoryError(
          `declared scan root '${root.path}' violates the project boundary: symlink roots are forbidden`,
          "project_boundary",
        );
      }
      if (!rootStat.isDirectory()) continue;
    } catch (error) {
      if (error instanceof MigrationInventoryError) throw error;
      continue;
    }
    collect(rootPath, rootRelative, root.maximumDepth, 0);
  }

  observations.sort((left, right) =>
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0,
  );

  const entries: Array<Record<string, unknown>> = [];
  let omittedCount = 0;
  let totalBytes = 0;
  for (const [index, observation] of observations.entries()) {
    if (index >= contract.inventory.maximumCandidateFiles) {
      omittedCount += 1;
      continue;
    }
    if (observation.sizeBytes > contract.inventory.maximumFileBytes) {
      omittedCount += 1;
      continue;
    }
    if (totalBytes + observation.sizeBytes > contract.inventory.maximumTotalBytes) {
      omittedCount += 1;
      continue;
    }
    totalBytes += observation.sizeBytes;
    entries.push(inventoryEntry(observation, project, contract));
  }

  return {
    project,
    entries,
    omittedCount,
    status: inventoryStatus(entries, omittedCount, contract),
  };
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
    if (
      !requiredSelector ||
      selectorValue(requiredSelector) === null ||
      selectorValue(requiredSelector) === undefined
    ) {
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
    const selectorName = Object.keys(contract.selectors).find(
      (name) => selectorFlag(name) === required,
    );
    return (
      !selectorName ||
      selectorValue(selectorName) === null ||
      selectorValue(selectorName) === undefined
    );
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
  const modeFailure = contract.invalidCombinations.find(
    (combination) => combination.message === message,
  );
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
      ...(contract
        ? { syntax: contract.command, example: authorityFailure(contract, failureClass).example }
        : {}),
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
    .map((entry) => {
      const projected = Object.fromEntries(
        Object.entries(entry).filter(([field]) => allowedFields.has(field)),
      );
      for (const field of ["path", "candidate_id"]) {
        if (typeof projected[field] === "string") {
          projected[field] = normalizedRelativePath(projected[field] as string);
        }
      }
      return projected;
    })
    .sort((left, right) => {
      const leftPath = String(left.path ?? "").replaceAll("\\", "/");
      const rightPath = String(right.path ?? "").replaceAll("\\", "/");
      return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
    });
  const limit = args.limit ?? contract.defaultLimit;
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
  const matches = (
    entry: Record<string, unknown>,
    predicates: Array<{ field: string; equals?: unknown; notEquals?: unknown }>,
  ): boolean =>
    predicates.every((predicate) => {
      if ("equals" in predicate) return entry[predicate.field] === predicate.equals;
      return entry[predicate.field] !== predicate.notEquals;
    });
  const counts: Record<string, number | null> = {};
  for (const field of contract.resultCountFields) {
    const rule = contract.resultCountRules[field];
    const sourceEntries = rule.source === "visible_entries" ? entries : [];
    if (rule.operation === "value" && rule.source === "omitted_count") {
      counts[field] = omittedCount;
    } else if (
      rule.operation === "count" &&
      rule.source === "all_candidates" &&
      rule.predicates.length === 0
    ) {
      counts[field] = entries.length + omittedCount;
    } else if (rule.operation === "count" && rule.source === "visible_entries") {
      counts[field] = sourceEntries.filter((entry) => matches(entry, rule.predicates)).length;
    } else if (rule.operation === "distinct" && rule.source === "visible_entries" && rule.field) {
      counts[field] = new Set(
        sourceEntries
          .filter((entry) => matches(entry, rule.predicates))
          .map((entry) => entry[rule.field as string])
          .filter(
            (value): value is string | number =>
              typeof value === "string" || typeof value === "number",
          ),
      ).size;
    } else {
      counts[field] = null;
    }
  }
  return counts;
}

function omissionValues(
  contract: StateMigrationContract,
  omittedCount: number,
  outputBounded = false,
): Record<string, unknown> {
  const sourceValues: Record<string, unknown> = {
    has_omissions: omittedCount > 0,
    omitted_count: omittedCount,
    omission_reason:
      omittedCount > 0
        ? outputBounded
          ? contract.omission.outputBoundedReason
          : contract.omission.boundedReason
        : contract.omission.completeReason,
    retrieval: {
      command: contract.omission.retrieval,
      retry: outputBounded ? contract.omission.outputRetry : contract.omission.retry,
    },
  };
  return Object.fromEntries(
    contract.omission.fields.map((field) => {
      const source = contract.omission.fieldSources[field];
      if (!(source in sourceValues)) {
        throw new Error(`state migration omission source '${source}' is unavailable`);
      }
      return [field, sourceValues[source]];
    }),
  );
}

function textResponse(response: Record<string, unknown>): string {
  const diagnostics = response.diagnostics as Array<{ message: string }>;
  const valueText = (value: unknown): string =>
    value !== null && typeof value === "object" ? JSON.stringify(value) : String(value);
  return (
    [
      ...Object.entries(response)
        .filter(([field]) => field !== "diagnostics")
        .map(([field, value]) => `${field}: ${valueText(value)}`),
      `diagnostic: ${diagnostics[0]?.message ?? "none"}`,
      `authority: ${(response.source_contract as { authority: string }).authority}`,
      "",
    ].join("\n")
  );
}

function serializedResponseBytes(response: Record<string, unknown>, format: MigrateFormat): number {
  const serialized =
    format === "text"
      ? textResponse(response)
      : format === "yaml"
        ? YAML.stringify(response, { sortMapEntries: false })
        : JSON.stringify(response, null, 2) + "\n";
  return Buffer.byteLength(serialized, "utf8");
}

function boundedDiagnostics(
  diagnostics: unknown,
  entries: Array<Record<string, unknown>>,
  contract: StateMigrationContract,
): Array<Record<string, unknown>> {
  if (!Array.isArray(diagnostics)) return [];
  const retainedIds = new Set(entries.map((entry) => String(entry.candidate_id ?? "")));
  const retained: Array<Record<string, unknown>> = [];
  const omitted = new Map<string, number>();
  for (const value of diagnostics) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const diagnostic = value as Record<string, unknown>;
    const candidateId = diagnostic.candidate_id;
    if (candidateId === undefined || retainedIds.has(String(candidateId))) {
      retained.push(diagnostic);
      continue;
    }
    const failureClass = String(diagnostic.class ?? "unsupported_candidate");
    omitted.set(failureClass, (omitted.get(failureClass) ?? 0) + 1);
  }
  for (const [failureClass, count] of [...omitted.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    retained.push({
      class: failureClass,
      message: `${count} candidate diagnostic(s) were omitted by the serialized output budget`,
      provenance: {
        failure_class: failureClass,
        reason: contract.omission.outputBoundedReason,
        omitted_count: count,
      },
    });
  }
  return retained;
}

function boundMigrationResponse(
  response: Record<string, unknown>,
  format: MigrateFormat,
  contract: StateMigrationContract,
): Record<string, unknown> {
  if (serializedResponseBytes(response, format) <= contract.outputMaxUtf8Bytes) return response;
  const entries = Array.isArray(response.entries)
    ? (response.entries as Array<Record<string, unknown>>)
    : [];
  const initialOmitted = Number(response.omitted_count ?? 0);
  for (let retainedCount = entries.length; retainedCount >= 0; retainedCount -= 1) {
    const retained = entries.slice(0, retainedCount);
    const omittedCount = initialOmitted + entries.length - retainedCount;
    const bounded = {
      ...response,
      entries: retained,
      diagnostics: boundedDiagnostics(response.diagnostics, retained, contract),
      counts: resultCounts(retained, omittedCount, contract),
      ...omissionValues(contract, omittedCount, true),
    };
    if (serializedResponseBytes(bounded, format) <= contract.outputMaxUtf8Bytes) return bounded;
  }
  throw new Error(
    `migration output requires more than the authority ${contract.outputMaxUtf8Bytes}-byte ${format} budget after required omission metadata`,
  );
}

export function deferredResponse(
  args: MigrateArgs,
  contract: StateMigrationContract,
  entries: Array<Record<string, unknown>> = [],
  inventory?: MigrationInventory,
  options: {
    status?: string;
    diagnostics?: Array<Record<string, unknown>>;
    operations?: Array<Record<string, unknown>>;
    mutationPerformed?: boolean;
  } = {},
  sourceRoot: string = resolveSourceRoot(),
): Record<string, unknown> {
  const mode = args.apply ? "apply" : args.dryRun ? "preview" : "inventory";
  const projected = projectedEntries(entries, args, contract);
  const omittedCount = (inventory?.omittedCount ?? 0) + projected.omittedCount;
  const omission = omissionValues(contract, omittedCount);
  const values: Record<string, unknown> = {
    schemaVersion: contract.resultSchemaVersion,
    command: contract.command,
    status: options.status ?? inventory?.status ?? contract.resultStatuses[0],
    mode,
    project: inventory?.project ?? args.project ?? process.cwd(),
    read_only: !args.apply,
    mutation_intent: args.apply,
    mutation_performed: options.mutationPerformed ?? false,
    remote_contact: false,
    inventory_performed: inventory !== undefined,
    entries: projected.entries,
    counts: resultCounts(projected.entries, omittedCount, contract),
    ...omission,
    diagnostics: options.diagnostics ?? [
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
        count_rules: contract.resultCountRules,
        omission: contract.omission,
        max_utf8_bytes: contract.outputMaxUtf8Bytes,
      },
      inventory: contract.inventory,
      git_required: false,
      remote_contact: "forbidden",
      optional_git_enrichment: migrationEnrichmentContract(sourceRoot),
    },
  };
  const response = Object.fromEntries(
    contract.resultRequiredFields.map((field) => [field, values[field] ?? null]),
  );
  if (options.operations !== undefined) response.operations = options.operations;
  return boundMigrationResponse(response, args.format, contract);
}

export function renderText(response: Record<string, unknown>, out: (text: string) => void): void {
  out(textResponse(response));
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

  let inventory: MigrationInventory;
  try {
    inventory = inventoryCandidates(parsed.project ?? process.cwd(), contract);
  } catch (error) {
    const inventoryError = error as MigrationInventoryError;
    return emitInvalidInput(
      io,
      invalid(
        inventoryError.message,
        format,
        contract,
        undefined,
        inventoryError.failureClass ?? "project_boundary",
      ),
    );
  }
  let inspection: LegacyMigrationInspection;
  try {
    inspection = inspectLegacyMigration(inventory, contract, sourceRoot, parsed);
  } catch (error) {
    return emitInvalidInput(
      io,
      invalid(
        `local migration inventory failed: ${(error as Error).message}`,
        format,
        contract,
        undefined,
        "corrupt_candidate",
      ),
    );
  }
  let applyResult: LegacyMigrationApplyResult | undefined;
  if (parsed.apply) {
    applyResult = applyLegacyMigration(
      inspection,
      {
        artifact: parsed.artifact as string,
        number: parsed.number as number,
        path: parsed.path,
      },
      { sourceRoot },
    );
  }
  const diagnostics = [...inspection.diagnostics, ...(applyResult?.diagnostics ?? [])].slice(
    0,
    parsed.limit ?? contract.defaultLimit,
  );
  const response = deferredResponse(
    parsed,
    contract,
    inspection.entries,
    { ...inventory, status: applyResult?.status ?? inspection.status },
    {
      status: applyResult?.status ?? inspection.status,
      diagnostics,
      operations: applyResult?.operations ?? inspection.operations,
      mutationPerformed: applyResult?.mutationPerformed ?? false,
    },
    sourceRoot,
  );
  const out = io.out ?? ((text: string) => process.stdout.write(text));
  if (format === "text") renderText(response, out);
  else emitStructured(response, format, out);
  return 1;
}
