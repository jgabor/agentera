import fs from "node:fs";
import path from "node:path";

import { loadYamlMapping } from "../core/yaml.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import {
  LIFECYCLE_OPERATION_CONTRACT_RELATIVE_PATH,
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
  RETIRED_RUNTIME_CLEANUP_CONTRACT_RELATIVE_PATH,
} from "./lifecycleAuthority.js";

export interface RetiredRuntimeResourceDefinition {
  id: string;
  kind: "file" | "directory" | "symlink";
  destination: string;
  ledgerStatus: "legacy";
}

export interface RetiredRuntimeDefinition {
  id: string;
  displayName: string;
  sourceProduct: string;
  resources: RetiredRuntimeResourceDefinition[];
  neverTouch: string[];
  safetyNote: string;
}

export interface RetiredRuntimeCleanupContract {
  sourcePath: string;
  runtimes: RetiredRuntimeDefinition[];
}

export interface RetiredRuntimeCleanupPreview {
  schemaVersion: "agentera.retiredRuntimeCleanupPreview.v1";
  mode: "preview";
  runtimeId: string;
  activeRuntime: false;
  sourceProduct: string;
  approvalRequired: true;
  ownershipRequirement: "matching_whole_resource_legacy_ledger";
  ledgerAuthorization: "legacy_match_or_absent_noop" | "blocked";
  ledgerDiagnostics: string[];
  plan: LifecycleOperationPlan;
  neverTouch: string[];
  safetyNote: string;
}

export interface RetiredRuntimeCleanupResult extends LifecycleApplyResult {
  runtimeId: string;
  activeRuntime: false;
  sourceProduct: string;
  approval: "approved" | "required";
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

export function validateRetiredRuntimeCleanupContractData(value: unknown): string[] {
  if (!isMapping(value)) return ["retired runtime cleanup contract must be a YAML object"];
  const errors: string[] = [];
  if (value.schema_version !== "agentera.retiredRuntimeResources.v1") {
    errors.push("schema_version must be agentera.retiredRuntimeResources.v1");
  }
  if (value.status !== "retired_migration_contract") errors.push("status must be retired_migration_contract");
  if (value.decision !== 92) errors.push("decision must cite approved Decision 92");
  if (value.authority !== LIFECYCLE_AUTHORITY_RELATIVE_PATH) {
    errors.push(`authority must point to ${LIFECYCLE_AUTHORITY_RELATIVE_PATH}`);
  }
  if (value.operation_contract !== LIFECYCLE_OPERATION_CONTRACT_RELATIVE_PATH) {
    errors.push(`operation_contract must point to ${LIFECYCLE_OPERATION_CONTRACT_RELATIVE_PATH}`);
  }
  const policy = isMapping(value.policy) ? value.policy : {};
  if (
    policy.active_inventory_exposure !== "forbidden"
    || policy.preview !== "strictly_read_only"
    || policy.apply_requires !== "explicit_approval"
    || policy.ownership !== "matching_whole_resource_legacy_ledger_identity_and_fingerprint"
    || policy.unsupported_platform_result !== "action_required"
  ) {
    errors.push("policy must fail closed with pure preview, explicit approval, and legacy ledger ownership");
  }
  const runtimes = value.retired_runtimes;
  if (!Array.isArray(runtimes) || runtimes.length !== 1 || !isMapping(runtimes[0])) {
    return [...errors, "retired_runtimes must contain exactly one Claude migration record"];
  }
  const claude = runtimes[0];
  if (
    claude.id !== "claude"
    || claude.active_runtime !== false
    || claude.source_product !== "claude-code"
  ) {
    errors.push("retired Claude record must be inactive with source_product claude-code");
  }
  const resources = claude.resources;
  if (!Array.isArray(resources) || resources.length !== 1 || !isMapping(resources[0])) {
    errors.push("Claude cleanup must declare exactly one legacy Agentera resource");
  } else if (
    resources[0].id !== "claude.agentera-skill-link"
    || resources[0].kind !== "symlink"
    || resources[0].intent !== "remove"
    || resources[0].destination !== "{home}/.claude/skills/agentera"
    || resources[0].ledger_status !== "legacy"
  ) {
    errors.push("Claude cleanup resource must be the legacy-ledger Agentera skill symlink removal");
  }
  const neverTouch = stringList(claude.never_touch);
  for (const required of ["projects", "settings", "credentials", "conversations", "cache", "stats"]) {
    if (!neverTouch.some((entry) => entry.toLowerCase().includes(required))) {
      errors.push(`Claude never_touch must cover ${required}`);
    }
  }
  return errors;
}

export function loadRetiredRuntimeCleanupContract(
  contractPath = path.join(resolveSourceRoot(), RETIRED_RUNTIME_CLEANUP_CONTRACT_RELATIVE_PATH),
): RetiredRuntimeCleanupContract {
  const data = loadYamlMapping(fs.readFileSync(contractPath, "utf8"));
  const errors = validateRetiredRuntimeCleanupContractData(data);
  if (errors.length > 0) throw new Error(`Retired runtime cleanup contract validation failed: ${errors.join("; ")}`);
  const runtimes = (data.retired_runtimes as Record<string, unknown>[]).map((runtime) => ({
    id: runtime.id as string,
    displayName: runtime.display_name as string,
    sourceProduct: runtime.source_product as string,
    resources: (runtime.resources as Record<string, unknown>[]).map((resource) => ({
      id: resource.id as string,
      kind: resource.kind as "file" | "directory" | "symlink",
      destination: resource.destination as string,
      ledgerStatus: resource.ledger_status as "legacy",
    })),
    neverTouch: runtime.never_touch as string[],
    safetyNote: runtime.safety_note as string,
  }));
  return { sourcePath: contractPath, runtimes };
}

export function validateRetiredRuntimeCleanupContractRoot(root = resolveSourceRoot()): string[] {
  const contractPath = path.join(root, RETIRED_RUNTIME_CLEANUP_CONTRACT_RELATIVE_PATH);
  if (!fs.existsSync(contractPath)) {
    return [`${RETIRED_RUNTIME_CLEANUP_CONTRACT_RELATIVE_PATH}: missing retired runtime cleanup contract`];
  }
  try {
    return validateRetiredRuntimeCleanupContractData(
      loadYamlMapping(fs.readFileSync(contractPath, "utf8")),
    ).map((error) => `${RETIRED_RUNTIME_CLEANUP_CONTRACT_RELATIVE_PATH}: ${error}`);
  } catch (error) {
    return [`${RETIRED_RUNTIME_CLEANUP_CONTRACT_RELATIVE_PATH}: could not parse contract: ${(error as Error).message}`];
  }
}

function expandHome(template: string, home: string): string {
  if (!template.startsWith("{home}/") || template.includes("..")) {
    throw new Error(`unsafe retired runtime destination template: ${template}`);
  }
  return path.join(path.resolve(home), template.slice("{home}/".length));
}

function legacyLedgerDiagnostics(plan: LifecycleOperationPlan): string[] {
  const ledger = plan.request.ledger ?? emptyLifecycleOwnershipLedger();
  const diagnostics: string[] = [];
  for (const operation of plan.request.operations) {
    const planned = plan.operations.find((candidate) => candidate.id === operation.id);
    const records = ledger.records.filter((record) => record.resourceId === operation.id);
    if (records.length === 0 && planned?.action === "noop") continue;
    if (records.length !== 1) {
      diagnostics.push(`${operation.id}: retired cleanup requires exactly one ownership ledger record`);
      continue;
    }
    const record = records[0];
    if (
      record.status !== "legacy"
      || record.scope !== "whole"
      || path.resolve(record.destination) !== path.resolve(operation.destination)
      || record.kind !== operation.kind
      || record.identity === null
      || record.fingerprint === null
    ) {
      diagnostics.push(
        `${operation.id}: retired cleanup requires matching whole-resource ledger status legacy with identity and fingerprint`,
      );
    }
  }
  return diagnostics;
}

function blockedRetiredPlan(plan: LifecycleOperationPlan, diagnostics: string[]): LifecycleOperationPlan {
  return {
    ...plan,
    operations: plan.operations.map((operation) => operation.action === "blocked_unowned"
      ? operation
      : {
          ...operation,
          state: "ambiguous_ownership",
          ownership: "ambiguous",
          action: "blocked_unowned",
          reason: diagnostics.join("; "),
        }),
  };
}

export function previewRetiredRuntimeCleanup(opts: {
  runtimeId: string;
  home: string;
  ledger?: LifecycleOwnershipLedger;
  contract?: RetiredRuntimeCleanupContract;
}): RetiredRuntimeCleanupPreview {
  const contract = opts.contract ?? loadRetiredRuntimeCleanupContract();
  const runtime = contract.runtimes.find((candidate) => candidate.id === opts.runtimeId);
  if (!runtime) throw new Error(`unknown retired runtime cleanup id: ${opts.runtimeId}`);
  const operations: LifecycleOperationSpec[] = runtime.resources.map((resource) => ({
    id: resource.id,
    destination: expandHome(resource.destination, opts.home),
    kind: resource.kind,
    intent: "remove",
    required: true,
  }));
  const suppliedLedger = opts.ledger ?? emptyLifecycleOwnershipLedger();
  const ledgerErrors = validateLifecycleOwnershipLedger(suppliedLedger);
  const plan = planLifecycleOperations({
    allowedRoots: [path.resolve(opts.home)],
    operations,
    manifest: createLifecycleOwnershipManifest(operations),
    ledger: ledgerErrors.length === 0 ? suppliedLedger : emptyLifecycleOwnershipLedger(),
  });
  const ledgerDiagnostics = ledgerErrors.length > 0
    ? ledgerErrors.map((error) => `invalid ownership ledger: ${error}`)
    : legacyLedgerDiagnostics(plan);
  const authorizedPlan = ledgerDiagnostics.length === 0
    ? plan
    : blockedRetiredPlan(plan, ledgerDiagnostics);
  return {
    schemaVersion: "agentera.retiredRuntimeCleanupPreview.v1",
    mode: "preview",
    runtimeId: runtime.id,
    activeRuntime: false,
    sourceProduct: runtime.sourceProduct,
    approvalRequired: true,
    ownershipRequirement: "matching_whole_resource_legacy_ledger",
    ledgerAuthorization: ledgerDiagnostics.length === 0 ? "legacy_match_or_absent_noop" : "blocked",
    ledgerDiagnostics,
    plan: authorizedPlan,
    neverTouch: runtime.neverTouch.map((entry) => expandHome(entry, opts.home)),
    safetyNote: runtime.safetyNote,
  };
}

function approvalRequiredResult(preview: RetiredRuntimeCleanupPreview): LifecycleApplyResult {
  const operations: AppliedLifecycleOperation[] = preview.plan.operations.map((operation) => ({
    ...operation,
    action: operation.action === "noop" || operation.action === "blocked_unowned"
      ? operation.action
      : "action_required",
    status: operation.action === "noop"
      ? "noop"
      : operation.action === "blocked_unowned"
        ? "blocked_unowned"
        : "action_required",
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

export function applyRetiredRuntimeCleanup(
  preview: RetiredRuntimeCleanupPreview,
  options: LifecycleApplyOptions & { approved: boolean },
): RetiredRuntimeCleanupResult {
  const currentLedgerDiagnostics = legacyLedgerDiagnostics(preview.plan);
  const authorized = preview.ledgerAuthorization === "legacy_match_or_absent_noop"
    && currentLedgerDiagnostics.length === 0;
  const result = options.approved && authorized
    ? applyLifecycleOperations(preview.plan, options)
    : approvalRequiredResult(preview);
  return {
    ...result,
    runtimeId: preview.runtimeId,
    activeRuntime: false,
    sourceProduct: preview.sourceProduct,
    approval: options.approved ? "approved" : "required",
  };
}
