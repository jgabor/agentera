import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  AGENTERA_USER_STATE_NAMES,
  ROOT_USER_STATE_DIR_NAMES,
  ROOT_USER_STATE_FILE_NAMES,
} from "../../../src/upgrade/doctor.js";

/** Paths preserved during v2→v3 app-home cleanup (relative to app-home root). */
export function listPreservedAppHomeRelPaths(appHome: string): string[] {
  const out: string[] = [];
  for (const name of ROOT_USER_STATE_FILE_NAMES) {
    const rel = name;
    if (fs.existsSync(path.join(appHome, rel))) {
      out.push(rel);
    }
  }
  for (const name of ROOT_USER_STATE_DIR_NAMES) {
    const rel = name;
    if (fs.existsSync(path.join(appHome, rel))) {
      out.push(rel);
    }
  }
  const agenteraDir = path.join(appHome, ".agentera");
  if (fs.existsSync(agenteraDir)) {
    for (const name of AGENTERA_USER_STATE_NAMES) {
      const rel = path.join(".agentera", name);
      if (fs.existsSync(path.join(appHome, rel))) {
        out.push(rel);
      }
    }
    const vision = path.join(".agentera", "vision.yaml");
    if (fs.existsSync(path.join(appHome, vision))) {
      out.push(".agentera/vision.yaml");
    }
    const optimera = path.join(".agentera", "optimera");
    if (fs.existsSync(optimera)) {
      const walk = (dir: string, prefix: string): void => {
        for (const entry of fs.readdirSync(dir)) {
          const full = path.join(dir, entry);
          const rel = prefix ? `${prefix}/${entry}` : entry;
          if (fs.statSync(full).isDirectory()) {
            walk(full, rel);
          } else {
            out.push(path.join(".agentera", "optimera", rel));
          }
        }
      };
      walk(optimera, "");
    }
  }
  return out.sort();
}

/** Project `.agentera/` YAML files under test. */
export function listProjectArtifactRelPaths(project: string): string[] {
  const agenteraDir = path.join(project, ".agentera");
  if (!fs.existsSync(agenteraDir)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of fs.readdirSync(agenteraDir)) {
    const full = path.join(agenteraDir, entry);
    if (fs.statSync(full).isFile() && entry.endsWith(".yaml")) {
      out.push(path.join(".agentera", entry));
    }
    if (entry === "optimera" && fs.statSync(full).isDirectory()) {
      const walk = (dir: string, prefix: string): void => {
        for (const name of fs.readdirSync(dir)) {
          const nested = path.join(dir, name);
          const rel = prefix ? `${prefix}/${name}` : name;
          if (fs.statSync(nested).isDirectory()) {
            walk(nested, rel);
          } else {
            out.push(path.join(".agentera", "optimera", rel));
          }
        }
      };
      walk(full, "");
    }
  }
  return out.sort();
}

export function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function checksumManifest(root: string, relPaths: readonly string[]): Record<string, string> {
  const manifest: Record<string, string> = {};
  for (const rel of relPaths) {
    const full = path.join(root, rel);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      manifest[rel] = sha256File(full);
    }
  }
  return manifest;
}

export function assertChecksumsUnchanged(
  root: string,
  before: Record<string, string>,
): void {
  for (const [rel, hash] of Object.entries(before)) {
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) {
      throw new Error(`preserved path missing after migration: ${rel}`);
    }
    const after = sha256File(full);
    if (after !== hash) {
      throw new Error(`checksum mismatch for ${rel}: before=${hash} after=${after}`);
    }
  }
}

/** Forbidden patterns on rewired managed surfaces. */
export const PYTHON_LEFTOVER_PATTERNS = [
  /validate_artifact\.py/,
  /cursor_session_start\.py/,
  /cursor_pre_tool_use\.py/,
  /cursor_session_stop\.py/,
  /\/app\/scripts\/agentera/,
  /\buv run\b.*scripts\/agentera/,
] as const;

export function scanTextForPythonLeftovers(text: string, label: string): string[] {
  const hits: string[] = [];
  for (const pattern of PYTHON_LEFTOVER_PATTERNS) {
    if (pattern.test(text)) {
      hits.push(`${label}: matched ${pattern}`);
    }
  }
  return hits;
}

export function scanDirectoryForPythonLeftovers(dir: string, extensions = [".json", ".toml", ".js", ".md"]): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const hits: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current)) {
      const full = path.join(current, entry);
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (!extensions.some((ext) => entry.endsWith(ext))) {
        continue;
      }
      const rel = path.relative(dir, full);
      hits.push(...scanTextForPythonLeftovers(fs.readFileSync(full, "utf8"), rel));
    }
  };
  walk(dir);
  return hits;
}
