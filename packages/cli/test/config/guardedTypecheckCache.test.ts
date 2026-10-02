import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vite-plus/test";
import config from "../../../../vite.config.ts";
import { stopGuardChild, trackGuardChild } from "../helpers/nativeCacheGuardCleanup.js";

const repo = path.resolve(import.meta.dirname, "../../../..");
const launcher = process.env.VP_CLI_BIN!;
const guardRelative = "packages/cli/scripts/guard-native-cache.mjs";
const evidence = path.join(process.env.AGENTERA_NATIVE_DIAGNOSTIC_ROOT ?? path.join(repo, "node_modules/agentera-native-guard-proof"), "typecheck");
fs.mkdirSync(evidence, { recursive: true });
const runEvidence = fs.mkdtempSync(path.join(evidence, "run-"));

// Snapshot only compiler inputs and actual owner manifests, not Git/state or a
// second checkout. Dependencies are read-only links; native cache is fixture-owned.
function fixture(wait = false) {
  const root = fs.mkdtempSync(path.join(runEvidence, "fixture-"));
  const ipc = fs.mkdtempSync("/tmp/agtc-");
  for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".node-version", "references/analysis/toolchain-baseline.yaml", "packages/cli/package.json", "packages/cli/tsconfig.json", "packages/cli/test/config/taskCache.test.ts", guardRelative]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(repo, file), path.join(root, file));
  }
  fs.cpSync(path.join(repo, "packages/cli/src"), path.join(root, "packages/cli/src"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(root, "node_modules"));
  // Fresh pnpm bin shims resolve through the root virtual store. Link only
  // dependencies, leaving this fixture's sibling .vite/task-cache private.
  fs.symlinkSync(path.join(repo, "node_modules/.pnpm"), path.join(root, "node_modules/.pnpm"), "dir");
  fs.symlinkSync(path.join(repo, "node_modules/vite-plus"), path.join(root, "node_modules/vite-plus"), "dir");
  fs.symlinkSync(path.join(repo, "packages/cli/node_modules"), path.join(root, "packages/cli/node_modules"), "dir");
  fs.writeFileSync(path.join(root, "vite.config.ts"), `export default ${JSON.stringify({ run: config.run })};\n`);
  const log = path.join(root, "compiler-executions.log");
  const release = path.join(ipc, "release");
  const observer = path.join(root, "observe-compiler.cjs");
  fs.writeFileSync(
    observer,
    `const fs = require('node:fs');
if (process.argv[1]?.replaceAll('\\\\', '/').endsWith('/typescript/bin/tsc')) {
  fs.appendFileSync(${JSON.stringify(log)}, 'compiler executed\\n');
  ${
    wait
      ? // The installed compiler launcher normally execve's the native compiler.
        // Use its existing execFileSync fallback only in this cancellation fixture,
        // so a beforeExit hold proves real compilation finished before cancellation.
        `process.execve = undefined;
  process.once('beforeExit', () => {
    if (process.exitCode) return;
    console.log('TYPECHECK_FINISHED_WAIT');
    const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) clearInterval(timer); }, 25);
  });`
      : ""
  }
}
`,
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TMPDIR: ipc,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${JSON.stringify(observer)}`,
  };
  const count = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").length : 0);
  const dispose = () => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(ipc, { recursive: true, force: true });
  };
  return { root, env, count, dispose, release };
}

describe("guarded real developer typecheck", () => {
  it("resolves a fresh relative pnpm compiler shim through the linked store without sharing task cache", () => {
    const f = fixture();
    const observations: object[] = [];
    const compilerPackage = fs.realpathSync(path.join(repo, "packages/cli/node_modules/typescript"));
    const compilerVersion = JSON.parse(fs.readFileSync(path.join(compilerPackage, "package.json"), "utf8")).version;
    const relativeCompiler = path.relative(path.join(repo, "packages/cli/node_modules/.bin"), path.join(compilerPackage, "bin/tsc"));
    const store = path.join(f.root, "node_modules/.pnpm");
    const inputFiles = ["package.json", "pnpm-lock.yaml", "packages/cli/package.json", "packages/cli/tsconfig.json"];
    const hashes = (root: string) =>
      Object.fromEntries(
        inputFiles.map((file) => [
          file,
          createHash("sha256")
            .update(fs.readFileSync(path.join(root, file)))
            .digest("hex"),
        ]),
      );
    const snapshotHashes = hashes(f.root);
    try {
      expect(snapshotHashes).toEqual(hashes(repo));
      expect(f.env.VP_HOME).toBe(process.env.VP_HOME);
      // Replace only the fixture link, never write through the original package's
      // node_modules. This shim models fresh pnpm's root-relative compiler path.
      const packageModules = path.join(f.root, "packages/cli/node_modules");
      expect(fs.lstatSync(packageModules).isSymbolicLink()).toBe(true);
      fs.unlinkSync(packageModules);
      fs.mkdirSync(path.join(packageModules, ".bin"), { recursive: true });
      const shim = path.join(packageModules, ".bin/tsc");
      expect(relativeCompiler).toMatch(/^\.\.\/\.\.\/\.\.\/\.\.\/node_modules\/\.pnpm\//);
      fs.writeFileSync(shim, `#!/bin/sh\nbasedir=$(dirname "$0")\nexec node "$basedir/${relativeCompiler}" "$@"\n`);
      const invoke = (label: string) => {
        const result = spawnSync("sh", [shim, "--version"], {
          cwd: f.root,
          env: { ...f.env, PATH: `${path.dirname(process.execPath)}:${f.env.PATH}` },
          encoding: "utf8",
          timeout: 15_000,
        });
        observations.push({
          label,
          status: result.status,
          stdout: result.stdout,
          stderr: result.stderr,
        });
        expect(result.error).toBeUndefined();
        return result;
      };
      const loaded = invoke("linked-store");
      expect(loaded.status, loaded.stderr).toBe(0);
      expect(loaded.stdout.trim()).toBe(`Version ${compilerVersion}`);
      expect(fs.lstatSync(path.join(f.root, "node_modules")).isSymbolicLink()).toBe(false);
      expect(fs.lstatSync(store).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(store)).toBe(fs.realpathSync(path.join(repo, "node_modules/.pnpm")));
      fs.unlinkSync(store); // Remove only the owned link to reproduce the hosted gap.
      try {
        const missing = invoke("missing-store");
        expect(missing.status).toBe(1);
        expect(missing.stderr).toContain("MODULE_NOT_FOUND");
        expect(missing.stderr).toContain(path.join(f.root, "node_modules/.pnpm"));
      } finally {
        fs.symlinkSync(path.join(repo, "node_modules/.pnpm"), store, "dir");
      }
      expect(invoke("restored-store").status).toBe(0);
      const cache = path.join(f.root, "node_modules/.vite/task-cache");
      fs.mkdirSync(cache, { recursive: true });
      expect(fs.realpathSync(cache)).toBe(path.join(fs.realpathSync(f.root), "node_modules/.vite/task-cache"));
      const marker = `probe-${path.basename(f.root)}.txt`;
      fs.writeFileSync(path.join(cache, marker), "fixture-owned cache\n");
      expect(fs.existsSync(path.join(repo, "node_modules/.vite/task-cache", marker))).toBe(false);
    } finally {
      fs.writeFileSync(path.join(runEvidence, "relative-shim.json"), JSON.stringify({ compilerVersion, relativeCompiler, snapshotHashes, observations }, null, 2));
      f.dispose();
    }
  });

  it("qualifies actual compiler reuse, source/test/lock/environment misses, failure, and public alias fault rejection", () => {
    const f = fixture();
    const operations: object[] = [];
    const invoke = (label: string, expectedStatus: number, expectedCount: number, env = f.env, task = "typecheck:cached", flags: string[] = []) => {
      const started = performance.now();
      const result = spawnSync(launcher, ["run", ...flags, task], {
        cwd: f.root,
        env,
        encoding: "utf8",
        timeout: 15_000,
      });
      operations.push({
        label,
        task,
        elapsedMs: performance.now() - started,
        count: f.count(),
        status: result.status,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.error?.message,
      });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(expectedStatus);
      expect(f.count(), label).toBe(expectedCount);
      return result;
    };
    try {
      expect(fs.existsSync(path.join(f.root, "node_modules/.vite/task-cache"))).toBe(false);
      invoke("cold", 0, 1);
      for (let i = 1; i <= 3; i++) expect(invoke(`warm-${i}`, 0, 1).stdout).toContain("cache hit");
      fs.appendFileSync(path.join(f.root, "packages/cli/src/cli/argvalidate.ts"), "\n// Owned source invalidation probe.\n");
      invoke("source-edit", 0, 2);
      fs.appendFileSync(path.join(f.root, "packages/cli/test/config/taskCache.test.ts"), "\n// Owned test-input invalidation probe.\n");
      invoke("test-edit", 0, 3);
      fs.appendFileSync(path.join(f.root, "pnpm-lock.yaml"), "\n# Owned lockfile invalidation probe.\n");
      invoke("lock-edit", 0, 4);
      const env = { ...f.env, NODE_OPTIONS: `${f.env.NODE_OPTIONS} --trace-warnings` };
      invoke("node-options-edit", 0, 5, env);
      const errorFile = path.join(f.root, "packages/cli/src/cache-proof-error.ts");
      fs.writeFileSync(errorFile, "export const invalid: string = 123;\n");
      expect(invoke("compiler-failure-1", 1, 6, env).stdout).toContain("TS2322");
      invoke("compiler-failure-2", 1, 7, env);
      fs.writeFileSync(errorFile, "export const valid: string = 'fixed';\n");
      invoke("compiler-fixed", 0, 8, env);
      invoke("fixed-warm", 0, 8, env);
      const cache = path.join(f.root, "node_modules/.vite/task-cache");
      const database = fs
        .readdirSync(cache, { recursive: true })
        .map(String)
        .find((file) => file.endsWith("/cache.db"));
      expect(database).toBeDefined();
      const db = new DatabaseSync(path.join(cache, database!));
      try {
        expect(Number(db.prepare("UPDATE cache_entries SET value = ?").run(Buffer.from("corrupt entry payload")).changes)).toBeGreaterThan(0);
      } finally {
        db.close();
      }
      expect(invoke("public-alias-corrupt-entry", 1, 8, env).stdout).toContain("Cache lookup failed");
      invoke("fresh-default-recovery", 0, 9, env, "typecheck");
      invoke("no-cache-deletion-or-auto-retry", 1, 9, env);
    } finally {
      fs.writeFileSync(
        path.join(runEvidence, "real-owner.json"),
        JSON.stringify(
          {
            owner: "pnpm -C packages/cli run typecheck",
            script: JSON.parse(fs.readFileSync(path.join(f.root, "packages/cli/package.json"), "utf8")).scripts.typecheck,
            operations,
          },
          null,
          2,
        ),
      );
      f.dispose();
    }
  });

  it("never replays success after cancelling the actual completed compiler owner before task exit", async () => {
    const f = fixture(true);
    const tracking = trackGuardChild(f.root, path.join(f.root, guardRelative));
    const env = {
      ...f.env,
      NODE_OPTIONS: `${f.env.NODE_OPTIONS} --require=${JSON.stringify(path.join(f.root, "track-guard-child.cjs"))}`,
    };
    const operations: object[] = [];
    async function waitingCall(expectedCount: number, cancel: boolean) {
      expect(fs.existsSync(f.release)).toBe(false);
      fs.rmSync(tracking.marker, { force: true });
      const child = spawn(launcher, ["run", "typecheck:cached"], {
        cwd: f.root,
        env,
        detached: true,
        stdio: "pipe",
      });
      let stdout = "";
      let stderr = "";
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Typecheck deadline (15000ms): ${stdout}${stderr}`)), 15_000);
      });
      const ready = new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.stdout!.on("data", (chunk) => {
          stdout += chunk;
          if (stdout.includes("TYPECHECK_FINISHED_WAIT")) resolve();
        });
        child.stderr!.on("data", (chunk) => {
          stderr += chunk;
        });
        void closed.then(() => reject(new Error(`Exited before compiler finished: ${stdout}${stderr}`)));
      });
      try {
        await Promise.race([ready, deadline]);
        expect(f.count()).toBe(expectedCount);
        if (cancel) process.kill(-child.pid!, "SIGTERM");
        else fs.writeFileSync(f.release, "release");
        const result = await Promise.race([closed, deadline]);
        expect(result.code === 0 && result.signal === null, stdout + stderr).toBe(!cancel);
      } finally {
        clearTimeout(timer);
        const result = await stopGuardChild(child, closed, tracking.marker, true);
        operations.push({ cancel, count: f.count(), ...result, stdout, stderr });
      }
    }
    try {
      await waitingCall(1, true);
      await waitingCall(2, false); // Same inputs/env, still no release marker at start.
      const result = spawnSync(launcher, ["run", "typecheck:cached"], {
        cwd: f.root,
        env,
        encoding: "utf8",
        timeout: 15_000,
      });
      operations.push({
        warm: true,
        count: f.count(),
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(f.count()).toBe(2);
    } finally {
      fs.writeFileSync(path.join(runEvidence, "real-owner-cancellation.json"), JSON.stringify({ operations }, null, 2));
      f.dispose();
    }
  });
});
