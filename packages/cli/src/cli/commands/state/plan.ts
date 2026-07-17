/**
 * `state plan` query (active PLAN.yaml + immutable archive history).
 *
 * Source-contract builder for plan artifacts: declares the
 * `complete_for_plan_artifact` / `complete_for_normal_startup_evaluation`
 * flags that downstream capabilities (prime, orchestrate) read
 * before raw plan access.
 */

import {
  emitStateStructured,
  filterByFieldValue,
  missingSchemaError,
  sourceMetadata,
  statusCounts,
  structuredState,
} from "../../stateQuery.js";
import { SchemaInfo } from "../../appContext.js";
import { artifactPath } from "../../appContext.js";
import { firstPresent } from "../../stateQuery.js";
import { out, err, StateArgs, Io } from "./shared.js";
import type { JsonObject } from "../../../core/jsonValue.js";
import {
  discoverPlanArtifacts,
  planDocumentParts,
  planCatalogEntry,
  type PlanArtifact,
  type PlanArtifactDiscovery,
} from "../../planArtifacts.js";
import { planLifecycleState } from "../../planLifecycleState.js";
import { resolvePlanTaskEvidence } from "../../planEvidence.js";
import { STATE_FAMILY_FALLBACK_COMMANDS } from "../../capabilityContext/types.js";
import { detectStateMode } from "../../../state/stateMode.js";
import { currentPlanEntityView } from "../../../state/planEntities.js";
import { emitStructured } from "../../structured.js";
import YAML from "yaml";

const PLAN_HISTORY_CATALOG_LIMIT = 10;
const PLAN_TEXT_TASK_LIMIT = 10;
const PLAN_TEXT_MAX_UTF8_BYTES = 32_768;

function planCatalogRetrieval(): JsonObject {
  return {
    list: "agentera state plan list --format json",
    get: "agentera state plan get --plan PLAN_ID --format json",
  };
}

function textScalar(value: unknown): string {
  return String(value).replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

function taskTextRow(task: JsonObject): string {
  const parts: string[] = [];
  for (const field of ["number", "status", "name", "title"]) {
    const value = task[field];
    if (value !== null && value !== undefined && value !== "" && !Array.isArray(value) && typeof value !== "object") {
      parts.push(`${field}=${textScalar(value)}`);
    }
  }
  return `Task: ${parts.join(" | ")}\n`;
}

function renderPlanText(
  data: JsonObject,
  tasks: JsonObject[],
  summary: JsonObject,
  evidenceComplete: boolean,
  planId: string,
  diagnostics: JsonObject[],
): string {
  type Row = { kind: "plan" | "task"; text: string };
  const rows: Row[] = [{
    kind: "plan",
    text: `Plan: status=${textScalar(summary.status ?? "unknown")} | title=${textScalar(summary.title ?? "")} | created=${textScalar(summary.created ?? "-")}\n`,
  }];
  if (!evidenceComplete) rows.push({ kind: "plan", text: "Evidence: incomplete | missing authoritative task evidence\n" });
  for (const diagnostic of diagnostics) {
    rows.push({
      kind: "plan",
      text: `Plan diagnostic: path=${textScalar(diagnostic.path)} | category=${textScalar(diagnostic.category)} | diagnostic=${textScalar(diagnostic.message)}\n`,
    });
  }
  for (const key of ["what", "why"]) {
    if (data[key] !== null && data[key] !== undefined && data[key] !== "") {
      rows.push({ kind: "plan", text: `${key}: ${textScalar(data[key])}\n` });
    }
  }
  const counts = statusCounts(tasks);
  if (Object.keys(counts).length > 0) {
    rows.push({
      kind: "plan",
      text: `Task status: ${Object.keys(counts).sort().map((name) => `${name}=${counts[name]}`).join(", ")}\n`,
    });
  }
  rows.push(...tasks.slice(0, PLAN_TEXT_TASK_LIMIT).map((task) => ({ kind: "task" as const, text: taskTextRow(task) })));

  const retained: Row[] = [];
  const countOmitted = Math.max(0, tasks.length - PLAN_TEXT_TASK_LIMIT);
  let byteTaskOmitted = 0;
  let bytePlanOmitted = 0;
  const output = (): string => {
    const lines = retained.map((row) => row.text);
    const taskOmitted = countOmitted + byteTaskOmitted;
    if (taskOmitted > 0) {
      const reason = countOmitted > 0 && byteTaskOmitted > 0
        ? "text_projection_limit_and_output_byte_budget"
        : byteTaskOmitted > 0 ? "text_output_byte_budget" : "text_projection_limit";
      lines.push(`Tasks omitted: ${taskOmitted} | reason=${reason}\n`);
      lines.push("Continue: agentera state plan tasks list --format json\n");
      lines.push("Get one: agentera state plan tasks get --task N --format json\n");
    }
    if (bytePlanOmitted > 0) {
      lines.push(`Plan fields omitted: ${bytePlanOmitted} | reason=text_output_byte_budget\n`);
      lines.push(`Get plan: agentera state plan get --plan ${planId} --format json\n`);
    }
    return lines.join("");
  };
  for (const row of rows) {
    retained.push(row);
    while (Buffer.byteLength(output(), "utf8") > PLAN_TEXT_MAX_UTF8_BYTES) {
      const omitted = retained.pop();
      if (!omitted) break;
      if (omitted.kind === "task") byteTaskOmitted += 1;
      else bytePlanOmitted += 1;
    }
  }
  return output();
}

function planArtifactSummary(artifact: PlanArtifact): JsonObject {
  const { data } = artifact;
  const parts = planDocumentParts(data);
  const header = { ...parts.header, status: parts.status };
  const summary: JsonObject = {
    header,
    title: firstPresent(header, ["title"], data.title ?? ""),
    status: parts.status,
    created: firstPresent(header, ["created"], data.created ?? ""),
    what: data.what,
    why: data.why,
    constraints: data.constraints,
    scope: data.scope,
    design: data.design,
    overall_acceptance: data.overall_acceptance,
    surprises: data.surprises,
    previous_plan_archived: data.previous_plan_archived,
  };
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(summary)) {
    if (v !== null && v !== undefined && v !== "") out[k] = v;
  }
  return out;
}

function planSource(primary: PlanArtifact | null, discovery: PlanArtifactDiscovery): JsonObject {
  const source = sourceMetadata("plan", primary?.path ?? discovery.activePath);
  const archivePaths = discovery.archived.map((artifact) => artifact.path);
  source.active = Boolean(discovery.active);
  source.archived = Boolean(primary?.archived);
  source.active_path = discovery.activePath;
  source.archive_count = archivePaths.length;
  source.archive_paths = archivePaths.slice(0, PLAN_HISTORY_CATALOG_LIMIT);
  const archivePathsOmitted = Math.max(0, archivePaths.length - PLAN_HISTORY_CATALOG_LIMIT);
  source.archive_paths_omitted = archivePathsOmitted > 0;
  source.archive_paths_omitted_count = archivePathsOmitted;
  source.archive_paths_omission_reason = archivePathsOmitted > 0 ? "archive_path_catalog_limit" : null;
  source.archive_paths_retrieval = {
    list: "agentera state plan list --format json",
    get: "agentera state plan get --plan PLAN_ID --format json",
  };
  if (discovery.diagnostics.length > 0) source.diagnostics = discovery.diagnostics;
  const activeDiagnostics = discovery.diagnostics.filter(
    (diagnostic) => diagnostic.path === discovery.activePath && diagnostic.category !== "legacy",
  );
  if (activeDiagnostics.length > 0) source.invalid_path = discovery.activePath;
  if (primary && discovery.diagnostics.some((diagnostic) => diagnostic.path === primary.path && diagnostic.category === "legacy")) {
    source.legacy_input = true;
  }
  if (discovery.invalidArchivePaths.length > 0) source.invalid_archive_paths = discovery.invalidArchivePaths;
  return source;
}

function planCatalog(discovery: PlanArtifactDiscovery): JsonObject[] {
  const artifacts = [
    ...(discovery.active ? [discovery.active] : []),
    ...discovery.archived,
  ];
  return artifacts
    .slice(0, PLAN_HISTORY_CATALOG_LIMIT)
    .map((artifact) => planCatalogEntry(
      artifact,
      discovery.activePath,
      discovery.identities.find((identity) => identity.artifact.path === artifact.path),
    ));
}

function activePlanDiagnostics(discovery: PlanArtifactDiscovery): JsonObject[] {
  return discovery.diagnostics.filter(
    (diagnostic) => diagnostic.path === discovery.activePath && diagnostic.category !== "legacy",
  );
}

function planSourceContract(
  source: JsonObject,
  summary: JsonObject,
  discovery: PlanArtifactDiscovery,
): JsonObject {
  const legacyEntries = Boolean(summary.legacy_entries);
  const evidenceIncomplete = summary.evidence_status === "incomplete";
  const currentDiagnostics = activePlanDiagnostics(discovery);
  const active = source.active === true;
  const verifiedAbsence = !active && currentDiagnostics.length === 0;
  const lifecycle = planLifecycleState({
    exists: source.exists,
    active: source.active,
    active_path: source.active_path,
    diagnostics: currentDiagnostics,
  });
  const complete =
    verifiedAbsence ||
    (Boolean(source.exists) &&
      !legacyEntries &&
      !evidenceIncomplete &&
      currentDiagnostics.length === 0 &&
      lifecycle.current_plan_degraded !== true);
  const startupComplete = complete;
  const missingState: string[] = [];
  if (!source.exists && !verifiedAbsence) missingState.push("plan artifact");
  else if (!active && !verifiedAbsence) missingState.push("active plan artifact");
  if (legacyEntries) missingState.push("current plan task artifact shape");
  if (evidenceIncomplete) missingState.push("task evidence");
  if (currentDiagnostics.length > 0) missingState.push("valid current plan artifact");
  const summaryFields = Object.keys(summary).sort();
  const entryFields = [
    "number",
    "name",
    "depends_on",
    "status",
    "acceptance",
    "evidence",
    "evidence_status",
    "evidence_provenance",
    "blocked_reason",
  ];
  return {
    artifact: "plan",
    canonical_artifact_label: "plan",
    persisted_artifact_path: source.path,
    active_plan_path: discovery.activePath,
    active_plan_exists: active,
    archived_plan_count: discovery.archived.length,
    archive_paths: discovery.archived
      .slice(0, PLAN_HISTORY_CATALOG_LIMIT)
      .map((artifact) => artifact.path),
    archive_paths_omitted: discovery.archived.length > PLAN_HISTORY_CATALOG_LIMIT,
    archive_paths_omitted_count: Math.max(0, discovery.archived.length - PLAN_HISTORY_CATALOG_LIMIT),
    archive_paths_omission_reason: discovery.archived.length > PLAN_HISTORY_CATALOG_LIMIT ? "archive_path_catalog_limit" : null,
    archive_paths_retrieval: {
      list: "agentera state plan list --format json",
      get: "agentera state plan get --plan PLAN_ID --format json",
    },
    invalid_archive_paths: discovery.invalidArchivePaths,
    lifecycle_state: lifecycle,
    complete_for_plan_artifact: complete,
    complete_for_normal_startup_evaluation: startupComplete,
    raw_artifact_reads_required: false,
    raw_artifact_read_policy:
      "Use `agentera state plan --format json` entries, summary, source, and source_contract before raw plan access. " +
      "When complete_for_plan_artifact is true, skip defensive `.agentera/plan.yaml` reads during normal read-only " +
      "plan startup/evaluation; raw plan artifact access is reserved for writes, archival, validation, corruption " +
      "diagnostics, or unavailable/incomplete CLI state.",
    included_state: [
      "header",
      "what",
      "why",
      "constraints",
      "scope",
      "design",
      "tasks",
      "task dependencies",
      "task acceptance criteria",
      "task evidence",
      "task evidence provenance",
      "overall_acceptance",
      "surprises",
      "previous_plan_archived",
      "archived plan history",
    ],
    complete_state: {
      summary: summaryFields,
      entries: entryFields,
      normal_startup_evaluation: startupComplete,
    },
    raw_artifact_access_boundary: {
      normal_read_only_startup_evaluation: "skip raw plan artifact reads when complete_for_plan_artifact is true",
      allowed_raw_artifact_uses: [
        "artifact writes",
        "plan archival",
        "artifact validation",
        "corruption diagnostics",
        "unavailable or incomplete CLI state after CLI fallbacks",
      ],
    },
    missing_state: missingState,
    fallback: complete ? [] : [STATE_FAMILY_FALLBACK_COMMANDS.docs],
    fallback_policy:
      `When plan CLI output is missing or incomplete, use supported CLI state such as \`${STATE_FAMILY_FALLBACK_COMMANDS.docs}\` ` +
      "for artifact mapping before any last-resort raw plan artifact read.",
    summary_fields: summaryFields,
    entry_fields: entryFields,
  };
}

export function queryPlan(args: StateArgs, schemas: Record<string, SchemaInfo>, io: Io): number {
  if (detectStateMode(process.cwd()) === "entities") {
    const o = out(io);
    const format = args.format ?? "text";
    const response = currentPlanEntityView(process.cwd(), args.limit ?? undefined, args.cursor ?? undefined, args.status ?? undefined, { format });
    if (format === "text") o(YAML.stringify(response));
    else emitStructured(response, format as "json" | "yaml", o);
    return 0;
  }
  const o = out(io);
  const e = err(io);
  const info = schemas.plan;
  if (!info) {
    e(missingSchemaError("plan") + "\n");
    return 1;
  }
  const p = artifactPath(info, "plan");
  const discovery = discoverPlanArtifacts(p);
  const currentDiagnostics = activePlanDiagnostics(discovery);
  // Archived plans are immutable history, never executable current state.
  // Keep them in the catalog instead of promoting the newest archive to the
  // current plan when the active artifact is absent.
  const primary = discovery.active;
  const format = args.format ?? "text";
  const catalog = planCatalog(discovery);
  const catalogTotal = (discovery.active ? 1 : 0) + discovery.archived.length;

  if (!primary) {
    if (format !== "text") {
      const source = planSource(null, discovery);
      const lifecycle = planLifecycleState({
        exists: false,
        active: false,
        active_path: discovery.activePath,
        diagnostics: currentDiagnostics,
      });
      const summary: JsonObject = lifecycle.status === "degraded"
        ? {
            invalid_path: discovery.activePath,
            diagnostic: currentDiagnostics[0] ?? discovery.diagnostics.find((diagnostic) => diagnostic.category !== "legacy"),
            absence_reason: "Current plan artifact is invalid.",
          }
        : { absence_reason: "No active plan exists." };
      summary.lifecycle_state = lifecycle;
      const payload = structuredState("plan", [], source, {
        filters: { status: args.status ?? null },
        summary,
        sourceContract: planSourceContract(source, summary, discovery),
      });
      if (lifecycle.current_plan_degraded === true) payload.status = "incomplete";
      payload.plans = catalog;
      payload.plan_catalog = {
        total: catalogTotal,
        returned: catalog.length,
        omitted: catalogTotal > catalog.length,
        omitted_count: Math.max(0, catalogTotal - catalog.length),
        omission_reason: catalogTotal > catalog.length ? "archive_catalog_limit" : null,
        retrieval: planCatalogRetrieval(),
      };
      return emitStateStructured(
        "plan",
        payload,
        format,
        args.fields,
        o,
        e,
      );
    }
    const [diagnostic] = activePlanDiagnostics(discovery);
    if (diagnostic) {
      o(`Plan: invalid | path=${diagnostic.path} | category=${diagnostic.category} | diagnostic=${diagnostic.message}\n`);
    }
    return 0;
  }
  const dataDict = primary.data;
  const parts = planDocumentParts(dataDict);
  const evidence = resolvePlanTaskEvidence(primary, parts.tasks, schemas);
  const summary: JsonObject = {
    ...planArtifactSummary(primary),
    ...(parts.legacyEntries ? { legacy_entries: true } : {}),
  };
  if (currentDiagnostics.length > 0) {
    summary.invalid_path = discovery.activePath;
    summary.current_plan_diagnostic = currentDiagnostics[0];
  }
  summary.evidence_status = evidence.complete ? "complete" : "incomplete";
  summary.evidence_sources = evidence.sources;
  let tasks = evidence.tasks;
  const statusFilter = args.status ?? null;
  if (statusFilter) tasks = filterByFieldValue(tasks, "status", statusFilter);
  const source = planSource(primary, discovery);
  const lifecycle = planLifecycleState({
    exists: source.active === true || source.archived === true,
    active: source.active,
    active_path: source.active_path,
    diagnostics: currentDiagnostics,
  });
  summary.lifecycle_state = lifecycle;
  if (format !== "text") {
    const payload = structuredState("plan", tasks, source, {
      filters: { status: statusFilter },
      summary,
      sourceContract: planSourceContract(source, summary, discovery),
    });
    if (!evidence.complete || lifecycle.current_plan_degraded === true) payload.status = "incomplete";
    payload.plans = catalog;
    payload.plan_catalog = {
      total: catalogTotal,
      returned: catalog.length,
      omitted: catalogTotal > catalog.length,
      omitted_count: Math.max(0, catalogTotal - catalog.length),
      omission_reason: catalogTotal > catalog.length ? "archive_catalog_limit" : null,
      retrieval: planCatalogRetrieval(),
    };
    return emitStateStructured(
      "plan",
      payload,
      format,
      args.fields,
      o,
      e,
    );
  }
  const identity = discovery.identities.find((candidate) => candidate.artifact.path === primary.path);
  o(renderPlanText(dataDict, tasks, summary, evidence.complete, identity?.stableId ?? "PLAN_ID", currentDiagnostics));
  return 0;
}
