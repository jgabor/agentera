import path from "node:path";

import { resolveSourceRoot } from "../core/sourceRoot.js";
import { loadYamlMappingFile } from "../core/yaml.js";

type Mapping = Record<string, unknown>;

export type GlossaryOwner = "personal" | "project";
export type GlossaryProvenanceKind =
  | "personal_explicit_definition"
  | "personal_inferred_usage"
  | "project_file";

export interface RetainedEvidence {
  sourceId: string;
  sourceKind: string;
  signalType: string;
}

export interface GlossaryAdmissionContext {
  retainedHistory: ReadonlyMap<string, RetainedEvidence>;
}

const DEFERRED_CAPABILITIES = ["profile", "audit", "discuss", "plan", "build"] as const;
export type DeferredGlossaryCapability = (typeof DEFERRED_CAPABILITIES)[number];

export function glossaryEntryAuthorityPath(root: string = resolveSourceRoot()): string {
  return path.join(root, "references", "artifacts", "glossary-entry-contract.yaml");
}

function mapping(value: unknown): Mapping | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Mapping)
    : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function contract(pathname: string): Mapping {
  return loadYamlMappingFile(pathname) as Mapping;
}

function sameStrings(actual: unknown, expected: readonly string[]): boolean {
  return JSON.stringify(strings(actual)) === JSON.stringify(expected);
}

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateGlossaryEntryContract(
  pathname: string = glossaryEntryAuthorityPath(),
): string[] {
  let authority: Mapping;
  try {
    authority = contract(pathname);
  } catch (error) {
    return [`glossary-entry-contract.yaml: ${(error as Error).message}`];
  }

  const errors: string[] = [];
  if (authority.schema_version !== "agentera.glossaryEntryContract.v1") {
    errors.push("schema_version must be agentera.glossaryEntryContract.v1");
  }

  const primitive = mapping(authority.shared_primitive);
  const required = strings(primitive?.required_fields);
  const expected = ["term", "meaning", "confidence", "permanence", "temporal", "provenance"];
  if (!sameStrings(required, expected)) {
    errors.push("shared_primitive.required_fields must define the canonical entry shape once");
  }

  const fields = mapping(primitive?.fields);
  for (const field of expected) {
    if (!mapping(fields?.[field])) errors.push(`shared_primitive.fields.${field} is required`);
  }
  for (const field of ["term", "meaning"]) {
    if (mapping(fields?.[field])?.type !== "non_empty_string") {
      errors.push(`shared_primitive.fields.${field}.type must be non_empty_string`);
    }
  }
  const confidence = mapping(fields?.confidence);
  if (
    confidence?.type !== "integer" ||
    confidence?.range_from !== "skills/agentera/protocol.yaml#CONFIDENCE_SCALE"
  ) {
    errors.push("confidence must derive integer bounds from protocol CONFIDENCE_SCALE");
  }
  const permanence = mapping(fields?.permanence);
  if (
    permanence?.type !== "enum" ||
    !sameStrings(permanence?.values, ["stable", "durable", "situational"])
  ) {
    errors.push("permanence must use the existing profile permanence classes");
  }
  if (!nonEmpty(permanence?.classification_rule)) {
    errors.push("permanence classification must remain independent from confidence");
  }
  const temporal = mapping(fields?.temporal);
  if (
    temporal?.type !== "object" ||
    temporal?.field_type !== "iso_date" ||
    !sameStrings(temporal?.required_fields, ["observed_at", "last_confirmed_at"])
  ) {
    errors.push("temporal metadata must include observed_at and last_confirmed_at");
  }
  const provenance = mapping(fields?.provenance);
  if (
    provenance?.type !== "discriminated_union" ||
    provenance?.discriminator !== "kind" ||
    provenance?.evidence_field !== "evidence" ||
    provenance?.variants_from !== "provenance_variants"
  ) {
    errors.push("provenance must derive its kind and evidence variants from provenance_variants");
  }

  const variants = mapping(authority.provenance_variants);
  const variantExpectations: Record<string, Mapping> = {
    personal_explicit_definition: {
      owner: "personal",
      evidence_count: 1,
      required_evidence_fields: ["source_id", "evidence_anchor", "signal_type"],
      allowed_signal_types: ["correction", "decision", "instruction"],
    },
    personal_inferred_usage: {
      owner: "personal",
      evidence_count: 2,
      required_evidence_fields: ["source_id", "evidence_anchor", "source_kind"],
      allowed_source_kinds: ["instruction_document", "project_config_signal"],
    },
    project_file: {
      owner: "project",
      evidence_count: 1,
      required_evidence_fields: ["source_path", "source_record_sha256"],
    },
  };
  for (const [kind, expectedVariant] of Object.entries(variantExpectations)) {
    const variant = mapping(variants?.[kind]);
    if (!variant) {
      errors.push(`provenance variant ${kind} is required`);
      continue;
    }
    if (variant.owner !== expectedVariant.owner)
      errors.push(`${kind}.owner must be ${expectedVariant.owner}`);
    if (variant.evidence_count !== expectedVariant.evidence_count) {
      errors.push(`${kind}.evidence_count must be ${expectedVariant.evidence_count}`);
    }
    if (
      !sameStrings(
        variant.required_evidence_fields,
        expectedVariant.required_evidence_fields as string[],
      )
    ) {
      errors.push(`${kind}.required_evidence_fields must match its provenance variant`);
    }
    if (variant.additional_evidence_fields !== "forbidden") {
      errors.push(`${kind}.additional_evidence_fields must be forbidden`);
    }
    for (const allowedField of ["allowed_signal_types", "allowed_source_kinds"]) {
      if (
        allowedField in expectedVariant &&
        !sameStrings(variant[allowedField], expectedVariant[allowedField] as string[])
      ) {
        errors.push(`${kind}.${allowedField} must preserve the admitted evidence classes`);
      }
    }
    if (!nonEmpty(variant.resolution_rule)) errors.push(`${kind}.resolution_rule is required`);
  }

  const ownership = mapping(authority.ownership_contracts);
  const personal = mapping(ownership?.personal);
  if (personal?.scope !== "user") errors.push("personal ownership scope must be user");
  if (
    !sameStrings(personal?.allowed_provenance, [
      "personal_explicit_definition",
      "personal_inferred_usage",
    ])
  ) {
    errors.push("personal ownership must admit only personal provenance variants");
  }
  const personalInput = mapping(personal?.input);
  const excluded = strings(personalInput?.excluded_categories);
  for (const category of [
    "project_glossary_artifact_identity",
    "project_glossary_path",
    "project_glossary_record",
    "project_file_provenance",
  ]) {
    if (!excluded.includes(category)) errors.push(`personal input must exclude ${category}`);
  }
  if (personalInput?.tier !== "signal")
    errors.push("personal input must use the bounded signal tier");
  if (personalInput?.authority !== "references/analysis/evidence-tier-authority.yaml") {
    errors.push("personal input must use evidence-tier authority");
  }
  if (!nonEmpty(personalInput?.bounded_rule)) {
    errors.push("personal input bounded_rule is required");
  }

  const decay = mapping(personal?.retention_and_decay);
  if (decay?.authority !== "packages/cli/src/capabilities/profile/instructions.ts#Profile-format") {
    errors.push("personal decay must delegate to the existing profile decay authority");
  }
  if (
    mapping(authority.authority)?.confidence !== "skills/agentera/protocol.yaml#CONFIDENCE_SCALE"
  ) {
    errors.push("contract confidence authority must be protocol CONFIDENCE_SCALE");
  }
  for (const field of ["retention", "confidence", "permanence"]) {
    if (!nonEmpty(decay?.[field])) errors.push(`personal retention_and_decay.${field} is required`);
  }

  const project = mapping(ownership?.project);
  const projectInput = mapping(project?.input);
  if (
    project?.scope !== "repository" ||
    !sameStrings(project?.allowed_provenance, ["project_file"])
  ) {
    errors.push("project ownership must be repository-scoped project_file provenance");
  }
  if (
    projectInput?.authority !== "repository_files" ||
    !nonEmpty(projectInput?.bounded_rule) ||
    !sameStrings(projectInput?.excluded_categories, [
      "personal_history_record",
      "personal_history_anchor",
    ])
  ) {
    errors.push(
      "project input must be bounded repository-file evidence excluding personal history",
    );
  }

  const consumer = mapping(authority.consumer_boundary);
  if (
    consumer?.implementation !== "declared_deferred" ||
    !sameStrings(consumer?.forbidden_persisted_entry_fields, ["precedence", "collision", "review"])
  ) {
    errors.push("consumer behavior must remain deferred and outside persisted entry state");
  }
  const exactCollision = mapping(consumer?.exact_collision);
  if (
    exactCollision?.behavior !== "project_precedence_at_consumption" ||
    exactCollision?.persistence !== "forbidden" ||
    exactCollision?.personal_entry_suppression !== "forbidden"
  ) {
    errors.push("exact collisions must defer project precedence to consumption without persistence or suppression");
  }
  const inferred = mapping(consumer?.inferred_semantic_equivalence);
  if (
    inferred?.behavior !== "user_review" ||
    inferred?.automatic_merge !== "forbidden" ||
    inferred?.suppression !== "forbidden" ||
    inferred?.precedence !== "forbidden"
  ) {
    errors.push("inferred equivalence must defer to user review without merge, suppression, or precedence");
  }

  const capabilities = mapping(authority.deferred_capability_contracts);
  const profile = mapping(capabilities?.profile);
  const profileContracts = mapping(profile?.contracts);
  if (
    profile?.implementation !== "declared_deferred" ||
    !sameStrings(profile?.capabilities, ["profile"]) ||
    profileContracts?.admission !== "ownership_contracts.personal.input" ||
    profileContracts?.provenance !== "ownership_contracts.personal.allowed_provenance" ||
    profileContracts?.confidence !== "shared_primitive.fields.confidence" ||
    profileContracts?.retention_and_decay !== "ownership_contracts.personal.retention_and_decay" ||
    !sameStrings(profile?.forbidden_current_claims, ["synthesis", "persistence", "lookup"])
  ) {
    errors.push("profile glossary synthesis must remain deferred and derive personal entry policy from shared contracts");
  }
  const audit = mapping(capabilities?.audit);
  const confirmation = mapping(audit?.confirmation);
  const auditInputs = mapping(audit?.inputs);
  if (
    audit?.implementation !== "declared_deferred" ||
    !sameStrings(audit?.capabilities, ["audit"]) ||
    audit?.intended_output !== "skills/agentera/schemas/artifacts/glossary.yaml" ||
    confirmation?.status !== "declared_deferred" ||
    confirmation?.required_before_write !== "explicit_user_confirmation" ||
    auditInputs?.personal_history !== "ownership_contracts.personal.input" ||
    auditInputs?.project_file !== "ownership_contracts.project.input" ||
    auditInputs?.project_file_history_classification !== "forbidden"
  ) {
    errors.push("audit glossary output, confirmation, and separated evidence inputs must remain deferred");
  }
  const consumers = mapping(capabilities?.consumers);
  if (
    consumers?.implementation !== "declared_deferred" ||
    !sameStrings(consumers?.capabilities, ["discuss", "plan", "build"]) ||
    consumers?.behavior !== "consumer_boundary" ||
    !sameStrings(consumers?.forbidden_current_claims, ["lookup", "precedence", "review"])
  ) {
    errors.push("discuss, plan, and build glossary consumption must remain deferred");
  }
  return errors;
}

export function validateGlossaryCapabilityImplementationClaim(
  capability: string,
  claimedImplementation: string,
  pathname: string = glossaryEntryAuthorityPath(),
): string[] {
  if (!DEFERRED_CAPABILITIES.includes(capability as DeferredGlossaryCapability)) {
    return [`${capability} is not an affected glossary capability`];
  }
  const authority = contract(pathname);
  const declarations = mapping(authority.deferred_capability_contracts);
  const declaration = Object.values(declarations ?? {})
    .map(mapping)
    .find((candidate) => strings(candidate?.capabilities).includes(capability));
  if (!declaration) return [`${capability} has no deferred glossary declaration`];
  if (claimedImplementation !== declaration.implementation) {
    return [
      `${capability} glossary behavior is declared_deferred; ${claimedImplementation} is a false implementation claim`,
    ];
  }
  return [];
}

function requiredEntryShape(entry: Mapping, authority: Mapping): string[] {
  const errors: string[] = [];
  const primitive = mapping(authority.shared_primitive);
  const fields = mapping(primitive?.fields);
  for (const field of strings(primitive?.required_fields)) {
    if (!(field in entry)) errors.push(`${field} is required`);
  }
  if (typeof entry.term !== "string" || entry.term.trim() === "")
    errors.push("term must be a non-empty string");
  if (typeof entry.meaning !== "string" || entry.meaning.trim() === "")
    errors.push("meaning must be a non-empty string");
  if (
    !Number.isInteger(entry.confidence) ||
    Number(entry.confidence) < 0 ||
    Number(entry.confidence) > 100
  ) {
    errors.push("confidence must be an integer from protocol CS1-CS5");
  }
  if (!strings(mapping(fields?.permanence)?.values).includes(String(entry.permanence))) {
    errors.push("permanence must be an existing profile permanence class");
  }
  const temporal = mapping(entry.temporal);
  for (const field of strings(mapping(fields?.temporal)?.required_fields)) {
    if (
      typeof temporal?.[field] !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(temporal[field] as string)
    ) {
      errors.push(`temporal.${field} must be an ISO date`);
    }
  }
  return errors;
}

function evidenceShape(
  evidence: Mapping,
  requiredFields: string[],
  kind: string,
  index: number,
): string[] {
  const errors: string[] = [];
  const missing = requiredFields.filter((field) => !(field in evidence));
  const forbidden = Object.keys(evidence).filter((field) => !requiredFields.includes(field));
  if (missing.length > 0) {
    errors.push(`provenance.evidence[${index}] is missing ${kind} fields: ${missing.join(", ")}`);
  }
  if (forbidden.length > 0) {
    errors.push(
      `provenance.evidence[${index}] contains fields forbidden for ${kind}: ${forbidden.join(", ")}`,
    );
  }
  return errors;
}

function validateHistoryEvidence(
  evidence: Mapping,
  context: GlossaryAdmissionContext,
  index: number,
): string[] {
  const errors: string[] = [];
  const sourceId = typeof evidence.source_id === "string" ? evidence.source_id : "";
  const anchor = typeof evidence.evidence_anchor === "string" ? evidence.evidence_anchor : "";
  const retained = context.retainedHistory.get(anchor);
  if (!sourceId || !anchor)
    errors.push(`provenance.evidence[${index}] requires source_id and evidence_anchor`);
  if (!retained || retained.sourceId !== sourceId) {
    errors.push(
      `provenance.evidence[${index}].evidence_anchor must resolve to its retained source_id`,
    );
  }
  return errors;
}

export function validateGlossaryEntry(
  entry: Mapping,
  owner: GlossaryOwner,
  context: GlossaryAdmissionContext = { retainedHistory: new Map() },
  pathname: string = glossaryEntryAuthorityPath(),
): string[] {
  const authorityErrors = validateGlossaryEntryContract(pathname);
  if (authorityErrors.length > 0) {
    return authorityErrors.map((error) => `glossary authority invalid: ${error}`);
  }
  const authority = contract(pathname);
  const variants = mapping(authority.provenance_variants) as Mapping;
  const ownership = mapping(authority.ownership_contracts) as Mapping;
  const ownerContract = mapping(ownership[owner]) as Mapping;
  const errors = requiredEntryShape(entry, authority);
  const provenance = mapping(entry.provenance);
  const kind = provenance?.kind as GlossaryProvenanceKind | undefined;
  const evidence = Array.isArray(provenance?.evidence) ? provenance.evidence.map(mapping) : [];

  if (!kind || !strings(ownerContract.allowed_provenance).includes(kind)) {
    errors.push(
      owner === "personal"
        ? "personal entries admit only bounded personal-history provenance"
        : "project entries admit only repository-file provenance",
    );
    return errors;
  }
  const variant = mapping(variants[kind]) as Mapping;
  const requiredEvidenceFields = strings(variant.required_evidence_fields);
  for (const [index, item] of evidence.entries()) {
    if (item) errors.push(...evidenceShape(item, requiredEvidenceFields, kind, index));
  }
  const evidenceCount = Number(variant.evidence_count);

  if (kind === "personal_explicit_definition") {
    if (evidence.length !== evidenceCount || evidence[0] === null) {
      errors.push("explicit personal definitions require exactly one retained record");
    } else {
      errors.push(...validateHistoryEvidence(evidence[0], context, 0));
      const retained = context.retainedHistory.get(String(evidence[0].evidence_anchor));
      if (
        !retained ||
        evidence[0].signal_type !== retained.signalType ||
        !strings(variant.allowed_signal_types).includes(retained.signalType)
      ) {
        errors.push("explicit personal definition evidence has an inadmissible signal type");
      }
    }
  }

  if (kind === "personal_inferred_usage") {
    if (evidence.length !== evidenceCount || evidence.some((item) => item === null)) {
      errors.push("inferred personal usage requires exactly two retained records");
    } else {
      for (const [index, item] of (evidence as Mapping[]).entries()) {
        errors.push(...validateHistoryEvidence(item, context, index));
        const retained = context.retainedHistory.get(String(item.evidence_anchor));
        if (
          !retained ||
          item.source_kind !== retained.sourceKind ||
          !strings(variant.allowed_source_kinds).includes(retained.sourceKind)
        ) {
          errors.push(`provenance.evidence[${index}] has an inadmissible inferred source kind`);
        }
      }
      const sourceIds = evidence.map((item) => String(item?.source_id));
      const anchors = evidence.map((item) => String(item?.evidence_anchor));
      if (new Set(sourceIds).size !== 2 || new Set(anchors).size !== 2) {
        errors.push(
          "inferred personal usage requires two distinct retained identities and anchors",
        );
      }
    }
  }

  if (kind === "project_file") {
    if (evidence.length !== evidenceCount || evidence[0] === null) {
      errors.push("project file provenance requires exactly one source record");
    } else {
      const sourcePath = evidence[0].source_path;
      const digest = evidence[0].source_record_sha256;
      if (
        typeof sourcePath !== "string" ||
        sourcePath.length === 0 ||
        path.isAbsolute(sourcePath) ||
        sourcePath.split(/[\\/]/).includes("..")
      ) {
        errors.push("project source_path must be safe and project-relative");
      }
      if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
        errors.push("project source_record_sha256 must be a lowercase SHA-256 digest");
      }
    }
  }
  return errors;
}
