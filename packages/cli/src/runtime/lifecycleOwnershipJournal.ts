import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  emptyLifecycleOwnershipLedger,
  validateLifecycleOwnershipLedger,
  type LifecycleOwnershipLedger,
} from "./lifecycleOperations.js";
import { secureLifecycleRemovalAvailable } from "./lifecyclePublication.js";

export const LIFECYCLE_OWNERSHIP_JOURNAL_SCHEMA =
  "agentera.lifecycleOwnershipJournalEvent.v1" as const;

const LIFECYCLE_OWNERSHIP_LOCK_SCHEMA = "agentera.lifecycleOwnershipJournalLock.v1" as const;

export type LifecycleOwnershipJournalState =
  | "absent"
  | "clean"
  | "recoverable_terminal_tail"
  | "corrupt";

export interface LifecycleOwnershipJournalRead {
  schemaVersion: "agentera.lifecycleOwnershipJournalRead.v1";
  path: string;
  state: LifecycleOwnershipJournalState;
  ledger: LifecycleOwnershipLedger;
  validEvents: number;
  ignoredEvents: number;
  temporaryArtifacts: number;
  diagnostics: string[];
}

export interface LifecycleOwnershipJournalLock {
  directory: string;
  token: string;
  bootId: string;
  processStartTicks: string;
}

interface LifecycleOwnershipJournalEventBody {
  schemaVersion: typeof LIFECYCLE_OWNERSHIP_JOURNAL_SCHEMA;
  sequence: number;
  eventId: string;
  previousDigest: string | null;
  recordedAt: string;
  ledger: LifecycleOwnershipLedger;
}

interface LifecycleOwnershipJournalEvent extends LifecycleOwnershipJournalEventBody {
  digest: string;
}

interface LifecycleOwnershipLockRecord {
  schemaVersion: typeof LIFECYCLE_OWNERSHIP_LOCK_SCHEMA;
  pid: number;
  bootId: string;
  processStartTicks: string;
  token: string;
}

interface InternalJournalRead extends LifecycleOwnershipJournalRead {
  lastDigest: string | null;
}

type ParsedEvent =
  | { state: "valid"; event: LifecycleOwnershipJournalEvent }
  | { state: "incomplete"; reason: string }
  | { state: "invalid"; reason: string };

type LockRead =
  | { state: "valid"; record: LifecycleOwnershipLockRecord }
  | { state: "absent" }
  | { state: "malformed"; reason: string };

const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const EVENT_NAME = new RegExp(`^(\\d{20})-(${UUID_PATTERN})\\.json$`);
const TEMP_EVENT_NAME = new RegExp(`^\\.event-(\\d{20})-(${UUID_PATTERN})\\.tmp$`);
const TEMP_LOCK_NAME = new RegExp(`^\\.apply-lock-(${UUID_PATTERN})\\.tmp$`);
const LOCK_RECORD_NAME = "owner.json";
const DIRECTORY_FLAGS = fs.constants.O_RDONLY
  | (fs.constants.O_DIRECTORY ?? 0)
  | (fs.constants.O_NOFOLLOW ?? 0);

function digestBody(body: LifecycleOwnershipJournalEventBody): string {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex")}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function eventFromValue(value: unknown): LifecycleOwnershipJournalEvent | null {
  if (!isObject(value)) return null;
  if (
    value.schemaVersion !== LIFECYCLE_OWNERSHIP_JOURNAL_SCHEMA
    || !Number.isSafeInteger(value.sequence)
    || typeof value.eventId !== "string"
    || typeof value.recordedAt !== "string"
    || (value.previousDigest !== null && typeof value.previousDigest !== "string")
    || typeof value.digest !== "string"
  ) {
    return null;
  }
  const ledgerErrors = validateLifecycleOwnershipLedger(value.ledger);
  if (ledgerErrors.length > 0) return null;
  return value as unknown as LifecycleOwnershipJournalEvent;
}

function incompleteJsonAtEnd(text: string, error: unknown): boolean {
  const trimmed = text.trimEnd();
  if (trimmed.length === 0) return true;
  const message = error instanceof Error ? error.message : "";
  const position = /position (\d+)/i.exec(message);
  const failedAtEnd = message.toLowerCase().includes("end of json input")
    || (position !== null && Number(position[1]) >= trimmed.length - 1);
  if (!failedAtEnd) return false;

  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const character of trimmed) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") stack.push(character);
    else if (character === "}" || character === "]") {
      const expected = character === "}" ? "{" : "[";
      if (stack.pop() !== expected) return false;
    }
  }
  return inString || stack.length > 0 || /[:,]$/.test(trimmed);
}

function readEvent(eventPath: string): ParsedEvent {
  let fd: number | null = null;
  try {
    const stat = fs.lstatSync(eventPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { state: "invalid", reason: "unsafe journal event type" };
    }
    fd = fs.openSync(eventPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const text = fs.readFileSync(fd, "utf8");
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      return incompleteJsonAtEnd(text, error)
        ? { state: "incomplete", reason: "syntactically incomplete publication" }
        : { state: "invalid", reason: "malformed complete JSON publication" };
    }
    const event = eventFromValue(value);
    return event
      ? { state: "valid", event }
      : { state: "invalid", reason: "complete event does not satisfy the journal schema" };
  } catch (error) {
    return { state: "invalid", reason: `unreadable journal event: ${(error as Error).message}` };
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function safeDirectoryState(directory: string): "absent" | "directory" | "unsafe" {
  const resolved = path.resolve(directory);
  const root = path.parse(resolved).root;
  let cursor = root;
  for (const segment of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      const stat = fs.lstatSync(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return "unsafe";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
      return "unsafe";
    }
  }
  return "directory";
}

function baseRead(pathname: string, state: LifecycleOwnershipJournalState): InternalJournalRead {
  return {
    schemaVersion: "agentera.lifecycleOwnershipJournalRead.v1",
    path: pathname,
    state,
    ledger: emptyLifecycleOwnershipLedger(),
    validEvents: 0,
    ignoredEvents: 0,
    temporaryArtifacts: 0,
    diagnostics: [],
    lastDigest: null,
  };
}

function corruptRead(
  current: InternalJournalRead,
  reason: string,
  finalEventCount: number,
): InternalJournalRead {
  return {
    ...current,
    state: "corrupt",
    ignoredEvents: Math.max(current.ignoredEvents, finalEventCount - current.validEvents),
    diagnostics: [...current.diagnostics, reason],
  };
}

function readJournal(journalPath: string): InternalJournalRead {
  const resolved = path.resolve(journalPath);
  const directoryState = safeDirectoryState(resolved);
  if (directoryState === "absent") return baseRead(resolved, "absent");
  if (directoryState === "unsafe") {
    return corruptRead(
      baseRead(resolved, "corrupt"),
      "ownership journal path contains a symlink, non-directory, or unreadable component",
      0,
    );
  }

  const current = baseRead(resolved, "clean");
  const events: Array<{ name: string; sequence: number; eventId: string }> = [];
  for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
    const eventMatch = EVENT_NAME.exec(entry.name);
    if (eventMatch) {
      events.push({ name: entry.name, sequence: Number(eventMatch[1]), eventId: eventMatch[2]! });
      continue;
    }
    if (TEMP_EVENT_NAME.test(entry.name) && entry.isFile() && !entry.isSymbolicLink()) {
      current.temporaryArtifacts += 1;
      current.diagnostics.push(`${entry.name}: ignored non-authoritative journal publication temporary`);
      continue;
    }
    return corruptRead(current, `${entry.name}: unrecognized or unsafe ownership journal entry`, events.length);
  }
  events.sort((left, right) => left.sequence - right.sequence || left.name.localeCompare(right.name));

  for (let index = 0; index < events.length; index += 1) {
    const item = events[index]!;
    const expectedSequence = current.validEvents + 1;
    if (item.sequence !== expectedSequence) {
      const kind = item.sequence < expectedSequence ? "duplicate sequence or fork" : "sequence gap";
      return corruptRead(
        current,
        `${item.name}: ${kind}; expected sequence ${expectedSequence}`,
        events.length,
      );
    }
    if (events[index + 1]?.sequence === item.sequence) {
      return corruptRead(current, `${item.name}: duplicate sequence or fork`, events.length);
    }

    const parsed = readEvent(path.join(resolved, item.name));
    if (parsed.state === "incomplete") {
      if (index === events.length - 1) {
        current.state = "recoverable_terminal_tail";
        current.ignoredEvents = 1;
        current.diagnostics.push(
          `${item.name}: recoverable terminal tail (${parsed.reason}); mutation remains blocked until removed`,
        );
        return current;
      }
      return corruptRead(
        current,
        `${item.name}: incomplete publication occurs before a successor event`,
        events.length,
      );
    }
    if (parsed.state === "invalid") {
      return corruptRead(current, `${item.name}: ${parsed.reason}`, events.length);
    }
    const event = parsed.event;
    if (event.sequence !== item.sequence) {
      return corruptRead(current, `${item.name}: filename and body sequence differ`, events.length);
    }
    if (event.eventId !== item.eventId) {
      return corruptRead(current, `${item.name}: filename and body event ID differ`, events.length);
    }
    if (event.previousDigest !== current.lastDigest) {
      return corruptRead(current, `${item.name}: previous digest disconnects the hash chain`, events.length);
    }
    const { digest, ...body } = event;
    if (digest !== digestBody(body)) {
      return corruptRead(current, `${item.name}: event digest mismatch`, events.length);
    }
    current.ledger = event.ledger;
    current.lastDigest = digest;
    current.validEvents += 1;
  }
  return current;
}

export function lifecycleOwnershipJournalPath(appHome: string): string {
  return path.join(path.resolve(appHome), ".agentera", "runtime-lifecycle", "ownership-journal-v1");
}

function ownedLockDirectory(directory: string): boolean {
  try {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    return entries.length === 1
      && entries[0]?.name === LOCK_RECORD_NAME
      && entries[0].isFile()
      && !entries[0].isSymbolicLink();
  } catch {
    return false;
  }
}

export function isLifecycleOwnershipStateDirectory(directory: string): boolean {
  if (safeDirectoryState(directory) !== "directory") return false;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.name === "apply.lock" && entry.isDirectory() && !entry.isSymbolicLink()) {
      if (ownedLockDirectory(full)) continue;
      return false;
    }
    if (TEMP_LOCK_NAME.test(entry.name) && entry.isDirectory() && !entry.isSymbolicLink()) {
      if (ownedLockDirectory(full)) continue;
      return false;
    }
    if (entry.name === "ownership-journal-v1" && entry.isDirectory() && !entry.isSymbolicLink()) {
      const journalEntries = fs.readdirSync(full, { withFileTypes: true });
      if (journalEntries.every((event) =>
        (event.isFile() && !event.isSymbolicLink() && EVENT_NAME.test(event.name))
        || (event.isFile() && !event.isSymbolicLink() && TEMP_EVENT_NAME.test(event.name)))) continue;
    }
    return false;
  }
  return true;
}

export function readLifecycleOwnershipJournal(journalPath: string): LifecycleOwnershipJournalRead {
  const { lastDigest: _lastDigest, ...result } = readJournal(journalPath);
  return result;
}

function ensureDirectoryTreePinned(directory: string): number {
  if (!secureLifecycleRemovalAvailable()) {
    throw new Error("ownership journal publication requires Linux /proc/self/fd directory-relative access");
  }
  const resolved = path.resolve(directory);
  const root = path.parse(resolved).root;
  let currentFd = fs.openSync(root, DIRECTORY_FLAGS);
  try {
    for (const segment of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
      const target = `/proc/self/fd/${currentFd}/${segment}`;
      try {
        fs.mkdirSync(target, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const nextFd = fs.openSync(target, DIRECTORY_FLAGS);
      fs.closeSync(currentFd);
      currentFd = nextFd;
    }
    return currentFd;
  } catch (error) {
    fs.closeSync(currentFd);
    throw error;
  }
}

function writeAll(fd: number, bytes: Buffer, errorMessage: string): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
    if (written === 0) throw new Error(errorMessage);
    offset += written;
  }
}

function appendEventFile(journalPath: string, name: string, eventId: string, bytes: Buffer): void {
  const directoryFd = ensureDirectoryTreePinned(journalPath);
  const temporaryName = `.event-${name.slice(0, 20)}-${eventId}.tmp`;
  const temporaryPath = `/proc/self/fd/${directoryFd}/${temporaryName}`;
  const finalPath = `/proc/self/fd/${directoryFd}/${name}`;
  let fileFd: number | null = null;
  let temporaryCreated = false;
  try {
    fileFd = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    temporaryCreated = true;
    writeAll(fileFd, bytes, "ownership journal write made no progress");
    fs.fsyncSync(fileFd);
    fs.closeSync(fileFd);
    fileFd = null;
    fs.linkSync(temporaryPath, finalPath);
    fs.fsyncSync(directoryFd);
    fs.unlinkSync(temporaryPath);
    temporaryCreated = false;
    fs.fsyncSync(directoryFd);
  } finally {
    if (fileFd !== null) fs.closeSync(fileFd);
    if (temporaryCreated) {
      try {
        fs.unlinkSync(temporaryPath);
        fs.fsyncSync(directoryFd);
      } catch {
        // A crash may leave a uniquely named non-authoritative temporary; readers ignore it.
      }
    }
    fs.closeSync(directoryFd);
  }
}

function bootId(): string {
  const value = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (!/^[0-9a-f-]{36}$/i.test(value)) throw new Error("Linux boot identity is unavailable");
  return value;
}

function processStartTicks(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8").trim();
    const close = stat.lastIndexOf(") ");
    if (close < 0) throw new Error("malformed proc stat record");
    const fields = stat.slice(close + 2).split(/\s+/);
    const value = fields[19];
    if (!value || !/^\d+$/.test(value)) throw new Error("proc start ticks are unavailable");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function currentLockRecord(token: string = crypto.randomUUID()): LifecycleOwnershipLockRecord {
  const startTicks = processStartTicks(process.pid);
  if (startTicks === null) throw new Error("current process identity is unavailable");
  return {
    schemaVersion: LIFECYCLE_OWNERSHIP_LOCK_SCHEMA,
    pid: process.pid,
    bootId: bootId(),
    processStartTicks: startTicks,
    token,
  };
}

function lockRecord(value: unknown): LifecycleOwnershipLockRecord | null {
  if (!isObject(value)) return null;
  if (
    value.schemaVersion !== LIFECYCLE_OWNERSHIP_LOCK_SCHEMA
    || !Number.isSafeInteger(value.pid)
    || (value.pid as number) <= 0
    || typeof value.bootId !== "string"
    || typeof value.processStartTicks !== "string"
    || !/^\d+$/.test(value.processStartTicks)
    || typeof value.token !== "string"
    || value.token.length === 0
  ) return null;
  return value as unknown as LifecycleOwnershipLockRecord;
}

function readLock(lockPath: string): LockRead {
  let directoryFd: number | null = null;
  let recordFd: number | null = null;
  try {
    const stat = fs.lstatSync(lockPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { state: "malformed", reason: "final lock is not a safe directory" };
    }
    directoryFd = fs.openSync(lockPath, DIRECTORY_FLAGS);
    const entries = fs.readdirSync(`/proc/self/fd/${directoryFd}`);
    if (entries.length !== 1 || entries[0] !== LOCK_RECORD_NAME) {
      return { state: "malformed", reason: "final lock does not contain exactly one owner record" };
    }
    recordFd = fs.openSync(
      `/proc/self/fd/${directoryFd}/${LOCK_RECORD_NAME}`,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const value: unknown = JSON.parse(fs.readFileSync(recordFd, "utf8"));
    const record = lockRecord(value);
    return record
      ? { state: "valid", record }
      : { state: "malformed", reason: "final lock owner record does not satisfy its schema" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
    return { state: "malformed", reason: `final lock is unreadable: ${(error as Error).message}` };
  } finally {
    if (recordFd !== null) fs.closeSync(recordFd);
    if (directoryFd !== null) fs.closeSync(directoryFd);
  }
}

function sameLockRecord(left: LifecycleOwnershipLockRecord, right: LifecycleOwnershipLockRecord): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.pid === right.pid
    && left.bootId === right.bootId
    && left.processStartTicks === right.processStartTicks
    && left.token === right.token;
}

function lockOwnerState(record: LifecycleOwnershipLockRecord): "live" | "stale" {
  if (record.bootId !== bootId()) return "stale";
  const startTicks = processStartTicks(record.pid);
  return startTicks === record.processStartTicks ? "live" : "stale";
}

function cleanupPreparedLock(parentFd: number, temporaryName: string): void {
  const temporaryPath = `/proc/self/fd/${parentFd}/${temporaryName}`;
  try {
    const temporaryFd = fs.openSync(temporaryPath, DIRECTORY_FLAGS);
    try {
      fs.unlinkSync(`/proc/self/fd/${temporaryFd}/${LOCK_RECORD_NAME}`);
      fs.fsyncSync(temporaryFd);
    } finally {
      fs.closeSync(temporaryFd);
    }
    fs.rmdirSync(temporaryPath);
    fs.fsyncSync(parentFd);
  } catch {
    // Cleanup is limited to this acquisition's unique temporary directory.
  }
}

function recoverPreparedLocks(parentFd: number): void {
  const parentPath = `/proc/self/fd/${parentFd}`;
  for (const entry of fs.readdirSync(parentPath, { withFileTypes: true })) {
    const match = TEMP_LOCK_NAME.exec(entry.name);
    if (!match || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const prepared = readLock(`${parentPath}/${entry.name}`);
    if (prepared.state !== "valid" || prepared.record.token !== match[1]) continue;
    if (lockOwnerState(prepared.record) === "live") {
      throw new Error(`lifecycle apply lock publication already in progress (pid ${prepared.record.pid})`);
    }
    cleanupPreparedLock(parentFd, entry.name);
  }
}

function publishLock(parentFd: number, record: LifecycleOwnershipLockRecord): void {
  const temporaryName = `.apply-lock-${record.token}.tmp`;
  const temporaryPath = `/proc/self/fd/${parentFd}/${temporaryName}`;
  const lockPath = `/proc/self/fd/${parentFd}/apply.lock`;
  let recordFd: number | null = null;
  let temporaryCreated = false;
  try {
    fs.mkdirSync(temporaryPath, { mode: 0o700 });
    temporaryCreated = true;
    recordFd = fs.openSync(
      `${temporaryPath}/${LOCK_RECORD_NAME}`,
      fs.constants.O_WRONLY
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeAll(
      recordFd,
      Buffer.from(`${JSON.stringify(record)}\n`),
      "lifecycle ownership journal lock write made no progress",
    );
    fs.fsyncSync(recordFd);
    fs.closeSync(recordFd);
    recordFd = null;
    const temporaryFd = fs.openSync(temporaryPath, DIRECTORY_FLAGS);
    fs.fsyncSync(temporaryFd);
    fs.closeSync(temporaryFd);
    try {
      fs.lstatSync(lockPath);
      const collision = new Error("final lifecycle apply lock already exists") as NodeJS.ErrnoException;
      collision.code = "EEXIST";
      throw collision;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    fs.renameSync(temporaryPath, lockPath);
    temporaryCreated = false;
    fs.fsyncSync(parentFd);
  } finally {
    if (recordFd !== null) fs.closeSync(recordFd);
    if (temporaryCreated) cleanupPreparedLock(parentFd, temporaryName);
  }
}

function removeStaleLock(parentFd: number, expected: LifecycleOwnershipLockRecord): boolean {
  const lockPath = `/proc/self/fd/${parentFd}/apply.lock`;
  const observed = readLock(lockPath);
  if (observed.state !== "valid" || !sameLockRecord(observed.record, expected)) return false;
  const lockFd = fs.openSync(lockPath, DIRECTORY_FLAGS);
  try {
    fs.unlinkSync(`/proc/self/fd/${lockFd}/${LOCK_RECORD_NAME}`);
    fs.fsyncSync(lockFd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  } finally {
    fs.closeSync(lockFd);
  }
  fs.rmdirSync(lockPath);
  fs.fsyncSync(parentFd);
  return true;
}

export function acquireLifecycleOwnershipJournalLock(
  journalPath: string,
): LifecycleOwnershipJournalLock {
  const directory = path.dirname(path.resolve(journalPath));
  const directoryFd = ensureDirectoryTreePinned(directory);
  const lockPath = `/proc/self/fd/${directoryFd}/apply.lock`;
  const record = currentLockRecord();
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        recoverPreparedLocks(directoryFd);
        publishLock(directoryFd, record);
        return {
          directory,
          token: record.token,
          bootId: record.bootId,
          processStartTicks: record.processStartTicks,
        };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!["EEXIST", "ENOTEMPTY", "EISDIR"].includes(code ?? "")) throw error;
        const existing = readLock(lockPath);
        if (existing.state === "malformed") {
          throw new Error(`lifecycle apply lock is malformed; refusing recovery: ${existing.reason}`);
        }
        if (existing.state === "absent") continue;
        if (lockOwnerState(existing.record) === "live") {
          throw new Error(`lifecycle apply already in progress (pid ${existing.record.pid})`);
        }
        if (!removeStaleLock(directoryFd, existing.record)) continue;
      }
    }
    throw new Error("could not acquire lifecycle ownership journal lock");
  } finally {
    fs.closeSync(directoryFd);
  }
}

export function releaseLifecycleOwnershipJournalLock(lock: LifecycleOwnershipJournalLock): void {
  const directoryFd = fs.openSync(lock.directory, DIRECTORY_FLAGS);
  const lockPath = `/proc/self/fd/${directoryFd}/apply.lock`;
  try {
    const existing = readLock(lockPath);
    const current = currentLockRecord(lock.token);
    if (
      existing.state !== "valid"
      || existing.record.pid !== process.pid
      || existing.record.token !== lock.token
      || existing.record.bootId !== lock.bootId
      || existing.record.processStartTicks !== lock.processStartTicks
      || !sameLockRecord(existing.record, current)
    ) {
      throw new Error("lifecycle ownership journal lock identity changed before release");
    }
    const lockFd = fs.openSync(lockPath, DIRECTORY_FLAGS);
    try {
      fs.unlinkSync(`/proc/self/fd/${lockFd}/${LOCK_RECORD_NAME}`);
      fs.fsyncSync(lockFd);
    } finally {
      fs.closeSync(lockFd);
    }
    fs.rmdirSync(lockPath);
    fs.fsyncSync(directoryFd);
  } finally {
    fs.closeSync(directoryFd);
  }
}

export function appendLifecycleOwnershipJournal(
  journalPath: string,
  ledger: LifecycleOwnershipLedger,
): LifecycleOwnershipJournalRead {
  const ledgerErrors = validateLifecycleOwnershipLedger(ledger);
  if (ledgerErrors.length > 0) throw new Error(ledgerErrors.join("; "));
  const resolved = path.resolve(journalPath);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const previous = readJournal(resolved);
    if (!["absent", "clean"].includes(previous.state)) {
      throw new Error(
        `ownership journal is not appendable (${previous.state}): ${previous.diagnostics.join("; ")}`,
      );
    }
    const sequence = previous.validEvents + 1;
    const eventId = crypto.randomUUID();
    const body: LifecycleOwnershipJournalEventBody = {
      schemaVersion: LIFECYCLE_OWNERSHIP_JOURNAL_SCHEMA,
      sequence,
      eventId,
      previousDigest: previous.lastDigest,
      recordedAt: new Date().toISOString(),
      ledger,
    };
    const event: LifecycleOwnershipJournalEvent = { ...body, digest: digestBody(body) };
    const name = `${String(sequence).padStart(20, "0")}-${eventId}.json`;
    try {
      appendEventFile(resolved, name, eventId, Buffer.from(`${JSON.stringify(event, null, 2)}\n`));
      return readLifecycleOwnershipJournal(resolved);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("ownership journal remained busy after bounded append retries");
}
