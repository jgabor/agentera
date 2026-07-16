import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { acquireWriterLock } from "../../../src/state/write/lock.js";
import { StateWriteInputError } from "../../../src/state/write/errors.js";

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

  it("recovers a stale ownerless lock directory", () => {
    const project = root();
    const lockPath = path.join(project, ".agentera/.writer.lock");
    fs.mkdirSync(lockPath, { recursive: true });
    const old = new Date(Date.now() - 1_000);
    fs.utimesSync(lockPath, old, old);

    const lock = acquireWriterLock(project, 100);
    expect(JSON.parse(fs.readFileSync(path.join(lock.path, "owner.json"), "utf8"))).toMatchObject({
      pid: process.pid,
    });
    lock.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("does not remove a valid owner that replaces malformed metadata during exact reclamation", () => {
    const project = root();
    const lockPath = seedLock(project, "not json\n");
    const ownerPath = path.join(lockPath, "owner.json");
    const old = new Date(Date.now() - 1_000);
    fs.utimesSync(ownerPath, old, old);
    fs.utimesSync(lockPath, old, old);
    const originalLink = fs.linkSync;
    let replaced = false;
    const link = vi.spyOn(fs, "linkSync").mockImplementation(((...args: unknown[]) => {
      const result = Reflect.apply(originalLink, fs, args);
      if (!replaced && String(args[0]).endsWith("/owner.json") && String(args[1]).includes(".claim")) {
        replaced = true;
        fs.unlinkSync(ownerPath);
        fs.writeFileSync(ownerPath, `${JSON.stringify({
          pid: process.pid,
          token: "malformed-successor",
          created_at: new Date().toISOString(),
        })}\n`);
      }
      return result;
    }) as typeof fs.linkSync);

    try {
      expect(() => acquireWriterLock(project, 50)).toThrow(/writer lock timeout/);
    } finally {
      link.mockRestore();
    }
    expect(replaced).toBe(true);
    expect(JSON.parse(fs.readFileSync(ownerPath, "utf8"))).toMatchObject({ token: "malformed-successor" });
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

  it("cannot publish or remove a successor after pausing before owner publication", () => {
    const project = root();
    const originalWrite = fs.writeFileSync;
    let successor: ReturnType<typeof acquireWriterLock> | undefined;
    let successorToken = "";
    const write = vi.spyOn(fs, "writeFileSync");
    write.mockImplementationOnce(((...args: unknown[]) => {
      const agenteraDir = path.join(project, ".agentera");
      expect(fs.readdirSync(agenteraDir).some((name) => name.startsWith(".writer."))).toBe(true);
      expect(fs.existsSync(path.join(agenteraDir, ".writer.lock"))).toBe(false);

      successor = acquireWriterLock(project, 100);
      successorToken = (JSON.parse(fs.readFileSync(path.join(successor.path, "owner.json"), "utf8")) as { token: string }).token;
      return Reflect.apply(originalWrite, fs, args);
    }) as typeof fs.writeFileSync);

    try {
      expect(() => acquireWriterLock(project, 50)).toThrow(/writer lock timeout/);
      expect(successor).toBeDefined();
      expect(JSON.parse(fs.readFileSync(path.join(successor!.path, "owner.json"), "utf8"))).toMatchObject({
        token: successorToken,
      });
      expect(fs.readdirSync(path.join(project, ".agentera")).filter((name) => name.startsWith(".writer.") && name !== ".writer.lock")).toEqual([]);
    } finally {
      write.mockRestore();
      successor?.release();
    }
    expect(fs.existsSync(path.join(project, ".agentera/.writer.lock"))).toBe(false);
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

  it("rejects a legacy lock file with structured actionable recovery", () => {
    const project = root();
    const lockPath = path.join(project, ".agentera/.writer.lock");
    const contents = `${JSON.stringify({ pid: 999_999_999, created_at: "2020-01-01T00:00:00Z" })}\n`;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, contents);

    try {
      acquireWriterLock(project, 50);
      throw new Error("legacy lock file unexpectedly acquired");
    } catch (error) {
      expect(error).toBeInstanceOf(StateWriteInputError);
      expect((error as StateWriteInputError).body).toMatchObject({
        class: "conflict",
        message: expect.stringMatching(/legacy writer lock file.*verify no Agentera writer.*remove.*retry/i),
      });
      expect((error as Error).message).not.toMatch(/ENOTDIR/);
    }
    expect(fs.readFileSync(lockPath, "utf8")).toBe(contents);
  });

  it("does not unlink a successor that replaces a legacy lock file during inspection", () => {
    const project = root();
    const lockPath = path.join(project, ".agentera/.writer.lock");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, "legacy\n");
    const originalOpen = fs.openSync;
    let replaced = false;
    const open = vi.spyOn(fs, "openSync").mockImplementation(((...args: unknown[]) => {
      try {
        return Reflect.apply(originalOpen, fs, args) as number;
      } catch (error) {
        if (!replaced && String(args[0]).endsWith("/.writer.lock") && (error as NodeJS.ErrnoException).code === "ENOTDIR") {
          replaced = true;
          fs.unlinkSync(lockPath);
          seedLock(project, {
            pid: process.pid,
            token: "legacy-successor",
            created_at: new Date().toISOString(),
          });
        }
        throw error;
      }
    }) as typeof fs.openSync);

    try {
      expect(() => acquireWriterLock(project, 50)).toThrow(/writer lock timeout/);
    } finally {
      open.mockRestore();
    }
    expect(replaced).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"))).toMatchObject({
      token: "legacy-successor",
    });
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
