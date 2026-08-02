import fs from "node:fs";
import path from "node:path";

import type { JsonObject } from "../core/jsonValue.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { loadYamlMapping } from "../core/yaml.js";

const SCHEMA_VERSION = "agentera.todoReadiness.v1";
const PHASE_AUTHORITY = "protocol.yaml#PHASES[*].capabilities";
const REQUIRED_FIELDS = [
  "capability",
  "reason",
  "dependencies",
  "blocked",
  "gate",
  "queue_rank",
  "order_reason",
] as const;
const EVALUATION_PRECEDENCE = [
  "todo_resolved",
  "readiness_absent",
  "blocked",
  "gate_pending",
  "dependency_cross_artifact",
  "dependency_missing",
  "dependency_cycle",
  "dependency_open",
  "ordering_conflict",
  "actionable",
] as const;
const PROHIBITED_TIEBREAKERS = [
  "entity_id",
  "file_order",
  "filesystem_time",
  "created_or_modified_time",
  "description_text",
] as const;

type OutcomeExpectation = {
  result: string;
  eligible: boolean | null;
  attention: "none" | "item";
  recovery: "required" | "null";
};

const OUTCOME_EXPECTATIONS: Record<string, OutcomeExpectation> = {
  todo_resolved: { result: "resolved", eligible: false, attention: "none", recovery: "null" },
  readiness_absent: { result: "needs-triage", eligible: false, attention: "item", recovery: "required" },
  blocked: { result: "blocked", eligible: false, attention: "item", recovery: "required" },
  gate_pending: { result: "gated", eligible: false, attention: "none", recovery: "required" },
  dependency_cross_artifact: { result: "needs-triage", eligible: false, attention: "item", recovery: "required" },
  dependency_missing: { result: "needs-triage", eligible: false, attention: "item", recovery: "required" },
  dependency_cycle: { result: "needs-triage", eligible: false, attention: "item", recovery: "required" },
  dependency_open: { result: "waiting", eligible: false, attention: "none", recovery: "required" },
  dependency_resolved: { result: "satisfied", eligible: null, attention: "none", recovery: "null" },
  ordering_conflict: { result: "needs-triage", eligible: false, attention: "item", recovery: "required" },
  actionable: { result: "actionable", eligible: true, attention: "none", recovery: "null" },
};

const QUEUE_EXPECTATIONS = {
  mixed_actionable_and_triage: {
    selection: "highest_ordered_actionable",
    attention: "bounded_triage_summary",
  },
  all_non_actionable: {
    selection: "abstain",
    attention: "bounded_highest_severity_summary",
  },
} as const;

function isMapping(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return null;
  return value as string[];
}

function sameList(actual: unknown, expected: readonly string[]): boolean {
  const list = stringList(actual);
  return list !== null && list.length === expected.length && list.every((value, index) => value === expected[index]);
}

function canonicalCapabilities(capabilityContract: JsonObject, errors: string[], sourceLabel: string): string[] {
  const aliases = isMapping(capabilityContract.ROUTE_ALIASES)
    ? capabilityContract.ROUTE_ALIASES.primary_aliases
    : null;
  if (!Array.isArray(aliases)) {
    errors.push(`${sourceLabel}: ROUTE_ALIASES.primary_aliases must be a list`);
    return [];
  }
  const capabilities: string[] = [];
  for (const alias of aliases) {
    if (!isMapping(alias) || typeof alias.capability !== "string" || !alias.capability.trim()) {
      errors.push(`${sourceLabel}: each ROUTE_ALIASES.primary_aliases entry must declare capability`);
      continue;
    }
    capabilities.push(alias.capability);
  }
  return capabilities;
}

function derivePhaseMapping(
  protocol: JsonObject,
  canonical: Set<string>,
  errors: string[],
  sourceLabel: string,
): Map<string, string> {
  const mapping = new Map<string, string>();
  if (!isMapping(protocol.PHASES)) {
    errors.push(`${sourceLabel}: protocol PHASES must be a mapping`);
    return mapping;
  }
  for (const entry of Object.values(protocol.PHASES)) {
    if (!isMapping(entry)) continue;
    const phase = typeof entry.value === "string" ? entry.value : "";
    const capabilities = stringList(entry.capabilities);
    if (!phase || capabilities === null) {
      errors.push(`${sourceLabel}: each PHASES entry must declare a value and capabilities list`);
      continue;
    }
    for (const capability of capabilities) {
      if (!canonical.has(capability)) {
        errors.push(`${sourceLabel}: PHASES capability '${capability}' is not canonical`);
      }
      if (mapping.has(capability)) {
        errors.push(`${sourceLabel}: capability '${capability}' appears in multiple PHASES entries`);
      } else {
        mapping.set(capability, phase);
      }
    }
  }
  return mapping;
}

function validateFields(readiness: JsonObject, errors: string[], sourceLabel: string): void {
  const fields = readiness.fields;
  if (!isMapping(fields)) {
    errors.push(`${sourceLabel}: READINESS.fields must be a mapping`);
    return;
  }
  for (const name of REQUIRED_FIELDS) {
    const field = fields[name];
    if (!isMapping(field)) {
      errors.push(`${sourceLabel}: READINESS.fields.${name} must be a mapping`);
      continue;
    }
    if (field.required !== true) {
      errors.push(`${sourceLabel}: READINESS.fields.${name}.required must be true`);
    }
  }
  const capability = fields.capability;
  if (isMapping(capability) && capability.enum_source !== PHASE_AUTHORITY) {
    errors.push(`${sourceLabel}: READINESS.fields.capability.enum_source must be ${PHASE_AUTHORITY}`);
  }
  const dependencies = fields.dependencies;
  const dependencyEntries = isMapping(dependencies) && isMapping(dependencies.entries)
    ? dependencies.entries
    : null;
  const dependencyArtifact = dependencyEntries && isMapping(dependencyEntries.artifact)
    ? dependencyEntries.artifact
    : null;
  if (dependencyArtifact?.const !== "todo") {
    errors.push(`${sourceLabel}: dependency artifact const must be todo`);
  }
}

function validateOutcomes(readiness: JsonObject, errors: string[], sourceLabel: string): void {
  const outcomes = readiness.outcomes;
  if (!isMapping(outcomes)) {
    errors.push(`${sourceLabel}: READINESS.outcomes must be a mapping`);
    return;
  }
  for (const [name, expected] of Object.entries(OUTCOME_EXPECTATIONS)) {
    const outcome = outcomes[name];
    if (!isMapping(outcome)) {
      errors.push(`${sourceLabel}: READINESS.outcomes.${name} must be a mapping`);
      continue;
    }
    if (outcome.result !== expected.result) {
      errors.push(`${sourceLabel}: READINESS.outcomes.${name}.result must be ${expected.result}`);
    }
    if (outcome.eligible !== expected.eligible) {
      errors.push(`${sourceLabel}: READINESS.outcomes.${name}.eligible must be ${String(expected.eligible)}`);
    }
    if (outcome.attention !== expected.attention) {
      errors.push(`${sourceLabel}: READINESS.outcomes.${name}.attention must be one of: none, item`);
    }
    const validRecovery = expected.recovery === "null"
      ? outcome.recovery === null
      : typeof outcome.recovery === "string" && outcome.recovery.trim().length > 0;
    if (!validRecovery) {
      errors.push(`${sourceLabel}: READINESS.outcomes.${name}.recovery must be ${expected.recovery === "null" ? "null" : "a non-empty string"}`);
    }
  }
}

function validateQueueOutcomes(readiness: JsonObject, errors: string[], sourceLabel: string): void {
  const outcomes = readiness.queue_outcomes;
  if (!isMapping(outcomes)) {
    errors.push(`${sourceLabel}: READINESS.queue_outcomes must be a mapping`);
    return;
  }
  for (const [name, expected] of Object.entries(QUEUE_EXPECTATIONS)) {
    const outcome = outcomes[name];
    if (!isMapping(outcome)) {
      errors.push(`${sourceLabel}: READINESS.queue_outcomes.${name} must be a mapping`);
      continue;
    }
    if (outcome.selection !== expected.selection || outcome.attention !== expected.attention) {
      errors.push(`${sourceLabel}: READINESS.queue_outcomes.${name} must use selection=${expected.selection} and attention=${expected.attention}`);
    }
    if (typeof outcome.recovery !== "string" || !outcome.recovery.trim()) {
      errors.push(`${sourceLabel}: READINESS.queue_outcomes.${name}.recovery must be a non-empty string`);
    }
  }
}

function validateOrdering(readiness: JsonObject, errors: string[], sourceLabel: string): void {
  const ordering = readiness.ordering;
  if (!isMapping(ordering)) {
    errors.push(`${sourceLabel}: READINESS.ordering must be a mapping`);
    return;
  }
  if (ordering.primary !== "protocol.yaml#SEVERITY_ISSUE") {
    errors.push(`${sourceLabel}: READINESS.ordering.primary must be protocol.yaml#SEVERITY_ISSUE`);
  }
  for (const legacy of ["within_severity", "duplicate_rank", "prohibited_tiebreakers"]) {
    if (legacy in ordering) errors.push(`${sourceLabel}: READINESS.ordering.${legacy} must be declared under one ordering mode`);
  }
  const modes = ordering.modes;
  if (!isMapping(modes)) {
    errors.push(`${sourceLabel}: READINESS.ordering.modes must be a mapping`);
    return;
  }
  if (Object.keys(modes).sort().join(",") !== "nonprojected,projected_startup") {
    errors.push(`${sourceLabel}: READINESS.ordering.modes must contain only nonprojected and projected_startup`);
  }
  const nonprojected = modes.nonprojected;
  if (!isMapping(nonprojected)) {
    errors.push(`${sourceLabel}: READINESS.ordering.modes.nonprojected must be a mapping`);
  } else {
    if (Object.keys(nonprojected).sort().join(",") !== "duplicate_rank,prohibited_tiebreakers,within_severity") {
      errors.push(`${sourceLabel}: READINESS.ordering.modes.nonprojected has unsupported fields`);
    }
    if (nonprojected.within_severity !== "queue_rank_ascending") {
      errors.push(`${sourceLabel}: READINESS.ordering.modes.nonprojected.within_severity must be queue_rank_ascending`);
    }
    if (nonprojected.duplicate_rank !== "ordering_conflict") {
      errors.push(`${sourceLabel}: READINESS.ordering.modes.nonprojected.duplicate_rank must be ordering_conflict`);
    }
    if (!sameList(nonprojected.prohibited_tiebreakers, PROHIBITED_TIEBREAKERS)) {
      errors.push(`${sourceLabel}: READINESS.ordering.modes.nonprojected.prohibited_tiebreakers must equal ${PROHIBITED_TIEBREAKERS.join(", ")}`);
    }
  }
  const projected = modes.projected_startup;
  const projectedRules: Record<string, string | boolean> = {
    entity_annotation: "required_for_every_entity",
    eligibility: "before_order",
    managed_before_absent: true,
    managed_within_severity: "markdown_order_ascending",
    managed_duplicate_rank: "ignored",
    absent_within_severity: "queue_rank_then_id",
    absent_duplicate_rank: "entity_id_ascending",
  };
  if (!isMapping(projected)) {
    errors.push(`${sourceLabel}: READINESS.ordering.modes.projected_startup must be a mapping`);
  } else {
    if (Object.keys(projected).sort().join(",") !== Object.keys(projectedRules).sort().join(",")) {
      errors.push(`${sourceLabel}: READINESS.ordering.modes.projected_startup has unsupported fields`);
    }
    for (const [field, expected] of Object.entries(projectedRules)) {
      if (projected[field] !== expected) errors.push(`${sourceLabel}: READINESS.ordering.modes.projected_startup.${field} must be ${String(expected)}`);
    }
  }
}

export function validateTodoReadinessContract(
  todoSchema: JsonObject,
  protocol: JsonObject,
  capabilityContract: JsonObject,
  sourceLabel = "TODO readiness contract",
): string[] {
  const errors: string[] = [];
  const readiness = todoSchema.READINESS;
  if (!isMapping(readiness)) return [`${sourceLabel}: READINESS must be a mapping`];
  if (readiness.schema_version !== SCHEMA_VERSION) {
    errors.push(`${sourceLabel}: READINESS.schema_version must be ${SCHEMA_VERSION}`);
  }

  const canonicalList = canonicalCapabilities(capabilityContract, errors, sourceLabel);
  const canonical = new Set(canonicalList);
  const phaseByCapability = derivePhaseMapping(protocol, canonical, errors, sourceLabel);
  const destination = readiness.destination;
  if (!isMapping(destination)) {
    errors.push(`${sourceLabel}: READINESS.destination must be a mapping`);
  } else {
    if (destination.phase_authority !== PHASE_AUTHORITY) {
      errors.push(`${sourceLabel}: READINESS.destination.phase_authority must be ${PHASE_AUTHORITY}`);
    }
    for (const duplicate of ["allowed_destinations", "phase_mapping"]) {
      if (duplicate in destination) {
        errors.push(`${sourceLabel}: READINESS.destination.${duplicate} duplicates the canonical PHASES authority`);
      }
    }
    const excluded = destination.excluded_capabilities;
    if (!isMapping(excluded)) {
      errors.push(`${sourceLabel}: READINESS.destination.excluded_capabilities must be a mapping`);
    } else {
      for (const capability of canonicalList) {
        const mapped = phaseByCapability.has(capability);
        const exclusion = excluded[capability];
        if (mapped && exclusion !== undefined) {
          errors.push(`${sourceLabel}: mapped capability '${capability}' must not also be excluded`);
        } else if (!mapped && (typeof exclusion !== "string" || !exclusion.trim())) {
          errors.push(`${sourceLabel}: canonical capability '${capability}' must be mapped to one phase or explicitly excluded`);
        }
      }
      for (const [capability, reason] of Object.entries(excluded)) {
        if (!canonical.has(capability)) {
          errors.push(`${sourceLabel}: excluded capability '${capability}' is not canonical`);
        }
        if (typeof reason !== "string" || !reason.trim()) {
          errors.push(`${sourceLabel}: excluded capability '${capability}' must have a non-empty reason`);
        }
      }
    }
  }

  validateFields(readiness, errors, sourceLabel);
  const evaluation = readiness.evaluation;
  if (!isMapping(evaluation) || !sameList(evaluation.precedence, EVALUATION_PRECEDENCE)) {
    errors.push(`${sourceLabel}: READINESS.evaluation.precedence must equal ${EVALUATION_PRECEDENCE.join(", ")}`);
  }
  validateOutcomes(readiness, errors, sourceLabel);
  validateQueueOutcomes(readiness, errors, sourceLabel);
  validateOrdering(readiness, errors, sourceLabel);
  return errors;
}

export interface TodoReadinessContract {
  schemaVersion: string;
  allowedDestinations: string[];
  phaseByCapability: Map<string, string>;
  excludedCapabilities: Record<string, string>;
  fields: JsonObject;
  precedence: string[];
  outcomes: Record<string, JsonObject>;
  queueOutcomes: Record<string, JsonObject>;
  ordering: JsonObject;
}

function requiredMappingFields(label: string, value: unknown, names: readonly string[]): string[] {
  if (!isMapping(value)) return [`${label} must be a mapping or null`];
  const errors: string[] = [];
  for (const name of names) {
    if (!(name in value)) errors.push(`${label}.${name} is required`);
    else if (typeof value[name] !== "string" || !String(value[name]).trim()) errors.push(`${label}.${name} must be a non-empty string`);
  }
  for (const name of Object.keys(value)) {
    if (!names.includes(name)) errors.push(`${label} has unsupported field '${name}'`);
  }
  return errors;
}

export function todoReadinessRecordViolations(
  readiness: unknown,
  contract = loadTodoReadinessContract(),
): string[] {
  if (!isMapping(readiness)) return ["readiness must be a mapping"];
  const errors: string[] = [];
  for (const field of REQUIRED_FIELDS) {
    if (!(field in readiness)) errors.push(`${field} is required when readiness is declared`);
  }
  for (const field of Object.keys(readiness)) {
    if (!REQUIRED_FIELDS.includes(field as typeof REQUIRED_FIELDS[number])) errors.push(`readiness has unsupported field '${field}'`);
  }
  if (typeof readiness.capability !== "string" || !contract.allowedDestinations.includes(readiness.capability)) {
    errors.push(`capability must be one of: ${contract.allowedDestinations.join(", ")}`);
  }
  if (typeof readiness.reason !== "string" || !readiness.reason.trim()) errors.push("reason must be a non-empty string");

  if (!Array.isArray(readiness.dependencies)) errors.push("dependencies must be a list");
  else for (const [index, dependency] of readiness.dependencies.entries()) {
    if (!isMapping(dependency)) {
      errors.push(`dependencies[${index}] must be a mapping`);
      continue;
    }
    for (const field of Object.keys(dependency)) {
      if (field !== "artifact" && field !== "id") errors.push(`dependencies[${index}] has unsupported field '${field}'`);
    }
    if (dependency.artifact !== "todo") errors.push(`dependencies[${index}] dependency artifact must be 'todo'`);
    if (!/^[a-z]{10}$/.test(String(dependency.id ?? ""))) errors.push(`dependencies[${index}] dependency ID must be ten lowercase letters`);
  }

  if (readiness.blocked !== null) errors.push(...requiredMappingFields("blocked", readiness.blocked, ["reason", "recovery"]));
  if (readiness.gate !== null) {
    errors.push(...requiredMappingFields("gate", readiness.gate, ["state", "reason", "recovery"]));
    const gate = isMapping(readiness.gate) ? readiness.gate : {};
    const gateFields = isMapping(contract.fields.gate) && isMapping(contract.fields.gate.fields) ? contract.fields.gate.fields : {};
    const stateField = isMapping(gateFields.state) ? gateFields.state : {};
    const allowed = stringList(stateField.enum) ?? [];
    if (typeof gate.state === "string" && !allowed.includes(gate.state)) errors.push(`gate.state must be one of: ${allowed.join(", ")}`);
  }
  const queueField = isMapping(contract.fields.queue_rank) ? contract.fields.queue_rank : {};
  const minimum = typeof queueField.minimum === "number" ? queueField.minimum : 1;
  if (!Number.isInteger(readiness.queue_rank) || Number(readiness.queue_rank) < minimum) errors.push(`queue_rank must be an integer greater than or equal to ${minimum}`);
  if (typeof readiness.order_reason !== "string" || !readiness.order_reason.trim()) errors.push("order_reason must be a non-empty string");
  return [...new Set(errors)];
}

export function todoReadinessReferenceViolations(
  itemId: string,
  readiness: unknown,
  todos: Array<{ id: string; record: JsonObject }>,
): string[] {
  if (!isMapping(readiness) || !Array.isArray(readiness.dependencies)) return [];
  const dependencies = readiness.dependencies
    .filter(isMapping)
    .map((dependency) => String(dependency.id ?? ""))
    .filter((id) => /^[a-z]{10}$/.test(id));
  const byId = new Map(todos.map((todo) => [todo.id, todo.record]));
  const errors: string[] = [];
  for (const dependency of dependencies) {
    if (dependency === itemId) errors.push(`TODO '${itemId}' cannot depend on itself`);
    else if (!byId.has(dependency)) errors.push(`TODO dependency '${dependency}' does not exist`);
  }
  const reachesItem = (id: string, seen: Set<string>): boolean => {
    if (id === itemId) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    const record = byId.get(id);
    const nested = isMapping(record?.readiness) && Array.isArray(record.readiness.dependencies)
      ? record.readiness.dependencies.filter(isMapping).map((dependency) => String(dependency.id ?? ""))
      : [];
    return nested.some((dependency) => reachesItem(dependency, seen));
  };
  if (!errors.length && dependencies.some((dependency) => reachesItem(dependency, new Set()))) {
    errors.push(`TODO '${itemId}' would create a dependency cycle`);
  }
  return errors;
}

export class TodoReadinessContractError extends Error {
  constructor(readonly errors: string[]) {
    super(errors.join("; "));
    this.name = "TodoReadinessContractError";
  }
}

export function loadTodoReadinessContract(
  todoSchemaPath = path.join(resolveSourceRoot(), "skills", "agentera", "schemas", "artifacts", "todo.yaml"),
  protocolPath = path.join(resolveSourceRoot(), "skills", "agentera", "protocol.yaml"),
  capabilityContractPath = path.join(resolveSourceRoot(), "skills", "agentera", "capability_schema_contract.yaml"),
): TodoReadinessContract {
  const todoSchema = loadYamlMapping(fs.readFileSync(todoSchemaPath, "utf8")) as JsonObject;
  const protocol = loadYamlMapping(fs.readFileSync(protocolPath, "utf8")) as JsonObject;
  const capabilityContract = loadYamlMapping(fs.readFileSync(capabilityContractPath, "utf8")) as JsonObject;
  const errors = validateTodoReadinessContract(todoSchema, protocol, capabilityContract, todoSchemaPath);
  if (errors.length) throw new TodoReadinessContractError(errors);

  const readiness = todoSchema.READINESS as JsonObject;
  const destination = readiness.destination as JsonObject;
  const phaseByCapability = derivePhaseMapping(protocol, new Set(canonicalCapabilities(capabilityContract, [], capabilityContractPath)), [], protocolPath);
  return {
    schemaVersion: readiness.schema_version as string,
    allowedDestinations: [...phaseByCapability.keys()],
    phaseByCapability,
    excludedCapabilities: destination.excluded_capabilities as Record<string, string>,
    fields: readiness.fields as JsonObject,
    precedence: (readiness.evaluation as JsonObject).precedence as string[],
    outcomes: readiness.outcomes as Record<string, JsonObject>,
    queueOutcomes: readiness.queue_outcomes as Record<string, JsonObject>,
    ordering: readiness.ordering as JsonObject,
  };
}
