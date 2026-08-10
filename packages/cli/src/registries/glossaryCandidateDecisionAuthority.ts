type Mapping = Record<string, unknown>;

function mapping(value: unknown): Mapping | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Mapping)
    : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function exactStrings(actual: unknown, expected: readonly string[]): boolean {
  return JSON.stringify(strings(actual)) === JSON.stringify(expected);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export const GLOSSARY_ADMISSION_OUTCOMES = [
  "automatic_admission", "review_required", "abstain",
] as const;

export type GlossaryAdmissionOutcome = (typeof GLOSSARY_ADMISSION_OUTCOMES)[number];

export const GLOSSARY_ADMISSION_REASONS_BY_OUTCOME = {
  automatic_admission: ["explicit_current_authorized"],
  review_required: [
    "inferred_requires_review",
    "scope_ambiguous",
    "classification_inconsistent",
    "classification_changed",
    "entry_conflict",
    "evidence_retracted_or_conflicted",
    "quality_gate_not_authorizing",
  ],
  abstain: ["scope_project", "evidence_unavailable", "evidence_changed"],
} as const;

export const GLOSSARY_ADMISSION_REASONS = [
  ...GLOSSARY_ADMISSION_REASONS_BY_OUTCOME.automatic_admission,
  ...GLOSSARY_ADMISSION_REASONS_BY_OUTCOME.review_required,
  ...GLOSSARY_ADMISSION_REASONS_BY_OUTCOME.abstain,
] as const;

export type GlossaryAdmissionReason = (typeof GLOSSARY_ADMISSION_REASONS)[number];

export function hasGlossaryAdmissionReasonCodesByOutcome(value: unknown): boolean {
  const reasonCodes = mapping(value);
  return reasonCodes !== null
    && exactStrings(Object.keys(reasonCodes), GLOSSARY_ADMISSION_OUTCOMES)
    && GLOSSARY_ADMISSION_OUTCOMES.every((outcome) =>
      exactStrings(reasonCodes[outcome], GLOSSARY_ADMISSION_REASONS_BY_OUTCOME[outcome]));
}

/** Validates the CLI admission layer's authority-owned vocabulary and command contract. */
export function validateGlossaryCandidateDecisionAuthority(authority: Mapping): string[] {
  const errors: string[] = [];
  const candidate = mapping(authority.candidate_contracts);
  const layers = mapping(candidate?.layers);
  const decisionLayer = mapping(layers?.cli_decision);
  if (!exactStrings(decisionLayer?.outcomes, GLOSSARY_ADMISSION_OUTCOMES)) {
    errors.push("CLI decision outcomes must use the approved vocabulary");
  }
  if (!exactStrings(decisionLayer?.reason_codes, GLOSSARY_ADMISSION_REASONS)) {
    errors.push("CLI decision reasons must use the approved vocabulary");
  }
  if (!hasGlossaryAdmissionReasonCodesByOutcome(decisionLayer?.reason_codes_by_outcome)) {
    errors.push("CLI decision reasons must declare the approved outcome/reason pairs");
  }
  const automatic = mapping(decisionLayer?.automatic_admission);
  const automaticClassification = mapping(automatic?.required_classification);
  if (
    automatic?.allowed_provenance !== "provenance_variants.personal_explicit_definition" ||
    automatic?.inferred_automatic_admission !== "disabled" ||
    automaticClassification?.scope !== "personal" ||
    automaticClassification?.consistency !== "consistent" ||
    automaticClassification?.term !== "exact_capsule_term" ||
    automaticClassification?.meaning !== "exact_capsule_meaning" ||
    automatic?.current_evidence !== "required" ||
    automatic?.quality_gate !== "personal_mining_authority.admission.quality_threshold"
  ) {
    errors.push("CLI automatic admission must be explicit-only and inferred automatic admission disabled");
  }
  const command = mapping(decisionLayer?.command);
  const request = mapping(command?.request);
  const result = mapping(command?.result);
  const receiptConstruction = mapping(command?.receipt_construction);
  const receiptConstructionResult = mapping(receiptConstruction?.result);
  if (
    command?.canonical !== "npx -y agentera@next report personal-glossary-decision" ||
    command?.namespace !== "report" ||
    command?.input_flag !== "--input" ||
    command?.stdin_value !== "-" ||
    command?.format !== "json" ||
    command?.project_checkout !== "not_required" ||
    request?.schema_version !== "agentera.personalGlossaryAdmissionRequest.v1" ||
    !exactStrings(request?.required_fields, ["schema_version", "receipt"]) ||
    request?.additional_fields !== "forbidden" ||
    request?.max_utf8_bytes !== 16384 ||
    result?.schema_version !== "agentera.personalGlossaryAdmissionResult.v1" ||
    !exactStrings(result?.fields, ["schemaVersion", "command", "status", "decision", "reason", "effects"]) ||
    !exactStrings(result?.statuses, GLOSSARY_ADMISSION_OUTCOMES) ||
    result?.max_utf8_bytes !== 4096 ||
    !exactStrings(result?.effects, []) ||
    receiptConstruction?.schema_version !== "agentera.personalGlossaryAdmissionRequest.v2" ||
    !exactStrings(receiptConstruction?.required_fields, [
      "schema_version",
      "candidate_id",
      "candidate_revision",
      "candidate_capsule_sha256",
      "candidate_projection_sha256",
      "generation",
      "policy_version",
      "classification",
    ]) ||
    receiptConstruction?.additional_fields !== "forbidden" ||
    receiptConstruction?.max_utf8_bytes !== 16384 ||
    receiptConstructionResult?.schema_version !== "agentera.personalGlossaryAdmissionResult.v2" ||
    !exactStrings(receiptConstructionResult?.fields, [
      "schemaVersion",
      "command",
      "status",
      "receipt",
      "decision",
      "reason",
      "effects",
    ]) ||
    !exactStrings(receiptConstructionResult?.statuses, GLOSSARY_ADMISSION_OUTCOMES) ||
    receiptConstructionResult?.max_utf8_bytes !== 16384 ||
    !exactStrings(receiptConstructionResult?.effects, []) ||
    !nonEmpty(command?.rule)
  ) {
    errors.push("CLI decision command must remain bounded, structured, read-only, and current-projection bound");
  }
  return errors;
}
