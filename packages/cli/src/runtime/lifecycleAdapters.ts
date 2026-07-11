import fs from "node:fs";
import path from "node:path";

import {
  buildRuntimeLifecycleState,
  loadLifecycleAuthority,
  type LifecycleEvidenceValue,
  type LifecycleRuntimeObservation,
  type LifecycleSurfaceDefinition,
  type RuntimeLifecycleAuthority,
  type RuntimeLifecycleState,
  type LifecycleSupportFloorViolation,
} from "./lifecycleAuthority.js";
import {
  RUNTIME_ADAPTER_CATEGORIES,
  loadRuntimeLifecycleAdapterContract,
  type RuntimeAdapterCapability,
  type RuntimeAdapterCategory,
  type RuntimeAdapterCategoryClaim,
  type RuntimeAdapterEvidenceState,
  type RuntimeAdapterNativeActionDeclaration,
  type RuntimeAdapterRemediationKind,
  type RuntimeAdapterResourceDeclaration,
  type RuntimeLifecycleAdapterContract,
  type RuntimeLifecycleAdapterDefinition,
} from "./lifecycleAdapterContract.js";
import {
  applyLifecycleOperations,
  createLifecycleOwnershipManifest,
  emptyLifecycleOwnershipLedger,
  planLifecycleOperations,
  type LifecycleApplyOptions,
  type LifecycleApplyResult,
  type LifecycleOperationPlan,
  type LifecycleOperationSpec,
  type LifecycleOwnershipLedger,
  type PlannedLifecycleOperation,
} from "./lifecycleOperations.js";

type SurfaceEvidenceField = "host_present" | "installed" | "enabled" | "trusted";

export interface RuntimeAdapterInspectionContext {
  home: string;
  project: string;
  sourceRoot: string;
  env?: Record<string, string | undefined>;
  ledger?: LifecycleOwnershipLedger;
  surfaceEvidence?: Record<string, Partial<Record<SurfaceEvidenceField, LifecycleEvidenceValue>>>;
  categoryEvidence?: Partial<
    Record<RuntimeAdapterCategory, Record<string, LifecycleEvidenceValue>>
  >;
}

export interface RuntimeAdapterEvidence {
  kind: "filesystem" | "environment" | "contract" | "host_probe" | "ownership" | "native_action";
  state: RuntimeAdapterEvidenceState;
  detail: string;
  path?: string;
  surfaceId: string;
}

export interface RuntimeAdapterNativeAction {
  id: string;
  kind: "slash_action" | "argv" | "instruction";
  command: string | string[];
  instruction: string;
}

export interface RuntimeAdapterRemediation {
  kind: RuntimeAdapterRemediationKind;
  summary: string;
  operationIds: string[];
  nativeActions: RuntimeAdapterNativeAction[];
}

export interface RuntimeAdapterCategorySurfaceReport {
  surfaceId: string;
  expected: boolean;
  state: RuntimeAdapterEvidenceState;
  capability: RuntimeAdapterCapability;
  source: string;
  required: boolean;
  diagnosisComplete: boolean;
  evidence: RuntimeAdapterEvidence[];
  remediation: RuntimeAdapterRemediation;
}

export interface RuntimeAdapterCategoryReport {
  category: RuntimeAdapterCategory;
  state: RuntimeAdapterEvidenceState;
  diagnosisComplete: boolean;
  capabilities: RuntimeAdapterCapability[];
  surfaces: RuntimeAdapterCategorySurfaceReport[];
}

export interface RuntimeAdapterSupportFloor {
  met: boolean;
  diagnosisComplete: boolean;
  releaseBlocking: boolean;
  unmet: string[];
  violations: LifecycleSupportFloorViolation[];
}

export interface RuntimeAdapterReport {
  schemaVersion: "agentera.runtimeAdapterReport.v1";
  runtimeId: string;
  displayName: string;
  status: "ready" | "degraded" | "blocked";
  categories: Record<RuntimeAdapterCategory, RuntimeAdapterCategoryReport>;
  canonicalSkill: {
    path: string;
    detected: LifecycleEvidenceValue;
  };
  supportFloor: RuntimeAdapterSupportFloor;
  lifecycleObservation: LifecycleRuntimeObservation;
  repairPlan: LifecycleOperationPlan;
  caveats: string[];
}

export interface RuntimeAdapterMatrixReport {
  schemaVersion: "agentera.runtimeAdapterMatrix.v1";
  reports: RuntimeAdapterReport[];
  lifecycleState: RuntimeLifecycleState;
}

interface ExpandedResource {
  declaration: RuntimeAdapterResourceDeclaration;
  operation?: LifecycleOperationSpec;
  sourcePath: string;
  destinationPath: string;
  sourceError?: string;
  alreadyInPlace?: boolean;
}

interface SkillProbe {
  location: string;
  canonical: boolean;
  state: RuntimeAdapterEvidenceState;
  detail: string;
  surfaces: string[];
}

const STATE_PRIORITY: Record<RuntimeAdapterEvidenceState, number> = {
  blocked_unowned: 100,
  action_required: 95,
  denied: 90,
  shadowed: 80,
  drifted: 70,
  absent: 60,
  unknown: 40,
  unsupported: 30,
  confirmed: 20,
  not_applicable: 10,
};

function aggregateState(states: RuntimeAdapterEvidenceState[]): RuntimeAdapterEvidenceState {
  if (states.length === 0) return "unknown";
  return [...states].sort((left, right) => STATE_PRIORITY[right] - STATE_PRIORITY[left])[0];
}

function opencodeConfig(home: string, env: Record<string, string | undefined>): string {
  const xdg = env.XDG_CONFIG_HOME;
  return xdg ? path.resolve(xdg, "opencode") : path.resolve(home, ".config", "opencode");
}

function templateValues(context: RuntimeAdapterInspectionContext): Record<string, string> {
  const env = context.env ?? process.env;
  return {
    home: path.resolve(context.home),
    project: path.resolve(context.project),
    source_root: path.resolve(context.sourceRoot),
    opencode_config: opencodeConfig(context.home, env),
  };
}

function expandTemplate(template: string, values: Record<string, string>): string {
  const expanded = template.replace(/\{([a-z_]+)\}/g, (_match, key: string) => {
    const value = values[key];
    if (!value) throw new Error(`unknown lifecycle adapter path template {${key}}`);
    return value;
  });
  if (/[{}]/.test(expanded)) throw new Error(`unresolved lifecycle adapter path template ${template}`);
  return path.resolve(expanded);
}

function expandResource(
  declaration: RuntimeAdapterResourceDeclaration,
  values: Record<string, string>,
): ExpandedResource[] {
  const sourcePath = expandTemplate(declaration.source, values);
  const destinationPath = expandTemplate(declaration.destination, values);
  if (declaration.kind === "directory_files") {
    let entries: string[];
    try {
      entries = fs.readdirSync(sourcePath)
        .filter((name) => name.endsWith(declaration.extension as string))
        .sort();
    } catch (error) {
      return [{
        declaration,
        sourcePath,
        destinationPath,
        sourceError: `could not read declared source directory: ${(error as Error).message}`,
      }];
    }
    if (entries.length === 0) {
      return [{ declaration, sourcePath, destinationPath, sourceError: "declared source directory is empty" }];
    }
    return entries.map((name) => {
      const source = path.join(sourcePath, name);
      const destination = path.join(destinationPath, name);
      if (source === destination) {
        return { declaration, sourcePath: source, destinationPath: destination, alreadyInPlace: true };
      }
      try {
        return {
          declaration,
          sourcePath: source,
          destinationPath: destination,
          operation: {
            id: `${declaration.id}.${path.basename(name, declaration.extension)}`,
            destination,
            kind: "file",
            intent: "ensure",
            content: fs.readFileSync(source),
            required: declaration.required,
          },
        };
      } catch (error) {
        return {
          declaration,
          sourcePath: source,
          destinationPath: destination,
          sourceError: `could not read declared source: ${(error as Error).message}`,
        };
      }
    });
  }
  if (sourcePath === destinationPath) {
    return [{ declaration, sourcePath, destinationPath, alreadyInPlace: true }];
  }
  if (declaration.kind === "symlink") {
    if (!fs.existsSync(sourcePath)) {
      return [{ declaration, sourcePath, destinationPath, sourceError: "declared symlink source is missing" }];
    }
    return [{
      declaration,
      sourcePath,
      destinationPath,
      operation: {
        id: declaration.id,
        destination: destinationPath,
        kind: "symlink",
        intent: "ensure",
        linkTarget: sourcePath,
        required: declaration.required,
      },
    }];
  }
  try {
    return [{
      declaration,
      sourcePath,
      destinationPath,
      operation: {
        id: declaration.id,
        destination: destinationPath,
        kind: "file",
        intent: "ensure",
        content: fs.readFileSync(sourcePath),
        required: declaration.required,
      },
    }];
  } catch (error) {
    return [{
      declaration,
      sourcePath,
      destinationPath,
      sourceError: `could not read declared source: ${(error as Error).message}`,
    }];
  }
}

function nearestPlanState(operation: PlannedLifecycleOperation): RuntimeAdapterEvidenceState {
  switch (operation.action) {
    case "noop": return "confirmed";
    case "create": return "absent";
    case "update":
    case "finalize_ownership": return "drifted";
    case "blocked_unowned": return "blocked_unowned";
    case "action_required": return operation.ownership === "unowned" ? "blocked_unowned" : "action_required";
    case "remove": return "action_required";
  }
}

function probeSkill(location: string, canonical: boolean, surfaces: string[]): SkillProbe {
  const skillFile = path.join(location, "SKILL.md");
  try {
    const stat = fs.lstatSync(skillFile);
    if (!stat.isFile()) {
      return { location, canonical, surfaces, state: "drifted", detail: "SKILL.md is not a regular file" };
    }
    const handle = fs.openSync(skillFile, "r");
    try {
      const bytes = Buffer.alloc(Math.min(stat.size, 64 * 1024));
      fs.readSync(handle, bytes, 0, bytes.length, 0);
      const text = bytes.toString("utf8");
      if (!/^name:\s*agentera\s*$/m.test(text)) {
        return { location, canonical, surfaces, state: "drifted", detail: "SKILL.md does not declare name: agentera" };
      }
      return { location, canonical, surfaces, state: "confirmed", detail: "Agentera SKILL.md detected" };
    } finally {
      fs.closeSync(handle);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { location, canonical, surfaces, state: "absent", detail: "Agentera SKILL.md is absent" };
    }
    return {
      location,
      canonical,
      surfaces,
      state: "unknown",
      detail: `Agentera skill detection failed: ${(error as Error).message}`,
    };
  }
}

function probeBinary(
  binaries: string[],
  env: Record<string, string | undefined>,
): LifecycleEvidenceValue {
  const searchPath = env.PATH;
  if (searchPath === undefined) return "unknown";
  let unknown = false;
  for (const directory of searchPath.split(path.delimiter).slice(0, 128)) {
    if (!directory) continue;
    for (const binary of binaries) {
      try {
        fs.accessSync(path.join(directory, binary), fs.constants.X_OK);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "EACCES") {
          unknown = true;
        }
      }
    }
  }
  return unknown ? "unknown" : false;
}

function evidenceState(value: LifecycleEvidenceValue, category: RuntimeAdapterCategory): RuntimeAdapterEvidenceState {
  if (value === true) return "confirmed";
  if (value === "denied" || (category === "trust" && value === false)) return "denied";
  if (value === false) return "absent";
  if (value === "not_applicable") return "not_applicable";
  return "unknown";
}

function resourceReports(
  expanded: ExpandedResource[],
  plan: LifecycleOperationPlan,
  category: RuntimeAdapterCategory,
  surfaceId: string,
): {
  state: RuntimeAdapterEvidenceState;
  evidence: RuntimeAdapterEvidence[];
  operations: PlannedLifecycleOperation[];
} {
  const matching = expanded.filter((resource) =>
    resource.declaration.category === category
    && (resource.declaration.surfaceId === undefined || resource.declaration.surfaceId === surfaceId));
  const evidence: RuntimeAdapterEvidence[] = [];
  const states: RuntimeAdapterEvidenceState[] = [];
  const operations: PlannedLifecycleOperation[] = [];
  for (const resource of matching) {
    if (resource.sourceError) {
      states.push("unknown");
      evidence.push({
        kind: "filesystem",
        state: "unknown",
        detail: resource.sourceError,
        path: resource.sourcePath,
        surfaceId,
      });
      continue;
    }
    if (resource.alreadyInPlace) {
      states.push("confirmed");
      evidence.push({
        kind: "filesystem",
        state: "confirmed",
        detail: "declared source and destination are the same repository-owned path",
        path: resource.destinationPath,
        surfaceId,
      });
      continue;
    }
    const operation = resource.operation
      ? plan.operations.find((candidate) => candidate.id === resource.operation?.id)
      : undefined;
    const state = operation ? nearestPlanState(operation) : "unknown";
    states.push(state);
    if (operation) operations.push(operation);
    evidence.push({
      kind: "ownership",
      state,
      detail: operation?.reason ?? "declared resource has no operation plan",
      path: resource.destinationPath,
      surfaceId,
    });
  }
  return {
    state: matching.length === 0 ? "unknown" : aggregateState(states),
    evidence,
    operations,
  };
}

function actionRequiredSummary(operations: PlannedLifecycleOperation[]): string {
  const missingParentOperations = operations.filter((operation) =>
    operation.reason === "allowed root is not an existing safe directory");
  if (missingParentOperations.length === operations.length) {
    const parents = [...new Set(missingParentOperations.map((operation) => path.dirname(operation.destination)))];
    return `Create the destination parent ${parents.join(", ")} as a real, non-symlink directory you control, then rerun preview; Agentera will not create or replace it.`;
  }
  return `Resolve these lifecycle blockers manually, then rerun preview: ${operations
    .map((operation) => `${operation.id}: ${operation.reason}`)
    .join("; ")}.`;
}

function remediationFor(
  state: RuntimeAdapterEvidenceState,
  claim: RuntimeAdapterCategoryClaim,
  operations: PlannedLifecycleOperation[],
  nativeActions: RuntimeAdapterNativeActionDeclaration[],
  runtimeId: string,
  surfaceId: string,
  evidencePath?: string,
  sourceRoot?: string,
): RuntimeAdapterRemediation {
  const blockedOperations = operations.filter((operation) => operation.action === "blocked_unowned");
  if (blockedOperations.length > 0) {
    return {
      kind: "action_required",
      summary: "The destination is not ledger-owned; review the collision manually. Agentera will not adopt it by name or equality.",
      operationIds: blockedOperations.map((operation) => operation.id),
      nativeActions: [],
    };
  }
  const actionRequiredOperations = operations.filter((operation) =>
    operation.action === "action_required" || operation.action === "remove");
  if (actionRequiredOperations.length > 0) {
    return {
      kind: "action_required",
      summary: actionRequiredSummary(actionRequiredOperations),
      operationIds: actionRequiredOperations.map((operation) => operation.id),
      nativeActions: [],
    };
  }
  if (nativeActions.length > 0) {
    return {
      kind: "action_required",
      summary: "Host-native actions are user-owned and are reported for manual execution only.",
      operationIds: [],
      nativeActions: nativeActions.map((action) => ({
        id: action.id,
        kind: action.actionKind,
        command: action.command,
        instruction: action.instruction,
      })),
    };
  }
  const repairOperations = operations.filter((operation) =>
    ["create", "update", "finalize_ownership"].includes(operation.action));
  if (["absent", "drifted"].includes(state) && repairOperations.length > 0) {
    return {
      kind: "repair",
      summary: "Preview and approve the declared Agentera-owned operations through the shared lifecycle engine.",
      operationIds: repairOperations.map((operation) => operation.id),
      nativeActions: [],
    };
  }
  if (state === "action_required") {
    return {
      kind: "action_required",
      summary: "Review the action-required evidence and complete the user-owned step, then rerun preview.",
      operationIds: [],
      nativeActions: [],
    };
  }
  if (claim.remediation === "action_required") {
    let summary = `Review ${runtimeId} ${surfaceId} ${claim.evidence} manually; Agentera will not mutate host-owned configuration or trust.`;
    if (claim.evidence.startsWith("path:") && evidencePath) {
      summary = `Edit ${evidencePath} and set AGENTERA_HOME to ${sourceRoot}; Agentera will not edit or trust this user-owned configuration.`;
    } else if (claim.evidence === "env:AGENTERA_HOME") {
      summary = `Launch ${runtimeId} ${surfaceId} with AGENTERA_HOME=${sourceRoot} in its environment.`;
    } else if (claim.evidence === "external_observation") {
      summary = `Review ${runtimeId} ${surfaceId} in the host trust or enablement UI and approve or deny it there; Agentera will only observe the result.`;
    }
    return { kind: "action_required", summary, operationIds: [], nativeActions: [] };
  }
  if (state === "confirmed" || state === "not_applicable") {
    return { kind: "none", summary: "No remediation is required.", operationIds: [], nativeActions: [] };
  }
  return {
    kind: "unavailable",
    summary: claim.capability === "unsupported"
      ? "The host surface is explicitly unsupported."
      : "No verified safe remediation is declared for this host surface.",
    operationIds: [],
    nativeActions: [],
  };
}

function assertSurfaceRemediationConsistency(
  category: RuntimeAdapterCategory,
  state: RuntimeAdapterEvidenceState,
  operations: PlannedLifecycleOperation[],
  remediation: RuntimeAdapterRemediation,
): void {
  if (category !== "native_actions" && remediation.nativeActions.length > 0) {
    throw new Error(`${category}: native actions may only remediate the native_actions category`);
  }
  const blocked = operations.some((operation) => operation.action === "blocked_unowned");
  const actionRequired = operations.some((operation) =>
    operation.action === "action_required" || operation.action === "remove");
  if (blocked && (state !== "blocked_unowned" || remediation.kind !== "action_required")) {
    throw new Error(`${category}: blocked operation must produce blocked_unowned action-required reporting`);
  }
  if (!blocked && actionRequired && (state !== "action_required" || remediation.kind !== "action_required")) {
    throw new Error(`${category}: action-required operation must produce action_required reporting`);
  }
  if (remediation.kind === "repair") {
    const repairableIds = new Set(operations
      .filter((operation) => ["create", "update", "finalize_ownership"].includes(operation.action))
      .map((operation) => operation.id));
    if (
      remediation.operationIds.length === 0
      || remediation.operationIds.some((operationId) => !repairableIds.has(operationId))
    ) {
      throw new Error(`${category}: repair remediation must reference only repairable plan operations`);
    }
  }
}

function categorySurface(
  runtimeId: string,
  surface: LifecycleSurfaceDefinition,
  category: RuntimeAdapterCategory,
  claim: RuntimeAdapterCategoryClaim,
  expected: boolean,
  context: RuntimeAdapterInspectionContext,
  values: Record<string, string>,
  expanded: ExpandedResource[],
  plan: LifecycleOperationPlan,
  skills: SkillProbe[],
  nativeActions: RuntimeAdapterNativeActionDeclaration[],
): RuntimeAdapterCategorySurfaceReport {
  if (!expected) {
    return {
      surfaceId: surface.id,
      expected: false,
      state: "not_applicable",
      capability: "not_applicable",
      source: claim.evidence,
      required: false,
      diagnosisComplete: true,
      evidence: [{
        kind: "host_probe",
        state: "not_applicable",
        detail: "conditional host surface is absent",
        surfaceId: surface.id,
      }],
      remediation: { kind: "none", summary: "No remediation is required.", operationIds: [], nativeActions: [] },
    };
  }

  let state: RuntimeAdapterEvidenceState;
  let evidence: RuntimeAdapterEvidence[] = [];
  let operations: PlannedLifecycleOperation[] = [];
  let evidencePath: string | undefined;
  if (category === "skills") {
    const relevant = skills.filter((skill) => skill.surfaces.includes(surface.id));
    const canonical = relevant.find((skill) => skill.canonical);
    const nonCanonical = relevant.filter((skill) => !skill.canonical && skill.state === "confirmed");
    state = canonical?.state ?? "unknown";
    if (nonCanonical.length > 0) state = "shadowed";
    evidence = relevant.map((skill) => ({
      kind: "filesystem",
      state: skill.state,
      detail: skill.canonical
        ? `${skill.detail}; canonical shared location`
        : `${skill.detail}; additional discovery location can shadow or collide with canonical Agentera`,
      path: skill.location,
      surfaceId: surface.id,
    }));
    const resources = resourceReports(expanded, plan, category, surface.id);
    operations = resources.operations;
    evidence.push(...resources.evidence);
    state = aggregateState([state, resources.state]);
  } else if (claim.capability === "repairable" || claim.evidence.startsWith("managed_resource:")) {
    const resourceCategory = claim.evidence.startsWith("managed_resource:")
      ? expanded.find((resource) => resource.declaration.id === claim.evidence.slice("managed_resource:".length))?.declaration.category ?? category
      : category;
    const resources = resourceReports(expanded, plan, resourceCategory, surface.id);
    state = resources.state;
    evidence = resources.evidence;
    operations = resources.operations;
  } else if (claim.capability === "not_applicable") {
    state = "not_applicable";
    evidence = [{ kind: "contract", state, detail: claim.evidence, surfaceId: surface.id }];
  } else if (claim.capability === "unsupported") {
    state = "unsupported";
    evidence = [{ kind: "contract", state, detail: claim.evidence, surfaceId: surface.id }];
  } else if (category === "native_actions" && nativeActions.length > 0) {
    state = "action_required";
    evidence = nativeActions.map((action) => ({
      kind: "native_action",
      state,
      detail: action.instruction,
      surfaceId: surface.id,
    }));
  } else if (claim.evidence.startsWith("path:")) {
    evidencePath = expandTemplate(claim.evidence.slice("path:".length), values);
    try {
      const present = fs.lstatSync(evidencePath).isFile();
      state = present ? "confirmed" : "drifted";
    } catch (error) {
      state = (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unknown";
    }
    evidence = [{ kind: "filesystem", state, detail: claim.evidence, path: evidencePath, surfaceId: surface.id }];
  } else if (claim.evidence.startsWith("env:")) {
    const key = claim.evidence.slice("env:".length);
    const value = (context.env ?? process.env)[key];
    state = value ? "confirmed" : "absent";
    evidence = [{
      kind: "environment",
      state,
      detail: value ? `${key} is present` : `${key} is absent`,
      surfaceId: surface.id,
    }];
  } else if (claim.evidence === "canonical_skill") {
    const canonical = skills.find((skill) => skill.canonical && skill.surfaces.includes(surface.id));
    state = canonical?.state ?? "unknown";
    evidence = [{
      kind: "filesystem",
      state,
      detail: canonical?.detail ?? "canonical skill was not diagnosed",
      path: canonical?.location,
      surfaceId: surface.id,
    }];
    const resources = resourceReports(expanded, plan, "skills", surface.id);
    operations = resources.operations;
    evidence.push(...resources.evidence);
    state = aggregateState([state, resources.state]);
  } else {
    const override = context.categoryEvidence?.[category]?.[surface.id]
      ?? (category === "trust" ? context.surfaceEvidence?.[surface.id]?.trusted : undefined)
      ?? (category === "enablement" ? context.surfaceEvidence?.[surface.id]?.enabled : undefined);
    state = evidenceState(override ?? "unknown", category);
    evidence = [{
      kind: "contract",
      state,
      detail: override === undefined ? `${claim.evidence}; no verified host observation was supplied` : claim.evidence,
      surfaceId: surface.id,
    }];
  }

  const diagnosisComplete = claim.required
    ? state !== "unknown" && claim.capability !== "unverified"
    : true;
  const remediation = remediationFor(
    state,
    claim,
    operations,
    nativeActions,
    runtimeId,
    surface.id,
    evidencePath,
    context.sourceRoot,
  );
  assertSurfaceRemediationConsistency(category, state, operations, remediation);
  return {
    surfaceId: surface.id,
    expected,
    state,
    capability: claim.capability,
    source: claim.evidence,
    required: claim.required,
    diagnosisComplete,
    evidence,
    remediation,
  };
}

function canonicalDetection(skills: SkillProbe[]): LifecycleEvidenceValue {
  const canonical = skills.find((skill) => skill.canonical);
  if (!canonical || canonical.state === "unknown") return "unknown";
  return canonical.state === "confirmed" ? true : false;
}

function lifecycleObservation(
  runtimeId: string,
  surfaces: LifecycleSurfaceDefinition[],
  hostPresence: Record<string, LifecycleEvidenceValue>,
  categories: RuntimeAdapterReport["categories"],
  canonicalSkillDetected: LifecycleEvidenceValue,
  diagnosisComplete: boolean,
  context: RuntimeAdapterInspectionContext,
): LifecycleRuntimeObservation {
  return {
    runtimeId,
    canonicalSkillDetected,
    diagnosisComplete,
    unmetMandatoryFields: [],
    surfaces: surfaces.map((surface) => {
      const host = hostPresence[surface.id] ?? "unknown";
      const expected = surface.presence === "required" || host === true;
      const skill = categories.skills.surfaces.find((item) => item.surfaceId === surface.id);
      const trust = context.categoryEvidence?.trust?.[surface.id]
        ?? context.surfaceEvidence?.[surface.id]?.trusted
        ?? "unknown";
      let enabled: LifecycleEvidenceValue;
      if (!expected) enabled = "not_applicable";
      else if (context.surfaceEvidence?.[surface.id]?.enabled !== undefined) {
        enabled = context.surfaceEvidence[surface.id].enabled as LifecycleEvidenceValue;
      } else if (skill?.state === "confirmed") enabled = true;
      else if (skill?.state === "absent") enabled = false;
      else enabled = "unknown";
      return {
        id: surface.id,
        evidence: {
          host_present: host,
          installed: !expected ? "not_applicable" : canonicalSkillDetected,
          enabled,
          trusted: !expected ? "not_applicable" : trust,
        },
        diagnosisComplete: expected ? skill?.diagnosisComplete === true : true,
      };
    }),
  };
}

export class RuntimeLifecycleAdapter {
  protected readonly runtime: RuntimeLifecycleAdapterDefinition;
  protected readonly runtimeAuthority: RuntimeLifecycleAuthority["runtimes"][number];

  constructor(
    readonly runtimeId: string,
    protected readonly contract: RuntimeLifecycleAdapterContract = loadRuntimeLifecycleAdapterContract(),
    protected readonly authority: RuntimeLifecycleAuthority = loadLifecycleAuthority(),
  ) {
    const runtime = contract.adapters.find((candidate) => candidate.runtimeId === runtimeId);
    const runtimeAuthority = authority.runtimes.find((candidate) => candidate.id === runtimeId);
    if (!runtime || !runtimeAuthority) throw new Error(`unknown active runtime adapter ${runtimeId}`);
    this.runtime = runtime;
    this.runtimeAuthority = runtimeAuthority;
  }

  inspect(context: RuntimeAdapterInspectionContext): RuntimeAdapterReport {
    const env = context.env ?? process.env;
    const values = templateValues(context);
    const declarations = this.runtime.resourceRefs.map((id) => {
      const declaration = this.contract.resources.find((candidate) => candidate.id === id);
      if (!declaration) throw new Error(`${this.runtimeId}: missing declared resource ${id}`);
      return declaration;
    });
    const expanded = declarations.flatMap((declaration) => expandResource(declaration, values));
    const operations = expanded.flatMap((resource) => resource.operation ? [resource.operation] : []);
    const allowedRoots = [...new Set([
      path.resolve(context.sourceRoot),
      ...expanded.map((resource) => path.dirname(resource.destinationPath)),
    ])];
    const repairPlan = planLifecycleOperations({
      allowedRoots,
      operations,
      manifest: createLifecycleOwnershipManifest(operations),
      ledger: context.ledger ?? emptyLifecycleOwnershipLedger(),
    });
    const skills = this.runtime.skillLocations.map((location) =>
      probeSkill(expandTemplate(location.path, values), location.canonical, location.surfaces));
    const hostPresence: Record<string, LifecycleEvidenceValue> = {};
    for (const surface of this.runtimeAuthority.surfaces) {
      hostPresence[surface.id] = context.surfaceEvidence?.[surface.id]?.host_present
        ?? probeBinary(this.runtime.binaries[surface.id], env);
    }

    const categories = {} as RuntimeAdapterReport["categories"];
    for (const category of RUNTIME_ADAPTER_CATEGORIES) {
      const surfaceReports = this.runtimeAuthority.surfaces.map((surface) => {
        const host = hostPresence[surface.id];
        const expected = surface.presence === "required" || host === true;
        return categorySurface(
          this.runtimeId,
          surface,
          category,
          this.runtime.categories[category][surface.id],
          expected,
          context,
          values,
          expanded,
          repairPlan,
          skills,
          category === "native_actions"
            ? this.runtime.nativeActions.filter((action) => action.surfaceId === surface.id)
            : [],
        );
      });
      categories[category] = {
        category,
        state: aggregateState(surfaceReports.map((surface) => surface.state)),
        diagnosisComplete: surfaceReports.every((surface) => surface.diagnosisComplete),
        capabilities: [...new Set(surfaceReports.map((surface) => surface.capability))],
        surfaces: surfaceReports,
      };
    }

    const detected = canonicalDetection(skills);
    const requiredSkillReports = categories.skills.surfaces.filter((surface) => surface.required);
    const diagnosisComplete = detected !== "unknown"
      && requiredSkillReports.length > 0
      && requiredSkillReports.every((surface) => surface.diagnosisComplete);
    const observation = lifecycleObservation(
      this.runtimeId,
      this.runtimeAuthority.surfaces,
      hostPresence,
      categories,
      detected,
      diagnosisComplete,
      context,
    );
    const authoritativeState = buildRuntimeLifecycleState(this.authority, [observation])
      .runtimes.find((runtime) => runtime.runtimeId === this.runtimeId);
    if (!authoritativeState) throw new Error(`${this.runtimeId}: lifecycle authority state is missing`);
    const supportFloor: RuntimeAdapterSupportFloor = {
      ...authoritativeState.supportFloor,
      diagnosisComplete,
    };
    const expectedCategorySurfaces = RUNTIME_ADAPTER_CATEGORIES.flatMap((category) =>
      categories[category].surfaces.filter((surface) => surface.expected));
    const degraded = expectedCategorySurfaces.some((surface) =>
      !["confirmed", "not_applicable"].includes(surface.state));
    const caveats = [
      ...this.contract.caveats,
      ...expanded
      .filter((resource) => resource.sourceError)
      .map((resource) => `${resource.declaration.id}: ${resource.sourceError}`),
    ];
    return {
      schemaVersion: "agentera.runtimeAdapterReport.v1",
      runtimeId: this.runtimeId,
      displayName: this.runtimeAuthority.displayName,
      status: authoritativeState.status === "blocked" ? "blocked" : degraded ? "degraded" : "ready",
      categories,
      canonicalSkill: { path: this.authority.canonicalSkillPath, detected },
      supportFloor,
      lifecycleObservation: observation,
      repairPlan,
      caveats,
    };
  }
}

export class OpenCodeLifecycleAdapter extends RuntimeLifecycleAdapter {
  constructor(contract?: RuntimeLifecycleAdapterContract, authority?: RuntimeLifecycleAuthority) {
    super("opencode", contract, authority);
  }
}

export class CodexLifecycleAdapter extends RuntimeLifecycleAdapter {
  constructor(contract?: RuntimeLifecycleAdapterContract, authority?: RuntimeLifecycleAuthority) {
    super("codex", contract, authority);
  }
}

export class CursorLifecycleAdapter extends RuntimeLifecycleAdapter {
  constructor(contract?: RuntimeLifecycleAdapterContract, authority?: RuntimeLifecycleAuthority) {
    super("cursor", contract, authority);
  }
}

export class CopilotLifecycleAdapter extends RuntimeLifecycleAdapter {
  constructor(contract?: RuntimeLifecycleAdapterContract, authority?: RuntimeLifecycleAuthority) {
    super("copilot", contract, authority);
  }
}

export function runtimeLifecycleAdapters(
  contract = loadRuntimeLifecycleAdapterContract(),
  authority = loadLifecycleAuthority(),
): RuntimeLifecycleAdapter[] {
  return [
    new OpenCodeLifecycleAdapter(contract, authority),
    new CodexLifecycleAdapter(contract, authority),
    new CursorLifecycleAdapter(contract, authority),
    new CopilotLifecycleAdapter(contract, authority),
  ];
}

export function inspectRuntimeLifecycleAdapters(
  context: RuntimeAdapterInspectionContext,
  contract = loadRuntimeLifecycleAdapterContract(),
  authority = loadLifecycleAuthority(),
): RuntimeAdapterMatrixReport {
  const reports = runtimeLifecycleAdapters(contract, authority).map((adapter) => adapter.inspect(context));
  return {
    schemaVersion: "agentera.runtimeAdapterMatrix.v1",
    reports,
    lifecycleState: buildRuntimeLifecycleState(
      authority,
      reports.map((report) => report.lifecycleObservation),
    ),
  };
}

export function applyRuntimeAdapterRepair(
  report: RuntimeAdapterReport,
  options: LifecycleApplyOptions = {},
): LifecycleApplyResult {
  return applyLifecycleOperations(report.repairPlan, options);
}
