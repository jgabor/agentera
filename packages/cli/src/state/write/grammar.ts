import crypto from "node:crypto";

import type { JsonObject } from "../../core/jsonValue.js";
import { resolveSourceRoot } from "../../core/sourceRoot.js";
import { loadStateStorageAuthority } from "../stateStorageAuthority.js";
import { runtimeOperationSpecs, type RuntimeOperationSpec } from "./runtimeOperations.js";

export const MUTATION_CLASSES = [
  "record_payload",
  "simple_transition",
  "batch_transaction",
] as const;
export type MutationClass = (typeof MUTATION_CLASSES)[number];

export const MUTATION_INPUT_MODES = [
  "none",
  "structured",
  "flags_until_conversion",
] as const;
export type MutationInputMode = (typeof MUTATION_INPUT_MODES)[number];

export type MutationFieldKind =
  | "string"
  | "boolean"
  | "integer"
  | "string_list"
  | "date"
  | "datetime";

export interface MutationFieldDeclaration {
  flag: string;
  field: string;
  kind: MutationFieldKind;
  required?: boolean;
  repeatable?: boolean;
  validValues?: string[];
  validValuesSource?: string;
  description?: string;
}

export interface MutationInputDeclaration {
  mode: MutationInputMode;
  root?: string;
  sources: string[];
  structuredSources?: string[];
  cliOwnedFields: string[];
}

export interface MutationOperationDeclaration {
  artifact: string;
  verb: string;
  mutationClass: MutationClass;
  selectors: string[];
  preconditions: string[];
  ownedFields: string[];
  input: MutationInputDeclaration;
  recovery: string;
  examples: string[];
  bounds: Record<string, unknown>;
  fields: MutationFieldDeclaration[];
  allowForce: boolean;
  compacts: boolean;
}

export interface MutationGrammar {
  schemaVersion: string;
  authority: string;
  operationClasses: MutationClass[];
  structuredInput: Record<string, unknown>;
  operations: MutationOperationDeclaration[];
  contractDigest: string;
}

interface CacheEntry {
  revision: symbol;
  grammar: MutationGrammar;
}

let cache: CacheEntry | undefined;

function mapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`invalid mutation grammar: ${path} must be a non-empty string`);
  return value;
}

function strings(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error(`invalid mutation grammar: ${path} must be a string list`);
  return [...value];
}

function clonePlain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clonePlain);
  if (mapping(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clonePlain(item)]));
  return value;
}

function fields(value: unknown, path: string): MutationFieldDeclaration[] {
  if (!Array.isArray(value)) throw new Error(`invalid mutation grammar: ${path} must be a list`);
  const seenFlags = new Set<string>();
  const seenFields = new Set<string>();
  return value.map((raw, index) => {
    const fieldPath = `${path}[${index}]`;
    if (!mapping(raw)) throw new Error(`invalid mutation grammar: ${fieldPath} must be a mapping`);
    const flag = requiredString(raw.flag, `${fieldPath}.flag`);
    const field = requiredString(raw.field, `${fieldPath}.field`);
    const kind = requiredString(raw.kind, `${fieldPath}.kind`) as MutationFieldKind;
    if (!["string", "boolean", "integer", "string_list", "date", "datetime"].includes(kind))
      throw new Error(`invalid mutation grammar: ${fieldPath}.kind '${kind}' is unsupported`);
    if (seenFlags.has(flag) || seenFields.has(field))
      throw new Error(`invalid mutation grammar: duplicate field ${flag}/${field} in ${path}`);
    seenFlags.add(flag);
    seenFields.add(field);
    const validValues = raw.valid_values === undefined ? undefined : strings(raw.valid_values, `${fieldPath}.valid_values`);
    const validValuesSource = raw.valid_values_source === undefined ? undefined : requiredString(raw.valid_values_source, `${fieldPath}.valid_values_source`);
    if (validValues && validValuesSource)
      throw new Error(`invalid mutation grammar: ${fieldPath} cannot declare both valid_values and valid_values_source`);
    return {
      flag,
      field,
      kind,
      required: raw.required === true,
      ...(raw.repeatable === true ? { repeatable: true } : {}),
      ...(validValues ? { validValues } : {}),
      ...(validValuesSource ? { validValuesSource } : {}),
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    };
  });
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (mapping(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function parseOperation(raw: unknown, index: number): MutationOperationDeclaration {
  const p = `mutation_grammar.operations[${index}]`;
  if (!mapping(raw)) throw new Error(`invalid mutation grammar: ${p} must be a mapping`);
  const artifact = requiredString(raw.artifact, `${p}.artifact`);
  const verb = requiredString(raw.verb, `${p}.verb`);
  const mutationClass = requiredString(raw.class, `${p}.class`) as MutationClass;
  if (!MUTATION_CLASSES.includes(mutationClass)) throw new Error(`invalid mutation grammar: ${p}.class '${mutationClass}' is unsupported`);
  if (!mapping(raw.input)) throw new Error(`invalid mutation grammar: ${p}.input must be a mapping`);
  const inputMode = requiredString(raw.input.mode, `${p}.input.mode`) as MutationInputMode;
  if (!MUTATION_INPUT_MODES.includes(inputMode)) throw new Error(`invalid mutation grammar: ${p}.input.mode '${inputMode}' is unsupported`);
  const input: MutationInputDeclaration = {
    mode: inputMode,
    ...(raw.input.root === undefined ? {} : { root: requiredString(raw.input.root, `${p}.input.root`) }),
    sources: strings(raw.input.sources, `${p}.input.sources`),
    ...(raw.input.structured_sources === undefined
      ? (inputMode === "structured" ? { structuredSources: strings(raw.input.sources, `${p}.input.sources`) } : {})
      : { structuredSources: strings(raw.input.structured_sources, `${p}.input.structured_sources`) }),
    cliOwnedFields: strings(raw.input.cli_owned_fields, `${p}.input.cli_owned_fields`),
  };
  if (inputMode === "structured" && (!input.root || input.sources.length === 0))
    throw new Error(`invalid mutation grammar: ${p} structured input needs a root and source`);
  if (inputMode === "none" && (input.sources.length > 0 || input.root !== undefined))
    throw new Error(`invalid mutation grammar: ${p} none input cannot declare sources or a root`);
  const operation = {
    artifact,
    verb,
    mutationClass,
    selectors: strings(raw.selectors, `${p}.selectors`),
    preconditions: strings(raw.preconditions, `${p}.preconditions`),
    ownedFields: strings(raw.owned_fields, `${p}.owned_fields`),
    input,
    recovery: requiredString(raw.recovery, `${p}.recovery`),
    examples: strings(raw.examples, `${p}.examples`),
    bounds: mapping(raw.bounds) ? clonePlain(raw.bounds) as Record<string, unknown> : (() => { throw new Error(`invalid mutation grammar: ${p}.bounds must be a mapping`); })(),
    fields: fields(raw.fields, `${p}.fields`),
    allowForce: raw.allow_force === true,
    compacts: raw.compacts === true,
  } satisfies MutationOperationDeclaration;
  if (operation.examples.length === 0) throw new Error(`invalid mutation grammar: ${p}.examples must not be empty`);
  const selectors = new Set(operation.selectors);
  for (const selector of selectors) {
    if (!selector.startsWith("--")) throw new Error(`invalid mutation grammar: ${p}.selectors must contain flags`);
  }
  return operation;
}

function runtimeFieldProjection(field: { flag: string; field: string; kind: string; required?: boolean; repeatable?: boolean; validValues?: string[]; validValuesSource?: string }): Record<string, unknown> {
  return {
    flag: field.flag,
    field: field.field,
    kind: field.kind,
    required: field.required === true,
    repeatable: field.repeatable === true,
    ...(field.validValuesSource
      ? { valid_values_source: field.validValuesSource }
      : field.validValues
        ? { valid_values: field.validValues }
        : {}),
  };
}

function declaredFieldProjection(field: MutationFieldDeclaration): Record<string, unknown> {
  return runtimeFieldProjection(field);
}

function operationParityProjection(operation: MutationOperationDeclaration): Record<string, unknown> {
  return {
    artifact: operation.artifact,
    verb: operation.verb,
    selectors: operation.selectors,
    owned_fields: operation.ownedFields,
    input: {
      mode: operation.input.mode,
      ...(operation.input.root ? { root: operation.input.root } : {}),
      sources: operation.input.sources,
      structured_sources: operation.input.structuredSources ?? [],
      cli_owned_fields: operation.input.cliOwnedFields,
    },
    fields: operation.fields.map(declaredFieldProjection),
    allow_force: operation.allowForce,
    compacts: operation.compacts,
    bounds: operation.input.mode === "structured"
      ? { max_input_utf8_bytes: operation.bounds.max_input_utf8_bytes }
      : { max_input_utf8_bytes: 0 },
  };
}

function runtimeParityProjection(operation: RuntimeOperationSpec): Record<string, unknown> {
  return {
    artifact: operation.artifact,
    verb: operation.verb,
    selectors: operation.selectors,
    owned_fields: operation.ownedFields,
    input: {
      mode: operation.inputMode,
      ...(operation.inputRoot ? { root: operation.inputRoot } : {}),
      sources: operation.inputSources,
      structured_sources: operation.structuredInputSources,
      cli_owned_fields: operation.cliOwnedFields,
    },
    fields: operation.fields.map(runtimeFieldProjection),
    allow_force: operation.allowForce,
    compacts: operation.compacts,
    bounds: { max_input_utf8_bytes: operation.inputMaxBytes },
  };
}

export function validateMutationGrammarParity(
  operations: MutationOperationDeclaration[],
  authorityPath = "references/artifacts/state-storage-authority.yaml",
): void {
  const runtime = runtimeOperationSpecs();
  const runtimeByKey = new Map(runtime.map((operation) => [`${operation.artifact}.${operation.verb}`, operation]));
  const declaredByKey = new Map(operations.map((operation) => [`${operation.artifact}.${operation.verb}`, operation]));
  const keys = [...new Set([...runtimeByKey.keys(), ...declaredByKey.keys()])].sort();
  const mismatches: string[] = [];
  for (const key of keys) {
    const code = runtimeByKey.get(key);
    const declared = declaredByKey.get(key);
    if (!code || !declared) {
      mismatches.push(`${key}: operation is ${code ? "missing from discovery" : "not code-owned"}`);
      continue;
    }
    const expected = canonicalJson(runtimeParityProjection(code));
    const actual = canonicalJson(operationParityProjection(declared));
    if (expected !== actual) mismatches.push(`${key}: discovery does not match code-owned runtime grammar`);
  }
  if (mismatches.length) {
    throw new Error(`mutation grammar parity failure for '${authorityPath}': ${mismatches.join("; ")}`);
  }
}

function parseGrammar(document: Record<string, unknown>, authority: string): MutationGrammar {
  const raw = document.mutation_grammar;
  if (!mapping(raw)) throw new Error(`invalid mutation grammar in '${authority}': mutation_grammar is missing`);
  const schemaVersion = requiredString(raw.schema_version, "mutation_grammar.schema_version");
  if (schemaVersion !== "agentera.stateMutationGrammar.v1") throw new Error(`invalid mutation grammar: unsupported schema version '${schemaVersion}'`);
  const operationClasses = strings(raw.operation_classes, "mutation_grammar.operation_classes") as MutationClass[];
  if (operationClasses.some((value) => !MUTATION_CLASSES.includes(value))) throw new Error("invalid mutation grammar: operation_classes contains an unsupported class");
  if (!mapping(raw.structured_input)) throw new Error("invalid mutation grammar: structured_input must be a mapping");
  if (!Array.isArray(raw.operations)) throw new Error("invalid mutation grammar: operations must be a list");
  const operations = raw.operations.map(parseOperation);
  const seen = new Set<string>();
  for (const operation of operations) {
    const key = `${operation.artifact}.${operation.verb}`;
    if (seen.has(key)) throw new Error(`invalid mutation grammar: duplicate public mutation '${key}'`);
    seen.add(key);
  }
  validateMutationGrammarParity(operations, authority);
  const contract = {
    schema_version: schemaVersion,
    operation_classes: operationClasses,
    structured_input: raw.structured_input,
    operations,
  };
  return {
    schemaVersion,
    authority: "references/artifacts/state-storage-authority.yaml",
    operationClasses,
    structuredInput: clonePlain(raw.structured_input) as JsonObject,
    operations,
    contractDigest: digest(contract),
  };
}

export function loadMutationGrammar(sourceRoot = resolveSourceRoot()): MutationGrammar {
  const authority = loadStateStorageAuthority(sourceRoot);
  if (cache?.revision === authority.revision) return cache.grammar;
  const grammar = parseGrammar(authority.document, authority.authorityPath);
  cache = { revision: authority.revision, grammar };
  return grammar;
}

export function mutationOperationsForArtifact(artifact: string, sourceRoot = resolveSourceRoot()): MutationOperationDeclaration[] {
  return loadMutationGrammar(sourceRoot).operations.filter((operation) => operation.artifact === artifact);
}

export function mutationGrammarPayload(sourceRoot = resolveSourceRoot()): JsonObject {
  const grammar = loadMutationGrammar(sourceRoot);
  return {
    schemaVersion: grammar.schemaVersion,
    authority: grammar.authority,
    contract_digest: grammar.contractDigest,
    operation_classes: grammar.operationClasses,
    structured_input: grammar.structuredInput as JsonObject,
    operations: grammar.operations as unknown as JsonObject[],
  };
}
