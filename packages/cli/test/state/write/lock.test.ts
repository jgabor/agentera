import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { acquireWriterLock } from "../../../src/state/write/lock.js";
import { StateWriteInputError } from "../../../src/state/write/errors.js";

const roots: string[] = [];
const crashWorker = fileURLToPath(new URL("./lockCrashWorker.mjs", import.meta.url));
const privateToken = "11111111-1111-4111-8111-111111111111";

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

function crashAt(project: string, point: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [crashWorker], {
      cwd: path.resolve(import.meta.dirname, "../../.."),
      env: {
        ...process.env,
        AGENTERA_LOCK_CRASH_ROOT: project,
        AGENTERA_LOCK_CRASH_POINT: point,
      },
      stdio: "pipe",
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code, signal) => fs.existsSync(path.join(project, `.lock-crash-${point}`))
      ? resolve(86)
      : reject(new Error(`crash worker exited ${code} (${signal ?? "no signal"}): ${stderr}`)));
  });
}

function privateDirectory(project: string, token: string, pid?: number): string {
  return path.join(project, ".agentera", `.writer.${pid === undefined ? "" : `${pid}.`}${token}.tmp`);
}

function makeOld(target: string): void {
  const old = new Date(Date.now() - 1_000);
  fs.utimesSync(target, old, old);
}

function expectPrivateResidueFailure(project: string): StateWriteInputError {
  try {
    const lock = acquireWriterLock(project, 50);
    lock.release();
    throw new Error("private writer preparation residue unexpectedly allowed acquisition");
  } catch (error) {
    expect(error).toBeInstanceOf(StateWriteInputError);
    const failure = error as StateWriteInputError;
    expect(failure.body).toMatchObject({ class: "conflict" });
    expect(failure.message).toMatch(/private writer preparation.*active writer.*remove.*retry/i);
    return failure;
  }
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
    const originalOpen = fs.openSync;
    let replaced = false;
    const open = vi.spyOn(fs, "openSync").mockImplementation(((...args: unknown[]) => {
      const result = Reflect.apply(originalOpen, fs, args) as number;
      if (!replaced && String(args[0]).endsWith("/.reclaim.json")) {
        replaced = true;
        fs.unlinkSync(ownerPath);
        fs.writeFileSync(ownerPath, `${JSON.stringify({
          pid: process.pid,
          token: "malformed-successor",
          created_at: new Date().toISOString(),
        })}\n`);
      }
      return result;
    }) as typeof fs.openSync);

    try {
      expect(() => acquireWriterLock(project, 50)).toThrow(/writer lock timeout/);
    } finally {
      open.mockRestore();
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

  it("does not steal a fully initialized claim from a paused live reclaimer", () => {
    const project = root();
    const lockPath = seedLock(project, {
      pid: 999_999_999,
      token: "stale-instance",
      created_at: "2020-01-01T00:00:00Z",
    });
    const originalLink = fs.linkSync;
    let paused = false;
    const link = vi.spyOn(fs, "linkSync").mockImplementation(((...args: unknown[]) => {
      const result = Reflect.apply(originalLink, fs, args);
      if (!paused && String(args[1]).endsWith("/.reclaim.json")) {
        paused = true;
        expectPrivateResidueFailure(project);
        expect(JSON.parse(fs.readFileSync(path.join(lockPath, ".reclaim.json"), "utf8"))).toMatchObject({
          pid: process.pid,
        });
      }
      return result;
    }) as typeof fs.linkSync);

    try {
      const lock = acquireWriterLock(project, 500);
      expect(paused).toBe(true);
      lock.release();
    } finally {
      link.mockRestore();
    }
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

  it("preserves a live creator paused beyond initialization grace and gives it sole ownership", () => {
    const project = root();
    const originalWrite = fs.writeFileSync;
    let contenderFailure: StateWriteInputError | undefined;
    const write = vi.spyOn(fs, "writeFileSync");
    write.mockImplementationOnce(((...args: unknown[]) => {
      const agenteraDir = path.join(project, ".agentera");
      const privateName = fs.readdirSync(agenteraDir).find((name) => name.endsWith(".tmp"));
      expect(privateName).toMatch(new RegExp(`^\\.writer\\.${process.pid}\\.`));
      expect(fs.existsSync(path.join(agenteraDir, ".writer.lock"))).toBe(false);

      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
      contenderFailure = expectPrivateResidueFailure(project);
      expect(fs.existsSync(path.join(agenteraDir, privateName!))).toBe(true);
      return Reflect.apply(originalWrite, fs, args);
    }) as typeof fs.writeFileSync);

    let creator: ReturnType<typeof acquireWriterLock> | undefined;
    try {
      creator = acquireWriterLock(project, 500);
      expect(contenderFailure).toBeInstanceOf(StateWriteInputError);
      expect(JSON.parse(fs.readFileSync(path.join(creator.path, "owner.json"), "utf8"))).toMatchObject({
        pid: process.pid,
      });
      expect(fs.readdirSync(path.join(project, ".agentera")).filter((name) => name.startsWith(".writer.") && name !== ".writer.lock")).toEqual([]);
    } finally {
      write.mockRestore();
      creator?.release();
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

  it("recovers in a fresh process after every stale-claim transition crash", async () => {
    for (const point of [
      "private-created",
      "claim-created",
      "claim-published",
      "owner-transitioned",
      "private-removed",
      "claim-removed",
    ]) {
      const project = root();
      const lockPath = seedLock(project, {
        pid: 999_999_999,
        token: "stale-owner",
        created_at: "2020-01-01T00:00:00Z",
      });

      await expect(crashAt(project, point), point).resolves.toBe(86);
      const recovered = acquireWriterLock(project, 1_500);
      expect(JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8")), point).toMatchObject({
        pid: process.pid,
      });
      recovered.release();
      expect(fs.existsSync(lockPath), point).toBe(false);
      expect(
        fs.readdirSync(path.join(project, ".agentera")).filter((name) => name.startsWith(".writer.")),
        point,
      ).toEqual([]);
    }
  }, 30_000);

  it("recovers the old adoption state with canonical and private owner links", () => {
    const project = root();
    const lockPath = seedLock(project, {
      pid: 999_999_999,
      token: privateToken,
      created_at: "2020-01-01T00:00:00Z",
    });
    const preparedPath = privateDirectory(project, privateToken);
    fs.mkdirSync(preparedPath);
    fs.linkSync(path.join(lockPath, "owner.json"), path.join(preparedPath, "owner.json"));
    fs.linkSync(
      path.join(lockPath, "owner.json"),
      path.join(lockPath, ".writer.77777777-7777-4777-8777-777777777777.claim"),
    );

    const lock = acquireWriterLock(project, 500);
    expect(fs.existsSync(preparedPath)).toBe(false);
    lock.release();
  });

  it("cleans private directories only with demonstrably dead PID or owner proof", () => {
    const project = root();
    const agenteraDirectory = path.join(project, ".agentera");
    fs.mkdirSync(agenteraDirectory);

    const namedDead = privateDirectory(project, "77777777-7777-4777-8777-777777777777", 999_999_999);
    fs.mkdirSync(namedDead);

    const malformed = privateDirectory(project, "33333333-3333-4333-8333-333333333333", 999_999_999);
    fs.mkdirSync(malformed);
    fs.writeFileSync(path.join(malformed, "owner.json"), "not json\n");

    const dead = privateDirectory(project, "44444444-4444-4444-8444-444444444444");
    fs.mkdirSync(dead);
    fs.writeFileSync(path.join(dead, "owner.json"), `${JSON.stringify({
      pid: 999_999_999,
      token: "44444444-4444-4444-8444-444444444444",
      created_at: "2020-01-01T00:00:00Z",
    })}\n`);

    const lock = acquireWriterLock(project, 500);
    lock.release();

    for (const recovered of [namedDead, malformed, dead]) expect(fs.existsSync(recovered)).toBe(false);
  });

  it("preserves an aged empty private directory whose PID is live", () => {
    const project = root();
    const residue = privateDirectory(project, "22222222-2222-4222-8222-222222222222", process.pid);
    fs.mkdirSync(residue, { recursive: true });
    makeOld(residue);

    expectPrivateResidueFailure(project);
    expect(fs.existsSync(residue)).toBe(true);
  });

  it("preserves an aged malformed private owner whose PID is live", () => {
    const project = root();
    const residue = privateDirectory(project, "33333333-3333-4333-8333-333333333333", process.pid);
    fs.mkdirSync(residue, { recursive: true });
    const ownerPath = path.join(residue, "owner.json");
    fs.writeFileSync(ownerPath, "not json\n");
    makeOld(ownerPath);
    makeOld(residue);

    expectPrivateResidueFailure(project);
    expect(fs.readFileSync(ownerPath, "utf8")).toBe("not json\n");
  });

  it("fails closed on indeterminate private ownership without removing residue", () => {
    const project = root();
    const indeterminatePid = 888_888_888;
    const residue = privateDirectory(project, "66666666-6666-4666-8666-666666666666", indeterminatePid);
    fs.mkdirSync(residue, { recursive: true });
    makeOld(residue);
    const originalKill = process.kill;
    const kill = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === indeterminatePid && signal === 0) {
        throw Object.assign(new Error("permission denied"), { code: "EPERM" });
      }
      return originalKill(pid, signal);
    }) as typeof process.kill);

    try {
      expectPrivateResidueFailure(project);
    } finally {
      kill.mockRestore();
    }
    expect(fs.existsSync(residue)).toBe(true);
  });

  it("preserves PID-less unknown private residue with bounded actionable recovery", () => {
    const project = root();
    const residue = privateDirectory(project, "99999999-9999-4999-8999-999999999999");
    fs.mkdirSync(residue, { recursive: true });
    fs.writeFileSync(path.join(residue, "foreign"), "preserve\n");
    makeOld(residue);

    const failure = expectPrivateResidueFailure(project);
    expect(failure.message.length).toBeLessThan(1_024);
    expect(fs.readFileSync(path.join(residue, "foreign"), "utf8")).toBe("preserve\n");
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
