#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const journalName = ".agentera-generated-publication.json";
const surfaces = ["dist", "bundle"];

function run(command, args, cwd = packageRoot) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status ?? "signal"}`);
}

function lockPath(root) {
  const identity = createHash("sha256").update(fs.realpathSync(root)).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), `agentera-generated-publication-${identity}.lock`);
}

function acquireLock(root, timeoutMs = 30_000) {
  const lock = lockPath(root);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, root }) + "\n");
      return () => fs.rmSync(lock, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner;
      try {
        owner = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8"));
      } catch {
        owner = undefined;
      }
      if (Number.isInteger(owner?.pid)) {
        try {
          process.kill(owner.pid, 0);
        } catch (signalError) {
          if (signalError?.code === "ESRCH") {
            fs.rmSync(lock, { recursive: true, force: true });
            continue;
          }
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(`generated-output publication is locked at ${lock}; correction: wait for PID ${owner?.pid ?? "unknown"} or remove the lock after confirming that process is gone`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

function recoverPublication(root, journalPath) {
  if (!fs.existsSync(journalPath)) return;
  let journal;
  try {
    journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  } catch (error) {
    throw new Error(`generated-output recovery journal is unreadable at ${journalPath}: ${error.message}; correction: preserve the file and generated directories for inspection`);
  }
  if (!Array.isArray(journal.entries) || journal.entries.length !== surfaces.length) {
    throw new Error(`generated-output recovery journal has an invalid surface inventory at ${journalPath}; correction: preserve it for inspection`);
  }
  for (const entry of journal.entries) {
    const expectedTarget = path.join(root, entry.surface ?? "");
    const backupPrefix = `.${entry.surface}.agentera-backup-`;
    if (!surfaces.includes(entry.surface)
      || entry.target !== expectedTarget
      || path.dirname(entry.backup ?? "") !== root
      || !path.basename(entry.backup).startsWith(backupPrefix)
      || typeof entry.hadPrevious !== "boolean") {
      throw new Error(`generated-output recovery journal has an unsafe ${entry.surface ?? "unknown"} entry at ${journalPath}; correction: preserve it for inspection`);
    }
  }
  if (new Set(journal.entries.map(({ surface }) => surface)).size !== surfaces.length) {
    throw new Error(`generated-output recovery journal repeats a surface at ${journalPath}; correction: preserve it for inspection`);
  }
  for (const entry of [...journal.entries].reverse()) {
    if (fs.existsSync(entry.backup)) {
      fs.rmSync(entry.target, { recursive: true, force: true });
      fs.renameSync(entry.backup, entry.target);
    } else if (!entry.hadPrevious) {
      fs.rmSync(entry.target, { recursive: true, force: true });
    }
  }
  fs.rmSync(journalPath, { force: true });
}

export function publishGeneratedSurfaces(root, stagedRoot, options = {}) {
  const release = acquireLock(root);
  const journalPath = path.join(root, journalName);
  try {
    options.onLockAcquired?.();
    if (options.holdLockMs) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, options.holdLockMs);
    }
    recoverPublication(root, journalPath);
    const transaction = randomUUID();
    const entries = surfaces.map((surface) => ({
      surface,
      target: path.join(root, surface),
      staged: path.join(stagedRoot, surface),
      backup: path.join(root, `.${surface}.agentera-backup-${transaction}`),
      hadPrevious: fs.existsSync(path.join(root, surface)),
    }));
    for (const entry of entries) {
      if (!fs.statSync(entry.staged).isDirectory()) throw new Error(`staged ${entry.surface} is not a directory: ${entry.staged}`);
    }
    fs.writeFileSync(journalPath, JSON.stringify({ schemaVersion: "agentera.generatedPublication.v1", entries }, null, 2) + "\n", { flag: "wx" });
    try {
      for (const entry of entries) {
        if (entry.hadPrevious) fs.renameSync(entry.target, entry.backup);
        fs.renameSync(entry.staged, entry.target);
        if (options.faultAfterSurface === entry.surface) {
          throw new Error(`injected interruption after ${entry.surface} publication`);
        }
      }
      fs.rmSync(journalPath, { force: true });
      for (const entry of entries) {
        try {
          fs.rmSync(entry.backup, { recursive: true, force: true });
        } catch (error) {
          console.warn(`build-package: published complete outputs but could not remove backup ${entry.backup}: ${error.message}`);
        }
      }
    } catch (error) {
      try {
        recoverPublication(root, journalPath);
      } catch (recoveryError) {
        throw new Error(`${error.message}; automatic recovery failed: ${recoveryError.message}`);
      }
      throw error;
    }
  } finally {
    release();
  }
}

function construct(outputRoot) {
  const distRoot = path.join(outputRoot, "dist");
  const bundleRoot = path.join(outputRoot, "bundle");
  const dependencies = path.join(outputRoot, "node_modules");
  fs.mkdirSync(outputRoot, { recursive: true });
  const createdDependencyLink = !fs.existsSync(dependencies);
  if (createdDependencyLink) fs.symlinkSync(path.join(packageRoot, "node_modules"), dependencies, "dir");
  try {
    run("pnpm", ["exec", "tsc", "-p", "tsconfig.json", "--outDir", distRoot]);
    run(process.execPath, ["scripts/copy-bundle.mjs", "--dist-root", distRoot, "--bundle-root", bundleRoot]);
  } finally {
    if (createdDependencyLink) fs.rmSync(dependencies, { force: true });
  }
}

function main() {
  const outputIndex = process.argv.indexOf("--output-root");
  if (outputIndex >= 0) {
    const outputRoot = process.argv[outputIndex + 1];
    if (!outputRoot) throw new Error("--output-root requires a path");
    construct(path.resolve(outputRoot));
    return;
  }
  const stagedRoot = fs.mkdtempSync(path.join(packageRoot, ".agentera-package-build-"));
  try {
    construct(stagedRoot);
    publishGeneratedSurfaces(packageRoot, stagedRoot);
  } finally {
    fs.rmSync(stagedRoot, { recursive: true, force: true });
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`build-package: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
