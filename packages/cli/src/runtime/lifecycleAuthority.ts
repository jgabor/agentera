import fs from "node:fs";
import path from "node:path";

import type { JsonObject } from "../core/jsonValue.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { loadYamlMapping } from "../core/yaml.js";
import { validateLifecycleOperationContractRoot } from "./lifecycleOperationContract.js";
import { LIFECYCLE_OPERATION_CONTRACT_RELATIVE_PATH } from "./lifecycleOperations.js";

export const LIFECYCLE_AUTHORITY_RELATIVE_PATH =
  "references/adapters/runtime-lifecycle-authority.yaml";
export const LIFECYCLE_ADAPTER_CONTRACT_RELATIVE_PATH =
  "references/adapters/runtime-lifecycle-adapters.yaml";
export const RETIRED_RUNTIME_CLEANUP_CONTRACT_RELATIVE_PATH =
  "references/adapters/runtime-retired-resources.yaml";

const EXPECTED_EVIDENCE_FIELDS = ["host_present", "installed", "enabled", "trusted"] as const;
export const LIFECYCLE_APPLICABILITY_VALUES = [
  "required",
  "conditional",
  "not_applicable",
] as const;
export const LIFECYCLE_ACTION_CLASS_VALUES = [
  "repairable_owned",
  "manual_verification",
  "unobservable_gap",
] as const;
export const LIFECYCLE_COMMAND_ELIGIBILITY_VALUES = [
  "preview",
  "apply",
  "manual",
  "diagnostic",
] as const;
const EVIDENCE_VALUES = new Set<LifecycleEvidenceValue>([
  true,
  false,
  "unknown",
  "denied",
  "not_applicable",
]);
const INVENTORY_DECLARATIONS = [
  /^\s*["']?(?:active_runtimes|active_runtime_ids|active_runtime_order)["']?\s*:/,
  /^\s*(?:export\s+)?const\s+(?:activeRuntimeIds|ACTIVE_RUNTIME_IDS)\s*=/,
];
const INVENTORY_SCAN_EXTENSIONS = new Set([".json", ".ts", ".yaml", ".yml"]);

export type LifecycleEvidenceField = (typeof EXPECTED_EVIDENCE_FIELDS)[number];
export type LifecycleEvidenceValue = boolean | "unknown" | "denied" | "not_applicable";
export type LifecycleAggregateStatus = "ready" | "degraded" | "blocked";
export type LifecycleSurfaceStatus =
  | "ready"
  | "degraded"
  | "blocked"
  | "unknown"
  | "not_applicable";
export type LifecycleApplicability = (typeof LIFECYCLE_APPLICABILITY_VALUES)[number];
export type LifecycleActionClass = (typeof LIFECYCLE_ACTION_CLASS_VALUES)[number];
export type LifecycleCommandEligibility = (typeof LIFECYCLE_COMMAND_ELIGIBILITY_VALUES)[number];

export type LifecycleSupportFloorBlockerCode =
  | "canonical_skill_unknown"
  | "canonical_skill_not_detected"
  | "diagnosis_incomplete"
  | "mandatory_evidence_missing"
  | "mandatory_evidence_unknown"
  | "mandatory_evidence_denied"
  | "mandatory_trust_denied"
  | "mandatory_evidence_not_applicable";

export interface LifecycleSupportFloorViolation {
  code: LifecycleSupportFloorBlockerCode;
  detail: string;
  surfaceId?: string;
  field?: LifecycleEvidenceField;
  observed?: LifecycleEvidenceValue | "missing";
}

export interface LifecycleSurfaceDefinition {
  id: string;
  displayName: string;
  presence: "required" | "conditional";
}

export interface LifecycleRuntimeDefinition {
  id: string;
  displayName: string;
  surfaces: LifecycleSurfaceDefinition[];
}

export interface RuntimeLifecycleAuthority {
  sourcePath: string;
  canonicalSkillPath: string;
  evidenceFields: LifecycleEvidenceField[];
  supportFloorPolicy: {
    unknownOrMissingMandatoryBlocks: boolean;
    deniedMandatoryTrustBlocks: boolean;
    knownFalseDiagnosesDegraded: LifecycleEvidenceField[];
    notApplicableScope: "unobserved_conditional_surface_only";
  };
  runtimes: LifecycleRuntimeDefinition[];
}

export interface LifecycleSurfaceObservation {
  id: string;
  applicability?: LifecycleApplicability;
  evidence?: Partial<Record<LifecycleEvidenceField, LifecycleEvidenceValue>>;
  diagnosisComplete?: boolean;
  unmetMandatoryFields?: string[];
}

export interface LifecycleRuntimeObservation {
  runtimeId: string;
  canonicalSkillDetected?: LifecycleEvidenceValue;
  diagnosisComplete?: boolean;
  unmetMandatoryFields?: string[];
  surfaces?: LifecycleSurfaceObservation[];
}

export interface LifecycleSurfaceState extends LifecycleSurfaceDefinition {
  expected: boolean;
  applicability: LifecycleApplicability;
  status: LifecycleSurfaceStatus;
  evidence: Partial<Record<LifecycleEvidenceField, LifecycleEvidenceValue>>;
  diagnosisComplete: boolean;
  unmetMandatoryFields: string[];
  releaseBlocking: boolean;
  supportFloorViolations: LifecycleSupportFloorViolation[];
}

export interface LifecycleRuntimeState {
  runtimeId: string;
  displayName: string;
  status: LifecycleAggregateStatus;
  canonicalSkill: {
    path: string;
    detected: LifecycleEvidenceValue;
  };
  diagnosisComplete: boolean;
  surfaces: LifecycleSurfaceState[];
  supportFloor: {
    met: boolean;
    releaseBlocking: boolean;
    unmet: string[];
    violations: LifecycleSupportFloorViolation[];
  };
}

export interface RuntimeLifecycleState {
  schemaVersion: "agentera.runtimeLifecycleState.v1";
  authority: string;
  activeRuntimeIds: string[];
  runtimes: LifecycleRuntimeState[];
  releaseBlocked: boolean;
}

export class LifecycleAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LifecycleAuthorityError";
  }
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string {
  return typeof value[key] === "string" ? value[key] : "";
}

function sourceError(sourcePath: string, location: string, message: string): string {
  return `${sourcePath}:${location}: ${message}`;
}

export function validateLifecycleAuthorityData(
  data: unknown,
  sourcePath = LIFECYCLE_AUTHORITY_RELATIVE_PATH,
): string[] {
  if (!isMapping(data)) return [sourceError(sourcePath, "1", "authority must be a YAML object")];
  const errors: string[] = [];
  if (data.status !== "migration_only_authority") {
    errors.push(
      sourceError(sourcePath, "status", "must be migration_only_authority"),
    );
  }
  if (data.schema_version !== "agentera.runtimeLifecycleAuthority.v1") {
    errors.push(
      sourceError(sourcePath, "schema_version", "must be agentera.runtimeLifecycleAuthority.v1"),
    );
  }
  if (data.decision !== 92) {
    errors.push(sourceError(sourcePath, "decision", "must cite approved Decision 92"));
  }
  if (data.operation_contract !== LIFECYCLE_OPERATION_CONTRACT_RELATIVE_PATH) {
    errors.push(
      sourceError(
        sourcePath,
        "operation_contract",
        `must point to ${LIFECYCLE_OPERATION_CONTRACT_RELATIVE_PATH}`,
      ),
    );
  }
  if (data.adapter_contract !== LIFECYCLE_ADAPTER_CONTRACT_RELATIVE_PATH) {
    errors.push(
      sourceError(
        sourcePath,
        "adapter_contract",
        `must point to ${LIFECYCLE_ADAPTER_CONTRACT_RELATIVE_PATH}`,
      ),
    );
  }
  if (data.retired_cleanup_contract !== RETIRED_RUNTIME_CLEANUP_CONTRACT_RELATIVE_PATH) {
    errors.push(
      sourceError(
        sourcePath,
        "retired_cleanup_contract",
        `must point to ${RETIRED_RUNTIME_CLEANUP_CONTRACT_RELATIVE_PATH}`,
      ),
    );
  }

  const canonicalSkill = data.canonical_skill;
  if (!isMapping(canonicalSkill) || canonicalSkill.path !== "~/.agents/skills/agentera") {
    errors.push(
      sourceError(sourcePath, "canonical_skill.path", "must be ~/.agents/skills/agentera"),
    );
  }
  if (!isMapping(canonicalSkill) || canonicalSkill.required_for_support_floor !== true) {
    errors.push(
      sourceError(sourcePath, "canonical_skill.required_for_support_floor", "must be true"),
    );
  }

  const projection = data.projection_contract;
  if (
    !isMapping(projection) ||
    projection.schema_version !== "agentera.runtimeLifecycleProjection.v1"
  ) {
    errors.push(
      sourceError(
        sourcePath,
        "projection_contract.schema_version",
        "must be agentera.runtimeLifecycleProjection.v1",
      ),
    );
  }
  if (!isMapping(projection) || projection.snapshot_identity !== "deterministic_sha256") {
    errors.push(
      sourceError(
        sourcePath,
        "projection_contract.snapshot_identity",
        "must be deterministic_sha256",
      ),
    );
  }
  if (
    !isMapping(projection) ||
    JSON.stringify(projection.applicability) !== JSON.stringify(LIFECYCLE_APPLICABILITY_VALUES)
  ) {
    errors.push(
      sourceError(
        sourcePath,
        "projection_contract.applicability",
        `must be ${LIFECYCLE_APPLICABILITY_VALUES.join(", ")}`,
      ),
    );
  }
  if (
    !isMapping(projection) ||
    JSON.stringify(projection.action_classes) !== JSON.stringify(LIFECYCLE_ACTION_CLASS_VALUES)
  ) {
    errors.push(
      sourceError(
        sourcePath,
        "projection_contract.action_classes",
        `must be ${LIFECYCLE_ACTION_CLASS_VALUES.join(", ")}`,
      ),
    );
  }
  if (
    !isMapping(projection) ||
    JSON.stringify(projection.command_eligibility) !==
      JSON.stringify(LIFECYCLE_COMMAND_ELIGIBILITY_VALUES)
  ) {
    errors.push(
      sourceError(
        sourcePath,
        "projection_contract.command_eligibility",
        `must be ${LIFECYCLE_COMMAND_ELIGIBILITY_VALUES.join(", ")}`,
      ),
    );
  }
  if (
    !isMapping(projection) ||
    projection.shared_resource_rule !== "selected_and_required_by_at_least_one_selected_runtime"
  ) {
    errors.push(
      sourceError(
        sourcePath,
        "projection_contract.shared_resource_rule",
        "must require selection and at least one selected runtime",
      ),
    );
  }

  const evidence = data.evidence_contract;
  const evidenceFields = isMapping(evidence) ? evidence.mandatory_fields : null;
  if (JSON.stringify(evidenceFields) !== JSON.stringify(EXPECTED_EVIDENCE_FIELDS)) {
    errors.push(
      sourceError(
        sourcePath,
        "evidence_contract.mandatory_fields",
        `must be ${EXPECTED_EVIDENCE_FIELDS.join(", ")}`,
      ),
    );
  }
  const supportFloor = data.support_floor;
  if (!isMapping(supportFloor) || supportFloor.unmet_blocks_release !== true) {
    errors.push(sourceError(sourcePath, "support_floor.unmet_blocks_release", "must be true"));
  }
  if (
    !isMapping(supportFloor) ||
    JSON.stringify(supportFloor.requirements) !==
      JSON.stringify([
        "canonical_shared_skill_detected",
        "diagnosis_complete",
        "mandatory_evidence_resolved",
      ])
  ) {
    errors.push(
      sourceError(
        sourcePath,
        "support_floor.requirements",
        "must require canonical skill detection, complete diagnosis, and resolved mandatory evidence",
      ),
    );
  }
  const evidenceRules =
    isMapping(supportFloor) && isMapping(supportFloor.evidence_rules)
      ? supportFloor.evidence_rules
      : {};
  if (evidenceRules.unknown_or_missing_mandatory_blocks !== true) {
    errors.push(
      sourceError(
        sourcePath,
        "support_floor.evidence_rules.unknown_or_missing_mandatory_blocks",
        "must be true",
      ),
    );
  }
  if (evidenceRules.denied_mandatory_trust_blocks !== true) {
    errors.push(
      sourceError(
        sourcePath,
        "support_floor.evidence_rules.denied_mandatory_trust_blocks",
        "must be true",
      ),
    );
  }
  if (
    JSON.stringify(evidenceRules.known_false_diagnoses_degraded) !==
    JSON.stringify(["host_present", "installed", "enabled"])
  ) {
    errors.push(
      sourceError(
        sourcePath,
        "support_floor.evidence_rules.known_false_diagnoses_degraded",
        "must be host_present, installed, enabled",
      ),
    );
  }
  if (evidenceRules.not_applicable_scope !== "unobserved_conditional_surface_only") {
    errors.push(
      sourceError(
        sourcePath,
        "support_floor.evidence_rules.not_applicable_scope",
        "must be unobserved_conditional_surface_only",
      ),
    );
  }

  const runtimes = data.active_runtimes;
  if (!Array.isArray(runtimes)) {
    return [...errors, sourceError(sourcePath, "active_runtimes", "must be a list")];
  }
  if (runtimes.length !== 0) {
    errors.push(
      sourceError(
        sourcePath,
        "active_runtimes",
        "must be empty because repository-native runtime integrations are retired",
      ),
    );
  }
  const retiredInputs = data.retired_runtime_inputs;
  if (
    !Array.isArray(retiredInputs) ||
    retiredInputs.length !== 1 ||
    !isMapping(retiredInputs[0]) ||
    retiredInputs[0].id !== "claude" ||
    JSON.stringify(retiredInputs[0].purposes) !==
      JSON.stringify(["consent_gated_historical_import", "owned_legacy_resource_cleanup"])
  ) {
    errors.push(
      sourceError(
        sourcePath,
        "retired_runtime_inputs",
        "must contain only claude for consent-gated historical import and owned legacy cleanup",
      ),
    );
  }
  const aliases = data.migration_aliases;
  const cursorAgent = isMapping(aliases) ? aliases["cursor-agent"] : null;
  if (
    !isMapping(cursorAgent) ||
    cursorAgent.runtime_id !== "cursor" ||
    cursorAgent.surface_id !== "cli"
  ) {
    errors.push(
      sourceError(
        sourcePath,
        "migration_aliases.cursor-agent",
        "must route to runtime cursor surface cli",
      ),
    );
  }
  return errors;
}

export function loadLifecycleAuthority(
  authorityPath = path.join(resolveSourceRoot(), LIFECYCLE_AUTHORITY_RELATIVE_PATH),
): RuntimeLifecycleAuthority {
  const data = loadYamlMapping(fs.readFileSync(authorityPath, "utf8"));
  const errors = validateLifecycleAuthorityData(data, authorityPath);
  if (errors.length > 0) {
    throw new LifecycleAuthorityError(
      `Runtime lifecycle authority validation failed: ${errors.join("; ")}`,
    );
  }
  const canonicalSkill = data.canonical_skill as JsonObject;
  const evidence = data.evidence_contract as JsonObject;
  const supportFloor = data.support_floor as JsonObject;
  const evidenceRules = supportFloor.evidence_rules as JsonObject;
  const runtimes = (data.active_runtimes as JsonObject[]).map((runtime) => ({
    id: runtime.id as string,
    displayName: runtime.display_name as string,
    surfaces: (runtime.surfaces as JsonObject[]).map((surface) => ({
      id: surface.id as string,
      displayName: surface.display_name as string,
      presence: surface.presence as "required" | "conditional",
    })),
  }));
  return {
    sourcePath: authorityPath,
    canonicalSkillPath: canonicalSkill.path as string,
    evidenceFields: evidence.mandatory_fields as LifecycleEvidenceField[],
    supportFloorPolicy: {
      unknownOrMissingMandatoryBlocks: evidenceRules.unknown_or_missing_mandatory_blocks as boolean,
      deniedMandatoryTrustBlocks: evidenceRules.denied_mandatory_trust_blocks as boolean,
      knownFalseDiagnosesDegraded:
        evidenceRules.known_false_diagnoses_degraded as LifecycleEvidenceField[],
      notApplicableScope:
        evidenceRules.not_applicable_scope as "unobserved_conditional_surface_only",
    },
    runtimes,
  };
}

function inventoryDeclarations(root: string, canonicalPath: string): string[] {
  const declarations: string[] = [];
  const visit = (entryPath: string): void => {
    if (!fs.existsSync(entryPath)) return;
    const stat = fs.statSync(entryPath);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(entryPath).sort()) visit(path.join(entryPath, name));
      return;
    }
    if (
      !INVENTORY_SCAN_EXTENSIONS.has(path.extname(entryPath)) ||
      path.resolve(entryPath) === canonicalPath
    ) {
      return;
    }
    fs.readFileSync(entryPath, "utf8")
      .split(/\r\n|\r|\n/)
      .forEach((line, index) => {
        if (INVENTORY_DECLARATIONS.some((pattern) => pattern.test(line))) {
          declarations.push(`${path.relative(root, entryPath)}:${index + 1}`);
        }
      });
  };
  visit(path.join(root, "references"));
  visit(path.join(root, "packages", "cli", "src"));
  return declarations;
}

export function validateLifecycleAuthorityRoot(root = resolveSourceRoot()): string[] {
  const authorityPath = path.join(root, LIFECYCLE_AUTHORITY_RELATIVE_PATH);
  if (!fs.existsSync(authorityPath)) {
    return [`${LIFECYCLE_AUTHORITY_RELATIVE_PATH}:1: missing runtime lifecycle authority`];
  }
  let data: Record<string, unknown>;
  try {
    data = loadYamlMapping(fs.readFileSync(authorityPath, "utf8"));
  } catch (error) {
    return [
      `${LIFECYCLE_AUTHORITY_RELATIVE_PATH}:1: could not parse authority: ${(error as Error).message}`,
    ];
  }
  const errors = validateLifecycleAuthorityData(data, LIFECYCLE_AUTHORITY_RELATIVE_PATH);
  errors.push(...validateLifecycleOperationContractRoot(root));
  for (const location of inventoryDeclarations(root, path.resolve(authorityPath))) {
    errors.push(
      `${location}: duplicate active runtime inventory; authority is ${LIFECYCLE_AUTHORITY_RELATIVE_PATH}:active_runtimes`,
    );
  }
  return errors;
}

function observedSurfaceExpected(
  definition: LifecycleSurfaceDefinition,
  observation: LifecycleSurfaceObservation | undefined,
  authority: RuntimeLifecycleAuthority,
): boolean {
  if (definition.presence === "required") return true;
  if (observation?.applicability === "conditional") return true;
  if (observation?.applicability === "not_applicable") return false;
  const hostPresent = observation?.evidence?.host_present;
  return (
    authority.supportFloorPolicy.notApplicableScope === "unobserved_conditional_surface_only" &&
    observation !== undefined &&
    hostPresent === true
  );
}

function mandatoryEvidenceViolation(
  field: LifecycleEvidenceField,
  value: LifecycleEvidenceValue | undefined,
  surfaceId: string,
  authority: RuntimeLifecycleAuthority,
): LifecycleSupportFloorViolation | null {
  const location = `surfaces.${surfaceId}.${field}`;
  if (value === undefined && authority.supportFloorPolicy.unknownOrMissingMandatoryBlocks) {
    return {
      code: "mandatory_evidence_missing",
      detail: `${location} is required but missing`,
      surfaceId,
      field,
      observed: "missing",
    };
  }
  if (value === "unknown" && authority.supportFloorPolicy.unknownOrMissingMandatoryBlocks) {
    return {
      code: "mandatory_evidence_unknown",
      detail: `${location} is required but unverified`,
      surfaceId,
      field,
      observed: value,
    };
  }
  if (
    field === "trusted" &&
    authority.supportFloorPolicy.deniedMandatoryTrustBlocks &&
    (value === "denied" || value === false)
  ) {
    return {
      code: "mandatory_trust_denied",
      detail: `${location} is required but trust is denied`,
      surfaceId,
      field,
      observed: value,
    };
  }
  if (value === "denied") {
    return {
      code: "mandatory_evidence_denied",
      detail: `${location} is required but denied`,
      surfaceId,
      field,
      observed: value,
    };
  }
  if (value === "not_applicable") {
    return {
      code: "mandatory_evidence_not_applicable",
      detail: `${location} cannot be not_applicable on an expected surface`,
      surfaceId,
      field,
      observed: value,
    };
  }
  if (
    value === false &&
    !authority.supportFloorPolicy.knownFalseDiagnosesDegraded.includes(field)
  ) {
    return {
      code: "mandatory_evidence_denied",
      detail: `${location} is required but false is not a diagnosed degraded state for this field`,
      surfaceId,
      field,
      observed: value,
    };
  }
  return null;
}

function surfaceState(
  definition: LifecycleSurfaceDefinition,
  observation: LifecycleSurfaceObservation | undefined,
  authority: RuntimeLifecycleAuthority,
): LifecycleSurfaceState {
  const evidence = observation?.evidence ?? {};
  const expected = observedSurfaceExpected(definition, observation, authority);
  const applicability: LifecycleApplicability =
    definition.presence === "required" ? "required" : expected ? "conditional" : "not_applicable";
  const missing = expected
    ? authority.evidenceFields.filter((field) => evidence[field] === undefined)
    : [];
  const unmet = [...new Set([...(observation?.unmetMandatoryFields ?? []), ...missing])];
  const diagnosisComplete = observation?.diagnosisComplete === true && unmet.length === 0;
  const supportFloorViolations = expected
    ? authority.evidenceFields.flatMap((field) => {
        const violation = mandatoryEvidenceViolation(
          field,
          evidence[field],
          definition.id,
          authority,
        );
        return violation ? [violation] : [];
      })
    : [];
  const releaseBlocking = supportFloorViolations.length > 0 || !diagnosisComplete;
  let status: LifecycleSurfaceStatus;
  if (!expected) status = "not_applicable";
  else if (
    supportFloorViolations.some(
      (violation) =>
        violation.code === "mandatory_trust_denied" ||
        violation.code === "mandatory_evidence_denied" ||
        violation.code === "mandatory_evidence_not_applicable",
    )
  )
    status = "blocked";
  else if (!diagnosisComplete || supportFloorViolations.length > 0) status = "unknown";
  else if (Object.values(evidence).some((value) => value === false)) {
    status = "degraded";
  } else status = "ready";
  return {
    ...definition,
    expected,
    applicability,
    status,
    evidence,
    diagnosisComplete,
    unmetMandatoryFields: unmet,
    releaseBlocking,
    supportFloorViolations,
  };
}

export function buildRuntimeLifecycleState(
  authority: RuntimeLifecycleAuthority,
  observations: LifecycleRuntimeObservation[],
): RuntimeLifecycleState {
  const duplicateObservationIds = observations
    .map((observation) => observation.runtimeId)
    .filter((id, index, ids) => ids.indexOf(id) !== index);
  if (duplicateObservationIds.length > 0) {
    throw new LifecycleAuthorityError(
      `duplicate lifecycle observations for runtime ${[...new Set(duplicateObservationIds)].join(", ")}`,
    );
  }
  const activeIds = new Set(authority.runtimes.map((runtime) => runtime.id));
  const unknown = observations.find((observation) => !activeIds.has(observation.runtimeId));
  if (unknown) {
    throw new LifecycleAuthorityError(
      `unknown active runtime observation ${unknown.runtimeId}; expected ${[...activeIds].join(", ")}`,
    );
  }

  const runtimes = authority.runtimes.map((runtime): LifecycleRuntimeState => {
    const observation = observations.find((candidate) => candidate.runtimeId === runtime.id);
    const observedSurfaces = observation?.surfaces ?? [];
    const duplicateSurfaceIds = observedSurfaces
      .map((surface) => surface.id)
      .filter((id, index, ids) => ids.indexOf(id) !== index);
    if (duplicateSurfaceIds.length > 0) {
      throw new LifecycleAuthorityError(
        `${runtime.id}: duplicate lifecycle observations for surface ${[...new Set(duplicateSurfaceIds)].join(", ")}`,
      );
    }
    const unknownSurface = observedSurfaces.find(
      (surface) => !runtime.surfaces.some((definition) => definition.id === surface.id),
    );
    if (unknownSurface) {
      throw new LifecycleAuthorityError(
        `${runtime.id}: unknown lifecycle surface ${unknownSurface.id}; expected ${runtime.surfaces.map((surface) => surface.id).join(", ")}`,
      );
    }
    const surfaces = runtime.surfaces.map((definition) =>
      surfaceState(
        definition,
        observedSurfaces.find((surface) => surface.id === definition.id),
        authority,
      ),
    );
    const canonicalSkillDetected = observation?.canonicalSkillDetected ?? "unknown";
    const violations: LifecycleSupportFloorViolation[] = [];
    if (canonicalSkillDetected === "unknown") {
      violations.push({
        code: "canonical_skill_unknown",
        detail: "canonical shared skill detection is required but unverified",
        observed: canonicalSkillDetected,
      });
    } else if (canonicalSkillDetected !== true) {
      violations.push({
        code: "canonical_skill_not_detected",
        detail: "canonical shared skill is required but not detected",
        observed: canonicalSkillDetected,
      });
    }
    if (observation?.diagnosisComplete !== true) {
      violations.push({
        code: "diagnosis_incomplete",
        detail: "required runtime lifecycle diagnosis is incomplete",
      });
    }
    for (const surface of surfaces.filter((candidate) => candidate.expected)) {
      violations.push(...surface.supportFloorViolations);
      if (!surface.diagnosisComplete && observation?.diagnosisComplete === true) {
        violations.push({
          code: "diagnosis_incomplete",
          detail: `required lifecycle diagnosis is incomplete for surface ${surface.id}`,
          surfaceId: surface.id,
        });
      }
    }
    const uniqueViolations = violations.filter(
      (violation, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.code === violation.code &&
            candidate.surfaceId === violation.surfaceId &&
            candidate.field === violation.field,
        ) === index,
    );
    const unmet = uniqueViolations.map((violation) =>
      [violation.code, violation.surfaceId, violation.field].filter(Boolean).join(":"),
    );
    const blocked = uniqueViolations.length > 0;
    const degraded = surfaces.some((surface) => surface.expected && surface.status !== "ready");
    return {
      runtimeId: runtime.id,
      displayName: runtime.displayName,
      status: blocked ? "blocked" : degraded ? "degraded" : "ready",
      canonicalSkill: {
        path: authority.canonicalSkillPath,
        detected: canonicalSkillDetected,
      },
      diagnosisComplete: observation?.diagnosisComplete === true,
      surfaces,
      supportFloor: {
        met: !blocked,
        releaseBlocking: blocked,
        unmet,
        violations: uniqueViolations,
      },
    };
  });
  return {
    schemaVersion: "agentera.runtimeLifecycleState.v1",
    authority: authority.sourcePath,
    activeRuntimeIds: runtimes.map((runtime) => runtime.runtimeId),
    runtimes,
    releaseBlocked: runtimes.some((runtime) => runtime.supportFloor.releaseBlocking),
  };
}

export function isLifecycleEvidenceValue(value: unknown): value is LifecycleEvidenceValue {
  return EVIDENCE_VALUES.has(value as LifecycleEvidenceValue);
}
