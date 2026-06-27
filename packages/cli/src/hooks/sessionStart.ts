import fs from "node:fs";
import path from "node:path";

import { resolvePath } from "../core/paths.js";
import { loadYamlMapping } from "../core/yaml.js";
import {
  loadArtifactOverrides,
  resolveArtifactPath,
  resolveSessionPath,
} from "./common.js";

/**
 * SessionStart hook: preloads a compact digest of operational artifacts.
 * Faithful TS port of hooks/session_start.py.
 */

import type { JsonObject } from "../core/jsonValue.js";

type Env = Record<string, string | undefined>;

const END_OF_STRING = "$(?![\\s\\S])";

export function extractLatestProgress(text: string): string | null {
  const pattern = new RegExp(
    `^(?:[^\\n]*?)##\\s+Cycle\\s+\\d+[\\s\\S]*?\\n([\\s\\S]*?)(?=^(?:[^\\n]*?)##\\s+Cycle\\s+\\d+|${END_OF_STRING})`,
    "m",
  );
  const m = pattern.exec(text);
  if (!m) {
    return null;
  }
  const body = m[1].trim();
  const lines = body.split(/\r\n|\r|\n/).filter((ln) => ln.trim());
  return lines.slice(0, 5).join("\n");
}

export function extractHealthGrades(text: string): string | null {
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (/^\*\*Grades\*\*:/.test(line)) {
      return line.trim();
    }
  }
  return null;
}

export function extractNextPlanTask(text: string): string | null {
  const taskPattern = new RegExp(
    `^###\\s+(Task\\s+\\d+:[\\s\\S]*?)\\n([\\s\\S]*?)(?=^### |${END_OF_STRING})`,
    "gm",
  );
  let m: RegExpExecArray | null;
  while ((m = taskPattern.exec(text)) !== null) {
    const title = m[1].trim();
    const body = m[2];
    const statusMatch = /\*\*Status\*\*:\s*(.+)/.exec(body);
    if (statusMatch) {
      const status = statusMatch[1].trim();
      if (status.toLowerCase().includes("complete")) {
        continue;
      }
    }
    return title;
  }
  return null;
}

export function extractCriticalTodos(text: string): string[] {
  const items: string[] = [];
  let inCritical = false;
  for (const line of text.split(/\r\n|\r|\n/)) {
    const stripped = line.trim();
    if (/^##\s*(?:\S+\s+)?Critical/i.test(stripped)) {
      inCritical = true;
      continue;
    }
    if (inCritical && /^##\s/.test(stripped)) {
      break;
    }
    if (inCritical && /^-\s/.test(stripped)) {
      items.push(stripped);
    }
  }
  return items;
}

export function extractSessionSummary(text: string): string | null {
  const pattern = new RegExp(`^##\\s+.+?\\n([\\s\\S]*?)(?=^## |${END_OF_STRING})`, "m");
  const m = pattern.exec(text);
  if (!m) {
    return null;
  }
  const body = m[1].trim();
  const lines = body.split(/\r\n|\r|\n/).filter((ln) => ln.trim());
  return lines.slice(0, 3).join("\n");
}

function loadYaml(p: string): unknown {
  try {
    return loadYamlMapping(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export function extractLatestProgressYaml(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const cycles = (data as JsonObject).cycles;
  if (!Array.isArray(cycles) || cycles.length === 0) return null;
  const latest = cycles[0] && typeof cycles[0] === "object" ? cycles[0] : null;
  if (!latest) return null;
  // cast: progress-cycle fields read from parsed progress.yaml
  const obj = latest as JsonObject;
  const parts: string[] = [];
  for (const key of ["number", "phase", "what", "verified", "next"]) {
    const value = obj[key];
    if (value !== null && value !== undefined && value !== "") {
      parts.push(`${key}: ${value}`);
    }
  }
  return parts.length > 0 ? parts.slice(0, 5).join("\n") : null;
}

export function extractHealthGradesYaml(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const audits = (data as JsonObject).audits;
  if (!Array.isArray(audits) || audits.length === 0 || typeof audits[0] !== "object") return null;
  // cast: audit grades read from parsed health.yaml
  const grades = (audits[0] as JsonObject).grades;
  if (!grades || typeof grades !== "object" || Array.isArray(grades) || Object.keys(grades).length === 0) return null;
  return "Grades: " + Object.entries(grades).map(([k, v]) => `${k} ${v}`).join(" | ");
}

export function extractNextPlanTaskYaml(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const tasks = (data as JsonObject).tasks;
  if (!Array.isArray(tasks)) return null;
  for (const task of tasks) {
    if (!task || typeof task !== "object") continue;
    // cast: plan-task fields read from parsed plan.yaml
    const taskObj = task as JsonObject;
    if (String(taskObj.status ?? "").toLowerCase() === "complete") continue;
    const number = taskObj.number;
    const name = taskObj.name ?? "unnamed task";
    return number !== null && number !== undefined ? `Task ${number}: ${name}` : String(name);
  }
  return null;
}

export function extractSessionSummaryYaml(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const bookmarks = (data as JsonObject).bookmarks;
  if (!Array.isArray(bookmarks) || bookmarks.length === 0 || typeof bookmarks[0] !== "object") return null;
  const latest = bookmarks[0];
  // cast: session bookmark fields read from parsed session bookmark yaml
  const latestObj = latest as JsonObject;
  const timestamp = latestObj.timestamp ?? "";
  const summary = latestObj.summary ?? "";
  const artifacts = latestObj.artifacts ?? [];
  const lines: string[] = [];
  if (timestamp) lines.push(String(timestamp));
  if (summary) lines.push(String(summary));
  if (Array.isArray(artifacts) && artifacts.length > 0) {
    lines.push("Artifacts modified: " + artifacts.map((a: unknown) => String(a)).join(", "));
  }
  return lines.length > 0 ? lines.slice(0, 3).join("\n") : null;
}

export function buildDigest(projectRoot: string, env: Env = process.env): string | null {
  const overrides = loadArtifactOverrides(projectRoot);
  const sections: string[] = [];

  const progressPath = resolveArtifactPath(projectRoot, "progress", overrides);
  if (fs.existsSync(progressPath)) {
    const entry = progressPath.endsWith(".yaml")
      ? extractLatestProgressYaml(loadYaml(progressPath))
      : extractLatestProgress(fs.readFileSync(progressPath, "utf8"));
    if (entry) sections.push(`## Latest progress\n${entry}`);
  }

  const healthPath = resolveArtifactPath(projectRoot, "health", overrides);
  if (fs.existsSync(healthPath)) {
    const grades = healthPath.endsWith(".yaml")
      ? extractHealthGradesYaml(loadYaml(healthPath))
      : extractHealthGrades(fs.readFileSync(healthPath, "utf8"));
    if (grades) sections.push(`## Health\n${grades}`);
  }

  const planPath = resolveArtifactPath(projectRoot, "plan", overrides);
  if (fs.existsSync(planPath)) {
    const task = planPath.endsWith(".yaml")
      ? extractNextPlanTaskYaml(loadYaml(planPath))
      : extractNextPlanTask(fs.readFileSync(planPath, "utf8"));
    if (task) sections.push(`## Next task\n${task}`);
  }

  const todoPath = resolveArtifactPath(projectRoot, "todo", overrides);
  if (fs.existsSync(todoPath)) {
    const critical = extractCriticalTodos(fs.readFileSync(todoPath, "utf8"));
    if (critical.length > 0) sections.push(`## Critical issues\n` + critical.join("\n"));
  }

  const sessionPath = resolveSessionPath(projectRoot, env);
  if (fs.existsSync(sessionPath)) {
    const summary = sessionPath.endsWith(".yaml")
      ? extractSessionSummaryYaml(loadYaml(sessionPath))
      : extractSessionSummary(fs.readFileSync(sessionPath, "utf8"));
    if (summary) sections.push(`## Last session\n${summary}`);
  }

  if (sections.length === 0) {
    return null;
  }
  return "# Session context\n\n" + sections.join("\n\n") + "\n";
}

export interface HookRunOptions {
  env?: Env;
  out?: (text: string) => void;
}

export function runSessionStart(rawStdin: string, opts: HookRunOptions = {}): number {
  const env = opts.env ?? process.env;
  const out = opts.out ?? ((text: string) => process.stdout.write(text));
  let cwd = ".";
  try {
    if (rawStdin.trim()) {
      const hookInput = JSON.parse(rawStdin);
      cwd = hookInput.cwd ?? ".";
    }
  } catch {
    cwd = ".";
  }
  const projectRoot = resolvePath(cwd);
  const digest = buildDigest(projectRoot, env);
  if (digest) {
    out(digest);
  }
  return 0;
}
