import fs from "node:fs";
import path from "node:path";

import { observeLifecyclePath, publishLifecycleResource, removeLifecycleResource, verifyLifecycleResourceAtPublication, withPinnedLifecycleDirectory, type LifecyclePathObservation, type LifecyclePublicationBoundaryHook, type LifecyclePublicationKind } from "../runtime/lifecyclePublication.js";
import type { MigrationPhaseItem } from "./migrateArtifactsV2ToV3.js";

type EvidenceRole = "source" | "target";

interface TreeEntry {
  destination: string;
  kind: LifecyclePublicationKind;
  observation: LifecyclePathObservation;
}

interface MigrationMutationEvidence {
  resources: Partial<Record<EvidenceRole, TreeEntry>>;
  tree?: TreeEntry[];
}

const evidenceByItem = new WeakMap<MigrationPhaseItem, MigrationMutationEvidence>();
const MIGRATION_EVIDENCE = Symbol.for("agentera.migrationMutationEvidence");
type EvidenceItem = MigrationPhaseItem & { [MIGRATION_EVIDENCE]?: MigrationMutationEvidence };

function evidenceFor(item: MigrationPhaseItem): MigrationMutationEvidence {
  const existing = evidenceByItem.get(item) ?? (item as EvidenceItem)[MIGRATION_EVIDENCE];
  if (existing) return existing;
  const created: MigrationMutationEvidence = { resources: {} };
  evidenceByItem.set(item, created);
  (item as EvidenceItem)[MIGRATION_EVIDENCE] = created;
  return created;
}

function readEvidence(item: MigrationPhaseItem): MigrationMutationEvidence | undefined {
  return evidenceByItem.get(item) ?? (item as EvidenceItem)[MIGRATION_EVIDENCE];
}

export function cloneMigrationItem(item: MigrationPhaseItem): MigrationPhaseItem {
  const clone = { ...item };
  const evidence = readEvidence(item);
  if (evidence) {
    evidenceByItem.set(clone, evidence);
    (clone as EvidenceItem)[MIGRATION_EVIDENCE] = evidence;
  }
  return clone;
}

function observationError(destination: string, observation: LifecyclePathObservation, expectedKind: LifecyclePublicationKind): string | null {
  if (observation.unsafeReason) return observation.unsafeReason;
  if (!observation.parentComplete) return `parent chain is incomplete for ${destination}`;
  if (observation.kind !== expectedKind || !observation.identity || !observation.fingerprint) {
    return `${destination} is not an observable ${expectedKind}`;
  }
  return null;
}

export function bindMigrationResource(item: MigrationPhaseItem, role: EvidenceRole, destination: string, allowedRoots: string[], kind: LifecyclePublicationKind): string | null {
  const observation = observeLifecyclePath(destination, allowedRoots);
  const error = observationError(destination, observation, kind);
  if (error) return error;
  evidenceFor(item).resources[role] = { destination, kind, observation };
  return null;
}

function boundResource(item: MigrationPhaseItem, role: EvidenceRole): TreeEntry {
  const resource = readEvidence(item)?.resources[role];
  if (!resource) throw new Error(`migration ${role} publication evidence is missing`);
  return resource;
}

export function verifyBoundMigrationResource(item: MigrationPhaseItem, role: EvidenceRole): void {
  const resource = boundResource(item, role);
  verifyLifecycleResourceAtPublication({ id: `${item.action}.${role}`, destination: resource.destination, kind: resource.kind }, resource.observation);
}

export function withBoundMigrationDirectory<T>(item: MigrationPhaseItem, role: EvidenceRole, callback: (directoryPath: string) => T, hook?: LifecyclePublicationBoundaryHook): T {
  const resource = boundResource(item, role);
  if (resource.kind !== "directory") throw new Error(`migration ${role} is not a directory`);
  return withPinnedLifecycleDirectory({ id: `${item.action}.${role}`, destination: resource.destination, kind: "directory" }, resource.observation, callback, hook);
}

export function updateBoundMigrationFile(item: MigrationPhaseItem, role: EvidenceRole, content: string): void {
  const resource = boundResource(item, role);
  if (resource.kind !== "file") throw new Error(`migration ${role} is not a file`);
  publishLifecycleResource({ id: `${item.action}.${role}`, destination: resource.destination, kind: "file", content }, "update", resource.observation);
}

export function removeBoundMigrationResource(item: MigrationPhaseItem, role: EvidenceRole): void {
  const resource = boundResource(item, role);
  removeLifecycleResource({ id: `${item.action}.${role}`, destination: resource.destination, kind: resource.kind }, resource.observation);
}

function walkTree(root: string): Array<{ destination: string; kind: LifecyclePublicationKind }> {
  const entries: Array<{ destination: string; kind: LifecyclePublicationKind }> = [];
  const walk = (destination: string): void => {
    const stat = fs.lstatSync(destination);
    const kind: LifecyclePublicationKind = stat.isSymbolicLink()
      ? "symlink"
      : stat.isFile()
        ? "file"
        : stat.isDirectory()
          ? "directory"
          : (() => {
              throw new Error(`unsupported bundle entry type at ${destination}`);
            })();
    entries.push({ destination, kind });
    if (kind === "directory") {
      for (const name of fs.readdirSync(destination).sort()) walk(path.join(destination, name));
    }
  };
  walk(root);
  return entries;
}

export function bindMigrationTree(item: MigrationPhaseItem, root: string, allowedRoots: string[]): string | null {
  try {
    const tree = walkTree(root).map(({ destination, kind }) => {
      const observation = observeLifecyclePath(destination, allowedRoots);
      const error = observationError(destination, observation, kind);
      if (error) throw new Error(error);
      return { destination, kind, observation };
    });
    evidenceFor(item).tree = tree;
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

export function removeBoundMigrationTree(item: MigrationPhaseItem): void {
  const tree = readEvidence(item)?.tree;
  if (!tree) throw new Error("migration cleanup tree evidence is missing");
  const current = walkTree(tree[0]!.destination);
  if (current.length !== tree.length || current.some((entry, index) => entry.destination !== tree[index]?.destination || entry.kind !== tree[index]?.kind)) {
    throw new Error("managed app cleanup set changed after preview");
  }
  for (const entry of tree) {
    verifyLifecycleResourceAtPublication({ id: `${item.action}.verify`, destination: entry.destination, kind: entry.kind }, entry.observation);
  }
  for (const entry of [...tree].reverse()) {
    removeLifecycleResource({ id: `${item.action}.remove`, destination: entry.destination, kind: entry.kind }, entry.observation);
  }
}
