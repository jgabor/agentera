#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "../..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-package-construction-"));
const construction = path.join(temporary, "package");
const dryRun = process.argv.includes("--dry-run");
const publish = process.argv.includes("--publish");
const json = process.argv.includes("--json");
const outputIndex = process.argv.indexOf("--output-dir");
const outputDir = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1]) : packageRoot;

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status ?? "signal"}`);
  return result.stdout;
}

try {
  fs.mkdirSync(construction, { recursive: true });
  for (const file of ["package.json", "README.md"]) {
    fs.copyFileSync(path.join(packageRoot, file), path.join(construction, file));
  }
  fs.copyFileSync(path.join(repoRoot, "LICENSE"), path.join(construction, "LICENSE"));
  run(process.execPath, ["scripts/build-package.mjs", "--output-root", construction], packageRoot);
  if (dryRun) {
    process.stdout.write(run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], construction));
  } else {
    const manifest = JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary], construction));
    const entry = Array.isArray(manifest) ? manifest[0] : Object.values(manifest)[0];
    const tarball = path.join(temporary, entry.filename);
    if (publish) {
      const tagIndex = process.argv.indexOf("--tag");
      const tag = tagIndex >= 0 ? process.argv[tagIndex + 1] : "next";
      process.stdout.write(run("npm", ["publish", tarball, "--tag", tag], packageRoot));
    } else {
      const destination = path.join(outputDir, entry.filename);
      fs.mkdirSync(outputDir, { recursive: true });
      fs.copyFileSync(tarball, destination);
      console.log(json ? JSON.stringify(entry) : destination);
    }
  }
} catch (error) {
  console.error(`pack-package: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
