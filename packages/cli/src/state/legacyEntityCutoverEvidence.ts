import { createHash } from "node:crypto";
import path from "node:path";

import { loadYamlMapping } from "../core/yaml.js";
import { validateRealProjectRoot } from "./projectRoot.js";
import { readProjectFileSnapshot } from "./safeProjectFile.js";

export interface EntityCutoverTargetBinding {
  path: string;
  sha256: string;
  id?: string;
  artifact?: string;
}

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function mapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function read(project: string, relative: string): Buffer {
  const observed = readProjectFileSnapshot(validateRealProjectRoot(project), relative);
  if (observed.kind !== "file") throw new Error(`historical entity cutover evidence '${relative}' is missing or unsafe`);
  return observed.bytes;
}

function safeTarget(value: string): boolean {
  return value.startsWith(".agentera/entities/") && !path.isAbsolute(value) && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** Minimal read-only compatibility required by public state validation. */
export function loadLegacyEntityCutoverTargets(projectRoot: string, markerBytes: Buffer): EntityCutoverTargetBinding[] {
  const project = validateRealProjectRoot(projectRoot).path;
  const marker = loadYamlMapping(markerBytes.toString("utf8"));
  const id = marker.migration_id;
  if (typeof id !== "string" || !/^[a-f0-9]{20}$/.test(id)) throw new Error("entity marker has no valid historical migration binding");
  const root = `.agentera/migrations/entities/${id}`;
  const journalBytes = read(project, `${root}/journal.yaml`);
  const manifestBytes = read(project, `${root}/manifest.yaml`);
  const journal = loadYamlMapping(journalBytes.toString("utf8"));
  const manifest = loadYamlMapping(manifestBytes.toString("utf8"));
  if (
    journal.schemaVersion !== "agentera.entityMigrationJournal.v1" ||
    journal.migration_id !== id ||
    journal.phase !== "cutover_complete" ||
    journal.manifest_sha256 !== hash(manifestBytes) ||
    manifest.schemaVersion !== "agentera.entityMigrationManifest.v1" ||
    manifest.migration_id !== id ||
    journal.source_fingerprint !== marker.source_fingerprint ||
    journal.preview_digest !== marker.preview_digest ||
    manifest.source_fingerprint !== marker.source_fingerprint ||
    manifest.preview_digest !== marker.preview_digest
  ) {
    throw new Error(`historical entity cutover evidence '${id}' does not match its marker`);
  }
  const receipts = mapping(manifest.receipts) ? manifest.receipts : {};
  const markerReceipt = mapping(receipts[".agentera/state-mode.yaml"]) ? receipts[".agentera/state-mode.yaml"] : null;
  if (!markerReceipt || markerReceipt.sha256 !== hash(markerBytes)) throw new Error(`historical entity cutover marker '${id}' diverges from its manifest`);
  if (!Array.isArray(manifest.entries)) throw new Error(`historical entity cutover manifest '${id}' has no target inventory`);
  const targets = manifest.entries.map((value): EntityCutoverTargetBinding => {
    const entry = mapping(value) ? value : {};
    const target = mapping(entry.proposed_target) ? entry.proposed_target : {};
    if (typeof target.path !== "string" || !safeTarget(target.path) || typeof target.id !== "string" || typeof entry.artifact !== "string" || typeof entry.target_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.target_sha256)) {
      throw new Error(`historical entity cutover manifest '${id}' has an invalid target`);
    }
    return {
      path: target.path,
      sha256: entry.target_sha256,
      id: target.id,
      artifact: entry.artifact,
    };
  });
  if (new Set(targets.map(({ path: target }) => target)).size !== targets.length) {
    throw new Error(`historical entity cutover manifest '${id}' target inventory is duplicated`);
  }
  return targets;
}
