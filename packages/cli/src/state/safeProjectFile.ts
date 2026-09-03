import fs from "node:fs";
import path from "node:path";

import { assertValidatedProjectRoot, type ValidatedProjectRoot } from "./projectRoot.js";

export type ProjectPathType = "file" | "directory" | "symlink" | "other";
export type ProjectDescriptorPathResolver = (descriptor: number) => string | null;

interface ProjectPathIdentity {
  absolute: string;
  dev: bigint;
  ino: bigint;
  type: ProjectPathType;
}

export type ProjectPathSnapshot = { kind: "stable"; absolute: string; identities: ProjectPathIdentity[]; leaf: fs.BigIntStats } | { kind: "missing"; absolute: string; reason: "missing" } | { kind: "unsafe"; absolute: string; reason: "symlink" | "type" | "unreadable" };

export type ProjectFileSnapshot =
  | { kind: "file"; bytes: Buffer; dev: bigint; ino: bigint; type: "file"; mode: number }
  | { kind: "missing"; bytes: null; reason: "missing"; absolute: string }
  | {
      kind: "unsafe";
      bytes: null;
      reason: "symlink" | "type" | "unreadable" | "changed" | "over_limit";
    };

function projectPathType(stat: fs.BigIntStats): ProjectPathType {
  if (stat.isFile()) return "file";
  if (stat.isDirectory()) return "directory";
  if (stat.isSymbolicLink()) return "symlink";
  return "other";
}

function samePathIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && projectPathType(left) === projectPathType(right);
}

function sameFileSnapshot(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.isFile() && right.isFile() && samePathIdentity(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

export function snapshotProjectPath(root: string, relativePath: string, leafType: "file" | "directory"): ProjectPathSnapshot {
  const targets = [root];
  let absolute = root;
  for (const segment of relativePath.split("/").filter(Boolean)) {
    absolute = path.join(absolute, segment);
    targets.push(absolute);
  }
  const identities: ProjectPathIdentity[] = [];
  let leaf: fs.BigIntStats | undefined;
  for (const [index, target] of targets.entries()) {
    let stat: fs.BigIntStats;
    try {
      stat = fs.lstatSync(target, { bigint: true });
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing", absolute: target, reason: "missing" } : { kind: "unsafe", absolute: target, reason: "unreadable" };
    }
    const type = projectPathType(stat);
    if (type === "symlink") return { kind: "unsafe", absolute: target, reason: "symlink" };
    const expected = index === targets.length - 1 ? leafType : "directory";
    if (type !== expected) return { kind: "unsafe", absolute: target, reason: "type" };
    identities.push({ absolute: target, dev: stat.dev, ino: stat.ino, type });
    leaf = stat;
  }
  return { kind: "stable", absolute, identities, leaf: leaf as fs.BigIntStats };
}

export function projectPathIsStable(snapshot: Extract<ProjectPathSnapshot, { kind: "stable" }>): boolean {
  return snapshot.identities.every((identity) => {
    try {
      const current = fs.lstatSync(identity.absolute, { bigint: true });
      return current.dev === identity.dev && current.ino === identity.ino && projectPathType(current) === identity.type;
    } catch {
      return false;
    }
  });
}

function containedBy(root: string, candidate: string): boolean {
  const relativePath = path.relative(root, candidate);
  return relativePath !== "" && !relativePath.startsWith(`..${path.sep}`) && relativePath !== ".." && !path.isAbsolute(relativePath);
}

export function resolveProjectDescriptorPath(descriptor: number): string | null {
  try {
    return fs.realpathSync(`/proc/self/fd/${descriptor}`);
  } catch {
    return null;
  }
}

function descriptorMatchesPath(root: string, absolute: string, descriptorPath: string): boolean {
  try {
    return containedBy(root, descriptorPath) && fs.realpathSync(absolute) === descriptorPath;
  } catch {
    return false;
  }
}

/** Pin one project file to a verified descriptor and return only stable in-project bytes. */
export function readProjectFileSnapshot(projectRoot: string | ValidatedProjectRoot, relativePath: string, descriptorPathResolver: ProjectDescriptorPathResolver = resolveProjectDescriptorPath, maxBytes: number | null = null): ProjectFileSnapshot {
  const root = typeof projectRoot === "string" ? projectRoot : projectRoot.path;
  const verifyRoot = (): void => {
    if (typeof projectRoot !== "string") assertValidatedProjectRoot(projectRoot);
  };
  verifyRoot();
  const pathSnapshot = snapshotProjectPath(root, relativePath, "file");
  if (pathSnapshot.kind === "missing") {
    verifyRoot();
    return { bytes: null, kind: "missing", reason: "missing", absolute: pathSnapshot.absolute };
  }
  if (pathSnapshot.kind === "unsafe") {
    verifyRoot();
    return { bytes: null, kind: "unsafe", reason: pathSnapshot.reason };
  }
  let descriptor: number | undefined;
  try {
    const noFollow = (fs.constants as Record<string, number>).O_NOFOLLOW ?? 0;
    descriptor = fs.openSync(pathSnapshot.absolute, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !samePathIdentity(pathSnapshot.leaf, opened) || !projectPathIsStable(pathSnapshot)) {
      return { bytes: null, kind: "unsafe", reason: "changed" };
    }
    if (maxBytes !== null && opened.size > BigInt(maxBytes)) {
      return { bytes: null, kind: "unsafe", reason: "over_limit" };
    }
    let descriptorRealPath: string | null = null;
    try {
      descriptorRealPath = descriptorPathResolver(descriptor);
    } catch {
      /* Descriptor paths are optional strengthening. */
    }
    if (descriptorRealPath !== null && !descriptorMatchesPath(root, pathSnapshot.absolute, descriptorRealPath)) {
      return { bytes: null, kind: "unsafe", reason: "changed" };
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (!sameFileSnapshot(opened, after) || BigInt(bytes.byteLength) !== opened.size || !projectPathIsStable(pathSnapshot) || (descriptorRealPath !== null && !descriptorMatchesPath(root, pathSnapshot.absolute, descriptorRealPath))) {
      return { bytes: null, kind: "unsafe", reason: "changed" };
    }
    verifyRoot();
    return {
      bytes,
      kind: "file",
      dev: after.dev,
      ino: after.ino,
      type: "file",
      mode: Number(after.mode & 0o7777n),
    };
  } catch {
    return { bytes: null, kind: "unsafe", reason: "changed" };
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        /* Failed close cannot make unverified bytes safe. */
      }
    }
  }
}
