import fs from "node:fs";
import path from "node:path";

import { pathExists } from "../core/paths.js";
import { writeFileAtomic } from "./atomicWriter.js";

const SNAPSHOT_PREFIX = "upgrade-snapshot-";
const MANIFEST_NAME = "upgrade-snapshot-latest.json";

export function snapshotDirectory(src: string, dest: string): void {
  if (!pathExists(src)) {
    return;
  }
  fs.cpSync(src, dest, { recursive: true });
}

export function upgradeSnapshotManifestPath(appHome: string): string {
  return path.join(appHome, ".agentera", MANIFEST_NAME);
}

export function snapshotManagedApp(src: string, appHome: string): string | null {
  if (!pathExists(src)) {
    return null;
  }
  const agenteraDir = path.join(appHome, ".agentera");
  fs.mkdirSync(agenteraDir, { recursive: true });
  const timestamp = Date.now();
  const snapshotDir = path.join(agenteraDir, `${SNAPSHOT_PREFIX}${timestamp}`);
  snapshotDirectory(src, snapshotDir);
  const manifest = JSON.stringify({
    path: snapshotDir,
    created: new Date(timestamp).toISOString(),
    source: src,
  });
  writeFileAtomic(upgradeSnapshotManifestPath(appHome), manifest);
  return snapshotDir;
}

export function removeUpgradeSnapshot(appHome: string, snapshotDir: string): void {
  if (pathExists(snapshotDir)) {
    fs.rmSync(snapshotDir, { recursive: true, force: true });
  }
  const manifestPath = upgradeSnapshotManifestPath(appHome);
  if (pathExists(manifestPath)) {
    fs.rmSync(manifestPath, { force: true });
  }
}

export interface RestoreResult {
  restored: boolean;
  source: string | null;
  snapshotDir: string | null;
  created: string | null;
  fileCount: number;
}

interface SnapshotManifest {
  path?: string;
  created?: string;
  source?: string;
}

function countFilesRecursive(root: string): number {
  let count = 0;
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else count += 1;
    }
  };
  visit(root);
  return count;
}

function emptyRestore(): RestoreResult {
  return { restored: false, source: null, snapshotDir: null, created: null, fileCount: 0 };
}

export function restoreFromSnapshot(appHome: string): RestoreResult {
  const manifestPath = upgradeSnapshotManifestPath(appHome);
  if (!pathExists(manifestPath)) {
    return emptyRestore();
  }
  let manifest: SnapshotManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as SnapshotManifest;
  } catch {
    return emptyRestore();
  }
  const snapshotDir = manifest.path ?? null;
  const source = manifest.source ?? null;
  const created = manifest.created ?? null;
  if (!snapshotDir || !source) {
    return { restored: false, source, snapshotDir, created, fileCount: 0 };
  }
  if (source === appHome || path.relative(appHome, source) === "") {
    return { restored: false, source, snapshotDir, created, fileCount: 0 };
  }
  if (!pathExists(snapshotDir)) {
    removeUpgradeSnapshot(appHome, snapshotDir);
    return { restored: false, source, snapshotDir, created, fileCount: 0 };
  }
  if (pathExists(source)) {
    fs.rmSync(source, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.cpSync(snapshotDir, source, { recursive: true });
  const fileCount = countFilesRecursive(source);
  removeUpgradeSnapshot(appHome, snapshotDir);
  return { restored: true, source, snapshotDir, created, fileCount };
}
