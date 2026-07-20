#!/usr/bin/env node
/**
 * Stage the registry-declared Agentera data bundle used by the compiled CLI.
 * PackageRegistry is the one executable contract for directory/file values,
 * shape, uniqueness, and path syntax. This script adds filesystem containment
 * checks, then performs the already-validated copy plan.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildExtractCorpusParityManifest } from "../dist/analytics/extractCorpus/extractCorpusParity.js";
import { loadRegistry } from "../dist/registries/packageRegistry.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const repoRoot = path.resolve(pkgRoot, "..", "..");
const bundleRoot = path.join(pkgRoot, "bundle");
const registryPath = path.join(repoRoot, "references/adapters/package-registry.yaml");
const SKIP_PARTS = new Set(["__pycache__", ".pytest_cache", "node_modules"]);
const SKIP_SUFFIXES = new Set([".pyc", ".pyo"]);

function abort(message) {
  console.error(`copy-bundle: ${message}`);
  process.exit(1);
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function shouldSkip(name) {
  if (SKIP_PARTS.has(name)) return true;
  for (const suffix of SKIP_SUFFIXES) {
    if (name.endsWith(suffix)) return true;
  }
  return false;
}

function runExtractCorpusParityCheck() {
  const generator = path.join(here, "generate-extract-corpus-parity.mjs");
  if (!fs.existsSync(generator)) return;
  const result = spawnSync(process.execPath, [generator], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function loadBundleEntries() {
  try {
    const record = loadRegistry(registryPath, repoRoot).get("agentera");
    return {
      directories: record.bundle_surfaces.directories,
      files: record.bundle_surfaces.files,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    abort(`${detail}; correction: fix ${registryPath} and rerun package construction`);
  }
}

function preflight(entries) {
  let repoRootReal;
  let pkgRootReal;
  try {
    repoRootReal = fs.realpathSync(repoRoot);
    pkgRootReal = fs.realpathSync(pkgRoot);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    abort(`cannot resolve package roots: ${detail}; correction: restore the repository checkout`);
  }

  if (!inside(pkgRoot, bundleRoot)) {
    abort(`bundle root ${JSON.stringify(bundleRoot)} escapes package root; correction: restore packages/cli/bundle`);
  }
  if (fs.existsSync(bundleRoot)) {
    const bundleStat = fs.lstatSync(bundleRoot);
    if (bundleStat.isSymbolicLink()) {
      abort(`bundle root ${JSON.stringify(bundleRoot)} is a symlink; correction: replace it with an in-package directory`);
    }
    const bundleReal = fs.realpathSync(bundleRoot);
    if (!inside(pkgRootReal, bundleReal)) {
      abort(`bundle root ${JSON.stringify(bundleRoot)} resolves outside package root; correction: restore packages/cli/bundle`);
    }
  }

  const directories = new Set();
  const files = [];
  const destinations = new Map();

  const sourceLabel = (entry, declaredPath = entry.path) =>
    `id ${JSON.stringify(entry.id)} path ${JSON.stringify(declaredPath)}`;

  const resolveSource = (entry, declaredPath, expectedKind) => {
    const source = path.resolve(repoRoot, declaredPath);
    if (!inside(repoRoot, source)) {
      abort(`source ${sourceLabel(entry, declaredPath)} escapes source root; correction: use a normalized relative POSIX path`);
    }
    if (inside(bundleRoot, source)) {
      abort(`source ${sourceLabel(entry, declaredPath)} is inside the generated bundle; correction: declare a source outside packages/cli/bundle`);
    }
    let stat;
    let real;
    try {
      stat = fs.statSync(source);
      real = fs.realpathSync(source);
    } catch {
      abort(`source ${sourceLabel(entry, declaredPath)} is missing; correction: restore the declared ${expectedKind}`);
    }
    if (!inside(repoRootReal, real)) {
      abort(`source ${sourceLabel(entry, declaredPath)} resolves outside source root; correction: replace the escaping symlink with an in-root source`);
    }
    if (expectedKind === "directory" && !stat.isDirectory()) {
      abort(`source ${sourceLabel(entry, declaredPath)} is not a directory; correction: point the registry entry at an in-root directory`);
    }
    if (expectedKind === "file" && !stat.isFile()) {
      abort(`source ${sourceLabel(entry, declaredPath)} is not a file; correction: point the registry entry at an in-root file`);
    }
    return source;
  };

  const reserveDestination = (entry, declaredPath, destination, kind) => {
    if (!inside(bundleRoot, destination)) {
      abort(`destination ${sourceLabel(entry, declaredPath)} escapes bundle root; correction: use a normalized relative POSIX path`);
    }
    const previous = destinations.get(destination);
    if (previous !== undefined) {
      abort(
        `destination ${sourceLabel(entry, declaredPath)} duplicates ${previous}; ` +
        "correction: give every copied source a unique bundle destination",
      );
    }
    destinations.set(destination, sourceLabel(entry, declaredPath));
    if (kind === "directory") directories.add(destination);
  };

  const inspectDirectory = (entry, source, destination, declaredPath) => {
    reserveDestination(entry, declaredPath, destination, "directory");
    const children = fs.readdirSync(source, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (shouldSkip(child.name)) continue;
      const childSource = path.join(source, child.name);
      const childDestination = path.join(destination, child.name);
      const childDeclaredPath = path.posix.join(declaredPath, child.name);
      let childReal;
      try {
        childReal = fs.realpathSync(childSource);
      } catch {
        abort(`source ${sourceLabel(entry, childDeclaredPath)} cannot be resolved; correction: restore or remove the broken source entry`);
      }
      if (!inside(repoRootReal, childReal)) {
        abort(`source ${sourceLabel(entry, childDeclaredPath)} resolves outside source root; correction: replace the escaping symlink with an in-root source`);
      }
      if (child.isSymbolicLink()) continue;
      if (child.isDirectory()) {
        inspectDirectory(entry, childSource, childDestination, childDeclaredPath);
      } else if (child.isFile()) {
        reserveDestination(entry, childDeclaredPath, childDestination, "file");
        files.push({ source: childSource, destination: childDestination });
      }
    }
  };

  for (const entry of entries.directories) {
    const source = resolveSource(entry, entry.path, "directory");
    const destination = path.resolve(bundleRoot, entry.path);
    inspectDirectory(entry, source, destination, entry.path);
  }
  for (const entry of entries.files) {
    const source = resolveSource(entry, entry.path, "file");
    const destination = path.resolve(bundleRoot, entry.path);
    reserveDestination(entry, entry.path, destination, "file");
    files.push({ source, destination });
  }

  const generated = {
    marker: path.join(bundleRoot, ".agentera-npx-bundle.json"),
    parity: path.join(bundleRoot, "extract-corpus-parity.json"),
  };
  for (const [id, destination] of Object.entries(generated)) {
    reserveDestination({ id, path: path.basename(destination) }, path.basename(destination), destination, "file");
  }

  let suiteVersion = "unknown";
  try {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8"));
    suiteVersion = pkgJson?.agentera?.suiteVersion ?? pkgJson?.version ?? "unknown";
  } catch {
    // Preserve the existing unknown-version fallback; all paths are already preflighted.
  }
  const parityManifest = buildExtractCorpusParityManifest();
  runExtractCorpusParityCheck();
  return { directories, files, generated, suiteVersion, parityManifest };
}

const entries = loadBundleEntries();
const plan = preflight(entries);

fs.rmSync(bundleRoot, { recursive: true, force: true });
fs.mkdirSync(bundleRoot, { recursive: true });
for (const directory of [...plan.directories].sort((left, right) => left.length - right.length)) {
  fs.mkdirSync(directory, { recursive: true });
}
for (const operation of plan.files) {
  fs.mkdirSync(path.dirname(operation.destination), { recursive: true });
  fs.copyFileSync(operation.source, operation.destination);
}
fs.writeFileSync(
  plan.generated.marker,
  JSON.stringify({ kind: "agentera-npx-bundle", suiteVersion: plan.suiteVersion }, null, 2) + "\n",
);
fs.writeFileSync(plan.generated.parity, JSON.stringify(plan.parityManifest, null, 2) + "\n");

const copied = entries.directories.length + entries.files.length;
console.log(`copy-bundle: staged ${copied} data surfaces into ${path.relative(pkgRoot, bundleRoot)}/`);
