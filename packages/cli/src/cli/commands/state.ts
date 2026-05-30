import { artifactPath, discoverSchemasDir, loadSchemas, SchemaInfo } from "../appContext.js";
import {
  asList,
  COMMAND_FILTERS,
  emitStateStructured,
  extractEntries,
  filterByFieldValue,
  filterByTopic,
  firstPresent,
  formatEntry,
  loadArtifact,
  missingSchemaError,
  printStatusCounts,
  recentCycles,
  sourceMetadata,
  statusCounts,
  structuredState,
  truncate,
  validateFilterValues,
} from "../stateQuery.js";

type Dict = Record<string, any>;
type Io = { out?: (t: string) => void; err?: (t: string) => void };

export interface StateArgs {
  command: string;
  topic?: string | null;
  status?: string | null;
  dimension?: string | null;
  severity?: string | null;
  limit?: number | null;
  format?: string;
  fields?: string | null;
}

function out(io: Io): (t: string) => void {
  return io.out ?? ((t: string) => process.stdout.write(t));
}
function err(io: Io): (t: string) => void {
  return io.err ?? ((t: string) => process.stderr.write(t));
}

export function queryProgress(args: StateArgs, schemas: Record<string, SchemaInfo>, io: Io): number {
  const o = out(io);
  const e = err(io);
  const info = schemas.progress;
  if (!info) {
    e(missingSchemaError("progress") + "\n");
    return 1;
  }
  const p = artifactPath(info, "progress");
  const data = loadArtifact(p);
  let entries = extractEntries(data);
  const topic = args.topic ?? null;
  if (topic) entries = filterByTopic(entries, topic, info.fields);
  const statusFilter = args.status ?? null;
  if (statusFilter) entries = filterByFieldValue(entries, "type", statusFilter);
  const effectiveLimit = (args.limit ?? 5) || 5;
  entries = recentCycles(entries, effectiveLimit);

  if ((args.format ?? "text") !== "text") {
    return emitStateStructured(
      "progress",
      structuredState("progress", entries, sourceMetadata("progress", p), {
        filters: { topic, status: statusFilter, limit: effectiveLimit },
      }),
      args.format ?? "text",
      args.fields,
      o,
      e,
    );
  }
  if (entries.length === 0) return 0;
  for (const entry of entries) {
    o(formatEntry(entry, ["number", "timestamp", "type", "phase", "commit"]) + "\n");
    for (const key of ["what", "verified", "next"]) {
      const value = entry[key];
      if (value) o(`  ${key}: ${truncate(value)}\n`);
    }
  }
  return 0;
}

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
  if (!source.exists) missingState.push("PLAN.md artifact");
  if (legacyEntries) missingState.push("current PLAN.md task artifact shape");
  const summaryFields = Object.keys(summary).sort();
  const entryFields = ["number", "name", "depends_on", "status", "acceptance", "evidence", "blocked_reason"];
  return {
    artifact: "PLAN.md",
    canonical_artifact_label: "PLAN.md",
    persisted_artifact_path: source.path,
    complete_for_plan_artifact: complete,
    complete_for_normal_startup_evaluation: complete,
    raw_artifact_reads_required: false,
    raw_artifact_read_policy:
      "Use `agentera plan --format json` entries, summary, source, and source_contract before raw PLAN.md access. " +
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

function healthAuditNumber(entry: Dict): number | null {
  const number = entry.number;
  if (typeof number === "number" && Number.isInteger(number)) return number;
  if (typeof number === "string" && /^\d+$/.test(number)) return parseInt(number, 10);
  return null;
}

function latestHealthAudit(entries: Dict[]): Dict | null {
  if (entries.length === 0) return null;
  let best: Dict | null = null;
  let bestNumber = -1;
  for (const entry of entries) {
    const number = healthAuditNumber(entry);
    if (number === null) continue;
    if (number > bestNumber) {
      bestNumber = number;
      best = entry;
    }
  }
  return best !== null ? best : entries[entries.length - 1];
}

export function queryHealth(args: StateArgs, schemas: Record<string, SchemaInfo>, io: Io): number {
  const o = out(io);
  const e = err(io);
  const info = schemas.health;
  if (!info) {
    e(missingSchemaError("health") + "\n");
    return 1;
  }
  const p = artifactPath(info, "health");
  const data = loadArtifact(p);
  const entries = extractEntries(data);
  const dimension = args.dimension ?? null;
  let latest = latestHealthAudit(entries);
  let latestEntries = latest ? [latest] : [];
  if (dimension && latestEntries.length > 0) {
    latest = latestEntries[0];
    const dimLower = dimension.toLowerCase();
    let matched = false;
    const grades = latest.grades;
    if (grades && typeof grades === "object" && !Array.isArray(grades)) {
      matched = Object.keys(grades).some((gk) => String(gk).toLowerCase().includes(dimLower));
    }
    const details = latest.dimensions_detail;
    if (Array.isArray(details)) {
      matched =
        matched ||
        details.some((d) => d && typeof d === "object" && String(d.name ?? "").toLowerCase().includes(dimLower));
    }
    if (!matched) latestEntries = [];
  }

  const format = args.format ?? "text";
  if (format !== "text") {
    return emitStateStructured(
      "health",
      structuredState("health", latestEntries, sourceMetadata("health", p), {
        filters: { dimension },
        summary: { latest_only: true },
      }),
      format,
      args.fields,
      o,
      e,
    );
  }
  if (entries.length === 0) return 0;
  latest = latestHealthAudit(entries);
  if (!latest) return 0;
  if (dimension) {
    const dimLower = dimension.toLowerCase();
    const grades = (latest.grades ?? {}) as Dict;
    let matched = false;
    for (const [gk, gv] of Object.entries(grades)) {
      if (String(gk).toLowerCase().includes(dimLower)) {
        o(`${gk}: ${gv}\n`);
        matched = true;
      }
    }
    const details = asList(latest.dimensions_detail);
    for (const d of details) {
      const dn = String(d.name ?? "");
      if (dn.toLowerCase().includes(dimLower)) {
        const summary = d.summary ?? "";
        if (summary) o(`  ${summary}\n`);
        for (const f of asList(d.findings)) {
          o(`  [${f.severity ?? ""}] ${f.heading ?? ""}\n`);
        }
        matched = true;
      }
    }
    if (!matched) return 0;
  } else {
    const num = latest.number ?? "?";
    const traj = latest.trajectory ?? "";
    o(`Audit ${num}: ${traj}\n`);
    const grades = (latest.grades ?? {}) as Dict;
    for (const [gk, gv] of Object.entries(grades)) {
      o(`  ${gk}: ${gv}\n`);
    }
  }
  return 0;
}

const STATE_COMMAND_HANDLERS: Record<
  string,
  (args: StateArgs, schemas: Record<string, SchemaInfo>, io: Io) => number
> = {
  progress: queryProgress,
  plan: queryPlan,
  health: queryHealth,
};



export function isPortedStateCommand(command: string): boolean {
  return command in STATE_COMMAND_HANDLERS;
}

export function cmdState(args: StateArgs, io: Io): number {
  const e = err(io);
  try {
    validateFilterValues(args as Dict, COMMAND_FILTERS[args.command] ?? []);
    if (args.limit !== null && args.limit !== undefined && args.limit < 0) {
      throw new Error("limit must be zero or greater");
    }
    const schemas = loadSchemas(discoverSchemasDir());
    const handler = STATE_COMMAND_HANDLERS[args.command];
    return handler(args, schemas, io);
  } catch (exc) {
    e(`Error: ${(exc as Error).message}\n`);
    return 2;
  }
}
