import fs from "node:fs";
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

const STARTUP_COMPLETENESS_MISSING_STATE: string[] = [];

export function queryDocs(args: StateArgs, schemas: Record<string, SchemaInfo>, io: Io): number {
  const o = out(io);
  const e = err(io);
  const info = schemas.docs;
  if (!info) {
    e(missingSchemaError("docs") + "\n");
    return 1;
  }
  const p = artifactPath(info, "docs");
  const data = loadArtifact(p);
  const format = args.format ?? "text";
  const isDict = data !== null && typeof data === "object" && !Array.isArray(data);
  if (!isDict) {
    if (format !== "text") {
      return emitStateStructured(
        "docs",
        structuredState("docs", [], sourceMetadata("docs", p), {
          filters: { topic: args.topic ?? null, status: args.status ?? null },
        }),
        format,
        args.fields,
        o,
        e,
      );
    }
    return 0;
  }
  const d = data as Dict;
  const legacyEntries = asList(d.entries);
  if (legacyEntries.length > 0) {
    let entries = legacyEntries;
    const statusFilter = args.status ?? null;
    if (statusFilter) entries = filterByFieldValue(entries, "status", statusFilter);
    if (format !== "text") {
      return emitStateStructured(
        "docs",
        structuredState("docs", entries, sourceMetadata("docs", p), { filters: { status: statusFilter } }),
        format,
        args.fields,
        o,
        e,
      );
    }
    for (const entry of entries) {
      const line = formatEntry(entry, ["last_audit", "document", "path", "status"]);
      if (line) o(line + "\n");
    }
    return 0;
  }
  const mapping = asList(d.mapping);
  let index = asList(d.index);
  const coverage = d.coverage && typeof d.coverage === "object" && !Array.isArray(d.coverage) ? d.coverage : {};
  const conventions =
    d.conventions && typeof d.conventions === "object" && !Array.isArray(d.conventions) ? d.conventions : {};
  const topic = args.topic ?? null;
  if (topic) {
    const t = topic.toLowerCase();
    index = index.filter(
      (entry) =>
        String(entry.document ?? "").toLowerCase().includes(t) ||
        String(entry.path ?? "").toLowerCase().includes(t) ||
        String(entry.status ?? "").toLowerCase().includes(t),
    );
  }
  const statusFilter = args.status ?? null;
  if (statusFilter) index = filterByFieldValue(index, "status", statusFilter);
  if (format !== "text") {
    return emitStateStructured(
      "docs",
      structuredState("docs", index, sourceMetadata("docs", p), {
        filters: { topic, status: statusFilter },
        summary: {
          last_audit: d.last_audit,
          conventions,
          mapping,
          mapping_entries: mapping.length,
          coverage,
          source_contract: {
            capability_startup_complete: STARTUP_COMPLETENESS_MISSING_STATE.length === 0,
            raw_artifact_reads_required: false,
          },
        },
      }),
      format,
      args.fields,
      o,
      e,
    );
  }
  o(`Docs: last_audit=${d.last_audit ?? "-"}\n`);
  o(`Mapping: entries=${mapping.length}\n`);
  if (Object.keys(coverage).length > 0) {
    o("Coverage: " + Object.entries(coverage).map(([k, v]) => `${k}=${truncate(v)}`).join(" | ") + "\n");
  }
  printStatusCounts("Docs status", statusCounts(index), o);
  for (const entry of index.slice(0, 10)) {
    const line = formatEntry(entry, ["document", "path", "last_updated", "status"]);
    if (line) o(line + "\n");
  }
  return 0;
}

export function queryObjective(args: StateArgs, schemas: Record<string, SchemaInfo>, io: Io): number {
  const o = out(io);
  const e = err(io);
  const info = schemas.objective;
  if (!info) {
    e(missingSchemaError("objective") + "\n");
    return 1;
  }
  const p = artifactPath(info, "objective");
  const data = loadArtifact(p);
  const format = args.format ?? "text";
  const isDict = data !== null && typeof data === "object" && !Array.isArray(data);
  if (!isDict) {
    if (format !== "text") {
      return emitStateStructured(
        "objective",
        structuredState("objective", [], sourceMetadata("objective", p), { filters: { status: args.status ?? null } }),
        format,
        args.fields,
        o,
        e,
      );
    }
    return 0;
  }
  const d = data as Dict;
  const legacyEntries = asList(d.entries);
  if (legacyEntries.length > 0) {
    let entries = legacyEntries;
    const statusFilter = args.status ?? null;
    if (statusFilter) entries = filterByFieldValue(entries, "status", statusFilter);
    if (format !== "text") {
      return emitStateStructured(
        "objective",
        structuredState("objective", entries, sourceMetadata("objective", p), { filters: { status: statusFilter } }),
        format,
        args.fields,
        o,
        e,
      );
    }
    for (const entry of entries) {
      const line = formatEntry(entry, ["title", "status", "target", "reason"]);
      if (line) o(line + "\n");
    }
    return 0;
  }
  const header = d.header && typeof d.header === "object" && !Array.isArray(d.header) ? d.header : {};
  const objective = d.objective && typeof d.objective === "object" && !Array.isArray(d.objective) ? d.objective : d;
  const title = firstPresent(header, ["title"], objective.title ?? "");
  const status = firstPresent(header, ["status"], objective.status ?? "");
  const closure = d.closure && typeof d.closure === "object" && !Array.isArray(d.closure) ? d.closure : {};
  if (format !== "text") {
    return emitStateStructured(
      "objective",
      structuredState("objective", objective ? [objective] : [], sourceMetadata("objective", p), {
        filters: { status: args.status ?? null },
        summary: { title, status, header, closure },
      }),
      format,
      args.fields,
      o,
      e,
    );
  }
  o(`Objective: title=${truncate(title)} | status=${status || "unknown"}\n`);
  for (const key of ["description", "target", "measurement", "direction", "unit"]) {
    const value = objective[key] ?? d[key];
    if (value) o(`${key}: ${truncate(value)}\n`);
  }
  if (Object.keys(closure).length > 0) {
    o(formatEntry(closure, ["final_value", "target", "reason"]) + "\n");
  }
  return 0;
}

export function queryExperiments(args: StateArgs, schemas: Record<string, SchemaInfo>, io: Io): number {
  const o = out(io);
  const e = err(io);
  const info = schemas.experiments;
  if (!info) {
    e(missingSchemaError("experiments") + "\n");
    return 1;
  }
  const p = artifactPath(info, "experiments");
  const data = loadArtifact(p);
  const format = args.format ?? "text";
  const isDict = data !== null && typeof data === "object" && !Array.isArray(data);
  if (!isDict) {
    if (format !== "text") {
      return emitStateStructured(
        "experiments",
        structuredState("experiments", [], sourceMetadata("experiments", p), {
          filters: { topic: args.topic ?? null, status: args.status ?? null, limit: args.limit ?? 5 },
        }),
        format,
        args.fields,
        o,
        e,
      );
    }
    return 0;
  }
  const d = data as Dict;
  let entries = asList(d.experiments);
  const statusFilter = args.status ?? null;
  if (statusFilter) entries = filterByFieldValue(entries, "status", statusFilter);
  const topic = args.topic ?? null;
  if (topic) entries = filterByTopic(entries, topic, info.fields);
  const limit = (args.limit ?? 5) || 5;
  entries = entries.slice(-limit);
  const closure = d.closure && typeof d.closure === "object" && !Array.isArray(d.closure) ? d.closure : {};
  if (format !== "text") {
    return emitStateStructured(
      "experiments",
      structuredState("experiments", entries, sourceMetadata("experiments", p), {
        filters: { topic, status: statusFilter, limit },
        summary: { closure },
      }),
      format,
      args.fields,
      o,
      e,
    );
  }
  printStatusCounts("Experiment status", statusCounts(entries), o);
  for (const entry of entries) {
    o(formatEntry(entry, ["number", "date", "label", "status"]) + "\n");
    const metric = entry.metric;
    if (metric && typeof metric === "object" && !Array.isArray(metric)) {
      const metricLine = formatEntry(metric, ["primary_value", "delta_vs_baseline"]);
      if (metricLine) o(`  metric: ${metricLine}\n`);
    }
    for (const key of ["conclusion", "next"]) {
      const value = entry[key];
      if (value) o(`  ${key}: ${truncate(value)}\n`);
    }
  }
  if (Object.keys(closure).length > 0) {
    o("Closure: " + formatEntry(closure, ["final_value", "target", "reason"]) + "\n");
  }
  return 0;
}

const TODO_SEVERITY_ORDER_KEYS = ["critical", "degraded", "warning", "normal", "info", "annoying"];
const TODO_ITEM_RE = /^- \[([^\]]+)\]\s+(.*)/;
const TODO_SEV_GLYPHS: Record<string, string> = {
  critical: "\u21f6",
  degraded: "\u21c9",
  warning: "\u21c9",
  normal: "\u2192",
  info: "\u21e2",
  annoying: "\u21e2",
};

function normalizeSeverity(value: unknown, deflt = "normal"): string {
  const text = String(value || deflt).toLowerCase();
  for (const key of TODO_SEVERITY_ORDER_KEYS) {
    if (text.includes(key)) return key;
  }
  return deflt;
}

export function queryTodo(
  args: StateArgs,
  schemas: Record<string, SchemaInfo>,
  io: Io,
  openOnly = false,
): number {
  const o = out(io);
  const info: SchemaInfo = schemas.todo ?? { path: "TODO.md", record: undefined, schema: {}, fields: {} };
  const todoPath = artifactPath(info, "todo");
  const severity = args.severity ?? null;
  const status = args.status ?? null;
  const format = args.format ?? "text";

  if (!fs.existsSync(todoPath)) {
    if (format !== "text") {
      return emitStateStructured(
        "todo",
        structuredState("todo", [], sourceMetadata("todo", todoPath), {
          filters: { severity, status },
        }),
        format,
        args.fields,
        o,
        err(io),
      );
    }
    return 0;
  }

  const data = loadArtifact(todoPath);
  let entries = extractEntries(data);
  if (entries.length > 0) {
    if (severity) entries = filterByFieldValue(entries, "severity", severity);
    if (status) entries = filterByFieldValue(entries, "status", status);
    if (openOnly) {
      entries = entries.filter(
        (entry) => !["done", "closed", "resolved"].includes(String(entry.status ?? "open").toLowerCase()),
      );
    }
    if (format !== "text") {
      return emitStateStructured(
        "todo",
        structuredState("todo", entries, sourceMetadata("todo", todoPath), {
          filters: { severity, status, open_only: openOnly || null },
        }),
        format,
        args.fields,
        o,
        err(io),
      );
    }
    printStatusCounts("TODO status", statusCounts(entries), o);
    for (const entry of entries) {
      const line = formatEntry(entry, ["severity", "status", "description", "title"]);
      if (line) o(line + "\n");
    }
    return 0;
  }

  const text = fs.readFileSync(todoPath, "utf8");
  const marker = severity ? TODO_SEV_GLYPHS[severity.toLowerCase()] ?? severity : null;
  let currentSection: string | null = null;
  const markdownEntries: Dict[] = [];
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const sline = rawLine.trim();
    if (sline.startsWith("## ")) {
      const section = sline.slice(3).trim();
      if (section.toLowerCase().includes("resolved")) {
        currentSection = null;
        continue;
      }
      currentSection = section;
      continue;
    }
    if (currentSection === null) continue;
    const m = TODO_ITEM_RE.exec(sline);
    if (!m) continue;
    if (marker && !currentSection.includes(marker)) continue;
    const item = m[2].trim();
    if (status && !["open", "todo"].includes(status.toLowerCase())) continue;
    markdownEntries.push({
      severity: normalizeSeverity(currentSection),
      status: "open",
      description: item,
      section: currentSection,
    });
    if (format === "text") o(`[${currentSection}] ${item}\n`);
  }
  if (format !== "text") {
    return emitStateStructured(
      "todo",
      structuredState("todo", markdownEntries, sourceMetadata("todo", todoPath), {
        filters: { severity, status, open_only: openOnly || null },
      }),
      format,
      args.fields,
      o,
      err(io),
    );
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
  docs: queryDocs,
  objective: queryObjective,
  experiments: queryExperiments,
  todo: queryTodo,
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
