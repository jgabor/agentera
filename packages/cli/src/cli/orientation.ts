import fs from "node:fs";
import path from "node:path";

import {
  ArtifactRecord,
  resolveArtifactPath,
} from "../registries/artifactRegistry.js";
import {
  activeObjectiveName,
  artifactPath,
  loadRegistryForSchemas,
  SchemaInfo,
} from "./appContext.js";
import {
  asList,
  extractEntries,
  firstPresent,
  loadArtifact,
  recentCycles,
  truncate,
} from "./stateQuery.js";
import { normalizeSeverity } from "./commands/state/index.js";
import { isResolvedTodoMarkdownStatus, parseTodoMarkdownListItem } from "./todoMarkdown.js";
import type { JsonObject } from "../core/jsonValue.js";
import { truncateCodePoints } from "../core/text.js";
import { TODO_SEVERITY_ORDER, TODO_SEVERITY_ORDER_KEYS } from "./todoSeverity.js";
import { capabilityStartupComplete, type StartupCompletenessInput } from "./startupCompletenessContract.js";
import { discoverPlanArtifacts, planCatalogEntry, planDocumentParts } from "./planArtifacts.js";
import { planLifecycleState } from "./planLifecycleState.js";
import { dependencyReadyTasks } from "./capabilityContext/planState.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { scanYamlCollection } from "../state/startupProjection.js";
import { numberedArchiveContract } from "../state/archiveDiscovery.js";
import type {
  DecisionFollowUp,
  DecisionReviewAttention,
  DecisionReviewEntry,
  DocsSummary,
  HealthSummary,
  IssueCounts,
  NextAction,
  ObjectiveSummary,
  PlanSummary,
  ProgressSummary,
  ReadinessHint,
  StatePresenceSummary,
} from "./contracts/orientationState.js";

export type {
  DecisionFollowUp,
  DecisionReviewAttention,
  DecisionReviewEntry,
  DocsSummary,
  HealthSummary,
  IssueCounts,
  NextAction,
  ObjectiveSummary,
  PlanSummary,
  ProgressSummary,
  ReadinessHint,
  StatePresenceSummary,
} from "./contracts/orientationState.js";

/**
 * Orientation summaries layer for prime/status. Faithful port of the
 * scripts/agentera `_*_summary`, `_load_todo_items`, `_issue_counts`,
 * `_decision_*`, `_select_status_next_action`, and staleness helpers.
 */

export const DONE_STATUSES = new Set(["complete", "completed", "closed", "done", "resolved", "retired"]);
export const BLOCKED_STATUSES = new Set(["blocked", "stuck"]);
export const DECISION_ATTENTION_MAX_ENTRIES = 3;
const TODO_SECTION_SEVERITIES: Record<string, string> = Object.fromEntries(
  TODO_SEVERITY_ORDER_KEYS.map((key) => [key, key]),
);
const TODO_PLAN_SIGNALS = new Set([
  "acceptance", "artifact", "capability", "capability-context", "compatibility", "contract",
  "cross-capability", "docs", "metadata", "migration", "schema", "startup", "surface", "test", "validation",
]);

const PROFILE_STALE_DAYS_ENV = "AGENTERA_PROFILE_MAX_AGE_DAYS";
const DEFAULT_PROFILE_STALE_DAYS = 7;
const AUDIT_STALE_DAYS_ENV = "AGENTERA_AUDIT_MAX_AGE_DAYS";
const DEFAULT_AUDIT_STALE_DAYS = 30;
const AUDIT_STALE_CYCLES_ENV = "AGENTERA_AUDIT_MAX_CYCLES";
const DEFAULT_AUDIT_STALE_CYCLES = 10;

type Env = Record<string, string | undefined>;

function intEnv(env: Env, key: string, def: number): number {
  const raw = env[key] ?? String(def);
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return def;
  return n >= 0 ? n : def;
}

// ── date helpers (calendar-day arithmetic) ──────────────────────────

function dateFromIso(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const utc = Date.UTC(y, mo - 1, d);
  const back = new Date(utc);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return utc;
}

function todayUtc(): number {
  const now = new Date();
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
}

function daysSince(genUtc: number): number {
  return Math.round((todayUtc() - genUtc) / 86400000);
}

// ── entry helpers ───────────────────────────────────────────────────

function entryStatusPy(entry: JsonObject, def = "open"): string {
  const raw = "status" in entry ? entry.status : def;
  return String(raw || def).toLowerCase();
}

function isOpenEntry(entry: JsonObject): boolean {
  return !DONE_STATUSES.has(entryStatusPy(entry));
}

export function loadNamedArtifact(schemas: Record<string, SchemaInfo>, name: string): unknown {
  const info = schemas[name];
  if (!info) return null;
  return loadArtifact(artifactPath(info, name));
}

export function registryArtifactPath(
  artifactId: string,
  schemasDir: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const record = loadRegistryForSchemas(schemasDir).get(artifactId);
  if (record === undefined) throw new Error(`artifact registry does not define '${artifactId}'`);
  return resolveArtifactPath(record as ArtifactRecord, process.cwd(), activeObjectiveName(), env);
}

// ── staleness ───────────────────────────────────────────────────────

const PROFILE_GENERATED_RE = /<!-- Generated:\s*(\d{4}-\d{2}-\d{2})/;
const PROFILE_VALIDATED_RE = /Validated:\s*(\d{4}-\d{2}-\d{2})/;

export function parseProfileHeaderDates(text: string): {
  generatedDate: string | null;
  validatedDate: string | null;
  generatedUtc: number | null;
  validatedUtc: number | null;
} {
  const genMatch = PROFILE_GENERATED_RE.exec(text);
  const generatedDate = genMatch ? genMatch[1] : null;
  const generatedUtc = generatedDate ? dateFromIso(generatedDate) : null;
  const valMatch = PROFILE_VALIDATED_RE.exec(text);
  const validatedDate = valMatch ? valMatch[1] : null;
  const validatedUtc = validatedDate ? dateFromIso(validatedDate) : null;
  return { generatedDate, validatedDate, generatedUtc, validatedUtc };
}

function profileRefreshAnchorUtc(text: string): number | null {
  const { generatedUtc, validatedUtc } = parseProfileHeaderDates(text);
  if (generatedUtc === null && validatedUtc === null) return null;
  if (generatedUtc === null) return validatedUtc;
  if (validatedUtc === null) return generatedUtc;
  return Math.max(generatedUtc, validatedUtc);
}

export function checkProfileStaleness(profilePath: string, env: Env = process.env): [boolean, number, number] | null {
  if (!fs.existsSync(profilePath)) return null;
  let text: string;
  try {
    text = fs.readFileSync(profilePath, "utf8");
  } catch (exc) {
    process.stderr.write(`warning: failed to read profile path ${profilePath}: ${(exc as Error).message}\n`);
    return null;
  }
  const anchor = profileRefreshAnchorUtc(text);
  if (anchor === null) return null;
  const staleDays = intEnv(env, PROFILE_STALE_DAYS_ENV, DEFAULT_PROFILE_STALE_DAYS);
  const since = daysSince(anchor);
  return [since >= staleDays, since, staleDays];
}

export function healthAuditDate(entry: JsonObject): number | null {
  for (const key of ["date", "timestamp"]) {
    const value = entry[key];
    if (typeof value === "string" && value.trim()) {
      const d = dateFromIso(value.trim().slice(0, 10));
      if (d !== null) return d;
    }
  }
  return null;
}

function progressEntryDate(entry: JsonObject): number | null {
  for (const key of ["timestamp", "date"]) {
    const value = entry[key];
    if (typeof value === "string" && value.trim()) {
      const d = dateFromIso(value.trim().slice(0, 10));
      if (d !== null) return d;
    }
  }
  return null;
}

function scanSchemaArtifact(
  schemas: Record<string, SchemaInfo>,
  artifactId: "progress" | "decisions" | "health",
): { active: ReturnType<typeof scanYamlCollection>; archive: ReturnType<typeof scanYamlCollection> } {
  const info = schemas[artifactId];
  const contract = numberedArchiveContract(artifactId, resolveSourceRoot());
  const currentPath = info ? artifactPath(info, artifactId) : path.join(process.cwd(), ".agentera", `${artifactId}.yaml`);
  const primary = scanYamlCollection(currentPath, contract.entryCollection, artifactId, contract.entryNumberField);
  const active = artifactId === "progress" && !primary.collection_found
    ? scanYamlCollection(currentPath, "progress", artifactId, contract.entryNumberField)
    : primary;
  return {
    active,
    archive: scanYamlCollection(currentPath, "archive", artifactId, contract.entryNumberField),
  };
}

function cyclesSinceHealthAudit(schemas: Record<string, SchemaInfo>, auditDate: number): number | null {
  const info = schemas.progress;
  if (!info) return null;
  const scan = scanSchemaArtifact(schemas, "progress").active;
  const entries = scan.entries.map((entry) => entry.fields);
  if (entries.length === 0) return null;
  let count = 0;
  for (const entry of entries) {
    const d = progressEntryDate(entry);
    if (d !== null && d > auditDate) count += 1;
  }
  return count;
}

function checkAuditStaleness(
  schemas: Record<string, SchemaInfo>,
  latest: JsonObject | null,
  auditDate: number | null,
  env: Env = process.env,
): Partial<HealthSummary> | null {
  if (latest === null || auditDate === null) return null;
  const staleDaysThreshold = intEnv(env, AUDIT_STALE_DAYS_ENV, DEFAULT_AUDIT_STALE_DAYS);
  const staleCyclesThreshold = intEnv(env, AUDIT_STALE_CYCLES_ENV, DEFAULT_AUDIT_STALE_CYCLES);
  const since = daysSince(auditDate);
  const cyclesSince = cyclesSinceHealthAudit(schemas, auditDate);
  const timeStale = since >= staleDaysThreshold;
  const cycleStale = cyclesSince !== null && cyclesSince >= staleCyclesThreshold;
  const isStale = timeStale || cycleStale;
  let triggeringAxis = "none";
  if (isStale) {
    if (timeStale && cycleStale) triggeringAxis = "both";
    else if (timeStale) triggeringAxis = "time";
    else triggeringAxis = "cycles";
  }
  const result: Partial<HealthSummary> = {
    stale: isStale,
    days_since_audit: since,
    stale_threshold_days: staleDaysThreshold,
    stale_threshold_cycles: staleCyclesThreshold,
    triggering_axis: triggeringAxis,
  };
  if (cyclesSince !== null) result.cycles_since_audit = cyclesSince;
  if (isStale) result.suggested_action = "Run audit to refresh health audit";
  return result;
}

// ── todo items + issue counts ───────────────────────────────────────

export function loadTodoItems(schemas: Record<string, SchemaInfo>): Array<Record<string, string>> {
  const info: SchemaInfo = schemas.todo ?? { path: "TODO.md", record: undefined, schema: {}, fields: {} };
  const todoPath = artifactPath(info, "todo");
  if (!fs.existsSync(todoPath)) return [];
  const data = loadArtifact(todoPath);
  const entries = extractEntries(data);
  if (entries.length > 0) {
    const items: Array<Record<string, string>> = [];
    for (const entry of entries) {
      if (!isOpenEntry(entry)) continue;
      const text = firstPresent(entry, ["description", "title", "name"], "");
      if (!text) continue;
      items.push({
        severity: normalizeSeverity(entry.severity),
        status: entryStatusPy(entry),
        text: String(text),
      });
    }
    return items;
  }
  const items: Array<Record<string, string>> = [];
  let currentSeverity = "";
  const text = fs.readFileSync(todoPath, "utf8");
  for (const line of text.split(/\r\n|\r|\n/)) {
    const stripped = line.trim();
    if (stripped.startsWith("## ")) {
      const heading = stripped.slice(3).trim().toLowerCase();
      if (heading.includes("resolved")) {
        currentSeverity = "";
      } else {
        currentSeverity = "normal";
        for (const [marker, sev] of Object.entries(TODO_SECTION_SEVERITIES)) {
          if (heading.includes(marker)) {
            currentSeverity = sev;
            break;
          }
        }
      }
      continue;
    }
    if (currentSeverity) {
      const parsed = parseTodoMarkdownListItem(stripped);
      if (!parsed || isResolvedTodoMarkdownStatus(parsed.status)) continue;
      if (!parsed.description) continue;
      items.push({ severity: currentSeverity, status: parsed.status, text: parsed.description });
    }
  }
  return items;
}

export function issueCounts(todoItems: Array<Record<string, string>>): IssueCounts {
  const counts = { critical: 0, degraded: 0, normal: 0, annoying: 0 };
  for (const item of todoItems) {
    const severity = item.severity;
    if (severity === "critical") counts.critical += 1;
    else if (severity === "degraded" || severity === "warning") counts.degraded += 1;
    else if (severity === "info" || severity === "annoying") counts.annoying += 1;
    else counts.normal += 1;
  }
  return counts;
}

function todoNeedsPlan(item: Record<string, string>): boolean {
  const text = item.text.toLowerCase();
  let signalCount = 0;
  for (const signal of TODO_PLAN_SIGNALS) if (text.includes(signal)) signalCount += 1;
  return signalCount >= 2 || (signalCount >= 1 && text.length > 180);
}

// ── per-artifact summaries ──────────────────────────────────────────

export function planSummary(schemas: Record<string, SchemaInfo>): PlanSummary {
  const info = schemas.plan;
  if (!info) {
    const summary: PlanSummary = {
      exists: false,
      active: false,
      tasks: [],
      status: "absent",
      title: "",
      active_path: "",
      absence_reason: "No active plan artifact is available from agentera plan.",
    };
    summary.lifecycle_state = planLifecycleState(summary as unknown as JsonObject);
    return summary;
  }
  const discovery = discoverPlanArtifacts(artifactPath(info, "plan"));
  const activeDiagnostics = discovery.diagnostics.filter(
    (diagnostic) => diagnostic.path === discovery.activePath && diagnostic.category !== "legacy",
  );
  const archivedPlans = discovery.archived.map((artifact) => planCatalogEntry(artifact, discovery.activePath));
  if (!discovery.active) {
    const summary: PlanSummary = {
      exists: activeDiagnostics.length === 0 && archivedPlans.length > 0,
      active: false,
      tasks: [],
      status: activeDiagnostics.length > 0 ? "invalid" : archivedPlans.length > 0 ? "archived" : "absent",
      title: "",
      active_path: discovery.activePath,
      absence_reason:
        activeDiagnostics.length > 0
          ? "Current plan artifact is invalid; see diagnostics."
          : archivedPlans.length > 0
          ? "No active plan artifact is available; archived plan state is history only."
          : "No active plan artifact is available from agentera plan.",
      complete: 0,
      total: 0,
      complete_plan: false,
      first_pending: null,
      archived_plans: archivedPlans,
      archive_count: archivedPlans.length,
      invalid_archive_paths: discovery.invalidArchivePaths,
      ...(activeDiagnostics.length > 0 ? { invalid_path: discovery.activePath } : {}),
      diagnostics: discovery.diagnostics,
    };
    summary.lifecycle_state = planLifecycleState(summary as unknown as JsonObject);
    return summary;
  }

  const d = discovery.active.data;
  const parts = planDocumentParts(d);
  const tasks = parts.tasks;
  const status = parts.legacyEntries ? entryStatusPy(tasks[0], "") : parts.status;
  const title = parts.legacyEntries
    ? String(firstPresent(tasks[0] ?? {}, ["title", "name"], ""))
    : parts.title;
  const complete = tasks.filter((task) => DONE_STATUSES.has(entryStatusPy(task, ""))).length;
  const total = tasks.length;
  const completePlan = DONE_STATUSES.has(status.toLowerCase()) && complete === total;
  const firstPending = completePlan
    ? null
    : dependencyReadyTasks(tasks).find((task) => entryStatusPy(task, "pending") === "pending") ?? null;
  const summary: PlanSummary = {
    exists: true,
    status,
    title,
    active_path: discovery.activePath,
    constraints: d.constraints ?? null,
    scope: d.scope ?? null,
    design: d.design ?? null,
    tasks,
    complete,
    total,
    active: true,
    complete_plan: completePlan,
    first_pending: firstPending,
    archived_plans: archivedPlans,
    archive_count: archivedPlans.length,
    invalid_archive_paths: discovery.invalidArchivePaths,
    diagnostics: discovery.diagnostics,
  };
  summary.lifecycle_state = planLifecycleState(summary as unknown as JsonObject);
  return summary;
}

/** Startup keeps plan routing metadata, not the full active plan body. */
export function startupPlanSummary(plan: PlanSummary): JsonObject {
  const tasks = asList(plan.tasks).filter((task) => task && typeof task === "object" && !Array.isArray(task));
  const boundedTasks = tasks.slice(0, 10).map((task) => {
    const item: JsonObject = {};
    for (const key of ["number", "name", "title", "status", "depends_on", "acceptance_summary", "evidence_summary", "blocked_reasons", "evaluation_state"]) {
      if (!(key in task)) continue;
      if (key === "acceptance_summary" || key === "evidence_summary") {
        const summary = task[key];
        item[key] = summary && typeof summary === "object" && !Array.isArray(summary)
          ? { count: (summary as JsonObject).count ?? asList((summary as JsonObject).items).length }
          : null;
      } else if (key === "evaluation_state") {
        const evaluation = task[key];
        item[key] = evaluation && typeof evaluation === "object" && !Array.isArray(evaluation)
          ? Object.fromEntries(Object.entries(evaluation as JsonObject).filter(([name]) => ["attempt_count", "failure_count", "last_verdict"].includes(name)))
          : null;
      } else if (key === "depends_on") {
        item[key] = asList(task[key]).slice(0, 20);
      } else if (key === "blocked_reasons") {
        item[key] = asList(task[key]).slice(0, 3).map((reason) => truncateCodePoints(String(reason), 160));
      } else {
        item[key] = typeof task[key] === "string" ? truncateCodePoints(task[key], 256) : task[key];
      }
    }
    return item;
  });
  const archived = asList(plan.archived_plans).slice(0, 10);
  const diagnostics = asList(plan.diagnostics).slice(0, 10);
  return {
    exists: Boolean(plan.exists),
    active: Boolean(plan.active),
    status: plan.status,
    title: plan.title ?? "",
    complete: plan.complete ?? 0,
    total: plan.total ?? tasks.length,
    complete_plan: Boolean(plan.complete_plan),
    first_pending: plan.first_pending && typeof plan.first_pending === "object" && !Array.isArray(plan.first_pending)
      ? { number: plan.first_pending.number ?? null, name: plan.first_pending.name ?? plan.first_pending.title ?? "", status: plan.first_pending.status ?? "pending" }
      : null,
    tasks: boundedTasks,
    task_count: tasks.length,
    omitted_task_count: Math.max(0, tasks.length - boundedTasks.length),
    archived_plans: archived,
    archive_count: plan.archive_count ?? archived.length,
    omitted_archive_count: Math.max(0, Number(plan.archive_count ?? archived.length) - archived.length),
    invalid_archive_paths: (plan.invalid_archive_paths ?? []).slice(0, 10),
    diagnostics,
    omitted_diagnostic_count: Math.max(0, (plan.diagnostics ?? []).length - diagnostics.length),
    source_contract: {
      detail_availability: tasks.length > boundedTasks.length ? "summary" : "full",
      retrieval: "agentera state plan --format json",
      raw_archive_records: false,
    },
    lifecycle_state: plan.lifecycle_state ?? null,
  };
}

export function docsSummary(
  schemas: Record<string, SchemaInfo>,
  startupInput: StartupCompletenessInput = {},
): DocsSummary {
  const info = schemas.docs;
  if (!info) {
    return { exists: false, status: "absent", absence_reason: "No docs mapping artifact is available from agentera docs." };
  }
  const docsPath = artifactPath(info, "docs");
  const mapping = scanYamlCollection(docsPath, "mapping", "docs", "artifact");
  const index = scanYamlCollection(docsPath, "index", "docs", "artifact");
  const exists = fs.existsSync(docsPath);
  const header = exists ? truncateCodePoints(fs.readFileSync(docsPath, "utf8"), 4096) : "";
  const lastAudit = /^last_audit:\s*(.+)$/m.exec(header)?.[1]?.trim().replace(/^['"]|['"]$/g, "") ?? null;
  return {
    exists,
    status: "available",
    last_audit: lastAudit,
    conventions: {},
    mapping: mapping.entries.slice(0, 10).map((entry) => entry.fields),
    mapping_entries: mapping.entries.length,
    coverage: {},
    source_contract: {
      capability_startup_complete: capabilityStartupComplete(startupInput),
      raw_artifact_reads_required: false,
      state_families: [
        "plan task details, dependencies, acceptance criteria, and evidence summaries",
        "docs artifact mapping and source-contract completeness metadata",
        "latest progress verification metadata needed for Orchestrate evaluation",
        "Document closeout context metadata for docs/TODO/changelog/progress synchronization",
      ],
    },
    indexed_documents: index.entries.length,
  };
}

export function progressSummary(schemas: Record<string, SchemaInfo>): ProgressSummary {
  const info = schemas.progress;
  if (!info) return { exists: false, status: "absent", absence_reason: "No progress cycles are available from agentera progress." };
  const scan = scanSchemaArtifact(schemas, "progress").active;
  const entries = scan.entries.map((entry) => entry.fields);
  if (entries.length === 0) {
    return { exists: false, status: "absent", absence_reason: "No progress cycles are available from agentera progress." };
  }
  const latest = recentCycles(entries, 1)[0] ?? {};
  const latestCycle: JsonObject = {};
  for (const key of ["number", "timestamp", "type", "phase", "what", "status"]) {
    if (key in latest) latestCycle[key] = latest[key];
  }
  return {
    exists: true,
    status: "available",
    latest: latestCycle,
    latest_verification: latest.verified_present ? { present: true } : null,
    cycle_count: entries.length,
  };
}

export function healthSummary(schemas: Record<string, SchemaInfo>, env: Env = process.env): HealthSummary {
  const info = schemas.health;
  if (!info) return { exists: false };
  const scan = scanSchemaArtifact(schemas, "health").active;
  const entries = scan.entries.map((entry) => entry.fields);
  if (entries.length === 0) return { exists: false };
  const latest = [...entries].sort((left, right) => Number(right.number ?? 0) - Number(left.number ?? 0))[0] ?? null;
  if (!latest) return { exists: false };
  const grades = latest.grades && typeof latest.grades === "object" && !Array.isArray(latest.grades) ? latest.grades : {};
  const gradeRank: Record<string, number> = { A: 0, B: 1, C: 2, D: 3, F: 4 };
  let worst: [string, any, number] | null = null;
  for (const [name, grade] of Object.entries(grades)) {
    const gradeText = String(grade).toUpperCase();
    const rank = gradeRank[gradeText.slice(0, 1)] ?? -1;
    if (worst === null || rank > worst[2]) worst = [name, grade, rank];
  }
  const trajectory = String(latest.trajectory ?? "");
  const auditDate = healthAuditDate(latest);
  const dateStr = auditDate !== null ? isoFromUtc(auditDate) : null;
  const latestNumber = typeof latest.number === "string" || typeof latest.number === "number" ? latest.number : "?";
  const latestTimestamp = typeof latest.timestamp === "string" ? latest.timestamp : null;
  const summary: HealthSummary = {
    exists: true,
    number: latestNumber,
    date: dateStr,
    timestamp: dateStr ?? latestTimestamp,
    trajectory,
    grade: worst ? worst[1] : "",
    worst,
    degrading:
      ["degrading", "declining", "worse"].includes(trajectory.toLowerCase()) ||
      (worst !== null && worst[2] >= gradeRank.D),
  };
  const staleness = checkAuditStaleness(schemas, latest, auditDate, env);
  if (staleness !== null) Object.assign(summary, staleness);
  return summary;
}

function isoFromUtc(utc: number): string {
  const d = new Date(utc);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function objectiveStatus(data: JsonObject): string {
  const header = data.header && typeof data.header === "object" && !Array.isArray(data.header) ? data.header : {};
  const objective = data.objective && typeof data.objective === "object" && !Array.isArray(data.objective) ? data.objective : {};
  return String(
    firstPresent(header, ["status"], data.status ?? objective.status ?? "") || "",
  ).toLowerCase();
}

export function activeObjectiveSummary(): ObjectiveSummary {
  const root = path.join(process.cwd(), ".agentera", "optimize");
  let isDir = false;
  try {
    isDir = fs.statSync(root).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) return { exists: false };
  const candidates: Array<[string, JsonObject, string]> = [];
  let closedCount = 0;
  for (const entry of fs.readdirSync(root)) {
    const candidate = path.join(root, entry);
    try {
      if (!fs.statSync(candidate).isDirectory()) continue;
    } catch {
      continue;
    }
    const objectivePath = path.join(candidate, "objective.yaml");
    if (!fs.existsSync(objectivePath)) continue;
    const data = loadArtifact(objectivePath);
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    const status = objectiveStatus(data as JsonObject);
    if (DONE_STATUSES.has(status)) {
      closedCount += 1;
      continue;
    }
    candidates.push([candidate, data as JsonObject, status]);
  }
  if (candidates.length === 0) return { exists: closedCount > 0, active: false, closed_count: closedCount };
  candidates.sort((a, b) => fs.statSync(b[0]).mtimeMs - fs.statSync(a[0]).mtimeMs);
  const [p, data, status] = candidates[0];
  const header = data.header && typeof data.header === "object" && !Array.isArray(data.header) ? data.header : {};
  const objective = data.objective && typeof data.objective === "object" && !Array.isArray(data.objective) ? data.objective : data;
  const title = firstPresent(header, ["title"], objective.title ?? path.basename(p));
  const metric = firstPresent(objective, ["measurement", "metric", "direction", "target"], title);
  const target = firstPresent(objective, ["target"], "");
  return {
    exists: true,
    active: true,
    name: path.basename(p),
    title: String(title),
    status: status || "active",
    metric: String(metric),
    target: String(target),
  };
}

export function statePresence(
  plan: PlanSummary,
  docs: DocsSummary,
  progress: ProgressSummary,
  health: HealthSummary,
  objective: ObjectiveSummary,
): StatePresenceSummary {
  const active = { plan: Boolean(plan.active), objective: Boolean(objective.active) };
  const available = {
    plan: Boolean(plan.exists),
    docs: Boolean(docs.exists),
    progress: Boolean(progress.exists),
    health: Boolean(health.exists),
    objective: Boolean(objective.exists),
  };
  const absence: Record<string, string> = {};
  for (const [name, summary] of [
    ["plan", plan],
    ["docs", docs],
    ["progress", progress],
  ] as Array<[string, PlanSummary | DocsSummary | ProgressSummary]>) {
    if (!summary.exists && summary.absence_reason) absence[name] = summary.absence_reason;
  }
  const anyActive = Object.values(active).some(Boolean);
  return {
    active,
    available,
    any_active: anyActive,
    absence_explained: Object.keys(absence).length > 0 || anyActive,
    absence,
  };
}

// ── decisions follow-up + attention ─────────────────────────────────

export function decisionFollowUp(schemas: Record<string, SchemaInfo>): DecisionFollowUp | null {
  for (const entry of startupDecisionEntries(schemas)) {
    const satisfaction = entry.satisfaction;
    if (!satisfaction || typeof satisfaction !== "object" || Array.isArray(satisfaction) || !satisfaction.review_needed)
      continue;
    const number = typeof entry.number === "string" || typeof entry.number === "number" ? entry.number : "?";
    const title = firstPresent(entry, ["question", "choice"], "decision follow-up");
    return { object: `DECISION ${number} follow-up`, title: String(title) };
  }
  return null;
}

export function startupDecisionEntries(schemas: Record<string, SchemaInfo>): JsonObject[] {
  if (!schemas.decisions) return [];
  const scans = scanSchemaArtifact(schemas, "decisions");
  return [...scans.active.entries, ...scans.archive.entries].map((candidate) => ({
    ...candidate.fields,
    ...(candidate.identity.number !== null && candidate.fields.number === undefined ? { number: candidate.identity.number } : {}),
  }));
}

function decisionAttentionState(satisfaction: JsonObject): string {
  const state = satisfaction.state;
  if (state === null || state === undefined || state === "") return "missing";
  if (state === "user_confirmed_satisfied" && satisfaction.review_needed) return "unconfirmed_user_confirmed_satisfied";
  if (["open", "provisionally_satisfied", "review_needed"].includes(String(state))) return String(state);
  if (state === "user_confirmed_satisfied") return "user_confirmed_satisfied";
  return "unrecognized";
}

export function decisionReviewAttention(schemas: Record<string, SchemaInfo>): DecisionReviewAttention | null {
  const reviewEntries: DecisionReviewEntry[] = [];
  const stateCounts: Record<string, number> = {};
  for (const entry of startupDecisionEntries(schemas)) {
    const satisfaction = entry.satisfaction;
    if (!satisfaction || typeof satisfaction !== "object" || Array.isArray(satisfaction) || !satisfaction.review_needed)
      continue;
    const state = decisionAttentionState(satisfaction);
    stateCounts[state] = (stateCounts[state] ?? 0) + 1;
    reviewEntries.push({
      number: typeof entry.number === "string" || typeof entry.number === "number" ? entry.number : "?",
      title: truncate(firstPresent(entry, ["question", "choice", "summary"], "decision review"), 80),
      state,
      source: satisfaction.source ?? null,
    });
  }
  if (reviewEntries.length === 0) return null;
  const boundedEntries = reviewEntries.slice(0, DECISION_ATTENTION_MAX_ENTRIES);
  const stateText = Object.keys(stateCounts)
    .sort()
    .map((name) => `${name}=${stateCounts[name]}`)
    .join(", ");
  const refs = boundedEntries.map((entry) => `Decision ${entry.number}: ${entry.title}`).join("; ");
  const more = reviewEntries.length - boundedEntries.length;
  const suffix = more > 0 ? `; +${more} more` : "";
  return {
    type: "decision_satisfaction_review",
    count: reviewEntries.length,
    states: stateCounts,
    entries: boundedEntries,
    max_entries: DECISION_ATTENTION_MAX_ENTRIES,
    bounded: true,
    attention: `normal: decisions need satisfaction review (${reviewEntries.length}; ${stateText}); ${refs}${suffix}`,
  };
}

export function formatNextAction(action: NextAction | Record<string, string> | null): string {
  if (!action) return "object=VISION refresh | capability=vision | reason=no executable follow-up | phase=envision";
  const phase = "phase" in action && action.phase ? ` | phase=${action.phase}` : "";
  return `object=${truncate(action.object)} | capability=${action.capability} | reason=${action.reason}${phase}`;
}

/**
 * Evolved state-readiness hint (Decision 76). Evaluates every cascade branch
 * (no early-return); each candidate carries a protocol.yaml phase tag (PH1
 * envision → PH5 audit). Position 1 (`recommended`) is the branch that would
 * have won under the legacy early-return cascade.
 */
export function selectStatusReadiness(
  plan: PlanSummary,
  health: HealthSummary,
  objective: ObjectiveSummary,
  todoItems: Array<Record<string, string>>,
  decision: DecisionFollowUp | null,
  savedContext: boolean,
): ReadinessHint {
  const candidates: NextAction[] = [];

  const pending = plan.first_pending;
  if (pending && typeof pending === "object" && !Array.isArray(pending)) {
    const number = pending.number ?? "?";
    const title = firstPresent(pending, ["name", "title"], "pending task");
    candidates.push({
      object: `PLAN Task ${number}: ${title}`,
      capability: "orchestrate",
      reason: "first pending plan task",
      phase: "build",
    });
  }
  if (health.degrading) {
    const worst = health.worst;
    const target = worst ? `${worst[0]}:${worst[1]}` : "degrading health";
    candidates.push({
      object: `HEALTH: ${target}`,
      capability: "audit",
      reason: "critical or degrading health",
      phase: "audit",
    });
  }
  if (objective.active) {
    candidates.push({
      object: `OBJECTIVE: ${objective.metric || objective.title}`,
      capability: "optimize",
      reason: "active non-closed objective",
      phase: "build",
    });
  }
  if (todoItems.length > 0) {
    const item = [...todoItems].sort(
      (a, b) => (TODO_SEVERITY_ORDER[a.severity] ?? 2) - (TODO_SEVERITY_ORDER[b.severity] ?? 2),
    )[0];
    if (todoNeedsPlan(item)) {
      candidates.push({ object: `TODO: ${item.text}`, capability: "plan", reason: "complex TODO needs planning", phase: "plan" });
    } else {
      candidates.push({ object: `TODO: ${item.text}`, capability: "build", reason: "highest-priority open TODO", phase: "build" });
    }
  }
  if (health.stale && !health.degrading) {
    candidates.push({
      object: `HEALTH: Audit ${health.number ?? "?"} stale`,
      capability: "audit",
      reason: "stale health audit",
      phase: "audit",
    });
  }
  if (decision) {
    candidates.push({
      object: String(decision.object),
      capability: "discuss",
      reason: "unresolved decision follow-up",
      phase: "deliberate",
    });
  }
  const visionExists = fs.existsSync(path.join(process.cwd(), ".agentera", "vision.yaml"));
  if ((plan.exists && !plan.complete_plan) || visionExists) {
    candidates.push({ object: "VISION refresh", capability: "plan", reason: "no executable follow-up", phase: "envision" });
  }
  if (savedContext && !visionExists) {
    candidates.push({ object: "Direction clarification", capability: "discuss", reason: "saved context without vision", phase: "envision" });
  }
  candidates.push({ object: "VISION refresh", capability: "vision", reason: "fresh project direction", phase: "envision" });
  // Guarantee at least one alternative so the hint never collapses to a single entry.
  if (candidates.length < 2) {
    candidates.push({ object: "Direction clarification", capability: "discuss", reason: "clarify project direction", phase: "envision" });
  }

  const [recommended, ...alternatives] = candidates;
  return { recommended, alternatives };
}

/** Legacy single-entry projection of {@link selectStatusReadiness}: the
 *  top-priority candidate as `{object, capability, reason}` (no `phase`). */
export function selectStatusNextAction(
  plan: PlanSummary,
  health: HealthSummary,
  objective: ObjectiveSummary,
  todoItems: Array<Record<string, string>>,
  decision: DecisionFollowUp | null,
  savedContext: boolean,
): Record<string, string> {
  const { recommended } = selectStatusReadiness(plan, health, objective, todoItems, decision, savedContext);
  return { object: recommended.object, capability: recommended.capability, reason: recommended.reason };
}
