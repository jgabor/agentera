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
  formatEntry,
  missingSchemaError,
  printStatusCounts,
  sourceMetadata,
  statusCounts,
  structuredState,
  truncate,
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

const PLAN_HISTORY_CATALOG_LIMIT = 10;

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
  if (archivePaths.length > PLAN_HISTORY_CATALOG_LIMIT) {
    source.archive_paths_omitted_count = archivePaths.length - PLAN_HISTORY_CATALOG_LIMIT;
  }
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
    archive_paths_omitted_count: Math.max(0, discovery.archived.length - PLAN_HISTORY_CATALOG_LIMIT),
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
    fallback: complete ? [] : ["agentera docs --format json"],
    fallback_policy:
      "When plan CLI output is missing or incomplete, use supported CLI state such as `agentera docs --format json` " +
      "for artifact mapping before any last-resort raw plan artifact read.",
    summary_fields: summaryFields,
    entry_fields: entryFields,
  };
}

export function queryPlan(args: StateArgs, schemas: Record<string, SchemaInfo>, io: Io): number {
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
  const title = summary.title ?? "";
  const status = summary.status ?? "";
  const created = summary.created ?? "";
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
  if (primary.archived) o(`Plan source: archived | path=${primary.path}\n`);
  if (currentDiagnostics.length > 0) {
    const diagnostic = currentDiagnostics[0]!;
    o(`Plan diagnostic: path=${diagnostic.path} | category=${diagnostic.category} | diagnostic=${diagnostic.message}\n`);
  }
  o(`Plan: status=${status || "unknown"} | title=${truncate(title)} | created=${created || "-"}\n`);
  if (!evidence.complete) o("Evidence: incomplete | missing authoritative task evidence\n");
  for (const key of ["what", "why"]) {
    const value = dataDict[key];
    if (value) o(`${key}: ${truncate(value)}\n`);
  }
  printStatusCounts("Task status", statusCounts(tasks), o);
  const visibleTasks = tasks.slice(0, 10);
  for (const task of visibleTasks) {
    const line = formatEntry(task, ["number", "status", "name", "title"]);
    if (line) o(`Task: ${line}\n`);
  }
  if (tasks.length > visibleTasks.length) {
    o(`Tasks omitted: ${tasks.length - visibleTasks.length} | reason=text_projection_limit\n`);
    o("Continue: agentera state plan tasks list --format json\n");
    o("Get one: agentera state plan tasks get --task N --format json\n");
  }
  return 0;
}
