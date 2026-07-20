import fs from "node:fs";
import path from "node:path";

import type { JsonObject } from "../core/jsonValue.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { loadYamlMapping } from "../core/yaml.js";
import {
  LIFECYCLE_ADAPTER_CONTRACT_RELATIVE_PATH,
  LIFECYCLE_AUTHORITY_RELATIVE_PATH,
  loadLifecycleAuthority,
  type RuntimeLifecycleAuthority,
} from "./lifecycleAuthority.js";
import { LIFECYCLE_OPERATION_CONTRACT_RELATIVE_PATH } from "./lifecycleOperations.js";

export const RUNTIME_LIFECYCLE_ADAPTER_CONTRACT_RELATIVE_PATH =
  LIFECYCLE_ADAPTER_CONTRACT_RELATIVE_PATH;

export const RUNTIME_ADAPTER_CATEGORIES = [
  "skills",
  "plugins",
  "hooks",
  "agents",
  "configuration",
  "enablement",
  "trust",
  "native_actions",
] as const;

export const RUNTIME_ADAPTER_CAPABILITIES = [
  "repairable",
  "observable",
  "action_required",
  "unsupported",
  "unverified",
  "not_applicable",
] as const;

export const RUNTIME_ADAPTER_EVIDENCE_STATES = [
  "confirmed",
  "absent",
  "drifted",
  "shadowed",
  "denied",
  "unknown",
  "blocked_unowned",
  "unsupported",
  "not_applicable",
  "action_required",
] as const;

export const RUNTIME_ADAPTER_REMEDIATION_KINDS = [
  "none",
  "repair",
  "action_required",
  "unavailable",
] as const;

export type RuntimeAdapterCategory = (typeof RUNTIME_ADAPTER_CATEGORIES)[number];
export type RuntimeAdapterCapability = (typeof RUNTIME_ADAPTER_CAPABILITIES)[number];
export type RuntimeAdapterEvidenceState = (typeof RUNTIME_ADAPTER_EVIDENCE_STATES)[number];
export type RuntimeAdapterRemediationKind = (typeof RUNTIME_ADAPTER_REMEDIATION_KINDS)[number];

export interface RuntimeAdapterCategoryClaim {
  capability: RuntimeAdapterCapability;
  evidence: string;
  remediation: string;
  required: boolean;
}

export interface RuntimeAdapterResourceDeclaration {
  id: string;
  runtimeId?: string;
  surfaceId?: string;
  category: RuntimeAdapterCategory;
  kind: "file" | "symlink" | "directory_files";
  source: string;
  destination: string;
  extension?: string;
  required: boolean;
}

export interface RuntimeAdapterSkillLocation {
  path: string;
  scope: string;
  canonical: boolean;
  surfaces: string[];
}

export interface RuntimeAdapterNativeActionDeclaration {
  id: string;
  surfaceId: string;
  actionKind: "slash_action" | "argv" | "instruction";
  command: string | string[];
  instruction: string;
}

export interface RuntimeLifecycleAdapterDefinition {
  runtimeId: string;
  binaries: Record<string, string[]>;
  resourceRefs: string[];
  skillLocations: RuntimeAdapterSkillLocation[];
  categories: Record<RuntimeAdapterCategory, Record<string, RuntimeAdapterCategoryClaim>>;
  nativeActions: RuntimeAdapterNativeActionDeclaration[];
}

export interface RuntimeLifecycleAdapterContract {
  sourcePath: string;
  forbiddenDestinationSegments: string[];
  caveats: string[];
  resources: RuntimeAdapterResourceDeclaration[];
  adapters: RuntimeLifecycleAdapterDefinition[];
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameList(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && JSON.stringify(value) === JSON.stringify(expected);
}

function sourceError(sourcePath: string, location: string, message: string): string {
  return `${sourcePath}:${location}: ${message}`;
}

function stringField(value: Record<string, unknown>, field: string): string {
  return typeof value[field] === "string" ? value[field] : "";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function forbiddenDestinationSegment(destination: string, forbidden: string[]): string | null {
  const segments = destination
    .toLowerCase()
    .split(/[\\/]+/)
    .filter(Boolean);
  return forbidden.find((candidate) => segments.includes(candidate.toLowerCase())) ?? null;
}

function validateResource(
  resource: unknown,
  location: string,
  sourcePath: string,
  forbidden: string[],
  runtimeIds: Set<string>,
  errors: string[],
): void {
  if (!isMapping(resource)) {
    errors.push(sourceError(sourcePath, location, "must be an object"));
    return;
  }
  const id = stringField(resource, "id");
  if (!id) errors.push(sourceError(sourcePath, `${location}.id`, "must be a non-empty string"));
  if (!RUNTIME_ADAPTER_CATEGORIES.includes(resource.category as RuntimeAdapterCategory)) {
    errors.push(
      sourceError(sourcePath, `${location}.category`, "must name a common adapter category"),
    );
  }
  if (!["file", "symlink", "directory_files"].includes(String(resource.kind))) {
    errors.push(
      sourceError(sourcePath, `${location}.kind`, "must be file, symlink, or directory_files"),
    );
  }
  for (const field of ["source", "destination"]) {
    if (typeof resource[field] !== "string" || !(resource[field] as string).startsWith("{")) {
      errors.push(
        sourceError(sourcePath, `${location}.${field}`, "must be an explicit rooted template"),
      );
    }
  }
  const destination = stringField(resource, "destination");
  const forbiddenSegment = forbiddenDestinationSegment(destination, forbidden);
  if (forbiddenSegment) {
    errors.push(
      sourceError(
        sourcePath,
        `${location}.destination`,
        `must not target runtime or package cache segment ${forbiddenSegment}`,
      ),
    );
  }
  if (resource.kind === "directory_files" && typeof resource.extension !== "string") {
    errors.push(
      sourceError(sourcePath, `${location}.extension`, "is required for directory_files"),
    );
  }
  if (resource.required !== true && resource.required !== false) {
    errors.push(sourceError(sourcePath, `${location}.required`, "must be explicit true or false"));
  }
  if (resource.runtime_id !== undefined && !runtimeIds.has(String(resource.runtime_id))) {
    errors.push(
      sourceError(sourcePath, `${location}.runtime_id`, "must name an active authority runtime"),
    );
  }
}

export function validateRuntimeLifecycleAdapterContractData(
  data: unknown,
  authority: RuntimeLifecycleAuthority,
  sourcePath = RUNTIME_LIFECYCLE_ADAPTER_CONTRACT_RELATIVE_PATH,
): string[] {
  if (!isMapping(data))
    return [sourceError(sourcePath, "1", "adapter contract must be a YAML object")];
  const errors: string[] = [];
  if (data.schema_version !== "agentera.runtimeLifecycleAdapters.v1") {
    errors.push(
      sourceError(sourcePath, "schema_version", "must be agentera.runtimeLifecycleAdapters.v1"),
    );
  }
  if (data.status !== "migration_only_contract") {
    errors.push(sourceError(sourcePath, "status", "must be migration_only_contract"));
  }
  if (data.decision !== 92)
    errors.push(sourceError(sourcePath, "decision", "must cite Decision 92"));
  if (data.authority !== LIFECYCLE_AUTHORITY_RELATIVE_PATH) {
    errors.push(
      sourceError(sourcePath, "authority", `must point to ${LIFECYCLE_AUTHORITY_RELATIVE_PATH}`),
    );
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
  if (!sameList(data.categories, RUNTIME_ADAPTER_CATEGORIES)) {
    errors.push(
      sourceError(
        sourcePath,
        "categories",
        `must be exactly ${RUNTIME_ADAPTER_CATEGORIES.join(", ")}`,
      ),
    );
  }
  const categoryContract = isMapping(data.category_contract) ? data.category_contract : {};
  if (!sameList(categoryContract.required_fields, ["capability", "evidence", "remediation"])) {
    errors.push(
      sourceError(
        sourcePath,
        "category_contract.required_fields",
        "must require capability, evidence, remediation",
      ),
    );
  }
  if (!sameList(categoryContract.capabilities, RUNTIME_ADAPTER_CAPABILITIES)) {
    errors.push(
      sourceError(
        sourcePath,
        "category_contract.capabilities",
        "does not match runtime capability vocabulary",
      ),
    );
  }
  if (!sameList(categoryContract.evidence_states, RUNTIME_ADAPTER_EVIDENCE_STATES)) {
    errors.push(
      sourceError(
        sourcePath,
        "category_contract.evidence_states",
        "does not match runtime evidence vocabulary",
      ),
    );
  }
  if (!sameList(categoryContract.remediation_kinds, RUNTIME_ADAPTER_REMEDIATION_KINDS)) {
    errors.push(
      sourceError(
        sourcePath,
        "category_contract.remediation_kinds",
        "does not match remediation vocabulary",
      ),
    );
  }
  const supportFloor = isMapping(data.support_floor) ? data.support_floor : {};
  if (
    supportFloor.authority !== `${LIFECYCLE_AUTHORITY_RELATIVE_PATH}#support_floor` ||
    supportFloor.required_category !== "skills" ||
    supportFloor.required_capability !== "repairable" ||
    supportFloor.unknown_or_unverified_required_detection_blocks !== true ||
    supportFloor.incomplete_required_diagnosis_blocks !== true ||
    supportFloor.unknown_or_missing_mandatory_evidence_blocks !== true ||
    supportFloor.denied_required_trust_blocks !== true ||
    supportFloor.known_false_presence_install_enable_is_diagnosed_degraded !== true ||
    supportFloor.not_applicable_only_for_unobserved_conditional_surface !== true
  ) {
    errors.push(
      sourceError(
        sourcePath,
        "support_floor",
        "must delegate exact fail-closed evidence semantics to lifecycle authority",
      ),
    );
  }
  const nativePolicy = isMapping(data.native_policy) ? data.native_policy : {};
  if (
    nativePolicy.execution !== "forbidden" ||
    nativePolicy.exact_action_required_only !== true ||
    nativePolicy.install_update_enable_auth_trust_are_user_owned !== true
  ) {
    errors.push(
      sourceError(
        sourcePath,
        "native_policy",
        "must keep every native mutation user-owned and non-executing",
      ),
    );
  }
  const pathPolicy = isMapping(data.path_policy) ? data.path_policy : {};
  const forbidden = stringList(pathPolicy.forbidden_destination_segments);
  if (
    pathPolicy.destination_templates_are_declarations !== true ||
    pathPolicy.matching_ledger_required_for_existing_resources !== true ||
    pathPolicy.equality_or_name_never_establishes_ownership !== true ||
    forbidden.length === 0
  ) {
    errors.push(
      sourceError(
        sourcePath,
        "path_policy",
        "must declare ledger-only ownership and cache exclusions",
      ),
    );
  }
  const caveats = stringList(data.known_caveats);
  if (
    caveats.length === 0 ||
    !caveats.some(
      (caveat) =>
        caveat.includes("Append-only ownership journal recovery") &&
        caveat.includes("strict contiguous hash chain") &&
        caveat.includes("blocks malformed or disconnected final events") &&
        caveat.includes("re-observes every resource"),
    )
  ) {
    errors.push(
      sourceError(
        sourcePath,
        "known_caveats",
        "must declare strict append-only chain validation, atomic-tail recovery, and per-resource re-observation",
      ),
    );
  }

  const runtimeIds = new Set(authority.runtimes.map((runtime) => runtime.id));
  const sharedResources = Array.isArray(data.shared_resources) ? data.shared_resources : [];
  const managedResources = Array.isArray(data.managed_resources) ? data.managed_resources : [];
  sharedResources.forEach((resource, index) =>
    validateResource(
      resource,
      `shared_resources[${index}]`,
      sourcePath,
      forbidden,
      runtimeIds,
      errors,
    ),
  );
  managedResources.forEach((resource, index) =>
    validateResource(
      resource,
      `managed_resources[${index}]`,
      sourcePath,
      forbidden,
      runtimeIds,
      errors,
    ),
  );
  const allResources = [...sharedResources, ...managedResources];
  const resourceIds = allResources.map((resource) =>
    isMapping(resource) ? stringField(resource, "id") : "",
  );
  const duplicateResource = resourceIds.find(
    (id, index) => id && resourceIds.indexOf(id) !== index,
  );
  if (duplicateResource) {
    errors.push(
      sourceError(sourcePath, "managed_resources", `duplicate resource id ${duplicateResource}`),
    );
  }
  const canonical = sharedResources.find(
    (resource) => isMapping(resource) && resource.id === "canonical_skill",
  );
  if (authority.runtimes.length > 0 && (
    !isMapping(canonical) ||
    canonical.destination !== "{home}/.agents/skills/agentera" ||
    canonical.source !== "{source_root}/skills/agentera" ||
    canonical.kind !== "symlink" ||
    canonical.required !== true
  )) {
    errors.push(
      sourceError(
        sourcePath,
        "shared_resources.canonical_skill",
        "must declare the canonical shared skill symlink",
      ),
    );
  }

  const adapters = Array.isArray(data.adapters) ? data.adapters : [];
  const adapterIds = adapters.map((adapter) =>
    isMapping(adapter) ? stringField(adapter, "runtime_id") : "",
  );
  const expectedIds = authority.runtimes.map((runtime) => runtime.id);
  if (JSON.stringify(adapterIds) !== JSON.stringify(expectedIds)) {
    errors.push(
      sourceError(
        sourcePath,
        "adapters",
        `runtime IDs must follow authority exactly: ${expectedIds.join(", ")}`,
      ),
    );
  }
  adapters.forEach((adapter, adapterIndex) => {
    const location = `adapters[${adapterIndex}]`;
    if (!isMapping(adapter)) {
      errors.push(sourceError(sourcePath, location, "must be an object"));
      return;
    }
    const runtimeId = stringField(adapter, "runtime_id");
    if (runtimeId === "claude" || runtimeId === "cursor-agent") {
      errors.push(
        sourceError(
          sourcePath,
          `${location}.runtime_id`,
          `${runtimeId} cannot be an active adapter`,
        ),
      );
    }
    const runtime = authority.runtimes.find((candidate) => candidate.id === runtimeId);
    const expectedSurfaces = runtime?.surfaces.map((surface) => surface.id) ?? [];
    const binaries = isMapping(adapter.binaries) ? adapter.binaries : {};
    if (JSON.stringify(Object.keys(binaries)) !== JSON.stringify(expectedSurfaces)) {
      errors.push(
        sourceError(
          sourcePath,
          `${location}.binaries`,
          `must declare surfaces ${expectedSurfaces.join(", ")}`,
        ),
      );
    }
    for (const surface of expectedSurfaces) {
      if (stringList(binaries[surface]).length === 0) {
        errors.push(
          sourceError(
            sourcePath,
            `${location}.binaries.${surface}`,
            "must list at least one bounded binary probe",
          ),
        );
      }
    }
    const refs = stringList(adapter.resource_refs);
    if (!refs.includes("canonical_skill")) {
      errors.push(
        sourceError(sourcePath, `${location}.resource_refs`, "must include canonical_skill"),
      );
    }
    for (const ref of refs) {
      const resource = allResources.find(
        (candidate) => isMapping(candidate) && candidate.id === ref,
      );
      if (!resource)
        errors.push(
          sourceError(sourcePath, `${location}.resource_refs`, `unknown resource ${ref}`),
        );
      else if (
        isMapping(resource) &&
        resource.runtime_id !== undefined &&
        resource.runtime_id !== runtimeId
      ) {
        errors.push(
          sourceError(
            sourcePath,
            `${location}.resource_refs`,
            `${ref} belongs to ${String(resource.runtime_id)}`,
          ),
        );
      }
    }
    const skillLocations = Array.isArray(adapter.skill_locations) ? adapter.skill_locations : [];
    const canonicalLocations = skillLocations.filter(
      (item) => isMapping(item) && item.canonical === true,
    );
    if (
      canonicalLocations.length !== 1 ||
      !isMapping(canonicalLocations[0]) ||
      canonicalLocations[0].path !== "{home}/.agents/skills/agentera"
    ) {
      errors.push(
        sourceError(
          sourcePath,
          `${location}.skill_locations`,
          "must identify exactly one canonical shared skill path",
        ),
      );
    }
    const categories = isMapping(adapter.categories) ? adapter.categories : {};
    for (const category of RUNTIME_ADAPTER_CATEGORIES) {
      const claims = isMapping(categories[category]) ? categories[category] : null;
      if (!claims) {
        errors.push(
          sourceError(
            sourcePath,
            `${location}.categories.${category}`,
            "missing common category claims",
          ),
        );
        continue;
      }
      if (JSON.stringify(Object.keys(claims)) !== JSON.stringify(expectedSurfaces)) {
        errors.push(
          sourceError(
            sourcePath,
            `${location}.categories.${category}`,
            `must report surfaces ${expectedSurfaces.join(", ")}`,
          ),
        );
      }
      for (const surface of expectedSurfaces) {
        const claim = claims[surface];
        const claimLocation = `${location}.categories.${category}.${surface}`;
        if (!isMapping(claim)) {
          errors.push(sourceError(sourcePath, claimLocation, "must be an object"));
          continue;
        }
        if (!RUNTIME_ADAPTER_CAPABILITIES.includes(claim.capability as RuntimeAdapterCapability)) {
          errors.push(sourceError(sourcePath, `${claimLocation}.capability`, "is invalid"));
        }
        if (typeof claim.evidence !== "string" || !claim.evidence) {
          errors.push(sourceError(sourcePath, `${claimLocation}.evidence`, "must be explicit"));
        }
        if (typeof claim.remediation !== "string" || !claim.remediation) {
          errors.push(sourceError(sourcePath, `${claimLocation}.remediation`, "must be explicit"));
        }
        if (
          category === "skills" &&
          runtime?.surfaces.find((item) => item.id === surface)?.presence === "required"
        ) {
          if (claim.required !== true || claim.capability !== "repairable") {
            errors.push(
              sourceError(
                sourcePath,
                claimLocation,
                "required surfaces need repairable required skill detection",
              ),
            );
          }
        } else if (claim.required === true) {
          errors.push(
            sourceError(
              sourcePath,
              `${claimLocation}.required`,
              "only required skill surfaces may be mandatory",
            ),
          );
        }
      }
    }
    const nativeActions = Array.isArray(adapter.native_actions) ? adapter.native_actions : [];
    const nativeActionIds = new Set<string>();
    for (const [actionIndex, action] of nativeActions.entries()) {
      const actionLocation = `${location}.native_actions[${actionIndex}]`;
      if (!isMapping(action)) {
        errors.push(sourceError(sourcePath, actionLocation, "must be an object"));
        continue;
      }
      if (!expectedSurfaces.includes(String(action.surface_id))) {
        errors.push(
          sourceError(sourcePath, `${actionLocation}.surface_id`, "must name an adapter surface"),
        );
      }
      const actionId = stringField(action, "id");
      if (!actionId || nativeActionIds.has(actionId)) {
        errors.push(
          sourceError(
            sourcePath,
            `${actionLocation}.id`,
            "must be non-empty and unique within the adapter",
          ),
        );
      }
      nativeActionIds.add(actionId);
      if (!["slash_action", "argv", "instruction"].includes(String(action.action_kind))) {
        errors.push(
          sourceError(
            sourcePath,
            `${actionLocation}.action_kind`,
            "must be slash_action, argv, or instruction",
          ),
        );
      }
      const commandValid =
        typeof action.command === "string"
          ? action.command.length > 0
          : stringList(action.command).length > 0;
      if (!commandValid || typeof action.instruction !== "string" || !action.instruction) {
        errors.push(
          sourceError(sourcePath, actionLocation, "must provide an exact command and instruction"),
        );
      }
    }
    const nativeClaims = isMapping(categories.native_actions) ? categories.native_actions : {};
    for (const surface of expectedSurfaces) {
      const claim = nativeClaims[surface];
      if (!isMapping(claim)) continue;
      const surfaceActions = nativeActions.filter(
        (action) => isMapping(action) && action.surface_id === surface,
      );
      const exactNativeClaim =
        claim.capability === "action_required" &&
        claim.evidence === "verified_host_actions" &&
        claim.remediation === "action_required";
      if (surfaceActions.length > 0 && !exactNativeClaim) {
        errors.push(
          sourceError(
            sourcePath,
            `${location}.categories.native_actions.${surface}`,
            "declared native actions require action_required, verified_host_actions, action_required semantics",
          ),
        );
      }
      if (surfaceActions.length === 0 && exactNativeClaim) {
        errors.push(
          sourceError(
            sourcePath,
            `${location}.categories.native_actions.${surface}`,
            "verified native-action claims require at least one exact action for the same surface",
          ),
        );
      }
    }
  });
  sharedResources.forEach((resource, resourceIndex) => {
    if (!isMapping(resource)) return;
    const resourceId = stringField(resource, "id");
    const references = adapters.filter(
      (adapter) => isMapping(adapter) && stringList(adapter.resource_refs).includes(resourceId),
    );
    if (references.length === 0) {
      errors.push(
        sourceError(
          sourcePath,
          `shared_resources[${resourceIndex}].id`,
          `${resourceId} must be required by at least one active runtime adapter`,
        ),
      );
    }
    if (resource.runtime_id !== undefined || resource.surface_id !== undefined) {
      errors.push(
        sourceError(
          sourcePath,
          `shared_resources[${resourceIndex}]`,
          "shared resources cannot declare a runtime or surface applicability",
        ),
      );
    }
  });
  managedResources.forEach((resource, resourceIndex) => {
    if (!isMapping(resource)) return;
    const resourceId = stringField(resource, "id");
    const runtimeId = stringField(resource, "runtime_id");
    const surfaceId = stringField(resource, "surface_id");
    const category = stringField(resource, "category");
    const references = adapters.flatMap((adapter, adapterIndex) => {
      if (!isMapping(adapter) || !stringList(adapter.resource_refs).includes(resourceId)) return [];
      return [{ adapter, adapterIndex }];
    });
    if (
      references.length !== 1 ||
      stringField(references[0]?.adapter ?? {}, "runtime_id") !== runtimeId
    ) {
      errors.push(
        sourceError(
          sourcePath,
          `managed_resources[${resourceIndex}].id`,
          `${resourceId} must be referenced exactly once by adapter ${runtimeId}`,
        ),
      );
      return;
    }
    const adapter = references[0].adapter;
    const categories = isMapping(adapter.categories) ? adapter.categories : {};
    const claims = isMapping(categories[category]) ? categories[category] : {};
    const claim = claims[surfaceId];
    if (
      !isMapping(claim) ||
      (claim.capability !== "repairable" && claim.evidence !== `managed_resource:${resourceId}`)
    ) {
      errors.push(
        sourceError(
          sourcePath,
          `managed_resources[${resourceIndex}]`,
          `${resourceId} must have a repairable or managed-resource claim at adapters[${references[0].adapterIndex}].categories.${category}.${surfaceId}`,
        ),
      );
    }
  });
  return errors;
}

function parseResource(resource: JsonObject): RuntimeAdapterResourceDeclaration {
  return {
    id: resource.id as string,
    runtimeId: resource.runtime_id as string | undefined,
    surfaceId: resource.surface_id as string | undefined,
    category: resource.category as RuntimeAdapterCategory,
    kind: resource.kind as RuntimeAdapterResourceDeclaration["kind"],
    source: resource.source as string,
    destination: resource.destination as string,
    extension: resource.extension as string | undefined,
    required: resource.required as boolean,
  };
}

export function loadRuntimeLifecycleAdapterContract(
  contractPath = path.join(resolveSourceRoot(), RUNTIME_LIFECYCLE_ADAPTER_CONTRACT_RELATIVE_PATH),
  authority = loadLifecycleAuthority(),
): RuntimeLifecycleAdapterContract {
  const data = loadYamlMapping(fs.readFileSync(contractPath, "utf8"));
  const errors = validateRuntimeLifecycleAdapterContractData(data, authority, contractPath);
  if (errors.length > 0)
    throw new Error(`Runtime lifecycle adapter contract validation failed: ${errors.join("; ")}`);
  const shared = (data.shared_resources as JsonObject[]).map(parseResource);
  const managed = (data.managed_resources as JsonObject[]).map(parseResource);
  const adapters = (data.adapters as JsonObject[]).map(
    (adapter): RuntimeLifecycleAdapterDefinition => {
      const categories = {} as RuntimeLifecycleAdapterDefinition["categories"];
      for (const category of RUNTIME_ADAPTER_CATEGORIES) {
        categories[category] = {};
        const claims = (adapter.categories as JsonObject)[category] as JsonObject;
        for (const [surface, rawClaim] of Object.entries(claims)) {
          const claim = rawClaim as JsonObject;
          categories[category][surface] = {
            capability: claim.capability as RuntimeAdapterCapability,
            evidence: claim.evidence as string,
            remediation: claim.remediation as string,
            required: claim.required === true,
          };
        }
      }
      return {
        runtimeId: adapter.runtime_id as string,
        binaries: adapter.binaries as Record<string, string[]>,
        resourceRefs: adapter.resource_refs as string[],
        skillLocations: (adapter.skill_locations as JsonObject[]).map((location) => ({
          path: location.path as string,
          scope: location.scope as string,
          canonical: location.canonical === true,
          surfaces: Array.isArray(location.surfaces)
            ? (location.surfaces as string[])
            : (authority.runtimes
                .find((runtime) => runtime.id === adapter.runtime_id)
                ?.surfaces.map((surface) => surface.id) ?? []),
        })),
        categories,
        nativeActions: (adapter.native_actions as JsonObject[]).map((action) => ({
          id: action.id as string,
          surfaceId: action.surface_id as string,
          actionKind: action.action_kind as RuntimeAdapterNativeActionDeclaration["actionKind"],
          command: action.command as string | string[],
          instruction: action.instruction as string,
        })),
      };
    },
  );
  return {
    sourcePath: contractPath,
    forbiddenDestinationSegments: stringList(
      (data.path_policy as JsonObject).forbidden_destination_segments,
    ),
    caveats: stringList(data.known_caveats),
    resources: [...shared, ...managed],
    adapters,
  };
}

function resolveSourceTemplate(template: string, root: string): string | null {
  if (!template.startsWith("{source_root}/")) return null;
  return path.resolve(root, template.slice("{source_root}/".length));
}

export function validateRuntimeLifecycleAdapterContractRoot(root = resolveSourceRoot()): string[] {
  const contractPath = path.join(root, RUNTIME_LIFECYCLE_ADAPTER_CONTRACT_RELATIVE_PATH);
  if (!fs.existsSync(contractPath)) {
    return [
      `${RUNTIME_LIFECYCLE_ADAPTER_CONTRACT_RELATIVE_PATH}:1: missing runtime lifecycle adapter contract`,
    ];
  }
  try {
    const authority = loadLifecycleAuthority(path.join(root, LIFECYCLE_AUTHORITY_RELATIVE_PATH));
    const data = loadYamlMapping(fs.readFileSync(contractPath, "utf8"));
    const errors = validateRuntimeLifecycleAdapterContractData(
      data,
      authority,
      RUNTIME_LIFECYCLE_ADAPTER_CONTRACT_RELATIVE_PATH,
    );
    const resources = [
      ...(Array.isArray(data.shared_resources) ? data.shared_resources : []),
      ...(Array.isArray(data.managed_resources) ? data.managed_resources : []),
    ];
    resources.forEach((resource, index) => {
      if (!isMapping(resource)) return;
      const source = resolveSourceTemplate(stringField(resource, "source"), root);
      if (!source || !fs.existsSync(source)) {
        errors.push(
          sourceError(
            RUNTIME_LIFECYCLE_ADAPTER_CONTRACT_RELATIVE_PATH,
            `resources[${index}].source`,
            `declared source is missing: ${source ?? String(resource.source)}`,
          ),
        );
      }
    });
    return errors;
  } catch (error) {
    return [
      `${RUNTIME_LIFECYCLE_ADAPTER_CONTRACT_RELATIVE_PATH}:1: could not validate contract: ${(error as Error).message}`,
    ];
  }
}
