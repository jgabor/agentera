#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  cleanupGeneratedState,
  generatedSourceIdentity,
  publishGeneratedGeneration,
  sameGeneratedSourceIdentity,
  validateRegularTree,
  withGeneratedStateLock,
  writeGeneratedSourceIdentity,
  writeGenerationIdentity,
  writeStagingOwner,
} from "./generated-output.mjs";
import { waitForVerificationBarrier } from "./verification-barrier.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const generatedDirectory = ".agentera-generated";

function run(command, args, cwd = packageRoot) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status ?? "signal"}`);
}

function construct(outputRoot, sourceIdentity) {
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
    run("pnpm", ["exec", "tsc", "-p", "tsconfig.json", "--outDir", distRoot, "--sourceMap", "false"]);
    fs.chmodSync(path.join(distRoot, "bin", "agentera.js"), 0o755);
    run(process.execPath, ["scripts/copy-bundle.mjs", "--dist-root", distRoot, "--bundle-root", bundleRoot]);
    writeGeneratedSourceIdentity(outputRoot, sourceIdentity);
    validateRegularTree(distRoot, "packaged dist surface");
    validateRegularTree(bundleRoot, "packaged bundle surface");
  } finally {
    if (createdDependencyLink) fs.rmSync(dependencies, { force: true });
  }
}

function requiredSourceIdentity() {
  const observed = generatedSourceIdentity(packageRoot);
  const supplied = process.env.AGENTERA_GENERATED_SOURCE_IDENTITY;
  if (supplied !== undefined) {
    let expected;
    try {
      expected = JSON.parse(supplied);
    } catch {
      throw new Error("AGENTERA_GENERATED_SOURCE_IDENTITY is malformed");
    }
    if (!sameGeneratedSourceIdentity(observed, expected)) {
      throw new Error("generated build source does not match the coordinator source identity");
    }
  }
  return observed;
}

function constructStableSource(outputRoot) {
  const before = requiredSourceIdentity();
  construct(outputRoot, before);
  const after = generatedSourceIdentity(packageRoot);
  if (!sameGeneratedSourceIdentity(before, after)) {
    throw new Error("generated build source changed during construction");
  }
  return before;
}

function launcherSource() {
  return `#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const protocol = await import(pathToFileURL(path.join(packageRoot, "scripts/generated-output.mjs")).href);
const selected = protocol.pinGeneratedGeneration(packageRoot);
process.once("exit", selected.release);
await import(pathToFileURL(path.join(selected.root, "dist/bin/agentera.js")).href);
`;
}

export function installCompatibilityLauncher(root) {
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
  if (process.argv.includes("--cleanup")) {
    const dryRun = process.argv.includes("--dry-run");
    if (!dryRun && !process.argv.includes("--force")) {
      throw new Error("generated cleanup requires --dry-run or --force; correction: run pnpm -C packages/cli run generated:cleanup -- --dry-run, then rerun with --force");
    }
    const result = cleanupGeneratedState(packageRoot, { dryRun });
    console.log(process.argv.includes("--json") ? JSON.stringify(result, null, 2) : `generated cleanup ${dryRun ? "preview" : "complete"}: ${result.removed.count} removed, ${result.retained.count} retained, ${result.preserved.count} preserved`);
    return;
  }
  const outputIndex = process.argv.indexOf("--output-root");
  if (outputIndex >= 0) {
    const outputRoot = process.argv[outputIndex + 1];
    if (!outputRoot) throw new Error("--output-root requires a path");
    constructStableSource(path.resolve(outputRoot));
    return;
  }
  waitForVerificationBarrier();
  const generationId = randomUUID();
  const generatedRoot = path.join(packageRoot, generatedDirectory);
  fs.mkdirSync(generatedRoot, { recursive: true });
  const recovery = cleanupGeneratedState(packageRoot);
  if (recovery.preserved.count > 0) {
    console.error(`build-package: preserved invalid current state for inspection at ${recovery.preserved.paths.join(", ")}${recovery.preserved.omitted > 0 ? ` (${recovery.preserved.omitted} more)` : ""}`);
  }
  const stagedRoot = path.join(generatedRoot, `.staging-${process.pid}-${generationId}`);
  try {
    writeStagingOwner(stagedRoot);
    const sourceIdentity = constructStableSource(stagedRoot);
    writeGenerationIdentity(stagedRoot, generationId, sourceIdentity);
    withGeneratedStateLock(packageRoot, () => {
      publishGeneratedGeneration(packageRoot, stagedRoot, generationId, { lockHeld: true });
      cleanupGeneratedState(packageRoot, { lockHeld: true });
      installCompatibilityLauncher(packageRoot);
    });
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
