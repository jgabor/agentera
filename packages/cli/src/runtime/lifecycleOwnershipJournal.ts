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

export type LifecycleOwnershipJournalState = "absent" | "ok" | "recovered" | "corrupt";

export interface LifecycleOwnershipJournalRead {
  schemaVersion: "agentera.lifecycleOwnershipJournalRead.v1";
  path: string;
  state: LifecycleOwnershipJournalState;
  ledger: LifecycleOwnershipLedger;
  validEvents: number;
  ignoredEvents: number;
  diagnostics: string[];
}

export interface LifecycleOwnershipJournalLock {
  directory: string;
  token: string;
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

interface InternalJournalRead extends LifecycleOwnershipJournalRead {
  lastDigest: string | null;
  maximumSequence: number;
}

const EVENT_NAME = /^(\d{20})-([0-9a-f-]{36})\.json$/;
const DIRECTORY_FLAGS = fs.constants.O_RDONLY
  | (fs.constants.O_DIRECTORY ?? 0)
  | (fs.constants.O_NOFOLLOW ?? 0);

function digestBody(body: LifecycleOwnershipJournalEventBody): string {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex")}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateEvent(
  value: unknown,
  expectedSequence: number,
  previousDigest: string | null,
): value is LifecycleOwnershipJournalEvent {
  if (!isObject(value)) return false;
  if (
    value.schemaVersion !== LIFECYCLE_OWNERSHIP_JOURNAL_SCHEMA
    || value.sequence !== expectedSequence
    || typeof value.eventId !== "string"
    || typeof value.recordedAt !== "string"
    || value.previousDigest !== previousDigest
    || typeof value.digest !== "string"
  ) {
    return false;
  }
  const ledgerErrors = validateLifecycleOwnershipLedger(value.ledger);
  if (ledgerErrors.length > 0) return false;
  const body: LifecycleOwnershipJournalEventBody = {
    schemaVersion: LIFECYCLE_OWNERSHIP_JOURNAL_SCHEMA,
    sequence: value.sequence as number,
    eventId: value.eventId as string,
    previousDigest: value.previousDigest as string | null,
    recordedAt: value.recordedAt as string,
    ledger: value.ledger as LifecycleOwnershipLedger,
  };
  return value.digest === digestBody(body);
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

function readJournal(journalPath: string): InternalJournalRead {
  const resolved = path.resolve(journalPath);
  const directoryState = safeDirectoryState(resolved);
  if (directoryState === "absent") {
    return {
      schemaVersion: "agentera.lifecycleOwnershipJournalRead.v1",
      path: resolved,
      state: "absent",
      ledger: emptyLifecycleOwnershipLedger(),
      validEvents: 0,
      ignoredEvents: 0,
      diagnostics: [],
      lastDigest: null,
      maximumSequence: 0,
    };
  }
  if (directoryState === "unsafe") {
    return {
      schemaVersion: "agentera.lifecycleOwnershipJournalRead.v1",
      path: resolved,
      state: "corrupt",
      ledger: emptyLifecycleOwnershipLedger(),
      validEvents: 0,
      ignoredEvents: 0,
      diagnostics: ["ownership journal path contains a symlink, non-directory, or unreadable component"],
      lastDigest: null,
      maximumSequence: 0,
    };
  }

  const diagnostics: string[] = [];
  let ledger = emptyLifecycleOwnershipLedger();
  let validEvents = 0;
  let ignoredEvents = 0;
  let lastDigest: string | null = null;
  let maximumSequence = 0;
  const names = fs.readdirSync(resolved).filter((name) => name.endsWith(".json")).sort();
  for (const name of names) {
    const match = EVENT_NAME.exec(name);
    if (!match) {
      ignoredEvents += 1;
      diagnostics.push(`${name}: ignored unrecognized ownership journal entry`);
      continue;
    }
    const sequence = Number(match[1]);
    maximumSequence = Math.max(maximumSequence, sequence);
    try {
      const eventPath = path.join(resolved, name);
      const eventStat = fs.lstatSync(eventPath);
      if (!eventStat.isFile() || eventStat.isSymbolicLink()) throw new Error("unsafe journal event type");
      const eventFd = fs.openSync(eventPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      let text: string;
      try {
        text = fs.readFileSync(eventFd, "utf8");
      } finally {
        fs.closeSync(eventFd);
      }
      const value: unknown = JSON.parse(text);
      if (!validateEvent(value, sequence, lastDigest)) {
        ignoredEvents += 1;
        diagnostics.push(`${name}: ignored incomplete, invalid, or disconnected ownership journal event`);
        continue;
      }
      const event = value as LifecycleOwnershipJournalEvent;
      ledger = event.ledger;
      lastDigest = event.digest;
      validEvents += 1;
    } catch {
      ignoredEvents += 1;
      diagnostics.push(`${name}: ignored incomplete or unreadable ownership journal event`);
    }
  }
  return {
    schemaVersion: "agentera.lifecycleOwnershipJournalRead.v1",
    path: resolved,
    state: diagnostics.length === 0 ? "ok" : validEvents > 0 ? "recovered" : "corrupt",
    ledger,
    validEvents,
    ignoredEvents,
    diagnostics,
    lastDigest,
    maximumSequence,
  };
}

export function lifecycleOwnershipJournalPath(appHome: string): string {
  return path.join(path.resolve(appHome), ".agentera", "runtime-lifecycle", "ownership-journal-v1");
}

export function isLifecycleOwnershipStateDirectory(directory: string): boolean {
  if (safeDirectoryState(directory) !== "directory") return false;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "apply.lock" && entry.isFile()) continue;
    if (entry.name === "ownership-journal-v1" && entry.isDirectory() && !entry.isSymbolicLink()) {
      const journal = path.join(directory, entry.name);
      if (fs.readdirSync(journal, { withFileTypes: true }).every((event) =>
        event.isFile() && EVENT_NAME.test(event.name))) continue;
    }
    return false;
  }
  return true;
}

export function readLifecycleOwnershipJournal(journalPath: string): LifecycleOwnershipJournalRead {
  const { lastDigest: _lastDigest, maximumSequence: _maximumSequence, ...result } = readJournal(journalPath);
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

function appendEventFile(journalPath: string, name: string, bytes: Buffer): void {
  const directoryFd = ensureDirectoryTreePinned(journalPath);
  let fileFd: number | null = null;
  try {
    fileFd = fs.openSync(
      `/proc/self/fd/${directoryFd}/${name}`,
      fs.constants.O_WRONLY
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(fileFd, bytes, offset, bytes.length - offset, offset);
      if (written === 0) throw new Error("ownership journal write made no progress");
      offset += written;
    }
    fs.fsyncSync(fileFd);
    fs.closeSync(fileFd);
    fileFd = null;
    fs.fsyncSync(directoryFd);
  } finally {
    if (fileFd !== null) fs.closeSync(fileFd);
    fs.closeSync(directoryFd);
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function readLock(lockPath: string): { pid: number; token: string } | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(lockPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const value: unknown = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (
      isObject(value)
      && typeof value.pid === "number"
      && Number.isSafeInteger(value.pid)
      && typeof value.token === "string"
    ) return { pid: value.pid, token: value.token };
  } catch {
    // Malformed lock bytes are stale because no live PID can be established.
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  return null;
}

export function acquireLifecycleOwnershipJournalLock(
  journalPath: string,
): LifecycleOwnershipJournalLock {
  const directory = path.dirname(path.resolve(journalPath));
  const directoryFd = ensureDirectoryTreePinned(directory);
  const lockPath = `/proc/self/fd/${directoryFd}/apply.lock`;
  const token = crypto.randomUUID();
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let fd: number | null = null;
      try {
        fd = fs.openSync(
          lockPath,
          fs.constants.O_WRONLY
            | fs.constants.O_CREAT
            | fs.constants.O_EXCL
            | (fs.constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        const bytes = Buffer.from(`${JSON.stringify({ pid: process.pid, token })}\n`);
        let offset = 0;
        while (offset < bytes.length) {
          const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
          if (written === 0) throw new Error("lifecycle ownership journal lock write made no progress");
          offset += written;
        }
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = null;
        fs.fsyncSync(directoryFd);
        return { directory, token };
      } catch (error) {
        if (fd !== null) fs.closeSync(fd);
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = readLock(lockPath);
        if (existing && processAlive(existing.pid)) {
          throw new Error(`lifecycle apply already in progress (pid ${existing.pid})`);
        }
        fs.unlinkSync(lockPath);
        fs.fsyncSync(directoryFd);
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
    if (!existing || existing.token !== lock.token || existing.pid !== process.pid) {
      throw new Error("lifecycle ownership journal lock identity changed before release");
    }
    fs.unlinkSync(lockPath);
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
    if (previous.state === "corrupt") {
      throw new Error(`ownership journal has no recoverable event: ${previous.diagnostics.join("; ")}`);
    }
    const sequence = previous.maximumSequence + 1;
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
      appendEventFile(resolved, name, Buffer.from(`${JSON.stringify(event, null, 2)}\n`));
      return readLifecycleOwnershipJournal(resolved);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("ownership journal remained busy after bounded append retries");
}
