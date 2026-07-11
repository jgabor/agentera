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
    const dir = path.join(project, ".agentera");
    fs.mkdirSync(dir, { recursive: true });
    const lockPath = path.join(dir, ".writer.lock");
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999_999_999, created_at: "2020-01-01T00:00:00Z" }),
    );
    const lock = acquireWriterLock(project, 100);
    expect(JSON.parse(fs.readFileSync(lock.path, "utf8")).pid).toBe(process.pid);
    lock.release();
    lock.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it.each(["", "not json\n"])("recovers stale malformed owner metadata %j", (contents) => {
    const project = root();
    const dir = path.join(project, ".agentera");
    fs.mkdirSync(dir, { recursive: true });
    const lockPath = path.join(dir, ".writer.lock");
    fs.writeFileSync(lockPath, contents);
    const old = new Date(Date.now() - 1_000);
    fs.utimesSync(lockPath, old, old);

    const lock = acquireWriterLock(project, 100);
    expect(JSON.parse(fs.readFileSync(lock.path, "utf8")).pid).toBe(process.pid);
    lock.release();
  });

  it("removes the lock file when writing owner metadata fails", () => {
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
