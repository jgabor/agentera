import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { dumpYamlMapping, loadYamlMapping } from "../core/yaml.js";
import { canonicalRecordJson } from "./archiveDiscovery.js";
import { canonicalEntityEnvelope, canonicalEntityEnvelopeBytes, entityBoundariesForArtifact } from "./entityStorage.js";
import type { DurableEntityMigrationPlan } from "./entityMigrationPreview.js";
import { assertValidatedProjectRoot, validateRealProjectRoot } from "./projectRoot.js";

export const ENTITY_MIGRATION_ROOT = ".agentera/migrations/entities";
export const ENTITY_MIGRATION_MARKER = ".agentera/state-mode.yaml";
const DIRECTORY_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0);

interface InventoryEntry {
  path: string;
  dev: string;
  ino: string;
  size: string;
  sha256: string;
}

export interface EntityMigrationPreparationInspection {
  name: string;
  id: string;
  relative_path: string;
  directory: { dev: string; ino: string };
  receipt_count: number;
  inventory_sha256: string;
  untracked_paths: string[];
  targets: string[];
  classification: "stale" | "same_operation";
}

export class EntityMigrationPreparationInspectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntityMigrationPreparationInspectionError";
  }
}

function hash(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fdPath(fd: number, name?: string): string {
  return name ? `/proc/self/fd/${fd}/${name}` : `/proc/self/fd/${fd}`;
}

function sameDirectory(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.isDirectory() && right.isDirectory() && left.dev === right.dev && left.ino === right.ino;
}

export function entityMigrationOperationId(plan: Pick<DurableEntityMigrationPlan, "project" | "source_fingerprint" | "preview_digest">): string {
  return hash(`agentera.entity-migration.v1\0${plan.project}\0${plan.source_fingerprint}\0${plan.preview_digest}`).slice(0, 20);
}

function fail(message: string): never {
  throw new EntityMigrationPreparationInspectionError(message);
}

function openDirectory(parent: number, name: string, label: string, requirement = "must be a real directory and must not be a symbolic link"): number {
  try {
    return fs.openSync(fdPath(parent, name), DIRECTORY_FLAGS);
  } catch {
    return fail(`${label} ${requirement}`);
  }
}

function pathExists(value: string): boolean {
  try {
    fs.lstatSync(value);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return fail(`migration publication path '${value}' is unreadable`);
  }
}

function stableRegularFile(parent: number, name: string, relativePath: string): { bytes: Buffer; inventory: InventoryEntry } {
  let fd: number | undefined;
  try {
    const linked = fs.lstatSync(fdPath(parent, name), { bigint: true });
    if (!linked.isFile() || linked.isSymbolicLink() || linked.nlink !== 1n) fail(`migration preparation receipt '${name}' is not an unlinked regular file`);
    fd = fs.openSync(fdPath(parent, name), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n) fail(`migration preparation receipt '${name}' is not an unlinked regular file`);
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mode !== after.mode || BigInt(bytes.length) !== after.size) fail(`migration preparation receipt '${name}' changed while inspected`);
    return { bytes, inventory: { path: relativePath, dev: String(after.dev), ino: String(after.ino), size: String(after.size), sha256: hash(bytes) } };
  } catch (error) {
    if (error instanceof EntityMigrationPreparationInspectionError) throw error;
    return fail(`migration preparation receipt '${name}' is unsafe or changed while inspected`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Read-only authority for admitting one unpublished, pre-journal preparation. */
export function inspectEntityMigrationPreparation(projectRoot: string, current: Pick<DurableEntityMigrationPlan, "project" | "source_fingerprint" | "preview_digest" | "entries"> | { project: string; source_fingerprint: string; preview_digest: string }): EntityMigrationPreparationInspection | undefined {
  const root = validateRealProjectRoot(projectRoot);
  const parentPath = path.join(root.path, ENTITY_MIGRATION_ROOT);
  if (!pathExists(parentPath)) return undefined;

  let rootFd: number | undefined;
  const parents: Array<{ parent: number; name: string; fd: number; identity: fs.BigIntStats }> = [];
  let parentFd: number | undefined;
  let stageFd: number | undefined;
  let receiptsFd: number | undefined;
  try {
    rootFd = fs.openSync(root.path, DIRECTORY_FLAGS);
    let cursor = rootFd;
    for (const segment of ENTITY_MIGRATION_ROOT.split("/")) {
      const fd = openDirectory(cursor, segment, `migration evidence path '${ENTITY_MIGRATION_ROOT}'`, "must be a real project directory and must not be a symbolic link");
      const identity = fs.fstatSync(fd, { bigint: true });
      parents.push({ parent: cursor, name: segment, fd, identity });
      cursor = fd;
    }
    parentFd = cursor;
    const parentIdentity = fs.fstatSync(parentFd, { bigint: true });
    const names = fs.readdirSync(fdPath(parentFd)).sort();
    const preparationNames = names.filter((name) => name.includes(".prepare-"));
    if (preparationNames.length === 0) {
      const unknown = names.find((name) => !/^[a-f0-9]{20}$/.test(name));
      if (unknown) fail(`migration evidence root has unknown child '${unknown}'`);
      return undefined;
    }
    if (preparationNames.length > 1) fail("multiple migration preparations are ambiguous and cannot be resumed or cleaned automatically");
    if (names.length !== 1) fail(`migration preparation has unknown or final sibling '${names.find((name) => name !== preparationNames[0])}'`);

    const name = preparationNames[0];
    const match = /^\.([a-f0-9]{20})\.prepare-([a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/.exec(name);
    if (!match) fail(`migration preparation '${name}' has an invalid operation-scoped name`);
    const id = match[1];
    const relativePath = `${ENTITY_MIGRATION_ROOT}/${name}`;
    const expectedId = entityMigrationOperationId(current);
    const plan = "entries" in current && id === expectedId ? current : undefined;

    stageFd = openDirectory(parentFd, name, `migration preparation '${name}'`);
    const stageIdentity = fs.fstatSync(stageFd, { bigint: true });
    if (fs.readdirSync(fdPath(stageFd)).join("\0") !== "receipts") fail(`migration preparation '${name}' may contain only its receipts directory`);
    receiptsFd = openDirectory(stageFd, "receipts", `migration preparation '${name}' receipts`);
    const receiptNames = fs.readdirSync(fdPath(receiptsFd)).sort();
    const entityNames = receiptNames.filter((entry) => entry !== "marker.yaml");
    if (entityNames.some((entry, index) => entry !== `${String(index).padStart(4, "0")}.yaml`) || (receiptNames.includes("marker.yaml") && entityNames.length === 0)) fail(`migration preparation '${name}' has an invalid receipt inventory`);

    const targets: string[] = [];
    const inventory: InventoryEntry[] = [];
    for (const [index, receiptName] of entityNames.entries()) {
      const relativeReceipt = `${relativePath}/receipts/${receiptName}`;
      const observed = stableRegularFile(receiptsFd, receiptName, relativeReceipt);
      const text = observed.bytes.toString("utf8");
      if (plan) {
        const entry = plan.entries[index];
        if (!entry || text !== canonicalEntityEnvelopeBytes({ id: entry.proposed_target!.id, artifact: entry.artifact!, record: entry.record })) fail(`migration preparation '${name}' receipt '${receiptName}' does not match the approved operation`);
        targets.push(entry.proposed_target!.path);
      } else {
        const document = loadYamlMapping(text);
        const entityId = String(document.id ?? "");
        const artifact = String(document.artifact ?? "");
        const boundaries = entityBoundariesForArtifact(artifact).filter((boundary) => {
          try { canonicalEntityEnvelope(text, { artifact, boundary, id: entityId }); return true; } catch { return false; }
        });
        if (boundaries.length !== 1 || text !== canonicalEntityEnvelopeBytes({ id: entityId, artifact, record: document.record as never })) fail(`migration preparation '${name}' receipt '${receiptName}' is not one canonical entity envelope`);
        targets.push(`.agentera/entities/${artifact}/${boundaries[0]}/${entityId}.yaml`);
      }
      inventory.push(observed.inventory);
    }
    if (plan && entityNames.length > plan.entries.length) fail(`migration preparation '${name}' has receipts beyond the approved operation`);

    if (receiptNames.includes("marker.yaml")) {
      const relativeReceipt = `${relativePath}/receipts/marker.yaml`;
      const observed = stableRegularFile(receiptsFd, "marker.yaml", relativeReceipt);
      const text = observed.bytes.toString("utf8");
      const marker = loadYamlMapping(text);
      const markerValid = plan
        ? entityNames.length === plan.entries.length && text === markerBytes(id, plan)
        : marker.schemaVersion === "agentera.stateMode.v1" && marker.mode === "entities" && marker.migration_id === id
          && entityMigrationOperationId({ project: root.path, source_fingerprint: String(marker.source_fingerprint), preview_digest: String(marker.preview_digest) }) === id;
      if (!markerValid) fail(`migration preparation '${name}' marker receipt is invalid`);
      targets.push(ENTITY_MIGRATION_MARKER);
      inventory.push(observed.inventory);
    }

    if (pathExists(path.join(parentPath, id))) fail(`migration preparation '${name}' has final operation evidence`);
    if (pathExists(path.join(root.path, ENTITY_MIGRATION_MARKER))) fail(`migration preparation '${name}' has a canonical state marker`);
    if (pathExists(path.join(root.path, ".agentera/entities"))) fail(`migration preparation '${name}' has canonical entity state`);
    for (const target of targets) if (pathExists(path.join(root.path, target))) fail(`migration preparation '${name}' has canonical publication '${target}'`);

    if (fs.readdirSync(fdPath(stageFd)).join("\0") !== "receipts" || fs.readdirSync(fdPath(receiptsFd)).sort().join("\0") !== receiptNames.join("\0")) fail(`migration preparation '${name}' changed while inspected`);
    const reopened = openDirectory(parentFd, name, `migration preparation '${name}'`);
    try { if (!sameDirectory(stageIdentity, fs.fstatSync(reopened, { bigint: true }))) fail(`migration preparation '${name}' was replaced while inspected`); } finally { fs.closeSync(reopened); }
    for (const entry of parents) {
      const current = openDirectory(entry.parent, entry.name, `migration evidence path '${ENTITY_MIGRATION_ROOT}'`, "must be a real project directory and must not be a symbolic link");
      try { if (!sameDirectory(entry.identity, fs.fstatSync(current, { bigint: true }))) fail(`migration evidence path '${ENTITY_MIGRATION_ROOT}' changed while inspected`); } finally { fs.closeSync(current); }
    }
    if (!sameDirectory(parentIdentity, fs.fstatSync(parentFd, { bigint: true }))) fail(`migration preparation parent changed while inspected`);
    assertValidatedProjectRoot(root);

    return {
      name,
      id,
      relative_path: relativePath,
      directory: { dev: String(stageIdentity.dev), ino: String(stageIdentity.ino) },
      receipt_count: inventory.length,
      inventory_sha256: hash(canonicalRecordJson(inventory)),
      untracked_paths: inventory.map((entry) => entry.path),
      targets,
      classification: id === expectedId ? "same_operation" : "stale",
    };
  } catch (error) {
    if (error instanceof EntityMigrationPreparationInspectionError) throw error;
    return fail(`migration preparation is unsafe or changed while inspected: ${(error as Error).message}`);
  } finally {
    if (receiptsFd !== undefined) fs.closeSync(receiptsFd);
    if (stageFd !== undefined) fs.closeSync(stageFd);
    for (const entry of parents.reverse()) fs.closeSync(entry.fd);
    if (rootFd !== undefined) fs.closeSync(rootFd);
  }
}

function markerBytes(id: string, plan: Pick<DurableEntityMigrationPlan, "source_fingerprint" | "preview_digest">): string {
  return dumpYamlMapping({ schemaVersion: "agentera.stateMode.v1", mode: "entities", migration_id: id, source_fingerprint: plan.source_fingerprint, preview_digest: plan.preview_digest });
}
