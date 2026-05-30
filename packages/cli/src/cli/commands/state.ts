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
  stringFieldNames,
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

export function healthAuditNumber(entry: Dict): number | null {
  const number = entry.number;
  if (typeof number === "number" && Number.isInteger(number)) return number;
  if (typeof number === "string" && /^\d+$/.test(number)) return parseInt(number, 10);
  return null;
}

export function latestHealthAudit(entries: Dict[]): Dict | null {
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

export function normalizeSeverity(value: unknown, deflt = "normal"): string {
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

const DECISION_CONTEXT_FIELDS = [
  "number",
  "date",
  "question",
  "context",
  "alternatives",
  "choice",
  "reasoning",
  "confidence",
  "feeds_into",
  "satisfaction",
];

const PRIORITY_FIELDS = [
  "number", "name", "title", "date", "timestamp", "status",
  "phase", "choice", "grade", "type", "label", "trajectory", "confidence",
];

const DECISION_ARCHIVE_RE = /Decision\s+(?<number>\d+)(?:\s+\((?<date>\d{4}-\d{2}-\d{2})\))?:\s*(?<summary>.*)/;

export function displayFields(fields: Dict, limit = 6): string[] {
  const ordered = PRIORITY_FIELDS.filter((p) => p in fields);
  for (const fn of Object.keys(fields)) {
    if (!ordered.includes(fn)) ordered.push(fn);
  }
  return ordered.slice(0, limit);
}

function isEmptyValue(v: unknown): boolean {
  return (
    v === null ||
    v === undefined ||
    v === "" ||
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === "object" && !Array.isArray(v) && Object.keys(v as Dict).length === 0)
  );
}

function decisionArchiveEntry(entry: unknown): Dict {
  const archiveEntry: Dict =
    entry && typeof entry === "object" && !Array.isArray(entry) ? { ...(entry as Dict) } : { summary: String(entry) };
  archiveEntry.compacted = true;
  const summary = String(archiveEntry.summary ?? "");
  const match = DECISION_ARCHIVE_RE.exec(summary);
  if (match && match.groups) {
    if (!("number" in archiveEntry)) archiveEntry.number = parseInt(match.groups.number, 10);
    if (match.groups.date && !("date" in archiveEntry)) archiveEntry.date = match.groups.date;
  }
  return archiveEntry;
}

function extractDecisionEntries(data: unknown): Dict[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) return extractEntries(data);
  const d = data as Dict;
  const decisions = d.decisions ?? [];
  const archive = d.archive ?? [];
  const entries: Dict[] = Array.isArray(decisions)
    ? decisions.filter((e) => e && typeof e === "object" && !Array.isArray(e))
    : [];
  if (Array.isArray(archive)) {
    for (const entry of archive) entries.push(decisionArchiveEntry(entry));
  }
  return entries;
}

function filterDecisionsByTopic(entries: Dict[], topic: string, fields: Dict): Dict[] {
  const t = topic.toLowerCase();
  const fnames = [...stringFieldNames(fields), "summary", "outcome"];
  return entries.filter((entry) => fnames.some((f) => String(entry[f] ?? "").toLowerCase().includes(t)));
}

function decisionFieldMissing(entry: Dict, field: string): boolean {
  return isEmptyValue(entry[field]);
}

function decisionDownstreamReferences(entry: Dict): Array<Record<string, string>> | null {
  const value = entry.feeds_into;
  if (value === null || value === undefined || value === "") return null;
  let refs: string[];
  if (Array.isArray(value)) {
    refs = value.map((item) => String(item).trim()).filter((s) => s);
  } else {
    refs = String(value)
      .split(",")
      .map((part) => part.trim())
      .filter((s) => s);
  }
  if (refs.length === 0) return null;
  return refs.map((ref) => ({ source_field: "feeds_into", reference: ref }));
}

export function decisionSatisfactionContext(entry: Dict): Dict {
  const satisfaction = entry.satisfaction;
  if (!satisfaction || typeof satisfaction !== "object" || Array.isArray(satisfaction)) {
    return {
      state: null,
      evidence: null,
      user_confirmation: null,
      review_needed: true,
      source: "missing_legacy_state",
      caveats: ["Missing legacy satisfaction state is not treated as satisfied."],
    };
  }
  const sat = satisfaction as Dict;
  const state = sat.state;
  const evidence = sat.evidence ?? null;
  const userConfirmation = sat.user_confirmation ?? null;
  const explicitReviewNeeded = sat.review_needed === true;
  let caveats: string[] = [];
  let reviewNeeded = true;
  if (state === "user_confirmed_satisfied") {
    reviewNeeded =
      !(userConfirmation && typeof userConfirmation === "object" && !Array.isArray(userConfirmation)) ||
      Object.keys(userConfirmation as Dict).length === 0;
    if (reviewNeeded) caveats.push("User-confirmed satisfaction is missing explicit user confirmation metadata.");
  } else if (state === "provisionally_satisfied") {
    if (isEmptyValue(evidence)) caveats.push("Provisional satisfaction is missing concrete evidence.");
    caveats.push("Provisional satisfaction still requires user confirmation.");
  } else if (state === "open") {
    caveats.push("Satisfaction state is open and requires review.");
  } else {
    caveats.push("Satisfaction state is missing or unrecognized and requires review.");
  }
  if (explicitReviewNeeded) {
    reviewNeeded = true;
    caveats.push("Decision satisfaction is explicitly marked review_needed.");
  }
  const originalCaveats = sat.caveats;
  if (Array.isArray(originalCaveats)) caveats = [...originalCaveats.map((c) => String(c)), ...caveats];
  else if (typeof originalCaveats === "string") caveats = [originalCaveats, ...caveats];
  const enriched: Dict = { ...sat };
  if (!("evidence" in enriched)) enriched.evidence = evidence;
  if (!("user_confirmation" in enriched)) enriched.user_confirmation = userConfirmation;
  enriched.review_needed = reviewNeeded;
  enriched.source = "decision.satisfaction";
  enriched.caveats = caveats;
  return enriched;
}

export function decisionContextEntry(entry: Dict): Dict {
  const enriched: Dict = { ...entry };
  if ((enriched.outcome === null || enriched.outcome === undefined || enriched.outcome === "") &&
      enriched.choice !== null && enriched.choice !== undefined && enriched.choice !== "") {
    enriched.outcome = enriched.choice;
  }
  const compacted =
    Boolean(enriched.compacted) ||
    ("summary" in enriched &&
      ["question", "reasoning", "confidence"].some((field) => decisionFieldMissing(enriched, field)));
  const missingFields = DECISION_CONTEXT_FIELDS.filter((field) => decisionFieldMissing(enriched, field));
  if (decisionFieldMissing(enriched, "choice") && decisionFieldMissing(enriched, "outcome")) {
    missingFields.push("outcome");
  }
  const downstreamReferences = decisionDownstreamReferences(enriched);
  const caveats: string[] = [];
  if (compacted) caveats.push("Decision entry is compacted; full decision context is not available in this CLI result.");
  if (missingFields.length > 0) caveats.push("Decision entry is missing one or more full-detail context fields.");
  if (downstreamReferences === null) {
    caveats.push("No explicit downstream consequence references were present; none were inferred.");
  }
  const satisfaction = decisionSatisfactionContext(enriched);
  if (satisfaction.review_needed) {
    caveats.push("Decision satisfaction requires user review; missing legacy state is not treated as satisfied.");
  }
  enriched.satisfaction = satisfaction;
  enriched.downstream_consequence_references = downstreamReferences;
  enriched.context_complete =
    !compacted && missingFields.length === 0 && downstreamReferences !== null && !satisfaction.review_needed;
  enriched.missing_fields = missingFields;
  enriched.compacted = compacted;
  enriched.caveats = caveats;
  return enriched;
}

function decisionSourceContract(source: Dict, entries: Dict[], filters: Dict): Dict {
  const sourceExists = Boolean(source.exists);
  const activeFilters = Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== null && v !== undefined));
  const filteredNoMatch = sourceExists && Object.keys(activeFilters).length > 0 && entries.length === 0;
  const compactedEntries = entries.filter((e) => e.compacted).length;
  const entriesWithMissingFields = entries.filter((e) => e.missing_fields && e.missing_fields.length > 0).length;
  const entriesWithoutDownstream = entries.filter((e) => e.downstream_consequence_references === null).length;
  const entriesRequiringSatisfactionReview = entries.filter(
    (e) => e.satisfaction && typeof e.satisfaction === "object" && e.satisfaction.review_needed,
  ).length;
  const userConfirmedSatisfied = entries.filter(
    (e) =>
      e.satisfaction &&
      typeof e.satisfaction === "object" &&
      e.satisfaction.state === "user_confirmed_satisfied" &&
      !e.satisfaction.review_needed,
  ).length;
  const completeForReturned = sourceExists && entries.every((e) => e.context_complete === true);
  const completeForNormalDeliberation = sourceExists;
  const caveats = [
    "Downstream consequence references are derived only from explicit structured feeds_into values; no references are inferred.",
    "Compacted archive decisions are not expanded by this command and are not complete full-detail decision context.",
  ];
  if (!sourceExists) caveats.push("Decision artifact is missing or unavailable; no decision context is available from this command result.");
  if (filteredNoMatch) caveats.push("Filtered result is empty; no returned decisions match the filter, but the decision artifact was available.");
  if (entriesWithMissingFields) caveats.push("One or more returned decisions are missing full-detail context fields.");
  if (entriesWithoutDownstream) caveats.push("One or more returned decisions lack explicit downstream consequence references.");
  if (entriesRequiringSatisfactionReview) caveats.push("One or more returned decisions require satisfaction review; satisfaction is never inferred from downstream references.");
  return {
    artifact: "DECISIONS.md",
    canonical_artifact_label: "DECISIONS.md",
    path: source.path,
    complete_for_returned_decisions: completeForReturned,
    complete_for_decision_context: completeForReturned,
    complete_for_returned_full_detail: completeForReturned,
    complete_for_normal_deliberation_context: completeForNormalDeliberation,
    completeness: {
      returned_decisions: entries.length,
      context_complete: completeForReturned,
      returned_full_detail_complete: completeForReturned,
      normal_deliberation_context: completeForNormalDeliberation,
      filtered_no_match: filteredNoMatch,
      source_exists: sourceExists,
      compacted_entries: compactedEntries,
      entries_with_missing_fields: entriesWithMissingFields,
      entries_without_downstream_references: entriesWithoutDownstream,
      entries_requiring_satisfaction_review: entriesRequiringSatisfactionReview,
      user_confirmed_satisfied_entries: userConfirmedSatisfied,
    },
    included_fields: [
      ...DECISION_CONTEXT_FIELDS,
      "outcome",
      "downstream_consequence_references",
      "context_complete",
      "missing_fields",
      "compacted",
      "caveats",
    ],
    satisfaction_context: {
      owner: "decision entry",
      state_field: "satisfaction.state",
      evidence_field: "satisfaction.evidence",
      confirmation_field: "satisfaction.user_confirmation",
      review_needed_field: "satisfaction.review_needed",
      confirmation_policy:
        "Only satisfaction.state=user_confirmed_satisfied with explicit user_confirmation metadata is reported as user-confirmed satisfied.",
      non_inference_policy:
        "Do not infer satisfaction from feeds_into, commits, downstream files, generated references, or compacted history.",
    },
    normal_deliberation_context: {
      use_complete_for_normal_deliberation_context: true,
      legacy_full_detail_signal: "complete_for_decision_context",
      guidance:
        "For normal deliberation, use returned entries plus missing_fields, compacted, caveats, " +
        "and satisfaction review state. Do not use the legacy full-detail completeness flag " +
        "as a reason to reread the raw decision artifact.",
    },
    decision_context_truth_table: {
      full_detail_entries: {
        full_detail_complete: true,
        normal_deliberation_context_complete: true,
        raw_artifact_read_required: false,
      },
      compacted_archive_entries: {
        full_detail_complete: false,
        normal_deliberation_context_complete: true,
        raw_artifact_read_required: false,
        carry_forward: ["missing_fields", "compacted", "caveats"],
      },
      entries_with_missing_full_detail_fields: {
        full_detail_complete: false,
        normal_deliberation_context_complete: true,
        raw_artifact_read_required: false,
        carry_forward: ["missing_fields", "caveats"],
      },
      satisfaction_review_needed: {
        full_detail_complete: false,
        normal_deliberation_context_complete: true,
        raw_artifact_read_required: false,
        carry_forward: ["satisfaction.review_needed", "caveats"],
      },
      filtered_no_match: {
        full_detail_complete: true,
        normal_deliberation_context_complete: true,
        raw_artifact_read_required: false,
        meaning: "The artifact exists, but no returned decisions matched the filter.",
      },
      missing_or_unavailable_artifact: {
        full_detail_complete: false,
        normal_deliberation_context_complete: false,
        raw_artifact_read_required: false,
        meaning:
          "No decision state is available from the CLI result; use CLI fallback or diagnostics before raw artifact repair.",
      },
    },
    missing_full_detail_boundary: {
      applies_when: "returned decisions have missing_fields or context_complete=false",
      normal_behavior: "Use present structured fields only and preserve missing_fields/caveats downstream.",
      raw_artifact_read_required: false,
      do_not: "Do not infer absent reasoning, alternatives, confidence, feeds_into, outcome, or downstream references.",
    },
    missing_artifact_boundary: {
      applies_when: "source.exists=false",
      normal_behavior: "Treat decision context as unavailable from this result; do not infer historical decisions.",
      raw_artifact_read_required: false,
      diagnostic_boundary: "Raw artifact access is reserved for explicit artifact repair/corruption or CLI-defect investigation.",
    },
    filtered_result_boundary: {
      applies_when: "filters are present and entries=[] while source.exists=true",
      normal_behavior: "Treat the result as no matching returned decisions, not as missing decision state.",
      raw_artifact_read_required: false,
    },
    satisfaction_review_boundary: {
      applies_when: "one or more entries have satisfaction.review_needed=true",
      normal_behavior:
        "Carry satisfaction review pressure forward; only user confirmation can make a decision user-confirmed satisfied.",
      raw_artifact_read_required: false,
      do_not: "Do not infer satisfaction from downstream references, commits, generated files, or compacted history.",
    },
    compacted_history_boundary: {
      applies_when: "returned entries have compacted=true",
      normal_behavior:
        "Use the compact summary and retained fields; preserve compacted/missing_fields/caveats downstream.",
      raw_artifact_read_required: false,
      do_not: "Do not expand archive decisions or reconstruct missing context from git history.",
    },
    raw_artifact_access_boundary: {
      normal_deliberation:
        "skip raw `.agentera/decisions.yaml` reads when complete_for_normal_deliberation_context=true",
      allowed_raw_artifact_uses: [
        "Resonera-owned decision writes or repairs",
        "artifact corruption diagnostics",
        "CLI defect investigation",
      ],
    },
    raw_artifact_reads_required: false,
    raw_artifact_read_policy:
      "Use `agentera decisions --format json` for normal deliberation context and key normal use off " +
      "complete_for_normal_deliberation_context. " +
      "Do not read `.agentera/decisions.yaml` unless investigating artifact corruption or CLI defects; " +
      "historical compacted gaps are exposed through missing_fields and caveats.",
    caveats,
    fallback_behavior: {
      normal:
        "Use this command's entries and source_contract; no raw decision artifact read is required for returned full-detail or compacted decision entries.",
      filtered_result:
        "The same per-decision guarantees apply after filters; an empty filtered result means no matching returned decisions.",
      missing_or_incomplete:
        "If a required field is missing, treat only the present structured fields as authoritative and do not infer absent context.",
      satisfaction:
        "Use only each entry's satisfaction object for satisfaction state. Missing, open, provisional, or unconfirmed satisfaction requires review and must not be reported as user-confirmed satisfied.",
      compacted_history:
        "Compacted archive decisions are included with explicit missing_fields and caveats; treat absent historical context as unavailable during normal deliberation.",
    },
    fallback_policy:
      "If the decision artifact is missing or CLI state appears defective, use CLI fallback/diagnostic paths before raw artifact repair; do not raw-read merely because returned decisions are compacted or incomplete.",
    filters: activeFilters,
  };
}

export function queryDecisions(args: StateArgs, schemas: Record<string, SchemaInfo>, io: Io): number {
  const o = out(io);
  const e = err(io);
  const info = schemas.decisions;
  if (!info) {
    e(missingSchemaError("decisions") + "\n");
    return 1;
  }
  const p = artifactPath(info, "decisions");
  const data = loadArtifact(p);
  let entries = extractDecisionEntries(data);
  const topic = args.topic ?? null;
  if (topic) entries = filterDecisionsByTopic(entries, topic, info.fields);
  const format = args.format ?? "text";
  if (format !== "text") {
    const enriched = entries.map((entry) => decisionContextEntry(entry));
    const source = sourceMetadata("decisions", p);
    const filters = { topic };
    return emitStateStructured(
      "decisions",
      structuredState("decisions", enriched, source, {
        filters,
        sourceContract: decisionSourceContract(source, enriched, filters),
      }),
      format,
      args.fields,
      o,
      e,
    );
  }
  if (entries.length === 0) return 0;
  const disp = displayFields(info.fields);
  for (const entry of entries) {
    const parts: string[] = [];
    for (const fn of disp) {
      const v = entry[fn];
      if (v !== null && v !== undefined && v !== "" && !Array.isArray(v) && typeof v !== "object") {
        parts.push(`${fn}=${v}`);
      }
    }
    if (parts.length > 0) o(parts.join(" | ") + "\n");
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
  decisions: queryDecisions,
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
