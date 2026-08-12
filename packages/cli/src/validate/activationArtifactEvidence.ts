import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ACTIVATION_CANONICAL_TUPLES } from "../registries/activationTuples.js";
import { loadRegistry } from "../registries/packageRegistry.js";
import {
  packageCommandDeclarations,
  packageDescriptorSemantics,
  packageDescriptors,
} from "./activationPackageSemantics.js";
import {
  GENERATED_OWNER_EVIDENCE_SCHEMA,
  OWNER_EVIDENCE_MAX_BYTES,
  PACKAGE_IDENTITY_MAX_BYTES,
  PACKAGE_IDENTITY_SCHEMA,
  PACKAGE_OWNER_EVIDENCE_SCHEMA,
  PACKAGE_SNAPSHOT_DIRECTORY,
  PACKAGE_SNAPSHOT_EXTRACTED_MAX_BYTES,
  PACKAGE_SNAPSHOT_MARKER_MAX_BYTES,
  PACKAGE_SNAPSHOT_MAX_ENTRIES,
  PACKAGE_SNAPSHOT_SCHEMA,
  PACKAGE_SNAPSHOT_TARBALL_MAX_BYTES,
  SOURCE_OWNER_EVIDENCE_SCHEMA,
  type ActivationArtifactRecord,
  type ActivationOwnerEvidence,
  type ActivationPackageArtifactIdentity,
  type ActivationPackageIdentity,
  type ActivationProducerKind,
  type FinalizedPackageOwnerEvidence,
  type SourcePackageExecutionEvidence,
} from "./activationArtifactEvidenceTypes.js";
import { bootstrapMatrixAuthority } from "./bootstrapAuthority.js";
export * from "./activationArtifactEvidenceTypes.js";

interface CompleteTreeEntry {
  path: string;
  type: "directory" | "file" | "symlink";
  mode: number;
  size?: number;
  sha256?: string;
  targetSha256?: string;
}

interface CompleteTreeObservation {
  entries: CompleteTreeEntry[];
  digest: string;
  fileCount: number;
  totalBytes: number;
}

interface TreeObservationOptions {
  allowSymlinks?: boolean;
  maxEntries?: number;
  maxTotalBytes?: number;
}

interface PackageSnapshotMarker {
  schemaVersion: typeof PACKAGE_SNAPSHOT_SCHEMA;
  packageArtifact: ActivationPackageArtifactIdentity;
  tarballTree: { count: number; digest: string; fileCount: number; totalBytes: number };
  snapshotDigest: string;
}

const sourceCapabilityCache = new Map<string, { modules: Record<string, string>; runtimeRegistry: Record<string, string>; routes: string[] }>();

interface CapabilityBodies {
  identities: string[];
  bodies: Record<string, { sha256: string; bytes: number }>;
}

interface CapabilityProjection {
  modules: CapabilityBodies;
  runtimeRegistry: CapabilityBodies;
  served?: CapabilityBodies;
  registry: string[];
  routes: string[];
  schemas: string[];
  startupProducers?: Array<{ path: string; value: string }>;
  artifacts: Record<string, string>;
}

const CAPABILITY_IDS = Object.freeze(ACTIVATION_CANONICAL_TUPLES
  .filter((tuple) => tuple.class === "capability")
  .map((tuple) => tuple.surface_id)
  .sort());

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, canonical(object[key])]));
  }
  return value;
}

export function canonicalObservationJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

export function observationDigest(value: unknown): string {
  return createHash("sha256").update(canonicalObservationJson(value), "utf8").digest("hex");
}

function fileSha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function artifactDigest(root: string, relatives: readonly string[]): string {
  return observationDigest([...relatives].sort().map((relative) => ({
    path: relative.split(path.sep).join("/"),
    sha256: fs.existsSync(path.join(root, relative)) && fs.statSync(path.join(root, relative)).isFile()
      ? fileSha256(path.join(root, relative))
      : "missing",
  })));
}

function filesBelow(root: string, relative = ""): string[] {
  const directory = path.join(root, relative);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) return [];
    return entry.isDirectory() ? filesBelow(root, child) : [child];
  });
}

function completeTreeObservation(root: string, options: TreeObservationOptions = {}): CompleteTreeObservation {
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("authoritative extracted package root is not a directory");
  const entries: CompleteTreeEntry[] = [];
  let fileCount = 0;
  let totalBytes = 0;
  const visit = (directory: string): void => {
    const directoryPath = path.join(root, directory);
    const directoryBefore = fs.lstatSync(directoryPath);
    const names = fs.readdirSync(directoryPath).sort();
    for (const name of names) {
      const relative = path.join(directory, name);
      const target = path.join(root, relative);
      const stat = fs.lstatSync(target);
      const normalized = relative.split(path.sep).join("/");
      if (normalized.length > 512 || /[\0\r\n]/.test(normalized)) throw new Error("authoritative extracted package path violates its bound");
      if (entries.length >= (options.maxEntries ?? PACKAGE_SNAPSHOT_MAX_ENTRIES)) throw new Error("authoritative extracted package exceeds its entry bound");
      if (stat.isDirectory()) {
        entries.push({ path: normalized, type: "directory", mode: stat.mode & 0o777 });
        visit(relative);
      } else if (stat.isFile()) {
        const bytes = readBoundedRegularFile(target, Math.max(0, (options.maxTotalBytes ?? PACKAGE_SNAPSHOT_EXTRACTED_MAX_BYTES) - totalBytes), true, stat);
        fileCount += 1;
        totalBytes += bytes.length;
        if (totalBytes > (options.maxTotalBytes ?? PACKAGE_SNAPSHOT_EXTRACTED_MAX_BYTES)) throw new Error("authoritative extracted package exceeds its byte bound");
        entries.push({
          path: normalized,
          type: "file",
          mode: stat.mode & 0o777,
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      } else if (stat.isSymbolicLink()) {
        if (options.allowSymlinks === false) throw new Error("authoritative extracted package contains a symlink");
        entries.push({
          path: normalized,
          type: "symlink",
          mode: stat.mode & 0o777,
          targetSha256: observationDigest(fs.readlinkSync(target)),
        });
      } else {
        throw new Error(`authoritative extracted package contains unsupported entry '${normalized}'`);
      }
    }
    const directoryAfter = fs.lstatSync(directoryPath);
    if (names.join("\0") !== fs.readdirSync(directoryPath).sort().join("\0")
      || directoryBefore.dev !== directoryAfter.dev || directoryBefore.ino !== directoryAfter.ino
      || directoryBefore.mtimeMs !== directoryAfter.mtimeMs) {
      throw new Error("authoritative extracted package changed while it was observed");
    }
  };
  visit("");
  return { entries, digest: observationDigest(entries), fileCount, totalBytes };
}

function readBoundedRegularFile(
  file: string,
  maximumBytes: number,
  allowEmpty = false,
  expected?: fs.Stats,
): Buffer {
  const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || (!allowEmpty && before.size <= 0) || before.size > maximumBytes
      || (expected && (expected.dev !== before.dev || expected.ino !== before.ino))) {
      throw new Error("authoritative package file violates its regular-file or byte bound");
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (bytes.length !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error("authoritative package tarball changed while it was read");
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function packageArtifactIdentity(filename: string, bytes: Buffer): ActivationPackageArtifactIdentity {
  return {
    filename,
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    shasum: createHash("sha1").update(bytes).digest("hex"),
    tarballSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function preflightPackageBytes(bytes: Buffer): void {
  const listed = spawnSync("tar", ["-tvzf", "-", "--numeric-owner", "--full-time"], {
    input: bytes,
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30_000,
    maxBuffer: PACKAGE_SNAPSHOT_MAX_ENTRIES * 2_048,
  });
  if (listed.status !== 0) throw new Error("authoritative package tarball cannot be listed");
  const lines = listed.stdout.trimEnd() === "" ? [] : listed.stdout.trimEnd().split("\n");
  if (lines.length < 1 || lines.length > PACKAGE_SNAPSHOT_MAX_ENTRIES) throw new Error("authoritative package tarball violates its entry bound");
  let totalBytes = 0;
  for (const line of lines) {
    const columns = line.trim().split(/\s+/);
    const size = Number(columns[2]);
    if (line.length > 2_048 || !["-", "d"].includes(line[0] ?? "") || !Number.isSafeInteger(size) || size < 0) {
      throw new Error("authoritative package tarball listing is malformed or contains an unsupported entry");
    }
    totalBytes += size;
    if (totalBytes > PACKAGE_SNAPSHOT_EXTRACTED_MAX_BYTES) throw new Error("authoritative package tarball exceeds its extracted byte bound");
  }
}

function extractPackageBytes(bytes: Buffer, temporary: string): string {
  preflightPackageBytes(bytes);
  const extracted = spawnSync("tar", ["-xzf", "-", "-C", temporary], {
    input: bytes,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30_000,
    maxBuffer: 65_536,
  });
  if (extracted.status !== 0) throw new Error("authoritative package tarball cannot be extracted");
  const topLevel = fs.readdirSync(temporary, { withFileTypes: true });
  if (topLevel.length !== 1 || topLevel[0]?.name !== "package" || !topLevel[0].isDirectory() || topLevel[0].isSymbolicLink()) {
    throw new Error("authoritative package tarball has an invalid package root");
  }
  return path.join(temporary, "package");
}

function snapshotMarker(
  artifact: ActivationPackageArtifactIdentity,
  tree: CompleteTreeObservation,
): PackageSnapshotMarker {
  const unsigned: Omit<PackageSnapshotMarker, "snapshotDigest"> = {
    schemaVersion: PACKAGE_SNAPSHOT_SCHEMA,
    packageArtifact: artifact,
    tarballTree: { count: tree.entries.length, digest: tree.digest, fileCount: tree.fileCount, totalBytes: tree.totalBytes },
  };
  return { ...unsigned, snapshotDigest: observationDigest(unsigned) };
}

function writeRetainedPackageSnapshot(
  directory: string,
  bytes: Buffer,
  packageRoot: string,
  artifact: ActivationPackageArtifactIdentity,
  tree: CompleteTreeObservation,
): void {
  const parent = path.dirname(path.resolve(directory));
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentReal = fs.realpathSync(parent);
  const target = path.join(parentReal, path.basename(directory));
  if (path.resolve(directory) !== target || fs.existsSync(target)) throw new Error("retained package snapshot target is not a new direct child of its parent");
  const staging = `${target}.${process.pid}.tmp`;
  fs.mkdirSync(staging, { mode: 0o700 });
  try {
    fs.writeFileSync(path.join(staging, "package.tgz"), bytes, { flag: "wx", mode: 0o600 });
    fs.cpSync(packageRoot, path.join(staging, "extracted"), { recursive: true, verbatimSymlinks: true });
    const marker = snapshotMarker(artifact, tree);
    const markerBytes = `${canonicalObservationJson(marker)}\n`;
    if (Buffer.byteLength(markerBytes, "utf8") > PACKAGE_SNAPSHOT_MARKER_MAX_BYTES) throw new Error("retained package snapshot marker exceeds its byte bound");
    fs.writeFileSync(path.join(staging, "snapshot.json"), markerBytes, { flag: "wx", mode: 0o600 });
    fs.renameSync(staging, target);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

export function observeCurrentPackageArtifact(tarball: string, extractedRoot: string, snapshotDirectory?: string): any {
  const bytes = readBoundedRegularFile(tarball, PACKAGE_SNAPSHOT_TARBALL_MAX_BYTES);
  const packageArtifact: ActivationPackageArtifactIdentity = {
    ...packageArtifactIdentity(path.basename(tarball), bytes),
  };
  const extractedTree = completeTreeObservation(extractedRoot, { allowSymlinks: true });
  const temporary = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "activation-tarball-tree-"));
  let tarballTree: CompleteTreeObservation;
  try {
    const packageRoot = extractPackageBytes(bytes, temporary);
    tarballTree = completeTreeObservation(packageRoot, { allowSymlinks: false });
    if (snapshotDirectory) writeRetainedPackageSnapshot(snapshotDirectory, bytes, packageRoot, packageArtifact, tarballTree);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  const runtimeSupportPaths = extractedTree.entries
    .filter((entry) => entry.path === "node_modules" && entry.type === "symlink")
    .map((entry) => entry.path);
  const extractedPayload = extractedTree.entries.filter((entry) => !runtimeSupportPaths.includes(entry.path));
  if (canonicalObservationJson(extractedPayload) !== canonicalObservationJson(tarballTree.entries)) {
    throw new Error("authoritative extracted package tree does not exactly match the current tarball payload");
  }
  return { ...packageArtifact, extractedTree, tarballTree, runtimeSupportPaths };
}

function packageSnapshotRootViolations(snapshotRoot: string, expectedIdentity: unknown, allowedRoot?: string): string[] {
  const invalid = "retained package snapshot differs from the independently retained package identity";
  if (activationPackageIdentityViolations(expectedIdentity).length > 0) return [invalid];
  const identity = expectedIdentity as ActivationPackageIdentity;
  let temporary: string | undefined;
  try {
    const snapshotStat = fs.lstatSync(snapshotRoot);
    if (!snapshotStat.isDirectory() || snapshotStat.isSymbolicLink()) return [invalid];
    const snapshotReal = fs.realpathSync(snapshotRoot);
    if (snapshotReal !== path.resolve(snapshotRoot)) return [invalid];
    if (allowedRoot) {
      const rootStat = fs.lstatSync(allowedRoot);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return [invalid];
      const rootReal = fs.realpathSync(allowedRoot);
      if (snapshotReal !== path.join(rootReal, PACKAGE_SNAPSHOT_DIRECTORY)) return [invalid];
    }
    const entries = fs.readdirSync(snapshotReal, { withFileTypes: true });
    if (entries.map((entry) => entry.name).sort().join("\0") !== ["extracted", "package.tgz", "snapshot.json"].join("\0")
      || entries.some((entry) => entry.isSymbolicLink())) return [invalid];
    const markerBytes = readBoundedRegularFile(path.join(snapshotReal, "snapshot.json"), PACKAGE_SNAPSHOT_MARKER_MAX_BYTES);
    const marker = JSON.parse(markerBytes.toString("utf8")) as PackageSnapshotMarker;
    const { snapshotDigest, ...unsignedMarker } = marker;
    if (Object.keys(marker).sort().join("\0") !== ["packageArtifact", "schemaVersion", "snapshotDigest", "tarballTree"].join("\0")
      || Object.keys(marker.packageArtifact ?? {}).sort().join("\0") !== ["filename", "integrity", "shasum", "tarballSha256"].join("\0")
      || Object.keys(marker.tarballTree ?? {}).sort().join("\0") !== ["count", "digest", "fileCount", "totalBytes"].join("\0")
      || marker.schemaVersion !== PACKAGE_SNAPSHOT_SCHEMA || snapshotDigest !== observationDigest(unsignedMarker)) return [invalid];
    const tarballBytes = readBoundedRegularFile(path.join(snapshotReal, "package.tgz"), PACKAGE_SNAPSHOT_TARBALL_MAX_BYTES);
    const artifact = packageArtifactIdentity(identity.packageArtifact.filename, tarballBytes);
    const extractedTree = completeTreeObservation(path.join(snapshotReal, "extracted"), { allowSymlinks: false });
    temporary = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "activation-snapshot-check-"));
    const reextractedRoot = extractPackageBytes(tarballBytes, temporary);
    const tarballTree = completeTreeObservation(reextractedRoot, { allowSymlinks: false });
    const treeSummary = { count: tarballTree.entries.length, digest: tarballTree.digest };
    if (canonicalObservationJson(artifact) !== canonicalObservationJson(identity.packageArtifact)
      || canonicalObservationJson(treeSummary) !== canonicalObservationJson(identity.tarballTree)
      || canonicalObservationJson(extractedTree.entries) !== canonicalObservationJson(tarballTree.entries)
      || canonicalObservationJson(marker.packageArtifact) !== canonicalObservationJson(identity.packageArtifact)
      || marker.tarballTree.count !== tarballTree.entries.length
      || marker.tarballTree.digest !== tarballTree.digest
      || marker.tarballTree.fileCount !== tarballTree.fileCount
      || marker.tarballTree.totalBytes !== tarballTree.totalBytes) return [invalid];
    return [];
  } catch {
    return [invalid];
  } finally {
    if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
  }
}

export function retainedPackageSnapshotViolations(generationRoot: string, expectedIdentity: unknown): string[] {
  return packageSnapshotRootViolations(
    path.join(path.resolve(generationRoot), PACKAGE_SNAPSHOT_DIRECTORY),
    expectedIdentity,
    generationRoot,
  );
}

export function installRetainedPackageSnapshot(
  sourceSnapshot: string,
  generationRoot: string,
  expectedIdentity: ActivationPackageIdentity,
): { schemaVersion: typeof PACKAGE_SNAPSHOT_SCHEMA; path: typeof PACKAGE_SNAPSHOT_DIRECTORY; identityDigest: string } {
  const sourceViolations = packageSnapshotRootViolations(sourceSnapshot, expectedIdentity);
  if (sourceViolations.length > 0) throw new Error(sourceViolations[0]);
  const generationStat = fs.lstatSync(generationRoot);
  if (!generationStat.isDirectory() || generationStat.isSymbolicLink()) throw new Error("authoritative generation root is not a regular directory");
  const generationReal = fs.realpathSync(generationRoot);
  if (generationReal !== path.resolve(generationRoot)) throw new Error("authoritative generation root realpath drifted");
  const target = path.join(generationReal, PACKAGE_SNAPSHOT_DIRECTORY);
  if (!fs.existsSync(target)) {
    const staging = `${target}.${process.pid}.tmp`;
    fs.cpSync(sourceSnapshot, staging, { recursive: true, verbatimSymlinks: true, errorOnExist: true });
    try {
      const copiedViolations = packageSnapshotRootViolations(staging, expectedIdentity);
      if (copiedViolations.length > 0) throw new Error(copiedViolations[0]);
      fs.renameSync(staging, target);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }
  const installedViolations = retainedPackageSnapshotViolations(generationReal, expectedIdentity);
  if (installedViolations.length > 0) throw new Error(installedViolations[0]);
  return { schemaVersion: PACKAGE_SNAPSHOT_SCHEMA, path: PACKAGE_SNAPSHOT_DIRECTORY, identityDigest: expectedIdentity.identityDigest };
}

export function removeRetainedPackageSnapshot(generationRoot: string): void {
  const generationReal = fs.realpathSync(generationRoot);
  const target = path.join(generationReal, PACKAGE_SNAPSHOT_DIRECTORY);
  if (path.dirname(target) !== generationReal) throw new Error("retained package snapshot cleanup escaped its generation root");
  fs.rmSync(target, { recursive: true, force: true });
}

function bodyObservation(bodies: Record<string, string>): CapabilityBodies {
  return {
    identities: Object.keys(bodies).sort(),
    bodies: Object.fromEntries(Object.entries(bodies).sort(([left], [right]) => left.localeCompare(right)).map(([id, body]) => [id, {
      sha256: createHash("sha256").update(body, "utf8").digest("hex"),
      bytes: Buffer.byteLength(body, "utf8"),
    }])),
  };
}

function registryCapabilities(file: string): string[] {
  const registry = JSON.parse(fs.readFileSync(file, "utf8"));
  return [...(registry?.skills?.[0]?.capabilities ?? [])].sort();
}

function schemaCapabilities(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => ["triggers.yaml", "artifacts.yaml", "validation.yaml", "exit.yaml"]
      .every((file) => fs.existsSync(path.join(root, entry.name, "schemas", file))))
    .map((entry) => entry.name)
    .sort();
}

export function loadSourceCapabilityInstructions(root: string): { modules: Record<string, string>; runtimeRegistry: Record<string, string>; routes: string[] } {
  const cacheKey = `${root}\0${activationSourceDigest(root)}`;
  const cached = sourceCapabilityCache.get(cacheKey);
  if (cached) return structuredClone(cached);
  const script = path.join(root, "packages/cli/scripts/observe-capability-source.mjs");
  const result = spawnSync(process.execPath, [script, root], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  if (result.status !== 0) throw new Error(`source capability observation failed: ${(result.stderr || result.stdout).trim()}`);
  const observed = JSON.parse(result.stdout) as { modules: Record<string, string>; runtimeRegistry: Record<string, string>; routes: string[] };
  sourceCapabilityCache.set(cacheKey, observed);
  return structuredClone(observed);
}

function sourceProjection(root: string): CapabilityProjection {
  const parsed = loadSourceCapabilityInstructions(root);
  const schemaRoot = path.join(root, "skills/agentera/capabilities");
  const moduleFiles = CAPABILITY_IDS.map((id) => `packages/cli/src/capabilities/${id}/instructions.ts`);
  const schemaFiles = filesBelow(root, "skills/agentera/capabilities");
  return {
    modules: bodyObservation(parsed.modules),
    runtimeRegistry: bodyObservation(parsed.runtimeRegistry),
    registry: registryCapabilities(path.join(root, "registry.json")),
    routes: [...parsed.routes].sort(),
    schemas: schemaCapabilities(schemaRoot),
    artifacts: {
      modules: artifactDigest(root, moduleFiles),
      runtimeRegistry: artifactDigest(root, [...moduleFiles, "packages/cli/src/capabilities/index.ts"]),
      registry: artifactDigest(root, ["registry.json"]),
      routes: artifactDigest(root, ["packages/cli/src/cli/commands/capability.ts"]),
      schemas: artifactDigest(root, schemaFiles),
    },
  };
}

function runtimeArtifactObservation(
  runtimeRoot: string,
  projectRoot: string,
  sourceRoot: string,
  mode: "full" | "package-smoke" = "full",
): { projection: CapabilityProjection; bootstrap: unknown } {
  const script = path.join(sourceRoot, "packages/cli/scripts/observe-runtime-artifact.mjs");
  const result = spawnSync(process.execPath, [script, runtimeRoot, projectRoot, mode], {
    cwd: projectRoot,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  if (result.status !== 0) throw new Error(`runtime artifact observation failed: ${(result.stderr || result.stdout).trim()}`);
  const parsed = JSON.parse(result.stdout) as {
    capabilities: { modules: Record<string, string>; runtimeRegistry: Record<string, string>; served: Record<string, string>; routes: string[]; startupProducers: Array<{ path: string; value: string }> };
    bootstrap: unknown;
  };
  const registryFile = path.join(runtimeRoot, "bundle/registry.json");
  const schemaRelative = "bundle/skills/agentera/capabilities";
  const schemaRoot = path.join(runtimeRoot, schemaRelative);
  const moduleFiles = CAPABILITY_IDS.map((id) => `dist/capabilities/${id}/instructions.js`);
  return { bootstrap: parsed.bootstrap, projection: {
    modules: bodyObservation(parsed.capabilities.modules),
    runtimeRegistry: bodyObservation(parsed.capabilities.runtimeRegistry),
    served: bodyObservation(parsed.capabilities.served),
    registry: registryCapabilities(registryFile),
    routes: [...parsed.capabilities.routes].sort(),
    schemas: schemaCapabilities(schemaRoot),
    startupProducers: parsed.capabilities.startupProducers,
    artifacts: {
      modules: artifactDigest(runtimeRoot, moduleFiles),
      runtimeRegistry: artifactDigest(runtimeRoot, [...moduleFiles, "dist/capabilities/index.js"]),
      served: artifactDigest(runtimeRoot, ["dist/bin/agentera.js"]),
      registry: artifactDigest(runtimeRoot, ["bundle/registry.json"]),
      routes: artifactDigest(runtimeRoot, ["dist/cli/commands/capability.js"]),
      schemas: artifactDigest(runtimeRoot, filesBelow(runtimeRoot, schemaRelative)),
      startupProducers: artifactDigest(runtimeRoot, ["dist/bin/agentera.js", "bundle/skills/agentera/SKILL.md"]),
    },
  } };
}

function runtimeProjection(
  runtimeRoot: string,
  projectRoot: string,
  sourceRoot: string,
  mode: "full" | "package-smoke" = "full",
): CapabilityProjection {
  return runtimeArtifactObservation(runtimeRoot, projectRoot, sourceRoot, mode).projection;
}

function createRecord(
  producerKind: ActivationProducerKind,
  artifactClass: string,
  artifactIdentity: string,
  artifactContentDigest: string,
  content: unknown,
  generation: string | null,
  packageIntegrity: string | null,
): ActivationArtifactRecord {
  return {
    producerKind,
    artifactClass,
    artifactIdentity,
    artifactContentDigest,
    generation,
    packageIntegrity,
    content,
    observationDigest: observationDigest(content),
  };
}

function finishEvidence(value: Omit<ActivationOwnerEvidence, "evidenceDigest">): ActivationOwnerEvidence {
  return { ...value, evidenceDigest: observationDigest(value) };
}

function packageManifestSummary(files: readonly { path: string; size: number; mode: number }[]): { count: number; digest: string } {
  const normalized = [...files]
    .map(({ path: file, size, mode }) => ({ path: file, size, mode }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return { count: normalized.length, digest: observationDigest(normalized) };
}

function packageRecord(root: string): any {
  return loadRegistry(path.join(root, "references/adapters/package-registry.yaml"), root).get("agentera");
}

export function activationSourceDigest(root: string): string {
  const files = new Set([
    "registry.json",
    "references/adapters/package-registry.yaml",
    "references/meta/retained-reference-authority.yaml",
    "skills/agentera/capability_schema_contract.yaml",
    ...ACTIVATION_CANONICAL_TUPLES.map((tuple) => tuple.owner_path),
  ]);
  return observationDigest([...files].sort().map((file) => ({ path: file, sha256: fs.existsSync(path.join(root, file)) ? fileSha256(path.join(root, file)) : "missing" })));
}

const runtimeAuthority = ["references", "adapters", "runtime-lifecycle-authority.yaml"].join("/");
const retiredAuthority = ["references", "adapters", "runtime-retired-resources.yaml"].join("/");
const GENERIC_SOURCE_ARTIFACTS: Record<string, string[]> = {
  "cli.discovery": ["packages/cli/src/cli/dispatch/commands.ts"],
  "cli.behavior": ["packages/cli/src/cli/dispatch/index.ts"],
  "cli.diagnostics": ["packages/cli/src/cli/dispatch/projections.ts", "packages/cli/src/cli/dispatch/commands.ts"],
  "cli.instructions": ["packages/cli/src/cli/help.ts"],
  "cli.adversarial": ["packages/cli/src/cli/dispatch/commands.ts", "packages/cli/src/cli/errors.ts"],
  "runtime.discovery": [runtimeAuthority, retiredAuthority],
  "runtime.behavior": [runtimeAuthority, retiredAuthority, "packages/cli/src/runtime/nativeResourceCleanup.ts"],
  "runtime.diagnostics": [retiredAuthority, "packages/cli/src/runtime/nativeResourceCleanup.ts"],
  "runtime.instructions": [runtimeAuthority, retiredAuthority],
  "runtime.adversarial": [runtimeAuthority, retiredAuthority],
  "reference.discovery": ["references/meta/retained-reference-authority.yaml"],
  "reference.behavior": ["references/meta/retained-reference-authority.yaml"],
  "reference.diagnostics": ["references/meta/retained-reference-authority.yaml"],
  "reference.instructions": ["references/meta/retained-reference-authority.yaml"],
  "reference.adversarial": ["references/meta/retained-reference-authority.yaml"],
  "state.discovery": ["packages/cli/src/state/entityListRuntimeRegistry.ts", "packages/cli/src/state/write/runtimeOperations.ts"],
  "state.behavior": ["packages/cli/src/state/entityListRuntimeRegistry.ts", "packages/cli/src/state/write/runtimeOperations.ts"],
  "state.diagnostics": ["packages/cli/src/state/write/runtimeOperations.ts", "packages/cli/src/state/entityListRuntimeRegistry.ts"],
  "state.instructions": ["packages/cli/src/state/entityRetrievalHelp.ts", "packages/cli/src/state/write/runtimeOperations.ts"],
  "state.adversarial": ["packages/cli/src/state/entityListRuntimeRegistry.ts", "packages/cli/src/state/write/runtimeOperations.ts"],
};

function genericDimensionObservation(classId: string, dimension: string, input: any): unknown {
  if (classId === "cli") {
    if (dimension === "discovery") return { commands: input.commands };
    if (dimension === "behavior") return { dispatchSourceDigest: observationDigest(input.dispatchSource), capabilityRoutes: input.capabilityRoutes };
    if (dimension === "diagnostics") return { diagnosticCommands: input.commands, runtimeCommands: input.runtimeDiagnosticCommands };
    if (dimension === "instructions") return { helpDigest: observationDigest(input.helpText), declaredCommands: input.declaredCommands };
    return { commandClassifications: input.commands.map((command: string) => ({ command, safe: !/\s|[;&|]/.test(command) })) };
  }
  if (classId === "runtime") {
    const resources = input.retired.resources;
    const diagnostics = input.retired.diagnosticResources;
    if (dimension === "discovery") return { lifecycleSource: input.lifecycle.sourcePath, runtimeIds: input.lifecycle.runtimes.map((entry: any) => entry.id), resources: resources.map((entry: any) => ({ host: entry.host, id: entry.id })) };
    if (dimension === "behavior") return { hosts: resources.map((entry: any) => ({ host: entry.host, support: entry.hostSupportStatus, safety: entry.safetyNote })), diagnosticDestinations: diagnostics.map((entry: any) => ({ id: entry.id, destinations: entry.destinations })) };
    if (dimension === "diagnostics") return { durableProof: resources.map((entry: any) => ({ host: entry.host, proof: entry.durableProof })), diagnosticIds: diagnostics.map((entry: any) => ({ id: entry.id, names: entry.names })) };
    if (dimension === "instructions") return { canonicalSkillPath: input.lifecycle.canonicalSkillPath, safetyNotes: resources.map((entry: any) => ({ host: entry.host, safety: entry.safetyNote })) };
    return { resourceShapes: resources.map((entry: any) => ({ host: entry.host, safe: /^[A-Za-z0-9._:-]+$/.test(entry.host) })), diagnosticShapes: diagnostics.map((entry: any) => ({ id: entry.id, bounded: !/[\0\r\n]/.test(entry.id) })) };
  }
  if (classId === "reference") {
    const inventory = input.inventory;
    if (dimension === "discovery") return inventory.map((entry: any) => ({ path: entry.path, classification: entry.classification }));
    if (dimension === "behavior") return inventory.map((entry: any) => ({ path: entry.path, consumers: entry.consumers ?? null, command: entry.command ?? null }));
    if (dimension === "diagnostics") return inventory.map((entry: any) => ({ path: entry.path, owner: entry.production_owner ?? null, maintainer: entry.maintainer ?? null }));
    if (dimension === "instructions") return inventory.map((entry: any) => ({ path: entry.path, modules: (entry.consumers ?? []).map((consumer: any) => [consumer.module, consumer.symbol]), command: entry.command ?? null }));
    return inventory.map((entry: any) => ({ path: entry.path, ownerShape: entry.production_owner ? [entry.production_owner.module, entry.production_owner.symbol] : null, commandSafe: entry.command ? !/[\0\r\n]/.test(entry.command) : true }));
  }
  const reads = input.readFamilies;
  const writes = input.operations;
  if (dimension === "discovery") return { reads: reads.map((entry: any) => entry.key), writes: writes.map((entry: any) => `${entry.artifact}.${entry.verb}`) };
  if (dimension === "behavior") return { reads: reads.map((entry: any) => ({ key: entry.key, tokens: entry.commandTokens })), writes: writes.map((entry: any) => ({ id: `${entry.artifact}.${entry.verb}`, inputMode: entry.inputMode })) };
  if (dimension === "diagnostics") return { bounds: input.bounds, recovery: writes.map((entry: any) => ({ id: `${entry.artifact}.${entry.verb}`, recovery: entry.projection.recovery.runtime })) };
  if (dimension === "instructions") return { help: input.helpFamilies, examples: writes.map((entry: any) => ({ id: `${entry.artifact}.${entry.verb}`, examples: entry.projection.examples })) };
  return { bounds: input.bounds, inputBounds: writes.map((entry: any) => ({ id: `${entry.artifact}.${entry.verb}`, bytes: entry.inputMaxBytes, formats: entry.projection.formatValues })) };
}

export function createSourceOwnerEvidence(
  root: string,
  productionInputs?: any,
  packageExecution?: SourcePackageExecutionEvidence,
): ActivationOwnerEvidence {
  const capabilities = sourceProjection(root);
  const record = packageRecord(root);
  const records: Record<string, ActivationArtifactRecord> = {
    "capability.source-modules": createRecord("source-owner", "capability-source-modules", "packages/cli/src/capabilities/*/instructions.ts", capabilities.artifacts.modules, capabilities.modules, null, null),
    "capability.source-runtime-registry": createRecord("source-owner", "capability-source-runtime-registry", "packages/cli/src/capabilities/index.ts#CAPABILITY_INSTRUCTIONS", capabilities.artifacts.runtimeRegistry, capabilities.runtimeRegistry, null, null),
    "capability.source-registry": createRecord("source-owner", "capability-source-registry", "registry.json#skills[0].capabilities", capabilities.artifacts.registry, capabilities.registry, null, null),
    "capability.source-routes": createRecord("source-owner", "capability-source-routes", "packages/cli/src/cli/commands/capability.ts#CAPABILITY_ROUTING_NAMES", capabilities.artifacts.routes, capabilities.routes, null, null),
    "capability.source-schemas": createRecord("source-owner", "capability-source-schemas", "skills/agentera/capabilities/*/schemas", capabilities.artifacts.schemas, capabilities.schemas, null, null),
    "package.source-registry": createRecord("source-owner", "package-source-registry", "references/adapters/package-registry.yaml#records[agentera]", artifactDigest(root, ["references/adapters/package-registry.yaml"]), packageDescriptorSemantics(packageDescriptors(record)), null, null),
    "package.source-construction": createRecord("source-owner", "package-source-construction", "references/adapters/package-registry.yaml#records[agentera].bundle_surfaces", artifactDigest(root, ["references/adapters/package-registry.yaml", "packages/cli/scripts/package-construction.mjs"]), packageDescriptors(record).map(({ id, entry }) => ({ id, path: entry.path })), null, null),
    "package.source-selectors": createRecord("source-owner", "package-source-selectors", "references/adapters/package-registry.yaml#records[agentera].semantic_fields", artifactDigest(root, ["references/adapters/package-registry.yaml"]), { semanticSelectors: packageDescriptorSemantics(packageDescriptors(record)) }, null, null),
    "bootstrap.source-authority": createRecord("source-owner", "bootstrap-source-authority", "packages/cli/src/validate/bootstrapAuthority.ts#bootstrapMatrixAuthority", artifactDigest(root, ["packages/cli/src/validate/bootstrapAuthority.ts"]), bootstrapMatrixAuthority(), null, null),
  };
  if (productionInputs?.classes) {
    for (const classId of ["cli", "runtime", "reference", "state"]) {
      for (const dimension of ["discovery", "behavior", "diagnostics", "instructions", "adversarial"]) {
        const content = productionInputs.classes[classId]?.dimensions?.[dimension];
        records[`generic.${classId}.${dimension}`] = createRecord(
          "source-owner",
          `${classId}-${dimension}-source-observation`,
          `${classId}.${dimension}`,
          artifactDigest(root, GENERIC_SOURCE_ARTIFACTS[`${classId}.${dimension}`] ?? []),
          genericDimensionObservation(classId, dimension, content),
          null,
          null,
        );
      }
    }
  }
  if (packageExecution) {
    const { fixture, runtimeSummary, missingSurfaceResults } = packageExecution;
    const capabilityProject = path.join(fixture.root, "activation-source-package-capability-project");
    resetObservationProject(capabilityProject);
    const packageCapabilities = runtimeProjection(fixture.packageRoot, capabilityProject, root);
    const packageRows = runtimeSummary.rows.filter((row: any) => row.runtime === "package");
    const rejectedRows = packageRows.filter((row: any) => !row.accepted);
    const commandPolicy = {
      rowCount: packageRows.length,
      accepted: packageRows.filter((row: any) => row.accepted).length,
      rejected: rejectedRows.length,
      classifications: Object.fromEntries([...new Set(packageRows.map((row: any) => row.classification))].sort().map((classification) => [classification, packageRows.filter((row: any) => row.classification === classification).length])),
      compositeIdentityDigest: observationDigest(packageRows.map((row: any) => `${row.runtime}/${row.projectState}/${row.id}`).sort()),
    };
    const adversarial = {
      rowCount: rejectedRows.length,
      allBlockedBeforeChildStart: rejectedRows.every((row: any) => row.childStarted === false),
      classifications: Object.fromEntries([...new Set(rejectedRows.map((row: any) => row.classification))].sort().map((classification) => [classification, rejectedRows.filter((row: any) => row.classification === classification).length])),
    };
    records["capability.extracted-served"] = createRecord("source-owner", "capability-extracted-served", "package/dist/bin/agentera.js#prime-context", packageCapabilities.artifacts.served!, packageCapabilities.served, null, null);
    records["package.command-policy"] = createRecord("source-owner", "package-command-policy", "source-integration/runtime-matrix/classifications", observationDigest(packageRows), commandPolicy, null, null);
    records["package.adversarial"] = createRecord("source-owner", "package-adversarial", "source-integration/runtime-matrix/rejections", observationDigest(rejectedRows), adversarial, null, null);
    records["bootstrap.extracted-classifications"] = createRecord("source-owner", "bootstrap-extracted-classifications", "source-integration/runtime-matrix/rows", observationDigest(packageRows), packageRows, null, null);
    records["bootstrap.extracted-diagnostics"] = createRecord("source-owner", "bootstrap-extracted-diagnostics", "source-integration/runtime-matrix/rejection-diagnostics", observationDigest(rejectedRows), rejectedRows, null, null);
    const parity = {
      ...(runtimeSummary.runtimeObservationDigests ?? {}),
      packageArtifact: runtimeSummary.packageArtifact ?? null,
    };
    records["bootstrap.source-package-parity"] = createRecord("source-owner", "bootstrap-source-package-parity", "source-integration/runtime-matrix/parity", observationDigest(parity), parity, null, null);
    records["bootstrap.missing-surface"] = createRecord("source-owner", "bootstrap-missing-surface", "source-integration/runtime-matrix/missing-required-surfaces", observationDigest(missingSurfaceResults), missingSurfaceResults, null, null);
  }
  return finishEvidence({
    schemaVersion: SOURCE_OWNER_EVIDENCE_SCHEMA,
    producerKind: "source-owner",
    sourceDigest: activationSourceDigest(root),
    generation: null,
    packageIntegrity: null,
    records,
  });
}

function packageArtifactObservation(runtimeRoot: string, fixture: any, requiredFiles: readonly string[], snapshotDirectory?: string): any {
  const tarball = path.join(fixture.root, fixture.manifest.filename);
  const current = observeCurrentPackageArtifact(tarball, runtimeRoot, snapshotDirectory);
  const { tarballTree, ...currentWithoutTarballEntries } = current;
  const manifestFile = path.join(runtimeRoot, "package.json");
  const manifestEntry = current.extractedTree.entries.find((entry: any) => entry.path === "package.json");
  return {
    ...currentWithoutTarballEntries,
    tarballTree: { count: tarballTree.entries.length, digest: tarballTree.digest },
    manifest: {
      path: "package.json",
      type: "file",
      mode: manifestEntry?.mode ?? null,
      contentDigest: fileSha256(manifestFile),
    },
    requiredSurfaces: requiredFiles.map((relative) => {
      const file = path.join(runtimeRoot, relative);
      const stat = fs.lstatSync(file);
      return { path: relative, type: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "other", mode: stat.mode & 0o777, contentDigest: stat.isFile() ? fileSha256(file) : null };
    }),
  };
}

function seedObservationProject(project: string): void {
  fs.mkdirSync(path.join(project, ".agentera"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(project, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n", { flag: "wx", mode: 0o600 });
}

function resetObservationProject(project: string): void {
  fs.rmSync(project, { recursive: true, force: true });
  seedObservationProject(project);
}

export async function finalizePackageOwnerEvidence(options: {
  root: string;
  fixture: any;
  requiredFiles: readonly string[];
  snapshotDirectory?: string;
}): Promise<FinalizedPackageOwnerEvidence> {
  const { root, fixture } = options;
  const runtimeRoot = fixture.packageRoot;
  const capabilityProject = path.join(fixture.root, "activation-capability-project");
  resetObservationProject(capabilityProject);
  const capabilities = runtimeProjection(runtimeRoot, capabilityProject, root, "package-smoke");
  const record = packageRecord(path.join(runtimeRoot, "bundle"));
  const packageArtifact = packageArtifactObservation(runtimeRoot, fixture, options.requiredFiles, options.snapshotDirectory);
  const integrity = packageArtifact.integrity as string;
  const secondManifestFiles = fixture.pathIndependence.secondManifest.files;
  const portability = {
    deterministicPackRuns: fixture.deterministicBytes.packRuns,
    deterministicTarballSha256: fixture.deterministicBytes.sha256,
    secondTarballSha256: fixture.deterministicBytes.secondSha256,
    constructionRootCount: fixture.pathIndependence.constructionRoots.length,
    constructionRootsDistinct: new Set(fixture.pathIndependence.constructionRoots).size === fixture.pathIndependence.constructionRoots.length,
    extractedRootCount: fixture.pathIndependence.extractedRoots.length,
    extractedRootsDistinct: new Set(fixture.pathIndependence.extractedRoots).size === fixture.pathIndependence.extractedRoots.length,
    regularFiles: fixture.pathIndependence.regularFiles,
    contentSha256: fixture.pathIndependence.contentSha256,
    forbiddenPathMatches: fixture.pathIndependence.forbiddenPathMatches,
    pathNeedleClasses: fixture.pathIndependence.pathNeedleClasses,
    secondManifest: {
      filename: fixture.pathIndependence.secondManifest.filename,
      integrity: fixture.pathIndependence.secondManifest.integrity,
      shasum: fixture.pathIndependence.secondManifest.shasum,
      files: packageManifestSummary(secondManifestFiles),
    },
  };
  const records: Record<string, ActivationArtifactRecord> = {
    "capability.extracted-modules": createRecord("package-owner", "capability-extracted-modules", "package/dist/capabilities/*/instructions.js", capabilities.artifacts.modules, capabilities.modules, null, integrity),
    "capability.extracted-runtime-registry": createRecord("package-owner", "capability-extracted-runtime-registry", "package/dist/capabilities/index.js#CAPABILITY_INSTRUCTIONS", capabilities.artifacts.runtimeRegistry, capabilities.runtimeRegistry, null, integrity),
    "capability.extracted-registry": createRecord("package-owner", "capability-extracted-registry", "package/bundle/registry.json#skills[0].capabilities", capabilities.artifacts.registry, capabilities.registry, null, integrity),
    "capability.extracted-routes": createRecord("package-owner", "capability-extracted-routes", "package/dist/cli/commands/capability.js#CAPABILITY_ROUTING_NAMES", capabilities.artifacts.routes, capabilities.routes, null, integrity),
    "capability.extracted-schemas": createRecord("package-owner", "capability-extracted-schemas", "package/bundle/skills/agentera/capabilities/*/schemas", capabilities.artifacts.schemas, capabilities.schemas, null, integrity),
    "package.extracted-artifact": createRecord("package-owner", "package-extracted-artifact", "npm-tarball/extracted-package", observationDigest(packageArtifact), packageArtifact, null, integrity),
    "package.extracted-registry": createRecord("package-owner", "package-extracted-registry", "package/bundle/references/adapters/package-registry.yaml#records[agentera]", artifactDigest(runtimeRoot, ["bundle/references/adapters/package-registry.yaml"]), packageDescriptorSemantics(packageDescriptors(record)), null, integrity),
    "package.extracted-smoke": createRecord("package-owner", "package-extracted-smoke", "package/dist/bin/agentera.js#prime-context-status", capabilities.artifacts.served!, capabilities.served, null, integrity),
    "package.portability": createRecord("package-owner", "package-portability", "npm-tarball/path-portability", fixture.pathIndependence.contentSha256, portability, null, integrity),
    "bootstrap.extracted-startup": createRecord("package-owner", "bootstrap-extracted-startup", "package/dist/bin/agentera.js#startup-producers", capabilities.artifacts.startupProducers!, capabilities.startupProducers, null, integrity),
    "bootstrap.extracted-declarations": createRecord("package-owner", "bootstrap-extracted-declarations", "package/bundle/references/adapters/package-registry.yaml#bootstrap_command_authority", artifactDigest(runtimeRoot, ["bundle/references/adapters/package-registry.yaml"]), packageCommandDeclarations(record), null, integrity),
  };
  for (const classId of ["runtime", "reference", "state"]) {
    const relative = classId === "runtime"
      ? [["bundle", "references", "adapters", "runtime-lifecycle-authority.yaml"].join("/"), ["bundle", "references", "adapters", "runtime-retired-resources.yaml"].join("/")]
      : classId === "reference"
        ? ["bundle/references/meta/retained-reference-authority.yaml"]
        : ["dist/state/entityListRuntimeRegistry.js", "dist/state/write/runtimeOperations.js", "dist/state/write/operations.js"];
    records[`generic.${classId}.package_projection`] = createRecord(
      "package-owner",
      `${classId}-package-projection`,
      `package/${classId}/projection`,
      artifactDigest(runtimeRoot, relative),
      relative.map((file) => ({ file, sha256: fs.existsSync(path.join(runtimeRoot, file)) ? fileSha256(path.join(runtimeRoot, file)) : "missing" })),
      null,
      integrity,
    );
  }
  const evidence = finishEvidence({
    schemaVersion: PACKAGE_OWNER_EVIDENCE_SCHEMA,
    producerKind: "package-owner",
    sourceDigest: activationSourceDigest(root),
    generation: null,
    packageIntegrity: integrity,
    records,
  });
  const unsignedIdentity: Omit<ActivationPackageIdentity, "identityDigest"> = {
    schemaVersion: PACKAGE_IDENTITY_SCHEMA,
    packageEvidenceDigest: evidence.evidenceDigest,
    packageArtifact: {
      filename: packageArtifact.filename,
      integrity: packageArtifact.integrity,
      shasum: packageArtifact.shasum,
      tarballSha256: packageArtifact.tarballSha256,
    },
    packageArtifactObservationDigest: records["package.extracted-artifact"].observationDigest,
    extractedTree: { count: packageArtifact.extractedTree.entries.length, digest: packageArtifact.extractedTree.digest },
    tarballTree: { count: packageArtifact.tarballTree.count, digest: packageArtifact.tarballTree.digest },
  };
  return { evidence, packageIdentity: { ...unsignedIdentity, identityDigest: observationDigest(unsignedIdentity) } };
}

export function createGeneratedOwnerEvidence(options: {
  root: string;
  generationRoot: string;
  generation: string;
  productionInputs: any;
}): ActivationOwnerEvidence {
  const project = fs.mkdtempSync(path.join(process.env.TMPDIR ?? options.generationRoot, "activation-generated-project-"));
  seedObservationProject(project);
  let runtimeObservation: ReturnType<typeof runtimeArtifactObservation>;
  try {
    runtimeObservation = runtimeArtifactObservation(options.generationRoot, project, options.root);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
  const capabilities = runtimeObservation.projection;
  const bundleRoot = path.join(options.generationRoot, "bundle");
  const record = packageRecord(bundleRoot);
  const bootstrap = runtimeObservation.bootstrap;
  const generationFiles = [".agentera-generation.json", "dist/.agentera-generation.json", "bundle/.agentera-generation.json", "dist/.agentera-build-source.json", "bundle/.agentera-build-source.json", "bundle/.agentera-npx-bundle.json", "bundle/extract-corpus-parity.json"]
    .filter((file) => fs.existsSync(path.join(options.generationRoot, file)));
  const records: Record<string, ActivationArtifactRecord> = {
    "capability.generated-modules": createRecord("generated-owner", "capability-generated-modules", "generation/dist/capabilities/*/instructions.js", capabilities.artifacts.modules, capabilities.modules, options.generation, null),
    "capability.generated-runtime-registry": createRecord("generated-owner", "capability-generated-runtime-registry", "generation/dist/capabilities/index.js#CAPABILITY_INSTRUCTIONS", capabilities.artifacts.runtimeRegistry, capabilities.runtimeRegistry, options.generation, null),
    "capability.generated-served": createRecord("generated-owner", "capability-generated-served", "generation/dist/bin/agentera.js#prime-context", capabilities.artifacts.served!, capabilities.served, options.generation, null),
    "capability.generated-registry": createRecord("generated-owner", "capability-generated-registry", "generation/bundle/registry.json#skills[0].capabilities", capabilities.artifacts.registry, capabilities.registry, options.generation, null),
    "capability.generated-routes": createRecord("generated-owner", "capability-generated-routes", "generation/dist/cli/commands/capability.js#CAPABILITY_ROUTING_NAMES", capabilities.artifacts.routes, capabilities.routes, options.generation, null),
    "capability.generated-schemas": createRecord("generated-owner", "capability-generated-schemas", "generation/bundle/skills/agentera/capabilities/*/schemas", capabilities.artifacts.schemas, capabilities.schemas, options.generation, null),
    "package.generated-construction": createRecord("generated-owner", "package-generated-construction", "generation/package-construction-markers", artifactDigest(options.generationRoot, generationFiles), generationFiles.map((file) => ({ file, sha256: fileSha256(path.join(options.generationRoot, file)) })), options.generation, null),
    "package.generated-registry": createRecord("generated-owner", "package-generated-registry", "generation/bundle/references/adapters/package-registry.yaml#records[agentera]", artifactDigest(options.generationRoot, ["bundle/references/adapters/package-registry.yaml"]), packageDescriptorSemantics(packageDescriptors(record)), options.generation, null),
    "package.generated-selectors": createRecord("generated-owner", "package-generated-selectors", "generation/bundle/references/adapters/package-registry.yaml#semantic_fields", artifactDigest(options.generationRoot, ["bundle/references/adapters/package-registry.yaml"]), { semanticSelectors: packageDescriptorSemantics(packageDescriptors(record)) }, options.generation, null),
    "bootstrap.generated-binder": createRecord("generated-owner", "bootstrap-generated-binder", "generation/dist/core/developmentInvocation.js#bindDevelopmentInvocation", artifactDigest(options.generationRoot, ["dist/core/developmentInvocation.js", "dist/validate/bootstrapAuthority.js"]), bootstrap, options.generation, null),
    "bootstrap.generated-diagnostics": createRecord("generated-owner", "bootstrap-generated-diagnostics", "generation/dist/core/developmentInvocation.js#DevelopmentInvocationError", artifactDigest(options.generationRoot, ["dist/core/developmentInvocation.js"]), (bootstrap as any).rows.filter((row: any) => row.classification !== "accepted"), options.generation, null),
    "bootstrap.generated-startup": createRecord("generated-owner", "bootstrap-generated-startup", "generation/dist/bin/agentera.js#startup-producers", capabilities.artifacts.startupProducers!, capabilities.startupProducers, options.generation, null),
    "bootstrap.generated-declarations": createRecord("generated-owner", "bootstrap-generated-declarations", "generation/bundle/references/adapters/package-registry.yaml#bootstrap_command_authority", artifactDigest(options.generationRoot, ["bundle/references/adapters/package-registry.yaml"]), packageCommandDeclarations(record), options.generation, null),
    "generic.cli.package_projection": createRecord("generated-owner", "cli-package-projection", "generation/dist/cli/dispatch/projections.js", artifactDigest(options.generationRoot, ["dist/cli/dispatch/projections.js"]), options.productionInputs.classes.cli.dimensions.package_projection, options.generation, null),
  };
  return finishEvidence({
    schemaVersion: GENERATED_OWNER_EVIDENCE_SCHEMA,
    producerKind: "generated-owner",
    sourceDigest: activationSourceDigest(options.root),
    generation: options.generation,
    packageIntegrity: null,
    records,
  });
}

export function writeContentAddressedOwnerEvidence(directory: string, evidence: ActivationOwnerEvidence): { path: string; digest: string; bytes: number } {
  const bytes = `${canonicalObservationJson(evidence)}\n`;
  const byteLength = Buffer.byteLength(bytes, "utf8");
  if (byteLength > OWNER_EVIDENCE_MAX_BYTES) {
    const contributors = Object.entries(evidence.records)
      .map(([ref, record]) => [ref, Buffer.byteLength(canonicalObservationJson(record), "utf8")] as const)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 3)
      .map(([ref, length]) => `${ref}=${length}`)
      .join(", ");
    throw new Error(`activation owner evidence is ${byteLength} bytes, over the ${OWNER_EVIDENCE_MAX_BYTES}-byte bound; largest records: ${contributors}`);
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const name = `${evidence.producerKind}-${evidence.evidenceDigest}.json`;
  const target = path.join(directory, name);
  const temporary = path.join(directory, `.${name}.${process.pid}.tmp`);
  fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
  fs.renameSync(temporary, target);
  return { path: target, digest: evidence.evidenceDigest, bytes: byteLength };
}

export function activationPackageIdentityViolations(
  identity: unknown,
  packageEvidence?: ActivationOwnerEvidence,
): string[] {
  if (!identity || typeof identity !== "object") return ["trusted immutable package identity is missing or malformed"];
  const actual = identity as ActivationPackageIdentity;
  const { identityDigest, ...unsigned } = actual;
  const violations: string[] = [];
  if (Object.keys(actual).sort().join("\0") !== ["extractedTree", "identityDigest", "packageArtifact", "packageArtifactObservationDigest", "packageEvidenceDigest", "schemaVersion", "tarballTree"].join("\0")
    || Object.keys(actual.packageArtifact ?? {}).sort().join("\0") !== ["filename", "integrity", "shasum", "tarballSha256"].join("\0")
    || Object.keys(actual.extractedTree ?? {}).sort().join("\0") !== ["count", "digest"].join("\0")
    || Object.keys(actual.tarballTree ?? {}).sort().join("\0") !== ["count", "digest"].join("\0")
    || actual.schemaVersion !== PACKAGE_IDENTITY_SCHEMA
    || !/^[a-f0-9]{64}$/.test(actual.packageEvidenceDigest ?? "")
    || !/^[a-f0-9]{64}$/.test(actual.packageArtifactObservationDigest ?? "")
    || !/^agentera-\d+\.\d+\.\d+(?:-dev\.\d+)?\.tgz$/.test(actual.packageArtifact?.filename ?? "")
    || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(actual.packageArtifact?.integrity ?? "")
    || !/^[a-f0-9]{40}$/.test(actual.packageArtifact?.shasum ?? "")
    || !/^[a-f0-9]{64}$/.test(actual.packageArtifact?.tarballSha256 ?? "")
    || !Number.isInteger(actual.extractedTree?.count) || actual.extractedTree.count < 1
    || !/^[a-f0-9]{64}$/.test(actual.extractedTree?.digest ?? "")
    || !Number.isInteger(actual.tarballTree?.count) || actual.tarballTree.count < 1
    || !/^[a-f0-9]{64}$/.test(actual.tarballTree?.digest ?? "")
    || identityDigest !== observationDigest(unsigned)) {
    violations.push("trusted immutable package identity is missing or malformed");
  }
  if (packageEvidence) {
    const artifact = packageEvidence.records?.["package.extracted-artifact"];
    const content = artifact?.content as any;
    if (packageEvidence.evidenceDigest !== actual.packageEvidenceDigest
      || artifact?.observationDigest !== actual.packageArtifactObservationDigest
      || canonicalObservationJson({
        filename: content?.filename,
        integrity: content?.integrity,
        shasum: content?.shasum,
        tarballSha256: content?.tarballSha256,
      }) !== canonicalObservationJson(actual.packageArtifact)
      || content?.extractedTree?.entries?.length !== actual.extractedTree?.count
      || content?.extractedTree?.digest !== actual.extractedTree?.digest
      || content?.tarballTree?.count !== actual.tarballTree?.count
      || content?.tarballTree?.digest !== actual.tarballTree?.digest) {
      violations.push("package-owner evidence differs from the independently retained package identity");
    }
  }
  return [...new Set(violations)];
}

export function writeContentAddressedPackageIdentity(directory: string, identity: ActivationPackageIdentity): { path: string; digest: string; bytes: number } {
  const violations = activationPackageIdentityViolations(identity);
  if (violations.length > 0) throw new Error(violations[0]);
  const bytes = `${canonicalObservationJson(identity)}\n`;
  const byteLength = Buffer.byteLength(bytes, "utf8");
  if (byteLength > PACKAGE_IDENTITY_MAX_BYTES) throw new Error(`activation package identity exceeds ${PACKAGE_IDENTITY_MAX_BYTES} bytes`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const name = `package-identity-${identity.identityDigest}.json`;
  const target = path.join(directory, name);
  const temporary = path.join(directory, `.${name}.${process.pid}.tmp`);
  fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
  fs.renameSync(temporary, target);
  return { path: target, digest: identity.identityDigest, bytes: byteLength };
}

export function readContentAddressedPackageIdentity(directory: string): ActivationPackageIdentity {
  const entries = fs.existsSync(directory) ? fs.readdirSync(directory, { withFileTypes: true }) : [];
  if (entries.length !== 1 || !entries[0]?.isFile() || entries[0].isSymbolicLink()) {
    throw new Error("package identity is missing, duplicated, unknown, or not a regular file");
  }
  const file = path.join(directory, entries[0].name);
  const stat = fs.statSync(file);
  if (stat.size <= 0 || stat.size > PACKAGE_IDENTITY_MAX_BYTES) throw new Error("package identity violates its byte bound");
  const identity = JSON.parse(fs.readFileSync(file, "utf8")) as ActivationPackageIdentity;
  if (entries[0].name !== `package-identity-${identity.identityDigest}.json`
    || activationPackageIdentityViolations(identity).length > 0) {
    throw new Error("package identity has wrong content-addressed provenance");
  }
  return identity;
}

export function readContentAddressedOwnerEvidence(directory: string, producerKind: ActivationProducerKind): ActivationOwnerEvidence {
  const entries = fs.existsSync(directory) ? fs.readdirSync(directory, { withFileTypes: true }) : [];
  if (entries.length !== 1 || !entries[0]?.isFile() || entries[0].isSymbolicLink()) {
    throw new Error(`${producerKind} evidence is missing, duplicated, unknown, or not a regular file`);
  }
  const file = path.join(directory, entries[0].name);
  const stat = fs.statSync(file);
  if (stat.size <= 0 || stat.size > OWNER_EVIDENCE_MAX_BYTES) throw new Error(`${producerKind} evidence violates its byte bound`);
  const evidence = JSON.parse(fs.readFileSync(file, "utf8")) as ActivationOwnerEvidence;
  if (evidence.producerKind !== producerKind || entries[0].name !== `${producerKind}-${evidence.evidenceDigest}.json`) {
    throw new Error(`${producerKind} evidence has wrong content-addressed provenance`);
  }
  const { evidenceDigest, ...unsigned } = evidence;
  if (observationDigest(unsigned) !== evidenceDigest) throw new Error(`${producerKind} evidence digest does not match its content`);
  return evidence;
}
