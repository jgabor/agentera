import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Suite usage analytics: detect skill invocations from a Section 22 corpus.
 * Faithful TS port of scripts/usage_stats.py. env/home/platform are injectable.
 */

type Dict = Record<string, any>;
type Env = Record<string, string | undefined>;

export const EXIT_STATUSES = new Set(["complete", "flagged", "stuck", "waiting"]);
export const TRIGGER_SLASH = "slash";
export const TRIGGER_NATURAL = "natural";

const MARKER_RE =
  /─{2,}\s+(\S)\s+([a-z]+era)\s+·\s+([a-z]+(?:\s+\d+)?)\s+─{2,}/g;

export interface Marker {
  kind: string;
  skill: string;
  glyph: string;
  word: string;
  line: string;
}

export interface Invocation {
  skill: string;
  glyph: string;
  intro_word: string;
  intro_source_id: string;
  intro_timestamp: string;
  completed: boolean;
  exit_status: string | null;
  exit_source_id: string | null;
  exit_timestamp: string | null;
  trigger: string;
  project_id: string;
}

function newInvocation(init: Partial<Invocation> & { skill: string; glyph: string }): Invocation {
  return {
    skill: init.skill,
    glyph: init.glyph,
    intro_word: init.intro_word ?? "",
    intro_source_id: init.intro_source_id ?? "",
    intro_timestamp: init.intro_timestamp ?? "",
    completed: init.completed ?? false,
    exit_status: init.exit_status ?? null,
    exit_source_id: init.exit_source_id ?? null,
    exit_timestamp: init.exit_timestamp ?? null,
    trigger: init.trigger ?? TRIGGER_NATURAL,
    project_id: init.project_id ?? "",
  };
}

export function findMarkers(text: string): Marker[] {
  if (!text) {
    return [];
  }
  const markers: Marker[] = [];
  MARKER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MARKER_RE.exec(text)) !== null) {
    const word = match[3];
    const kind = EXIT_STATUSES.has(word) ? "exit" : "intro";
    markers.push({ kind, skill: match[2], glyph: match[1], word, line: match[0] });
  }
  return markers;
}

function isMapping(value: unknown): value is Dict {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isAssistantConversationTurn(record: unknown): boolean {
  if (!isMapping(record)) return false;
  if (record.source_kind !== "conversation_turn") return false;
  const data = record.data;
  if (!isMapping(data)) return false;
  return data.actor === "assistant";
}

function conversationKey(record: Dict): string | null {
  const sid = record.session_id;
  if (typeof sid === "string" && sid) return sid;
  const data = record.data;
  if (isMapping(data)) {
    const dsid = data.session_id;
    if (typeof dsid === "string" && dsid) return dsid;
  }
  const ssid = record.source_id;
  if (typeof ssid === "string" && ssid) return ssid;
  return null;
}

export function groupByConversation(records: Iterable<Dict>): Map<string, Dict[]> {
  const buckets = new Map<string, Dict[]>();
  for (const record of records) {
    if (!isAssistantConversationTurn(record)) continue;
    const key = conversationKey(record);
    if (key === null) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(record);
  }
  for (const items of buckets.values()) {
    stableSortByTimestamp(items);
  }
  return buckets;
}

function stableSortByTimestamp(items: Dict[]): void {
  items
    .map((item, index) => [item, index] as [Dict, number])
    .sort((a, b) => {
      const ta = String(a[0].timestamp ?? "");
      const tb = String(b[0].timestamp ?? "");
      if (ta < tb) return -1;
      if (ta > tb) return 1;
      return a[1] - b[1];
    })
    .forEach(([item], i) => {
      items[i] = item;
    });
}

export function pairInvocations(turns: Iterable<Dict>): Invocation[] {
  const pending = new Map<string, Invocation[]>();
  const completed: Invocation[] = [];
  for (const turn of turns) {
    const sid = String(turn.source_id ?? "");
    const ts = String(turn.timestamp ?? "");
    const text = (isMapping(turn.data) ? turn.data.content : "") || "";
    for (const marker of findMarkers(text)) {
      if (marker.kind === "intro") {
        if (!pending.has(marker.skill)) pending.set(marker.skill, []);
        pending.get(marker.skill)!.push(
          newInvocation({
            skill: marker.skill,
            glyph: marker.glyph,
            intro_word: marker.word,
            intro_source_id: sid,
            intro_timestamp: ts,
            completed: false,
          }),
        );
      } else {
        const queue = pending.get(marker.skill);
        if (!queue || queue.length === 0) continue;
        const inv = queue.pop()!;
        inv.completed = true;
        inv.exit_status = marker.word;
        inv.exit_source_id = sid;
        inv.exit_timestamp = ts;
        completed.push(inv);
      }
    }
  }
  const incomplete: Invocation[] = [];
  for (const queue of pending.values()) {
    incomplete.push(...queue);
  }
  return stableSort(completed.concat(incomplete), (inv) => [inv.intro_timestamp, inv.intro_source_id]);
}

function stableSort<T>(items: T[], key: (item: T) => Array<string | number>): T[] {
  return items
    .map((item, index) => [item, index] as [T, number])
    .sort((a, b) => {
      const ka = key(a[0]);
      const kb = key(b[0]);
      for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
        if (ka[i] < kb[i]) return -1;
        if (ka[i] > kb[i]) return 1;
      }
      return a[1] - b[1];
    })
    .map(([item]) => item);
}

const CLAUDE_CODE_XML_RE = /<command-name>\s*\/[A-Za-z0-9._:-]+\s*<\/command-name>/;
const BARE_SLASH_RE = /^\s*\/[A-Za-z0-9._:-]+(?:\s|$)/m;

export function classifyTrigger(userTurnText: string | null): string {
  if (!userTurnText) return TRIGGER_NATURAL;
  if (CLAUDE_CODE_XML_RE.test(userTurnText)) return TRIGGER_SLASH;
  if (BARE_SLASH_RE.test(userTurnText)) return TRIGGER_SLASH;
  return TRIGGER_NATURAL;
}

function projectMatch(recordProjectId: string, requested: string): boolean {
  if (!recordProjectId || !requested) return false;
  return recordProjectId.includes(requested) || requested.includes(recordProjectId);
}

export function filterRecordsByProject(records: Iterable<Dict>, requested: string | null): Dict[] {
  if (requested === null) {
    return [...records];
  }
  const out: Dict[] = [];
  for (const record of records) {
    if (!isMapping(record)) continue;
    const pid = record.project_id ?? "";
    if (typeof pid === "string" && projectMatch(pid, requested)) {
      out.push(record);
    }
  }
  return out;
}

function userTurnsByConversation(records: Iterable<Dict>): Map<string, Dict[]> {
  const buckets = new Map<string, Dict[]>();
  for (const record of records) {
    if (!isMapping(record)) continue;
    if (record.source_kind !== "conversation_turn") continue;
    const data = record.data;
    if (!isMapping(data)) continue;
    if (data.actor !== "user") continue;
    const key = conversationKey(record);
    if (key === null) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(record);
  }
  for (const items of buckets.values()) {
    stableSortByTimestamp(items);
  }
  return buckets;
}

function precedingUserTurn(userTurns: Dict[], assistantTimestamp: string): Dict | null {
  let candidate: Dict | null = null;
  for (const turn of userTurns) {
    const ts = String(turn.timestamp ?? "");
    if (ts < assistantTimestamp) {
      candidate = turn;
    } else {
      break;
    }
  }
  return candidate;
}

export interface CorpusAnalysis {
  invocations: Invocation[];
  skills: Record<string, Record<string, number>>;
  project_filter: string | null;
  per_project: Record<string, Record<string, Record<string, number>>>;
}

function emptySkillBucket(): Record<string, number> {
  return { total: 0, completed: 0, incomplete: 0, trigger_slash: 0, trigger_natural: 0 };
}

function accumulate(bucket: Record<string, number>, inv: Invocation): void {
  bucket.total += 1;
  bucket[inv.completed ? "completed" : "incomplete"] += 1;
  bucket[inv.trigger === TRIGGER_SLASH ? "trigger_slash" : "trigger_natural"] += 1;
}

export function analyzeCorpus(corpus: Dict, projectFilter: string | null = null): CorpusAnalysis {
  const rawRecords = isMapping(corpus) ? (corpus.records ?? []) : [];
  const records = filterRecordsByProject(rawRecords, projectFilter);

  const userTurnsByConv = userTurnsByConversation(records);
  const grouped = groupByConversation(records);
  const invocations: Invocation[] = [];
  for (const [sid, turns] of grouped) {
    const tsToProject = new Map<string, string>();
    for (const t of turns) {
      tsToProject.set(String(t.timestamp ?? ""), String(t.project_id ?? ""));
    }
    for (const inv of pairInvocations(turns)) {
      inv.project_id = tsToProject.get(inv.intro_timestamp) ?? "";
      const preceding = precedingUserTurn(userTurnsByConv.get(sid) ?? [], inv.intro_timestamp);
      let precedingText = "";
      if (preceding !== null) {
        const data = isMapping(preceding.data) ? preceding.data : {};
        precedingText = data.content || "";
      }
      inv.trigger = classifyTrigger(precedingText);
      invocations.push(inv);
    }
  }

  const sorted = stableSort(invocations, (inv) => [inv.intro_timestamp, inv.intro_source_id, inv.skill]);

  const skills: Record<string, Record<string, number>> = {};
  const perProject: Record<string, Record<string, Record<string, number>>> = {};
  for (const inv of sorted) {
    if (!(inv.skill in skills)) skills[inv.skill] = emptySkillBucket();
    accumulate(skills[inv.skill], inv);
    if (projectFilter === null && inv.project_id) {
      if (!(inv.project_id in perProject)) perProject[inv.project_id] = {};
      if (!(inv.skill in perProject[inv.project_id])) perProject[inv.project_id][inv.skill] = emptySkillBucket();
      accumulate(perProject[inv.project_id][inv.skill], inv);
    }
  }

  return { invocations: sorted, skills, project_filter: projectFilter, per_project: perProject };
}

// --- Paths -----------------------------------------------------------------

export const CORPUS_GUIDANCE =
  "Run uv run scripts/extract_corpus.py to build the default corpus. " +
  "Provide --corpus <path> to an existing corpus.json.";

function homeDir(env: Env): string {
  return env.HOME ?? os.homedir();
}

export function defaultUsageDir(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  const override = env.AGENTERA_USAGE_DIR;
  if (override) return override;
  const profileraOverride = env.PROFILERA_PROFILE_DIR;
  if (profileraOverride) return profileraOverride;
  const home = homeDir(env);
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "agentera");
  if (platform === "win32") {
    const appdata = env.APPDATA ?? path.join(home, "AppData", "Roaming");
    return path.join(appdata, "agentera");
  }
  const xdg = env.XDG_DATA_HOME ?? path.join(home, ".local", "share");
  return path.join(xdg, "agentera");
}

export function defaultCorpusPath(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  const profileraOverride = env.PROFILERA_PROFILE_DIR;
  if (profileraOverride) return path.join(profileraOverride, "intermediate", "corpus.json");
  const home = homeDir(env);
  let base: string;
  if (platform === "darwin") {
    base = path.join(home, "Library", "Application Support", "agentera");
  } else if (platform === "win32") {
    const appdata = env.APPDATA ?? path.join(home, "AppData", "Roaming");
    base = path.join(appdata, "agentera");
  } else {
    const xdg = env.XDG_DATA_HOME ?? path.join(home, ".local", "share");
    base = path.join(xdg, "agentera");
  }
  return path.join(base, "intermediate", "corpus.json");
}

export class CorpusUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorpusUnavailable";
  }
}

export function loadCorpusOrRaise(corpusPath: string): Dict {
  if (!fs.existsSync(corpusPath)) {
    throw new CorpusUnavailable(`corpus.json not found at ${corpusPath}. ${CORPUS_GUIDANCE}`);
  }
  const corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
  const records = isMapping(corpus) ? (corpus.records ?? []) : [];
  const hasTurn = Array.isArray(records) && records.some(
    (r: unknown) => isMapping(r) && r.source_kind === "conversation_turn",
  );
  if (!hasTurn) {
    throw new CorpusUnavailable(
      `corpus at ${corpusPath} contains no conversation_turn records. ${CORPUS_GUIDANCE}`,
    );
  }
  return corpus;
}

export function buildJsonPayload(
  analysis: CorpusAnalysis,
  opts: { generatedAt: string; extractedAt: string | null },
): Dict {
  return {
    generated_at: opts.generatedAt,
    extracted_at: opts.extractedAt,
    project_filter: analysis.project_filter,
    skills: analysis.skills,
    per_project: analysis.per_project,
    invocations: analysis.invocations.map((inv) => ({ ...inv })),
  };
}

export function renderJson(
  analysis: CorpusAnalysis,
  opts: { generatedAt: string; extractedAt: string | null },
): string {
  return JSON.stringify(buildJsonPayload(analysis, opts), null, 2);
}

function exitStatusCounts(analysis: CorpusAnalysis, skill: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const status of [...EXIT_STATUSES].sort()) counts[status] = 0;
  for (const inv of analysis.invocations) {
    if (inv.skill !== skill || !inv.completed || inv.exit_status === null) continue;
    counts[inv.exit_status] = (counts[inv.exit_status] ?? 0) + 1;
  }
  return counts;
}

function lastSeen(analysis: CorpusAnalysis, skill: string): string {
  const timestamps = analysis.invocations
    .filter((inv) => inv.skill === skill)
    .map((inv) => inv.intro_timestamp);
  return timestamps.length ? timestamps.reduce((a, b) => (a > b ? a : b)) : "-";
}

export function renderMarkdown(
  analysis: CorpusAnalysis,
  opts: { generatedAt: string; extractedAt: string | null },
): string {
  const scope = analysis.project_filter || "all projects";
  const extractedLine = opts.extractedAt || "unknown (corpus omitted extracted_at)";

  const lines: string[] = [];
  lines.push("# Suite Usage", "", `- Generated: ${opts.generatedAt}`, `- Corpus extracted: ${extractedLine}`, `- Scope: ${scope}`, "");

  if (Object.keys(analysis.skills).length === 0) {
    lines.push("No skill invocations found in the corpus for this scope.", "");
    return lines.join("\n");
  }

  const totalInvocations = Object.values(analysis.skills).reduce((s, b) => s + b.total, 0);
  const totalCompleted = Object.values(analysis.skills).reduce((s, b) => s + b.completed, 0);
  lines.push(
    `- Skills observed: ${Object.keys(analysis.skills).length} · ` +
      `Invocations: ${totalInvocations} · Completed: ${totalCompleted}`,
    "",
  );

  const statuses = [...EXIT_STATUSES].sort();
  const headerCols = [
    "Skill",
    "Invocations",
    ...statuses.map((s) => s.charAt(0).toUpperCase() + s.slice(1)),
    "Incomplete",
    "Slash",
    "Natural",
    "Last seen",
  ];
  lines.push("| " + headerCols.join(" | ") + " |");
  lines.push("| " + headerCols.map(() => "---").join(" | ") + " |");

  const skillOrder = Object.entries(analysis.skills).sort((a, b) => {
    if (b[1].total !== a[1].total) return b[1].total - a[1].total;
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
  for (const [skill, bucket] of skillOrder) {
    const statusCounts = exitStatusCounts(analysis, skill);
    const row = [
      skill,
      String(bucket.total),
      ...statuses.map((s) => String(statusCounts[s])),
      String(bucket.incomplete),
      String(bucket.trigger_slash),
      String(bucket.trigger_natural),
      lastSeen(analysis, skill),
    ];
    lines.push("| " + row.join(" | ") + " |");
  }

  if (analysis.project_filter === null && Object.keys(analysis.per_project).length > 0) {
    lines.push("", "## Per-project totals", "", "| Project | Skill | Invocations | Completed | Incomplete |", "| --- | --- | --- | --- | --- |");
    for (const pid of Object.keys(analysis.per_project).sort()) {
      for (const skill of Object.keys(analysis.per_project[pid]).sort()) {
        const b = analysis.per_project[pid][skill];
        lines.push(`| ${pid} | ${skill} | ${b.total} | ${b.completed} | ${b.incomplete} |`);
      }
    }
    lines.push("");
  }

  return lines.join("\n").replace(/\s+$/, "") + "\n";
}

export function writeMarkdown(
  analysis: CorpusAnalysis,
  opts: { generatedAt: string; extractedAt: string | null; outputDir: string },
): string {
  fs.mkdirSync(opts.outputDir, { recursive: true });
  const outPath = path.join(opts.outputDir, "USAGE.md");
  fs.writeFileSync(outPath, renderMarkdown(analysis, opts));
  return outPath;
}

export function renderStdoutSummary(
  analysis: CorpusAnalysis,
  opts: { generatedAt: string; extractedAt: string | null; reportPath: string },
): string {
  const total = Object.values(analysis.skills).reduce((s, b) => s + b.total, 0);
  const completed = Object.values(analysis.skills).reduce((s, b) => s + b.completed, 0);
  const rate = total ? `${Math.round((completed / total) * 100)}%` : "n/a";
  const scope = analysis.project_filter || "all projects";
  const extractedLine = opts.extractedAt || "unknown";
  return [
    `Suite usage · scope: ${scope}`,
    `Skills observed: ${Object.keys(analysis.skills).length}`,
    `Invocations: ${total} · completed: ${completed} (${rate})`,
    `Report: ${opts.reportPath}`,
    `Run-at: ${opts.generatedAt} · Corpus extracted-at: ${extractedLine}`,
  ].join("\n");
}

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export interface UsageMainIo {
  out?: (text: string) => void;
  err?: (text: string) => void;
  env?: Env;
  platform?: NodeJS.Platform;
}

/**
 * Engine entry point mirroring scripts/usage_stats.py main(): emit a USAGE.md
 * report (default) or a JSON document (--json) from the existing corpus.
 * Returns 2 when the corpus is unavailable, matching the Python engine.
 */
export function usageMain(argv: string[], io: UsageMainIo = {}): number {
  const out = io.out ?? ((t: string) => process.stdout.write(t + "\n"));
  const err = io.err ?? ((t: string) => process.stderr.write(t + "\n"));
  const env = io.env ?? process.env;
  const platform = io.platform ?? process.platform;

  let corpus: string | null = null;
  let project: string | null = null;
  let emitJson = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--corpus") corpus = argv[++i] ?? null;
    else if (a.startsWith("--corpus=")) corpus = a.slice("--corpus=".length);
    else if (a === "--project") project = argv[++i] ?? null;
    else if (a.startsWith("--project=")) project = a.slice("--project=".length);
    else if (a === "--json") emitJson = true;
  }

  const corpusPath = corpus ?? defaultCorpusPath(env, platform);
  let corpusData: Dict;
  try {
    corpusData = loadCorpusOrRaise(corpusPath);
  } catch (e) {
    if (e instanceof CorpusUnavailable) {
      err(String(e.message));
      return 2;
    }
    throw e;
  }

  const analysis = analyzeCorpus(corpusData, project);
  const generatedAt = nowIso();
  const md = (corpusData as Dict).metadata;
  const extractedAt =
    md && typeof md === "object" && !Array.isArray(md) ? ((md.extracted_at as string) ?? null) : null;

  if (emitJson) {
    out(renderJson(analysis, { generatedAt, extractedAt }));
    return 0;
  }

  const outputDir = defaultUsageDir(env, platform);
  const outPath = writeMarkdown(analysis, { generatedAt, extractedAt, outputDir });
  out(renderStdoutSummary(analysis, { generatedAt, extractedAt, reportPath: outPath }));
  return 0;
}
