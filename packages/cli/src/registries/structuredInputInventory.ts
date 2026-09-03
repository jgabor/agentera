import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import { resolveSourceRoot } from "../core/sourceRoot.js";
import { runtimeOperationSpecs } from "../state/write/runtimeOperations.js";
import { GLOSSARY_ADVICE_STRUCTURED_INPUT_OPTIONS } from "../cli/commands/glossaryAdvice.js";
import { PERSONAL_GLOSSARY_DECISION_STRUCTURED_INPUT_OPTIONS } from "../cli/commands/personalGlossaryDecision.js";
import { PERSONAL_GLOSSARY_PUBLISH_STRUCTURED_INPUT_OPTIONS } from "../cli/commands/personalGlossaryPublish.js";
import { PERSONAL_GLOSSARY_REVIEW_STRUCTURED_INPUT_SPECS } from "../cli/commands/personalGlossaryReviewRecords.js";
import { PRIME_STRUCTURED_INPUT_SPECS } from "../cli/commands/prime.js";

export type StructuredInputSources = {
  writerOperations: ReturnType<typeof runtimeOperationSpecs>;
  glossaryAdviceOptions: readonly string[];
  decisionOptions: readonly string[];
  publishOptions: readonly string[];
  reviewSpecs: readonly { action: string; option: string }[];
  startupSpecs: readonly { context: string; option: string }[];
};

export function activeStructuredInputSources(): StructuredInputSources {
  return {
    writerOperations: runtimeOperationSpecs(),
    glossaryAdviceOptions: GLOSSARY_ADVICE_STRUCTURED_INPUT_OPTIONS,
    decisionOptions: PERSONAL_GLOSSARY_DECISION_STRUCTURED_INPUT_OPTIONS,
    publishOptions: PERSONAL_GLOSSARY_PUBLISH_STRUCTURED_INPUT_OPTIONS,
    reviewSpecs: PERSONAL_GLOSSARY_REVIEW_STRUCTURED_INPUT_SPECS,
    startupSpecs: PRIME_STRUCTURED_INPUT_SPECS,
  };
}

export function activeStructuredInputRouteIds(inputs = activeStructuredInputSources()): string[] {
  const writers = inputs.writerOperations.filter((operation) => operation.structuredInputSources.length > 0).map((operation) => `writer.${operation.artifact}.${operation.verb}.input`);
  const optionName = (option: string) => option.slice(2);
  const reports = [
    ...inputs.glossaryAdviceOptions.map((option) => `report.glossary-advice.${optionName(option)}`),
    ...inputs.decisionOptions.map((option) => `report.personal-glossary-decision.${optionName(option)}`),
    ...inputs.publishOptions.map((option) => `report.personal-glossary-publish.${optionName(option)}`),
    ...inputs.reviewSpecs.map(({ action, option }) => `report.personal-glossary-reviews.${action}.${optionName(option)}`),
  ];
  const startup = inputs.startupSpecs.map(({ context, option }) => `startup.${context}.${optionName(option)}`);
  return [...writers, ...reports, ...startup].sort();
}

export function computeSyntheticMetrics(contentBytes: number, processes: Array<{ wrapper: boolean; contentBearing: boolean }>) {
  const contentBearingCount = processes.filter((process) => process.contentBearing).length;
  return {
    child_process_count: processes.length,
    wrapper_count: processes.filter((process) => process.wrapper).length,
    duplicate_content_bytes: Math.max(0, contentBearingCount - 1) * contentBytes,
  };
}

type Inventory = {
  schema_version?: unknown;
  scope?: unknown;
  historical_surfaces?: unknown;
  evidence?: { mode?: string; recent_host_usage_claim?: boolean };
  routes?: Array<{
    id?: string;
    owner?: string;
    disposition?: string;
    usage_evidence?: { recurring_host_usage?: string; cost_evidence?: string; blocked_by?: string };
    retention_justification?: string;
  }>;
  exceptions?: Array<{ route_id?: string; owner?: string }>;
  synthetic_baseline?: {
    route_identity?: string;
    content_bytes?: number;
    fixtures?: Array<{
      child_process_count?: number;
      wrapper_count?: number;
      duplicate_content_bytes?: number;
    }>;
    deltas?: {
      child_process_count?: number;
      wrapper_count?: number;
      duplicate_content_bytes?: number;
    };
  };
  closure_evidence?: {
    active_registry_routes?: number;
    classified_active_routes?: number;
    historical_only_routes?: unknown;
    unresolved_rows?: number;
    simplify_remove_rows?: number;
    command_trace_proof?: string;
  };
};

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function structuredInputInventoryPath(): string {
  return path.join(resolveSourceRoot(), "references/analysis/structured-input-inventory.yaml");
}

export function validateStructuredInputInventory(inventoryPath = structuredInputInventoryPath(), activeIds = activeStructuredInputRouteIds()): string[] {
  let source: string;
  try {
    source = fs.readFileSync(inventoryPath, "utf8");
  } catch {
    return ["structured input inventory is unreadable"];
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(source) as unknown;
  } catch {
    return ["structured input inventory contains malformed YAML"];
  }
  if (!isMapping(parsed)) return ["structured input inventory root must be a mapping"];
  const inventory = parsed as Inventory;
  const errors: string[] = [];
  if (inventory.schema_version !== "agentera.structuredInputInventory.v1") errors.push("unsupported structured input inventory schema_version");
  if (inventory.scope !== "active_structured_input_routes_only") errors.push("structured input inventory has invalid scope");
  if (inventory.historical_surfaces !== "excluded") errors.push("structured input inventory must exclude historical surfaces");
  if (!Array.isArray(inventory.routes)) return [...errors, "structured input inventory routes must be a list of mappings"];
  if (inventory.routes.some((row) => !isMapping(row))) return [...errors, "structured input inventory routes must be a list of mappings"];
  const rows = inventory.routes;
  const ids: string[] = [];
  rows.forEach((row, index) => {
    if (typeof row.id !== "string" || !row.id.trim()) errors.push(`route id must be a nonempty string: row ${index + 1}`);
    else ids.push(row.id);
  });
  const expected = new Set(activeIds);
  const actual = new Set(ids);

  for (const id of expected) if (!actual.has(id)) errors.push(`missing active route: ${id}`);
  for (const id of actual) if (!expected.has(id)) errors.push(`extra route: ${id}`);
  for (const id of ids.filter((id, index) => ids.indexOf(id) !== index)) errors.push(`duplicate route: ${id}`);
  for (const row of rows) {
    if (!row.owner || !["writer", "report", "startup"].includes(row.owner)) errors.push(`unowned route: ${row.id ?? "<missing>"}`);
    else if (typeof row.id === "string" && row.id.split(".", 1)[0] !== row.owner) errors.push(`route owner does not match namespace: ${row.id}`);
  }
  const dispositions = new Set(["retain", "simplify", "remove", "unresolved"]);
  let unmeasuredSeen = false;
  for (const row of rows) {
    if (!row.disposition || !dispositions.has(row.disposition)) errors.push(`invalid disposition: ${row.id ?? "<missing>"}`);
    if (!row.usage_evidence?.recurring_host_usage || !row.usage_evidence.cost_evidence) {
      errors.push(`missing usage evidence: ${row.id ?? "<missing>"}`);
    }
    if (!row.retention_justification?.trim()) errors.push(`missing retention justification: ${row.id ?? "<missing>"}`);
    const recurring = row.usage_evidence?.recurring_host_usage;
    if (recurring === "not_measured") unmeasuredSeen = true;
    if (recurring === "measured" && unmeasuredSeen && !row.usage_evidence?.blocked_by) {
      errors.push(`measured recurring cost is not prioritized: ${row.id ?? "<missing>"}`);
    }
  }
  for (const exception of inventory.exceptions ?? []) {
    if (!exception.owner?.trim()) errors.push(`unowned exception: ${exception.route_id ?? "<missing>"}`);
  }

  if (inventory.evidence?.mode === "synthetic" && inventory.evidence.recent_host_usage_claim !== false) {
    errors.push("synthetic evidence must not claim recent host usage");
  }
  const baseline = inventory.synthetic_baseline;
  if (!baseline?.route_identity?.trim()) errors.push("synthetic baseline must identify its route");
  if (!Number.isInteger(baseline?.content_bytes) || (baseline?.content_bytes ?? 0) < 1 || baseline?.fixtures?.length !== 2) {
    errors.push("synthetic baseline must contain two fixed-length fixtures");
  } else {
    const contentBytes = baseline.content_bytes as number;
    const expected = [
      computeSyntheticMetrics(contentBytes, [
        { wrapper: true, contentBearing: true },
        { wrapper: false, contentBearing: true },
      ]),
      computeSyntheticMetrics(contentBytes, [{ wrapper: false, contentBearing: true }]),
    ];
    baseline.fixtures.forEach((fixture, index) => {
      for (const [key, value] of Object.entries(expected[index])) {
        if (fixture[key as keyof typeof fixture] !== value) errors.push(`synthetic fixture ${index + 1} has invalid ${key}`);
      }
    });
    const deltas = Object.fromEntries(Object.keys(expected[0]).map((key) => [key, expected[1][key as keyof (typeof expected)[1]] - expected[0][key as keyof (typeof expected)[0]]]));
    for (const [key, value] of Object.entries(deltas)) {
      if (baseline.deltas?.[key as keyof NonNullable<typeof baseline.deltas>] !== value) {
        errors.push(`synthetic baseline has invalid ${key} delta`);
      }
    }
  }
  const simplifyRemoveRows = rows.filter((row) => row.disposition === "simplify" || row.disposition === "remove").length;
  const unresolvedRows = rows.filter((row) => row.disposition === "unresolved").length;
  if (inventory.closure_evidence?.active_registry_routes !== activeIds.length) {
    errors.push("active registry route count does not match active routes");
  }
  if (inventory.closure_evidence?.classified_active_routes !== rows.length) {
    errors.push("classified active route count does not match inventory routes");
  }
  if (inventory.closure_evidence?.historical_only_routes !== "excluded") {
    errors.push("closure evidence must exclude historical routes");
  }
  if (inventory.closure_evidence?.unresolved_rows !== unresolvedRows) {
    errors.push("unresolved row count does not match route dispositions");
  }
  if (inventory.closure_evidence?.simplify_remove_rows !== simplifyRemoveRows) {
    errors.push("simplify/remove row count does not match route dispositions");
  }
  if (simplifyRemoveRows === 0 && inventory.closure_evidence?.command_trace_proof !== "not_applicable_zero_simplify_remove_rows") {
    errors.push("zero simplify/remove rows must record mechanical command-trace N/A");
  }
  return errors;
}
