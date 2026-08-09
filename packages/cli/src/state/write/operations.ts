import crypto from "node:crypto";

import type { JsonObject } from "../../core/jsonValue.js";
import {
  canonicalJson,
  loadMutationGrammar,
  type MutationOperationDeclaration,
} from "./grammar.js";
import {
  RUNTIME_WRITABLE_ARTIFACTS,
  RUNTIME_WRITE_VERBS,
  runtimeOperationSpec,
  runtimeOperationSpecs,
  type RuntimeOperationField,
  type RuntimeOperationSpec,
  type RuntimeWritableArtifact,
  type RuntimeWriteVerb,
} from "./runtimeOperations.js";
import { structuredInputDescriptor, structuredInputSchemaProjection } from "./input.js";

export const WRITABLE_ARTIFACTS = RUNTIME_WRITABLE_ARTIFACTS;
export type WritableArtifact = RuntimeWritableArtifact;
export const WRITE_VERBS = RUNTIME_WRITE_VERBS;
export type WriteVerb = RuntimeWriteVerb;
export type FieldKind = RuntimeOperationField["kind"];
export type OperationField = RuntimeOperationField;
export type OperationSpec = RuntimeOperationSpec;

export interface StateWriteRequest {
  artifact: WritableArtifact;
  spec: OperationSpec;
  projectRoot: string;
  dryRun: boolean;
  force: boolean;
  values: Record<string, unknown>;
  callerPayload: Record<string, unknown>;
  input: Record<string, unknown> | null;
}

export interface StateWriteEnvelope extends Record<string, unknown> {
  schemaVersion: "agentera.stateWrite.v1";
  status: "pass";
}

let runtimeCache: RuntimeOperationSpec[] | undefined;

function codeOwnedSpecs(): RuntimeOperationSpec[] {
  if (!runtimeCache) runtimeCache = runtimeOperationSpecs();
  return runtimeCache;
}

/**
 * Runtime behavior is deliberately code-owned. The authority is loaded only
 * to prove that its discovery projection still describes these executable
 * operations; it never supplies parser fields or accepted verbs.
 */
export function assertMutationGrammarParity(): void {
  loadMutationGrammar();
}

export function operationSpec(artifact: string, verb: string): OperationSpec | null {
  const spec = runtimeOperationSpec(artifact, verb);
  return spec ? { ...spec, fields: spec.fields.map((field) => ({ ...field })) } : null;
}

export function verbsForArtifact(artifact: string): WriteVerb[] {
  if (!isWritableArtifact(artifact)) return [];
  return [...codeOwnedSpecs().filter((spec) => spec.artifact === artifact).map((spec) => spec.verb), "explain"];
}

export function isWriteVerb(value: string | undefined): value is WriteVerb {
  return Boolean(value && WRITE_VERBS.includes(value as WriteVerb));
}

export function isWritableArtifact(value: string): value is WritableArtifact {
  return WRITABLE_ARTIFACTS.includes(value as WritableArtifact);
}

export function writerOwnedFields(artifact: string): string[] {
  return [...new Set(codeOwnedSpecs().filter((spec) => spec.artifact === artifact).flatMap((spec) => spec.ownedFields))];
}

function declarationFor(grammar: ReturnType<typeof loadMutationGrammar>, artifact: string, verb: string): MutationOperationDeclaration {
  const declaration = grammar.operations.find((operation) => operation.artifact === artifact && operation.verb === verb);
  if (!declaration) throw new Error(`mutation grammar is missing code-owned operation '${artifact}.${verb}'`);
  return declaration;
}

function operationProjection(operation: MutationOperationDeclaration): JsonObject {
  const structured = structuredInputDescriptor(operation.artifact, operation.verb);
  return {
    verb: operation.verb,
    class: operation.mutationClass,
    selectors: operation.selectors,
    preconditions: operation.preconditions,
    owned_fields: operation.ownedFields,
    input: {
      mode: operation.input.mode,
      ...(operation.input.root ? { root: operation.input.root } : {}),
      ...(operation.input.optional ? { optional: true } : {}),
      sources: operation.input.sources,
      structured_sources: operation.input.structuredSources ?? [],
      cli_owned_fields: operation.input.cliOwnedFields,
      ...(structured ? { schema: structuredInputSchemaProjection(structured) as JsonObject } : {}),
    },
    recovery: operation.recovery,
    examples: operation.examples,
    bounds: operation.bounds as JsonObject,
    fields: operation.fields.map((field) => ({
      flag: field.flag,
      field: field.field,
      kind: field.kind,
      required: field.required === true,
      ...(field.repeatable ? { repeatable: true } : {}),
      ...(field.validValues ? { valid_values: field.validValues } : {}),
      ...(field.validValuesSource ? { valid_values_source: field.validValuesSource } : {}),
      ...(field.description ? { description: field.description } : {}),
    })),
    allow_force: operation.allowForce,
    compacts: operation.compacts,
  };
}

export function mutationParityMatrix(targets: readonly string[] = WRITABLE_ARTIFACTS): JsonObject {
  const selected = new Set(targets);
  const grammar = loadMutationGrammar();
  const rows = codeOwnedSpecs()
    .filter((spec) => selected.has(spec.artifact))
    .map((spec) => {
      const declaration = declarationFor(grammar, spec.artifact, spec.verb);
      const operationDigest = cryptoDigest(canonicalJson(operationProjection(declaration)));
      return {
        artifact: spec.artifact,
        verb: spec.verb,
        class: declaration.mutationClass,
        contract_digest: grammar.contractDigest,
        operation_digest: operationDigest,
        surfaces: {
          authority: `references/artifacts/state-storage-authority.yaml#mutation_grammar.${spec.artifact}.${spec.verb}`,
          runtime: `agentera state ${spec.artifact} ${spec.verb}`,
          explain: `agentera state ${spec.artifact} explain --verb ${spec.verb} --format json`,
          schema: "agentera schema --format json",
          help: `agentera state ${spec.artifact} --help`,
        },
        success: { command: declaration.examples[0], expected: "pass", evidence: "class-level runtime regression" },
        rejection: { command: `${declaration.examples[0]} --retired-content-flag`, expected: "fail", before_effects: true, evidence: "generic parser rejection regression" },
        compare: ["authority", "runtime", "explain", "schema", "help"],
      };
    });
  return {
    schemaVersion: "agentera.stateMutationParity.v1",
    contract_digest: grammar.contractDigest,
    rows,
    counts: {
      operations: rows.length,
      classes: Object.fromEntries(["record_payload", "simple_transition", "batch_transaction"].map((kind) => [kind, rows.filter((row) => row.class === kind).length])),
    },
  };
}

function cryptoDigest(value: string): string {
  // Kept local to make the parity projection independent from authority bytes.
  return createSha256(value);
}

function createSha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function stateWriterArtifactContract(
  artifact: string,
  mode: "full" | "compact" = "full",
): JsonObject | null {
  if (!isWritableArtifact(artifact)) return null;
  const grammar = loadMutationGrammar();
  const specs = codeOwnedSpecs().filter((spec) => spec.artifact === artifact);
  const mutations = specs.map((spec) => spec.verb);
  const result: JsonObject = {
    artifact,
    contract_digest: grammar.contractDigest,
    mutations,
    operation_count: specs.length,
    explain_command: `agentera state ${artifact} explain --format json`,
    explain_all_command: `agentera state ${artifact} explain --all --format json`,
    explain_by_verb: Object.fromEntries(mutations.map((verb) => [verb, `agentera state ${artifact} explain --verb ${verb} --format json`])),
    ...(writerOwnedFields(artifact).length ? { writer_owned_fields: writerOwnedFields(artifact) } : {}),
  };
  if (mode === "full") {
    result.operations = specs.map((spec) => operationProjection(declarationFor(grammar, artifact, spec.verb)));
    result.parity_matrix = mutationParityMatrix([artifact]);
  }
  return result;
}

export function stateWriterContract(
  targets: readonly string[] = WRITABLE_ARTIFACTS,
  mode: "full" | "compact" = "full",
): JsonObject {
  const uniqueTargets = [...new Set(targets)];
  const artifacts = uniqueTargets.map((target) => stateWriterArtifactContract(target, mode)).filter((entry): entry is JsonObject => entry !== null);
  const grammar = loadMutationGrammar();
  const fullParity = mutationParityMatrix(uniqueTargets) as Record<string, any>;
  const parity = mode === "full"
    ? fullParity
    : {
      schemaVersion: fullParity.schemaVersion,
      contract_digest: fullParity.contract_digest,
      counts: fullParity.counts,
      row_count: (fullParity.rows as unknown[]).length,
      detail: "agentera state <artifact> explain --all --format json",
    };
  return {
    schemaVersion: "agentera.stateWriterDiscovery.v1",
    namespace: "agentera state",
    authority: grammar.authority,
    contract_digest: grammar.contractDigest,
    policy: "Use the state writer for supported artifact mutations; do not hand-edit those artifacts during normal capability execution.",
    discovery_command: "agentera schema --format json",
    mutation_grammar: `agentera state <artifact> explain --all --format json`,
    artifacts,
    parity_matrix: parity,
    unsupported_targets: uniqueTargets.filter((target) => stateWriterArtifactContract(target, mode) === null),
  };
}
