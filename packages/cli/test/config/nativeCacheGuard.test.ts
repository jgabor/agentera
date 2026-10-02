import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { cacheLookupScanner } from "../../scripts/guard-native-cache.mjs";
import { stopGuardChild, trackGuardChild } from "../helpers/nativeCacheGuardCleanup.js";

const guard = path.resolve(import.meta.dirname, "../../scripts/guard-native-cache.mjs");
const evidence = path.join(process.env.AGENTERA_NATIVE_DIAGNOSTIC_ROOT ?? path.resolve(import.meta.dirname, "../../../../node_modules/agentera-native-guard-proof"), "guard-cleanup");
function fixture() {
  fs.mkdirSync(evidence, { recursive: true });
  return fs.mkdtempSync(path.join(evidence, "fixture-"));
}
function run(source: string) {
  return spawnSync(process.execPath, [guard, process.execPath, "--input-type=module", "-e", source], { encoding: "utf8", timeout: 10_000 });
}

describe("outer native cache guard", () => {
  it("matches every split and ANSI-interrupted text without retaining output", () => {
    const text = Buffer.from("prefix Cache \x1b[31mlookup\x1b[0m failed suffix");
    for (let split = 0; split <= text.length; split++) {
      const scanner = cacheLookupScanner();
      scanner.write(text.subarray(0, split));
      scanner.write(text.subarray(split));
      expect(scanner.failed, String(split)).toBe(true);
    }
    const scanner = cacheLookupScanner();
    for (let i = 0; i < 128; i++) scanner.write(Buffer.alloc(64 * 1024, 120));
    scanner.write(Buffer.from("\x1b]0;title\x1b\\Cache lookup failed"));
    expect(scanner.failed).toBe(true);
  });

  for (const stream of ["stdout", "stderr"]) {
    it(`rejects zero-exit diagnostic on ${stream}, including replayed text`, () => {
      const result = run(`process.${stream}.write('replayed: Cache \\x1b[31mlookup\\x1b[0m failed\\n');`);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result[stream]).toContain("replayed: Cache \x1b[31mlookup\x1b[0m failed\n");
      expect(result.stderr).toContain("workaround, not an upstream repair");
    });
  }

  it("preserves output, arguments and normal failure without retry", () => {
    const result = run("process.stdout.write('once\\n'); process.stderr.write('ordinary failure\\n'); process.exitCode = 19;");
    expect(result.status).toBe(19);
    expect(result.stdout).toBe("once\n");
    expect(result.stderr).toBe("ordinary failure\n");
    const success = spawnSync(process.execPath, [guard, process.execPath, "-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--", "two words", "--flag"], { encoding: "utf8" });
    expect(success.status).toBe(0);
    expect(success.stdout).toBe('["two words","--flag"]');
  });

  it("streams output larger than capture defaults and still rejects a trailing diagnostic", () => {
    const result = spawnSync(process.execPath, [guard, process.execPath, "-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024)); process.stdout.write('Cache lookup failed');"], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("x".repeat(2 * 1024 * 1024) + "Cache lookup failed");
  });

  it("does not combine partial diagnostics from different streams", () => {
    const result = run("process.stdout.write('Cache lookup '); process.stderr.write('failed');");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Cache lookup ");
    expect(result.stderr).toBe("failed");
  });

  it("preserves a child signal", () => {
    const result = run("process.kill(process.pid, 'SIGTERM');");
    expect(result.status).toBeNull();
    expect(result.signal).toBe("SIGTERM");
  });

  it("forwards cancellation and stays cancelled even if the child exits zero", async () => {
    const root = fixture();
    const tracking = trackGuardChild(root, guard);
    const child = spawn(process.execPath, [guard, process.execPath, "-e", "process.on('SIGTERM', () => { console.log('stopped'); process.exit(0); }); console.log('READY'); setInterval(() => {}, 1000);"], { env: tracking.env, stdio: ["ignore", "pipe", "pipe"] });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
    let output = "";
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const failed = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("guard cancellation timed out")), 10_000);
        child.once("error", reject);
      });
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (!cancelled && output.includes("READY")) {
          cancelled = true;
          child.kill("SIGTERM");
        }
      });
      const result = await Promise.race([closed, failed]);
      expect(result).toEqual({ code: null, signal: "SIGTERM" });
      expect(output).toBe("READY\nstopped\n");
    } finally {
      clearTimeout(timer);
      await stopGuardChild(child, closed, tracking.marker);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("hard-cleans a forced deadline before deleting the interval child's fixture", async () => {
    for (const outerGroup of [false, true]) {
      const root = fixture();
      const tracking = trackGuardChild(root, guard);
      const child = spawn(process.execPath, [guard, process.execPath, "-e", "process.on('SIGTERM', () => {}); console.log('READY'); setInterval(() => {}, 1000);"], { env: tracking.env, detached: outerGroup, stdio: ["ignore", "pipe", "pipe"] });
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      let timer: ReturnType<typeof setTimeout> | undefined;
      let innerPid: number | undefined;
      try {
        const ready = new Promise<void>((resolve, reject) => {
          child.once("error", reject);
          child.stdout!.on("data", () => resolve());
          void closed.then(() => reject(new Error("Exited before READY")));
        });
        const startupDeadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("startup deadline")), 10_000);
        });
        await Promise.race([ready, startupDeadline]);
        clearTimeout(timer);
        innerPid = JSON.parse(fs.readFileSync(tracking.marker, "utf8"));
        process.kill(innerPid!, 0);
        await expect(
          Promise.race([
            closed,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("forced deadline")), 0);
            }),
          ]),
        ).rejects.toThrow("forced deadline");
      } finally {
        clearTimeout(timer);
        await stopGuardChild(child, closed, tracking.marker, outerGroup);
        expect(fs.existsSync(root)).toBe(true);
        if (innerPid) expect(() => process.kill(innerPid!, 0)).toThrow();
        fs.rmSync(root, { recursive: true, force: true });
      }
      expect(fs.existsSync(root)).toBe(false);
      fs.writeFileSync(
        path.join(evidence, `${path.basename(root)}-deadline.json`),
        JSON.stringify(
          {
            outerGroup,
            innerPid,
            forcedDeadline: true,
            innerAliveAfterTeardown: false,
            fixtureRetainedUntilTeardown: true,
            fixtureRemoved: true,
          },
          null,
          2,
        ),
      );
    }
  });

  it("drains early startup and spawn errors when no inner PID is available", async () => {
    for (const scenario of ["early", "outer-error", "inner-error"]) {
      const root = fixture();
      const tracking = trackGuardChild(root, guard);
      const child = spawn(scenario === "outer-error" ? "/nonexistent/agentera-test-guard" : process.execPath, [guard, scenario === "inner-error" ? "/nonexistent/agentera-test-child" : process.execPath, "-e", "setInterval(() => {}, 1000)"], { env: tracking.env, stdio: ["ignore", "pipe", "pipe"] });
      child.once("error", () => {});
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (scenario === "inner-error")
          await Promise.race([
            closed,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("spawn error deadline")), 10_000);
            }),
          ]);
        expect(fs.existsSync(tracking.marker)).toBe(false);
      } finally {
        clearTimeout(timer);
        await stopGuardChild(child, closed, tracking.marker);
        expect(fs.existsSync(root)).toBe(true);
        fs.rmSync(root, { recursive: true, force: true });
      }
      expect(fs.existsSync(root)).toBe(false);
      fs.writeFileSync(
        path.join(evidence, `${path.basename(root)}-startup.json`),
        JSON.stringify(
          {
            scenario,
            innerPidAvailable: false,
            fixtureRetainedUntilTeardown: true,
            fixtureRemoved: true,
          },
          null,
          2,
        ),
      );
    }
  });

  it("fails closed on spawn error without disclosing argv", () => {
    const result = spawnSync(process.execPath, [guard, "/nonexistent/agentera-guard-command", "secret-argument"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("Native cache guard could not start the child.\n");
  });
});
