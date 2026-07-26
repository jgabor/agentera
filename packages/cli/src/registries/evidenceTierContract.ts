import path from "node:path";

import { loadYamlMappingFile } from "../core/yaml.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";

/**
 * Contract model for the authoritative evidence-tier authority
 * (`references/analysis/evidence-tier-authority.yaml`). Task 1 of the tiered
 * extraction plan defines and verifies the tier contract; this loader is the
 * small contract-model code that makes the contract's invariants executable
 * and testable. It does not implement the extraction writer or migrate
 * consumers (plan Tasks 2-4).
 */

export type TierId = "full_evidence" | "signal";
export type CompatibilityOutcome = "recover" | "degrade";
export type CompatibilityStateId =
  | "oversized"
  | "legacy"
  | "missing"
  | "corrupt"
  | "incomplete";

export interface EvidenceTierDefinition {
  tier_id: TierId;
  rank: number;
  stored_fields: { required: string[]; optional: string[] };
}

export interface SourceFamilyDefinition {
  family_id: string;
  source_class: "active_runtime" | "historical_import";
  source_product: string[];
  active_runtime: boolean;
  inclusion_rule?: string;
}

export interface ConsumerDefinition {
  consumer_id: string;
  tier: TierId;
  purpose: string;
  required_fields: string[];
  source_identity: string;
  input_contract: string;
}

export interface DeferredConsumerDefinition {
  consumer_id: string;
  tier: TierId;
  status: string;
  input_scope?: string;
  excluded_evidence_classes: string[];
  required_semantics: string[];
}

export interface SignalSemanticDefinition {
  kind: string;
  meaning: string;
  derivable_from: string;
  deferred_consumer: string;
  current_consumer?: string;
}

export interface CompatibilityStateDefinition {
  state_id: CompatibilityStateId;
  trigger: string;
  status: string;
  reason: string;
  outcome: CompatibilityOutcome;
  recovery: string;
}

export interface EvidenceTierBounds {
  readerByteCap: number;
  shardByteCap: number;
  signalByteCap: number;
}

/** Profile-synthesis sufficiency threshold (resolves planning Unknown 2). */
export interface ProfileSufficiencyDefinition {
  profileSignalTypes: string[];
  minimumFamilyRetention: number;
}

interface ContractModel {
  schemaVersion: string;
  status: string;
  tierIds: TierId[];
  families: Map<string, SourceFamilyDefinition>;
  consumers: Map<string, ConsumerDefinition>;
  deferredConsumers: Map<string, DeferredConsumerDefinition>;
  signalSemantics: Map<string, SignalSemanticDefinition>;
  compatibilityStates: Map<CompatibilityStateId, CompatibilityStateDefinition>;
  bounds: EvidenceTierBounds;
  profileSufficiency: ProfileSufficiencyDefinition;
  decisionNumber: number;
}

export class EvidenceTierContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceTierContractError";
  }
}

/** Supported source families the contract must never silently omit. */
export const REQUIRED_SOURCE_FAMILIES = [
  "codex",
  "cursor",
  "opencode",
  "copilot",
  "claude-code",
] as const;

/** Signal semantics whose required meaning must remain available. */
export const REQUIRED_SIGNAL_KINDS = [
  "correction",
  "decision",
  "question",
  "instruction",
  "configuration",
  "record_identity",
  "date",
  "evidence_anchor",
] as const;

/** Compatibility states that must have deterministic, actionable outcomes. */
export const REQUIRED_COMPATIBILITY_STATES = [
  "oversized",
  "legacy",
  "missing",
  "corrupt",
  "incomplete",
] as const;

/** Latent startup-analysis reader that must appear in the consumer map. */
export const STARTUP_ANALYSIS_CONSUMER = "startup_analysis";

/** Profile-synthesis consumer that must appear in the consumer map. */
export const PROFILE_SYNTHESIS_CONSUMER = "profile_synthesis";

/** Signal types the profile_synthesis consumer reads for bounded synthesis. */
export const PROFILE_SIGNAL_TYPES = [
  "decision",
  "question",
  "correction",
  "instruction",
  "configuration",
] as const;

export function evidenceTierAuthorityPath(root: string = resolveSourceRoot()): string {
  return path.join(root, "references", "analysis", "evidence-tier-authority.yaml");
}

function mapping(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  const m = mapping(value);
  if (m === null) {
    throw new EvidenceTierContractError(`${label} must be a mapping`);
  }
  return m;
}

function asMappingMap(
  value: unknown,
  label: string,
): Map<string, Record<string, unknown>> {
  const m = mapping(value);
  const out = new Map<string, Record<string, unknown>>();
  if (m === null) {
    throw new EvidenceTierContractError(`${label} must be a mapping`);
  }
  for (const [key, entry] of Object.entries(m)) {
    const em = mapping(entry);
    if (em === null) {
      throw new EvidenceTierContractError(`${label}.${key} must be a mapping`);
    }
    out.set(key, em);
  }
  return out;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new EvidenceTierContractError(`${label} must be a non-empty string`);
  }
  return value;
}

function asStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new EvidenceTierContractError(`${label} must be an array`);
  }
  return value.map((entry, i) => asString(entry, `${label}[${i}]`));
}

function asPositiveInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || Math.floor(value) !== value) {
    throw new EvidenceTierContractError(`${label} must be a positive integer`);
  }
  return value;
}

function asPositiveNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new EvidenceTierContractError(`${label} must be a positive number in (0, 1]`);
  }
  return value;
}

/**
 * A family declares either `source_product` (single string) or `source_products`
 * (list, e.g. cursor covers both Cursor and Cursor Agent). Normalize to a list
 * for uniform coverage checks. At least one product is required.
 */
function resolveSourceProduct(entry: Record<string, unknown>, label: string): string[] {
  const products = entry.source_products ?? entry.source_product;
  if (products === undefined) {
    throw new EvidenceTierContractError(`${label} must declare source_product or source_products`);
  }
  return Array.isArray(products) ? asStringArray(products, `${label}.source_products`) : [asString(products, `${label}.source_product`)];
}

/** Load and structurally validate the evidence-tier authority YAML. */
export function loadEvidenceTierContract(
  contractPath: string = evidenceTierAuthorityPath(),
): ContractModel {
  let raw: Record<string, unknown>;
  try {
    raw = loadYamlMappingFile(contractPath);
  } catch (error) {
    throw new EvidenceTierContractError(
      `evidence tier authority ${contractPath} is unreadable or malformed: ${(error as Error).message}`,
    );
  }

  const schemaVersion = asString(raw.schema_version, "schema_version");
  if (schemaVersion !== "agentera.evidenceTierAuthority.v1") {
    throw new EvidenceTierContractError(
      `evidence tier authority ${contractPath} has unsupported schema_version: ${schemaVersion}`,
    );
  }

  const tiersMap = asMappingMap(raw.tiers, "tiers");
  const tierIds: TierId[] = [];
  for (const [key, entry] of tiersMap) {
    if (key !== "full_evidence" && key !== "signal") {
      throw new EvidenceTierContractError(`tiers.${key} is not a recognized tier id`);
    }
    tierIds.push(key);
    const stored = asRecord(entry.stored_fields, `tiers.${key}.stored_fields`);
    asStringArray(stored.required, `tiers.${key}.stored_fields.required`);
  }

  const familiesMap = asMappingMap(
    asRecord(raw.source_families, "source_families").families,
    "source_families.families",
  );
  const families = new Map<string, SourceFamilyDefinition>();
  for (const [familyId, entry] of familiesMap) {
    const sourceClass = asString(entry.source_class, `source_families.families.${familyId}.source_class`);
    if (sourceClass !== "active_runtime" && sourceClass !== "historical_import") {
      throw new EvidenceTierContractError(
        `source_families.families.${familyId}.source_class must be active_runtime or historical_import`,
      );
    }
    families.set(familyId, {
      family_id: familyId,
      source_class: sourceClass,
      source_product: resolveSourceProduct(entry, `source_families.families.${familyId}`),
      active_runtime: Boolean(entry.active_runtime),
      inclusion_rule: typeof entry.inclusion_rule === "string" ? entry.inclusion_rule : undefined,
    });
  }

  const consumerMapRoot = asRecord(raw.consumer_map, "consumer_map");
  const consumersMap = asMappingMap(consumerMapRoot.consumers, "consumer_map.consumers");
  const consumers = new Map<string, ConsumerDefinition>();
  for (const [consumerId, entry] of consumersMap) {
    const tier = asString(entry.tier, `consumer_map.consumers.${consumerId}.tier`);
    if (tier !== "full_evidence" && tier !== "signal") {
      throw new EvidenceTierContractError(
        `consumer_map.consumers.${consumerId}.tier must be full_evidence or signal`,
      );
    }
    consumers.set(consumerId, {
      consumer_id: consumerId,
      tier,
      purpose: asString(entry.purpose, `consumer_map.consumers.${consumerId}.purpose`),
      required_fields: asStringArray(entry.required_fields, `consumer_map.consumers.${consumerId}.required_fields`),
      source_identity: asString(entry.source_identity, `consumer_map.consumers.${consumerId}.source_identity`),
      input_contract: asString(entry.input_contract, `consumer_map.consumers.${consumerId}.input_contract`),
    });
  }

  const deferredMap = asMappingMap(consumerMapRoot.deferred_consumers, "consumer_map.deferred_consumers");
  const deferredConsumers = new Map<string, DeferredConsumerDefinition>();
  for (const [consumerId, entry] of deferredMap) {
    deferredConsumers.set(consumerId, {
      consumer_id: consumerId,
      tier: asString(entry.tier, `consumer_map.deferred_consumers.${consumerId}.tier`) as TierId,
      status: asString(entry.status, `consumer_map.deferred_consumers.${consumerId}.status`),
      input_scope: typeof entry.input_scope === "string" ? entry.input_scope : undefined,
      excluded_evidence_classes: Array.isArray(entry.excluded_evidence_classes)
        ? asStringArray(
            entry.excluded_evidence_classes,
            `consumer_map.deferred_consumers.${consumerId}.excluded_evidence_classes`,
          )
        : [],
      required_semantics: asStringArray(
        entry.required_semantics,
        `consumer_map.deferred_consumers.${consumerId}.required_semantics`,
      ),
    });
  }

  const semanticsMap = asMappingMap(
    asRecord(raw.signal_semantics, "signal_semantics").kinds,
    "signal_semantics.kinds",
  );
  const signalSemantics = new Map<string, SignalSemanticDefinition>();
  for (const [kind, entry] of semanticsMap) {
    signalSemantics.set(kind, {
      kind,
      meaning: asString(entry.meaning, `signal_semantics.kinds.${kind}.meaning`),
      derivable_from: asString(entry.derivable_from, `signal_semantics.kinds.${kind}.derivable_from`),
      deferred_consumer: asString(entry.deferred_consumer, `signal_semantics.kinds.${kind}.deferred_consumer`),
      current_consumer: typeof entry.current_consumer === "string" ? entry.current_consumer : undefined,
    });
  }

  const statesMap = asMappingMap(
    asRecord(raw.compatibility_states, "compatibility_states").states,
    "compatibility_states.states",
  );
  const compatibilityStates = new Map<CompatibilityStateId, CompatibilityStateDefinition>();
  for (const [key, entry] of statesMap) {
    if (!REQUIRED_COMPATIBILITY_STATES.includes(key as CompatibilityStateId)) {
      throw new EvidenceTierContractError(`compatibility_states.states.${key} is not a recognized state`);
    }
    const stateId = key as CompatibilityStateId;
    const outcome = asString(entry.outcome, `compatibility_states.states.${key}.outcome`);
    if (outcome !== "recover" && outcome !== "degrade") {
      throw new EvidenceTierContractError(
        `compatibility_states.states.${key}.outcome must be recover or degrade`,
      );
    }
    compatibilityStates.set(stateId, {
      state_id: stateId,
      trigger: asString(entry.trigger, `compatibility_states.states.${key}.trigger`),
      status: asString(entry.status, `compatibility_states.states.${key}.status`),
      reason: asString(entry.reason, `compatibility_states.states.${key}.reason`),
      outcome,
      recovery: asString(entry.recovery, `compatibility_states.states.${key}.recovery`),
    });
  }

  const reconciliation = asRecord(raw.decision_55_reconciliation, "decision_55_reconciliation");

  const boundsRoot = asRecord(raw.bounds, "bounds");
  const bounds: EvidenceTierBounds = {
    readerByteCap: asPositiveInt(boundsRoot.reader_byte_cap, "bounds.reader_byte_cap"),
    shardByteCap: asPositiveInt(boundsRoot.shard_byte_cap, "bounds.shard_byte_cap"),
    signalByteCap: asPositiveInt(boundsRoot.signal_byte_cap, "bounds.signal_byte_cap"),
  };

  const suffRoot = asRecord(raw.profile_sufficiency, "profile_sufficiency");
  const profileSufficiency: ProfileSufficiencyDefinition = {
    profileSignalTypes: asStringArray(
      suffRoot.profile_signal_types,
      "profile_sufficiency.profile_signal_types",
    ),
    minimumFamilyRetention: asPositiveNumber(
      suffRoot.minimum_family_retention,
      "profile_sufficiency.minimum_family_retention",
    ),
  };

  return {
    schemaVersion,
    status: asString(raw.status, "status"),
    tierIds,
    families,
    consumers,
    deferredConsumers,
    signalSemantics,
    compatibilityStates,
    bounds,
    profileSufficiency,
    decisionNumber: typeof reconciliation.decision_number === "number"
      ? reconciliation.decision_number
      : 0,
  };
}

/** All declared source family ids (no family is silently omitted). */
export function supportedSourceFamilies(
  contractPath: string = evidenceTierAuthorityPath(),
): string[] {
  return [...loadEvidenceTierContract(contractPath).families.keys()];
}

/** All declared consumers with their bounded input contract and required fields. */
export function consumerMap(
  contractPath: string = evidenceTierAuthorityPath(),
): ConsumerDefinition[] {
  return [...loadEvidenceTierContract(contractPath).consumers.values()];
}

/** All declared signal semantics available to current and deferred consumers. */
export function signalSemantics(
  contractPath: string = evidenceTierAuthorityPath(),
): SignalSemanticDefinition[] {
  return [...loadEvidenceTierContract(contractPath).signalSemantics.values()];
}

/** All declared compatibility states with deterministic, actionable outcomes. */
export function compatibilityStates(
  contractPath: string = evidenceTierAuthorityPath(),
): CompatibilityStateDefinition[] {
  return [...loadEvidenceTierContract(contractPath).compatibilityStates.values()];
}

/**
 * Projected byte caps for full-evidence shards and the signal tier. These are
 * the bounds the publication writer and direct retriever enforce; they are read
 * from the authority rather than duplicated in callers.
 */
export function evidenceTierBounds(
  contractPath: string = evidenceTierAuthorityPath(),
): EvidenceTierBounds {
  return loadEvidenceTierContract(contractPath).bounds;
}

/**
 * Profile-synthesis sufficiency threshold (resolves planning Unknown 2). The
 * profile_signal_types and minimum_family_retention are the authority a bounded
 * profile reader projects when comparing the retained signal distribution
 * against the intended distribution. Callers must not re-declare these.
 */
export function profileSufficiency(
  contractPath: string = evidenceTierAuthorityPath(),
): ProfileSufficiencyDefinition {
  return loadEvidenceTierContract(contractPath).profileSufficiency;
}

/**
 * Validate the contract against its invariants. Returns a list of human-readable
 * errors; an empty list means the contract satisfies every Task 1 acceptance
 * invariant. Used by tests for both passing (production contract) and failing
 * (mutated fixture) checks.
 */
export function validateEvidenceTierContract(
  contractPath: string = evidenceTierAuthorityPath(),
): string[] {
  const errors: string[] = [];
  let model: ContractModel;
  try {
    model = loadEvidenceTierContract(contractPath);
  } catch (error) {
    return [(error as Error).message];
  }

  // AC1: every consumer has one bounded input contract supplying required fields
  // with source identity.
  for (const consumer of model.consumers.values()) {
    if (consumer.required_fields.length === 0) {
      errors.push(`consumer ${consumer.consumer_id} declares no required fields`);
    }
    if (!consumer.source_identity) {
      errors.push(`consumer ${consumer.consumer_id} has no source identity`);
    }
    if (!consumer.input_contract) {
      errors.push(`consumer ${consumer.consumer_id} has no input contract`);
    }
  }
  if (!model.consumers.has(STARTUP_ANALYSIS_CONSUMER)) {
    errors.push(`consumer map omits latent ${STARTUP_ANALYSIS_CONSUMER} reader`);
  }

  // AC2: no supported source family is silently omitted.
  for (const family of REQUIRED_SOURCE_FAMILIES) {
    if (!model.families.has(family)) {
      errors.push(`source family ${family} is omitted`);
    }
  }

  // AC3: signal semantics required meaning remains available to current and
  // declared deferred consumers.
  for (const kind of REQUIRED_SIGNAL_KINDS) {
    const semantic = model.signalSemantics.get(kind);
    if (!semantic) {
      errors.push(`signal semantic ${kind} is omitted`);
      continue;
    }
    if (!semantic.deferred_consumer) {
      errors.push(`signal semantic ${kind} has no declared deferred consumer`);
    }
  }
  for (const [name, deferred] of model.deferredConsumers) {
    for (const kind of deferred.required_semantics) {
      if (!model.signalSemantics.has(kind)) {
        errors.push(`deferred consumer ${name} requires unknown semantic ${kind}`);
      }
    }
  }
  const glossary = model.deferredConsumers.get("glossary");
  if (
    glossary?.status !== "declared_deferred" ||
    glossary.input_scope !== "bounded_personal_history" ||
    !glossary.excluded_evidence_classes.includes("project_file")
  ) {
    errors.push(
      "deferred glossary evidence must reserve bounded personal history and exclude project files",
    );
  }

  // AC4: every compatibility state is deterministic and actionable.
  for (const state of REQUIRED_COMPATIBILITY_STATES) {
    const def = model.compatibilityStates.get(state);
    if (!def) {
      errors.push(`compatibility state ${state} is omitted`);
      continue;
    }
    if (def.outcome !== "recover" && def.outcome !== "degrade") {
      errors.push(`compatibility state ${state} has non-deterministic outcome`);
    }
    if (!def.recovery) {
      errors.push(`compatibility state ${state} has no actionable recovery`);
    }
  }

  // Profile-synthesis sufficiency (Unknown 2): the consumer must appear, the
  // sufficiency model must declare profile signal types, and each declared
  // type must be a recognized signal semantic so the comparison is meaningful.
  if (!model.consumers.has(PROFILE_SYNTHESIS_CONSUMER)) {
    errors.push(`consumer map omits ${PROFILE_SYNTHESIS_CONSUMER} consumer`);
  }
  if (model.profileSufficiency.profileSignalTypes.length === 0) {
    errors.push("profile_sufficiency declares no profile_signal_types");
  }
  for (const kind of model.profileSufficiency.profileSignalTypes) {
    if (!model.signalSemantics.has(kind)) {
      errors.push(`profile_sufficiency references unknown signal semantic ${kind}`);
    }
  }

  // Decision 55 reconciliation: the decision is referenced, not rewritten.
  if (model.decisionNumber !== 55) {
    errors.push(`decision_55_reconciliation.decision_number is ${model.decisionNumber}, expected 55`);
  }

  return errors;
}
