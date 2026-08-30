#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseReleaseFlags } from "./release-arguments.mjs";
import {
  formatConstruction,
  normalizeConstruction,
  npmChildEnvironment,
} from "./package-construction.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "../..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-package-construction-"));
const construction = path.join(temporary, "package");
const home = path.join(temporary, "home");
const cache = path.join(temporary, "cache");
const npmrc = path.join(temporary, "npmrc");
const globalNpmrc = path.join(temporary, "global-npmrc");
const flags = parseReleaseFlags(process.argv.slice(2), {
  boolean: ["--dry-run", "--with-dry-run", "--json", "--verbose"],
  value: ["--output-dir", "--git-ref", "--package-version"],
});
const dryRun = flags.has("--dry-run");
const withDryRun = flags.has("--with-dry-run");
const json = flags.has("--json");
const verbose = flags.has("--verbose");
const outputDir = flags.has("--output-dir") ? path.resolve(flags.get("--output-dir")) : packageRoot;
const gitRef = flags.get("--git-ref");
const packageVersion = flags.get("--package-version");

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: npmEnvironment(),
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
    env: npmEnvironment(),
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

function npmEnvironment() {
  return {
    ...npmChildEnvironment(process.env, npmrc, globalNpmrc),
    HOME: home,
    XDG_CONFIG_HOME: path.join(temporary, "config"),
    NPM_CONFIG_CACHE: cache,
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
  };
}

try {
  if (withDryRun && (dryRun || !flags.has("--output-dir") || !json)) {
    throw new Error("--with-dry-run requires --output-dir and --json, and cannot be combined with --dry-run");
  }
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  fs.writeFileSync(npmrc, "", { mode: 0o600, flag: "wx" });
  fs.writeFileSync(globalNpmrc, "", { mode: 0o600, flag: "wx" });
  fs.mkdirSync(construction, { recursive: true });
  for (const file of ["package.json", "README.md"]) {
    fs.copyFileSync(path.join(packageRoot, file), path.join(construction, file));
  }
  if (packageVersion !== undefined && gitRef === undefined) {
    throw new Error("--package-version requires --git-ref");
  }
  if (gitRef !== undefined) {
    if (!/^[0-9a-f]{40}$/.test(gitRef)) {
      throw new Error("--git-ref must be a 40-character lowercase commit SHA");
    }
    const manifestPath = path.join(construction, "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (!/^3\.0\.0-dev\.(?:0|[1-9]\d*)$/.test(manifest.version)) {
      throw new Error("package manifest version must match 3.0.0-dev.N");
    }
    if (packageVersion !== undefined) {
      if (!/^3\.0\.0-dev\.(?:0|[1-9]\d*)$/.test(packageVersion)) {
        throw new Error("--package-version must match 3.0.0-dev.N on the package manifest base line");
      }
      manifest.version = packageVersion;
    }
    manifest.agentera = { ...manifest.agentera, gitRef };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  fs.copyFileSync(path.join(repoRoot, "LICENSE"), path.join(construction, "LICENSE"));
  run(process.execPath, ["scripts/build-package.mjs", "--output-root", construction], packageRoot);
  const expected = JSON.parse(fs.readFileSync(path.join(construction, "package.json"), "utf8"));
  const expectedTag = expected.publishConfig?.tag ?? "next";
  if (withDryRun) {
    const { entry: dryEntry, warnings: dryWarnings } = npmPack(
      ["pack", "--dry-run", "--ignore-scripts"],
      construction,
    );
    const dry = normalizeConstruction(dryEntry, {
      expectedName: expected.name,
      expectedVersion: expected.version,
      expectedTag,
      warnings: dryWarnings,
    });
    const destination = path.join(outputDir, dryEntry.filename);
    if (fs.existsSync(destination)) {
      throw new Error(
        `package artifact already exists at ${destination}; move or remove it and retry`,
      );
    }
    const { entry, warnings } = npmPack(
      ["pack", "--ignore-scripts", "--pack-destination", temporary],
      construction,
    );
    const tarball = path.join(temporary, entry.filename);
    const packedDestination = path.join(outputDir, entry.filename);
    const packed = normalizeConstruction(entry, {
      expectedName: expected.name,
      expectedVersion: expected.version,
      expectedTag,
      artifact: packedDestination,
      warnings,
    });
    fs.mkdirSync(outputDir, { recursive: true });
    try {
      fs.copyFileSync(tarball, packedDestination, fs.constants.COPYFILE_EXCL);
      process.stdout.write(`${JSON.stringify({ dry, packed })}\n`);
    } catch (error) {
      fs.rmSync(packedDestination, { force: true });
      throw error;
    }
  } else if (dryRun) {
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
