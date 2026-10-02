import { spawn, spawnSync as nodeSpawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import config from "../../../../vite.config.ts";
import { sharedTestConfig } from "../../vitest.shared.ts";
import { startNativeDiagnostic, writeSourceDiagnostic } from "../../scripts/source-diagnostics.mjs";
import { stopGuardChild, trackGuardChild } from "../helpers/nativeCacheGuardCleanup.js";

const repo = path.resolve(import.meta.dirname, "../../../..");
const packageManager = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).packageManager;
const vp = path.join(repo, "node_modules/.bin/vp");
const cacheGuard = path.join(repo, "packages/cli/scripts/guard-native-cache.mjs");
const tasks = config.run!.tasks!;
// Synthetic cache probes remain separate from the guarded real typecheck proof.
// Never accept the native malformed-entry success without the outer guard.
const requiredFreshNames = [
  "bootstrap",
  "test",
  "test:local",
  "build",
  "verify",
  "verify:development",
  "typecheck",
  "typecheck:fresh",
  "cli:prepare:dev",
  "cli:prepare:stable",
  "cli:qualify:source",
  "cli:ready:dev",
  "cli:qualify:dev",
  "cli:benchmark:qualification",
  "cli:publish:qualified:dev",
  "cli:publish:qualified:stable",
  "cli:approve:dev",
  "cli:stage:dev",
  "cli:promote:dev",
  "cli:stage:stable",
  "cli:promote:stable",
];
const freshNames = [...requiredFreshNames, "typecheck:cached"];
const candidateCache = {
  input: [{ auto: true }, ".node-version", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "references/analysis/toolchain-baseline.yaml"],
  env: ["NODE_OPTIONS", "NODE_PATH", "NODE_ENV", "PATH", "VP_HOME", "VP_NODE_VERSION", "VP_PACKAGE_MANAGER", "VP_PNPM_VERSION", "PROBE_MODE", "PROBE_RELEASE"],
  output: [],
};
const roots: string[] = [];
const ipcRoots = new Map<string, string>();
const evidence = process.env.AGENTERA_NATIVE_DIAGNOSTIC_ROOT ? path.join(process.env.AGENTERA_NATIVE_DIAGNOSTIC_ROOT, "cache") : path.join(repo, ".vitest/followup/cache");
fs.mkdirSync(evidence, { recursive: true });
const runEvidence = fs.mkdtempSync(path.join(evidence, "run-"));
let invocation = 0;
let nativeInvocation = 0;
const diagnosticFile = "packages/cli/test/config/taskCache.test.ts";
function spawnSync(command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) {
  const index = ++nativeInvocation;
  const timing = startNativeDiagnostic(diagnosticFile, index);
  const marker = path.join(runEvidence, `child-start-${index}.json`);
  const result = nodeSpawnSync(command, args, {
    ...options,
    // Descriptor 3 bypasses spawnSync's captured stdout/stderr. A blocked native
    // invocation still exposes the real fixture child start to both coordinators.
    stdio: ["pipe", "pipe", "pipe", 2],
    env: {
      ...options.env,
      AGENTERA_NATIVE_STARTED: String(timing.started),
      AGENTERA_NATIVE_INDEX: String(index),
      AGENTERA_NATIVE_MARKER: marker,
    },
  });
  timing.complete(result);
  let childStarted: number | null = null;
  try {
    childStarted = JSON.parse(fs.readFileSync(marker, "utf8")).started;
  } catch {
    /* A cache hit or non-probe command has no child marker. */
  }
  record("native-timing", {
    index,
    totalMs: Date.now() - timing.started,
    parentToChildMs: childStarted === null ? null : childStarted - timing.started,
    childToExitMs: childStarted === null ? null : Date.now() - childStarted,
    status: result.status,
    errorCode: result.error?.code ?? null,
  });
  return result;
}
function record(label: string, result: object) {
  fs.writeFileSync(path.join(runEvidence, `${++invocation}-${label}.json`), JSON.stringify(result, null, 2));
}
function cleanup(root: string) {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(ipcRoots.get(root)!, { recursive: true, force: true });
  ipcRoots.delete(root);
}
afterEach(() => roots.splice(0).forEach(cleanup));

function fixture(suiteOwned = false) {
  // Bulk data and caches stay on disk. Only native Unix sockets use short /tmp.
  const root = fs.mkdtempSync(path.join(runEvidence, "fixture-"));
  ipcRoots.set(root, fs.mkdtempSync("/tmp/atc-"));
  if (!suiteOwned) roots.push(root);
  // Each fixture owns its cache. Never symlink the whole node_modules directory.
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.symlinkSync(path.join(repo, "node_modules/vite-plus"), path.join(root, "node_modules/vite-plus"), "dir");
  fs.copyFileSync(path.join(repo, ".node-version"), path.join(root, ".node-version"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "cache-probe", private: true, type: "module", packageManager }));
  fs.writeFileSync(path.join(root, "input.txt"), "original");
  fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "lock input\n");
  // Nested disk fixtures must not discover the enclosing production workspace.
  fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  fs.writeFileSync(
    path.join(root, "child.mjs"),
    `import fs from 'node:fs';
import { writeSourceDiagnostic } from ${JSON.stringify(path.join(repo, "packages/cli/scripts/source-diagnostics.mjs"))};
const started = Date.now();
if (process.env.AGENTERA_NATIVE_MARKER) fs.writeFileSync(process.env.AGENTERA_NATIVE_MARKER, JSON.stringify({started}));
writeSourceDiagnostic({file: ${JSON.stringify(diagnosticFile)}, phase: 'native-child-start', index: Number(process.env.AGENTERA_NATIVE_INDEX), elapsedMs: started - Number(process.env.AGENTERA_NATIVE_STARTED)}, {fd: 3});
fs.readFileSync('input.txt', 'utf8');
fs.appendFileSync('executions.log', 'executed\\n');
fs.appendFileSync('argv.log', JSON.stringify({args: process.argv.slice(2), mode: process.env.PROBE_MODE ?? null}) + '\\n');
if (process.env.PROBE_MODE === 'fail') process.exit(19);
if (process.env.PROBE_MODE === 'wait') {
console.log('READY');
await new Promise(resolve => {
const timer = setInterval(() => {
if (fs.existsSync(process.env.PROBE_RELEASE)) { clearInterval(timer); resolve(); }
}, 25);
});
}
console.log('probe assertions executed');\n`,
  );
  const command = "node child.mjs";
  const cache = candidateCache;
  const fresh = Object.fromEntries(Object.entries(tasks).map(([name, task]) => [name, { ...(task as object), command }]));
  fs.writeFileSync(path.join(root, "vite.config.ts"), `export default ${JSON.stringify({ run: { ...config.run, cache: { scripts: false, tasks: true }, tasks: { ...fresh, diagnostic: { command, cache } } } })};\n`);
  writeSourceDiagnostic({ file: diagnosticFile, phase: "fixture-ready" });
  return root;
}
function run(root: string, task = "diagnostic", env: NodeJS.ProcessEnv = process.env, flags: string[] = [], guarded = false) {
  const args = ["run", ...flags, task];
  const result = spawnSync(guarded ? process.execPath : vp, guarded ? [cacheGuard, vp, ...args] : args, {
    cwd: root,
    // Native task-cache tracking uses a Unix socket beneath TMPDIR. The private
    // qualification owner's nested temp path can exceed Linux SUN_LEN; the
    // fixture owns a short temp root without changing production cache policy.
    env: {
      ...env,
      TMPDIR: ipcRoots.get(root),
      PROBE_RELEASE: path.join(ipcRoots.get(root)!, "release"),
    },
    encoding: "utf8",
    timeout: 15_000,
  });
  record(task, { root, flags, guarded, mode: env.PROBE_MODE, ...result });
  expect(result.error, result.stderr).toBeUndefined();
  return result;
}
function pass(root: string, task = "diagnostic", env: NodeJS.ProcessEnv = process.env, flags: string[] = []) {
  const result = run(root, task, env, flags);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return result;
}
function executions(root: string) {
  return fs.readFileSync(path.join(root, "executions.log"), "utf8").trim().split("\n").length;
}

describe("fresh tasks and bounded preparation reuse", () => {
  it("declares the canonical provisioned manager without latest registry resolution", () => {
    const root = fixture();
    expect(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).packageManager).toBe(packageManager);
    const result = pass(root, "diagnostic", {
      ...process.env,
      VP_LOG: "vp_pm_cli=debug,vite_plus_cli=debug",
    });
    expect(result.stdout + result.stderr).not.toMatch(/\/pnpm\/latest|failed to resolve package manager for task PATH setup|Downloading pnpm/);
    expect(executions(root)).toBe(1);
  });

  it("activates the pinned runtime inside root pnpm tasks instead of ambient Node", () => {
    const root = fixture();
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    manifest.packageManager = packageManager;
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
    fs.mkdirSync(path.join(root, "packages/cli"), { recursive: true });
    fs.writeFileSync(path.join(root, "packages/cli/package.json"), JSON.stringify({ name: "runtime-probe", scripts: { typecheck: "node runtime.cjs" } }));
    fs.writeFileSync(path.join(root, "packages/cli/runtime.cjs"), 'require("node:fs").writeFileSync("runtime.json", JSON.stringify({ version: process.version, args: process.argv.slice(2) }));');
    fs.writeFileSync(path.join(root, "vite.config.ts"), `export default ${JSON.stringify({ run: { cache: false, tasks: { typecheck: tasks.typecheck } } })};`);
    expect(process.env.VP_CLI_BIN).toBeDefined();
    const result = spawnSync(process.env.VP_CLI_BIN!, ["run", "typecheck", "--", "two words"], {
      cwd: root,
      env: {
        ...process.env,
        TMPDIR: ipcRoots.get(root),
        PATH: `${path.dirname(vp)}:/usr/bin:/bin`,
      },
      encoding: "utf8",
      timeout: 30_000,
    });
    record("runtime", result);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(root, "packages/cli/runtime.json"), "utf8"))).toEqual({
      version: `v${fs.readFileSync(path.join(repo, ".node-version"), "utf8").trim()}`,
      args: ["--", "two words"],
    });
  });
  it("reuses transformed preparation but executes assertions again, including a warm failure", () => {
    const root = fixture();
    const testConfig = {
      ...sharedTestConfig,
      maxWorkers: 1,
      include: ["probe.test.ts"],
      fsModuleCachePath: path.join(root, "module-cache"),
    };
    fs.writeFileSync(
      path.join(root, "vite.config.ts"),
      `import fs from 'node:fs';
export default { test: ${JSON.stringify(testConfig)}, plugins: [{ name: 'observe-preparation', transform(code, id) {
if (id.endsWith('/subject.ts') || id.endsWith('/probe.test.ts')) fs.appendFileSync(${JSON.stringify(path.join(root, "transforms.log"))}, id + '\\n');
} }] };\n`,
    );
    fs.writeFileSync(path.join(root, "subject.ts"), "export const value: number = 1;\n");
    fs.writeFileSync(
      path.join(root, "probe.test.ts"),
      `import fs from 'node:fs';
import { it, expect } from 'vite-plus/test';
import { value } from './subject.ts';
it('fresh assertion', () => {
fs.appendFileSync(${JSON.stringify(path.join(root, "assertions.log"))}, 'asserted\\n');
expect(value).toBe(Number(process.env.EXPECTED ?? 1));
});\n`,
    );
    const test = (expected = "1") => {
      const result = spawnSync(vp, ["test", "run", "--config", "vite.config.ts", "--reporter=dot"], {
        cwd: root,
        env: { ...process.env, TMPDIR: ipcRoots.get(root), EXPECTED: expected },
        encoding: "utf8",
        timeout: 15_000,
      });
      record("preparation", { expected, ...result });
      return result;
    };
    const lines = (file: string) => fs.readFileSync(path.join(root, file), "utf8").trim().split("\n").length;
    const cold = test();
    expect(cold.status, cold.stdout + cold.stderr).toBe(0);
    expect(lines("transforms.log")).toBe(2);
    expect(lines("assertions.log")).toBe(1);
    const warm = test();
    expect(warm.status, warm.stdout + warm.stderr).toBe(0);
    expect(lines("transforms.log")).toBe(2); // No repeated deterministic preparation.
    expect(lines("assertions.log")).toBe(2); // Assertions were not replayed.
    const failure = test("2");
    expect(failure.status).not.toBe(0);
    expect(lines("transforms.log")).toBe(2);
    expect(lines("assertions.log")).toBe(3);
    fs.writeFileSync(path.join(root, "subject.ts"), "export const value: number = 2;\n");
    const changed = test("2");
    expect(changed.status, changed.stdout + changed.stderr).toBe(0);
    expect(lines("transforms.log")).toBe(3);
    expect(lines("assertions.log")).toBe(4);
    const moduleCache = path.join(root, "module-cache");
    const entries = fs.readdirSync(moduleCache).filter((file) => /^[a-f0-9]{40}$/.test(file));
    expect(entries.length).toBeGreaterThan(0);
    for (const file of entries) fs.writeFileSync(path.join(moduleCache, file), "corrupt transformed module\n");
    const repaired = test("2");
    expect(repaired.status, repaired.stdout + repaired.stderr).toBe(0);
    expect(lines("transforms.log")).toBe(5);
    expect(lines("assertions.log")).toBe(5);
  });

  it("keeps required root tasks fresh and limits explicit developer diagnostics", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
    expect(manifest.scripts).toBeUndefined(); // Task/script names cannot overlap.
    expect(Object.keys(tasks).sort()).toEqual([...freshNames, "_typecheck:cached"].sort());
    expect(requiredFreshNames).toHaveLength(21);
    for (const name of freshNames) {
      expect(tasks[name], name).toMatchObject({ cache: false, command: expect.any(String) });
    }
    expect(tasks.typecheck).toEqual(tasks["typecheck:fresh"]);
    expect(tasks.test).toMatchObject({
      command: '"$VP_CLI_BIN" env exec --node 24.19.0 pnpm -C packages/cli test',
    });
    expect(tasks.build).toMatchObject({
      command: '"$VP_CLI_BIN" env exec --node 24.19.0 pnpm -C packages/cli build',
    });
    expect(tasks.verify).toMatchObject({
      command: '"$VP_CLI_BIN" env exec --node 24.19.0 pnpm -C packages/cli run verify:release',
    });
    expect(tasks["verify:development"]).toMatchObject({
      command: '"$VP_CLI_BIN" env exec --node 24.19.0 pnpm -C packages/cli run verify:development',
    });
    expect(config.run!.cache).toEqual({ scripts: false, tasks: true });
    expect(tasks["_typecheck:cached"]).toMatchObject({
      command: (tasks.typecheck as { command: string }).command,
      cache: {
        input: expect.arrayContaining(["packages/cli/src/**", "packages/cli/test/**", "pnpm-lock.yaml"]),
        output: [],
        env: expect.arrayContaining(["NODE_OPTIONS", "NODE_ENV", "VP_CLI_BIN"]),
      },
    });
    expect(tasks["typecheck:cached"]).toMatchObject({
      command: expect.stringContaining('node packages/cli/scripts/guard-native-cache.mjs "$VP_CLI_BIN" run _typecheck:cached'),
    });
    expect(tasks).not.toHaveProperty("typecheck:local");
    expect(tasks["test:local"]).toMatchObject({
      command: '"$VP_CLI_BIN" env exec --node 24.19.0 vp test run --project local',
      cache: false,
    });
    expect(sharedTestConfig.fsModuleCache).toBe(true);
  });

  it("hits only unchanged inputs and environment, and --no-cache executes", () => {
    const root = fixture();
    pass(root);
    expect(executions(root)).toBe(1);
    pass(root);
    expect(executions(root)).toBe(1);
    fs.writeFileSync(path.join(root, "input.txt"), "changed automatically tracked input");
    pass(root);
    expect(executions(root)).toBe(2);
    fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "changed explicit tool input\n");
    pass(root);
    expect(executions(root)).toBe(3);
    const env = { ...process.env, NODE_OPTIONS: "--trace-warnings" };
    pass(root, "diagnostic", env);
    expect(executions(root)).toBe(4);
    pass(root, "diagnostic", env);
    expect(executions(root)).toBe(4);
    pass(root, "diagnostic", env, ["--no-cache"]);
    expect(executions(root)).toBe(5);
  });

  describe("fresh root owners beside a valid cached verdict", { concurrency: false }, () => {
    let root: string;
    beforeAll(() => {
      root = fixture(true);
      pass(root);
      pass(root);
      expect(executions(root)).toBe(1);
    });
    afterAll(() => {
      if (root) cleanup(root);
    });
    for (const name of freshNames) {
      it(`${name} executes twice under --cache`, () => {
        const before = executions(root);
        pass(root, name, process.env, ["--cache"]);
        pass(root, name, process.env, ["--cache"]);
        expect(executions(root), name).toBe(before + 2);
      });
    }
  });

  it("explicitly permits only the private developer typecheck exception to reuse a verdict", () => {
    const root = fixture();
    pass(root, "_typecheck:cached");
    pass(root, "_typecheck:cached");
    expect(executions(root)).toBe(1);
  });

  it("never turns failed children into successful cache entries", () => {
    const root = fixture();
    const env = { ...process.env, PROBE_MODE: "fail" };
    expect(run(root, "diagnostic", env).status).not.toBe(0);
    expect(run(root, "diagnostic", env).status).not.toBe(0);
    expect(executions(root)).toBe(2);
    pass(root);
    pass(root);
    expect(executions(root)).toBe(3);
  });

  it("preserves uncached script argument forwarding, environment and child failure", () => {
    const root = fixture();
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    manifest.scripts = { legacy: "node child.mjs" };
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
    const env = { ...process.env, PROBE_MODE: "fail" };
    for (const task of ["legacy", "typecheck"]) {
      const result = spawnSync(vp, ["run", task, "--", "--flag", "two words"], {
        cwd: root,
        env: { ...env, TMPDIR: ipcRoots.get(root) },
        encoding: "utf8",
        timeout: 15_000,
      });
      record(task, result);
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
    }
    const records = fs
      .readFileSync(path.join(root, "argv.log"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({ args: ["--", "--flag", "two words"], mode: "fail" });
    expect(records[1]).toEqual(records[0]);
  });

  it("isolates malformed-entry false success from hard-fresh root tasks", () => {
    const root = fixture();
    pass(root);
    pass(root);
    expect(executions(root)).toBe(1);
    const cache = path.join(root, "node_modules/.vite/task-cache");
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
    const result = run(root);
    // Characterize the native defect rather than accept it as fail-closed reuse.
    expect(result.stdout).toContain("Cache lookup failed");
    expect(result.status).toBe(0);
    expect(executions(root)).toBe(1);
    pass(root, "typecheck", process.env, ["--cache"]);
    expect(executions(root)).toBe(2);
  });

  it("outer guard rejects the actual malformed native entry and permits valid hits and ordinary failures", () => {
    const root = fixture();
    expect(run(root, "diagnostic", process.env, [], true).status).toBe(0);
    const hit = run(root, "diagnostic", process.env, [], true);
    expect(hit.status, hit.stdout + hit.stderr).toBe(0);
    expect(executions(root)).toBe(1);
    const cache = path.join(root, "node_modules/.vite/task-cache");
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
    const rejected = run(root, "diagnostic", process.env, [], true);
    expect(rejected.stdout + rejected.stderr).toContain("Cache lookup failed");
    expect(rejected.status).toBe(1);
    expect(executions(root)).toBe(1); // No retry or falsely accepted skip.
    const failed = run(root, "diagnostic", { ...process.env, PROBE_MODE: "fail" }, ["--no-cache"], true);
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).not.toContain("Native cache guard rejected");
    expect(executions(root)).toBe(2); // Exactly one ordinary failed execution.
    expect(run(root, "typecheck", process.env, [], true).status).toBe(0);
    expect(executions(root)).toBe(3); // Existing fresh entry works without deletion.
  });

  it("rejects a wholly corrupt native cache database", () => {
    const root = fixture();
    pass(root);
    pass(root);
    const cache = path.join(root, "node_modules/.vite/task-cache");
    const files = fs
      .readdirSync(cache, { recursive: true })
      .map(String)
      .filter((file) => fs.statSync(path.join(cache, file)).isFile());
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) fs.writeFileSync(path.join(cache, file), "corrupt cache probe\n");
    const result = run(root);
    // A stale successful replay is forbidden. Native rejection is also safe.
    expect(result.status !== 0 || executions(root) === 2, result.stdout + result.stderr).toBe(true);
  });

  for (const guarded of [false, true])
    it(`does not store success when an executing child is cancelled (outer guard: ${guarded})`, async () => {
      // This asynchronous journey owns deletion, not afterEach: a Vitest timeout
      // stops awaiting the callback but must not delete a still-running fixture.
      const root = fixture(true);
      const env = { ...process.env, PROBE_MODE: "wait" };
      const release = path.join(ipcRoots.get(root)!, "release");
      const tracking = trackGuardChild(root, cacheGuard);
      // Both waiting calls start with identical command/env and no release input.
      async function waitingCall(expectedExecutions: number, cancel: boolean) {
        expect(fs.existsSync(release)).toBe(false);
        fs.rmSync(tracking.marker, { force: true });
        const child = spawn(guarded ? process.execPath : vp, guarded ? [cacheGuard, vp, "run", "diagnostic"] : ["run", "diagnostic"], {
          cwd: root,
          env: {
            ...tracking.env,
            ...env,
            NODE_OPTIONS: tracking.env.NODE_OPTIONS,
            TMPDIR: ipcRoots.get(root),
            PROBE_RELEASE: release,
          },
          detached: true,
          stdio: "pipe",
        });
        let stdout = "";
        let stderr = "";
        let startupError: string | undefined;
        const context = () =>
          JSON.stringify({
            stdout,
            stderr,
            startupError,
            code: child.exitCode,
            signal: child.signalCode,
          });
        const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
          child.once("error", (error) => {
            startupError = error.message;
          });
          // close drains the pipes before fixture cleanup.
          child.once("close", (code, signal) => resolve({ code, signal }));
        });
        // Use the existing 15s task-child deadline, not the unrelated 5s poll.
        // READY cannot become successful completion without the external release marker.
        let timer: ReturnType<typeof setTimeout>;
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Waiting child deadline (15000ms): ${context()}`)), 15_000);
        });
        const ready = new Promise<void>((resolve, reject) => {
          child.stdout.on("data", (data) => {
            stdout += data.toString();
            if (stdout.split(/\r?\n/).includes("READY")) resolve();
          });
          child.stderr.on("data", (data) => {
            stderr += data.toString();
          });
          child.once("error", (error) => reject(new Error(`Startup failed: ${error.message}; ${context()}`)));
          void exited.then(() => reject(new Error(`Exited before READY: ${context()}`)));
        });
        try {
          await Promise.race([ready, deadline]);
          expect(fs.existsSync(release), context()).toBe(false);
          expect(executions(root), context()).toBe(expectedExecutions);
          expect(child.exitCode, context()).toBeNull();
          expect(child.signalCode, context()).toBeNull();
          if (cancel) process.kill(-child.pid!, "SIGTERM");
          else fs.writeFileSync(release, "release");
          const result = await Promise.race([exited, deadline]);
          expect(result.code === 0 && result.signal === null, context()).toBe(!cancel);
        } finally {
          clearTimeout(timer!);
          const result = await stopGuardChild(child, exited, tracking.marker, true);
          record(cancel ? "cancellation" : "cancel-retry", {
            ...result,
            stdout,
            stderr,
            startupError,
          });
        }
      }
      try {
        await waitingCall(1, true);
        // Prove fresh execution before changing the potentially tracked release input.
        await waitingCall(2, false);
        expect(executions(root)).toBe(2);
        // The successful retry created a valid verdict with the marker present.
        pass(root, "diagnostic", { ...env, NODE_OPTIONS: tracking.env.NODE_OPTIONS });
        expect(executions(root)).toBe(2);
      } finally {
        cleanup(root); // waitingCall has drained the inner group before returning.
      }
    });
});
