import fs from "node:fs";
import path from "node:path";

import { loadYamlMapping } from "../core/yaml.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import {
  LIFECYCLE_OPERATION_CONTRACT_RELATIVE_PATH,
  LIFECYCLE_MANUAL_REVIEW_GUIDANCE,
  applyLifecycleOperations,
  createLifecycleOwnershipManifest,
  emptyLifecycleOwnershipLedger,
  planLifecycleOperations,
  validateLifecycleOwnershipLedger,
  type AppliedLifecycleOperation,
  type LifecycleApplyOptions,
  type LifecycleApplyResult,
  type LifecycleApplySummary,
  type LifecycleOperationPlan,
  type LifecycleOperationSpec,
  type LifecycleOwnershipLedger,
} from "./lifecycleOperations.js";
import {
  LIFECYCLE_AUTHORITY_RELATIVE_PATH,
  NATIVE_RESOURCE_CLEANUP_CONTRACT_RELATIVE_PATH,
  loadLifecycleAuthority,
} from "./lifecycleAuthority.js";
import { loadRuntimeLifecycleAdapterContract } from "./lifecycleAdapterContract.js";
import { loadLifecycleOperationContract } from "./lifecycleOperationContract.js";

type NativeResourceKind = "file" | "directory" | "symlink";
type HostSupportStatus = "supported" | "supported_disabled" | "retired_historical";

export interface NativeResourceCleanupDefinition {
  id: string;
  historicalIds: string[];
  host: string;
  hostSupportStatus: HostSupportStatus;
  kind: NativeResourceKind;
  destination: string;
  ledgerStatus: "legacy" | "managed";
  durableProof: string;
  neverTouch: string[];
  safetyNote: string;
}

export interface NativeResourceVocabularyDefinition {
  id: string;
  resourceClass: string;
  migrationScope: "explicit_cleanup" | "v2_upgrade_only";
  resourceIds: string[];
  historicalIds: string[];
}

interface NativeResourceCleanupConfigurationDefinition {
  id: string;
  host: string;
  key: string;
}

export interface NativeResourceCleanupConfigurationUnit {
  id: string;
  hostId: string;
  key: string;
  status: "action_required";
  reason: string;
}

export interface NativeResourceCleanupContract {
  sourcePath: string;
  resourceVocabulary: NativeResourceVocabularyDefinition[];
  resources: NativeResourceCleanupDefinition[];
  configuration: NativeResourceCleanupConfigurationDefinition[];
}

const REQUIRED_RESOURCE_VOCABULARY: Record<string, string> = {
  "claude.skill-link": "legacy_skill_link",
  "codex.agent-descriptor": "capability_descriptor",
  "opencode.plugin": "plugin",
  "opencode.command": "command",
  "legacy.primary-agent": "primary_agent",
  "legacy.capability-agent": "capability_agent",
  "opencode.stale-skill-link": "stale_skill_link",
  "installed.hook": "installed_hook",
  "agentera.registration": "registration",
};

const CUTOVER_DELETION_INVENTORY = [
  ["packages/cli/src/migrate/v2HandoffManifest.ts", "tracked_v2_handoff_preflight"],
  ["packages/cli/src/upgrade/appContentRefresh.ts", "v2_managed_app_content_refresh"],
  ["packages/cli/src/upgrade/compatibility.ts", "v2_install_classification"],
  ["packages/cli/src/upgrade/installedHooksRetirement.ts", "installed_v2_hook_retirement"],
  ["packages/cli/src/upgrade/legacyAgentCleanup.ts", "v2_native_agent_retirement"],
  ["packages/cli/src/upgrade/migrateArtifactsV2ToV3.ts", "v2_project_artifact_migration"],
  ["packages/cli/src/upgrade/runtimeMigration.ts", "v2_native_hook_retirement"],
  ["packages/cli/src/upgrade/versionResolution.ts", "cross_major_v2_upgrade_resolution"],
  ["packages/cli/shim/lib/exec.mjs", "v2_shim_handoff"],
  ["packages/cli/test/upgrade/fixtures/v2-*", "v2_migration_fixtures"],
] as const;

export interface NativeResourceCleanupPreview {
  schemaVersion: "agentera.nativeResourceCleanupPreview.v1";
  mode: "preview";
  resourceId: string;
  hostId: string;
  hostSupportStatus: HostSupportStatus;
  ledgerStatus: "legacy" | "managed";
  approvalRequired: true;
  ownershipRequirement: "matching_whole_resource_ledger";
  ledgerAuthorization: "match_or_absent_noop" | "blocked";
  ledgerDiagnostics: string[];
  plan: LifecycleOperationPlan;
  /** Report-only shared configuration; it never adds apply work for a selected resource. */
  configurationUnits: NativeResourceCleanupConfigurationUnit[];
  neverTouch: string[];
  safetyNote: string;
}

export interface NativeResourceCleanupResult extends LifecycleApplyResult {
  resourceId: string;
  hostId: string;
  hostSupportStatus: HostSupportStatus;
  approval: "approved" | "required";
  configurationUnits: NativeResourceCleanupConfigurationUnit[];
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function requiredString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "string" && value[key].length > 0;
}

export function validateNativeResourceCleanupContractData(value: unknown): string[] {
  if (!isMapping(value)) return ["native resource cleanup contract must be a YAML object"];
  const errors: string[] = [];
  if (value.schema_version !== "agentera.nativeResourceCleanup.v1") {
    errors.push("schema_version must be agentera.nativeResourceCleanup.v1");
  }
  if (value.status !== "resource_retirement_contract") {
    errors.push("status must be resource_retirement_contract");
  }
  if (value.decision !== "nksvqmnevm") errors.push("decision must cite firm decision nksvqmnevm");
  if (value.authority !== LIFECYCLE_AUTHORITY_RELATIVE_PATH) {
    errors.push(`authority must point to ${LIFECYCLE_AUTHORITY_RELATIVE_PATH}`);
  }
  if (value.operation_contract !== LIFECYCLE_OPERATION_CONTRACT_RELATIVE_PATH) {
    errors.push(`operation_contract must point to ${LIFECYCLE_OPERATION_CONTRACT_RELATIVE_PATH}`);
  }
  const policy = isMapping(value.policy) ? value.policy : {};
  if (
    policy.host_inventory_exposure !== "evidence_only"
    || policy.selection !== "native_agentera_resource_only"
    || policy.preview !== "strictly_read_only"
    || policy.apply_requires !== "explicit_approval"
    || policy.ownership !== "matching_whole_resource_ledger_identity_and_fingerprint"
    || policy.shared_configuration !== "action_required_without_key_level_ownership"
    || policy.unsupported_platform_result !== "action_required"
  ) {
    errors.push("policy must expose resource-only selection, pure preview, explicit approval, and fail-closed ownership");
  }
  const forbidden = stringList(policy.forbidden_ownership_evidence);
  for (const evidence of ["value_equality", "managed_marker", "resource_name", "file_equality"]) {
    if (!forbidden.includes(evidence)) errors.push(`policy must reject ${evidence} as ownership evidence`);
  }

  const hosts = Array.isArray(value.hosts) ? value.hosts : [];
  const expectedHosts: Record<string, HostSupportStatus> = {
    codex: "supported",
    cursor: "supported",
    opencode: "supported",
    copilot: "supported_disabled",
    claude: "retired_historical",
  };
  const hostStatuses = new Map<string, HostSupportStatus>();
  for (const host of hosts) {
    if (!isMapping(host) || !requiredString(host, "id") || !requiredString(host, "display_name")) continue;
    if (!(host.support_status === "supported" || host.support_status === "supported_disabled" || host.support_status === "retired_historical")) continue;
    hostStatuses.set(host.id as string, host.support_status);
  }
  for (const [id, status] of Object.entries(expectedHosts)) {
    if (hostStatuses.get(id) !== status) errors.push(`hosts must retain ${id} as ${status}`);
  }

  const evidence = Array.isArray(value.accepted_host_evidence) ? value.accepted_host_evidence : [];
  const proofByHost = new Map<string, string>();
  for (const item of evidence) {
    if (isMapping(item) && requiredString(item, "host") && requiredString(item, "proof")) {
      proofByHost.set(item.host as string, item.proof as string);
    }
  }
  for (const host of ["codex", "cursor", "opencode", "copilot"]) {
    if (!proofByHost.has(host)) errors.push(`accepted_host_evidence must retain ${host} proof`);
  }

  const vocabulary = Array.isArray(value.resource_vocabulary) ? value.resource_vocabulary : [];
  const vocabularyById = new Map<string, Record<string, unknown>>();
  for (const entry of vocabulary) {
    if (!isMapping(entry) || !requiredString(entry, "id")) continue;
    vocabularyById.set(entry.id as string, entry);
  }
  if (vocabulary.length !== Object.keys(REQUIRED_RESOURCE_VOCABULARY).length) {
    errors.push("resource_vocabulary must declare every retired native resource class");
  }
  for (const [id, resourceClass] of Object.entries(REQUIRED_RESOURCE_VOCABULARY)) {
    const entry = vocabularyById.get(id);
    if (!entry || entry.resource_class !== resourceClass
      || !(entry.migration_scope === "explicit_cleanup" || entry.migration_scope === "v2_upgrade_only")
      || stringList(entry.resource_ids).length === 0
      || !Array.isArray(entry.historical_ids)
    ) {
      errors.push(`resource_vocabulary must retain ${id} as ${resourceClass}`);
    }
  }

  const resources = Array.isArray(value.resources) ? value.resources : [];
  if (resources.length !== 2) errors.push("resources must declare the Claude link and Codex descriptor class");
  const resourceById = new Map<string, Record<string, unknown>>();
  for (const resource of resources) {
    if (!isMapping(resource) || !requiredString(resource, "id")) continue;
    resourceById.set(resource.id as string, resource);
  }
  const claude = resourceById.get("claude.agentera-skill-link");
  if (!claude || claude.host !== "claude" || claude.kind !== "symlink" || claude.intent !== "remove"
    || claude.destination !== "{home}/.claude/skills/agentera" || claude.ledger_status !== "legacy"
    || claude.vocabulary !== "claude.skill-link" || !requiredString(claude, "durable_proof")) {
    errors.push("Claude cleanup must remain the legacy-ledger Agentera skill symlink removal");
  }
  const codex = resourceById.get("codex.agent-descriptor");
  const descriptors = codex ? stringList(codex.descriptors) : [];
  const expectedDescriptors = ["status", "vision", "discuss", "research", "plan", "build", "optimize", "audit", "document", "profile", "design", "orchestrate"];
  if (!codex || codex.host !== "codex" || codex.kind !== "file" || codex.intent !== "remove"
    || codex.destination !== "{home}/.codex/agents/{descriptor}.toml" || codex.ledger_status !== "managed"
    || codex.vocabulary !== "codex.agent-descriptor" || !requiredString(codex, "durable_proof")
    || stringList(codex.historical_ids).join(",") !== "codex.agents.{descriptor}"
    || descriptors.join(",") !== expectedDescriptors.join(",")) {
    errors.push("Codex descriptors must be independently ledger-owned native files");
  }

  const configuration = Array.isArray(value.configuration_inventory) ? value.configuration_inventory : [];
  const expectedKeys = [
    "shell_environment_policy.set.AGENTERA_HOME",
    "agents.max_depth",
    "features.multi_agent_v2",
  ];
  if (configuration.length !== expectedKeys.length) {
    errors.push("configuration_inventory must declare every Agentera-written Codex key");
  }
  for (const key of expectedKeys) {
    const unit = configuration.find((item) => isMapping(item) && item.key === key);
    if (!isMapping(unit) || !requiredString(unit, "id") || unit.host !== "codex" || unit.destination !== "{home}/.codex/config.toml"
      || unit.durable_proof !== "key-level ownership ledger identity and fingerprint"
      || unit.ownership_available !== false || unit.result_without_proof !== "action_required") {
      errors.push(`configuration_inventory must preserve ${key} without key-level ownership`);
    }
  }
  const deletionInventory = isMapping(value.cutover_deletion_inventory)
    ? value.cutover_deletion_inventory
    : null;
  if (
    deletionInventory?.schema_version !== "agentera.v2CutoverDeletionInventory.v1"
    || deletionInventory.approval_gate !== "approved_stable_cutover"
    || deletionInventory.policy !== "delete_only_after_approved_stable_cutover"
  ) {
    errors.push("cutover_deletion_inventory must be approval-gated v2 deletion inventory");
  }
  const deletionEntries = Array.isArray(deletionInventory?.entries)
    ? deletionInventory.entries
    : [];
  const actualDeletionEntries = deletionEntries.flatMap((entry) =>
    isMapping(entry) && typeof entry.path === "string" && typeof entry.responsibility === "string"
      ? [[entry.path, entry.responsibility] as const]
      : [],
  );
  if (JSON.stringify(actualDeletionEntries) !== JSON.stringify(CUTOVER_DELETION_INVENTORY)) {
    errors.push("cutover_deletion_inventory must identify every quarantined v2 source, shim, and fixture path");
  }
  return errors;
}

function expandResource(
  resource: Record<string, unknown>,
  hostSupportStatus: HostSupportStatus,
): NativeResourceCleanupDefinition[] {
  const descriptorNames = stringList(resource.descriptors);
  const ids = descriptorNames.length > 0
    ? descriptorNames.map((name) => `${resource.id as string}.${name}`)
    : [resource.id as string];
  return ids.map((id, index) => ({
    id,
    historicalIds: stringList(resource.historical_ids).map((historicalId) => descriptorNames.length > 0
      ? historicalId.replace("{descriptor}", descriptorNames[index]!)
      : historicalId),
    host: resource.host as string,
    hostSupportStatus,
    kind: resource.kind as NativeResourceKind,
    destination: descriptorNames.length > 0
      ? (resource.destination as string).replace("{descriptor}", descriptorNames[index]!)
      : resource.destination as string,
    ledgerStatus: resource.ledger_status as "legacy" | "managed",
    durableProof: resource.durable_proof as string,
    neverTouch: stringList(resource.never_touch),
    safetyNote: (resource.safety_note as string | undefined) ?? "",
  }));
}

export function loadNativeResourceCleanupContract(
  contractPath = path.join(resolveSourceRoot(), NATIVE_RESOURCE_CLEANUP_CONTRACT_RELATIVE_PATH),
): NativeResourceCleanupContract {
  const data = loadYamlMapping(fs.readFileSync(contractPath, "utf8"));
  const errors = validateNativeResourceCleanupContractData(data);
  if (errors.length > 0) throw new Error(`Native resource cleanup contract validation failed: ${errors.join("; ")}`);
  // The cleanup contract declares the authority and operation-contract paths.
  // Load their adapter chain before using cleanup definitions so migration data
  // cannot look valid while its declared compatibility contracts have drifted.
  const authority = loadLifecycleAuthority();
  loadRuntimeLifecycleAdapterContract(undefined, authority);
  loadLifecycleOperationContract();
  const statuses = new Map((data.hosts as Record<string, unknown>[]).map((host) => [
    host.id as string,
    host.support_status as HostSupportStatus,
  ]));
  return {
    sourcePath: contractPath,
    resourceVocabulary: (data.resource_vocabulary as Record<string, unknown>[]).map((entry) => ({
      id: entry.id as string,
      resourceClass: entry.resource_class as string,
      migrationScope: entry.migration_scope as "explicit_cleanup" | "v2_upgrade_only",
      resourceIds: stringList(entry.resource_ids),
      historicalIds: stringList(entry.historical_ids),
    })),
    resources: (data.resources as Record<string, unknown>[]).flatMap((resource) =>
      expandResource(resource, statuses.get(resource.host as string)!),
    ),
    configuration: (data.configuration_inventory as Record<string, unknown>[]).map((unit) => ({
      id: unit.id as string,
      host: unit.host as string,
      key: unit.key as string,
    })),
  };
}

export function nativeResourceCleanupIds(contract = loadNativeResourceCleanupContract()): string[] {
  return contract.resources.map((resource) => resource.id);
}

export function nativeResourceCleanupHistoricalIds(contract = loadNativeResourceCleanupContract()): string[] {
  return contract.resources.flatMap((resource) => resource.historicalIds);
}

export function resolveNativeResourceCleanupId(
  resourceId: string,
  contract = loadNativeResourceCleanupContract(),
): NativeResourceCleanupDefinition | null {
  const matches = contract.resources.filter((resource) =>
    resource.id === resourceId || resource.historicalIds.includes(resourceId),
  );
  return matches.length === 1 ? matches[0]! : null;
}

export function validateNativeResourceCleanupContractRoot(root = resolveSourceRoot()): string[] {
  const contractPath = path.join(root, NATIVE_RESOURCE_CLEANUP_CONTRACT_RELATIVE_PATH);
  if (!fs.existsSync(contractPath)) {
    return [`${NATIVE_RESOURCE_CLEANUP_CONTRACT_RELATIVE_PATH}: missing native resource cleanup contract`];
  }
  try {
    return validateNativeResourceCleanupContractData(
      loadYamlMapping(fs.readFileSync(contractPath, "utf8")),
    ).map((error) => `${NATIVE_RESOURCE_CLEANUP_CONTRACT_RELATIVE_PATH}: ${error}`);
  } catch (error) {
    return [`${NATIVE_RESOURCE_CLEANUP_CONTRACT_RELATIVE_PATH}: could not parse contract: ${(error as Error).message}`];
  }
}

function expandHome(template: string, home: string): string {
  if (!template.startsWith("{home}/") || template.includes("..")) {
    throw new Error(`unsafe native resource destination template: ${template}`);
  }
  return path.join(path.resolve(home), template.slice("{home}/".length));
}

function ledgerDiagnostics(plan: LifecycleOperationPlan, resource: NativeResourceCleanupDefinition): string[] {
  const ledger = plan.request.ledger ?? emptyLifecycleOwnershipLedger();
  const planned = plan.operations[0];
  if (planned?.action === "noop") return [];
  const records = ledger.records.filter((record) => record.resourceId === resource.id);
  if (records.length !== 1) return [`${resource.id}: cleanup requires exactly one ownership ledger record`];
  const record = records[0]!;
  if (
    record.status !== resource.ledgerStatus
    || record.scope !== "whole"
    || path.resolve(record.destination) !== path.resolve(plan.request.operations[0]!.destination)
    || record.kind !== resource.kind
    || record.identity === null
    || record.fingerprint === null
  ) {
    return [`${resource.id}: cleanup requires matching whole-resource ${resource.ledgerStatus} ledger identity and fingerprint`];
  }
  return [];
}

function blockedPlan(
  plan: LifecycleOperationPlan,
  diagnostics: string[],
  invalidLedger = false,
): LifecycleOperationPlan {
  const reason = `${diagnostics.join("; ")} ${LIFECYCLE_MANUAL_REVIEW_GUIDANCE}`;
  return {
    ...plan,
    operations: plan.operations.map((operation) => operation.action === "noop" ? operation : {
      ...operation,
      ...(invalidLedger ? { state: "ambiguous_ownership" as const, ownership: "ambiguous" as const } : {}),
      action: "action_required",
      reason,
    }),
  };
}

function configurationUnitsFor(
  contract: NativeResourceCleanupContract,
  host: string,
): NativeResourceCleanupConfigurationUnit[] {
  return contract.configuration
    .filter((unit) => unit.host === host)
    .map((unit) => ({
      id: unit.id,
      hostId: unit.host,
      key: unit.key,
      status: "action_required",
      reason: "no durable key-level ownership ledger identity and fingerprint",
  }));
}

function canonicalizeHistoricalOwnershipIds(
  ledger: LifecycleOwnershipLedger,
  resource: NativeResourceCleanupDefinition,
): LifecycleOwnershipLedger {
  if (resource.historicalIds.length === 0) return ledger;
  return {
    ...ledger,
    records: ledger.records.map((record) => resource.historicalIds.includes(record.resourceId)
      ? { ...record, resourceId: resource.id }
      : record),
  };
}

export function previewNativeResourceCleanup(opts: {
  resourceId: string;
  home: string;
  ledger?: LifecycleOwnershipLedger;
  contract?: NativeResourceCleanupContract;
}): NativeResourceCleanupPreview {
  const contract = opts.contract ?? loadNativeResourceCleanupContract();
  const resource = resolveNativeResourceCleanupId(opts.resourceId, contract);
  if (!resource) throw new Error(`unknown native Agentera resource cleanup id: ${opts.resourceId}`);
  const operations: LifecycleOperationSpec[] = [{
    id: resource.id,
    destination: expandHome(resource.destination, opts.home),
    kind: resource.kind,
    intent: "remove",
    required: true,
  }];
  const suppliedLedger = opts.ledger ?? emptyLifecycleOwnershipLedger();
  const errors = validateLifecycleOwnershipLedger(suppliedLedger);
  const ledger = errors.length === 0
    ? canonicalizeHistoricalOwnershipIds(suppliedLedger, resource)
    : emptyLifecycleOwnershipLedger();
  const plan = planLifecycleOperations({
    allowedRoots: [path.resolve(opts.home)],
    operations,
    manifest: createLifecycleOwnershipManifest(operations),
    ledger,
  });
  const diagnostics = errors.length > 0
    ? errors.map((error) => `invalid ownership ledger: ${error}`)
    : ledgerDiagnostics(plan, resource);
  return {
    schemaVersion: "agentera.nativeResourceCleanupPreview.v1",
    mode: "preview",
    resourceId: resource.id,
    hostId: resource.host,
    hostSupportStatus: resource.hostSupportStatus,
    ledgerStatus: resource.ledgerStatus,
    approvalRequired: true,
    ownershipRequirement: "matching_whole_resource_ledger",
    ledgerAuthorization: diagnostics.length === 0 ? "match_or_absent_noop" : "blocked",
    ledgerDiagnostics: diagnostics,
    plan: diagnostics.length === 0 ? plan : blockedPlan(plan, diagnostics, errors.length > 0),
    configurationUnits: configurationUnitsFor(contract, resource.host),
    neverTouch: resource.neverTouch.map((entry) => expandHome(entry, opts.home)),
    safetyNote: resource.safetyNote,
  };
}

function approvalRequiredResult(preview: NativeResourceCleanupPreview): LifecycleApplyResult {
  const operations: AppliedLifecycleOperation[] = preview.plan.operations.map((operation) => ({
    ...operation,
    action: operation.action === "noop" || operation.action === "blocked_unowned" ? operation.action : "action_required",
    status: operation.action === "noop" ? "noop" : operation.action === "blocked_unowned" ? "blocked_unowned" : "action_required",
    dependencyCauses: [],
    reason: operation.action === "noop" || operation.action === "blocked_unowned"
      ? operation.reason
      : "explicit cleanup approval is required",
  }));
  const summary: LifecycleApplySummary = {
    applied: 0,
    noop: operations.filter((item) => item.status === "noop").length,
    failed: 0,
    blocked_unowned: operations.filter((item) => item.status === "blocked_unowned").length,
    skipped_dependency: 0,
    action_required: operations.filter((item) => item.status === "action_required").length,
  };
  return {
    schemaVersion: "agentera.lifecycleApplyResult.v1",
    status: operations.every((item) => item.status === "noop") ? "success" : "non_success",
    operations,
    summary,
    requiredUnmet: operations.filter((item) => item.required && item.status !== "noop").map((item) => item.id),
    ownershipLedger: preview.plan.request.ledger ?? emptyLifecycleOwnershipLedger(),
  };
}

export function applyNativeResourceCleanup(
  preview: NativeResourceCleanupPreview,
  options: LifecycleApplyOptions & { approved: boolean },
): NativeResourceCleanupResult {
  const resource = preview.plan.request.operations[0]!;
  const definition: NativeResourceCleanupDefinition = {
    id: preview.resourceId,
    historicalIds: [],
    host: preview.hostId,
    hostSupportStatus: preview.hostSupportStatus,
    kind: resource.kind,
    destination: resource.destination,
    ledgerStatus: preview.ledgerStatus,
    durableProof: "",
    neverTouch: [],
    safetyNote: "",
  };
  const diagnostics = ledgerDiagnostics(preview.plan, definition);
  const authorized = preview.ledgerAuthorization === "match_or_absent_noop" && diagnostics.length === 0;
  const result = options.approved && authorized
    ? applyLifecycleOperations(preview.plan, options)
    : approvalRequiredResult(preview);
  return {
    ...result,
    resourceId: preview.resourceId,
    hostId: preview.hostId,
    hostSupportStatus: preview.hostSupportStatus,
    approval: options.approved ? "approved" : "required",
    configurationUnits: preview.configurationUnits,
  };
}
