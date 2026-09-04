#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

import YAML from "yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DIR = path.join(ROOT, "packages/cli/test/evidence/all-test-typecheck-replay");
const EVIDENCE_PATH = path.join(
  ROOT,
  "packages/cli/test/fixtures/all-test-typecheck-viability.yaml",
);
const VERIFIER_PATH = fileURLToPath(import.meta.url);
const VERIFIER_RELATIVE_PATH = path.relative(ROOT, VERIFIER_PATH).split(path.sep).join("/");
const COMMAND = [
  "vp",
  "lint",
  "src",
  "test",
  "--type-aware",
  "--type-check",
  "--tsconfig",
  "tsconfig.json",
  "--format=json",
];
const CANONICALIZER_VERSION = "agentera.compilerDiagnosticsCanonicalizer.v1";
const NORMALIZATION_POLICY = {
  selection:
    "Keep only diagnostics whose code exactly matches typescript(TS<digits>); non-TypeScript lint diagnostics and top-level lint/runtime telemetry are outside this compiler-evidence artifact.",
  disposablePaths:
    "Replace only the exact isolated work-root string supplied to the canonicalizer with <DISPOSABLE_WORK_ROOT>; perform no general absolute-path normalization.",
  diagnosticFields:
    "Preserve every field and value of each selected diagnostic; only unwrap its code from typescript(TS<digits>) to TS<digits>.",
  ordering:
    "Recursively sort object keys and sort diagnostics by their complete canonical JSON; preserve array order inside each diagnostic.",
};
const CLASSIFICATIONS = {
  "classifications/valid.ts": [],
  "classifications/intentional-invalid.ts": ["TS2353"],
  "classifications/genuine-defect.ts": ["TS18047"],
};
const INPUTS = [
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "source-binding.json",
  "compiler.raw.json.gz",
  "compiler.normalized.json",
  ...Object.keys(CLASSIFICATIONS),
];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value) => `${JSON.stringify(value, null, 2)}\n`;
const readAt = (directory, name) => fs.readFileSync(path.join(directory, name));
const fail = (message) => {
  throw new Error(`all-test typecheck replay: ${message}`);
};

function sourceBinding() {
  const files = [];
  for (const base of ["packages/cli/src", "packages/cli/test", "packages/cli/scripts"]) {
    const visit = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (absolute !== DIR) visit(absolute);
        } else if (/\.(?:ts|mjs)$/.test(entry.name)) {
          files.push({
            path: path.relative(ROOT, absolute),
            sha256: sha256(fs.readFileSync(absolute)),
          });
        }
      }
    };
    visit(path.join(ROOT, base));
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function run(command, options) {
  const result = spawnSync(command[0], command.slice(1), {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  });
  if (result.error) fail(`${command[0]} unavailable: ${result.error.message}`);
  return result;
}

function stableValue(value, disposableWorkRoot) {
  if (typeof value === "string")
    return value.split(disposableWorkRoot).join("<DISPOSABLE_WORK_ROOT>");
  if (Array.isArray(value)) return value.map((item) => stableValue(item, disposableWorkRoot));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item, disposableWorkRoot)]),
    );
  }
  return value;
}

function canonicalizeCompilerOutput(raw, disposableWorkRoot) {
  if (!path.isAbsolute(disposableWorkRoot) || !raw.includes(disposableWorkRoot))
    fail("raw output lacks its bound disposable work root");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.diagnostics)) fail("raw output lacks diagnostics");
  const diagnostics = parsed.diagnostics
    .filter(({ code }) => /^typescript\(TS\d+\)$/.test(code))
    .map((diagnostic) =>
      stableValue({ ...diagnostic, code: diagnostic.code.slice(11, -1) }, disposableWorkRoot),
    )
    .sort((left, right) => canonical(left).localeCompare(canonical(right)));
  const byCode = {};
  const byFile = {};
  for (const diagnostic of diagnostics) {
    byCode[diagnostic.code] = (byCode[diagnostic.code] ?? 0) + 1;
    byFile[diagnostic.filename] = (byFile[diagnostic.filename] ?? 0) + 1;
  }
  return {
    total: diagnostics.length,
    files: Object.keys(byFile).length,
    source: diagnostics.filter(({ filename }) => filename.startsWith("src/")).length,
    test: diagnostics.filter(({ filename }) => filename.startsWith("test/")).length,
    byCode: Object.fromEntries(Object.entries(byCode).sort()),
    byFile: Object.fromEntries(Object.entries(byFile).sort()),
    diagnostics,
  };
}

function isolatedReplay(directory = DIR) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-type-replay-"));
  try {
    const work = path.join(sandbox, "work");
    fs.mkdirSync(work);
    fs.cpSync(path.join(ROOT, "packages/cli/src"), path.join(work, "src"), { recursive: true });
    fs.cpSync(path.join(ROOT, "packages/cli/scripts"), path.join(work, "scripts"), {
      recursive: true,
    });
    fs.cpSync(path.join(ROOT, "packages/cli/test"), path.join(work, "test"), {
      recursive: true,
      filter: (source) => !source.startsWith(DIR),
    });
    for (const name of ["package.json", "pnpm-lock.yaml", "tsconfig.json"])
      fs.copyFileSync(path.join(directory, name), path.join(work, name));
    const env = {
      ...process.env,
      HOME: path.join(sandbox, "home"),
      XDG_CACHE_HOME: path.join(sandbox, "cache"),
      npm_config_cache: path.join(sandbox, "npm-cache"),
      PNPM_HOME: path.join(sandbox, "pnpm-home"),
    };
    const install = run(
      [
        "pnpm",
        "install",
        "--ignore-workspace",
        "--frozen-lockfile",
        "--store-dir",
        path.join(sandbox, "store"),
      ],
      { cwd: work, env },
    );
    if (install.status !== 0) fail(`isolated install failed\n${install.stdout}${install.stderr}`);
    const measurement = run([path.join(work, "node_modules/.bin/vp"), ...COMMAND.slice(1)], {
      cwd: work,
      env,
    });
    if (!measurement.stdout.trim().startsWith("{"))
      fail(`measurement produced no JSON\n${measurement.stdout}${measurement.stderr}`);
    const classifications = {};
    for (const [name, expected] of Object.entries(CLASSIFICATIONS)) {
      const result = run(
        [
          path.join(work, "node_modules/.bin/tsc6"),
          "--ignoreConfig",
          "--noEmit",
          "--strict",
          "--skipLibCheck",
          "--module",
          "NodeNext",
          "--moduleResolution",
          "NodeNext",
          "--target",
          "ES2023",
          path.join(directory, name),
        ],
        { cwd: work, env },
      );
      const codes = [...result.stdout.matchAll(/error (TS\d+):/g)].map((match) => match[1]);
      if (canonical(codes) !== canonical(expected))
        fail(`classification mismatch: ${name} expected ${expected}, got ${codes}`);
      classifications[name] = codes;
    }
    return { raw: measurement.stdout, disposableWorkRoot: work, classifications };
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

function manifestDigest(manifest) {
  const copy = structuredClone(manifest);
  delete copy.manifestSha256;
  return sha256(canonical(copy));
}

function selectedIntegrities(lock) {
  const packages = lock.packages ?? {};
  const wanted = [
    "vite-plus@0.3.0",
    "vite@8.2.2",
    "vitest@4.1.11",
    "oxlint@1.79.0",
    "oxfmt@0.64.0",
    "@typescript/typescript6@6.0.2",
  ];
  return Object.fromEntries(
    wanted.map((name) => {
      const key = Object.keys(packages).find(
        (candidate) =>
          candidate.replace(/^\//, "").startsWith(`${name}(`) ||
          candidate.replace(/^\//, "") === name,
      );
      if (!key || !packages[key]?.resolution?.integrity)
        fail(`lockfile lacks integrity for ${name}`);
      return [name, packages[key].resolution.integrity];
    }),
  );
}

export function verifyEvidence({ replay = true, directory = DIR } = {}) {
  const errors = [];
  try {
    const read = (name) => readAt(directory, name);
    const manifest = JSON.parse(read("manifest.json"));
    if (manifest.schemaVersion !== "agentera.allTestTypecheckReplay.v1")
      fail("unsupported manifest schema");
    if (manifest.manifestSha256 !== manifestDigest(manifest)) fail("manifest digest mismatch");
    if (read("manifest.sha256").toString().trim() !== manifest.manifestSha256)
      fail("detached manifest digest mismatch");
    if (canonical(manifest.command) !== canonical(COMMAND)) fail("exact command mismatch");
    if (
      manifest.normalization?.canonicalizer?.version !== CANONICALIZER_VERSION ||
      manifest.normalization.canonicalizer.path !== VERIFIER_RELATIVE_PATH ||
      manifest.normalization.canonicalizer.sha256 !== sha256(fs.readFileSync(VERIFIER_PATH))
    )
      fail("canonicalizer binding mismatch");
    if (canonical(manifest.normalization?.policy) !== canonical(NORMALIZATION_POLICY))
      fail("normalization policy mismatch");
    for (const name of INPUTS)
      if (sha256(read(name)) !== manifest.inputs[name]) fail(`input digest mismatch: ${name}`);
    if (sha256(read("compiler.raw.json.gz")) !== manifest.rawGzipSha256)
      fail("raw gzip binding mismatch");
    if (sha256(read("compiler.normalized.json")) !== manifest.normalizedSha256)
      fail("normalized output binding mismatch");
    if (canonical(JSON.parse(read("source-binding.json"))) !== canonical(sourceBinding()))
      fail("source binding mismatch");
    const lock = YAML.parse(read("pnpm-lock.yaml").toString());
    if (canonical(selectedIntegrities(lock)) !== canonical(manifest.toolIntegrities))
      fail("tool version or integrity mismatch");
    const normalizedText = read("compiler.normalized.json").toString();
    const normalized = JSON.parse(normalizedText);
    let trackedRaw;
    try {
      trackedRaw = gunzipSync(read("compiler.raw.json.gz")).toString("utf8");
    } catch {
      fail("tracked raw gzip is not decodable");
    }
    if (
      canonical(
        canonicalizeCompilerOutput(trackedRaw, manifest.normalization.trackedDisposableWorkRoot),
      ) !== normalizedText
    )
      fail("tracked raw compiler output mismatch");
    const evidence = YAML.parse(fs.readFileSync(EVIDENCE_PATH, "utf8"));
    if (
      evidence.outcome !== "source-only-retain" ||
      evidence.measurement.manifest_sha256 !== manifest.manifestSha256
    )
      fail("downstream outcome or manifest binding mismatch");
    if (
      canonical(evidence.measurement.compiler_diagnostics) !==
      canonical({
        total: normalized.total,
        files: normalized.files,
        source: normalized.source,
        test: normalized.test,
        by_code: normalized.byCode,
      })
    )
      fail("evidence totals differ from retained output");
    if (replay) {
      const actual = isolatedReplay(directory);
      if (
        canonical(canonicalizeCompilerOutput(actual.raw, actual.disposableWorkRoot)) !==
        normalizedText
      )
        fail("isolated compiler output mismatch");
      if (canonical(actual.classifications) !== canonical(manifest.classifications))
        fail("compiled classifications differ");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors;
}

function generate() {
  fs.writeFileSync(path.join(DIR, "source-binding.json"), canonical(sourceBinding()));
  const result = isolatedReplay();
  fs.writeFileSync(
    path.join(DIR, "compiler.raw.json.gz"),
    gzipSync(result.raw.endsWith("\n") ? result.raw : `${result.raw}\n`, { mtime: 0 }),
  );
  const normalized = canonicalizeCompilerOutput(result.raw, result.disposableWorkRoot);
  fs.writeFileSync(path.join(DIR, "compiler.normalized.json"), canonical(normalized));
  const lock = YAML.parse(readAt(DIR, "pnpm-lock.yaml").toString());
  const manifest = {
    schemaVersion: "agentera.allTestTypecheckReplay.v1",
    command: COMMAND,
    packageManager: "pnpm@10.30.3",
    node: process.version,
    toolIntegrities: selectedIntegrities(lock),
    inputs: Object.fromEntries(INPUTS.map((name) => [name, sha256(readAt(DIR, name))])),
    normalization: {
      canonicalizer: {
        version: CANONICALIZER_VERSION,
        path: VERIFIER_RELATIVE_PATH,
        sha256: sha256(fs.readFileSync(VERIFIER_PATH)),
      },
      policy: NORMALIZATION_POLICY,
      trackedDisposableWorkRoot: result.disposableWorkRoot,
    },
    rawGzipSha256: sha256(readAt(DIR, "compiler.raw.json.gz")),
    normalizedSha256: sha256(readAt(DIR, "compiler.normalized.json")),
    classifications: result.classifications,
  };
  manifest.manifestSha256 = manifestDigest(manifest);
  fs.writeFileSync(path.join(DIR, "manifest.json"), canonical(manifest));
  fs.writeFileSync(path.join(DIR, "manifest.sha256"), `${manifest.manifestSha256}\n`);
  console.log(
    `generated ${manifest.manifestSha256}: ${normalized.total} diagnostics across ${normalized.files} files`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--generate")) generate();
  else {
    const errors = verifyEvidence();
    if (errors.length) {
      console.error(errors.join("\n"));
      process.exitCode = 1;
    } else console.log("all-test typecheck evidence: pass");
  }
}
