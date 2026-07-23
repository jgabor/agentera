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
} from "./lifecycleAuthority.js";

type NativeResourceKind = "file" | "directory" | "symlink";
type HostSupportStatus = "supported" | "supported_disabled" | "retired_historical";

export interface NativeResourceCleanupDefinition {
  id: string;
  host: string;
  hostSupportStatus: HostSupportStatus;
  kind: NativeResourceKind;
  destination: string;
  ledgerStatus: "legacy" | "managed";
  durableProof: string;
  neverTouch: string[];
  safetyNote: string;
}

export interface NativeResourceCleanupContract {
  sourcePath: string;
  resources: NativeResourceCleanupDefinition[];
}

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
  neverTouch: string[];
  safetyNote: string;
}

export interface NativeResourceCleanupResult extends LifecycleApplyResult {
  resourceId: string;
  hostId: string;
  hostSupportStatus: HostSupportStatus;
  approval: "approved" | "required";
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
    || !requiredString(claude, "durable_proof")) {
    errors.push("Claude cleanup must remain the legacy-ledger Agentera skill symlink removal");
  }
  const codex = resourceById.get("codex.agent-descriptor");
  const descriptors = codex ? stringList(codex.descriptors) : [];
  const expectedDescriptors = ["status", "vision", "discuss", "research", "plan", "build", "optimize", "audit", "document", "profile", "design", "orchestrate"];
  if (!codex || codex.host !== "codex" || codex.kind !== "file" || codex.intent !== "remove"
    || codex.destination !== "{home}/.codex/agents/{descriptor}.toml" || codex.ledger_status !== "managed"
    || !requiredString(codex, "durable_proof") || descriptors.join(",") !== expectedDescriptors.join(",")) {
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
    if (!isMapping(unit) || unit.host !== "codex" || unit.destination !== "{home}/.codex/config.toml"
      || unit.durable_proof !== "key-level ownership ledger identity and fingerprint"
      || unit.ownership_available !== false || unit.result_without_proof !== "action_required") {
      errors.push(`configuration_inventory must preserve ${key} without key-level ownership`);
    }
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
  const statuses = new Map((data.hosts as Record<string, unknown>[]).map((host) => [
    host.id as string,
    host.support_status as HostSupportStatus,
  ]));
  return {
    sourcePath: contractPath,
    resources: (data.resources as Record<string, unknown>[]).flatMap((resource) =>
      expandResource(resource, statuses.get(resource.host as string)!),
    ),
  };
}

export function nativeResourceCleanupIds(contract = loadNativeResourceCleanupContract()): string[] {
  return contract.resources.map((resource) => resource.id);
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
  if (planned?.action === "noop" && ledger.records.length === 0) return [];
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

function blockedPlan(plan: LifecycleOperationPlan, diagnostics: string[]): LifecycleOperationPlan {
  const reason = `${diagnostics.join("; ")} ${LIFECYCLE_MANUAL_REVIEW_GUIDANCE}`;
  return {
    ...plan,
    operations: plan.operations.map((operation) => operation.action === "noop" ? operation : {
      ...operation,
      state: "ambiguous_ownership",
      ownership: "ambiguous",
      action: "blocked_unowned",
      reason,
    }),
  };
}

export function previewNativeResourceCleanup(opts: {
  resourceId: string;
  home: string;
  ledger?: LifecycleOwnershipLedger;
  contract?: NativeResourceCleanupContract;
}): NativeResourceCleanupPreview {
  const contract = opts.contract ?? loadNativeResourceCleanupContract();
  const resource = contract.resources.find((candidate) => candidate.id === opts.resourceId);
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
  const plan = planLifecycleOperations({
    allowedRoots: [path.resolve(opts.home)],
    operations,
    manifest: createLifecycleOwnershipManifest(operations),
    ledger: errors.length === 0 ? suppliedLedger : emptyLifecycleOwnershipLedger(),
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
    plan: diagnostics.length === 0 ? plan : blockedPlan(plan, diagnostics),
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
  };
}
