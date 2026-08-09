import path from "node:path";

import { loadYamlMappingFile } from "../core/yaml.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import {
  canonicalGlossaryJson,
  compareGlossaryUnicodeStrings,
  glossaryCandidateRevision,
  glossaryCanonicalSha256,
  isGlossaryCandidateScope,
  stableGlossaryTermIdentity,
  type GlossaryCandidateEvidenceIdentity,
  type GlossaryCandidateScope,
} from "./glossaryTermIdentity.js";
import {
  glossaryEvidenceSetDigest,
  PERSONAL_REVIEW_DISPOSITIONS,
  type PersonalReviewDisposition,
} from "./glossaryMiningAuthority.js";
import {
  GLOSSARY_ADMISSION_OUTCOMES,
  GLOSSARY_ADMISSION_REASONS,
  hasGlossaryAdmissionReasonCodesByOutcome,
  validateGlossaryCandidateDecisionAuthority,
  type GlossaryAdmissionReason,
} from "./glossaryCandidateDecisionAuthority.js";

export { GLOSSARY_ADMISSION_REASONS, type GlossaryAdmissionReason } from "./glossaryCandidateDecisionAuthority.js";

export type GlossaryContractRecord = Record<string, unknown>;

type Mapping = GlossaryContractRecord;
type CandidateLayer =
  | "evidence_capsule"
  | "host_classification_receipt"
  | "cli_decision"
  | "review_record"
  | "publication_result";

const CANDIDATE_CONTRACTS_SCHEMA = "agentera.personalGlossaryCandidateContracts.v1";
const CANDIDATE_CONTRACTS_AUTHORITY = "candidate_contracts";
const LAYERS: readonly CandidateLayer[] = [
  "evidence_capsule",
  "host_classification_receipt",
  "cli_decision",
  "review_record",
  "publication_result",
];

const LAYER_OWNERS = {
  evidence_capsule: "deterministic_discovery_projection",
  host_classification_receipt: "semantic_host_classification",
  cli_decision: "deterministic_cli_admission_validation",
  review_record: "user_local_review_lifecycle",
  publication_result: "personal_profile_publication",
} as const;

const LAYER_SCHEMAS = {
  evidence_capsule: "agentera.personalGlossaryCandidateCapsule.v1",
  host_classification_receipt: "agentera.personalGlossaryHostClassificationReceipt.v1",
  cli_decision: "agentera.personalGlossaryAdmissionDecision.v1",
  review_record: "agentera.personalGlossaryReviewRecord.v1",
  publication_result: "agentera.personalGlossaryPublicationResult.v1",
} as const;

const BODY_DIGEST_FIELDS = {
  evidence_capsule: "capsule_sha256",
  host_classification_receipt: "receipt_sha256",
  cli_decision: "decision_sha256",
  review_record: "record_sha256",
  publication_result: "result_sha256",
} as const;

const LAYER_REQUIRED_FIELDS = {
  evidence_capsule: [
    "schema_version", "owner", "candidate_id", "candidate_revision", "term", "meaning", "scope",
    "provenance_kind", "evidence", "evidence_complete", "evidence_set_sha256", "policy_version",
    "generation", "capsule_sha256",
  ],
  host_classification_receipt: [
    "schema_version", "owner", "candidate_id", "candidate_revision", "candidate_capsule_sha256",
    "candidate_projection_sha256", "generation", "policy_version", "classification", "semantic_fingerprint", "receipt_sha256",
  ],
  cli_decision: [
    "schema_version", "owner", "candidate_id", "candidate_revision", "candidate_capsule_sha256",
    "candidate_projection_sha256", "host_receipt_sha256", "classification_contract_version", "semantic_fingerprint",
    "generation", "policy_version", "outcome", "reason", "decision_sha256",
  ],
  review_record: [
    "schema_version", "owner", "candidate_id", "candidate_revision", "candidate_capsule_sha256",
    "host_receipt_sha256", "cli_decision_sha256", "semantic_fingerprint", "generation", "policy_version",
    "disposition", "corrected_meaning", "disposed_at", "expires_at", "record_sha256",
  ],
  publication_result: [
    "schema_version", "owner", "candidate_id", "candidate_revision", "candidate_capsule_sha256",
    "decision_sha256", "review_record_sha256", "generation", "policy_version", "status",
    "profile_section_sha256", "published_at", "result_sha256",
  ],
} as const;

const LAYER_BINDING_FIELDS = {
  evidence_capsule: ["candidate_id", "candidate_revision", "generation", "policy_version"],
  host_classification_receipt: ["candidate_id", "candidate_revision", "candidate_capsule_sha256", "candidate_projection_sha256", "generation", "policy_version"],
  cli_decision: ["candidate_id", "candidate_revision", "candidate_capsule_sha256", "candidate_projection_sha256", "host_receipt_sha256", "classification_contract_version", "semantic_fingerprint", "generation", "policy_version"],
  review_record: ["candidate_id", "candidate_revision", "candidate_capsule_sha256", "host_receipt_sha256", "cli_decision_sha256", "semantic_fingerprint", "generation", "policy_version"],
  publication_result: ["candidate_id", "candidate_revision", "candidate_capsule_sha256", "decision_sha256", "generation", "policy_version"],
} as const;

const HOST_CLASSIFICATION_FIELDS = [
  "term",
  "meaning",
  "scope",
  "permanence",
  "consistency",
  "confidence",
] as const;

const ADMISSION_OUTCOMES = GLOSSARY_ADMISSION_OUTCOMES;
const CONSISTENCY_VALUES = ["consistent", "inconsistent", "uncertain"] as const;

export interface GlossaryEvidenceCapsule extends Mapping {
  schema_version: typeof LAYER_SCHEMAS.evidence_capsule;
  owner: typeof LAYER_OWNERS.evidence_capsule;
  candidate_id: string;
  candidate_revision: string;
  term: string;
  meaning: string;
  scope: GlossaryCandidateScope;
  provenance_kind: string;
  evidence: Mapping[];
  evidence_complete: true;
  evidence_set_sha256: string;
  policy_version: string;
  generation: string;
  capsule_sha256: string;
}

export interface GlossaryHostClassification extends Mapping {
  term: string;
  meaning: string;
  scope: GlossaryCandidateScope;
  permanence: string;
  consistency: string;
  confidence: number;
}

export interface GlossaryHostClassificationReceipt extends Mapping {
  schema_version: typeof LAYER_SCHEMAS.host_classification_receipt;
  owner: typeof LAYER_OWNERS.host_classification_receipt;
  candidate_id: string;
  candidate_revision: string;
  candidate_capsule_sha256: string;
  candidate_projection_sha256: string;
  generation: string;
  policy_version: string;
  classification: GlossaryHostClassification;
  semantic_fingerprint: string;
  receipt_sha256: string;
}

export interface GlossaryAdmissionDecision extends Mapping {
  schema_version: typeof LAYER_SCHEMAS.cli_decision;
  owner: typeof LAYER_OWNERS.cli_decision;
  candidate_id: string;
  candidate_revision: string;
  candidate_capsule_sha256: string;
  candidate_projection_sha256: string;
  host_receipt_sha256: string;
  classification_contract_version: string;
  semantic_fingerprint: string;
  generation: string;
  policy_version: string;
  outcome: (typeof ADMISSION_OUTCOMES)[number];
  reason: GlossaryAdmissionReason;
  decision_sha256: string;
}

export interface GlossaryReviewRecord extends Mapping {
  schema_version: typeof LAYER_SCHEMAS.review_record;
  owner: typeof LAYER_OWNERS.review_record;
  candidate_id: string;
  candidate_revision: string;
  candidate_capsule_sha256: string;
  host_receipt_sha256: string;
  cli_decision_sha256: string;
  semantic_fingerprint: string;
  generation: string;
  policy_version: string;
  disposition: PersonalReviewDisposition;
  corrected_meaning: string | null;
  disposed_at: string;
  expires_at: string;
  record_sha256: string;
}

export interface GlossaryPublicationResult extends Mapping {
  schema_version: typeof LAYER_SCHEMAS.publication_result;
  owner: typeof LAYER_OWNERS.publication_result;
  candidate_id: string;
  candidate_revision: string;
  candidate_capsule_sha256: string;
  decision_sha256: string;
  review_record_sha256: string | null;
  generation: string;
  policy_version: string;
  status: string;
  profile_section_sha256: string;
  published_at: string | null;
  result_sha256: string;
}

function mapping(value: unknown): Mapping | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Mapping)
    : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function exactStrings(actual: unknown, expected: readonly string[]): boolean {
  return JSON.stringify(strings(actual)) === JSON.stringify(expected);
}

function exactFields(value: Mapping, fields: readonly string[], label: string): string[] {
  const errors: string[] = [];
  const missing = fields.filter((field) => !(field in value));
  const extra = Object.keys(value).filter((field) => !fields.includes(field));
  if (missing.length > 0) errors.push(`${label} is missing fields: ${missing.join(", ")}`);
  if (extra.length > 0) errors.push(`${label} contains fields outside its contract: ${extra.join(", ")}`);
  return errors;
}

function compareRecords(left: Mapping, right: Mapping): number {
  return compareGlossaryUnicodeStrings(canonicalGlossaryJson(left), canonicalGlossaryJson(right));
}

function sortEvidence(evidence: readonly Mapping[]): Mapping[] {
  return evidence.map((item) => ({ ...item })).sort(compareRecords);
}

function bodyWithoutDigest(value: Mapping, field: string): Mapping {
  const body = { ...value };
  delete body[field];
  return body;
}

function timestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

function utf8Within(value: unknown, maxBytes: number): value is string {
  return nonEmpty(value) && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function candidateAuthorityPath(root: string = resolveSourceRoot()): string {
  return path.join(root, "references", "artifacts", "glossary-entry-contract.yaml");
}

export function glossaryCandidateContractsAuthorityPath(root: string = resolveSourceRoot()): string {
  return candidateAuthorityPath(root);
}

function loadAuthority(pathname: string): Mapping {
  return loadYamlMappingFile(pathname) as Mapping;
}

function loadCandidateAuthority(pathname: string): { authority: Mapping; candidate: Mapping } | null {
  try {
    const authority = loadAuthority(pathname);
    const candidate = mapping(authority[CANDIDATE_CONTRACTS_AUTHORITY]);
    return candidate ? { authority, candidate } : null;
  } catch {
    return null;
  }
}

function loadedContract(pathname: string): { authority: Mapping; candidate: Mapping; errors: string[] } {
  const loaded = loadCandidateAuthority(pathname);
  if (!loaded) {
    return {
      authority: {},
      candidate: {},
      errors: ["candidate_contracts authority could not be loaded"],
    };
  }
  return { ...loaded, errors: [] };
}

function contractLayer(value: unknown, name: CandidateLayer): Mapping | null {
  const candidate = mapping(value);
  return mapping(candidate?.layers)?.[name] as Mapping | null;
}

function validateLayerEnvelope(value: Mapping, layerAuthority: Mapping, name: CandidateLayer): string[] {
  const required = strings(layerAuthority.required_fields);
  const errors = exactFields(value, required, `candidate_contracts.layers.${name}`);
  if (layerAuthority.additional_fields !== "forbidden") {
    errors.push(`candidate_contracts.layers.${name}.additional_fields must be forbidden`);
  }
  if (layerAuthority.owner !== LAYER_OWNERS[name]) {
    errors.push(`candidate_contracts.layers.${name}.owner is invalid`);
  }
  if (layerAuthority.schema_version !== LAYER_SCHEMAS[name]) {
    errors.push(`candidate_contracts.layers.${name}.schema_version is invalid`);
  }
  return errors;
}

function candidateBounds(candidate: Mapping): Mapping {
  return mapping(candidate.bounds) ?? {};
}

function validateBoundedIdentityFields(value: Mapping, candidate: Mapping, label: string): string[] {
  const bounds = candidateBounds(candidate);
  const errors: string[] = [];
  const identityMax = Number(bounds.binding_max_utf8_bytes ?? 0);
  const meaningMax = Number(bounds.meaning_max_utf8_bytes ?? 0);
  const termMax = Number(bounds.term_max_utf8_bytes ?? 0);
  for (const field of ["candidate_id", "candidate_revision", "generation", "policy_version"]) {
    if (!utf8Within(value[field], field.startsWith("candidate_") ? 64 : identityMax)) {
      errors.push(`${label}.${field} is outside its binding bound`);
    }
  }
  if (!utf8Within(value.term, termMax)) errors.push(`${label}.term is outside its bound`);
  if (!utf8Within(value.meaning, meaningMax)) errors.push(`${label}.meaning is outside its bound`);
  return errors;
}

function validateSharedClassification(
  classification: Mapping,
  authority: Mapping,
  candidate: Mapping,
  label: string,
): string[] {
  const classificationAuthority = mapping(contractLayer(candidate, "host_classification_receipt")?.classification);
  const fields = strings(classificationAuthority?.fields);
  const errors = exactFields(classification, fields, label);
  const primitive = mapping(authority.shared_primitive);
  const permanence = mapping(mapping(primitive?.fields)?.permanence);
  const consistencyValues = strings(classificationAuthority?.consistency_values);
  const bounds = candidateBounds(candidate);
  if (!utf8Within(classification.term, Number(bounds.term_max_utf8_bytes ?? 0))) {
    errors.push(`${label}.term is outside its bound`);
  }
  if (!utf8Within(classification.meaning, Number(bounds.meaning_max_utf8_bytes ?? 0))) {
    errors.push(`${label}.meaning is outside its bound`);
  }
  if (!isGlossaryCandidateScope(classification.scope)) errors.push(`${label}.scope is invalid`);
  if (!strings(permanence?.values).includes(String(classification.permanence))) {
    errors.push(`${label}.permanence is invalid`);
  }
  if (!consistencyValues.includes(String(classification.consistency))) {
    errors.push(`${label}.consistency is invalid`);
  }
  if (!Number.isInteger(classification.confidence) || Number(classification.confidence) < 0 || Number(classification.confidence) > 100) {
    errors.push(`${label}.confidence must be an integer from shared_primitive.fields.confidence`);
  }
  return errors;
}

function validateProvenanceEvidence(
  capsule: Mapping,
  authority: Mapping,
  candidate: Mapping,
): string[] {
  const errors: string[] = [];
  const kind = capsule.provenance_kind;
  const allowedKinds = strings(mapping(mapping(authority.ownership_contracts)?.personal)?.allowed_provenance);
  if (!nonEmpty(kind) || !allowedKinds.includes(kind)) {
    errors.push("evidence_capsule.provenance_kind is not an allowed personal provenance variant");
    return errors;
  }
  const variant = mapping(mapping(authority.provenance_variants)?.[kind]);
  if (!variant) {
    errors.push("evidence_capsule.provenance_kind has no provenance variant");
    return errors;
  }
  const evidence = capsule.evidence;
  if (!Array.isArray(evidence)) {
    errors.push("evidence_capsule.evidence must be a list");
    return errors;
  }
  const maxRecords = Number(candidateBounds(candidate).evidence_records_max ?? 0);
  if (evidence.length === 0 || evidence.length > maxRecords) {
    errors.push("evidence_capsule.evidence is outside its record bound");
  }
  const required = strings(variant.required_evidence_fields);
  const expectedCount = variant.evidence_count === "variable" ? null : Number(variant.evidence_count);
  const minimum = Number(variant.minimum_evidence_count ?? expectedCount ?? 0);
  if ((expectedCount !== null && evidence.length !== expectedCount) || (expectedCount === null && evidence.length < minimum)) {
    errors.push("evidence_capsule.evidence count does not satisfy its provenance variant");
  }
  const allowedSignals = strings(variant.allowed_signal_types);
  const allowedSources = strings(variant.allowed_source_kinds);
  const allowedAuthors = strings(variant.allowed_author_classes);
  const distinctness = mapping(variant.distinctness);
  for (const [index, item] of evidence.entries()) {
    const itemMapping = mapping(item);
    if (!itemMapping) {
      errors.push(`evidence_capsule.evidence[${index}] must be an object`);
      continue;
    }
    errors.push(...exactFields(itemMapping, required, `evidence_capsule.evidence[${index}]`));
    for (const field of required) {
      if (!nonEmpty(itemMapping[field])) errors.push(`evidence_capsule.evidence[${index}].${field} must be non-empty`);
    }
    if ("signal_type" in itemMapping && !allowedSignals.includes(String(itemMapping.signal_type))) {
      errors.push(`evidence_capsule.evidence[${index}].signal_type is invalid`);
    }
    if ("source_kind" in itemMapping && !allowedSources.includes(String(itemMapping.source_kind))) {
      errors.push(`evidence_capsule.evidence[${index}].source_kind is invalid`);
    }
    if ("author_class" in itemMapping && !allowedAuthors.includes(String(itemMapping.author_class))) {
      errors.push(`evidence_capsule.evidence[${index}].author_class is invalid`);
    }
    if ("content_fingerprint" in itemMapping && !digest(itemMapping.content_fingerprint)) {
      errors.push(`evidence_capsule.evidence[${index}].content_fingerprint must be lowercase SHA-256`);
    }
  }
  const sorted = sortEvidence(evidence as Mapping[]);
  if (JSON.stringify(evidence) !== JSON.stringify(sorted)) {
    errors.push("evidence_capsule.evidence must be in canonical evidence order");
  }
  for (const [field, requiredDistinct] of Object.entries(distinctness ?? {})) {
    const evidenceField = field.endsWith("s") ? field.slice(0, -1) : field;
    const values = evidence.map((item) => mapping(item)?.[evidenceField]);
    if (new Set(values).size < Number(requiredDistinct)) {
      errors.push(`evidence_capsule.evidence requires ${requiredDistinct} distinct ${evidenceField}`);
    }
  }
  if (capsule.evidence_complete !== true) errors.push("evidence_capsule.evidence_complete must be true");
  if (!digest(capsule.evidence_set_sha256)) {
    errors.push("evidence_capsule.evidence_set_sha256 must be lowercase SHA-256");
  } else {
    try {
      const anchors = evidence.map((item) => String(mapping(item)?.evidence_anchor));
      if (capsule.evidence_set_sha256 !== glossaryEvidenceSetDigest(String(capsule.generation), anchors)) {
        errors.push("evidence_capsule.evidence_set_sha256 does not match generation and anchors");
      }
    } catch {
      errors.push("evidence_capsule.evidence_set_sha256 cannot be computed from evidence anchors");
    }
  }
  return errors;
}

function validateCapsuleIdentity(capsule: Mapping): string[] {
  const errors: string[] = [];
  if (!digest(capsule.candidate_id)) errors.push("evidence_capsule.candidate_id must be lowercase SHA-256");
  if (!digest(capsule.candidate_revision)) errors.push("evidence_capsule.candidate_revision must be lowercase SHA-256");
  if (!digest(capsule.capsule_sha256)) errors.push("evidence_capsule.capsule_sha256 must be lowercase SHA-256");
  if (nonEmpty(capsule.term) && stableGlossaryTermIdentity(capsule.term) !== capsule.candidate_id) {
    errors.push("evidence_capsule.candidate_id does not match stable term identity");
  }
  return errors;
}

export function validateGlossaryEvidenceCapsule(
  capsule: Mapping,
  pathname: string = candidateAuthorityPath(),
): string[] {
  const loaded = loadedContract(pathname);
  if (loaded.errors.length > 0) return loaded.errors;
  const layerAuthority = contractLayer(loaded.candidate, "evidence_capsule");
  if (!layerAuthority) return ["candidate_contracts.layers.evidence_capsule is missing"];
  const errors = validateLayerEnvelope(capsule, layerAuthority, "evidence_capsule");
  errors.push(...validateBoundedIdentityFields(capsule, loaded.candidate, "evidence_capsule"));
  errors.push(...validateCapsuleIdentity(capsule));
  if (capsule.schema_version !== LAYER_SCHEMAS.evidence_capsule) errors.push("evidence_capsule.schema_version is invalid");
  if (capsule.owner !== LAYER_OWNERS.evidence_capsule) errors.push("evidence_capsule.owner is invalid");
  if (!isGlossaryCandidateScope(capsule.scope)) errors.push("evidence_capsule.scope is invalid");
  errors.push(...validateProvenanceEvidence(capsule, loaded.authority, loaded.candidate));
  if (digest(capsule.capsule_sha256) && capsule.capsule_sha256 !== glossaryCanonicalSha256(bodyWithoutDigest(capsule, "capsule_sha256"))) {
    errors.push("evidence_capsule.capsule_sha256 does not match canonical capsule bytes");
  }
  if (digest(capsule.candidate_revision) && Array.isArray(capsule.evidence) && isGlossaryCandidateScope(capsule.scope)) {
    try {
      const revision = glossaryCandidateRevision({
        stable_term_identity: String(capsule.candidate_id),
        meaning: String(capsule.meaning),
        scope: capsule.scope,
        evidence: capsule.evidence as GlossaryCandidateEvidenceIdentity[],
        policy_version: String(capsule.policy_version),
        generation: String(capsule.generation),
      });
      if (revision !== capsule.candidate_revision) errors.push("evidence_capsule.candidate_revision is not current-helper output");
    } catch {
      errors.push("evidence_capsule.candidate_revision cannot be computed from its bound fields");
    }
  }
  return errors;
}

export function createGlossaryEvidenceCapsule(input: {
  term: string;
  meaning: string;
  scope: GlossaryCandidateScope;
  provenance_kind: string;
  evidence: readonly Mapping[];
  policy_version: string;
  generation: string;
}): GlossaryEvidenceCapsule {
  const evidence = sortEvidence(input.evidence);
  const candidateId = stableGlossaryTermIdentity(input.term);
  const candidateRevision = glossaryCandidateRevision({
    stable_term_identity: candidateId,
    meaning: input.meaning,
    scope: input.scope,
    evidence: evidence as GlossaryCandidateEvidenceIdentity[],
    policy_version: input.policy_version,
    generation: input.generation,
  });
  const capsule = {
    schema_version: LAYER_SCHEMAS.evidence_capsule,
    owner: LAYER_OWNERS.evidence_capsule,
    candidate_id: candidateId,
    candidate_revision: candidateRevision,
    term: input.term,
    meaning: input.meaning,
    scope: input.scope,
    provenance_kind: input.provenance_kind,
    evidence,
    evidence_complete: true,
    evidence_set_sha256: glossaryEvidenceSetDigest(input.generation, evidence.map((item) => String(item.evidence_anchor))),
    policy_version: input.policy_version,
    generation: input.generation,
  } as GlossaryContractRecord;
  capsule.capsule_sha256 = glossaryCanonicalSha256(capsule);
  const errors = validateGlossaryEvidenceCapsule(capsule);
  if (errors.length > 0) throw new TypeError(errors.join("; "));
  return capsule as GlossaryEvidenceCapsule;
}

export interface GlossaryHostReceiptValidationContext {
  candidateProjectionSha256: string;
}

function validateHostBindings(
  receipt: Mapping,
  capsule: Mapping,
  layerAuthority: Mapping,
  context: GlossaryHostReceiptValidationContext,
): string[] {
  const errors: string[] = [];
  for (const field of strings(layerAuthority.binding_fields)) {
    const expected = field === "candidate_capsule_sha256"
      ? capsule.capsule_sha256
      : field === "candidate_projection_sha256"
        ? context.candidateProjectionSha256
        : capsule[field];
    if (receipt[field] !== expected) {
      errors.push(
        field === "candidate_projection_sha256"
          ? "host_classification_receipt.candidate_projection_sha256 does not match the current projection"
          : `host_classification_receipt.${field} does not match the capsule`,
      );
    }
  }
  return errors;
}

export function glossaryHostSemanticFingerprint(classification: Mapping): string {
  return glossaryCanonicalSha256(classification);
}

export function validateGlossaryHostClassificationReceipt(
  receipt: Mapping,
  capsule: Mapping,
  context: GlossaryHostReceiptValidationContext,
  pathname: string = candidateAuthorityPath(),
): string[] {
  const loaded = loadedContract(pathname);
  if (loaded.errors.length > 0) return loaded.errors;
  const errors = validateGlossaryEvidenceCapsule(capsule, pathname);
  const layerAuthority = contractLayer(loaded.candidate, "host_classification_receipt");
  if (!layerAuthority) return [...errors, "candidate_contracts.layers.host_classification_receipt is missing"];
  errors.push(...validateLayerEnvelope(receipt, layerAuthority, "host_classification_receipt"));
  if (receipt.schema_version !== LAYER_SCHEMAS.host_classification_receipt) {
    errors.push("host_classification_receipt.schema_version is invalid");
  }
  if (receipt.owner !== LAYER_OWNERS.host_classification_receipt) {
    errors.push("host_classification_receipt.owner is invalid");
  }
  if (!digest(context.candidateProjectionSha256)) {
    errors.push("host_classification_receipt validation requires a current candidate projection SHA-256");
  }
  errors.push(...validateHostBindings(receipt, capsule, layerAuthority, context));
  if (!digest(receipt.candidate_projection_sha256)) {
    errors.push("host_classification_receipt.candidate_projection_sha256 must be lowercase SHA-256");
  }
  const classification = mapping(receipt.classification);
  if (!classification) {
    errors.push("host_classification_receipt.classification must be an object");
  } else {
    errors.push(...validateSharedClassification(classification, loaded.authority, loaded.candidate, "host_classification_receipt.classification"));
    if (nonEmpty(classification.term) && stableGlossaryTermIdentity(classification.term) !== capsule.candidate_id) {
      errors.push("host_classification_receipt.classification.term changes stable term identity");
    }
  if (digest(receipt.semantic_fingerprint) && receipt.semantic_fingerprint !== glossaryHostSemanticFingerprint(classification)) {
      errors.push("host_classification_receipt.semantic_fingerprint does not match classification");
    }
    if (!digest(receipt.semantic_fingerprint)) errors.push("host_classification_receipt.semantic_fingerprint must be lowercase SHA-256");
  }
  const forbidden = strings(layerAuthority.forbidden_fields);
  for (const field of forbidden) {
    if (field in receipt || (classification !== null && field in classification)) {
      errors.push(`host_classification_receipt contains forbidden authority field: ${field}`);
    }
  }
  if (digest(receipt.receipt_sha256) && receipt.receipt_sha256 !== glossaryCanonicalSha256(bodyWithoutDigest(receipt, "receipt_sha256"))) {
    errors.push("host_classification_receipt.receipt_sha256 does not match canonical receipt bytes");
  }
  if (!digest(receipt.receipt_sha256)) errors.push("host_classification_receipt.receipt_sha256 must be lowercase SHA-256");
  return errors;
}

export function createGlossaryHostClassificationReceipt(input: {
  capsule: GlossaryEvidenceCapsule;
  candidate_projection_sha256: string;
  classification: GlossaryHostClassification;
}): GlossaryHostClassificationReceipt {
  const receipt = {
    schema_version: LAYER_SCHEMAS.host_classification_receipt,
    owner: LAYER_OWNERS.host_classification_receipt,
    candidate_id: input.capsule.candidate_id,
    candidate_revision: input.capsule.candidate_revision,
    candidate_capsule_sha256: input.capsule.capsule_sha256,
    candidate_projection_sha256: input.candidate_projection_sha256,
    generation: input.capsule.generation,
    policy_version: input.capsule.policy_version,
    classification: { ...input.classification },
    semantic_fingerprint: glossaryHostSemanticFingerprint(input.classification),
  } as GlossaryContractRecord;
  receipt.receipt_sha256 = glossaryCanonicalSha256(receipt);
  const errors = validateGlossaryHostClassificationReceipt(receipt, input.capsule, {
    candidateProjectionSha256: input.candidate_projection_sha256,
  });
  if (errors.length > 0) throw new TypeError(errors.join("; "));
  return receipt as GlossaryHostClassificationReceipt;
}

export function validateGlossaryAdmissionDecision(
  decision: Mapping,
  capsule: Mapping,
  receipt: Mapping,
  pathname: string = candidateAuthorityPath(),
): string[] {
  const loaded = loadedContract(pathname);
  if (loaded.errors.length > 0) return loaded.errors;
  const errors = [
    ...validateGlossaryEvidenceCapsule(capsule, pathname),
    ...validateGlossaryHostClassificationReceipt(receipt, capsule, {
      candidateProjectionSha256: String(decision.candidate_projection_sha256),
    }, pathname),
  ];
  const layerAuthority = contractLayer(loaded.candidate, "cli_decision");
  if (!layerAuthority) return [...errors, "candidate_contracts.layers.cli_decision is missing"];
  errors.push(...validateLayerEnvelope(decision, layerAuthority, "cli_decision"));
  if (decision.schema_version !== LAYER_SCHEMAS.cli_decision) {
    errors.push("cli_decision.schema_version is invalid");
  }
  if (decision.owner !== LAYER_OWNERS.cli_decision) {
    errors.push("cli_decision.owner is invalid");
  }
  if (!exactStrings(layerAuthority.outcomes, ADMISSION_OUTCOMES)) errors.push("cli_decision.outcomes are not the approved vocabulary");
  if (!ADMISSION_OUTCOMES.includes(decision.outcome as (typeof ADMISSION_OUTCOMES)[number])) {
    errors.push("cli_decision.outcome is invalid");
  }
  if (!utf8Within(decision.reason, Number(candidateBounds(loaded.candidate).reason_max_utf8_bytes ?? 0))) {
    errors.push("cli_decision.reason is outside its bound");
  }
  if (!exactStrings(layerAuthority.reason_codes, GLOSSARY_ADMISSION_REASONS)) errors.push("cli_decision.reason_codes are not the approved vocabulary");
  if (!hasGlossaryAdmissionReasonCodesByOutcome(layerAuthority.reason_codes_by_outcome)) errors.push("cli_decision.reason_codes_by_outcome is not authoritative");
  if (!strings(mapping(layerAuthority.reason_codes_by_outcome)?.[String(decision.outcome)]).includes(String(decision.reason))) errors.push("cli_decision.reason is not allowed for cli_decision.outcome");
  if (decision.candidate_id !== capsule.candidate_id || decision.candidate_revision !== capsule.candidate_revision || decision.candidate_capsule_sha256 !== capsule.capsule_sha256 || decision.generation !== capsule.generation || decision.policy_version !== capsule.policy_version) {
    errors.push("cli_decision bindings do not match the capsule");
  }
  if (decision.candidate_projection_sha256 !== receipt.candidate_projection_sha256) {
    errors.push("cli_decision.candidate_projection_sha256 does not match the host receipt");
  }
  if (decision.host_receipt_sha256 !== receipt.receipt_sha256) errors.push("cli_decision.host_receipt_sha256 does not match the host receipt");
  if (decision.classification_contract_version !== receipt.schema_version) {
    errors.push("cli_decision.classification_contract_version does not match the host receipt");
  }
  if (decision.semantic_fingerprint !== receipt.semantic_fingerprint) {
    errors.push("cli_decision.semantic_fingerprint does not match the host receipt");
  }
  const automatic = mapping(layerAuthority.automatic_admission);
  const automaticClassification = mapping(automatic?.required_classification);
  if (decision.outcome === "automatic_admission") {
    if (capsule.provenance_kind !== automatic?.allowed_provenance?.toString().replace("provenance_variants.", "")) {
      errors.push("cli_decision automatic_admission is disabled for inferred provenance");
    }
    const classification = mapping(receipt.classification);
    if (
      classification?.scope !== automaticClassification?.scope ||
      classification?.consistency !== automaticClassification?.consistency ||
      classification?.term !== capsule.term ||
      classification?.meaning !== capsule.meaning
    ) {
      errors.push("cli_decision automatic_admission requires the exact personal consistent capsule classification");
    }
  }
  const miningAdmission = mapping(mapping(loaded.authority.personal_mining_authority)?.admission);
  if (miningAdmission?.inferred_automatic_admission !== "disabled") errors.push("inferred automatic admission must remain disabled");
  if (digest(decision.decision_sha256) && decision.decision_sha256 !== glossaryCanonicalSha256(bodyWithoutDigest(decision, "decision_sha256"))) {
    errors.push("cli_decision.decision_sha256 does not match canonical decision bytes");
  }
  if (!digest(decision.decision_sha256)) errors.push("cli_decision.decision_sha256 must be lowercase SHA-256");
  return errors;
}

export function createGlossaryAdmissionDecision(input: {
  capsule: GlossaryEvidenceCapsule;
  receipt: GlossaryHostClassificationReceipt;
  outcome: (typeof ADMISSION_OUTCOMES)[number];
  reason: GlossaryAdmissionReason;
}): GlossaryAdmissionDecision {
  const decision = {
    schema_version: LAYER_SCHEMAS.cli_decision,
    owner: LAYER_OWNERS.cli_decision,
    candidate_id: input.capsule.candidate_id,
    candidate_revision: input.capsule.candidate_revision,
    candidate_capsule_sha256: input.capsule.capsule_sha256,
    candidate_projection_sha256: input.receipt.candidate_projection_sha256,
    host_receipt_sha256: input.receipt.receipt_sha256,
    classification_contract_version: input.receipt.schema_version,
    semantic_fingerprint: input.receipt.semantic_fingerprint,
    generation: input.capsule.generation,
    policy_version: input.capsule.policy_version,
    outcome: input.outcome,
    reason: input.reason,
  } as GlossaryContractRecord;
  decision.decision_sha256 = glossaryCanonicalSha256(decision);
  const errors = validateGlossaryAdmissionDecision(decision, input.capsule, input.receipt);
  if (errors.length > 0) throw new TypeError(errors.join("; "));
  return decision as GlossaryAdmissionDecision;
}

function validateReviewTimeFields(record: Mapping): string[] {
  const errors: string[] = [];
  if (!timestamp(record.disposed_at)) errors.push("review_record.disposed_at must be an ISO timestamp");
  if (!timestamp(record.expires_at)) errors.push("review_record.expires_at must be an ISO timestamp");
  if (timestamp(record.disposed_at) && timestamp(record.expires_at) && Date.parse(record.expires_at) < Date.parse(record.disposed_at)) {
    errors.push("review_record.expires_at must not precede disposed_at");
  }
  return errors;
}

export function validateGlossaryReviewRecord(
  record: Mapping,
  capsule: Mapping,
  receipt: Mapping,
  decision: Mapping,
  pathname: string = candidateAuthorityPath(),
): string[] {
  const loaded = loadedContract(pathname);
  if (loaded.errors.length > 0) return loaded.errors;
  const errors = validateGlossaryAdmissionDecision(decision, capsule, receipt, pathname);
  const layerAuthority = contractLayer(loaded.candidate, "review_record");
  if (!layerAuthority) return [...errors, "candidate_contracts.layers.review_record is missing"];
  errors.push(...validateLayerEnvelope(record, layerAuthority, "review_record"));
  if (decision.outcome !== "review_required") errors.push("review_record requires a review_required CLI decision");
  const expectedBindings: Record<string, unknown> = {
    candidate_id: capsule.candidate_id,
    candidate_revision: capsule.candidate_revision,
    candidate_capsule_sha256: capsule.capsule_sha256,
    host_receipt_sha256: receipt.receipt_sha256,
    cli_decision_sha256: decision.decision_sha256,
    semantic_fingerprint: receipt.semantic_fingerprint,
    generation: capsule.generation,
    policy_version: capsule.policy_version,
  };
  for (const [field, expected] of Object.entries(expectedBindings)) {
    if (record[field] !== expected) errors.push(`review_record.${field} does not match its source layer`);
  }
  const reviews = mapping(mapping(loaded.authority.personal_mining_authority)?.privacy)?.reviews;
  const dispositions = strings(mapping(reviews)?.dispositions);
  if (!dispositions.includes(String(record.disposition)) || !PERSONAL_REVIEW_DISPOSITIONS.includes(record.disposition as PersonalReviewDisposition)) {
    errors.push("review_record.disposition is invalid");
  }
  const correctedMax = Number(candidateBounds(loaded.candidate).corrected_meaning_max_utf8_bytes ?? 0);
  if (record.disposition === "correct") {
    if (!utf8Within(record.corrected_meaning, correctedMax)) errors.push("review_record.corrected_meaning is required and outside its bound");
  } else if (record.corrected_meaning !== null) {
    errors.push("review_record.corrected_meaning must be null unless disposition is correct");
  }
  errors.push(...validateReviewTimeFields(record));
  if (digest(record.record_sha256) && record.record_sha256 !== glossaryCanonicalSha256(bodyWithoutDigest(record, "record_sha256"))) {
    errors.push("review_record.record_sha256 does not match canonical review bytes");
  }
  if (!digest(record.record_sha256)) errors.push("review_record.record_sha256 must be lowercase SHA-256");
  return errors;
}

export function createGlossaryReviewRecord(input: {
  capsule: GlossaryEvidenceCapsule;
  receipt: GlossaryHostClassificationReceipt;
  decision: GlossaryAdmissionDecision;
  disposition: PersonalReviewDisposition;
  corrected_meaning: string | null;
  disposed_at: string;
  expires_at: string;
}): GlossaryReviewRecord {
  const record = {
    schema_version: LAYER_SCHEMAS.review_record,
    owner: LAYER_OWNERS.review_record,
    candidate_id: input.capsule.candidate_id,
    candidate_revision: input.capsule.candidate_revision,
    candidate_capsule_sha256: input.capsule.capsule_sha256,
    host_receipt_sha256: input.receipt.receipt_sha256,
    cli_decision_sha256: input.decision.decision_sha256,
    semantic_fingerprint: input.receipt.semantic_fingerprint,
    generation: input.capsule.generation,
    policy_version: input.capsule.policy_version,
    disposition: input.disposition,
    corrected_meaning: input.corrected_meaning,
    disposed_at: input.disposed_at,
    expires_at: input.expires_at,
  } as GlossaryContractRecord;
  record.record_sha256 = glossaryCanonicalSha256(record);
  const errors = validateGlossaryReviewRecord(record, input.capsule, input.receipt, input.decision);
  if (errors.length > 0) throw new TypeError(errors.join("; "));
  return record as GlossaryReviewRecord;
}

export function validateGlossaryPublicationResult(
  result: Mapping,
  capsule: Mapping,
  receipt: Mapping,
  decision: Mapping,
  review: Mapping | null,
  pathname: string = candidateAuthorityPath(),
): string[] {
  const loaded = loadedContract(pathname);
  if (loaded.errors.length > 0) return loaded.errors;
  const errors = validateGlossaryAdmissionDecision(decision, capsule, receipt, pathname);
  const layerAuthority = contractLayer(loaded.candidate, "publication_result");
  if (!layerAuthority) return [...errors, "candidate_contracts.layers.publication_result is missing"];
  errors.push(...validateLayerEnvelope(result, layerAuthority, "publication_result"));
  const profile = mapping(mapping(loaded.authority.ownership_contracts)?.personal)?.profile_output;
  const command = mapping(mapping(profile)?.command);
  const statuses = strings(command?.output_statuses);
  if (!statuses.includes(String(result.status))) errors.push("publication_result.status is not an existing profile output status");
  const expectedBindings: Record<string, unknown> = {
    candidate_id: capsule.candidate_id,
    candidate_revision: capsule.candidate_revision,
    candidate_capsule_sha256: capsule.capsule_sha256,
    decision_sha256: decision.decision_sha256,
    generation: capsule.generation,
    policy_version: capsule.policy_version,
  };
  for (const [field, expected] of Object.entries(expectedBindings)) {
    if (result[field] !== expected) errors.push(`publication_result.${field} does not match its source layer`);
  }
  if (decision.outcome === "automatic_admission" && result.review_record_sha256 !== null) {
    errors.push("publication_result must not bind a review record for automatic admission");
  }
  if (decision.outcome === "review_required") {
    if (!review) errors.push("publication_result requires a review record");
    else {
      errors.push(...validateGlossaryReviewRecord(review, capsule, receipt, decision, pathname));
      if (result.review_record_sha256 !== review.record_sha256) errors.push("publication_result.review_record_sha256 does not match review record");
      if (!["accept", "correct"].includes(String(review.disposition))) errors.push("publication_result review disposition is not publishable");
    }
  }
  if (decision.outcome === "abstain") errors.push("publication_result cannot publish an abstained decision");
  if (!digest(result.profile_section_sha256)) errors.push("publication_result.profile_section_sha256 must be lowercase SHA-256");
  if (result.status === "dry_run_candidate") {
    if (result.published_at !== null) errors.push("publication_result.published_at must be null for dry-run candidates");
  } else if (!timestamp(result.published_at)) {
    errors.push("publication_result.published_at must be an ISO timestamp for published results");
  }
  if (digest(result.result_sha256) && result.result_sha256 !== glossaryCanonicalSha256(bodyWithoutDigest(result, "result_sha256"))) {
    errors.push("publication_result.result_sha256 does not match canonical publication bytes");
  }
  if (!digest(result.result_sha256)) errors.push("publication_result.result_sha256 must be lowercase SHA-256");
  return errors;
}

export function createGlossaryPublicationResult(input: {
  capsule: GlossaryEvidenceCapsule;
  receipt: GlossaryHostClassificationReceipt;
  decision: GlossaryAdmissionDecision;
  review: GlossaryReviewRecord | null;
  status: string;
  profile_section_sha256: string;
  published_at: string | null;
}): GlossaryPublicationResult {
  const result = {
    schema_version: LAYER_SCHEMAS.publication_result,
    owner: LAYER_OWNERS.publication_result,
    candidate_id: input.capsule.candidate_id,
    candidate_revision: input.capsule.candidate_revision,
    candidate_capsule_sha256: input.capsule.capsule_sha256,
    decision_sha256: input.decision.decision_sha256,
    review_record_sha256: input.review?.record_sha256 ?? null,
    generation: input.capsule.generation,
    policy_version: input.capsule.policy_version,
    status: input.status,
    profile_section_sha256: input.profile_section_sha256,
    published_at: input.published_at,
  } as GlossaryContractRecord;
  result.result_sha256 = glossaryCanonicalSha256(result);
  const errors = validateGlossaryPublicationResult(result, input.capsule, input.receipt, input.decision, input.review);
  if (errors.length > 0) throw new TypeError(errors.join("; "));
  return result as GlossaryPublicationResult;
}

export function validatePersonalCandidateContracts(authority: Mapping): string[] {
  const errors: string[] = [];
  const candidate = mapping(authority.candidate_contracts);
  if (!candidate) return ["candidate_contracts is required"];
  if (candidate.schema_version !== CANDIDATE_CONTRACTS_SCHEMA) errors.push("candidate_contracts.schema_version is invalid");
  if (candidate.status !== "active_partial") errors.push("candidate_contracts.status must be active_partial");
  if (candidate.implementation_boundary !== "receipt_validation_deterministic_decision_and_explicit_personal_publication_runtime") {
    errors.push("candidate_contracts must scope runtime to validation, deterministic decisions, and explicit personal publication");
  }
  if (!exactStrings(candidate.layers && Object.keys(mapping(candidate.layers) ?? {}), LAYERS)) errors.push("candidate_contracts.layers must contain exactly the five candidate layers");
  const owners = LAYERS.map((name) => mapping(candidate.layers)?.[name]).map(mapping).map((item) => String(item?.owner ?? ""));
  if (new Set(owners).size !== LAYERS.length || LAYERS.some((name, index) => owners[index] !== LAYER_OWNERS[name])) errors.push("candidate contract layer owners must be distinct and authoritative");
  for (const name of LAYERS) {
    const current = mapping(mapping(candidate.layers)?.[name]);
    if (!current) {
      errors.push(`candidate_contracts.layers.${name} is required`);
      continue;
    }
    const required = strings(current.required_fields);
    if (!exactStrings(required, LAYER_REQUIRED_FIELDS[name])) errors.push(`candidate_contracts.layers.${name}.required_fields must be exact and unique`);
    errors.push(...validateLayerEnvelope({}, { ...current, required_fields: [] }, name).filter((error) => error.includes("additional_fields") || error.includes("owner") || error.includes("schema_version")));
    if (current.additional_fields !== "forbidden") errors.push(`candidate_contracts.layers.${name}.additional_fields must be forbidden`);
    const forbidden = strings(current.forbidden_fields);
    if (forbidden.length === 0 || new Set(forbidden).size !== forbidden.length) errors.push(`candidate_contracts.layers.${name}.forbidden_fields must be explicit and unique`);
    if (forbidden.some((field) => required.includes(field))) errors.push(`candidate_contracts.layers.${name} cannot forbid a required field`);
    if (!exactStrings(current.binding_fields, LAYER_BINDING_FIELDS[name])) {
      errors.push(`candidate_contracts.layers.${name}.binding_fields are incomplete or reordered`);
    }
    if (current.body_digest !== BODY_DIGEST_FIELDS[name]) errors.push(`candidate_contracts.layers.${name}.body_digest is invalid`);
  }
  const canonicalization = mapping(candidate.canonicalization);
  if (canonicalization?.algorithm !== "sha256" || canonicalization?.encoding !== "lowercase_hex" || canonicalization?.input !== "canonical_utf8_json" || canonicalization?.object_keys !== "unicode_code_point_sorted" || canonicalization?.evidence_records !== "canonical_json_sorted" || canonicalization?.digest_field_rule !== "exclude_digest_field_from_body") {
    errors.push("candidate_contracts.canonicalization must reuse canonical UTF-8 JSON and lowercase SHA-256");
  }
  const bounds = candidateBounds(candidate);
  if (bounds.term_max_utf8_bytes !== 256 || bounds.meaning_max_utf8_bytes !== 4096 || bounds.binding_max_utf8_bytes !== 256 || bounds.evidence_records_max !== 100 || bounds.reason_max_utf8_bytes !== 512 || bounds.corrected_meaning_max_utf8_bytes !== 4096 || bounds.digest_bytes !== 32) {
    errors.push("candidate_contracts.bounds must preserve the declared candidate limits");
  }
  const identity = mapping(candidate.identity);
  if (identity?.stable_term_identity !== "personal_mining_authority.term_identity.stable_term_identity" || identity?.candidate_revision !== "personal_mining_authority.term_identity.candidate_revision") {
    errors.push("candidate_contracts.identity must delegate to the settled term and revision helpers");
  }
  const layers = mapping(candidate.layers);
  const host = mapping(layers?.host_classification_receipt);
  const classification = mapping(mapping(host)?.classification);
  if (!exactStrings(classification?.fields, HOST_CLASSIFICATION_FIELDS) || classification?.term !== "shared_primitive.fields.term" || classification?.meaning !== "shared_primitive.fields.meaning" || classification?.scope !== "packages/cli/src/registries/glossaryTermIdentity.ts#GlossaryCandidateScope" || !exactStrings(classification?.consistency_values, CONSISTENCY_VALUES)) {
    errors.push("host classification must expose only the approved semantic fields and consistency vocabulary");
  }
  errors.push(...validateGlossaryCandidateDecisionAuthority(authority));
  const reviews = mapping(mapping(mapping(authority.personal_mining_authority)?.privacy)?.reviews);
  const reviewLayer = mapping(layers?.review_record);
  if (!exactStrings(reviewLayer?.dispositions_from, ["personal_mining_authority.privacy.reviews.dispositions"]) || !exactStrings(reviews?.dispositions, PERSONAL_REVIEW_DISPOSITIONS)) {
    errors.push("review records must reuse the current user-local disposition vocabulary");
  }
  const profileOutput = mapping(mapping(mapping(authority.ownership_contracts)?.personal)?.profile_output);
  const publicationLayer = mapping(layers?.publication_result);
  if (publicationLayer?.owner !== "personal_profile_publication" || publicationLayer?.command !== "ownership_contracts.personal.profile_output.command.canonical" || !exactStrings(publicationLayer?.status_values_from, ["ownership_contracts.personal.profile_output.command.output_statuses"]) || !exactStrings(mapping(profileOutput?.command)?.output_statuses, ["changed", "unchanged_replay", "dry_run_candidate"])) {
    errors.push("publication results must reuse the personal Profile output contract");
  }
  const invariance = mapping(candidate.shared_invariance);
  if (invariance?.shared_primitive !== "shared_primitive" || invariance?.consumer_precedence !== "consumer_boundary.primary_selection" || invariance?.project_publication !== "ownership_contracts.project.publication" || invariance?.personal_project_isolation !== "ownership_contracts.personal.admission.isolation_rule") {
    errors.push("candidate contracts must preserve shared entry, consumer precedence, project publication, and isolation owners");
  }
  const recovery = mapping(candidate.recovery);
  if (recovery?.stale_or_mismatch !== "fail_closed_no_effects" || !nonEmpty(recovery?.retry)) errors.push("candidate contracts need fail-closed stale and mismatch recovery");
  const inferredUsage = mapping(mapping(authority.provenance_variants)?.personal_inferred_usage);
  const inferredDistinctness = mapping(inferredUsage?.distinctness);
  if (inferredDistinctness?.source_ids !== 2 || inferredDistinctness?.evidence_anchors !== 2) {
    errors.push("personal_inferred_usage must require two distinct source IDs and evidence anchors");
  }
  const forbiddenHost = strings(host?.forbidden_fields);
  for (const field of ["admission", "decision", "mutation", "publication", "review_bypass", "trusted_publication_effect"]) {
    if (!forbiddenHost.includes(field)) errors.push(`host classification must forbid ${field}`);
  }
  return errors;
}
