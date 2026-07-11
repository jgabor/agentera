import fs from "node:fs";
import path from "node:path";

import { loadYamlMapping } from "../core/yaml.js";
import {
  LIFECYCLE_APPLY_STATUSES,
  LIFECYCLE_OPERATION_CONTRACT_RELATIVE_PATH,
  LIFECYCLE_PLAN_ACTIONS,
  LIFECYCLE_RESOURCE_STATES,
} from "./lifecycleOperations.js";

function sameList(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && JSON.stringify(value) === JSON.stringify(expected);
}

export function validateLifecycleOperationContractData(value: unknown): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return ["operation contract must be a YAML object"];
  }
  const data = value as Record<string, unknown>;
  const errors: string[] = [];
  if (data.schema_version !== "agentera.lifecycleOperationContract.v1") {
    errors.push("schema_version must be agentera.lifecycleOperationContract.v1");
  }
  if (data.status !== "active_contract") errors.push("status must be active_contract");
  if (data.decision !== 92) errors.push("decision must cite approved Decision 92");
  if (!sameList(data.resource_states, LIFECYCLE_RESOURCE_STATES)) {
    errors.push(`resource_states must be ${LIFECYCLE_RESOURCE_STATES.join(", ")}`);
  }
  if (!sameList(data.plan_actions, LIFECYCLE_PLAN_ACTIONS)) {
    errors.push(`plan_actions must be ${LIFECYCLE_PLAN_ACTIONS.join(", ")}`);
  }
  if (!sameList(data.apply_results, LIFECYCLE_APPLY_STATUSES)) {
    errors.push(`apply_results must be ${LIFECYCLE_APPLY_STATUSES.join(", ")}`);
  }
  const ownership = data.ownership as Record<string, unknown> | undefined;
  if (ownership?.identity_rule !== "Managed and published pending-create records bind the filesystem device and inode observed at publication.") {
    errors.push("ownership.identity_rule must bind records to publication identity");
  }
  if (typeof ownership?.removal_rule !== "string" || !ownership.removal_rule.includes("identity and fingerprint")) {
    errors.push("ownership.removal_rule must require matching identity and fingerprint");
  }
  if (
    typeof ownership?.journal_rule !== "string"
    || !ownership.journal_rule.includes("append-only")
    || !ownership.journal_rule.includes("last valid ownership evidence")
  ) {
    errors.push("ownership.journal_rule must preserve the last valid evidence through append-only publication");
  }
  if (
    typeof ownership?.recovery_rule !== "string"
    || !ownership.recovery_rule.includes("last valid connected journal event")
    || !ownership.recovery_rule.includes("re-observes each resource")
  ) {
    errors.push("ownership.recovery_rule must recover interrupted tails and re-observe resources");
  }
  const publication = data.publication_policy as Record<string, unknown> | undefined;
  if (publication?.supported_platform !== "linux_proc_self_fd") {
    errors.push("publication_policy.supported_platform must be linux_proc_self_fd");
  }
  if (publication?.unsupported_platform_result !== "action_required") {
    errors.push("publication_policy.unsupported_platform_result must be action_required");
  }
  if (
    typeof publication?.apply_serialization !== "string"
    || !publication.apply_serialization.includes("proc-fd-pinned")
    || !publication.apply_serialization.includes("stale-lock recovery")
  ) {
    errors.push("publication_policy.apply_serialization must pin and recover the lifecycle apply lock");
  }
  if (publication?.destructive_path_mutations !== "owned_removal_only") {
    errors.push("publication_policy.destructive_path_mutations must be owned_removal_only");
  }
  if (typeof publication?.cleanup_rule !== "string" || !publication.cleanup_rule.includes("never unlinks")) {
    errors.push("publication_policy.cleanup_rule must forbid unlinking colliding or replaced paths");
  }
  const nativePolicy = data.native_policy as Record<string, unknown> | undefined;
  if (nativePolicy?.install_update_auth_trust_operations !== "forbidden") {
    errors.push("native_policy.install_update_auth_trust_operations must be forbidden");
  }
  if (nativePolicy?.trust_is_observed_only !== true) {
    errors.push("native_policy.trust_is_observed_only must be true");
  }
  return errors;
}

export function validateLifecycleOperationContractRoot(root: string): string[] {
  const contractPath = path.join(root, LIFECYCLE_OPERATION_CONTRACT_RELATIVE_PATH);
  if (!fs.existsSync(contractPath)) {
    return [`${LIFECYCLE_OPERATION_CONTRACT_RELATIVE_PATH}:1: missing lifecycle operation contract`];
  }
  try {
    return validateLifecycleOperationContractData(
      loadYamlMapping(fs.readFileSync(contractPath, "utf8")),
    ).map((error) => `${LIFECYCLE_OPERATION_CONTRACT_RELATIVE_PATH}: ${error}`);
  } catch (error) {
    return [
      `${LIFECYCLE_OPERATION_CONTRACT_RELATIVE_PATH}: could not parse contract: ${(error as Error).message}`,
    ];
  }
}
