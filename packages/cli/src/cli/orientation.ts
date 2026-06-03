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
  progressEntriesForOutput,
  recentCycles,
  truncate,
} from "./stateQuery.js";
import { decisionContextEntry, latestHealthAudit, normalizeSeverity } from "./commands/state.js";
import { isResolvedTodoMarkdownStatus, parseTodoMarkdownListItem } from "./todoMarkdown.js";

/**
 * Orientation summaries layer for prime/hej. Faithful port of the
 * scripts/agentera `_*_summary`, `_load_todo_items`, `_issue_counts`,
 * `_decision_*`, `_select_hej_next_action`, and staleness helpers.
 */

type Dict = Record<string, any>;

export const DONE_STATUSES = new Set(["complete", "completed", "closed", "done", "resolved", "retired"]);
export const BLOCKED_STATUSES = new Set(["blocked", "stuck"]);
export const DECISION_ATTENTION_MAX_ENTRIES = 3;
export const STARTUP_COMPLETENESS_MISSING_STATE: string[] = [];

const TODO_SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  degraded: 1,
  warning: 1,
  normal: 2,
  info: 3,
  annoying: 3,
};
const TODO_SECTION_SEVERITIES: Record<string, string> = {
  critical: "critical",
  degraded: "degraded",
  warning: "warning",
  normal: "normal",
  info: "info",
  annoying: "annoying",
};
const TODO_PLANERA_SIGNALS = new Set([
  "acceptance", "artifact", "capability", "capability-context", "compatibility", "contract",
  "cross-capability", "docs", "metadata", "migration", "schema", "startup", "surface", "test", "validation",
]);

const PROFILERA_STALE_DAYS_ENV = "AGENTERA_PROFILERA_MAX_AGE_DAYS";
const DEFAULT_PROFILERA_STALE_DAYS = 7;
const INSPEKTERA_STALE_DAYS_ENV = "AGENTERA_INSPEKTERA_MAX_AGE_DAYS";
const DEFAULT_INSPEKTERA_STALE_DAYS = 30;
const INSPEKTERA_STALE_CYCLES_ENV = "AGENTERA_INSPEKTERA_MAX_CYCLES";
const DEFAULT_INSPEKTERA_STALE_CYCLES = 10;

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

function entryStatusPy(entry: Dict, def = "open"): string {
  const raw = "status" in entry ? entry.status : def;
  return String(raw || def).toLowerCase();
}

function isOpenEntry(entry: Dict): boolean {
  return !DONE_STATUSES.has(entryStatusPy(entry));
}

export function loadNamedArtifact(schemas: Record<string, SchemaInfo>, name: string): unknown {
  const info = schemas[name];
  if (!info) return null;
  return loadArtifact(artifactPath(info, name));
}

export function registryArtifactPath(artifactId: string, schemasDir: string): string {
  const record = loadRegistryForSchemas(schemasDir).get(artifactId);
  if (record === undefined) throw new Error(`artifact registry does not define '${artifactId}'`);
  return resolveArtifactPath(record as ArtifactRecord, process.cwd(), activeObjectiveName());
}

// ── staleness ───────────────────────────────────────────────────────

export function checkProfileraStaleness(profilePath: string, env: Env = process.env): [boolean, number, number] | null {
  if (!fs.existsSync(profilePath)) return null;
  let text: string;
  try {
    text = fs.readFileSync(profilePath, "utf8");
  } catch (exc) {
    process.stderr.write(`warning: failed to read profile path ${profilePath}: ${(exc as Error).message}\n`);
    return null;
  }
  const m = /<!-- Generated:\s*(\d{4}-\d{2}-\d{2})/.exec(text);
  if (!m) return null;
  const gen = dateFromIso(m[1]);
  if (gen === null) return null;
  const staleDays = intEnv(env, PROFILERA_STALE_DAYS_ENV, DEFAULT_PROFILERA_STALE_DAYS);
  const since = daysSince(gen);
  return [since >= staleDays, since, staleDays];
}

export function healthAuditDate(entry: Dict): number | null {
  for (const key of ["date", "timestamp"]) {
    const value = entry[key];
    if (typeof value === "string" && value.trim()) {
      const d = dateFromIso(value.trim().slice(0, 10));
      if (d !== null) return d;
    }
  }
  return null;
}

function progressEntryDate(entry: Dict): number | null {
  for (const key of ["timestamp", "date"]) {
    const value = entry[key];
    if (typeof value === "string" && value.trim()) {
      const d = dateFromIso(value.trim().slice(0, 10));
      if (d !== null) return d;
    }
  }
  return null;
}

function cyclesSinceHealthAudit(schemas: Record<string, SchemaInfo>, auditDate: number): number | null {
  const entries = extractEntries(loadNamedArtifact(schemas, "progress"));
  if (entries.length === 0) return null;
  let count = 0;
  for (const entry of entries) {
    const d = progressEntryDate(entry);
    if (d !== null && d > auditDate) count += 1;
  }
  return count;
}

function checkInspekteraAuditStaleness(
  schemas: Record<string, SchemaInfo>,
  latest: Dict | null,
  auditDate: number | null,
  env: Env = process.env,
): Dict | null {
  if (latest === null || auditDate === null) return null;
  const staleDaysThreshold = intEnv(env, INSPEKTERA_STALE_DAYS_ENV, DEFAULT_INSPEKTERA_STALE_DAYS);
  const staleCyclesThreshold = intEnv(env, INSPEKTERA_STALE_CYCLES_ENV, DEFAULT_INSPEKTERA_STALE_CYCLES);
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
  const result: Dict = {
    stale: isStale,
    days_since_audit: since,
    stale_threshold_days: staleDaysThreshold,
    stale_threshold_cycles: staleCyclesThreshold,
    triggering_axis: triggeringAxis,
  };
  if (cyclesSince !== null) result.cycles_since_audit = cyclesSince;
  if (isStale) result.suggested_action = "Run inspektera to refresh health audit";
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

export function issueCounts(todoItems: Array<Record<string, string>>): Record<string, number> {
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

function todoNeedsPlanera(item: Record<string, string>): boolean {
  const text = item.text.toLowerCase();
  let signalCount = 0;
  for (const signal of TODO_PLANERA_SIGNALS) if (text.includes(signal)) signalCount += 1;
  return signalCount >= 2 || (signalCount >= 1 && text.length > 180);
}

// ── per-artifact summaries ──────────────────────────────────────────

export function planSummary(schemas: Record<string, SchemaInfo>): Dict {
  const data = loadNamedArtifact(schemas, "plan");
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return {
      exists: false,
      active: false,
      tasks: [],
      status: "absent",
      title: "",
      absence_reason: "No active plan artifact is available from agentera plan.",
    };
  }
  const d = data as Dict;
  const legacyEntries = asList(d.entries);
  let tasks: Dict[];
  let status: string;
  let title: string;
  if (legacyEntries.length > 0) {
    tasks = legacyEntries;
    status = entryStatusPy(tasks[0], "");
    title = String(firstPresent(tasks[0], ["title", "name"], ""));
  } else {
    const header = d.header && typeof d.header === "object" && !Array.isArray(d.header) ? d.header : {};
    tasks = asList(d.tasks);
    status = String(firstPresent(header, ["status"], d.status ?? "") || "");
    title = String(firstPresent(header, ["title"], d.title ?? "") || "");
  }
  const complete = tasks.filter((task) => DONE_STATUSES.has(entryStatusPy(task, ""))).length;
  const total = tasks.length;
  const completePlan = DONE_STATUSES.has(status.toLowerCase()) && complete === total;
  let firstPending: Dict | null = null;
  if (!completePlan) {
    for (const task of tasks) {
      const ts = entryStatusPy(task, "pending");
      if (DONE_STATUSES.has(ts) || BLOCKED_STATUSES.has(ts)) continue;
      firstPending = task;
      break;
    }
  }
  return {
    exists: true,
    status,
    title,
    constraints: d.constraints ?? null,
    scope: d.scope ?? null,
    design: d.design ?? null,
    tasks,
    complete,
    total,
    active: !completePlan,
    complete_plan: completePlan,
    first_pending: firstPending,
  };
}

export function docsSummary(schemas: Record<string, SchemaInfo>): Dict {
  const data = loadNamedArtifact(schemas, "docs");
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { exists: false, status: "absent", absence_reason: "No docs mapping artifact is available from agentera docs." };
  }
  const d = data as Dict;
  const mapping = asList(d.mapping);
  const index = asList(d.index);
  const coverage = d.coverage && typeof d.coverage === "object" && !Array.isArray(d.coverage) ? d.coverage : {};
  const conventions = d.conventions && typeof d.conventions === "object" && !Array.isArray(d.conventions) ? d.conventions : {};
  return {
    exists: true,
    status: "available",
    last_audit: d.last_audit ?? null,
    conventions,
    mapping,
    mapping_entries: mapping.length,
    coverage,
    source_contract: {
      capability_startup_complete: STARTUP_COMPLETENESS_MISSING_STATE.length === 0,
      raw_artifact_reads_required: false,
      state_families: [
        "plan task details, dependencies, acceptance criteria, and evidence summaries",
        "docs artifact mapping and source-contract completeness metadata",
        "latest progress verification metadata needed for Orkestrera evaluation",
        "Dokumentera closeout context metadata for docs/TODO/changelog/progress synchronization",
      ],
    },
    indexed_documents: index.length,
  };
}

export function progressSummary(schemas: Record<string, SchemaInfo>): Dict {
  const data = loadNamedArtifact(schemas, "progress");
  const entries = extractEntries(data);
  if (entries.length === 0) {
    return { exists: false, status: "absent", absence_reason: "No progress cycles are available from agentera progress." };
  }
  const latest = progressEntriesForOutput(recentCycles(entries, 1))[0];
  return {
    exists: true,
    status: "available",
    latest,
    latest_verification: latest.verified ?? null,
    cycle_count: entries.length,
  };
}

export function healthSummary(schemas: Record<string, SchemaInfo>, env: Env = process.env): Dict {
  const data = loadNamedArtifact(schemas, "health");
  const entries = extractEntries(data);
  if (entries.length === 0) return { exists: false };
  const latest = latestHealthAudit(entries);
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
  const summary: Dict = {
    exists: true,
    number: latest.number ?? "?",
    date: dateStr,
    timestamp: dateStr ?? latest.timestamp ?? null,
    trajectory,
    grade: worst ? worst[1] : "",
    worst,
    degrading:
      ["degrading", "declining", "worse"].includes(trajectory.toLowerCase()) ||
      (worst !== null && worst[2] >= gradeRank.D),
  };
  const staleness = checkInspekteraAuditStaleness(schemas, latest, auditDate, env);
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

function objectiveStatus(data: Dict): string {
  const header = data.header && typeof data.header === "object" && !Array.isArray(data.header) ? data.header : {};
  const objective = data.objective && typeof data.objective === "object" && !Array.isArray(data.objective) ? data.objective : {};
  return String(
    firstPresent(header, ["status"], data.status ?? objective.status ?? "") || "",
  ).toLowerCase();
}

export function activeObjectiveSummary(): Dict {
  const root = path.join(process.cwd(), ".agentera", "optimera");
  let isDir = false;
  try {
    isDir = fs.statSync(root).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) return { exists: false };
  const candidates: Array<[string, Dict, string]> = [];
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
    const status = objectiveStatus(data as Dict);
    if (DONE_STATUSES.has(status)) {
      closedCount += 1;
      continue;
    }
    candidates.push([candidate, data as Dict, status]);
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

export function statePresence(plan: Dict, docs: Dict, progress: Dict, health: Dict, objective: Dict): Dict {
  const active = { plan: Boolean(plan.active), objective: Boolean(objective.active) };
  const available = {
    plan: Boolean(plan.exists),
    docs: Boolean(docs.exists),
    progress: Boolean(progress.exists),
    health: Boolean(health.exists),
    objective: Boolean(objective.exists),
  };
  const absence: Record<string, any> = {};
  for (const [name, summary] of [["plan", plan], ["docs", docs], ["progress", progress]] as Array<[string, Dict]>) {
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

export function decisionFollowUp(schemas: Record<string, SchemaInfo>): Dict | null {
  const data = loadNamedArtifact(schemas, "decisions");
  for (const rawEntry of extractEntries(data)) {
    const entry = decisionContextEntry(rawEntry);
    const satisfaction = entry.satisfaction;
    if (!satisfaction || typeof satisfaction !== "object" || !satisfaction.review_needed) continue;
    const number = entry.number ?? "?";
    const title = firstPresent(entry, ["question", "choice"], "decision follow-up");
    return { object: `DECISION ${number} follow-up`, title };
  }
  return null;
}

function decisionAttentionState(satisfaction: Dict): string {
  const state = satisfaction.state;
  if (state === null || state === undefined || state === "") return "missing";
  if (state === "user_confirmed_satisfied" && satisfaction.review_needed) return "unconfirmed_user_confirmed_satisfied";
  if (["open", "provisionally_satisfied", "review_needed"].includes(state)) return String(state);
  if (state === "user_confirmed_satisfied") return "user_confirmed_satisfied";
  return "unrecognized";
}

export function decisionReviewAttention(schemas: Record<string, SchemaInfo>): Dict | null {
  const data = loadNamedArtifact(schemas, "decisions");
  const reviewEntries: Dict[] = [];
  const stateCounts: Record<string, number> = {};
  for (const rawEntry of extractEntries(data)) {
    const entry = decisionContextEntry(rawEntry);
    const satisfaction = entry.satisfaction;
    if (!satisfaction || typeof satisfaction !== "object" || !satisfaction.review_needed) continue;
    const state = decisionAttentionState(satisfaction);
    stateCounts[state] = (stateCounts[state] ?? 0) + 1;
    reviewEntries.push({
      number: entry.number ?? "?",
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

export function formatNextAction(action: Record<string, string> | null): string {
  if (!action) return "object=VISION refresh | capability=visionera | reason=no executable follow-up";
  return `object=${truncate(action.object)} | capability=${action.capability} | reason=${action.reason}`;
}

export function selectHejNextAction(
  plan: Dict,
  health: Dict,
  objective: Dict,
  todoItems: Array<Record<string, string>>,
  decision: Dict | null,
  savedContext: boolean,
): Record<string, string> {
  const pending = plan.first_pending;
  if (pending && typeof pending === "object" && !Array.isArray(pending)) {
    const number = pending.number ?? "?";
    const title = firstPresent(pending, ["name", "title"], "pending task");
    return { object: `PLAN Task ${number}: ${title}`, capability: "orkestrera", reason: "first pending plan task" };
  }
  if (health.degrading) {
    const worst = health.worst;
    const target = worst ? `${worst[0]}:${worst[1]}` : "degrading health";
    return { object: `HEALTH: ${target}`, capability: "inspektera", reason: "critical or degrading health" };
  }
  if (objective.active) {
    return {
      object: `OBJECTIVE: ${objective.metric || objective.title}`,
      capability: "optimera",
      reason: "active non-closed objective",
    };
  }
  if (todoItems.length > 0) {
    const item = [...todoItems].sort(
      (a, b) => (TODO_SEVERITY_ORDER[a.severity] ?? 2) - (TODO_SEVERITY_ORDER[b.severity] ?? 2),
    )[0];
    if (todoNeedsPlanera(item)) {
      return { object: `TODO: ${item.text}`, capability: "planera", reason: "complex TODO needs planning" };
    }
    return { object: `TODO: ${item.text}`, capability: "realisera", reason: "highest-priority open TODO" };
  }
  if (health.stale && !health.degrading) {
    return {
      object: `HEALTH: Audit ${health.number ?? "?"} stale`,
      capability: "inspektera",
      reason: "stale health audit",
    };
  }
  if (decision) {
    return { object: String(decision.object), capability: "resonera", reason: "unresolved decision follow-up" };
  }
  const visionExists = fs.existsSync(path.join(process.cwd(), ".agentera", "vision.yaml"));
  if (plan.exists && !plan.complete_plan) {
    return { object: "VISION refresh", capability: "planera", reason: "no executable follow-up" };
  }
  if (visionExists) {
    return { object: "VISION refresh", capability: "planera", reason: "no executable follow-up" };
  }
  if (savedContext) {
    return { object: "Direction clarification", capability: "resonera", reason: "saved context without vision" };
  }
  return { object: "VISION refresh", capability: "visionera", reason: "fresh project direction" };
}
