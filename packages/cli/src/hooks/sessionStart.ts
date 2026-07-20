import fs from "node:fs";

import type { JsonObject } from "../core/jsonValue.js";
import { loadYamlMapping } from "../core/yaml.js";
import { listHealthEntities } from "../state/healthEntities.js";
import { listPlanEntities, listPlanTaskEntities } from "../state/planEntities.js";
import { listProgressEntities } from "../state/progressEntities.js";
import { listTodoDocsEntities } from "../state/todoDocsEntities.js";
import { resolveSessionPath } from "./common.js";
import { parseProjectHookInput, type ParsedProjectHookInput } from "./projectHookInput.js";

type Env = Record<string, string | undefined>;

const END_OF_STRING = "$(?![\\s\\S])";

export function extractSessionSummary(text: string): string | null {
  const pattern = new RegExp(`^##\\s+.+?\\n([\\s\\S]*?)(?=^## |${END_OF_STRING})`, "m");
  const match = pattern.exec(text);
  if (!match) return null;
  const lines = match[1].trim().split(/\r\n|\r|\n/).filter((line) => line.trim());
  return lines.length ? lines.slice(0, 3).join("\n") : null;
}

export function extractSessionSummaryYaml(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const bookmarks = (data as JsonObject).bookmarks;
  if (!Array.isArray(bookmarks) || bookmarks.length === 0 || typeof bookmarks[0] !== "object") return null;
  const latest = bookmarks[0] as JsonObject;
  const timestamp = latest.timestamp ?? "";
  const summary = latest.summary ?? "";
  const artifacts = latest.artifacts ?? [];
  const lines: string[] = [];
  if (timestamp) lines.push(String(timestamp));
  if (summary) lines.push(String(summary));
  if (Array.isArray(artifacts) && artifacts.length > 0) lines.push("Artifacts modified: " + artifacts.map(String).join(", "));
  return lines.length ? lines.slice(0, 3).join("\n") : null;
}

function objects(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is JsonObject => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
    : [];
}

function entityLine(entry: JsonObject, fields: string[]): string {
  const record = entry.record && typeof entry.record === "object" && !Array.isArray(entry.record)
    ? entry.record as JsonObject
    : {};
  return [
    `id: ${entry.id}`,
    `artifact: ${entry.artifact}`,
    ...fields.filter((field) => record[field] !== undefined).map((field) => `${field}: ${String(record[field])}`),
  ].join("\n");
}

export function buildDigest(projectRoot: string, env: Env = process.env): string | null {
  const sections: string[] = [];
  const progress = objects(listProgressEntities(projectRoot, 1, {}, undefined, { format: "json" }).entries)[0];
  if (progress) sections.push(`## Latest progress\n${entityLine(progress, ["timestamp", "phase", "what", "verified"])}`);

  const health = objects(listHealthEntities(projectRoot, 1, undefined, undefined, { format: "json" }).entries)[0];
  if (health) sections.push(`## Health\n${entityLine(health, ["date", "trajectory"])}`);

  const plans = objects(listPlanEntities(projectRoot, 20, undefined, { format: "json" }).entries);
  const openPlan = plans.find((entry) => {
    const record = entry.record as JsonObject | undefined;
    const header = record?.header as JsonObject | undefined;
    return String(header?.status ?? "") === "open";
  });
  if (openPlan) {
    const tasks = objects(listPlanTaskEntities(projectRoot, String(openPlan.id), 20, undefined, { format: "json" }).entries);
    const task = tasks.find((entry) => String((entry.record as JsonObject | undefined)?.status ?? "pending") !== "complete");
    if (task) sections.push(`## Next task\n${entityLine(task, ["name", "status"])}`);
  }

  const todos = objects(listTodoDocsEntities(projectRoot, "todo", 20, undefined, { severity: "critical", status: "open" }, { format: "json" }).entries);
  if (todos.length) sections.push(`## Critical issues\n${todos.map((entry) => entityLine(entry, ["description", "severity", "status"])).join("\n\n")}`);

  const sessionPath = resolveSessionPath(projectRoot, env);
  if (fs.existsSync(sessionPath)) {
    const summary = sessionPath.endsWith(".yaml")
      ? extractSessionSummaryYaml(loadYamlMapping(fs.readFileSync(sessionPath, "utf8")))
      : extractSessionSummary(fs.readFileSync(sessionPath, "utf8"));
    if (summary) sections.push(`## Last session\n${summary}`);
  }
  return sections.length ? `# Session context\n\n${sections.join("\n\n")}\n` : null;
}

export interface HookRunOptions {
  env?: Env;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

export function runSessionStart(
  input: string | ParsedProjectHookInput,
  opts: HookRunOptions = {},
): number {
  const env = opts.env ?? process.env;
  const output = opts.out ?? ((text: string) => process.stdout.write(text));
  const parsed = typeof input === "string" ? parseProjectHookInput("session-start", input) : input;
  const digest = buildDigest(parsed.projectRoot, env);
  if (digest) output(digest);
  return 0;
}
