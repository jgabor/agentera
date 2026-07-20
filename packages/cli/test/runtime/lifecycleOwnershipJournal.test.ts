import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sourceModuleUrl, sourceSubprocessEnv } from "../helpers/sourceSubprocess.js";

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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_JOURNAL_MODULE = sourceModuleUrl("runtime/lifecycleOwnershipJournal.js");

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
      fingerprint: `sha256:${"0".repeat(64)}`,
      identity: null,
    }],
  };
}

function eventFiles(): string[] {
  return fs.readdirSync(journalPath)
    .filter((name) => /^\d{20}-.+\.json$/.test(name))
    .sort();
}

function appendEvents(count: number): void {
  for (let sequence = 1; sequence <= count; sequence += 1) {
    appendLifecycleOwnershipJournal(journalPath, ledger(`resource-${sequence}`));
  }
}

function eventValue(index: number): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(journalPath, eventFiles()[index]!), "utf8"));
}

function writeEvent(index: number, value: Record<string, unknown> | string): void {
  fs.writeFileSync(
    path.join(journalPath, eventFiles()[index]!),
    typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
  );
}

function lockRecordPath(directory: string): string {
  return path.join(directory, "apply.lock", "owner.json");
}

function waitForLine(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const newline = output.indexOf("\n");
      if (newline >= 0) resolve(output.slice(0, newline));
    });
    child.stderr.on("data", (chunk: Buffer) => reject(new Error(chunk.toString("utf8"))));
    child.on("exit", (code) => {
      if (!output.includes("\n")) reject(new Error(`lock owner exited before ready (${code})`));
    });
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.on("exit", resolve));
}

describe("lifecycle ownership journal", () => {
  it("is read-only when absent and creates no app-home or journal directory", () => {
    const before = fs.readdirSync(root);

    const observed = readLifecycleOwnershipJournal(journalPath);

    expect(observed).toMatchObject({
      state: "absent",
      validEvents: 0,
      ignoredEvents: 0,
      temporaryArtifacts: 0,
    });
    expect(observed.ledger).toEqual(emptyLifecycleOwnershipLedger());
    expect(fs.readdirSync(root)).toEqual(before);
    expect(fs.existsSync(appHome)).toBe(false);
  });

  it("atomically publishes connected snapshots and folds the latest event after restart", () => {
    const first = appendLifecycleOwnershipJournal(journalPath, ledger("first"));
    const second = appendLifecycleOwnershipJournal(journalPath, ledger("second"));

    expect(first.state).toBe("clean");
    expect(second.ledger.records[0]?.resourceId).toBe("second");
    expect(eventFiles()).toHaveLength(2);
    expect(fs.readdirSync(journalPath).every((name) => !name.endsWith(".tmp"))).toBe(true);

    const restarted = readLifecycleOwnershipJournal(journalPath);
    expect(restarted).toMatchObject({ state: "clean", validEvents: 2, ignoredEvents: 0 });
    expect(restarted.ledger.records[0]?.resourceId).toBe("second");
  });

  it("marks one syntactically incomplete final event recoverable but never appends past it", () => {
    appendEvents(2);
    const partial = path.join(
      journalPath,
      "00000000000000000003-00000000-0000-4000-8000-000000000003.json",
    );
    fs.writeFileSync(partial, '{"schemaVersion":"agentera.lifecycleOwnershipJournalEvent.v1"');
    const before = fs.readdirSync(journalPath).sort();

    const restarted = readLifecycleOwnershipJournal(journalPath);

    expect(restarted).toMatchObject({
      state: "recoverable_terminal_tail",
      validEvents: 2,
      ignoredEvents: 1,
    });
    expect(restarted.ledger.records[0]?.resourceId).toBe("resource-2");
    expect(() => appendLifecycleOwnershipJournal(journalPath, ledger("blocked")))
      .toThrow("ownership journal is not appendable (recoverable_terminal_tail)");
    expect(fs.readdirSync(journalPath).sort()).toEqual(before);
  });

  it("ignores multiple non-authoritative publication temporaries across restart and append", () => {
    appendEvents(2);
    fs.writeFileSync(
      path.join(journalPath, ".event-00000000000000000003-00000000-0000-4000-8000-000000000003.tmp"),
      "partial",
    );
    fs.writeFileSync(
      path.join(journalPath, ".event-00000000000000000003-00000000-0000-4000-8000-000000000004.tmp"),
      "another partial",
    );

    expect(readLifecycleOwnershipJournal(journalPath)).toMatchObject({
      state: "clean",
      validEvents: 2,
      temporaryArtifacts: 2,
    });
    const appended = appendLifecycleOwnershipJournal(journalPath, ledger("resource-3"));
    expect(appended).toMatchObject({ state: "clean", validEvents: 3, temporaryArtifacts: 2 });
    expect(appended.ledger.records[0]?.resourceId).toBe("resource-3");
  });

  it("rejects exact event-2 corruption in a nine-event chain without rolling ownership back for append", () => {
    appendEvents(9);
    writeEvent(1, '{"schemaVersion":"agentera.lifecycleOwnershipJournalEvent.v1"');
    const before = eventFiles();

    const observed = readLifecycleOwnershipJournal(journalPath);

    expect(observed).toMatchObject({ state: "corrupt", validEvents: 1, ignoredEvents: 8 });
    expect(observed.diagnostics.join(" ")).toContain("before a successor event");
    expect(() => appendLifecycleOwnershipJournal(journalPath, ledger("forked")))
      .toThrow("ownership journal is not appendable (corrupt)");
    expect(eventFiles()).toEqual(before);
  });

  it.each([
    ["gap", () => fs.unlinkSync(path.join(journalPath, eventFiles()[1]!)), "sequence gap"],
    ["fork", () => {
      const source = eventFiles()[1]!;
      fs.copyFileSync(
        path.join(journalPath, source),
        path.join(journalPath, source.replace(/[0-9a-f-]{36}\.json$/, "ffffffff-ffff-4fff-8fff-ffffffffffff.json")),
      );
    }, "duplicate sequence or fork"],
    ["body sequence mismatch", () => {
      const value = eventValue(1);
      value.sequence = 7;
      writeEvent(1, value);
    }, "filename and body sequence differ"],
    ["body event ID mismatch", () => {
      const value = eventValue(1);
      value.eventId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      writeEvent(1, value);
    }, "filename and body event ID differ"],
    ["digest mismatch", () => {
      const value = eventValue(1);
      value.digest = "sha256:bad";
      writeEvent(1, value);
    }, "event digest mismatch"],
    ["disconnection", () => {
      const value = eventValue(1);
      value.previousDigest = "sha256:disconnected";
      writeEvent(1, value);
    }, "previous digest disconnects"],
    ["malformed complete event", () => writeEvent(1, { schemaVersion: "wrong" }), "does not satisfy"],
  ])("classifies %s as corruption and blocks append", (_name, corrupt, diagnostic) => {
    appendEvents(3);
    corrupt();

    const observed = readLifecycleOwnershipJournal(journalPath);

    expect(observed.state).toBe("corrupt");
    expect(observed.diagnostics.join(" ")).toContain(diagnostic);
    expect(() => appendLifecycleOwnershipJournal(journalPath, ledger("blocked")))
      .toThrow("ownership journal is not appendable (corrupt)");
  });
});

describe("lifecycle ownership journal lock", () => {
  it("publishes a complete durable owner record before the final lock becomes visible", () => {
    const lock = acquireLifecycleOwnershipJournalLock(journalPath);
    const finalPath = path.join(lock.directory, "apply.lock");
    const record = JSON.parse(fs.readFileSync(lockRecordPath(lock.directory), "utf8"));

    expect(fs.lstatSync(finalPath).isDirectory()).toBe(true);
    expect(record).toMatchObject({
      schemaVersion: "agentera.lifecycleOwnershipJournalLock.v1",
      pid: process.pid,
      token: lock.token,
      bootId: lock.bootId,
      processStartTicks: lock.processStartTicks,
    });
    expect(fs.readdirSync(lock.directory).every((name) => !name.startsWith(".apply-lock-"))).toBe(true);
    releaseLifecycleOwnershipJournalLock(lock);
    expect(fs.existsSync(finalPath)).toBe(false);
  });

  it("blocks a contender on a live owner in a separate process and recovers after restart", async () => {
    const script = `
      import {
        acquireLifecycleOwnershipJournalLock,
        releaseLifecycleOwnershipJournalLock,
      } from ${JSON.stringify(SOURCE_JOURNAL_MODULE)};
      const lock = acquireLifecycleOwnershipJournalLock(${JSON.stringify(journalPath)});
      process.stdout.write(JSON.stringify(lock) + "\\n");
      process.stdin.once("data", () => {
        releaseLifecycleOwnershipJournalLock(lock);
        process.exit(0);
      });
    `;
    const owner = spawn(process.execPath, ["--input-type=module", "-e", script], { env: sourceSubprocessEnv() });
    try {
      const published = JSON.parse(await waitForLine(owner));
      expect(published.token).toBeTruthy();
      expect(() => acquireLifecycleOwnershipJournalLock(journalPath)).toThrow("already in progress");

      const finalPath = path.join(published.directory, "apply.lock");
      const preparedPath = path.join(published.directory, `.apply-lock-${published.token}.tmp`);
      fs.renameSync(finalPath, preparedPath);
      expect(() => acquireLifecycleOwnershipJournalLock(journalPath))
        .toThrow("lock publication already in progress");
      expect(fs.existsSync(preparedPath)).toBe(true);
      expect(fs.existsSync(finalPath)).toBe(false);
      fs.renameSync(preparedPath, finalPath);

      owner.stdin.write("release\n");
      expect(await waitForExit(owner)).toBe(0);

      const restarted = acquireLifecycleOwnershipJournalLock(journalPath);
      releaseLifecycleOwnershipJournalLock(restarted);
    } finally {
      if (owner.exitCode === null) owner.kill("SIGKILL");
    }
  });

  it("allows exactly one winner when two processes interleave atomic lock publication", async () => {
    const script = `
      import {
        acquireLifecycleOwnershipJournalLock,
        releaseLifecycleOwnershipJournalLock,
      } from ${JSON.stringify(SOURCE_JOURNAL_MODULE)};
      process.stdin.once("data", () => {
        try {
          const lock = acquireLifecycleOwnershipJournalLock(${JSON.stringify(journalPath)});
          process.stdout.write(JSON.stringify({ status: "acquired", lock }) + "\\n");
          process.stdin.once("data", () => {
            releaseLifecycleOwnershipJournalLock(lock);
            process.exit(0);
          });
        } catch (error) {
          process.stdout.write(JSON.stringify({ status: "blocked", message: error.message }) + "\\n");
          process.exit(0);
        }
      });
    `;
    const contenders = [
      spawn(process.execPath, ["--input-type=module", "-e", script], { env: sourceSubprocessEnv() }),
      spawn(process.execPath, ["--input-type=module", "-e", script], { env: sourceSubprocessEnv() }),
    ];
    try {
      const lines = contenders.map((child) => waitForLine(child));
      for (const child of contenders) child.stdin.write("publish\n");
      const results = (await Promise.all(lines)).map((line) => JSON.parse(line));
      const winner = results.findIndex((result) => result.status === "acquired");
      const loser = results.findIndex((result) => result.status === "blocked");

      expect(winner).toBeGreaterThanOrEqual(0);
      expect(loser).toBeGreaterThanOrEqual(0);
      expect(results[loser].message).toContain("already in progress");
      expect(JSON.parse(fs.readFileSync(lockRecordPath(path.dirname(journalPath)), "utf8")))
        .toMatchObject({ token: results[winner].lock.token });

      contenders[winner]!.stdin.write("release\n");
      expect(await waitForExit(contenders[winner]!)).toBe(0);
      expect(await waitForExit(contenders[loser]!)).toBe(0);
      expect(fs.existsSync(path.join(path.dirname(journalPath), "apply.lock"))).toBe(false);
    } finally {
      for (const contender of contenders) {
        if (contender.exitCode === null) contender.kill("SIGKILL");
      }
    }
  });

  it.each([
    ["dead owner", (record: Record<string, unknown>) => {
      record.pid = 2_147_483_647;
      record.processStartTicks = "1";
    }],
    ["PID reuse", (record: Record<string, unknown>) => {
      record.processStartTicks = `${BigInt(record.processStartTicks as string) + 1n}`;
    }],
    ["prior boot", (record: Record<string, unknown>) => {
      record.bootId = "00000000-0000-4000-8000-000000000000";
    }],
  ])("recovers a stale %s identity", (_name, makeStale) => {
    const stale = acquireLifecycleOwnershipJournalLock(journalPath);
    const recordPath = lockRecordPath(stale.directory);
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    makeStale(record);
    fs.writeFileSync(recordPath, `${JSON.stringify(record)}\n`);

    const recovered = acquireLifecycleOwnershipJournalLock(journalPath);

    expect(recovered.token).not.toBe(stale.token);
    releaseLifecycleOwnershipJournalLock(recovered);
  });

  it("cleans only a complete stale prepared lock after restart", () => {
    const interrupted = acquireLifecycleOwnershipJournalLock(journalPath);
    const finalPath = path.join(interrupted.directory, "apply.lock");
    const preparedPath = path.join(interrupted.directory, `.apply-lock-${interrupted.token}.tmp`);
    fs.renameSync(finalPath, preparedPath);
    const recordPath = path.join(preparedPath, "owner.json");
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    record.pid = 2_147_483_647;
    record.processStartTicks = "1";
    fs.writeFileSync(recordPath, `${JSON.stringify(record)}\n`);

    const restarted = acquireLifecycleOwnershipJournalLock(journalPath);

    expect(fs.existsSync(preparedPath)).toBe(false);
    releaseLifecycleOwnershipJournalLock(restarted);
  });

  it.each(["empty", "partial record"])(
    "fails closed on a malformed %s final lock instead of stealing it",
    (malformation) => {
    const lock = acquireLifecycleOwnershipJournalLock(journalPath);
    releaseLifecycleOwnershipJournalLock(lock);
    const finalPath = path.join(lock.directory, "apply.lock");
    fs.mkdirSync(finalPath);
    if (malformation === "partial record") fs.writeFileSync(path.join(finalPath, "owner.json"), "{");

    expect(() => acquireLifecycleOwnershipJournalLock(journalPath))
      .toThrow("lock is malformed; refusing recovery");
    expect(fs.readdirSync(finalPath)).toEqual(malformation === "empty" ? [] : ["owner.json"]);
    if (malformation === "partial record") {
      expect(fs.readFileSync(path.join(finalPath, "owner.json"), "utf8")).toBe("{");
    }
  });

  it("verifies token and process identity before release and preserves another record", () => {
    const lock = acquireLifecycleOwnershipJournalLock(journalPath);
    const recordPath = lockRecordPath(lock.directory);
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    record.token = "replacement-owner-token";
    fs.writeFileSync(recordPath, `${JSON.stringify(record)}\n`);

    expect(() => releaseLifecycleOwnershipJournalLock(lock)).toThrow("identity changed before release");
    expect(JSON.parse(fs.readFileSync(recordPath, "utf8")).token).toBe("replacement-owner-token");
  });
});
