import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { JsonObject } from "../core/jsonValue.js";
import { dumpYamlMapping } from "../core/yaml.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { ArtifactSchemaValidator } from "../hooks/validateArtifact/index.js";
import { assertRealpathBoundary } from "../registries/artifactRegistry.js";
import {
  canonicalRecordJson,
  discoverNumberedArchives,
  numberedArchiveContract,
} from "./archiveDiscovery.js";
import { reject } from "./write/errors.js";

export interface ArchivePublicationResult {
  path: string;
  stableId: string;
  recordSha256: string;
  replay: boolean;
}

export interface NumberedArchiveBytes {
  bytes: string;
  recordSha256: string;
}

export interface ArchivePublicationFileSystem {
  mkdir(directory: string): void;
  openExclusive(stage: string): number;
  write(fd: number, bytes: string): void;
  syncFile(fd: number): void;
  close(fd: number): void;
  link(stage: string, target: string): void;
  unlink(stage: string): void;
  syncDirectory(directory: string): void;
}

export interface ImmutableFilePublicationOptions {
  fileSystem?: ArchivePublicationFileSystem;
  onExisting?: () => void;
  afterDirectorySync?: () => void;
}

const nodeFileSystem: ArchivePublicationFileSystem = {
  mkdir: (directory) => fs.mkdirSync(directory, { recursive: true }),
  openExclusive: (stage) => fs.openSync(stage, "wx"),
  write: (fd, bytes) => fs.writeFileSync(fd, bytes, "utf8"),
  syncFile: (fd) => fs.fsyncSync(fd),
  close: (fd) => fs.closeSync(fd),
  link: (stage, target) => fs.linkSync(stage, target),
  unlink: (stage) => fs.unlinkSync(stage),
  syncDirectory: (directory) => {
    const fd = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  },
};

let stageSequence = 0;

export function publishImmutableFile(
  target: string,
  bytes: string,
  options: ImmutableFilePublicationOptions = {},
): boolean {
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const directory = path.dirname(target);
  fileSystem.mkdir(directory);
  const stage = stagePath(directory, path.basename(target));
  let stageCreated = false;
  let fd: number | undefined;
  try {
    fd = fileSystem.openExclusive(stage);
    stageCreated = true;
    fileSystem.write(fd, bytes);
    fileSystem.syncFile(fd);
    fileSystem.close(fd);
    fd = undefined;
    try {
      fileSystem.link(stage, target);
      fileSystem.syncDirectory(directory);
      options.afterDirectorySync?.();
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      options.onExisting?.();
      return false;
    }
  } finally {
    if (fd !== undefined) fileSystem.close(fd);
    if (stageCreated) {
      try {
        fileSystem.unlink(stage);
        fileSystem.syncDirectory(directory);
      } catch {
        // A linked file is authoritative; a private stage can be cleaned on retry.
      }
    }
  }
}

function rejectConflict(stableId: string, message: string): never {
  reject({
    class: "conflict",
    message,
    syntax: "agentera state <artifact-id> append ... --format json",
    example: "retry the same append for an identical record; change the entry content for a new record",
    violations: [`immutable archive identity: ${stableId}`],
  });
}

function assertNoSymlinkPath(projectRoot: string, candidate: string): void {
  const relative = path.relative(path.resolve(projectRoot), candidate);
  let cursor = path.resolve(projectRoot);
  for (const segment of relative.split(path.sep)) {
    if (!segment) continue;
    cursor = path.join(cursor, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink())
      reject({
        class: "unsupported_target",
        message: `numbered archive path contains a symbolic link: '${cursor}'`,
        syntax: "agentera state <artifact-id> append ... --format json",
        example: "remove the symbolic link and retry the append",
      });
  }
}

function archivePath(
  projectRoot: string,
  artifactId: string,
  entryNumber: number,
  sourceRoot: string,
): { target: string; stableId: string; contract: ReturnType<typeof numberedArchiveContract> } {
  if (!Number.isSafeInteger(entryNumber) || entryNumber <= 0)
    reject({
      class: "invalid_int",
      message: `entry number must be a positive safe integer, got '${entryNumber}'`,
      syntax: "entry number N",
      example: "use the number assigned by the state writer",
    });
  const contract = numberedArchiveContract(artifactId, sourceRoot);
  const target = path.join(
    path.resolve(projectRoot),
    contract.archiveRoot,
    contract.artifactId,
    `${entryNumber}${contract.archiveExtension}`,
  );
  try {
    assertRealpathBoundary(projectRoot, target, "numbered archive");
  } catch (error) {
    reject({
      class: "unsupported_target",
      message: (error as Error).message,
      syntax: "agentera state <artifact-id> append ... --format json",
      example: "select a project-local archive path and retry",
    });
  }
  assertNoSymlinkPath(projectRoot, target);
  return { target, stableId: `${artifactId}:${entryNumber}`, contract };
}

function validateRecord(
  sourceRoot: string,
  contract: ReturnType<typeof numberedArchiveContract>,
  entryNumber: number,
  record: JsonObject,
): string {
  if (
    typeof record[contract.entryNumberField] !== "number" ||
    !Number.isSafeInteger(record[contract.entryNumberField]) ||
    record[contract.entryNumberField] !== entryNumber
  ) {
    throw new Error(
      `archive record ${contract.entryNumberField} must equal its positive entry number ${entryNumber}`,
    );
  }
  const validator = new ArtifactSchemaValidator(
    path.join(sourceRoot, "skills", "agentera", "schemas", "artifacts"),
  );
  const schema = validator.loadSchema(contract.artifactId);
  if (!schema) throw new Error(`archive artifact '${contract.artifactId}' schema is unavailable`);
  const violations = validator.validateYaml(
    dumpYamlMapping({ [contract.entryCollection]: [record] }),
    schema,
    contract.artifactId,
  );
  if (violations.length > 0)
    throw new Error(`archive record failed ${contract.artifactId} schema validation: ${violations.join("; ")}`);
  return canonicalRecordJson(record);
}

function stagePath(directory: string, filename: string): string {
  stageSequence += 1;
  return path.join(directory, `.${filename}.writer.${process.pid}.${stageSequence}.tmp`);
}

function existingArchiveMatches(
  projectRoot: string,
  target: string,
  stableId: string,
  record: JsonObject,
  sourceRoot: string,
): boolean {
  const discovered = discoverNumberedArchives(projectRoot, { sourceRoot });
  const existing = discovered.entries.find((entry) => entry.path === target);
  if (existing && canonicalRecordJson(existing.record) === canonicalRecordJson(record)) return true;
  rejectConflict(
    stableId,
    `immutable archive '${target}' already exists with different or invalid canonical content; existing bytes were preserved`,
  );
}

export function publishNumberedArchive(
  projectRoot: string,
  artifactId: string,
  entryNumber: number,
  record: JsonObject,
  options: {
    sourceRoot?: string;
    fileSystem?: ArchivePublicationFileSystem;
    afterDirectorySync?: () => void;
  } = {},
): ArchivePublicationResult {
  const sourceRoot = options.sourceRoot ?? resolveSourceRoot();
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const location = archivePath(projectRoot, artifactId, entryNumber, sourceRoot);
  const serialized = serializeNumberedArchive(artifactId, entryNumber, record, sourceRoot);
  const published = publishImmutableFile(location.target, serialized.bytes, {
    fileSystem,
    afterDirectorySync: options.afterDirectorySync,
    onExisting: () => {
      existingArchiveMatches(
        projectRoot,
        location.target,
        location.stableId,
        record,
        sourceRoot,
      );
    },
  });
  return {
    path: location.target,
    stableId: location.stableId,
    recordSha256: serialized.recordSha256,
    replay: !published,
  };
}

export function serializeNumberedArchive(
  artifactId: string,
  entryNumber: number,
  record: JsonObject,
  sourceRoot: string = resolveSourceRoot(),
): NumberedArchiveBytes {
  const contract = numberedArchiveContract(artifactId, sourceRoot);
  const canonical = validateRecord(sourceRoot, contract, entryNumber, record);
  const recordSha256 = createHash("sha256").update(canonical, "utf8").digest("hex");
  return {
    bytes: dumpYamlMapping({
      schemaVersion: contract.entrySchemaVersion,
      artifact_id: artifactId,
      entry_number: entryNumber,
      record,
      record_sha256: recordSha256,
    }),
    recordSha256,
  };
}
