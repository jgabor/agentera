import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { personalGlossaryCandidateProjectionContract } from "../registries/glossaryCandidateProjectionContract.js";
import { PERSONAL_GLOSSARY_MINING_POLICY_VERSION } from "../registries/glossaryMiningAuthority.js";
import { readCurrentGeneration } from "./extractCorpus/evidenceTiers.js";
import { mineExplicitGlossaryCandidates } from "./personalGlossaryExplicitMining.js";
import { mineRecurringGlossaryCandidates } from "./personalGlossaryRecurrence.js";
import {
  personalGlossaryCandidateProjectionPath,
  persistPersonalGlossaryCandidateProjectionAfterRefresh,
  projectPersonalGlossaryCandidates,
  type PersonalGlossaryCandidateProjectionStorageOptions,
  type PersonalGlossaryMiningFamilySummary,
  type PersonalGlossaryMiningSummary,
} from "./personalGlossaryCandidateProjection.js";

export interface PersonalGlossaryRefreshProjectionOptions extends PersonalGlossaryCandidateProjectionStorageOptions {
  tiersDir: string;
}

export interface PersonalGlossaryRefreshProjectionResult {
  status: "changed" | "unchanged_replay";
  generation: string;
  policy_version: string;
  candidate_projection_sha256: string;
  candidate_count: number;
  abstention_count: number;
  path: string;
}

export interface PersonalGlossaryRefreshCommitLock {
  descriptor: number;
  path: string;
  record: PersonalGlossaryRefreshCommitLockRecord;
}

interface PersonalGlossaryRefreshCommitLockRecord {
  schema_version: "agentera.personalGlossaryRefreshLock.v1";
  pid: number;
  token: string;
  created_at: string;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

const LOCK_SCHEMA_VERSION = "agentera.personalGlossaryRefreshLock.v1";
const MAX_LOCK_BYTES = 8 * 1024;
const FILE_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export class PersonalGlossaryRefreshCommitLockError extends Error {
  constructor(
    message: string,
    readonly recovery: string,
  ) {
    super(message);
    this.name = "PersonalGlossaryRefreshCommitLockError";
  }
}

export class PersonalGlossaryRefreshCommitBusyError extends PersonalGlossaryRefreshCommitLockError {
  constructor(message = "another consented refresh is still publishing the current candidate projection") {
    super(message, "npx -y agentera@next report refresh --consent local-history");
    this.name = "PersonalGlossaryRefreshCommitBusyError";
  }
}

function unsafeLock(lockPath: string, detail: string): never {
  throw new PersonalGlossaryRefreshCommitLockError(`personal glossary refresh lock is unsafe: ${detail}`, `Inspect ${lockPath}; remove it only after verifying no refresh owns it, then rerun npx -y agentera@next report refresh --consent local-history`);
}

function identity(fd: number): FileIdentity {
  const stat = fs.fstatSync(fd, { bigint: true });
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameRecord(left: PersonalGlossaryRefreshCommitLockRecord, right: PersonalGlossaryRefreshCommitLockRecord): boolean {
  return left.schema_version === right.schema_version && left.pid === right.pid && left.token === right.token && left.created_at === right.created_at;
}

function parseRecord(value: unknown): PersonalGlossaryRefreshCommitLockRecord | null {
  if (
    value === null ||
    typeof value !== "object" ||
    (value as { schema_version?: unknown }).schema_version !== LOCK_SCHEMA_VERSION ||
    !Number.isSafeInteger((value as { pid?: unknown }).pid) ||
    (value as { pid: number }).pid <= 0 ||
    typeof (value as { token?: unknown }).token !== "string" ||
    !TOKEN_PATTERN.test((value as { token: string }).token) ||
    typeof (value as { created_at?: unknown }).created_at !== "string" ||
    !Number.isFinite(Date.parse((value as { created_at: string }).created_at))
  )
    return null;
  return value as PersonalGlossaryRefreshCommitLockRecord;
}

function readRecord(fd: number): PersonalGlossaryRefreshCommitLockRecord | null {
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.size === 0n || stat.size > BigInt(MAX_LOCK_BYTES)) return null;
    const bytes = Buffer.alloc(Number(stat.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) return null;
      offset += count;
    }
    return parseRecord(JSON.parse(bytes.toString("utf8")) as unknown);
  } catch {
    return null;
  }
}

function openOwnedRecord(recordPath: string, label: string): { descriptor: number; record: PersonalGlossaryRefreshCommitLockRecord } | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(recordPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink()) unsafeLock(recordPath, `${label} is a symbolic link`);
  if (!stat.isFile()) unsafeLock(recordPath, `${label} is not a regular file`);

  let descriptor: number;
  try {
    descriptor = fs.openSync(recordPath, FILE_FLAGS);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") unsafeLock(recordPath, `${label} changed during inspection`);
    throw error;
  }
  const opened = fs.fstatSync(descriptor);
  if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
    fs.closeSync(descriptor);
    unsafeLock(recordPath, `${label} changed identity during inspection`);
  }
  const record = readRecord(descriptor);
  if (!record) {
    fs.closeSync(descriptor);
    unsafeLock(recordPath, `${label} has a malformed or foreign ownership record`);
  }
  return { descriptor, record };
}

function ownerState(pid: number): "live" | "dead" | "indeterminate" {
  if (pid === process.pid) return "live";
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "indeterminate";
  }
}

function pathMatches(pathname: string, descriptor: number): boolean {
  let observed: number | undefined;
  try {
    observed = fs.openSync(pathname, FILE_FLAGS);
    return sameIdentity(identity(observed), identity(descriptor));
  } catch {
    return false;
  } finally {
    if (observed !== undefined) fs.closeSync(observed);
  }
}

function unlinkOwned(pathname: string, descriptor: number): boolean {
  if (!pathMatches(pathname, descriptor)) return false;
  try {
    fs.unlinkSync(pathname);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function prepareRecord(directory: string, basename: string, record: PersonalGlossaryRefreshCommitLockRecord): { path: string; descriptor: number } {
  const preparedPath = path.join(directory, `.${basename}.${record.token}.tmp`);
  const descriptor = fs.openSync(preparedPath, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`);
    fs.fsyncSync(descriptor);
    return { path: preparedPath, descriptor };
  } catch (error) {
    fs.closeSync(descriptor);
    fs.rmSync(preparedPath, { force: true });
    throw error;
  }
}

function publishPrepared(prepared: { path: string; descriptor: number }, targetPath: string): boolean {
  try {
    fs.linkSync(prepared.path, targetPath);
    try {
      fs.unlinkSync(prepared.path);
    } catch (error) {
      unlinkOwned(targetPath, prepared.descriptor);
      throw error;
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

function removeDeadClaim(claimPath: string): void {
  const claim = openOwnedRecord(claimPath, "reclaim claim");
  if (!claim) return;
  try {
    const state = ownerState(claim.record.pid);
    if (state === "live") throw new PersonalGlossaryRefreshCommitBusyError("another refresh is reclaiming an orphaned personal glossary refresh lock");
    if (state === "indeterminate") unsafeLock(claimPath, "reclaim claim owner liveness is indeterminate");
    if (!unlinkOwned(claimPath, claim.descriptor)) unsafeLock(claimPath, "reclaim claim changed identity before recovery");
  } finally {
    fs.closeSync(claim.descriptor);
  }
}

function reclaimDeadOwner(lockPath: string, current: { descriptor: number; record: PersonalGlossaryRefreshCommitLockRecord }, prepared: { path: string; descriptor: number }, record: PersonalGlossaryRefreshCommitLockRecord): PersonalGlossaryRefreshCommitLock {
  const claimPath = `${lockPath}.reclaim`;
  const claim = prepareRecord(path.dirname(lockPath), path.basename(claimPath), record);
  if (!publishPrepared(claim, claimPath)) {
    fs.rmSync(claim.path, { force: true });
    fs.closeSync(claim.descriptor);
    throw new PersonalGlossaryRefreshCommitBusyError("another refresh is reclaiming an orphaned personal glossary refresh lock");
  }
  let adopted = false;
  try {
    const observed = readRecord(current.descriptor);
    if (!pathMatches(lockPath, current.descriptor) || !observed || !sameRecord(observed, current.record)) {
      unsafeLock(lockPath, "owner changed identity before orphan recovery");
    }
    const state = ownerState(current.record.pid);
    if (state === "live") throw new PersonalGlossaryRefreshCommitBusyError();
    if (state === "indeterminate") unsafeLock(lockPath, "owner liveness is indeterminate");
    if (!unlinkOwned(lockPath, current.descriptor)) unsafeLock(lockPath, "owner changed identity during orphan recovery");
    if (!publishPrepared(prepared, lockPath)) unsafeLock(lockPath, "a successor appeared during orphan recovery");
    if (!unlinkOwned(claimPath, claim.descriptor)) {
      unlinkOwned(lockPath, prepared.descriptor);
      unsafeLock(claimPath, "reclaim claim changed identity before release");
    }
    adopted = true;
    return { descriptor: prepared.descriptor, path: lockPath, record };
  } finally {
    if (!adopted) unlinkOwned(claimPath, claim.descriptor);
    fs.closeSync(claim.descriptor);
  }
}

/** Exclude another consented refresh until evidence and its projection are committed together. */
export function acquirePersonalGlossaryRefreshCommitLock(options: PersonalGlossaryCandidateProjectionStorageOptions = {}): PersonalGlossaryRefreshCommitLock {
  const directory = path.dirname(personalGlossaryCandidateProjectionPath(options));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const lockPath = path.join(directory, ".refresh.lock");
  removeDeadClaim(`${lockPath}.reclaim`);
  const record: PersonalGlossaryRefreshCommitLockRecord = {
    schema_version: LOCK_SCHEMA_VERSION,
    pid: process.pid,
    token: randomUUID(),
    created_at: new Date().toISOString(),
  };
  const prepared = prepareRecord(directory, path.basename(lockPath), record);
  try {
    if (publishPrepared(prepared, lockPath)) return { descriptor: prepared.descriptor, path: lockPath, record };
    const current = openOwnedRecord(lockPath, "owner");
    if (!current) unsafeLock(lockPath, "owner disappeared during inspection");
    try {
      const state = ownerState(current.record.pid);
      if (state === "live") throw new PersonalGlossaryRefreshCommitBusyError();
      if (state === "indeterminate") unsafeLock(lockPath, "owner liveness is indeterminate");
      return reclaimDeadOwner(lockPath, current, prepared, record);
    } finally {
      fs.closeSync(current.descriptor);
    }
  } catch (error) {
    if (pathMatches(prepared.path, prepared.descriptor)) fs.rmSync(prepared.path, { force: true });
    fs.closeSync(prepared.descriptor);
    throw error;
  }
}

export function releasePersonalGlossaryRefreshCommitLock(lock: PersonalGlossaryRefreshCommitLock): void {
  try {
    if (pathMatches(lock.path, lock.descriptor)) {
      const observed = readRecord(lock.descriptor);
      if (observed && sameRecord(observed, lock.record)) unlinkOwned(lock.path, lock.descriptor);
    }
  } finally {
    fs.closeSync(lock.descriptor);
  }
}

function familySummary(keys: readonly string[], candidateCount: number, abstentions: ReadonlyArray<{ reason: string }>): PersonalGlossaryMiningFamilySummary {
  const counts = Object.fromEntries(keys.map((key) => [key, 0]));
  for (const abstention of abstentions) {
    if (!(abstention.reason in counts)) throw new TypeError("mining produced an unknown abstention reason");
    counts[abstention.reason] += 1;
  }
  return {
    candidate_count: candidateCount,
    abstention_count: abstentions.length,
    abstentions_by_reason: counts,
  };
}

/** Mine and publish the projection bound to the current successfully published evidence generation. */
export function produceCurrentPersonalGlossaryProjection(options: PersonalGlossaryRefreshProjectionOptions): PersonalGlossaryRefreshProjectionResult {
  const before = readCurrentGeneration(options.tiersDir);
  if (!before) throw new TypeError("current evidence generation is unavailable");

  const explicit = mineExplicitGlossaryCandidates({ tiersDir: options.tiersDir });
  const recurring = mineRecurringGlossaryCandidates({ tiersDir: options.tiersDir });
  const after = readCurrentGeneration(options.tiersDir);
  if (!after || explicit.generation !== before.manifest.generation || recurring.generation !== before.manifest.generation || after.manifest.generation !== before.manifest.generation) {
    throw new TypeError("current evidence generation changed during projection production");
  }

  const contract = personalGlossaryCandidateProjectionContract();
  const explicitSummary = familySummary(contract.explicitAbstentionKeys, explicit.candidates.length, explicit.abstentions);
  const recurringSummary = familySummary(contract.recurringAbstentionKeys, recurring.candidates.length, recurring.abstentions);
  const miningSummary: PersonalGlossaryMiningSummary = {
    schema_version: "agentera.personalGlossaryMiningSummary.v1",
    explicit: explicitSummary,
    recurring: recurringSummary,
    total_candidate_count: explicitSummary.candidate_count + recurringSummary.candidate_count,
    total_abstention_count: explicitSummary.abstention_count + recurringSummary.abstention_count,
  };
  const projection = projectPersonalGlossaryCandidates({
    generation: before.manifest.generation,
    policy_version: PERSONAL_GLOSSARY_MINING_POLICY_VERSION,
    retained_at: before.manifest.published_at,
    candidates: [
      ...explicit.candidates.map((candidate) => ({
        capsule: candidate.capsule,
        project_ids: candidate.project_ids,
      })),
      ...recurring.candidates.map((candidate) => ({
        capsule: candidate.capsule,
        project_ids: candidate.project_ids,
      })),
    ],
    mining_summary: miningSummary,
  });
  const persisted = persistPersonalGlossaryCandidateProjectionAfterRefresh(projection, options);
  const committed = readCurrentGeneration(options.tiersDir);
  if (!committed || committed.manifest.generation !== projection.generation) {
    throw new TypeError("current evidence generation changed before projection commit completed");
  }
  return {
    status: persisted.status,
    generation: projection.generation,
    policy_version: projection.policy_version,
    candidate_projection_sha256: projection.projection_sha256,
    candidate_count: projection.report.mining_summary.total_candidate_count,
    abstention_count: projection.report.mining_summary.total_abstention_count,
    path: persisted.path,
  };
}
