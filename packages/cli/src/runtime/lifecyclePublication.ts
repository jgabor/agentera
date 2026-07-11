import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type LifecyclePublicationKind = "file" | "directory" | "symlink";

export interface LifecycleResourceIdentity {
  device: string;
  inode: string;
}

export interface LifecyclePublicationSpec {
  id: string;
  destination: string;
  kind: LifecyclePublicationKind;
  content?: string | Buffer;
  linkTarget?: string;
}

interface ObservedDirectory {
  path: string;
  identity: LifecycleResourceIdentity;
}

export interface LifecyclePathObservation {
  kind: LifecyclePublicationKind | "other" | "missing";
  unsafeReason?: string;
  root?: string;
  directories: ObservedDirectory[];
  parentComplete: boolean;
  identity?: LifecycleResourceIdentity;
  fingerprint?: string;
}

export interface LifecyclePublicationBoundary {
  operationId: string;
  destination: string;
  action: "create" | "update" | "remove" | "finalize_ownership";
}

export type LifecyclePublicationBoundaryHook = (boundary: LifecyclePublicationBoundary) => void;

export class LifecyclePublicationError extends Error {
  readonly createdIdentity?: LifecycleResourceIdentity;

  constructor(message: string, createdIdentity?: LifecycleResourceIdentity) {
    super(message);
    this.name = "LifecyclePublicationError";
    this.createdIdentity = createdIdentity;
  }
}

const DIRECTORY_OPEN_FLAGS = fs.constants.O_RDONLY
  | (fs.constants.O_DIRECTORY ?? 0)
  | (fs.constants.O_NOFOLLOW ?? 0);
const FILE_READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
const FILE_UPDATE_FLAGS = fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0);
const FILE_CREATE_FLAGS = fs.constants.O_WRONLY
  | fs.constants.O_CREAT
  | fs.constants.O_EXCL
  | (fs.constants.O_NOFOLLOW ?? 0);

function fingerprintBytes(bytes: Buffer): string {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function identityOf(stat: fs.BigIntStats): LifecycleResourceIdentity {
  return { device: stat.dev.toString(), inode: stat.ino.toString() };
}

export function sameLifecycleIdentity(
  left: LifecycleResourceIdentity | undefined,
  right: LifecycleResourceIdentity | undefined,
): boolean {
  return left !== undefined
    && right !== undefined
    && left.device === right.device
    && left.inode === right.inode;
}

function lstatMaybe(target: string): fs.BigIntStats | null {
  try {
    return fs.lstatSync(target, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function containingRoot(destination: string, allowedRoots: string[]): string | null {
  const roots = allowedRoots.map((root) => path.resolve(root)).sort((a, b) => b.length - a.length);
  return roots.find((root) => {
    const relative = path.relative(root, destination);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  }) ?? null;
}

function statKind(stat: fs.BigIntStats): LifecyclePathObservation["kind"] {
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isFile()) return "file";
  if (stat.isDirectory()) return "directory";
  return "other";
}

function fingerprintObservedTarget(
  destination: string,
  kind: LifecyclePathObservation["kind"],
  identity: LifecycleResourceIdentity,
): string | undefined {
  if (kind === "directory") return "directory";
  if (kind === "symlink") {
    const target = fs.readlinkSync(destination);
    const after = lstatMaybe(destination);
    if (!sameLifecycleIdentity(identity, after ? identityOf(after) : undefined)) {
      throw new LifecyclePublicationError("resource identity changed while observing symlink");
    }
    return fingerprintBytes(Buffer.from(target));
  }
  if (kind !== "file") return undefined;
  const fd = fs.openSync(destination, FILE_READ_FLAGS);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!sameLifecycleIdentity(identity, identityOf(opened))) {
      throw new LifecyclePublicationError("resource identity changed while opening file");
    }
    return fingerprintBytes(readFileDescriptor(fd, opened));
  } finally {
    fs.closeSync(fd);
  }
}

export function observeLifecyclePath(
  destination: string,
  allowedRoots: string[],
): LifecyclePathObservation {
  const empty = { directories: [], parentComplete: false };
  if (!path.isAbsolute(destination)) {
    return { ...empty, kind: "missing", unsafeReason: "destination must be absolute" };
  }
  const resolved = path.resolve(destination);
  const root = containingRoot(resolved, allowedRoots);
  if (!root) {
    return { ...empty, kind: "missing", unsafeReason: "destination must be beneath an allowed root" };
  }
  const rootStat = lstatMaybe(root);
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    return { ...empty, kind: "missing", unsafeReason: "allowed root is not an existing safe directory" };
  }
  const directories: ObservedDirectory[] = [{ path: root, identity: identityOf(rootStat) }];
  const relativeParent = path.relative(root, path.dirname(resolved));
  let cursor = root;
  let parentComplete = true;
  for (const segment of relativeParent === "" ? [] : relativeParent.split(path.sep)) {
    cursor = path.join(cursor, segment);
    const stat = lstatMaybe(cursor);
    if (!stat) {
      parentComplete = false;
      break;
    }
    if (stat.isSymbolicLink()) {
      return {
        kind: "missing",
        root,
        directories,
        parentComplete: false,
        unsafeReason: `parent traverses symlink at ${cursor}`,
      };
    }
    if (!stat.isDirectory()) {
      return {
        kind: "other",
        root,
        directories,
        parentComplete: false,
        unsafeReason: `parent is not a directory at ${cursor}`,
      };
    }
    directories.push({ path: cursor, identity: identityOf(stat) });
  }
  const stat = parentComplete ? lstatMaybe(resolved) : null;
  if (!stat) return { kind: "missing", root, directories, parentComplete };
  const kind = statKind(stat);
  const identity = identityOf(stat);
  try {
    return {
      kind,
      root,
      directories,
      parentComplete,
      identity,
      fingerprint: fingerprintObservedTarget(resolved, kind, identity),
    };
  } catch (error) {
    return {
      kind,
      root,
      directories,
      parentComplete,
      identity,
      unsafeReason: (error as Error).message,
    };
  }
}

function procFdPath(fd: number, child?: string): string {
  const base = `/proc/self/fd/${fd}`;
  return child === undefined ? base : path.join(base, child);
}

function assertSecurePublicationSupport(): void {
  if (process.platform !== "linux" || !fs.existsSync("/proc/self/fd")) {
    throw new LifecyclePublicationError(
      "safe lifecycle publication requires Linux /proc/self/fd directory-relative access",
    );
  }
  if (!fs.constants.O_DIRECTORY || !fs.constants.O_NOFOLLOW) {
    throw new LifecyclePublicationError(
      "safe lifecycle publication requires O_DIRECTORY and O_NOFOLLOW support",
    );
  }
}

export function secureLifecycleRemovalAvailable(): boolean {
  return process.platform === "linux"
    && fs.existsSync("/proc/self/fd")
    && Boolean(fs.constants.O_DIRECTORY)
    && Boolean(fs.constants.O_NOFOLLOW);
}

function assertDirectorySnapshot(directory: ObservedDirectory): void {
  const stat = lstatMaybe(directory.path);
  if (
    !stat
    || !stat.isDirectory()
    || stat.isSymbolicLink()
    || !sameLifecycleIdentity(directory.identity, identityOf(stat))
  ) {
    throw new LifecyclePublicationError(`directory identity changed before publication: ${directory.path}`);
  }
}

function withPinnedParent<T>(
  observation: LifecyclePathObservation,
  boundary: LifecyclePublicationBoundary,
  hook: LifecyclePublicationBoundaryHook | undefined,
  callback: (parentFd: number, targetPath: string) => T,
): T {
  assertSecurePublicationSupport();
  if (!observation.root || !observation.parentComplete || observation.directories.length === 0) {
    throw new LifecyclePublicationError("destination parent is not an existing safe directory");
  }
  const descriptors: number[] = [];
  try {
    let currentFd = fs.openSync(observation.root, DIRECTORY_OPEN_FLAGS);
    descriptors.push(currentFd);
    if (!sameLifecycleIdentity(observation.directories[0].identity, identityOf(fs.fstatSync(currentFd, { bigint: true })))) {
      throw new LifecyclePublicationError("allowed root identity changed before publication");
    }
    for (let index = 1; index < observation.directories.length; index += 1) {
      const directory = observation.directories[index];
      const nextFd = fs.openSync(procFdPath(currentFd, path.basename(directory.path)), DIRECTORY_OPEN_FLAGS);
      descriptors.push(nextFd);
      currentFd = nextFd;
      if (!sameLifecycleIdentity(directory.identity, identityOf(fs.fstatSync(currentFd, { bigint: true })))) {
        throw new LifecyclePublicationError(`parent identity changed before publication: ${directory.path}`);
      }
    }
    hook?.(boundary);
    for (const directory of observation.directories) assertDirectorySnapshot(directory);
    return callback(currentFd, procFdPath(currentFd, path.basename(boundary.destination)));
  } finally {
    for (const fd of descriptors.reverse()) {
      try {
        fs.closeSync(fd);
      } catch {
        // Closing a descriptor does not mutate user resources.
      }
    }
  }
}

function readFileDescriptor(fd: number, stat = fs.fstatSync(fd, { bigint: true })): Buffer {
  if (stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new LifecyclePublicationError("resource is too large to fingerprint safely");
  }
  const bytes = Buffer.alloc(Number(stat.size));
  let offset = 0;
  while (offset < bytes.length) {
    const read = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
    if (read === 0) break;
    offset += read;
  }
  return offset === bytes.length ? bytes : bytes.subarray(0, offset);
}

function writeFileDescriptor(fd: number, bytes: Buffer): void {
  fs.ftruncateSync(fd, 0);
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
    if (written === 0) throw new LifecyclePublicationError("filesystem write made no progress");
    offset += written;
  }
  fs.fsyncSync(fd);
}

function assertTargetIdentity(
  targetPath: string,
  expected: LifecycleResourceIdentity | undefined,
  expectedKind: LifecyclePublicationKind,
): fs.BigIntStats {
  const stat = lstatMaybe(targetPath);
  if (!stat || !sameLifecycleIdentity(expected, identityOf(stat)) || statKind(stat) !== expectedKind) {
    throw new LifecyclePublicationError("resource identity changed before publication");
  }
  return stat;
}

export function verifyLifecycleResourceAtPublication(
  spec: LifecyclePublicationSpec,
  observation: LifecyclePathObservation,
  hook?: LifecyclePublicationBoundaryHook,
): LifecycleResourceIdentity | undefined {
  return withPinnedParent(
    observation,
    { operationId: spec.id, destination: spec.destination, action: "finalize_ownership" },
    hook,
    (_parentFd, targetPath) => {
      if (observation.kind === "missing") {
        if (lstatMaybe(targetPath)) {
          throw new LifecyclePublicationError("resource appeared before ownership publication");
        }
        return undefined;
      }
      const stat = assertTargetIdentity(targetPath, observation.identity, spec.kind);
      if (spec.kind === "file") {
        const fd = fs.openSync(targetPath, FILE_READ_FLAGS);
        try {
          const opened = fs.fstatSync(fd, { bigint: true });
          if (!sameLifecycleIdentity(observation.identity, identityOf(opened))) {
            throw new LifecyclePublicationError("resource identity changed while verifying file");
          }
          if (opened.nlink !== 1n) {
            throw new LifecyclePublicationError("owned file has additional hard links");
          }
          if (fingerprintBytes(readFileDescriptor(fd, opened)) !== observation.fingerprint) {
            throw new LifecyclePublicationError("resource content changed before ownership publication");
          }
        } finally {
          fs.closeSync(fd);
        }
      } else if (spec.kind === "symlink") {
        if (fingerprintBytes(Buffer.from(fs.readlinkSync(targetPath))) !== observation.fingerprint) {
          throw new LifecyclePublicationError("symlink target changed before ownership publication");
        }
      }
      return identityOf(stat);
    },
  );
}

export function publishLifecycleResource(
  spec: LifecyclePublicationSpec,
  action: "create" | "update",
  observation: LifecyclePathObservation,
  hook?: LifecyclePublicationBoundaryHook,
): LifecycleResourceIdentity {
  return withPinnedParent(
    observation,
    { operationId: spec.id, destination: spec.destination, action },
    hook,
    (_parentFd, targetPath) => {
      if (action === "create") {
        if (lstatMaybe(targetPath)) {
          throw new LifecyclePublicationError("resource appeared before exclusive creation");
        }
        if (spec.kind === "directory") {
          fs.mkdirSync(targetPath, { mode: 0o700 });
          const created = fs.lstatSync(targetPath, { bigint: true });
          if (!created.isDirectory() || created.isSymbolicLink()) {
            throw new LifecyclePublicationError("exclusive directory creation produced an unexpected type");
          }
          return identityOf(created);
        }
        if (spec.kind === "symlink") {
          fs.symlinkSync(spec.linkTarget as string, targetPath);
          const created = fs.lstatSync(targetPath, { bigint: true });
          if (!created.isSymbolicLink()) {
            throw new LifecyclePublicationError("exclusive symlink creation produced an unexpected type");
          }
          return identityOf(created);
        }
        const fd = fs.openSync(targetPath, FILE_CREATE_FLAGS, 0o600);
        const created = identityOf(fs.fstatSync(fd, { bigint: true }));
        try {
          writeFileDescriptor(fd, Buffer.isBuffer(spec.content) ? spec.content : Buffer.from(spec.content as string));
          return created;
        } catch (error) {
          throw new LifecyclePublicationError((error as Error).message, created);
        } finally {
          fs.closeSync(fd);
        }
      }

      if (spec.kind !== "file") {
        throw new LifecyclePublicationError(
          "safe conditional replacement is unavailable for symlinks and directories",
        );
      }
      assertTargetIdentity(targetPath, observation.identity, "file");
      const fd = fs.openSync(targetPath, FILE_UPDATE_FLAGS);
      try {
        const opened = fs.fstatSync(fd, { bigint: true });
        const openedIdentity = identityOf(opened);
        if (!sameLifecycleIdentity(observation.identity, openedIdentity)) {
          throw new LifecyclePublicationError("resource identity changed while opening owned file");
        }
        if (opened.nlink !== 1n) {
          throw new LifecyclePublicationError("owned file has additional hard links");
        }
        if (fingerprintBytes(readFileDescriptor(fd, opened)) !== observation.fingerprint) {
          throw new LifecyclePublicationError("owned file content changed before publication");
        }
        writeFileDescriptor(fd, Buffer.isBuffer(spec.content) ? spec.content : Buffer.from(spec.content as string));
        const after = lstatMaybe(targetPath);
        if (!sameLifecycleIdentity(openedIdentity, after ? identityOf(after) : undefined)) {
          throw new LifecyclePublicationError("resource path changed during owned file update");
        }
        return openedIdentity;
      } finally {
        fs.closeSync(fd);
      }
    },
  );
}

export function removeLifecycleResource(
  spec: LifecyclePublicationSpec,
  observation: LifecyclePathObservation,
  hook?: LifecyclePublicationBoundaryHook,
): void {
  withPinnedParent(
    observation,
    { operationId: spec.id, destination: spec.destination, action: "remove" },
    hook,
    (_parentFd, targetPath) => {
      const stat = assertTargetIdentity(targetPath, observation.identity, spec.kind);
      if (spec.kind === "file") {
        const fd = fs.openSync(targetPath, FILE_READ_FLAGS);
        try {
          const opened = fs.fstatSync(fd, { bigint: true });
          if (!sameLifecycleIdentity(observation.identity, identityOf(opened))) {
            throw new LifecyclePublicationError("resource identity changed while opening owned file for removal");
          }
          if (opened.nlink !== 1n) {
            throw new LifecyclePublicationError("owned file has additional hard links");
          }
          if (fingerprintBytes(readFileDescriptor(fd, opened)) !== observation.fingerprint) {
            throw new LifecyclePublicationError("owned file content changed before removal");
          }
        } finally {
          fs.closeSync(fd);
        }
        assertTargetIdentity(targetPath, observation.identity, "file");
        fs.unlinkSync(targetPath);
      } else if (spec.kind === "symlink") {
        if (fingerprintBytes(Buffer.from(fs.readlinkSync(targetPath))) !== observation.fingerprint) {
          throw new LifecyclePublicationError("owned symlink target changed before removal");
        }
        assertTargetIdentity(targetPath, observation.identity, "symlink");
        fs.unlinkSync(targetPath);
      } else {
        if (fs.readdirSync(targetPath).length > 0) {
          throw new LifecyclePublicationError("owned directory is not empty");
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new LifecyclePublicationError("owned directory type changed before removal");
        }
        assertTargetIdentity(targetPath, observation.identity, "directory");
        fs.rmdirSync(targetPath);
      }
      if (lstatMaybe(targetPath)) {
        throw new LifecyclePublicationError("resource path reappeared during removal");
      }
    },
  );
}
