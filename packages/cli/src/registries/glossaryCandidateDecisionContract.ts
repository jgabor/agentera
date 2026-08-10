import { loadYamlMappingFile } from "../core/yaml.js";
import { projectGlossaryDevelopmentValue } from "../core/developmentInvocation.js";
import { hasGlossaryAdmissionReasonCodesByOutcome } from "./glossaryCandidateDecisionAuthority.js";
import { glossaryEntryAuthorityPath } from "./glossaryEntryContract.js";
import type { PersonalGlossaryCandidateDecisionContract } from "./personalGlossaryContracts.js";

type Mapping = Record<string, unknown>;

function mapping(value: unknown): Mapping | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Mapping)
    : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? [...value]
    : [];
}

/** Load the bounded receipt-validation and deterministic-decision settings. */
export function personalGlossaryCandidateDecisionContract(
  pathname: string = glossaryEntryAuthorityPath(),
): PersonalGlossaryCandidateDecisionContract {
  const authority = loadYamlMappingFile(pathname) as Mapping;
  const candidateContracts = mapping(authority.candidate_contracts);
  const layers = mapping(candidateContracts?.layers);
  const decision = mapping(layers?.cli_decision);
  const command = mapping(decision?.command);
  const request = mapping(command?.request);
  const result = mapping(command?.result);
  const receiptConstruction = mapping(command?.receipt_construction);
  const receiptConstructionResult = mapping(receiptConstruction?.result);
  const automatic = mapping(decision?.automatic_admission);
  const reasonCodesByOutcome = mapping(decision?.reason_codes_by_outcome);
  if (!reasonCodesByOutcome || !hasGlossaryAdmissionReasonCodesByOutcome(reasonCodesByOutcome)) {
    throw new TypeError("invalid development command projection: personal glossary decision outcome/reason authority is unavailable");
  }
  return {
    command: projectGlossaryDevelopmentValue(
      command?.canonical,
      "candidate_decision.command",
    ),
    requestSchemaVersion:
      typeof request?.schema_version === "string" ? request.schema_version : "",
    requestFields: strings(request?.required_fields),
    maxRequestUtf8Bytes:
      typeof request?.max_utf8_bytes === "number" ? request.max_utf8_bytes : 0,
    resultSchemaVersion:
      typeof result?.schema_version === "string" ? result.schema_version : "",
    resultFields: strings(result?.fields),
    resultStatuses: strings(result?.statuses),
    reasonCodesByOutcome: Object.fromEntries(
      Object.entries(reasonCodesByOutcome).map(([outcome, reasons]) => [outcome, strings(reasons)]),
    ),
    maxResultUtf8Bytes:
      typeof result?.max_utf8_bytes === "number" ? result.max_utf8_bytes : 0,
    receiptConstructionRequestSchemaVersion:
      typeof receiptConstruction?.schema_version === "string"
        ? receiptConstruction.schema_version
        : "",
    receiptConstructionRequestFields: strings(receiptConstruction?.required_fields),
    receiptConstructionMaxRequestUtf8Bytes:
      typeof receiptConstruction?.max_utf8_bytes === "number"
        ? receiptConstruction.max_utf8_bytes
        : 0,
    receiptConstructionResultSchemaVersion:
      typeof receiptConstructionResult?.schema_version === "string"
        ? receiptConstructionResult.schema_version
        : "",
    receiptConstructionResultFields: strings(receiptConstructionResult?.fields),
    receiptConstructionResultStatuses: strings(receiptConstructionResult?.statuses),
    receiptConstructionMaxResultUtf8Bytes:
      typeof receiptConstructionResult?.max_utf8_bytes === "number"
        ? receiptConstructionResult.max_utf8_bytes
        : 0,
    automaticProvenance:
      typeof automatic?.allowed_provenance === "string" ? automatic.allowed_provenance : "",
    inferredAutomaticAdmission:
      typeof automatic?.inferred_automatic_admission === "string"
        ? automatic.inferred_automatic_admission
        : "",
    qualityGate: typeof automatic?.quality_gate === "string" ? automatic.quality_gate : "",
  };
}
