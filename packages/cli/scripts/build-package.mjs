#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generatedSourceIdentity, sameGeneratedSourceIdentity, validateRegularTree, writeGeneratedSourceIdentity } from "./generated-output.mjs";
import { waitForVerificationBarrier } from "./verification-barrier.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");

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

export function synchronizeTree(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const sourceNames = new Set(fs.readdirSync(source));
  for (const name of fs.readdirSync(destination)) {
    if (!sourceNames.has(name)) fs.rmSync(path.join(destination, name), { recursive: true, force: true });
  }
  for (const name of sourceNames) {
    const from = path.join(source, name);
    const to = path.join(destination, name);
    const sourceStat = fs.lstatSync(from);
    const destinationStat = fs.existsSync(to) ? fs.lstatSync(to) : null;
    if (sourceStat.isDirectory()) {
      if (destinationStat && !destinationStat.isDirectory()) fs.rmSync(to, { recursive: true, force: true });
      synchronizeTree(from, to);
      continue;
    }
    const mode = sourceStat.mode & 0o777;
    const unchanged = destinationStat?.isFile() && (destinationStat.mode & 0o777) === mode && sourceStat.size === destinationStat.size && fs.readFileSync(from).equals(fs.readFileSync(to));
    if (unchanged) continue;
    if (destinationStat) fs.rmSync(to, { recursive: true, force: true });
    fs.copyFileSync(from, to);
    fs.chmodSync(to, mode);
  }
}

function main() {
  waitForVerificationBarrier();
  const outputIndex = process.argv.indexOf("--output-root");
  if (outputIndex >= 0) {
    const outputRoot = process.argv[outputIndex + 1];
    if (!outputRoot) throw new Error("--output-root requires a path");
    constructStableSource(path.resolve(outputRoot));
    return;
  }
  const stagedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-build-"));
  try {
    constructStableSource(stagedRoot);
    synchronizeTree(path.join(stagedRoot, "dist"), path.join(packageRoot, "dist"));
    synchronizeTree(path.join(stagedRoot, "bundle"), path.join(packageRoot, "bundle"));
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
