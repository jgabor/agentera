import path from "node:path";

import { loadYamlMappingFile } from "../core/yaml.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import {
  ARTIFACT_PROTOCOL_PATHS,
  normalizeArtifactProtocolId,
} from "./artifactProtocolIds.js";

export type VerbosityBudgetClassification =
  | "numeric_limit"
  | "explicit_no_limit"
  | "non_word_unit"
  | "invalid_declaration";

export interface VerbosityBudgetDimension {
  scope: string;
  classification: VerbosityBudgetClassification;
  unit: "words" | "tokens" | null;
  limit: number | null;
  declarationId: string | null;
  error?: string;
}

export interface VerbosityBudgetOwner {
  artifactId: string;
  authorityPath: string;
  schemaPath: string;
}

export interface ArtifactVerbosityBudget extends VerbosityBudgetOwner {
  dimensions: VerbosityBudgetDimension[];
}

interface ContractModel {
  contractPath: string;
  owners: Map<string, VerbosityBudgetOwner>;
}

export class VerbosityBudgetContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerbosityBudgetContractError";
  }
}

export function verbosityBudgetAuthorityPath(): string {
  return path.join(resolveSourceRoot(), "references", "artifacts", "verbosity-budget-authority.yaml");
}

function mapping(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function readMapping(filePath: string, label: string): Record<string, unknown> {
  try {
    return loadYamlMappingFile(filePath);
  } catch (error) {
    throw new VerbosityBudgetContractError(
      `${label} ${filePath} is unreadable or malformed: ${(error as Error).message}`,
    );
  }
}

function loadContract(contractPath: string): ContractModel {
  const contract = readMapping(contractPath, "verbosity budget authority");
  if (contract.schema_version !== "agentera.verbosityBudgetAuthority.v1") {
    throw new VerbosityBudgetContractError(
      `verbosity budget authority ${contractPath} has unsupported schema_version`,
    );
  }
  const authority = mapping(contract.authority);
  const scope = mapping(contract.scope);
  const supported = scope?.supported_artifacts;
  if (!authority || typeof authority.schema_directory !== "string" || !Array.isArray(supported)) {
    throw new VerbosityBudgetContractError(
      `verbosity budget authority ${contractPath} must declare authority.schema_directory and scope.supported_artifacts`,
    );
  }
  const schemaDirectory = path.resolve(path.dirname(contractPath), authority.schema_directory);
  const owners = new Map<string, VerbosityBudgetOwner>();
  for (const raw of supported) {
    const entry = mapping(raw);
    const artifactId = entry?.artifact_id;
    const schema = entry?.schema;
    if (typeof artifactId !== "string" || normalizeArtifactProtocolId(artifactId) !== artifactId) {
      throw new VerbosityBudgetContractError(
        `verbosity budget authority ${contractPath} contains an invalid artifact_id`,
      );
    }
    if (typeof schema !== "string" || !schema.endsWith(".yaml") || path.basename(schema) !== schema) {
      throw new VerbosityBudgetContractError(
        `verbosity budget authority ${contractPath} contains an invalid schema owner for ${artifactId}`,
      );
    }
    if (owners.has(artifactId)) {
      throw new VerbosityBudgetContractError(
        `verbosity budget authority ${contractPath} declares ambiguous owners for ${artifactId}`,
      );
    }
    owners.set(artifactId, {
      artifactId,
      authorityPath: contractPath,
      schemaPath: path.join(schemaDirectory, schema),
    });
  }
  if (owners.size === 0) {
    throw new VerbosityBudgetContractError(
      `verbosity budget authority ${contractPath} declares no supported artifacts`,
    );
  }
  return { contractPath, owners };
}

function protocolIdForOwner(input: string): string | null {
  const normalized = normalizeArtifactProtocolId(input);
  if (normalized) return normalized;
  const comparable = input.trim().replaceAll("\\", "/").toLowerCase();
  for (const [artifactId, artifactPath] of Object.entries(ARTIFACT_PROTOCOL_PATHS)) {
    const canonicalPath = artifactPath.toLowerCase();
    if (comparable === canonicalPath || comparable === path.posix.basename(canonicalPath)) {
      return artifactId;
    }
  }
  return null;
}

export function resolveVerbosityBudgetOwner(
  artifact: string,
  contractPath: string = verbosityBudgetAuthorityPath(),
): VerbosityBudgetOwner {
  const contract = loadContract(contractPath);
  const artifactId = protocolIdForOwner(artifact);
  const owner = artifactId ? contract.owners.get(artifactId) : undefined;
  if (!owner) {
    throw new VerbosityBudgetContractError(
      `unsupported artifact ${JSON.stringify(artifact)} in verbosity budget authority; ` +
        `valid artifact_id values: ${[...contract.owners.keys()].sort().join(", ")}`,
    );
  }
  return owner;
}

function invalidDimension(scope: string, declarationId: string | null, error: string): VerbosityBudgetDimension {
  return {
    scope,
    classification: "invalid_declaration",
    unit: null,
    limit: null,
    declarationId,
    error,
  };
}

function classifyDeclaration(raw: unknown, index: string): VerbosityBudgetDimension {
  const declaration = mapping(raw);
  if (!declaration) return invalidDimension(`<entry:${index}>`, null, "budget declaration must be a mapping");
  const scope = typeof declaration.scope === "string" && declaration.scope.trim()
    ? declaration.scope.trim()
    : `<entry:${index}>`;
  const declarationId = typeof declaration.id === "string" ? declaration.id : null;
  if (scope.startsWith("<entry:")) {
    return invalidDimension(scope, declarationId, "budget declaration must define a non-empty scope");
  }
  const hasWords = Object.hasOwn(declaration, "max_words");
  const hasTokens = Object.hasOwn(declaration, "token_budget");
  if (Number(hasWords) + Number(hasTokens) !== 1) {
    return invalidDimension(
      scope,
      declarationId,
      "budget declaration must define exactly one of max_words or token_budget",
    );
  }
  if (hasWords) {
    if (declaration.max_words === null) {
      return { scope, classification: "explicit_no_limit", unit: "words", limit: null, declarationId };
    }
    if (positiveNumber(declaration.max_words)) {
      return {
        scope,
        classification: "numeric_limit",
        unit: "words",
        limit: declaration.max_words,
        declarationId,
      };
    }
    return invalidDimension(scope, declarationId, "max_words must be a positive number or null");
  }
  if (positiveNumber(declaration.token_budget)) {
    return {
      scope,
      classification: "non_word_unit",
      unit: "tokens",
      limit: declaration.token_budget,
      declarationId,
    };
  }
  return invalidDimension(scope, declarationId, "token_budget must be a positive number");
}

function isNonVerbosityBudgetEntry(raw: unknown): boolean {
  const declaration = mapping(raw);
  return Boolean(
    declaration &&
      typeof declaration.rule === "string" &&
      !Object.hasOwn(declaration, "max_words") &&
      !Object.hasOwn(declaration, "token_budget"),
  );
}

export function inspectArtifactVerbosityBudget(
  artifact: string,
  contractPath: string = verbosityBudgetAuthorityPath(),
): ArtifactVerbosityBudget {
  const owner = resolveVerbosityBudgetOwner(artifact, contractPath);
  let schema: Record<string, unknown>;
  try {
    schema = readMapping(owner.schemaPath, `verbosity budget owner for ${owner.artifactId}`);
  } catch (error) {
    return {
      ...owner,
      dimensions: [invalidDimension("<authority>", null, (error as Error).message)],
    };
  }
  const budget = mapping(schema.BUDGET);
  if (!budget || Object.keys(budget).length === 0) {
    return {
      ...owner,
      dimensions: [invalidDimension("<authority>", null, "owning schema must define a non-empty BUDGET mapping")],
    };
  }
  const dimensions = Object.entries(budget)
    .filter(([, declaration]) => !isNonVerbosityBudgetEntry(declaration))
    .map(([index, declaration]) => classifyDeclaration(declaration, index));
  if (dimensions.length === 0) {
    return {
      ...owner,
      dimensions: [invalidDimension("<authority>", null, "owning schema defines no verbosity budget declarations")],
    };
  }
  const counts = new Map<string, number>();
  for (const dimension of dimensions) counts.set(dimension.scope, (counts.get(dimension.scope) ?? 0) + 1);
  return {
    ...owner,
    dimensions: dimensions.map((dimension) =>
      (counts.get(dimension.scope) ?? 0) > 1
        ? invalidDimension(dimension.scope, dimension.declarationId, `duplicate budget scope ${dimension.scope}`)
        : dimension,
    ),
  };
}

export function validateVerbosityBudgetContract(
  contractPath: string = verbosityBudgetAuthorityPath(),
): string[] {
  let contract: ContractModel;
  try {
    contract = loadContract(contractPath);
  } catch (error) {
    return [(error as Error).message];
  }
  const errors: string[] = [];
  for (const artifactId of contract.owners.keys()) {
    const inspected = inspectArtifactVerbosityBudget(artifactId, contractPath);
    for (const dimension of inspected.dimensions) {
      if (dimension.classification === "invalid_declaration") {
        errors.push(`${artifactId}:${dimension.scope}: ${dimension.error}`);
      }
    }
  }
  return errors;
}
