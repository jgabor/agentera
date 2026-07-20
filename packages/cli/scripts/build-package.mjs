#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { waitForVerificationBarrier } from "./verification-barrier.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const generatedDirectory = ".agentera-generated";
const identityFile = ".agentera-generation.json";

function run(command, args, cwd = packageRoot) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status ?? "signal"}`);
}

export function legacyPublicationLockPath(root) {
  const identity = createHash("sha256").update(fs.realpathSync(root)).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), `agentera-generated-publication-${identity}.lock`);
}

function rejectLegacyRecoveryResidue(root) {
  const legacyLock = legacyPublicationLockPath(root);
  if (fs.existsSync(legacyLock)) {
    let ownerPid;
    try {
      ownerPid = JSON.parse(fs.readFileSync(path.join(legacyLock, "owner.json"), "utf8")).pid;
    } catch {
      ownerPid = undefined;
    }
    if (Number.isInteger(ownerPid) && processIsAlive(ownerPid)) {
      throw new Error(`legacy generated-output publisher PID ${ownerPid} is active at ${legacyLock}; correction: wait for it to finish`);
    }
    const ageMs = Date.now() - fs.statSync(legacyLock).mtimeMs;
    if (!Number.isInteger(ownerPid) && ageMs < 30_000) {
      throw new Error(`legacy generated-output lock has no complete owner record at ${legacyLock}; correction: retry after 30 seconds or preserve it for inspection`);
    }
    fs.rmSync(legacyLock, { recursive: true, force: true });
  }
  const residue = fs.readdirSync(root)
    .filter((name) => name === ".agentera-generated-publication.json"
      || name.startsWith(".dist.agentera-backup-")
      || name.startsWith(".bundle.agentera-backup-"))
    .sort();
  if (residue.length > 0) {
    const shown = residue.slice(0, 3).map((name) => path.join(root, name));
    const omitted = residue.length - shown.length;
    throw new Error(`legacy generated-output recovery residue must be preserved for inspection: ${shown.join(", ")}${omitted > 0 ? ` (${omitted} more)` : ""}; correction: verify or remove the legacy residue, then rerun build`);
  }
}

function readIdentity(file, label) {
  if (!fs.existsSync(file)) throw new Error(`${label} identity is missing at ${file}`);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${label} identity is invalid at ${file}: ${error.message}`);
  }
  if (parsed?.schemaVersion !== "agentera.generatedGeneration.v1" || typeof parsed?.id !== "string") {
    throw new Error(`${label} identity has an invalid contract at ${file}`);
  }
  return parsed.id;
}

export function writeGenerationIdentity(generationRoot, id) {
  const payload = JSON.stringify({ schemaVersion: "agentera.generatedGeneration.v1", id, ownerPid: process.pid }, null, 2) + "\n";
  fs.writeFileSync(path.join(generationRoot, identityFile), payload);
  for (const surface of ["dist", "bundle"]) {
    fs.writeFileSync(path.join(generationRoot, surface, identityFile), payload);
  }
}

function validateGeneration(generationRoot, expectedId) {
  const identities = [
    readIdentity(path.join(generationRoot, identityFile), "generation"),
    readIdentity(path.join(generationRoot, "dist", identityFile), "dist"),
    readIdentity(path.join(generationRoot, "bundle", identityFile), "bundle"),
  ];
  if (identities.some((id) => id !== expectedId)) {
    throw new Error(`generated surfaces do not share generation ${JSON.stringify(expectedId)} at ${generationRoot}`);
  }
  return { id: expectedId, root: generationRoot };
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

export function cleanupGeneratedState(root) {
  const generatedRoot = path.join(root, generatedDirectory);
  if (!fs.existsSync(generatedRoot)) return;
  const malformed = [];
  for (const name of fs.readdirSync(generatedRoot)) {
    if (!name.startsWith(".staging-")) continue;
    const match = /^\.staging-(\d+)-[0-9a-f-]+$/.exec(name);
    if (!match) {
      malformed.push(path.join(generatedRoot, name));
      continue;
    }
    if (!processIsAlive(Number(match[1]))) {
      fs.rmSync(path.join(generatedRoot, name), { recursive: true, force: true });
    }
  }
  if (malformed.length > 0) {
    const shown = malformed.slice(0, 3);
    throw new Error(`generated-output staging state has unknown ownership: ${shown.join(", ")}${malformed.length > shown.length ? ` (${malformed.length - shown.length} more)` : ""}; correction: preserve it for inspection before removal`);
  }
  try {
    const current = fs.realpathSync(path.join(generatedRoot, "current"));
    fs.writeFileSync(path.join(current, ".selected"), "selected\n");
  } catch {
    // A missing selection is valid before the first successful build.
  }
  const generationsRoot = path.join(generatedRoot, "generations");
  if (!fs.existsSync(generationsRoot)) return;
  let current = null;
  try {
    current = fs.realpathSync(path.join(generatedRoot, "current"));
  } catch {
    // Selection validation reports broken pointers when a consumer enters.
  }
  for (const name of fs.readdirSync(generationsRoot)) {
    const candidate = path.join(generationsRoot, name);
    if (candidate === current || fs.existsSync(path.join(candidate, ".selected"))) continue;
    let ownerPid;
    try {
      ownerPid = JSON.parse(fs.readFileSync(path.join(candidate, identityFile), "utf8")).ownerPid;
    } catch {
      malformed.push(candidate);
      continue;
    }
    if (!Number.isInteger(ownerPid)) {
      malformed.push(candidate);
    } else if (!processIsAlive(ownerPid)) {
      fs.rmSync(candidate, { recursive: true, force: true });
    }
  }
  if (malformed.length > 0) {
    const shown = malformed.slice(0, 3);
    throw new Error(`generated-output state has unknown ownership: ${shown.join(", ")}${malformed.length > shown.length ? ` (${malformed.length - shown.length} more)` : ""}; correction: preserve it for inspection before removal`);
  }
}

export function selectGeneratedGeneration(root) {
  const current = path.join(root, generatedDirectory, "current");
  let stat;
  try {
    stat = fs.lstatSync(current);
  } catch {
    throw new Error(`generated-output current selection is missing at ${current}; correction: run pnpm -C packages/cli build`);
  }
  if (!stat.isSymbolicLink()) {
    throw new Error(`generated-output current selection is not a symbolic link at ${current}; correction: preserve it for inspection and rerun build`);
  }
  let selected;
  try {
    selected = fs.realpathSync(current);
  } catch (error) {
    throw new Error(`generated-output current selection is broken at ${current}: ${error.message}; correction: rerun build`);
  }
  const id = readIdentity(path.join(selected, identityFile), "generation");
  return validateGeneration(selected, id);
}

export function publishGeneratedGeneration(root, stagedRoot, generationId, options = {}) {
  rejectLegacyRecoveryResidue(root);
  validateGeneration(stagedRoot, generationId);
  if (options.faultAt === "after-validation") throw new Error("injected interruption at after-validation");

  const generatedRoot = path.join(root, generatedDirectory);
  const generationsRoot = path.join(generatedRoot, "generations");
  fs.mkdirSync(generationsRoot, { recursive: true });
  const generationRoot = path.join(generationsRoot, generationId);
  fs.renameSync(stagedRoot, generationRoot);
  if (options.faultAt === "after-generation-rename") throw new Error("injected interruption at after-generation-rename");

  options.onBeforePointer?.();
  if (options.holdBeforePointerMs) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, options.holdBeforePointerMs);
  }
  const temporaryPointer = path.join(generatedRoot, `.current-${generationId}`);
  fs.symlinkSync(path.relative(generatedRoot, generationRoot), temporaryPointer, "dir");
  fs.renameSync(temporaryPointer, path.join(generatedRoot, "current"));
  if (options.faultAt === "after-pointer") throw new Error("injected interruption at after-pointer");
  fs.writeFileSync(path.join(generationRoot, ".selected"), "selected\n");
  return selectGeneratedGeneration(root);
}

function construct(outputRoot) {
  const distRoot = path.join(outputRoot, "dist");
  const bundleRoot = path.join(outputRoot, "bundle");
  const dependencies = path.join(outputRoot, "node_modules");
  fs.mkdirSync(outputRoot, { recursive: true });
  if (!fs.existsSync(path.join(outputRoot, "package.json"))) {
    fs.copyFileSync(path.join(packageRoot, "package.json"), path.join(outputRoot, "package.json"));
  }
  const createdDependencyLink = !fs.existsSync(dependencies);
  if (createdDependencyLink) fs.symlinkSync(path.join(packageRoot, "node_modules"), dependencies, "dir");
  try {
    run("pnpm", ["exec", "tsc", "-p", "tsconfig.json", "--outDir", distRoot]);
    run(process.execPath, ["scripts/copy-bundle.mjs", "--dist-root", distRoot, "--bundle-root", bundleRoot]);
  } finally {
    if (createdDependencyLink) fs.rmSync(dependencies, { force: true });
  }
}

function launcherSource() {
  return `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const current = path.join(packageRoot, ".agentera-generated/current");
const selected = fs.realpathSync(current);
const identities = ["", "dist", "bundle"].map((surface) => {
  const file = path.join(selected, surface, ".agentera-generation.json");
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value?.schemaVersion !== "agentera.generatedGeneration.v1" || typeof value?.id !== "string") {
    throw new Error(\`invalid generated-output identity at \${file}; rerun pnpm -C packages/cli build\`);
  }
  return value.id;
});
if (new Set(identities).size !== 1) throw new Error("generated-output identities disagree; rerun pnpm -C packages/cli build");
await import(pathToFileURL(path.join(selected, "dist/bin/agentera.js")).href);
`;
}

function installCompatibilityLauncher(root) {
  const dist = path.join(root, "dist");
  const expected = launcherSource();
  const existing = path.join(dist, "bin", "agentera.js");
  if (fs.existsSync(existing) && fs.readFileSync(existing, "utf8") === expected) return;
  const staged = path.join(root, `.agentera-launcher-${randomUUID()}`);
  fs.mkdirSync(path.join(staged, "bin"), { recursive: true });
  fs.writeFileSync(path.join(staged, "bin", "agentera.js"), expected, { mode: 0o755 });
  const legacy = path.join(root, `.agentera-legacy-dist-${randomUUID()}`);
  if (fs.existsSync(dist)) fs.renameSync(dist, legacy);
  fs.renameSync(staged, dist);
  fs.rmSync(legacy, { recursive: true, force: true });
  fs.rmSync(path.join(root, "bundle"), { recursive: true, force: true });
}

function main() {
  const outputIndex = process.argv.indexOf("--output-root");
  if (outputIndex >= 0) {
    const outputRoot = process.argv[outputIndex + 1];
    if (!outputRoot) throw new Error("--output-root requires a path");
    construct(path.resolve(outputRoot));
    return;
  }
  waitForVerificationBarrier();
  const generationId = randomUUID();
  const generatedRoot = path.join(packageRoot, generatedDirectory);
  fs.mkdirSync(generatedRoot, { recursive: true });
  cleanupGeneratedState(packageRoot);
  const stagedRoot = path.join(generatedRoot, `.staging-${process.pid}-${generationId}`);
  try {
    construct(stagedRoot);
    writeGenerationIdentity(stagedRoot, generationId);
    publishGeneratedGeneration(packageRoot, stagedRoot, generationId);
    installCompatibilityLauncher(packageRoot);
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
