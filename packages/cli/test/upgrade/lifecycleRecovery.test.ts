import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendLifecycleOwnershipJournal, lifecycleOwnershipJournalPath, readLifecycleOwnershipJournal } from "../../src/runtime/lifecycleOwnershipJournal.js";
import { applyLifecycleOperations, createLifecycleOwnershipManifest, emptyLifecycleOwnershipLedger, lifecycleOperationFingerprint, planLifecycleOperations, type LifecycleOperationSpec, type LifecycleOwnershipLedger } from "../../src/runtime/lifecycleOperations.js";

let root: string;
let appHome: string;
let journalPath: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-recovery-"));
  appHome = path.join(root, "app-home");
  journalPath = lifecycleOwnershipJournalPath(appHome);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function spec(id: string, dependsOn: string[] = []): LifecycleOperationSpec {
  return {
    id,
    destination: path.join(root, `${id}.txt`),
    kind: "file",
    intent: "ensure",
    content: `${id}\n`,
    dependsOn,
  };
}

function pendingLedger(operation: LifecycleOperationSpec): LifecycleOwnershipLedger {
  return {
    ...emptyLifecycleOwnershipLedger(),
    records: [
      {
        resourceId: operation.id,
        destination: operation.destination,
        kind: operation.kind,
        scope: "whole",
        status: "pending_create",
        fingerprint: lifecycleOperationFingerprint(operation),
        identity: null,
      },
    ],
  };
}

function plan(operations: LifecycleOperationSpec[], ledger: LifecycleOwnershipLedger) {
  return planLifecycleOperations({
    allowedRoots: [root],
    operations,
    manifest: createLifecycleOwnershipManifest(operations),
    ledger,
  });
}

function persist(next: LifecycleOwnershipLedger): void {
  appendLifecycleOwnershipJournal(journalPath, next);
}

function interruptedPublicationTemporary(sequence: number): void {
  fs.mkdirSync(journalPath, { recursive: true });
  fs.writeFileSync(path.join(journalPath, `.event-${String(sequence).padStart(20, "0")}-00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}.tmp`), '{"schemaVersion":"agentera.lifecycleOwnershipJournalEvent.v1"');
}

describe("lifecycle crash recovery and convergence", () => {
  it("retries safely after interruption before resource publication", () => {
    const operation = spec("before-resource");
    const first = applyLifecycleOperations(plan([operation], emptyLifecycleOwnershipLedger()), {
      persistLedger: persist,
      beforePublication() {
        throw new Error("interrupted before resource publication");
      },
    });

    expect(first.operations[0].status).toBe("failed");
    expect(fs.existsSync(operation.destination)).toBe(false);
    const restartedLedger = readLifecycleOwnershipJournal(journalPath).ledger;
    expect(restartedLedger.records[0]).toMatchObject({ status: "pending_create", identity: null });

    const retry = applyLifecycleOperations(plan([operation], restartedLedger), {
      persistLedger: persist,
    });
    expect(retry.operations[0].status).toBe("applied");
    expect(fs.readFileSync(operation.destination, "utf8")).toBe("before-resource\n");
  });

  it("finalizes safely after resource publication outlives its identity-ledger event", () => {
    const operation = spec("after-resource");
    appendLifecycleOwnershipJournal(journalPath, pendingLedger(operation));
    fs.writeFileSync(operation.destination, operation.content as string);

    const restartedLedger = readLifecycleOwnershipJournal(journalPath).ledger;
    const restartPlan = plan([operation], restartedLedger);
    expect(restartPlan.operations[0]).toMatchObject({
      action: "finalize_ownership",
      state: "exact",
    });

    const retry = applyLifecycleOperations(restartPlan, { persistLedger: persist });
    expect(retry.operations[0].status).toBe("applied");
    expect(retry.ownershipLedger.records[0]).toMatchObject({ status: "managed" });
  });

  it("ignores an interrupted non-authoritative publication and converges from the durable event", () => {
    const operation = spec("before-ledger");
    appendLifecycleOwnershipJournal(journalPath, pendingLedger(operation));
    fs.writeFileSync(operation.destination, operation.content as string);
    interruptedPublicationTemporary(2);

    const restarted = readLifecycleOwnershipJournal(journalPath);
    expect(restarted).toMatchObject({ state: "clean", temporaryArtifacts: 1 });
    expect(restarted.ledger.records[0]).toMatchObject({ status: "pending_create", identity: null });

    const retry = applyLifecycleOperations(plan([operation], restarted.ledger), {
      persistLedger: persist,
    });
    expect(retry.operations[0]).toMatchObject({ action: "finalize_ownership", status: "applied" });
  });

  it("keeps completed work noop after a durable event plus interrupted publication temporary", () => {
    const operation = spec("after-ledger");
    const first = applyLifecycleOperations(plan([operation], emptyLifecycleOwnershipLedger()), {
      persistLedger: persist,
    });
    expect(first.operations[0].status).toBe("applied");
    interruptedPublicationTemporary(readLifecycleOwnershipJournal(journalPath).validEvents + 1);

    const restarted = readLifecycleOwnershipJournal(journalPath);
    expect(restarted).toMatchObject({ state: "clean", temporaryArtifacts: 1 });
    const retry = applyLifecycleOperations(plan([operation], restarted.ledger), {
      persistLedger: persist,
    });
    expect(retry.operations[0]).toMatchObject({ action: "noop", status: "noop" });
  });

  it("continues independent work, skips dependents with cause, and retries only remaining operations", () => {
    const a = spec("a");
    const b = spec("b");
    const c = spec("c", ["a"]);
    const operations = [a, b, c];
    const first = applyLifecycleOperations(plan(operations, emptyLifecycleOwnershipLedger()), {
      persistLedger: persist,
      beforePublication(boundary) {
        if (boundary.operationId === "a") throw new Error("a failed independently");
      },
    });

    expect(first.operations.map(({ id, status }) => [id, status])).toEqual([
      ["a", "failed"],
      ["b", "applied"],
      ["c", "skipped_dependency"],
    ]);
    expect(first.operations[2].dependencyCauses).toEqual(["a"]);

    const restarted = readLifecycleOwnershipJournal(journalPath);
    const retry = applyLifecycleOperations(plan(operations, restarted.ledger), {
      persistLedger: persist,
    });
    expect(retry.operations.map(({ id, status }) => [id, status])).toEqual([
      ["a", "applied"],
      ["b", "noop"],
      ["c", "applied"],
    ]);
    const converged = applyLifecycleOperations(plan(operations, retry.ownershipLedger));
    expect(converged.operations.every((operation) => operation.status === "noop")).toBe(true);
  });
});
