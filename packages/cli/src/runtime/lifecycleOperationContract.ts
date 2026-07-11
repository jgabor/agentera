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
