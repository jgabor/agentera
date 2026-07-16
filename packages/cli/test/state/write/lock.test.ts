import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { acquireWriterLock } from "../../../src/state/write/lock.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-writer-lock-"));
  roots.push(value);
  return value;
}

function seedLock(project: string, owner: unknown): string {
  const lockPath = path.join(project, ".agentera/.writer.lock");
  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(path.join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`);
  return lockPath;
}

describe("project writer lock", () => {
  it("times out with retry guidance while a live owner holds the project lock", () => {
    const project = root();
    const first = acquireWriterLock(project, 50);
    try {
      expect(() => acquireWriterLock(project, 75)).toThrow(/writer lock timeout.*retry/);
    } finally {
      first.release();
    }
  });

  it("recovers a demonstrably dead owner and releases in an idempotent way", () => {
    const project = root();
    const lockPath = seedLock(project, {
      pid: 999_999_999,
      token: "dead-owner",
      created_at: "2020-01-01T00:00:00Z",
    });
    const lock = acquireWriterLock(project, 100);
    expect(JSON.parse(fs.readFileSync(path.join(lock.path, "owner.json"), "utf8")).pid).toBe(process.pid);
    lock.release();
    lock.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it.each(["", "not json\n"])("recovers stale malformed owner metadata %j", (contents) => {
    const project = root();
    const lockPath = seedLock(project, {});
    const ownerPath = path.join(lockPath, "owner.json");
    fs.writeFileSync(ownerPath, contents);
    const old = new Date(Date.now() - 1_000);
    fs.utimesSync(ownerPath, old, old);
    fs.utimesSync(lockPath, old, old);

    const lock = acquireWriterLock(project, 100);
    expect(JSON.parse(fs.readFileSync(path.join(lock.path, "owner.json"), "utf8")).pid).toBe(process.pid);
    lock.release();
  });

  it("does not reclaim a successor that replaced the stale instance it inspected", () => {
    const project = root();
    const lockPath = seedLock(project, {
      pid: 999_999_999,
      token: "stale-instance",
      created_at: "2020-01-01T00:00:00Z",
    });
    const kill = vi.spyOn(process, "kill").mockImplementationOnce(() => {
      fs.rmSync(lockPath, { recursive: true });
      seedLock(project, {
        pid: process.pid,
        token: "successor-instance",
        created_at: new Date().toISOString(),
      });
      throw Object.assign(new Error("dead"), { code: "ESRCH" });
    });

    expect(() => acquireWriterLock(project, 50)).toThrow(/writer lock timeout/);
    kill.mockRestore();
    expect(JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"))).toMatchObject({
      token: "successor-instance",
    });
  });

  it("does not release a successor lock with a different owner token", () => {
    const project = root();
    const first = acquireWriterLock(project, 100);
    const parked = `${first.path}.parked`;
    fs.renameSync(first.path, parked);
    const successor = acquireWriterLock(project, 100);

    first.release();
    expect(fs.existsSync(successor.path)).toBe(true);
    successor.release();
    expect(fs.existsSync(successor.path)).toBe(false);
    fs.rmSync(parked, { recursive: true });
  });

  it("removes the lock directory when writing owner metadata fails", () => {
    const project = root();
    const write = vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("injected metadata write failure"), { code: "ENOSPC" });
    });
    expect(() => acquireWriterLock(project, 100)).toThrow("injected metadata write failure");
    write.mockRestore();

    const lock = acquireWriterLock(project, 100);
    lock.release();
  });

  it("rejects a symlinked lock directory before touching its external target", () => {
    const project = root();
    const outside = root();
    const lockPath = path.join(outside, ".writer.lock");
    const contents = JSON.stringify({ pid: 999_999_999, created_at: "2020-01-01T00:00:00Z" });
    fs.writeFileSync(lockPath, contents);
    fs.symlinkSync(outside, path.join(project, ".agentera"), "dir");

    expect(() => acquireWriterLock(project, 100)).toThrow(
      /writer lock.*escapes the project boundary/,
    );
    expect(fs.readFileSync(lockPath, "utf8")).toBe(contents);
  });
});
