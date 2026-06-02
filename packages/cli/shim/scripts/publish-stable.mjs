#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const shimDir = resolve(__dirname, "..");
const pkgPath = resolve(shimDir, "package.json");
const original = readFileSync(pkgPath, "utf8");

let pkg;
try {
  pkg = JSON.parse(original);
} catch (exc) {
  console.error(`publish:stable: cannot parse package.json: ${exc.message}`);
  process.exit(1);
}

function restore() {
  writeFileSync(pkgPath, original);
  console.log("publish:stable: restored package.json after failure");
}

function fail(message, code = 1) {
  console.error(`publish:stable: ${message}`);
  restore();
  process.exit(code);
}

const runCapturing = (cmd, args) =>
  execFileSync(cmd, args, { encoding: "utf8" }).trim();
const runInheriting = (cmd, args, cwd) =>
  spawnSync(cmd, args, { cwd, stdio: "inherit", env: process.env });

const dirty = runCapturing("git", ["status", "--porcelain"]);
if (dirty) {
  fail(
    `working tree is dirty:\n${dirty}\nCommit or stash changes before publishing.`,
  );
}

console.log("publish:stable: running shim regression tests...");
const testResult = runInheriting("pnpm", ["-C", "..", "test", "test/shim/"]);
if (testResult.status !== 0) {
  fail(`tests failed (exit ${testResult.status ?? "signal"})`);
}

const commit = runCapturing("git", ["rev-parse", "HEAD"]);
const [major, minor, patch] = pkg.version.split(".").map(Number);
if ([major, minor, patch].some((n) => Number.isNaN(n))) {
  fail(`cannot parse current version: ${pkg.version}`);
}
const nextVersion = `${major}.${minor}.${patch + 1}`;

pkg.version = nextVersion;
pkg.agentera = pkg.agentera ?? {};
pkg.agentera.gitRef = commit;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log(
  `publish:stable: bumped version ${pkg.version} and set gitRef to ${commit.slice(0, 7)}`,
);

console.log("publish:stable: publishing to npm (default tag)...");
const publishResult = runInheriting("npm", ["publish"], shimDir);
if (publishResult.status !== 0) {
  fail(`npm publish failed (exit ${publishResult.status ?? "signal"})`);
}

console.log(
  `publish:stable: published agentera@${nextVersion}\n` +
    "publish:stable: package.json updated locally; commit the bump when ready.",
);
