#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pinGeneratedGeneration, selectGeneratedGeneration } from "./generated-output.mjs";
import { validatePendingTests } from "./overlap-pending.mjs";
import { npmChildEnvironment } from "./package-construction.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-real-overlap-"));
const barrier = path.join(root, "barrier");
const repoRoot = path.resolve(packageRoot, "../..");
const policyBytes = fs.readFileSync(path.join(repoRoot, "references/analysis/verification-policy.yaml"));
const inventoryResult = spawnSync(process.execPath, ["scripts/verify-lane.mjs", "inventory", "--json"], {
  cwd: packageRoot,
  encoding: "utf8",
});
if (inventoryResult.status !== 0) throw new Error(`verification inventory failed: ${inventoryResult.stderr || inventoryResult.stdout}`);
const inventory = JSON.parse(inventoryResult.stdout);
const participants = {
  source: ["pnpm", "-C", "packages/cli", "run", "test:source"],
  build: ["pnpm", "-C", "packages/cli", "build"],
  package: ["pnpm", "-C", "packages/cli", "run", "verify:package"],
};

function start(participant, command) {
  const started = performance.now();
  const output = path.join(root, `${participant}.log`);
  const stream = fs.createWriteStream(output);
  const stateRoot = path.join(root, `${participant}-npm-state`);
  const home = path.join(stateRoot, "home");
  const cache = path.join(stateRoot, "cache");
  const userConfig = path.join(stateRoot, "user.npmrc");
  const globalConfig = path.join(stateRoot, "global.npmrc");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  fs.writeFileSync(userConfig, "registry=https://registry.npmjs.org/\n", { mode: 0o600, flag: "wx" });
  fs.writeFileSync(globalConfig, "registry=https://registry.npmjs.org/\n", { mode: 0o600, flag: "wx" });
  const child = spawn(command[0], command.slice(1), {
    cwd: repoRoot,
    env: {
      ...npmChildEnvironment(process.env, userConfig, globalConfig),
      HOME: home,
      XDG_CONFIG_HOME: path.join(stateRoot, "config"),
      NPM_CONFIG_CACHE: cache,
      AGENTERA_VERIFICATION_BARRIER: barrier,
      AGENTERA_VERIFICATION_PARTICIPANT: participant,
      ...(participant === "build" ? {} : { AGENTERA_VERIFICATION_RESULT: path.join(root, `${participant}.json`) }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(stream);
  child.stderr.pipe(stream);
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => {
      stream.end();
      if (code === 0) resolve({
        command,
        elapsedMs: Math.max(0, Math.round(performance.now() - started)),
        log: output,
      });
      else reject(new Error(`${participant} overlap command failed with exit ${code}; log: ${output}`));
    });
  });
}

async function waitForReady() {
  const deadline = Date.now() + 30_000;
  while (!Object.keys(participants).every((name) => fs.existsSync(path.join(barrier, `${name}.ready`)))) {
    if (Date.now() >= deadline) throw new Error(`real overlap participants did not become ready under ${barrier}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function ownerResult(owner) {
  const result = fs.readFileSync(path.join(root, `${owner}.json`));
  const expectedFiles = inventory.files[owner];
  const pending = validatePendingTests(owner, result, Buffer.from(JSON.stringify(expectedFiles)), policyBytes, repoRoot, process.platform);
  return { files: expectedFiles.length, tests: JSON.parse(result.toString("utf8")).numTotalTests, pending };
}

let running = [];
let settlement = Promise.resolve([]);
try {
  for (const target of [".agentera-generated", "dist", "bundle"]) {
    fs.rmSync(path.join(packageRoot, target), { recursive: true, force: true });
  }
  running = Object.entries(participants).map(([name, command]) => [name, start(name, command)]);
  settlement = Promise.allSettled(running.map(async ([name, done]) => [name, await done]));
  await waitForReady();
  fs.writeFileSync(path.join(barrier, "release"), "release\n");
  let observed = false;
  let identityMismatches = 0;
  let surfaceValidationFailures = 0;
  const readerGenerations = new Set();
  let readerError;
  const monitor = setInterval(() => {
    try {
      if (!fs.existsSync(path.join(packageRoot, ".agentera-generated", "current"))) return;
      const pinned = pinGeneratedGeneration(packageRoot);
      try {
        const dist = JSON.parse(fs.readFileSync(path.join(pinned.root, "dist", ".agentera-generation.json"), "utf8")).id;
        const bundle = JSON.parse(fs.readFileSync(path.join(pinned.root, "bundle", ".agentera-generation.json"), "utf8")).id;
        if (pinned.id !== dist || pinned.id !== bundle) {
          identityMismatches += 1;
          throw new Error(`reader mixed ${pinned.id}, ${dist}, and ${bundle}`);
        }
        if (pinned.inventory.dist.entries < 1 || pinned.inventory.bundle.entries < 1) {
          surfaceValidationFailures += 1;
          throw new Error(`reader observed an empty generated surface in ${pinned.id}`);
        }
        observed = true;
        readerGenerations.add(pinned.id);
      } finally {
        pinned.release();
      }
    } catch (error) {
      readerError ??= error;
    }
  }, 10);
  const settled = await settlement;
  clearInterval(monitor);
  const failures = settled.filter(({ status }) => status === "rejected");
  if (failures.length > 0) throw failures[0].reason;
  const completed = Object.fromEntries(settled.map(({ value }) => value));
  if (readerError) throw new Error(`continuous generated reader failed: ${readerError.message}`);
  if (!observed) throw new Error("continuous generated reader observed no selected generation during full-owner overlap");
  const source = ownerResult("source");
  const packageResult = ownerResult("package");
  if (source.files !== inventory.counts.source || packageResult.files !== inventory.counts.package) {
    throw new Error(`real overlap owner count mismatch: ${JSON.stringify({ source, package: packageResult, inventory: inventory.counts })}`);
  }
  const selected = selectGeneratedGeneration(packageRoot);
  const invocation = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(packageRoot, "dist/bin/agentera.js"), "--version"], { cwd: packageRoot });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`selected CLI failed: ${stderr}`)));
  });
  console.log(JSON.stringify({
    schemaVersion: "agentera.generatedOverlapEvidence.v1",
    status: "pass",
    inventory: inventory.counts,
    participants: {
      source: {
        ...source,
        command: completed.source.command,
        elapsedMs: completed.source.elapsedMs,
      },
      package: {
        ...packageResult,
        command: completed.package.command,
        elapsedMs: completed.package.elapsedMs,
      },
      build: {
        command: completed.build.command,
        elapsedMs: completed.build.elapsedMs,
        status: "pass",
      },
    },
    reader: {
      observed,
      all_observations_complete: identityMismatches === 0 && surfaceValidationFailures === 0,
      identity_mismatches: identityMismatches,
      surface_validation_failures: surfaceValidationFailures,
      generations: [...readerGenerations],
    },
    generation: selected.id,
    invocation,
  }));
} catch (error) {
  if (running.length > 0) await settlement;
  console.error(`verify-generated-overlap: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (process.exitCode !== 1) fs.rmSync(root, { recursive: true, force: true });
}
