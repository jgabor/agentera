#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatConstruction,
  normalizeConstruction,
  npmChildEnvironment,
} from "./package-construction.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "../..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-package-construction-"));
const construction = path.join(temporary, "package");
const npmrc = path.join(temporary, "npmrc");
const globalNpmrc = path.join(temporary, "global-npmrc");
const dryRun = process.argv.includes("--dry-run");
const json = process.argv.includes("--json");
const verbose = process.argv.includes("--verbose");
const outputIndex = process.argv.indexOf("--output-dir");
const outputDir = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1]) : packageRoot;

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: npmChildEnvironment(process.env, npmrc),
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status ?? "signal"}`);
  return result.stdout;
}

function npmPack(args, cwd) {
  const result = spawnSync("npm", [...args, "--json"], {
    cwd,
    encoding: "utf8",
    env: npmChildEnvironment(process.env, npmrc, globalNpmrc),
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  const parsed = JSON.parse(result.stdout);
  const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  const warnings = result.stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return { entry, warnings };
}

try {
  fs.writeFileSync(npmrc, "", { mode: 0o600, flag: "wx" });
  fs.writeFileSync(globalNpmrc, "", { mode: 0o600, flag: "wx" });
  fs.mkdirSync(construction, { recursive: true });
  for (const file of ["package.json", "README.md"]) {
    fs.copyFileSync(path.join(packageRoot, file), path.join(construction, file));
  }
  fs.copyFileSync(path.join(repoRoot, "LICENSE"), path.join(construction, "LICENSE"));
  run(process.execPath, ["scripts/build-package.mjs", "--output-root", construction], packageRoot);
  const expected = JSON.parse(fs.readFileSync(path.join(construction, "package.json"), "utf8"));
  const expectedTag = expected.publishConfig?.tag ?? "next";
  if (dryRun) {
    const { entry, warnings } = npmPack(["pack", "--dry-run", "--ignore-scripts"], construction);
    const result = normalizeConstruction(entry, {
      expectedName: expected.name,
      expectedVersion: expected.version,
      expectedTag,
      warnings,
    });
    process.stdout.write(
      `${formatConstruction(result, json ? "json" : verbose ? "verbose" : "default")}\n`,
    );
  } else {
    const { entry, warnings } = npmPack(
      ["pack", "--ignore-scripts", "--pack-destination", temporary],
      construction,
    );
    const tarball = path.join(temporary, entry.filename);
    const destination = path.join(outputDir, entry.filename);
    const result = normalizeConstruction(entry, {
      expectedName: expected.name,
      expectedVersion: expected.version,
      expectedTag,
      artifact: destination,
      warnings,
    });
    fs.mkdirSync(outputDir, { recursive: true });
    if (fs.existsSync(destination)) {
      throw new Error(
        `package artifact already exists at ${destination}; move or remove it and retry`,
      );
    }
    try {
      fs.copyFileSync(tarball, destination, fs.constants.COPYFILE_EXCL);
      console.log(formatConstruction(result, json ? "json" : verbose ? "verbose" : "default"));
    } catch (error) {
      fs.rmSync(destination, { force: true });
      throw error;
    }
  }
} catch (error) {
  console.error(`pack-package: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
