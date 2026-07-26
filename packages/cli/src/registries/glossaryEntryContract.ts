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
  if (JSON.stringify(required) !== JSON.stringify(expected)) {
    errors.push("shared_primitive.required_fields must define the canonical entry shape once");
  }

  const fields = mapping(primitive?.fields);
  const confidence = mapping(fields?.confidence);
  if (
    confidence?.type !== "integer" ||
    confidence?.range_from !== "skills/agentera/protocol.yaml#CONFIDENCE_SCALE"
  ) {
    errors.push("confidence must derive integer bounds from protocol CONFIDENCE_SCALE");
  }
  const permanence = mapping(fields?.permanence);
  if (
    JSON.stringify(strings(permanence?.values)) !==
    JSON.stringify(["stable", "durable", "situational"])
  ) {
    errors.push("permanence must use the existing profile permanence classes");
  }
  const temporal = mapping(fields?.temporal);
  if (
    JSON.stringify(strings(temporal?.required_fields)) !==
    JSON.stringify(["observed_at", "last_confirmed_at"])
  ) {
    errors.push("temporal metadata must include observed_at and last_confirmed_at");
  }

  const variants = mapping(authority.provenance_variants);
  for (const kind of ["personal_explicit_definition", "personal_inferred_usage", "project_file"]) {
    if (!mapping(variants?.[kind])) errors.push(`provenance variant ${kind} is required`);
  }

  const ownership = mapping(authority.ownership_contracts);
  const personal = mapping(ownership?.personal);
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

  const decay = mapping(personal?.retention_and_decay);
  if (decay?.authority !== "packages/cli/src/capabilities/profile/instructions.ts#Profile-format") {
    errors.push("personal decay must delegate to the existing profile decay authority");
  }
  if (
    mapping(authority.authority)?.confidence !== "skills/agentera/protocol.yaml#CONFIDENCE_SCALE"
  ) {
    errors.push("contract confidence authority must be protocol CONFIDENCE_SCALE");
  }
  return errors;
}

function requiredEntryShape(entry: Mapping): string[] {
  const errors: string[] = [];
  for (const field of ["term", "meaning", "confidence", "permanence", "temporal", "provenance"]) {
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
  if (!["stable", "durable", "situational"].includes(String(entry.permanence))) {
    errors.push("permanence must be an existing profile permanence class");
  }
  const temporal = mapping(entry.temporal);
  for (const field of ["observed_at", "last_confirmed_at"]) {
    if (
      typeof temporal?.[field] !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(temporal[field] as string)
    ) {
      errors.push(`temporal.${field} must be an ISO date`);
    }
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
): string[] {
  const errors = requiredEntryShape(entry);
  const provenance = mapping(entry.provenance);
  const kind = provenance?.kind as GlossaryProvenanceKind | undefined;
  const evidence = Array.isArray(provenance?.evidence) ? provenance.evidence.map(mapping) : [];

  const personalKinds = new Set<GlossaryProvenanceKind>([
    "personal_explicit_definition",
    "personal_inferred_usage",
  ]);
  if (owner === "personal" && (!kind || !personalKinds.has(kind))) {
    errors.push("personal entries admit only bounded personal-history provenance");
    return errors;
  }
  if (owner === "project" && kind !== "project_file") {
    errors.push("project entries admit only repository-file provenance");
    return errors;
  }

  if (kind === "personal_explicit_definition") {
    if (evidence.length !== 1 || evidence[0] === null) {
      errors.push("explicit personal definitions require exactly one retained record");
    } else {
      errors.push(...validateHistoryEvidence(evidence[0], context, 0));
      const retained = context.retainedHistory.get(String(evidence[0].evidence_anchor));
      if (
        !retained ||
        evidence[0].signal_type !== retained.signalType ||
        !["correction", "decision", "instruction"].includes(retained.signalType)
      ) {
        errors.push("explicit personal definition evidence has an inadmissible signal type");
      }
    }
  }

  if (kind === "personal_inferred_usage") {
    if (evidence.length !== 2 || evidence.some((item) => item === null)) {
      errors.push("inferred personal usage requires exactly two retained records");
    } else {
      for (const [index, item] of (evidence as Mapping[]).entries()) {
        errors.push(...validateHistoryEvidence(item, context, index));
        const retained = context.retainedHistory.get(String(item.evidence_anchor));
        if (
          !retained ||
          item.source_kind !== retained.sourceKind ||
          !["instruction_document", "project_config_signal"].includes(retained.sourceKind)
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
    if (evidence.length !== 1 || evidence[0] === null) {
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
