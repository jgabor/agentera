import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  acquireLifecycleOwnershipJournalLock,
  appendLifecycleOwnershipJournal,
  lifecycleOwnershipJournalPath,
  readLifecycleOwnershipJournal,
  releaseLifecycleOwnershipJournalLock,
} from "../../src/runtime/lifecycleOwnershipJournal.js";
import {
  LIFECYCLE_LEDGER_SCHEMA,
  emptyLifecycleOwnershipLedger,
  type LifecycleOwnershipLedger,
} from "../../src/runtime/lifecycleOperations.js";

let root: string;
let appHome: string;
let journalPath: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-journal-"));
  appHome = path.join(root, "app-home");
  journalPath = lifecycleOwnershipJournalPath(appHome);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function ledger(resourceId: string): LifecycleOwnershipLedger {
  return {
    schemaVersion: LIFECYCLE_LEDGER_SCHEMA,
    owner: "agentera",
    records: [{
      resourceId,
      destination: path.join(root, resourceId),
      kind: "file",
      scope: "whole",
      status: "pending_create",
      fingerprint: "sha256:pending",
      identity: null,
    }],
  };
}

describe("lifecycle ownership journal", () => {
  it("is read-only when absent and creates no app-home or journal directory", () => {
    const before = fs.readdirSync(root);

    const observed = readLifecycleOwnershipJournal(journalPath);

    expect(observed).toMatchObject({ state: "absent", validEvents: 0, ignoredEvents: 0 });
    expect(observed.ledger).toEqual(emptyLifecycleOwnershipLedger());
    expect(fs.readdirSync(root)).toEqual(before);
    expect(fs.existsSync(appHome)).toBe(false);
  });

  it("publishes fsynced append-only snapshots and folds the latest event after restart", () => {
    const first = appendLifecycleOwnershipJournal(journalPath, ledger("first"));
    const second = appendLifecycleOwnershipJournal(journalPath, ledger("second"));

    expect(first.state).toBe("ok");
    expect(second.ledger.records[0]?.resourceId).toBe("second");
    expect(fs.readdirSync(journalPath)).toHaveLength(2);

    const restarted = readLifecycleOwnershipJournal(journalPath);
    expect(restarted).toMatchObject({ state: "ok", validEvents: 2, ignoredEvents: 0 });
    expect(restarted.ledger.records[0]?.resourceId).toBe("second");
  });

  it("recovers the last valid snapshot when interruption leaves a partial tail event", () => {
    appendLifecycleOwnershipJournal(journalPath, ledger("durable"));
    const partial = path.join(
      journalPath,
      "00000000000000000002-00000000-0000-4000-8000-000000000002.json",
    );
    fs.writeFileSync(partial, '{"schemaVersion":"agentera.lifecycleOwnershipJournalEvent.v1"');

    const restarted = readLifecycleOwnershipJournal(journalPath);

    expect(restarted.state).toBe("recovered");
    expect(restarted.validEvents).toBe(1);
    expect(restarted.ignoredEvents).toBe(1);
    expect(restarted.ledger.records[0]?.resourceId).toBe("durable");

    appendLifecycleOwnershipJournal(journalPath, ledger("retried"));
    const converged = readLifecycleOwnershipJournal(journalPath);
    expect(converged.state).toBe("recovered");
    expect(converged.validEvents).toBe(2);
    expect(converged.ledger.records[0]?.resourceId).toBe("retried");
  });

  it("fails closed when no valid ownership event can be recovered", () => {
    fs.mkdirSync(journalPath, { recursive: true });
    fs.writeFileSync(
      path.join(journalPath, "00000000000000000001-00000000-0000-4000-8000-000000000001.json"),
      "truncated",
    );

    const observed = readLifecycleOwnershipJournal(journalPath);

    expect(observed.state).toBe("corrupt");
    expect(observed.ledger).toEqual(emptyLifecycleOwnershipLedger());
    expect(() => appendLifecycleOwnershipJournal(journalPath, ledger("blocked")))
      .toThrow("ownership journal has no recoverable event");
  });

  it("serializes apply through a proc-fd-pinned lock and recovers a stale lock", () => {
    const first = acquireLifecycleOwnershipJournalLock(journalPath);
    expect(() => acquireLifecycleOwnershipJournalLock(journalPath)).toThrow("already in progress");
    releaseLifecycleOwnershipJournalLock(first);

    const stale = acquireLifecycleOwnershipJournalLock(journalPath);
    const lockPath = path.join(stale.directory, "apply.lock");
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 2_147_483_647, token: "stale" }));
    const recovered = acquireLifecycleOwnershipJournalLock(journalPath);
    releaseLifecycleOwnershipJournalLock(recovered);
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
