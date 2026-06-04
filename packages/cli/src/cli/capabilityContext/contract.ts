import fs from "node:fs";
import path from "node:path";
import { loadYamlMapping } from "../../core/yaml.js";
import { activeAppModel, discoverSchemasDir } from "../appContext.js";
import { capabilityStartupCommand } from "../../capabilities/index.js";
import {
  PLANERA_COMPLETED_PLAN_ARCHIVE_CONFIRMATION,
  PLANERA_INSTRUCTIONS_AUTHORITY_EXCEPTIONS,
  PLANERA_PLANNING_LEVELS,
  PLANERA_RAW_PLAN_ACCESS_ALLOWED_FOR,
  PLANERA_STARTUP_CONTRACT_VERSION,
  PLANERA_STEP_VERBS,
  STARTUP_ENVELOPE_STATE_FAMILIES,
  STATE_FAMILY_FALLBACK_COMMANDS,
} from "./types.js";
import { CAPABILITY_INSTRUCTIONS, capabilityInstructionModulePath } from "../../capabilities/index.js";
import { isFile, pyRepr, appendUnique } from "./shared.js";
import type { Dict } from "./types.js";

export function capabilityInstructionContractPath(): string {
  const model = activeAppModel();
  const active = path.join(String((model as Dict).authoritativeRoot ?? model.activeBundleRoot), "references", "cli", "capability-instruction-contract.yaml");
  if (isFile(active)) return active;
  return path.join(path.resolve(discoverSchemasDir(), "..", "..", "..", ".."), "references", "cli", "capability-instruction-contract.yaml");
}

export function capabilityInstructionContract(): Dict {
  const p = capabilityInstructionContractPath();
  if (!isFile(p)) return {};
  try {
    return loadYamlMapping(fs.readFileSync(p, "utf8")) as Dict;
  } catch (exc) {
    process.stderr.write(`warning: failed to load capability instruction contract: ${(exc as Error).message}\n`);
    return {};
  }
}

export function capabilityInstructionTarget(capability: string): Dict {
  const module = capabilityInstructionModulePath(capability);
  const prose = CAPABILITY_INSTRUCTIONS[capability] ?? null;
  return {
    module,
    exists: prose !== null && prose.length > 0,
    runtime_path: module,
    prose_present: prose !== null,
    prose_length: prose === null ? 0 : prose.length,
  };
}

export function firstInvocationReadMetadata(capability: string): Dict {
  const authority = capabilityInstructionContract();
  const firstRead = authority.first_invocation_read && typeof authority.first_invocation_read === "object" ? authority.first_invocation_read : {};
  const allowedValues = firstRead.allowed_values && typeof firstRead.allowed_values === "object" ? firstRead.allowed_values : {};
  const value = "prime_context";
  const valueContract = (allowedValues[value] ?? {}) as Dict;
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

export function planeraStartupContract(): Dict {
  return {
    schemaVersion: PLANERA_STARTUP_CONTRACT_VERSION,
    status: "implemented_compact_normal_startup_contract",
    canonical_surface: "agentera prime --context planera --format json",
    bounded: true,
    instructions_runtime_read_required: false,
    instructions_authority: {
      normal_startup:
        "Use this compact context for normal Planera execution startup; " +
        "shell out to `agentera prime --context planera --format json` for the full Planera prose.",
      read_planera_instructions_when: PLANERA_INSTRUCTIONS_AUTHORITY_EXCEPTIONS,
    },
    planning: {
      levels: PLANERA_PLANNING_LEVELS,
      step_marker_format: "── step N/6: verb",
      required_steps: PLANERA_STEP_VERBS,
      full_plan_review_required: true,
      pre_write_self_audit_required: true,
      max_full_plan_tasks: 8,
    },
    cli_first_orientation: {
      use_startup_state_first: true,
      current_plan_command: "agentera plan --format json",
      complete_plan_contract_key: "source_contract.complete_for_plan_artifact",
      fallback_policy:
        "Use CLI-provided fallback commands for missing or incomplete state families " +
        "before any last-resort raw artifact read.",
    },
    artifact_access_boundaries: {
      skip_raw_plan_artifact_when:
        "`agentera plan --format json` reports source_contract.complete_for_plan_artifact=true " +
        "during normal read-only startup or evaluation.",
      raw_plan_artifact_allowed_for: PLANERA_RAW_PLAN_ACCESS_ALLOWED_FOR,
      completed_plan_archive_confirmation: PLANERA_COMPLETED_PLAN_ARCHIVE_CONFIRMATION,
      artifact_mapping_source: "agentera docs/query artifact mapping before writes or closeout",
    },
    handoff_expectations: [
      "skip level suggests ⧉ realisera and waits for confirmation unless the user already asked to implement now",
      "single-task plans suggest ⧉ realisera and wait for confirmation",
      "full plans suggest ⎈ orkestrera and wait for confirmation",
    ],
    unsupported_command_boundary: {
      capability_cli_commands_added: true,
      forbidden_examples: [],
      route_boundary:
        "Use `/agentera plan` for routing, `agentera plan` for plan state, " +
        "and `agentera planera` for capability routing guidance only.",
    },
    seam_decision: {
      selected: "prime --context",
      not_changed: [
        { surface: "agentera schema --format json", reason: "runtime/schema command discovery, not capability workflow startup context" },
        { surface: "dispatcher guidance", reason: "route and CLI-state separation guidance, not a bounded Planera workflow payload" },
      ],
    },
  };
}

export function capabilityArtifactInventory(capability: string): [Dict, string | null] {
  const inventory: Dict = { read_needs: [], write_targets: [] };
  const capabilityDir = path.join(String(activeAppModel().skillRoot), "capabilities", capability);
  const p = path.join(capabilityDir, "schemas", "artifacts.yaml");
  if (!isFile(p)) return [inventory, `No capability artifact schema found for ${capability}.`];
  let data: Dict;
  try {
    data = loadYamlMapping(fs.readFileSync(p, "utf8")) as Dict;
  } catch (exc) {
    return [inventory, `Capability artifact schema for ${capability} could not be read: ${(exc as Error).message}`];
  }
  const artifacts = data.ARTIFACTS;
  if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts)) {
    return [inventory, `Capability artifact schema for ${capability} has no ARTIFACTS mapping.`];
  }
  const errors: string[] = [];
  for (const [key, entry] of Object.entries(artifacts as Dict)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`entry ${key} is not a mapping`);
      continue;
    }
    const e = entry as Dict;
    const artifactId = String(e.artifact_id ?? "").trim();
    const localRole = String(e.local_role ?? "").trim();
    if (!artifactId) {
      errors.push(`entry ${key} is missing artifact_id`);
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

export function capabilityContext(capability: string | null): Dict | null {
  if (!capability) return null;
  const [inventory, error] = capabilityArtifactInventory(capability);
  const needs = inventory.read_needs as string[];
  const writeTargets = inventory.write_targets as string[];
  const missing = needs.filter((name) => !STARTUP_ENVELOPE_STATE_FAMILIES.has(name));
  const cliFallback = missing.filter((name) => name in STATE_FAMILY_FALLBACK_COMMANDS).map((name) => STATE_FAMILY_FALLBACK_COMMANDS[name]);
  const context: Dict = {
    capability,
    first_invocation_read: firstInvocationReadMetadata(capability),
    declared_state_needs: needs,
    declared_write_targets: writeTargets,
    artifact_inventory: inventory,
    included_state_families: needs.filter((name) => STARTUP_ENVELOPE_STATE_FAMILIES.has(name)),
    missing_state_families: missing,
    cli_fallback: cliFallback,
    raw_artifact_read_policy:
      "Use the included state families from this prime --context response first. " +
      "If needed families are missing or CLI state is incomplete, run the CLI fallback commands before raw file access.",
    schema_error: error,
  };
  if (capability === "planera") context.startup_contract = planeraStartupContract();
  return context;
}
