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
  ) {
    errors.push("Claude cleanup resource must be the legacy Agentera skill symlink removal");
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
  const plan = planLifecycleOperations({
    allowedRoots: [path.resolve(opts.home)],
    operations,
    manifest: createLifecycleOwnershipManifest(operations),
    ledger: opts.ledger ?? emptyLifecycleOwnershipLedger(),
  });
  return {
    schemaVersion: "agentera.retiredRuntimeCleanupPreview.v1",
    mode: "preview",
    runtimeId: runtime.id,
    activeRuntime: false,
    sourceProduct: runtime.sourceProduct,
    approvalRequired: true,
    plan,
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
  const result = options.approved
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
