/**
 * `state plan` query (active PLAN.yaml → summary + task list).
 *
 * Source-contract builder for plan artifacts: declares the
 * `complete_for_plan_artifact` / `complete_for_normal_startup_evaluation`
 * flags that downstream capabilities (prime, orchestrate) read
 * before raw plan access.
 */

import {
  asList,
  emitStateStructured,
  filterByFieldValue,
  formatEntry,
  loadArtifact,
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

type Dict = Record<string, any>;

function planArtifactSummary(data: Dict, header: Dict): Dict {
  const summary: Dict = {
    header,
    title: firstPresent(header, ["title"], data.title ?? ""),
    status: firstPresent(header, ["status"], data.status ?? ""),
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
  const out: Dict = {};
  for (const [k, v] of Object.entries(summary)) {
    if (v !== null && v !== undefined && v !== "") out[k] = v;
  }
  return out;
}

function planSourceContract(source: Dict, summary: Dict): Dict {
  const legacyEntries = Boolean(summary.legacy_entries);
  const complete = Boolean(source.exists) && !legacyEntries;
  const missingState: string[] = [];
  if (!source.exists) missingState.push("plan artifact");
  if (legacyEntries) missingState.push("current plan task artifact shape");
  const summaryFields = Object.keys(summary).sort();
  const entryFields = ["number", "name", "depends_on", "status", "acceptance", "evidence", "blocked_reason"];
  return {
    artifact: "plan",
    canonical_artifact_label: "plan",
    persisted_artifact_path: source.path,
    complete_for_plan_artifact: complete,
    complete_for_normal_startup_evaluation: complete,
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
      "overall_acceptance",
      "surprises",
      "previous_plan_archived",
    ],
    complete_state: {
      summary: summaryFields,
      entries: entryFields,
      normal_startup_evaluation: complete,
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
  const data = loadArtifact(p);
  const isDict = data !== null && typeof data === "object" && !Array.isArray(data);
  const format = args.format ?? "text";

  if (!isDict) {
    if (format !== "text") {
      const source = sourceMetadata("plan", p);
      const summary = { absence_reason: "No plan artifact is available from agentera plan." };
      return emitStateStructured(
        "plan",
        structuredState("plan", [], source, {
          filters: { status: args.status ?? null },
          summary,
          sourceContract: planSourceContract(source, summary),
        }),
        format,
        args.fields,
        o,
        e,
      );
    }
    return 0;
  }
  const dataDict = data as Dict;

  const legacyEntries = asList(dataDict.entries);
  if (legacyEntries.length > 0) {
    let entries = legacyEntries;
    const statusFilter = args.status ?? null;
    if (statusFilter) entries = filterByFieldValue(entries, "status", statusFilter);
    const source = sourceMetadata("plan", p);
    const summary = { legacy_entries: true };
    if (format !== "text") {
      return emitStateStructured(
        "plan",
        structuredState("plan", entries, source, {
          filters: { status: statusFilter },
          summary,
          sourceContract: planSourceContract(source, summary),
        }),
        format,
        args.fields,
        o,
        e,
      );
    }
    for (const entry of entries) {
      const line = formatEntry(entry, ["status", "title", "name"]);
      if (line) o(line + "\n");
    }
    return 0;
  }

  const header =
    dataDict.header && typeof dataDict.header === "object" && !Array.isArray(dataDict.header) ? dataDict.header : {};
  const summary = planArtifactSummary(dataDict, header);
  const title = summary.title ?? "";
  const status = summary.status ?? "";
  const created = summary.created ?? "";
  let tasks = asList(dataDict.tasks);
  const statusFilter = args.status ?? null;
  if (statusFilter) tasks = filterByFieldValue(tasks, "status", statusFilter);
  const source = sourceMetadata("plan", p);
  if (format !== "text") {
    return emitStateStructured(
      "plan",
      structuredState("plan", tasks, source, {
        filters: { status: statusFilter },
        summary,
        sourceContract: planSourceContract(source, summary),
      }),
      format,
      args.fields,
      o,
      e,
    );
  }
  o(`Plan: status=${status || "unknown"} | title=${truncate(title)} | created=${created || "-"}\n`);
  for (const key of ["what", "why"]) {
    const value = dataDict[key];
    if (value) o(`${key}: ${truncate(value)}\n`);
  }
  printStatusCounts("Task status", statusCounts(tasks), o);
  for (const task of tasks.slice(0, 10)) {
    const line = formatEntry(task, ["number", "status", "name", "title"]);
    if (line) o(`Task: ${line}\n`);
  }
  return 0;
}
