import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vite-plus/test";

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
    const values = await scheduler.own(({ run, all }) => {
      const pending = [80, 10, 60, 20, 40, 30].map((delay, index) => run(command("setTimeout(() => process.stdout.write(process.argv[1]), Number(process.argv[2]));", String(index), String(delay))));
      expect(scheduler.snapshot()).toMatchObject({ active: 4, waiters: 2 });
      return all(pending);
    });
    expect(values.map(({ status, stdout }) => ({ status, stdout }))).toEqual([0, 1, 2, 3, 4, 5].map((index) => ({ status: 0, stdout: String(index) })));
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
    // Cover both a journey assertion failure and a concurrent parity-reader
    // failure. In either case every child must close before fixture cleanup.
    for (const failure of ["callback", "all"]) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "cold-process-abort-"));
      const activeFiles = Array.from({ length: 4 }, (_, index) => path.join(root, `active-${index}`));
      const queuedFiles = Array.from({ length: 2 }, (_, index) => path.join(root, `queued-${index}`));
      const scheduler = new ColdProcessScheduler({
        concurrency: 4,
        timeoutMs: 30_000,
        abortGraceMs: 100,
      });
      const hung = "const fs = await import('node:fs'); fs.writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);";
      const queued = "const fs = await import('node:fs'); fs.writeFileSync(process.argv[1], 'started');";
      let rootExistedAfterSettlement = false;
      try {
        await expect(
          scheduler.own(async ({ run, all }) => {
            const pending = [...activeFiles.map((file) => run(command(hung, file))), ...queuedFiles.map((file) => run(command(queued, file)))];
            const failed = async () => {
              await waitForFiles(activeFiles);
              throw new Error("intentional early callback failure");
            };
            if (failure === "all") await all([...pending, failed()]);
            else await failed();
          }),
        ).rejects.toThrow("intentional early callback failure");
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
        expect(snapshot.outcomes.every(({ pid, signal, aborted }) => pid !== null && signal !== null && aborted)).toBe(true);
        expect(new Set(snapshot.outcomes.map(({ pid }) => pid))).toEqual(new Set(activeFiles.map((file) => Number(fs.readFileSync(file, "utf8")))));
      } finally {
        expect(rootExistedAfterSettlement).toBe(true);
        fs.rmSync(root, { recursive: true, force: true });
      }
      expect(fs.existsSync(root)).toBe(false);
    }
    // Real Vitest timeout: its signal must stop the child and its finish hook
    // must drain the rejected journey before the caller removes the fixture.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cold-process-test-timeout-"));
    try {
      fs.symlinkSync(path.resolve(import.meta.dirname, "../../node_modules"), path.join(root, "node_modules"), "dir");
      fs.writeFileSync(path.join(root, "vite.config.mts"), `export default { test: { root: ${JSON.stringify(root)}, include: ["deadline.test.ts"], maxWorkers: 1 } };`);
      const helper = path.resolve(import.meta.dirname, "../helpers/coldProcessTest.ts");
      fs.writeFileSync(
        path.join(root, "deadline.test.ts"),
        `
import fs from "node:fs";
import path from "node:path";
import { it, expect } from "vite-plus/test";
import { coldProcessTest } from ${JSON.stringify(helper)};
it("drains timed-out work before cleanup", { timeout: 500 }, async (context) => {
  const project = ${JSON.stringify(path.join(root, "project"))};
  fs.mkdirSync(project);
  context.onTestFinished(() => {
    expect(fs.readFileSync(path.join(project, "settled"), "utf8")).toBe("yes");
    const pid = Number(fs.readFileSync(path.join(project, "pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    fs.rmSync(project, { recursive: true });
    fs.writeFileSync(${JSON.stringify(path.join(root, "cleanup"))}, "passed");
  });
  await coldProcessTest(context, async ({ run }) => {
    try {
      await run({ command: process.execPath, cwd: project, args: ["--input-type=module", "--eval", "import fs from 'node:fs'; fs.writeFileSync('pid', String(process.pid)); setInterval(() => {}, 1000);"] });
    } finally { fs.writeFileSync(path.join(project, "settled"), "yes"); }
  }, { concurrency: 1 });
});
`,
      );
      const resultFile = path.join(root, "result.json");
      const child = spawnSync("vp", ["test", "run", "--config", path.join(root, "vite.config.mts"), "--reporter=json", `--outputFile=${resultFile}`], { cwd: path.resolve(import.meta.dirname, "../.."), encoding: "utf8", timeout: 20_000 });
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(1);
      expect(fs.existsSync(resultFile), child.stdout + child.stderr).toBe(true);
      const result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
      expect(result.numFailedTests).toBe(1);
      expect(result.testResults[0].assertionResults[0].failureMessages.join("\n")).toContain("timed out in 500ms");
      expect(fs.readFileSync(path.join(root, "cleanup"), "utf8")).toBe("passed");
      expect(fs.existsSync(path.join(root, "project"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
