#!/usr/bin/env node
/**
 * Copy the Agentera app-data surfaces the TypeScript CLI reads at runtime into
 * packages/cli/bundle/ so the published npm package is self-contained: npx
 * agentera then works with no repo checkout and no AGENTERA_HOME, reading
 * skills/, references/, and registry.json from the bundled data directory.
 *
 * This intentionally bundles only DATA (no Python). The data set mirrors the
 * source-root-relative paths resolved by resolveSourceRoot()/appContext:
 *   - skills/        (SKILL.md, protocol.yaml, capability_schema_contract.yaml,
 *                     capabilities/*, schemas/*)
 *   - references/    (artifact-registry interface model + reference paths)
 *   - registry.json  (artifact registry at the source root)
 *
 * D65: per-capability instructions.md files are no longer copied because
 * they do not exist on disk. The per-capability prose ships via the
 * compiled dist/capabilities/[name]/instructions.js modules that tsc emits
 * alongside the rest of the TypeScript surface. The runtime loader
 * imports the compiled .js path from ../capabilities/index.js; the
 * source packages/cli/src/capabilities/[name]/instructions.ts files
 * are bundled into dist/ by the build script before copy-bundle.mjs
 * runs in prepack. The skills/ directory still carries the
 * capability schemas/[wildcard].yaml files because the capability validator
 * and routing still need them.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const repoRoot = path.resolve(pkgRoot, "..", "..");
const bundleRoot = path.join(pkgRoot, "bundle");

const DIRS = ["skills", "references"];
const FILES = ["registry.json"];
const SKIP_PARTS = new Set(["__pycache__", ".pytest_cache", "node_modules"]);
const SKIP_SUFFIXES = new Set([".pyc", ".pyo"]);

function shouldSkip(name) {
  if (SKIP_PARTS.has(name)) return true;
  for (const suffix of SKIP_SUFFIXES) {
    if (name.endsWith(suffix)) return true;
  }
  return false;
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (shouldSkip(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

fs.rmSync(bundleRoot, { recursive: true, force: true });
fs.mkdirSync(bundleRoot, { recursive: true });

let copied = 0;
for (const dir of DIRS) {
  const src = path.join(repoRoot, dir);
  if (fs.existsSync(src) && fs.statSync(src).isDirectory()) {
    copyDir(src, path.join(bundleRoot, dir));
    copied += 1;
  } else {
    console.error(`copy-bundle: missing data directory ${dir} at ${src}`);
    process.exit(1);
  }
}
for (const file of FILES) {
  const src = path.join(repoRoot, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(bundleRoot, file));
    copied += 1;
  } else {
    console.error(`copy-bundle: missing data file ${file} at ${src}`);
    process.exit(1);
  }
}

// Sentinel marking this directory as a self-contained npx app bundle so the
// CLI's app-model resolver treats it as the authoritative app home (see
// appContext.isNpxBundle). Never present in a repo checkout or installed app.
let suiteVersion = "unknown";
try {
  const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8"));
  suiteVersion = pkgJson?.agentera?.suiteVersion ?? pkgJson?.version ?? "unknown";
} catch {
  /* keep default */
}
fs.writeFileSync(
  path.join(bundleRoot, ".agentera-npx-bundle.json"),
  JSON.stringify({ kind: "agentera-npx-bundle", suiteVersion }, null, 2) + "\n",
);

console.log(`copy-bundle: staged ${copied} data surfaces into ${path.relative(pkgRoot, bundleRoot)}/`);
