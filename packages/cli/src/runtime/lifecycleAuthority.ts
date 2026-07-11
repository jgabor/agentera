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

const EXPECTED_ACTIVE_RUNTIME_ORDER = "opencode,codex,cursor,copilot";
const EXPECTED_EVIDENCE_FIELDS = ["host_present", "installed", "enabled", "trusted"] as const;
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
export type LifecycleSurfaceStatus = "ready" | "degraded" | "unknown" | "not_applicable";

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
  runtimes: LifecycleRuntimeDefinition[];
}

export interface LifecycleSurfaceObservation {
  id: string;
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
  status: LifecycleSurfaceStatus;
  evidence: Partial<Record<LifecycleEvidenceField, LifecycleEvidenceValue>>;
  diagnosisComplete: boolean;
  unmetMandatoryFields: string[];
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
  if (data.schema_version !== "agentera.runtimeLifecycleAuthority.v1") {
    errors.push(sourceError(sourcePath, "schema_version", "must be agentera.runtimeLifecycleAuthority.v1"));
  }
  if (data.status !== "active_authority") {
    errors.push(sourceError(sourcePath, "status", "must be active_authority"));
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

  const runtimes = data.active_runtimes;
  if (!Array.isArray(runtimes)) {
    return [...errors, sourceError(sourcePath, "active_runtimes", "must be a list")];
  }
  const ids = runtimes.map((runtime) => (isMapping(runtime) ? stringField(runtime, "id") : ""));
  if (ids.join(",") !== EXPECTED_ACTIVE_RUNTIME_ORDER) {
    errors.push(
      sourceError(
        sourcePath,
        "active_runtimes",
        "active runtime IDs must be exactly opencode, codex, cursor, copilot in that order",
      ),
    );
  }
  ids.forEach((id, index) => {
    if (id === "claude" || id === "cursor-agent") {
      errors.push(
        sourceError(
          sourcePath,
          `active_runtimes[${index}].id`,
          `${id} cannot be an active runtime identity`,
        ),
      );
    }
  });

  runtimes.forEach((runtime, runtimeIndex) => {
    if (!isMapping(runtime)) {
      errors.push(sourceError(sourcePath, `active_runtimes[${runtimeIndex}]`, "must be an object"));
      return;
    }
    const surfaces = runtime.surfaces;
    if (!Array.isArray(surfaces) || surfaces.length === 0) {
      errors.push(
        sourceError(sourcePath, `active_runtimes[${runtimeIndex}].surfaces`, "must be a non-empty list"),
      );
      return;
    }
    const surfaceIds = surfaces.map((surface) => (isMapping(surface) ? stringField(surface, "id") : ""));
    if (new Set(surfaceIds).size !== surfaceIds.length) {
      errors.push(
        sourceError(sourcePath, `active_runtimes[${runtimeIndex}].surfaces`, "surface IDs must be unique"),
      );
    }
    surfaces.forEach((surface, surfaceIndex) => {
      if (!isMapping(surface)) {
        errors.push(
          sourceError(
            sourcePath,
            `active_runtimes[${runtimeIndex}].surfaces[${surfaceIndex}]`,
            "must be an object",
          ),
        );
        return;
      }
      if (surface.presence !== "required" && surface.presence !== "conditional") {
        errors.push(
          sourceError(
            sourcePath,
            `active_runtimes[${runtimeIndex}].surfaces[${surfaceIndex}].presence`,
            "must be required or conditional",
          ),
        );
      }
    });
  });

  const cursorIndex = ids.indexOf("cursor");
  const cursor = cursorIndex >= 0 ? runtimes[cursorIndex] : null;
  const cursorSurfaces = isMapping(cursor) && Array.isArray(cursor.surfaces) ? cursor.surfaces : [];
  const cursorSurfaceShape = cursorSurfaces.map((surface) =>
    isMapping(surface) ? `${stringField(surface, "id")}:${String(surface.presence)}` : "",
  );
  if (cursorSurfaceShape.join(",") !== "cli:required,ide:conditional") {
    errors.push(
      sourceError(
        sourcePath,
        `active_runtimes[${cursorIndex < 0 ? "cursor" : cursorIndex}].surfaces`,
        "Cursor surfaces must be cli:required and ide:conditional beneath runtime cursor",
      ),
    );
  }
  const retiredInputs = data.retired_runtime_inputs;
  if (
    !Array.isArray(retiredInputs) ||
    retiredInputs.length !== 1 ||
    !isMapping(retiredInputs[0]) ||
    retiredInputs[0].id !== "claude" ||
    retiredInputs[0].purpose !== "consent_gated_historical_import"
  ) {
    errors.push(
      sourceError(
        sourcePath,
        "retired_runtime_inputs",
        "must contain only claude as a consent_gated_historical_import",
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
    throw new LifecycleAuthorityError(`Runtime lifecycle authority validation failed: ${errors.join("; ")}`);
  }
  const canonicalSkill = data.canonical_skill as JsonObject;
  const evidence = data.evidence_contract as JsonObject;
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
    if (!INVENTORY_SCAN_EXTENSIONS.has(path.extname(entryPath)) || path.resolve(entryPath) === canonicalPath) {
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
    return [`${LIFECYCLE_AUTHORITY_RELATIVE_PATH}:1: could not parse authority: ${(error as Error).message}`];
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
): boolean {
  if (definition.presence === "required") return true;
  const hostPresent = observation?.evidence?.host_present;
  return observation !== undefined && hostPresent !== false && hostPresent !== "not_applicable";
}

function surfaceState(
  definition: LifecycleSurfaceDefinition,
  observation: LifecycleSurfaceObservation | undefined,
  evidenceFields: LifecycleEvidenceField[],
): LifecycleSurfaceState {
  const evidence = observation?.evidence ?? {};
  const expected = observedSurfaceExpected(definition, observation);
  const missing = expected ? evidenceFields.filter((field) => evidence[field] === undefined) : [];
  const unmet = [...new Set([...(observation?.unmetMandatoryFields ?? []), ...missing])];
  const diagnosisComplete = observation?.diagnosisComplete === true && unmet.length === 0;
  let status: LifecycleSurfaceStatus;
  if (!expected) status = "not_applicable";
  else if (!diagnosisComplete) status = "unknown";
  else if (Object.values(evidence).some((value) =>
    value === false || value === "unknown" || value === "denied" || value === "not_applicable"
  )) {
    status = "degraded";
  } else status = "ready";
  return {
    ...definition,
    expected,
    status,
    evidence,
    diagnosisComplete,
    unmetMandatoryFields: unmet,
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
        authority.evidenceFields,
      ),
    );
    const unmet = [...(observation?.unmetMandatoryFields ?? [])];
    const canonicalSkillDetected = observation?.canonicalSkillDetected ?? "unknown";
    if (canonicalSkillDetected !== true) unmet.push("canonical_shared_skill_detected");
    if (observation?.diagnosisComplete !== true) unmet.push("diagnosis_complete");
    for (const surface of surfaces.filter((candidate) => candidate.expected)) {
      for (const field of surface.unmetMandatoryFields) unmet.push(`surfaces.${surface.id}.${field}`);
      if (!surface.diagnosisComplete) unmet.push(`surfaces.${surface.id}.diagnosis_complete`);
    }
    const uniqueUnmet = [...new Set(unmet)];
    const blocked = uniqueUnmet.length > 0;
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
        unmet: uniqueUnmet,
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
