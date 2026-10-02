import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createOverlapProgressForwarder, createVerificationProgress } from "../../scripts/verification-progress.mjs";

const checkpoint = "AGENTERA_VERIFICATION_PROGRESS scope=overlap owner=package status=running elapsedMs=30000\n";
const sourceCheckpoint = "AGENTERA_SOURCE_DIAGNOSTIC file=packages/cli/test/config/taskCache.test.ts phase=native-start index=1 elapsedMs=0 durationMs=0 status=observed\n";

describe("verification progress diagnostics", () => {
  afterEach(() => vi.useRealTimers());

  it("emits immediate start, a thirty-second heartbeat, and one completion", () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    let elapsed = 0;
    const progress = createVerificationProgress("overlap", "package", {
      write: (line: string) => {
        lines.push(line);
        return true;
      },
      now: () => elapsed,
    });
    expect(lines).toEqual(["AGENTERA_VERIFICATION_PROGRESS scope=overlap owner=package status=started elapsedMs=0\n"]);
    elapsed = 30_000;
    vi.advanceTimersByTime(30_000);
    expect(lines.at(-1)).toBe(checkpoint);
    elapsed = 31_000;
    progress.complete("passed");
    progress.complete("failed");
    vi.advanceTimersByTime(60_000);
    expect(lines).toHaveLength(3);
    expect(lines.at(-1)).toBe("AGENTERA_VERIFICATION_PROGRESS scope=overlap owner=package status=passed elapsedMs=31000\n");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["failed", "cancelled"])("stops the heartbeat after %s", (status) => {
    vi.useFakeTimers();
    const write = vi.fn();
    const progress = createVerificationProgress("qualification", "generated-overlap", { write });
    progress.complete(status);
    vi.advanceTimersByTime(60_000);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1][0]).toContain(`status=${status}`);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("forwards only complete whitelisted overlap records across chunk boundaries", () => {
    const lines: string[] = [];
    const forwarder = createOverlapProgressForwarder((line: string) => {
      lines.push(line);
      return true;
    });
    forwarder.feed(checkpoint.slice(0, 37));
    expect(lines).toEqual([]);
    forwarder.feed(checkpoint.slice(37));
    forwarder.feed("private reporter output NPM_TOKEN=secret\n");
    forwarder.feed(checkpoint.replace("owner=package", "owner=/private/path"));
    forwarder.feed(checkpoint.replace("status=running", "status=unknown"));
    forwarder.feed(checkpoint.replace("scope=overlap", "scope=qualification"));
    forwarder.feed(checkpoint.replace("elapsedMs=30000", "elapsedMs=-1"));
    forwarder.feed(`prefix ${checkpoint}`);
    expect(lines).toEqual([checkpoint]);
  });

  it("discards an oversized line until its newline and resumes with the next record", () => {
    const lines: string[] = [];
    const forwarder = createOverlapProgressForwarder((line: string) => {
      lines.push(line);
      return true;
    });
    forwarder.feed("x".repeat(1000));
    forwarder.feed(checkpoint);
    forwarder.feed(checkpoint);
    expect(lines).toEqual([checkpoint]);
  });

  it("rejects owner labels before creating a timer or emitting output", () => {
    vi.useFakeTimers();
    const write = vi.fn();
    expect(() => createVerificationProgress("overlap", "/private/secret", { write })).toThrow("unknown verification progress owner");
    expect(write).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("forwards source records through both layers, rejects private/partial records and tolerates sink errors", () => {
    const lines: string[] = [];
    const qualification = createOverlapProgressForwarder((line: string) => {
      lines.push(line);
      return true;
    });
    const overlap = createOverlapProgressForwarder(
      (line: string) => {
        qualification.feed(line.slice(0, 11));
        qualification.feed(line.slice(11));
        return true;
      },
      { sourceOnly: true },
    );
    for (const char of sourceCheckpoint) overlap.feed(char);
    overlap.feed(sourceCheckpoint.replace("packages/cli/test/config/taskCache.test.ts", "/private/secret.test.ts"));
    overlap.feed(sourceCheckpoint.replace("phase=native-start", "phase=PRIVATE"));
    overlap.feed(sourceCheckpoint.replace("status=observed", "status=secret"));
    overlap.feed(sourceCheckpoint.replace("index=1", "index=-1"));
    overlap.feed(checkpoint);
    overlap.feed(sourceCheckpoint.slice(0, -1));
    expect(lines).toEqual([sourceCheckpoint]);
    const broken = createOverlapProgressForwarder(() => {
      throw new Error("diagnostic sink failed");
    });
    expect(() => broken.feed(sourceCheckpoint)).not.toThrow();
  });

  it("retains native start and real child start before killing a blocked spawnSync, without a final report", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "source-interruption-"));
    const retained = path.join(root, "source.progress.log");
    const forwarded = path.join(root, "forwarded.log");
    const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, "../../scripts/source-diagnostics.mjs")).href;
    const probe = `import { writeSourceDiagnostic } from ${JSON.stringify(moduleUrl)}; writeSourceDiagnostic({file:'packages/cli/test/config/taskCache.test.ts',phase:'native-child-start',index:1}, {fd:3}); setInterval(()=>{},1000);`;
    const parent = `import {spawnSync} from 'node:child_process'; import {startNativeDiagnostic} from ${JSON.stringify(moduleUrl)}; const timing=startNativeDiagnostic('packages/cli/test/config/taskCache.test.ts',1); const result=spawnSync(process.execPath,['--input-type=module','-e',${JSON.stringify(probe)}],{stdio:['ignore','pipe','pipe',2],env:process.env}); timing.complete(result);`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", parent], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        AGENTERA_SOURCE_DIAGNOSTICS: "1",
        AGENTERA_SOURCE_DIAGNOSTIC_OUTPUT: retained,
      },
    });
    const qualification = createOverlapProgressForwarder((line: string) => {
      fs.appendFileSync(forwarded, line);
      return true;
    });
    const overlap = createOverlapProgressForwarder(
      (line: string) => {
        qualification.feed(line);
        return true;
      },
      { sourceOnly: true },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("missing incremental child start")), 5000);
        child.stderr.on("data", (chunk) => {
          overlap.feed(chunk);
          if (fs.existsSync(forwarded) && fs.readFileSync(forwarded, "utf8").includes("phase=native-child-start")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
      process.kill(-child.pid!, "SIGTERM");
      expect(await closed).toEqual({ code: null, signal: "SIGTERM" });
      for (const target of [retained, forwarded]) {
        const text = fs.readFileSync(target, "utf8");
        expect(text).toContain("phase=native-start");
        expect(text).toContain("phase=native-child-start");
        expect(text).not.toContain("phase=native-end");
        expect(text).not.toContain("status=passed");
      }
      expect(fs.existsSync(path.join(root, "source.json"))).toBe(false);
    } finally {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        /* already closed */
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
