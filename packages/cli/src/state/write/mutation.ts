import fs from "node:fs";
import path from "node:path";

import type { JsonObject } from "../../core/jsonValue.js";
import type { ExperimentArchivePublication } from "../experimentArchive.js";
import { publishImmutableFile, publishNumberedArchive, type ArchivePublicationResult } from "../archivePublication.js";
import { assertValidatedProjectRoot, type ValidatedProjectRoot } from "../projectRoot.js";
import type { WritableArtifact } from "./operations.js";
import { acquireWriterLock } from "./lock.js";

export const MUTATION_FAILURE_BOUNDARIES = ["staged-write", "archive-directory-publication", "archive-publication", "backup-publication", "revision-publication", "projection-consistency", "projection-publication", "directory-sync"] as const;

export type MutationFailureBoundary = (typeof MUTATION_FAILURE_BOUNDARIES)[number];

export interface StateMutationOptions {
  failAfter?: MutationFailureBoundary;
  lockTimeoutMs?: number;
}

export class InjectedMutationFailure extends Error {
  readonly boundary: MutationFailureBoundary;

  constructor(boundary: MutationFailureBoundary) {
    super(`injected state mutation failure after ${boundary}`);
    this.name = "InjectedMutationFailure";
    this.boundary = boundary;
  }
}

let stageSequence = 0;

function fsyncDirectory(directory: string): void {
  const fd = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function stagePath(target: string): string {
  stageSequence += 1;
  return path.join(path.dirname(target), `.${path.basename(target)}.writer.${process.pid}.${stageSequence}.tmp`);
}

function isMutationStage(name: string): boolean {
  return /\.writer\.\d+\.\d+\.tmp$/.test(name);
}

function removeStaleStages(directory: string): void {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      removeStaleStages(candidate);
      continue;
    }
    if (!entry.isFile() || !isMutationStage(entry.name)) continue;
    try {
      fs.unlinkSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export class StateMutationTransaction {
  private readonly stages = new Set<string>();
  private failureInjected = false;

  constructor(
    readonly projectRoot: string,
    private readonly options: StateMutationOptions = {},
  ) {}

  stageProjection(target: string, bytes: string): string {
    const directory = path.dirname(target);
    fs.mkdirSync(directory, { recursive: true });
    removeStaleStages(directory);
    const stage = stagePath(target);
    let fd: number | undefined;
    try {
      fd = fs.openSync(stage, "wx");
      fs.writeFileSync(fd, bytes, "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      this.stages.add(stage);
      return stage;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (!this.stages.has(stage)) {
        try {
          fs.unlinkSync(stage);
        } catch {
          /* stage was never created or cleanup is already complete */
        }
      }
    }
  }

  syncStaged(stage: string): void {
    const fd = fs.openSync(stage, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.failAfter("staged-write");
  }

  publishArchive(artifact: WritableArtifact, entryNumber: number, record: JsonObject): ArchivePublicationResult {
    const archive = publishNumberedArchive(this.projectRoot, artifact, entryNumber, record, {
      afterDirectorySync: () => this.failAfter("directory-sync"),
    });
    this.failAfter("archive-publication");
    return archive;
  }

  publishExperimentArchive(publication: ExperimentArchivePublication, onExisting: () => void): boolean {
    const published = publishImmutableFile(publication.target, publication.bytes, {
      directoryDurabilityRoot: publication.directoryDurabilityRoot,
      onExisting,
      afterDirectoryEntrySync: () => this.failAfter("archive-directory-publication"),
      afterDirectorySync: () => this.failAfter("directory-sync"),
    });
    this.failAfter("archive-publication");
    return published;
  }

  publishBackup(target: string, bytes: string, onExisting?: () => void): boolean {
    const published = publishImmutableFile(target, bytes, {
      onExisting,
      afterDirectorySync: () => this.failAfter("directory-sync"),
    });
    this.failAfter("backup-publication");
    return published;
  }

  /**
   * Atomically stage, fsync, and rename a decision revision document. The
   * revision document is keyed-by-stable-id immutable evidence: a publication
   * renames a fully-staged replacement into place, then fsyncs the directory.
   * `expectedBytes` (the bytes read before staging) guards against a concurrent
   * change to the revision document between preparation and publication.
   *
   * Boundaries (in order): `staged-write`, `revision-publication`,
   * `directory-sync`. A `projection-consistency` checkpoint follows in the
   * amendment handler, after the immutable evidence is durable.
   */
  publishRevisionDocument(target: string, bytes: string, expectedBytes?: string): void {
    const stage = this.stageProjection(target, bytes);
    try {
      this.syncStaged(stage);
      if (expectedBytes !== undefined) {
        const currentBytes = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
        if (currentBytes !== expectedBytes) {
          throw new Error(`revision document '${target}' changed before publication; existing bytes were preserved`);
        }
      }
      fs.renameSync(stage, target);
      this.stages.delete(stage);
      this.failAfter("revision-publication");
      fsyncDirectory(path.dirname(target));
      this.failAfter("directory-sync");
    } finally {
      this.removeStage(stage);
    }
  }

  /**
   * A read-only recovery checkpoint. The amendment handler verifies the
   * decisions projection base still agrees with the published revision's
   * `base_sha256`, then marks the checkpoint so a recovery test can inject a
   * failure after verification but before the operation returns success.
   */
  revisionConsistencyCheckpoint(): void {
    this.failAfter("projection-consistency");
  }

  publishProjection(stage: string, target: string, expectedBytes?: string): void {
    if (expectedBytes !== undefined) {
      const currentBytes = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
      if (currentBytes !== expectedBytes) {
        throw new Error(`projection target '${target}' changed before publication; existing bytes were preserved`);
      }
    }
    fs.renameSync(stage, target);
    this.stages.delete(stage);
    this.failAfter("projection-publication");
    fsyncDirectory(path.dirname(target));
    this.failAfter("directory-sync");
  }

  mutateProjection<T extends { changed: boolean }>(target: string, mutation: (stage: string) => T): T {
    const stage = this.stageProjection(target, fs.readFileSync(target, "utf8"));
    try {
      const result = mutation(stage);
      if (result.changed) {
        this.syncStaged(stage);
        this.publishProjection(stage, target);
      }
      return result;
    } finally {
      this.removeStage(stage);
    }
  }

  removeStage(stage: string): void {
    this.stages.delete(stage);
    try {
      fs.unlinkSync(stage);
    } catch {
      /* published or already removed */
    }
  }

  cleanup(): void {
    for (const stage of this.stages) this.removeStage(stage);
    this.stages.clear();
  }

  private failAfter(boundary: MutationFailureBoundary): void {
    if (this.failureInjected || this.options.failAfter !== boundary) return;
    this.failureInjected = true;
    throw new InjectedMutationFailure(boundary);
  }
}

export function withStateMutation<T>(projectRoot: string, operation: (transaction: StateMutationTransaction) => T, options: StateMutationOptions = {}, validatedRoot?: ValidatedProjectRoot): T {
  const lock = acquireWriterLock(projectRoot, options.lockTimeoutMs, validatedRoot);
  const transaction = new StateMutationTransaction(projectRoot, options);
  try {
    if (validatedRoot) assertValidatedProjectRoot(validatedRoot);
    removeStaleStages(path.join(projectRoot, ".agentera"));
    return operation(transaction);
  } finally {
    transaction.cleanup();
    lock.release();
  }
}
