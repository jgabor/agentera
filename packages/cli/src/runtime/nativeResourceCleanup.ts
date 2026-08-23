import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { loadYamlMapping } from "../core/yaml.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import {
  LIFECYCLE_LEDGER_SCHEMA,
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
  LIFECYCLE_OWNERSHIP_JOURNAL_SCHEMA,
  readLifecycleOwnershipJournal,
} from "./lifecycleOwnershipJournal.js";
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

export interface NativeResourceCleanupConfigurationDefinition {
  id: string;
  host: string;
  destination: string;
  key: string;
}

export interface NativeResourceCleanupConfigurationUnit {
  id: string;
  hostId: string;
  key: string;
  status: "action_required";
  reason: string;
}

export interface RetiredResourceDiagnosticDefinition {
  id: string;
  vocabulary: string;
  names: string[];
  destinations: string[];
  contains: string | null;
}

export interface NativeResourceCleanupContract {
  sourcePath: string;
  resourceVocabulary: NativeResourceVocabularyDefinition[];
  diagnosticMaximumResources: number;
  diagnosticMaximumFileBytes: number;
  diagnosticResources: RetiredResourceDiagnosticDefinition[];
  resources: NativeResourceCleanupDefinition[];
  configuration: NativeResourceCleanupConfigurationDefinition[];
  automaticRetirement: AutomaticRetirementDefinition[];
}

export interface AutomaticRetirementDefinition {
  id: string;
  resourceId: string;
  ownershipResourceId: string;
  kind: "file";
  sizeBytes: number;
  sha256: string;
}

export interface AutomaticRetirementClassification {
  qualification: "qualified" | "manual_review";
  variantId: string | null;
  reason: "proven_variant_and_ownership" | "resource_not_enabled" | "not_regular_file" | "unreadable" | "unproven_content" | "ownership_evidence_missing" | "ownership_evidence_mismatch";
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

function expandedDiagnosticIds(resource: Record<string, unknown>): string[] {
  if (typeof resource.id !== "string") return [];
  const names = stringList(resource.names);
  if (!resource.id.includes("{name}")) return [resource.id];
  return names.map((name) => (resource.id as string).replace("{name}", name));
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

  const automatic = isMapping(value.automatic_retirement) ? value.automatic_retirement : {};
  const enabledResourceIds = stringList(automatic.enabled_resource_ids);
  const ownershipEvidence = isMapping(automatic.ownership_evidence) ? automatic.ownership_evidence : {};
  const variants = Array.isArray(automatic.variants) ? automatic.variants : [];
  if (enabledResourceIds.length !== 1 || enabledResourceIds[0] !== "opencode.plugin.agentera"
    || automatic.qualification !== "bounded_sha256_and_matching_installer_ledger"
    || automatic.result_without_match !== "manual_review") {
    errors.push("automatic_retirement must enable only opencode.plugin.agentera and fail closed");
  }
  if (ownershipEvidence.journal_schema !== LIFECYCLE_OWNERSHIP_JOURNAL_SCHEMA
    || ownershipEvidence.ledger_schema !== LIFECYCLE_LEDGER_SCHEMA
    || ownershipEvidence.ledger_resource_id !== "opencode.plugin"
    || ownershipEvidence.status !== "managed"
    || ownershipEvidence.scope !== "whole"
    || ownershipEvidence.match !== "exact_destination_kind_identity_and_fingerprint") {
    errors.push("automatic_retirement must require the matching historical installer ownership journal");
  }
  if (variants.length === 0 || variants.some((variant) => !isMapping(variant)
    || !requiredString(variant, "id")
    || variant.resource_id !== "opencode.plugin.agentera"
    || variant.kind !== "file"
    || !Number.isInteger(variant.size_bytes)
    || typeof variant.sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(variant.sha256)
    || !isMapping(variant.provenance)
    || !requiredString(variant.provenance, "source_commit")
    || !requiredString(variant.provenance, "source_path")
    || !requiredString(variant.provenance, "transformation")
    || !requiredString(variant.provenance, "verification"))) {
    errors.push("automatic_retirement variants must have bounded positive provenance");
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
  const registrationEvidence = stringList(vocabularyById.get("agentera.registration")?.identity_evidence);
  if (registrationEvidence.length === 0) {
    errors.push("agentera.registration must retain identity evidence for excluded template labels");
  }
  const declaredDiagnosticIds = new Map<string, string>();
  for (const [vocabularyId, entry] of vocabularyById) {
    for (const resourceId of stringList(entry.resource_ids)) {
      if (resourceId.includes("{")) {
        errors.push(`resource_vocabulary ${vocabularyId} must declare exact resource IDs`);
        continue;
      }
      if (declaredDiagnosticIds.has(resourceId)) {
        errors.push(`resource_vocabulary must not duplicate ${resourceId}`);
        continue;
      }
      declaredDiagnosticIds.set(resourceId, vocabularyId);
    }
  }

  const diagnosticInventory = isMapping(value.diagnostic_inventory) ? value.diagnostic_inventory : null;
  const maximumResources = diagnosticInventory?.maximum_resources;
  const maximumFileBytes = diagnosticInventory?.maximum_file_bytes;
  if (!Number.isInteger(maximumResources) || (maximumResources as number) < 1 || (maximumResources as number) > 256
    || !Number.isInteger(maximumFileBytes) || (maximumFileBytes as number) < 1 || (maximumFileBytes as number) > 1024 * 1024) {
    errors.push("diagnostic_inventory must declare bounded maximum_resources and maximum_file_bytes");
  }
  const diagnosticResources = Array.isArray(diagnosticInventory?.resources) ? diagnosticInventory.resources : [];
  const diagnosticIds = new Map<string, string>();
  for (const resource of diagnosticResources) {
    if (!isMapping(resource)
      || !requiredString(resource, "id")
      || !requiredString(resource, "vocabulary")
      || !Array.isArray(resource.destinations)
      || !stringList(resource.destinations).length
      || (resource.names !== undefined && !Array.isArray(resource.names))
      || (resource.contains !== undefined && !requiredString(resource, "contains"))) {
      errors.push("diagnostic_inventory resources must declare bounded resource IDs and paths");
      continue;
    }
    const vocabularyId = resource.vocabulary as string;
    if (!vocabularyById.has(vocabularyId)) {
      errors.push(`diagnostic_inventory references unknown vocabulary ${vocabularyId}`);
    }
    const template = resource.id as string;
    const ids = expandedDiagnosticIds(resource);
    if (template.includes("{") && (template.match(/\{name\}/g)?.length !== 1 || ids.length === 0)) {
      errors.push(`diagnostic_inventory must expand ${template} with one or more names`);
    }
    for (const id of ids) {
      const declaredVocabulary = declaredDiagnosticIds.get(id);
      if (declaredVocabulary !== vocabularyId) {
        errors.push(`diagnostic_inventory ${id} must map to its exact declared vocabulary identity`);
      }
      if (diagnosticIds.has(id)) {
        errors.push(`diagnostic_inventory must not duplicate ${id}`);
      } else {
        diagnosticIds.set(id, vocabularyId);
      }
    }
  }
  for (const id of declaredDiagnosticIds.keys()) {
    if (!diagnosticIds.has(id)) errors.push(`diagnostic_inventory must define ${id}`);
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
    diagnosticMaximumResources: (data.diagnostic_inventory as Record<string, unknown>).maximum_resources as number,
    diagnosticMaximumFileBytes: (data.diagnostic_inventory as Record<string, unknown>).maximum_file_bytes as number,
    diagnosticResources: ((data.diagnostic_inventory as Record<string, unknown>).resources as Record<string, unknown>[]).map((entry) => ({
      id: entry.id as string,
      vocabulary: entry.vocabulary as string,
      names: stringList(entry.names),
      destinations: stringList(entry.destinations),
      contains: typeof entry.contains === "string" ? entry.contains : null,
    })),
    resources: (data.resources as Record<string, unknown>[]).flatMap((resource) =>
      expandResource(resource, statuses.get(resource.host as string)!),
    ),
    configuration: (data.configuration_inventory as Record<string, unknown>[]).map((unit) => ({
      id: unit.id as string,
      host: unit.host as string,
      destination: unit.destination as string,
      key: unit.key as string,
    })),
    automaticRetirement: ((data.automatic_retirement as Record<string, unknown>).variants as Record<string, unknown>[]).map((variant) => ({
      id: variant.id as string,
      resourceId: variant.resource_id as string,
      ownershipResourceId: ((data.automatic_retirement as Record<string, unknown>).ownership_evidence as Record<string, unknown>).ledger_resource_id as string,
      kind: "file",
      sizeBytes: variant.size_bytes as number,
      sha256: variant.sha256 as string,
    })),
  };
}

export function classifyAutomaticRetirement(
  resourceId: string,
  destination: string,
  ownershipJournalPath: string | null = null,
  contract = loadNativeResourceCleanupContract(),
): AutomaticRetirementClassification {
  const variants = contract.automaticRetirement.filter((variant) => variant.resourceId === resourceId);
  if (variants.length === 0) return { qualification: "manual_review", variantId: null, reason: "resource_not_enabled" };
  let stat: fs.BigIntStats;
  try {
    stat = fs.lstatSync(destination, { bigint: true });
  } catch {
    return { qualification: "manual_review", variantId: null, reason: "unreadable" };
  }
  if (!stat.isFile()) return { qualification: "manual_review", variantId: null, reason: "not_regular_file" };
  let content: Buffer;
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(destination, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      return { qualification: "manual_review", variantId: null, reason: "unreadable" };
    }
    content = fs.readFileSync(descriptor);
  } catch {
    return { qualification: "manual_review", variantId: null, reason: "unreadable" };
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
  const digest = createHash("sha256").update(content).digest("hex");
  const variant = variants.find((item) => item.sizeBytes === content.length && item.sha256 === digest);
  if (!variant) return { qualification: "manual_review", variantId: null, reason: "unproven_content" };
  if (!ownershipJournalPath) {
    return { qualification: "manual_review", variantId: variant.id, reason: "ownership_evidence_missing" };
  }
  let journal;
  try {
    journal = readLifecycleOwnershipJournal(ownershipJournalPath);
  } catch {
    return { qualification: "manual_review", variantId: variant.id, reason: "ownership_evidence_mismatch" };
  }
  if (journal.state === "absent") {
    return { qualification: "manual_review", variantId: variant.id, reason: "ownership_evidence_missing" };
  }
  const destinationPath = path.resolve(destination);
  const record = journal.state === "clean" && journal.ledger.records.find((item) =>
    item.resourceId === variant.ownershipResourceId
    && item.destination === destinationPath
    && item.kind === "file"
    && item.scope === "whole"
    && item.status === "managed"
    && item.fingerprint === `sha256:${digest}`
    && item.identity?.device === stat.dev.toString()
    && item.identity.inode === stat.ino.toString(),
  );
  return record
    ? { qualification: "qualified", variantId: variant.id, reason: "proven_variant_and_ownership" }
    : { qualification: "manual_review", variantId: variant.id, reason: "ownership_evidence_mismatch" };
}

export function nativeResourceCleanupIds(contract = loadNativeResourceCleanupContract()): string[] {
  return contract.resources.map((resource) => resource.id);
}

export function retiredResourceDiagnosticIds(contract = loadNativeResourceCleanupContract()): string[] {
  return contract.diagnosticResources.flatMap((resource) =>
    resource.id.includes("{name}")
      ? resource.names.map((name) => resource.id.replace("{name}", name))
      : [resource.id],
  ).sort();
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
