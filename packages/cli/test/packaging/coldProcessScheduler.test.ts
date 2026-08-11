import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ColdProcessScheduler } from "../helpers/coldProcessScheduler.js";

function command(script: string, ...args: string[]) {
  return {
    command: process.execPath,
    args: ["--input-type=module", "--eval", script, ...args],
    cwd: process.cwd(),
  };
}

async function waitForFiles(files: string[], timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!files.every((file) => fs.existsSync(file))) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${files.join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("cold process scheduler ownership", () => {
  it("preserves bounded concurrency and deterministic successful result order", async () => {
    const scheduler = new ColdProcessScheduler({ concurrency: 4, timeoutMs: 30_000 });
    const values = await scheduler.own(({ run, all }) => all(
      [80, 10, 60, 20, 40, 30].map((delay, index) => run(command(
        "setTimeout(() => process.stdout.write(process.argv[1]), Number(process.argv[2]));",
        String(index),
        String(delay),
      ))),
    ));
    expect(values.map(({ status, stdout }) => ({ status, stdout }))).toEqual(
      [0, 1, 2, 3, 4, 5].map((index) => ({ status: 0, stdout: String(index) })),
    );
    expect(scheduler.snapshot()).toMatchObject({
      aborted: false,
      active: 0,
      slots: 0,
      waiters: 0,
      timers: 0,
      started: 6,
    });
  });

  it("aborts active children, rejects queued work, and settles before root removal", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cold-process-abort-"));
    const activeFiles = Array.from({ length: 4 }, (_, index) => path.join(root, `active-${index}`));
    const queuedFiles = Array.from({ length: 2 }, (_, index) => path.join(root, `queued-${index}`));
    const scheduler = new ColdProcessScheduler({ concurrency: 4, timeoutMs: 30_000, abortGraceMs: 100 });
    const hung = "const fs = await import('node:fs'); fs.writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);";
    const queued = "const fs = await import('node:fs'); fs.writeFileSync(process.argv[1], 'started');";
    let rootExistedAfterSettlement = false;
    try {
      await expect(scheduler.own(async ({ run }) => {
        for (const file of activeFiles) void run(command(hung, file));
        for (const file of queuedFiles) void run(command(queued, file));
        await waitForFiles(activeFiles);
        throw new Error("intentional early callback failure");
      })).rejects.toThrow("intentional early callback failure");
      rootExistedAfterSettlement = fs.existsSync(root);
      expect(queuedFiles.some((file) => fs.existsSync(file))).toBe(false);
      const snapshot = scheduler.snapshot();
      expect(snapshot).toMatchObject({
        aborted: true,
        active: 0,
        slots: 0,
        waiters: 0,
        timers: 0,
        started: 4,
      });
      expect(snapshot.outcomes).toHaveLength(4);
      expect(snapshot.outcomes.every(({ pid, signal, aborted }) => (
        pid !== null && signal !== null && aborted
      ))).toBe(true);
      expect(new Set(snapshot.outcomes.map(({ pid }) => pid))).toEqual(
        new Set(activeFiles.map((file) => Number(fs.readFileSync(file, "utf8")))),
      );
    } finally {
      expect(rootExistedAfterSettlement).toBe(true);
      fs.rmSync(root, { recursive: true, force: true });
    }
    expect(fs.existsSync(root)).toBe(false);
  });
});
