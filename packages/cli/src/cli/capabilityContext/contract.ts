import fs from "node:fs";
import path from "node:path";
import { loadYamlMapping } from "../../core/yaml.js";
import { activeAppModel, discoverSchemasDir } from "../appContext.js";
import { capabilityStartupCommand } from "../../capabilities/index.js";
import { CAPABILITY_INSTRUCTIONS, capabilityInstructionModulePath } from "../../capabilities/index.js";
import { isFile, pyRepr, appendUnique } from "./shared.js";
import type { JsonObject } from "../../core/jsonValue.js";
import { startupAvailabilityProjection } from "./startupAggregation.js";

export function capabilityInstructionContractPath(): string {
  const model = activeAppModel();
  const active = path.join(String(model.authoritativeRoot ?? model.activeBundleRoot), "references", "cli", "capability-instruction-contract.yaml");
  if (isFile(active)) return active;
  return path.join(path.resolve(discoverSchemasDir(), "..", "..", "..", ".."), "references", "cli", "capability-instruction-contract.yaml");
}

export function capabilityInstructionContract(): JsonObject {
  const p = capabilityInstructionContractPath();
  if (!isFile(p)) return {};
  try {
    return loadYamlMapping(fs.readFileSync(p, "utf8")) as JsonObject; // cast: IO boundary — YAML parse of capability-instruction contract file
  } catch (exc) {
    process.stderr.write(`warning: failed to load capability instruction contract: ${(exc as Error).message}\n`);
    return {};
  }
}

export function capabilityInstructionTarget(capability: string): JsonObject {
  const module = capabilityInstructionModulePath(capability);
  const instructions = CAPABILITY_INSTRUCTIONS[capability] ?? null;
  return {
    module,
    exists: instructions !== null && instructions.length > 0,
    runtime_path: module,
    instructions_present: instructions !== null,
    instructions_length: instructions === null ? 0 : instructions.length,
  };
}

export function firstInvocationReadMetadata(capability: string): JsonObject {
  const authority = capabilityInstructionContract();
  const firstRead: JsonObject = authority.first_invocation_read && typeof authority.first_invocation_read === "object" && !Array.isArray(authority.first_invocation_read) ? authority.first_invocation_read : {};
  const allowedValues: JsonObject = firstRead.allowed_values && typeof firstRead.allowed_values === "object" && !Array.isArray(firstRead.allowed_values) ? firstRead.allowed_values : {};
  const value = "prime_context";
  const valueContract = (allowedValues[value] ?? {}) as JsonObject;
  return {
    field: "first_invocation_read",
    value,
    allowed_values: Object.keys(allowedValues),
    default_rule: firstRead.default_rule ?? firstRead.default_future_rule ?? null,
    module_target: capabilityInstructionTarget(capability),
    startup_command: capabilityStartupCommand(capability),
    obligation_summary: valueContract.obligation ?? `shell out to ${capabilityStartupCommand(capability)}`,
    meaning: valueContract.meaning ?? null,
    runtime_enforcement: true,
    provenance: {
      authority_path: "references/cli/capability-instruction-contract.yaml",
      authority_status: authority.status ?? null,
      decision: authority.decision ?? null,
      source_field: "first_invocation_read.allowed_values",
    },
  };
}

export function capabilityArtifactInventory(capability: string): [JsonObject, string | null] {
  const inventory: JsonObject & { read_needs: string[]; write_targets: string[] } = {
    read_needs: [],
    write_targets: [],
  };
  const capabilityDir = path.join(String(activeAppModel().skillRoot), "capabilities", capability);
  const p = path.join(capabilityDir, "schemas", "artifacts.yaml");
  if (!isFile(p)) return [inventory, `No capability artifact schema found for ${capability}.`];
  let data: JsonObject;
  try {
    data = loadYamlMapping(fs.readFileSync(p, "utf8")) as JsonObject; // cast: IO boundary — YAML parse of artifact inventory file
  } catch (exc) {
    return [inventory, `Capability artifact schema for ${capability} could not be read: ${(exc as Error).message}`];
  }
  const artifacts = data.ARTIFACTS;
  if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts)) {
    return [inventory, `Capability artifact schema for ${capability} has no ARTIFACTS mapping.`];
  }
  const errors: string[] = [];
  for (const [key, entry] of Object.entries(artifacts as JsonObject)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`entry ${key} is not a mapping`);
      continue;
    }
    const e = entry as JsonObject;
    const artifactId = String(e.artifact ?? "").trim();
    const localRole = String(e.local_role ?? "").trim();
    if (!artifactId) {
      errors.push(`entry ${key} is missing artifact`);
      continue;
    }
    if (localRole === "consumes") appendUnique(inventory.read_needs, artifactId);
    else if (localRole === "produces") appendUnique(inventory.write_targets, artifactId);
    else if (localRole === "produces_and_consumes") {
      appendUnique(inventory.read_needs, artifactId);
      appendUnique(inventory.write_targets, artifactId);
    } else errors.push(`entry ${key} has unsupported local_role ${pyRepr(localRole)}`);
  }
  const error = errors.length > 0 ? `Capability artifact schema for ${capability} has invalid ARTIFACTS entries: ${errors.join("; ")}.` : null;
  return [inventory, error];
}

export function capabilityContext(capability: string | null): JsonObject | null {
  if (!capability) return null;
  const [inventory, error] = capabilityArtifactInventory(capability);
  const needs = inventory.read_needs as string[];
  const context: JsonObject = {
    capability,
    first_invocation_read: firstInvocationReadMetadata(capability),
    availability: startupAvailabilityProjection(needs),
    schema_error: error,
  };
  return context;
}
