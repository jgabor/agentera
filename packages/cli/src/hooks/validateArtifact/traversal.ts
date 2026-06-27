/**
 * Path resolution and artifact identification.
 *
 * Given an arbitrary `cwd` and a candidate write path, decide which
 * (if any) protocol-tracked artifact the write targets, applying
 * `.agentera/docs.yaml` path overrides when present.
 */

import fs from "node:fs";
import path from "node:path";

import { resolvePath } from "../../core/paths.js";
import { loadYamlMapping } from "../../core/yaml.js";
import {
  ARTIFACT_PROTOCOL_PATHS,
  HUMAN_FACING_ARTIFACT_IDS,
  normalizeArtifactProtocolId,
} from "../../registries/artifactProtocolIds.js";
import { DEFAULT_ARTIFACT_PATHS } from "../common.js";
import { COMPACTABLE_YAML_ARTIFACTS, compactFile, compactYamlFile } from "../compaction/index.js";
import { isMapping } from "./schema.js";

import type { JsonObject } from "../../core/jsonValue.js";

const AGENT_YAML_RE = /\.agentera\/([a-z_]+)\.yaml$/;

function resolvePathRel(fp: string, cwd: string): string {
  return path.isAbsolute(fp) ? fp : path.join(cwd, fp);
}

function docsPathOverrides(cwd: string): Record<string, string> {
  const docsPath = path.join(cwd, ".agentera", "docs.yaml");
  if (!fs.existsSync(docsPath) || !fs.statSync(docsPath).isFile()) return {};
  let data: JsonObject;
  try {
    // cast: docs.yaml path-override mapping parsed from a YAML file
    data = loadYamlMapping(fs.readFileSync(docsPath, "utf8")) as JsonObject;
  } catch (exc) {
    process.stderr.write(`warning: failed to load docs path overrides: ${(exc as Error).message}\n`);
    return {};
  }
  const mapping = data.mapping;
  if (!Array.isArray(mapping)) return {};
  const overrides: Record<string, string> = {};
  for (const entry of mapping) {
    if (!isMapping(entry)) continue;
    const artifact = entry.artifact;
    const p = entry.path;
    if (typeof artifact === "string" && typeof p === "string") overrides[artifact] = p;
  }
  return overrides;
}

export function defaultArtifactPath(artifact: string, cwd: string): string {
  const rel = docsPathOverrides(cwd)[artifact] ?? DEFAULT_ARTIFACT_PATHS[artifact] ?? "";
  return rel ? resolvePathRel(rel, cwd) : "";
}

export function artifactPaths(cwd: string): Record<string, string> {
  const paths: Record<string, string> = { ...DEFAULT_ARTIFACT_PATHS, ...docsPathOverrides(cwd) };
  const resolved: Record<string, string> = {};
  for (const [artifact, p] of Object.entries(paths)) resolved[artifact] = resolvePathRel(p, cwd);
  return resolved;
}

function samePath(left: string, right: string): boolean {
  return resolvePath(left) === resolvePath(right);
}

export function artifactForWrite(absPath: string, relPath: string, basename: string, cwd: string): string | null {
  for (const [artifact, mappedPath] of Object.entries(artifactPaths(cwd))) {
    if (samePath(absPath, mappedPath)) return artifact;
  }
  const match = AGENT_YAML_RE.exec(relPath);
  if (match) {
    const id = match[1];
    return id in ARTIFACT_PROTOCOL_PATHS ? id : null;
  }
  if (HUMAN_FACING_ARTIFACT_IDS.has(normalizeArtifactProtocolId(basename) ?? "")) {
    return normalizeArtifactProtocolId(basename);
  }
  return null;
}

function readIfNeeded(content: string | null, absPath: string): string | null {
  if (content !== null && content !== undefined) return content;
  try {
    return fs.readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
}

function compactAfterValidWrite(artifact: string, absPath: string): string[] {
  if (!fs.existsSync(absPath)) return [];
  try {
    if (artifact === "todo") {
      compactFile(absPath, "todo-resolved");
    } else if (artifact in COMPACTABLE_YAML_ARTIFACTS) {
      compactYamlFile(absPath, artifact);
    } else {
      return [];
    }
  } catch (exc) {
    return [`${artifact}: compaction failed: ${(exc as Error).message}`];
  }
  return [];
}

export { readIfNeeded, compactAfterValidWrite };
