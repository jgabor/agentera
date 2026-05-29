import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expanduser, resolvePath } from "../core/paths.js";
import { resolveCandidate } from "../state/installRoot.js";

/**
 * Shared utilities for agentera hooks. Faithful TS port of hooks/common.py:
 * compaction retention caps, runtime-local session bookmark paths, and artifact
 * path resolution.
 */

export {
  loadYamlMapping,
  loadYamlMappingFile,
} from "../core/yaml.js";
export {
  COMMIT_HASH_RE,
  commitToken,
  validateProgressCommits,
} from "../state/progressCommit.js";
export { ancestorState, gitRun } from "../core/git.js";

type Env = Record<string, string | undefined>;
type Entry = Record<string, unknown>;

export const MAX_FULL_ENTRIES = 10;
export const MAX_ONELINE_ENTRIES = 40;
export const MAX_TOTAL_ENTRIES = MAX_FULL_ENTRIES + MAX_ONELINE_ENTRIES;

export function applyRetentionCaps<T extends Entry>(
  fullEntries: T[],
  archiveEntries: T[],
  opts: { maxFull?: number; maxOneline?: number; maxTotal?: number } = {},
): T[] {
  const maxFull = opts.maxFull ?? MAX_FULL_ENTRIES;
  const maxOneline = opts.maxOneline ?? MAX_ONELINE_ENTRIES;
  const maxTotal = opts.maxTotal ?? MAX_TOTAL_ENTRIES;
  const cappedArchive = archiveEntries.slice(0, maxOneline);
  return [...fullEntries.slice(0, maxFull), ...cappedArchive].slice(0, maxTotal);
}

export function resolveAgenteraDataHome(env: Env = process.env, home: string = os.homedir()): string {
  const configured = env.AGENTERA_HOME;
  if (configured) {
    return expanduser(configured);
  }
  const [root] = resolveCandidate(null, { env, home });
  return root;
}

export function resolveSessionPath(
  projectRoot: string,
  env: Env = process.env,
  home: string = os.homedir(),
): string {
  const dataHome = resolveAgenteraDataHome(env, home);
  const resolved = resolvePath(projectRoot);
  const digest = crypto.createHash("sha256").update(resolved, "utf8").digest("hex").slice(0, 16);
  const name = path.basename(projectRoot);
  const slug = name.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "") || "project";
  return path.join(dataHome, "sessions", `${slug}-${digest}`, "session.yaml");
}

export function sessionBookmarkToOneline(entry: Entry): Entry {
  return {
    timestamp: String(entry.timestamp ?? ""),
    artifacts: [],
    summary: String(entry.summary ?? ""),
    kind: "oneline",
  };
}

export function compactSessionBookmarkEntries(
  entries: Entry[],
  opts: {
    maxFull?: number;
    maxOneline?: number;
    maxTotal?: number;
    toOneline?: (entry: Entry) => Entry;
  } = {},
): Entry[] {
  const maxFull = opts.maxFull ?? MAX_FULL_ENTRIES;
  const maxOneline = opts.maxOneline ?? MAX_ONELINE_ENTRIES;
  const maxTotal = opts.maxTotal ?? MAX_TOTAL_ENTRIES;
  const convert = opts.toOneline ?? sessionBookmarkToOneline;
  const ordered = [...entries].sort((a, b) => {
    const ta = String(a.timestamp ?? "");
    const tb = String(b.timestamp ?? "");
    return ta < tb ? 1 : ta > tb ? -1 : 0;
  });
  const full: Entry[] = [];
  const archive: Entry[] = [];
  for (const entry of ordered) {
    if (entry.kind === "full" && full.length < maxFull) {
      full.push(entry);
    } else {
      archive.push(convert(entry));
    }
  }
  return applyRetentionCaps(full, archive, { maxFull, maxOneline, maxTotal });
}

export const DEFAULT_ARTIFACT_PATHS: Record<string, string> = {
  "VISION.md": ".agentera/vision.yaml",
  "TODO.md": "TODO.md",
  "CHANGELOG.md": "CHANGELOG.md",
  "DECISIONS.md": ".agentera/decisions.yaml",
  "PLAN.md": ".agentera/plan.yaml",
  "PROGRESS.md": ".agentera/progress.yaml",
  "HEALTH.md": ".agentera/health.yaml",
  "DOCS.md": ".agentera/docs.yaml",
  "DESIGN.md": "DESIGN.md",
};

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}

export function parseDocsYamlMapping(docsText: string): Record<string, string> {
  const mapping: Record<string, string> = {};
  let inMapping = false;
  let current: string | null = null;
  for (const line of docsText.split(/\r\n|\r|\n/)) {
    if (line.startsWith("mapping:")) {
      inMapping = true;
      continue;
    }
    if (inMapping && line && !line.startsWith(" ") && !line.startsWith("-")) {
      break;
    }
    if (!inMapping) {
      continue;
    }
    const artifactMatch = /^-\s+artifact:\s*(.+?)\s*$/.exec(line);
    if (artifactMatch) {
      current = stripQuotes(artifactMatch[1].trim());
      continue;
    }
    const pathMatch = /^\s+path:\s*(.+?)\s*$/.exec(line);
    if (pathMatch && current) {
      mapping[current] = stripQuotes(pathMatch[1].trim());
      current = null;
    }
  }
  return mapping;
}

export function parseArtifactMapping(docsText: string): Record<string, string> {
  const mapping: Record<string, string> = {};
  let inTable = false;
  for (const line of docsText.split(/\r\n|\r|\n/)) {
    const stripped = line.trim();
    if (/\|\s*Artifact\s*\|.*Path/i.test(stripped)) {
      inTable = true;
      continue;
    }
    if (inTable && /\|[-| :]+\|/.test(stripped)) {
      continue;
    }
    if (inTable && stripped.startsWith("|")) {
      const cells = stripped.split("|").map((c) => c.trim());
      if (cells.length >= 3 && cells[1] && cells[2]) {
        mapping[cells[1]] = cells[2];
      }
    } else if (inTable && !stripped.startsWith("|")) {
      break;
    }
  }
  return mapping;
}

export function resolveArtifactPath(
  projectRoot: string,
  artifact: string,
  overrides: Record<string, string> | null = null,
): string {
  if (overrides && artifact in overrides) {
    return path.join(projectRoot, overrides[artifact]);
  }
  return path.join(projectRoot, DEFAULT_ARTIFACT_PATHS[artifact] ?? `.agentera/${artifact}`);
}

export function loadArtifactOverrides(projectRoot: string): Record<string, string> | null {
  const yamlPath = path.join(projectRoot, ".agentera", "docs.yaml");
  if (fs.existsSync(yamlPath)) {
    const mapping = parseDocsYamlMapping(fs.readFileSync(yamlPath, "utf8"));
    if (Object.keys(mapping).length > 0) {
      return mapping;
    }
  }
  const docsPath = path.join(projectRoot, ".agentera", "DOCS.md");
  if (fs.existsSync(docsPath)) {
    const mapping = parseArtifactMapping(fs.readFileSync(docsPath, "utf8"));
    if (Object.keys(mapping).length > 0) {
      return mapping;
    }
  }
  return null;
}
