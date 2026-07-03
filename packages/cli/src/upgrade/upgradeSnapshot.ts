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
