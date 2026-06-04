import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import YAML from "yaml";

import { resolvePath } from "../core/paths.js";
import { loadYamlMapping } from "../core/yaml.js";
import {
  MAX_TOTAL_ENTRIES,
  compactSessionBookmarkEntries,
  loadArtifactOverrides,
  resolveArtifactPath,
  resolveSessionPath,
  sessionBookmarkToOneline,
} from "./common.js";

/**
 * Stop hook: writes runtime-local session bookmarks. Faithful TS port of
 * hooks/session_stop.py.
 */

type Dict = Record<string, any>;
type Env = Record<string, string | undefined>;

export { MAX_TOTAL_ENTRIES };

import { TRACKED_ARTIFACT_IDS } from "../registries/artifactProtocolIds.js";

export { TRACKED_ARTIFACT_IDS as TRACKED_ARTIFACTS } from "../registries/artifactProtocolIds.js";

export function getArtifactPaths(
  projectRoot: string,
  overrides: Record<string, string> | null,
): Record<string, string> {
  const pathToName: Record<string, string> = {};
  for (const artifact of TRACKED_ARTIFACT_IDS) {
    const resolved = resolveArtifactPath(projectRoot, artifact, overrides);
    const rel = path.relative(resolvePath(projectRoot), resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      continue;
    }
    pathToName[rel] = artifact;
  }
  return pathToName;
}

function runGit(projectRoot: string, args: string[]): string[] {
  const result = spawnSync("git", args, { cwd: projectRoot, encoding: "utf8", timeout: 10000 });
  if (!result.error && result.status === 0) {
    return (result.stdout ?? "")
      .trim()
      .split(/\r\n|\r|\n/)
      .map((line) => line.trim())
      .filter((line) => line);
  }
  return [];
}

export function getModifiedFiles(projectRoot: string): string[] {
  const modified = new Set<string>();
  const headDiff = runGit(projectRoot, ["diff", "--name-only", "HEAD"]);
  if (headDiff.length > 0) {
    for (const f of headDiff) modified.add(f);
  } else {
    for (const f of runGit(projectRoot, ["diff", "--cached", "--name-only"])) modified.add(f);
    for (const f of runGit(projectRoot, ["diff", "--name-only"])) modified.add(f);
  }
  for (const f of runGit(projectRoot, ["ls-files", "--others", "--exclude-standard"])) modified.add(f);
  return [...modified].sort();
}

export function detectModifiedArtifacts(
  projectRoot: string,
  overrides: Record<string, string> | null,
  getModified: (root: string) => string[] = getModifiedFiles,
): string[] {
  const pathToName = getArtifactPaths(projectRoot, overrides);
  const modifiedFiles = getModified(projectRoot);
  const modifiedArtifacts = new Set<string>();
  for (const filepath of modifiedFiles) {
    const normalized = filepath.replace(/\\/g, "/");
    if (normalized in pathToName) {
      modifiedArtifacts.add(pathToName[normalized]);
    }
  }
  return [...modifiedArtifacts].sort();
}

export function parseSessionEntries(text: string): Dict[] {
  let data: unknown = null;
  try {
    data = loadYamlMapping(text);
  } catch {
    data = null;
  }
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const entries: Dict[] = [];
    for (const bookmark of (data as Dict).bookmarks ?? []) {
      if (bookmark && typeof bookmark === "object") {
        entries.push({
          timestamp: String(bookmark.timestamp ?? ""),
          artifacts: [...(bookmark.artifacts ?? [])],
          summary: String(bookmark.summary ?? ""),
          kind: "full",
        });
      }
    }
    for (const archived of (data as Dict).archive ?? []) {
      if (archived && typeof archived === "object") {
        entries.push({
          timestamp: String(archived.timestamp ?? ""),
          artifacts: [],
          summary: String(archived.summary ?? ""),
          kind: "oneline",
        });
      }
    }
    if (entries.length > 0) {
      return entries;
    }
  }

  const entries: Dict[] = [];
  const pattern = /^##\s+(.+)$/gm;
  const matches = [...text.matchAll(pattern)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const header = m[1].trim();
    const start = m.index! + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : text.length;
    const body = text.slice(start, end).trim();
    if (body) {
      let summary = "";
      let artifacts: string[] = [];
      for (const line of body.split(/\r\n|\r|\n/)) {
        const stripped = line.trim();
        if (stripped.toLowerCase().startsWith("summary:")) {
          summary = stripped.split(/:(.*)/s)[1].trim();
        }
        if (stripped.toLowerCase().startsWith("artifacts modified:")) {
          const raw = stripped.split(/:(.*)/s)[1];
          artifacts = raw.split(",").map((a) => a.trim()).filter((a) => a);
        }
      }
      entries.push({ timestamp: header, artifacts, summary, kind: "full" });
    } else {
      entries.push({ timestamp: header, artifacts: [], summary: header, kind: "oneline" });
    }
  }
  return entries;
}

export const compactEntryToOneline = sessionBookmarkToOneline;
export const compactEntries = compactSessionBookmarkEntries;

export function formatSessionYaml(entries: Dict[]): string {
  const bookmarks: Dict[] = [];
  const archive: Dict[] = [];
  for (const entry of entries) {
    if (entry.kind === "full") {
      bookmarks.push({
        timestamp: entry.timestamp ?? "",
        artifacts: [...(entry.artifacts ?? [])],
        summary: entry.summary ?? "",
      });
    } else {
      archive.push({ timestamp: entry.timestamp ?? "", summary: entry.summary ?? "" });
    }
  }
  const data: Dict = { bookmarks };
  if (archive.length > 0) {
    data.archive = archive;
  }
  return YAML.stringify(data);
}

function formatTimestampUtc(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
  );
}

export function buildBookmark(modifiedArtifacts: string[], timestamp: Date | null = null): Dict {
  const ts = timestamp ?? new Date();
  return {
    timestamp: formatTimestampUtc(ts),
    artifacts: modifiedArtifacts,
    summary: `Modified ${modifiedArtifacts.length} artifact(s)`,
    kind: "full",
  };
}

export function writeSessionBookmark(
  projectRoot: string,
  _overrides: Record<string, string> | null,
  modifiedArtifacts: string[],
  opts: { timestamp?: Date | null; env?: Env } = {},
): boolean {
  if (modifiedArtifacts.length === 0) {
    return false;
  }
  const env = opts.env ?? process.env;
  const sessionPath = resolveSessionPath(projectRoot, env);

  let existingText = "";
  if (fs.existsSync(sessionPath)) {
    existingText = fs.readFileSync(sessionPath, "utf8");
  }
  const existingEntries = parseSessionEntries(existingText);
  const newEntry = buildBookmark(modifiedArtifacts, opts.timestamp ?? null);
  const allEntries = [newEntry, ...existingEntries];
  const compacted = compactEntries(allEntries);

  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, formatSessionYaml(compacted));
  return true;
}

export interface HookRunOptions {
  env?: Env;
}

export function runSessionStop(rawStdin: string, opts: HookRunOptions = {}): number {
  const env = opts.env ?? process.env;
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
  const overrides = loadArtifactOverrides(projectRoot);
  const modified = detectModifiedArtifacts(projectRoot, overrides);
  if (modified.length === 0) {
    return 0;
  }
  const written = writeSessionBookmark(projectRoot, overrides, modified, { env });
  return written ? 0 : 1;
}
