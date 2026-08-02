#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { npmChildEnvironment, normalizeConstruction } from "./package-construction.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(scriptDir, "../../..");
const CONTRACT_PATH = path.join(REPO_ROOT, "references/adapters/package-publication.json");
export const RELEASE_CONTRACT = JSON.parse(fs.readFileSync(CONTRACT_PATH, "utf8"));
const RECEIPT_SCHEMA = "agentera.releaseQualification.v1";
const ARTIFACT_MODE = Number.parseInt(RELEASE_CONTRACT.qualification.candidate.retainedArtifactMode, 8);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonical(value))}\n`;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha512Integrity(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function run(command, args, options = {}) {
  const invoked = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    encoding: "utf8",
    env: options.env ?? npmChildEnvironment(process.env),
    input: options.input,
    timeout: options.timeout ?? RELEASE_CONTRACT.bounds.commandTimeoutMs,
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (invoked.error) throw invoked.error;
  if (invoked.status !== 0) {
    const output = (invoked.stderr || invoked.stdout || `exit ${invoked.status ?? "signal"}`).trim();
    throw new Error(`${command} ${args.join(" ")} failed: ${output}`);
  }
  return invoked.stdout.trim();
}

function git(args, repo = REPO_ROOT) {
  return run("git", args, { cwd: repo });
}

function redact(value, candidateDirectory) {
  let text = String(value ?? "");
  for (const privatePath of [REPO_ROOT, candidateDirectory, os.homedir()].filter(Boolean)) {
    text = text.replaceAll(privatePath, privatePath === REPO_ROOT ? "<repository>" : "<private>");
  }
  return text
    .replace(/(?:NPM_TOKEN|NODE_AUTH_TOKEN)=\S+/g, "$1=<redacted>")
    .slice(0, RELEASE_CONTRACT.bounds.diagnosticCharacters);
}

function requireArgument(argumentsMap, name) {
  const value = argumentsMap.get(name);
  if (!value) throw new Error(`missing required ${name}`);
  return value;
}

function parseArguments(values) {
  const flags = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) throw new Error(`unexpected argument '${value}'`);
    if (["--json", "--verbose"].includes(value)) {
      flags.set(value, true);
      continue;
    }
    const next = values[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`${value} requires a value`);
    flags.set(value, next);
    index += 1;
  }
  return flags;
}

function emit(receipt, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    return;
  }
  process.stdout.write(
    `${receipt.package}@${receipt.version} ${receipt.phase}: ${receipt.outcome}; ${receipt.executed}; ${receipt.elapsedMs}ms; next: ${receipt.nextAction}${receipt.detail ? `; ${receipt.detail}` : ""}\n`,
  );
}

function phaseResult({ packageName, version, phase, outcome, elapsedMs = 0, executed, reused, nextAction, detail }) {
  const result = {
    package: packageName,
    version,
    phase,
    outcome,
    elapsedMs: Math.max(0, Math.round(elapsedMs)),
    executed,
    reused: Boolean(reused),
    nextAction,
  };
  if (detail) result.detail = String(detail).slice(0, RELEASE_CONTRACT.bounds.diagnosticCharacters);
  return result;
}

function readManifest(adapterName, repo = REPO_ROOT) {
  const adapter = RELEASE_CONTRACT.packages[adapterName];
  if (!adapter) throw new Error(`unknown package '${adapterName}'; use development or stable`);
  return JSON.parse(fs.readFileSync(path.join(repo, adapter.manifestPath), "utf8"));
}

function packageManifestSourceBytes(repo = REPO_ROOT) {
  const manifest = readManifest("development", repo);
  delete manifest.version;
  if (manifest.agentera) delete manifest.agentera.gitRef;
  return Buffer.from(canonicalJson(manifest));
}

function trackedSourceHash(repo = REPO_ROOT) {
  const raw = run("git", ["ls-files", "-z"], { cwd: repo });
  const digest = createHash("sha256");
  for (const relative of raw.split("\0").filter(Boolean).sort()) {
    digest.update(relative);
    digest.update("\0");
    digest.update(
      relative === "packages/cli/package.json"
        ? packageManifestSourceBytes(repo)
        : fs.readFileSync(path.join(repo, relative)),
    );
    digest.update("\0");
  }
  return digest.digest("hex");
}

export function toolVersion(command, args = ["--version"], repo = REPO_ROOT, options = {}) {
  const state = isolatedNpmState("agentera-release-tool-version-", { environment: options.environment });
  try {
    return (options.run ?? run)(command, args, { cwd: repo, env: state.environment })
      .split(/\s+/)[0];
  } finally {
    fs.rmSync(state.root, { recursive: true, force: true });
  }
}

function sourceGateSet() {
  return RELEASE_CONTRACT.qualification.source.gates;
}

export function sourceComponentIdentity(options = {}) {
  const repo = options.repo ?? REPO_ROOT;
  const gateSet = options.gates ?? sourceGateSet();
  const policyPath = path.join(repo, "references/analysis/verification-policy.yaml");
  const lockPath = path.join(repo, "pnpm-lock.yaml");
  const probeToolVersion = options.probeToolVersion ?? toolVersion;
  const toolchain = options.toolchain ?? {
    node: probeToolVersion(process.execPath, ["--version"], repo, { run: options.probeRun, environment: options.environment }),
    npm: probeToolVersion("npm", ["--version"], repo, { run: options.probeRun, environment: options.environment }),
    pnpm: probeToolVersion("pnpm", ["--version"], repo, { run: options.probeRun, environment: options.environment }),
  };
  const inputs = {
    component: RELEASE_CONTRACT.qualification.source.component,
    trackedTreeSha256: trackedSourceHash(repo),
    verificationPolicySha256: sha256(fs.readFileSync(policyPath)),
    lockfileSha256: sha256(fs.readFileSync(lockPath)),
    toolchain,
    gates: gateSet,
  };
  return { ...inputs, sha256: sha256(canonicalJson(inputs)) };
}

function assertCleanCommittedTree(repo = REPO_ROOT) {
  if (git(["status", "--porcelain"], repo)) {
    throw new Error("source qualification requires a clean committed tree; commit governed source before qualifying");
  }
}

export function qualificationPreflight(options = {}) {
  const repo = options.repo ?? REPO_ROOT;
  const candidateDirectory = path.resolve(options.candidateDirectory);
  const relative = path.relative(repo, candidateDirectory);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..")) {
    throw new Error("candidate directory must be outside the repository checkout");
  }
  if (fs.existsSync(candidateDirectory)) {
    throw new Error("qualification preflight requires a new empty candidate directory");
  }
  const parent = fs.realpathSync(path.dirname(candidateDirectory));
  const fromRepo = path.relative(repo, parent);
  if (fromRepo === "" || (!fromRepo.startsWith(`..${path.sep}`) && fromRepo !== "..")) {
    throw new Error("candidate directory parent resolves inside the repository checkout");
  }
  assertCleanCommittedTree(repo);
  const { manifest, adapter } = candidateManifest(options.adapterName ?? "development", repo);
  return { candidateDirectory, manifest, adapter };
}

function assertExternalDirectory(directory, repo = REPO_ROOT, create = true) {
  const candidate = path.resolve(directory);
  const relative = path.relative(repo, candidate);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..")) {
    throw new Error("candidate directory must be outside the repository checkout");
  }
  if (create) fs.mkdirSync(candidate, { recursive: true, mode: 0o700 });
  else if (!fs.existsSync(candidate)) throw new Error("candidate directory is missing");
  const resolved = fs.realpathSync(candidate);
  const fromRepo = path.relative(repo, resolved);
  if (fromRepo === "" || (!fromRepo.startsWith(`..${path.sep}`) && fromRepo !== "..")) {
    throw new Error("candidate directory resolves inside the repository checkout");
  }
  return resolved;
}

function receiptPath(directory, name) {
  return path.join(directory, name);
}

function readJson(file, label) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${label} is missing or invalid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed;
}

function writeImmutableJson(file, value, label) {
  const bytes = canonicalJson(value);
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, "utf8") !== bytes) {
      throw new Error(`${label} conflicts with an existing immutable receipt`);
    }
    return false;
  }
  fs.writeFileSync(file, bytes, { encoding: "utf8", mode: 0o400, flag: "wx" });
  return true;
}

function receiptDigest(receipt) {
  const copy = structuredClone(receipt);
  delete copy.receiptSha256;
  return sha256(canonicalJson(copy));
}

function validReceiptDigest(receipt, label) {
  if (receipt.schemaVersion !== RECEIPT_SCHEMA || typeof receipt.receiptSha256 !== "string") {
    throw new Error(`${label} has an unsupported schema or missing digest`);
  }
  if (receiptDigest(receipt) !== receipt.receiptSha256) {
    throw new Error(`${label} digest does not match its content`);
  }
  return receipt;
}

function executeGate(gate, dependencies = {}) {
  const execute = dependencies.run ?? run;
  const started = performance.now();
  try {
    execute(gate.command[0] === "node" ? process.execPath : gate.command[0], gate.command.slice(1), {
      cwd: dependencies.repo ?? REPO_ROOT,
      env: dependencies.environment,
      timeout: dependencies.timeout ?? RELEASE_CONTRACT.benchmark.timeouts.sourceQualificationMs,
    });
  } catch (error) {
    if (error && typeof error === "object") error.owner ??= gate.name;
    throw error;
  }
  return {
    name: gate.name,
    elapsedMs: Math.max(0, Math.round(performance.now() - started)),
    executed: "ordered",
    reused: false,
  };
}

export function issueSourceReceipt(options = {}) {
  const repo = options.repo ?? REPO_ROOT;
  assertCleanCommittedTree(repo);
  const candidateDirectory = assertExternalDirectory(options.candidateDirectory, repo);
  const identity = sourceComponentIdentity({
    repo,
    gates: options.gates,
    toolchain: options.toolchain,
    probeToolVersion: options.probeToolVersion,
  });
  const file = receiptPath(candidateDirectory, "source-receipt.json");
  if (fs.existsSync(file)) {
    const existing = validReceiptDigest(readJson(file, "source receipt"), "source receipt");
    if (existing.component?.sha256 !== identity.sha256) {
      throw new Error("source receipt inputs changed; use a new empty candidate directory and rerun source qualification");
    }
    return { receipt: existing, reused: true, gates: [] };
  }
  const verificationState = isolatedNpmState("agentera-release-source-", { ignoreScripts: false });
  try {
    const started = performance.now();
    const deadline = started + RELEASE_CONTRACT.benchmark.timeouts.sourceQualificationMs;
    const gates = [];
    for (const gate of options.gates ?? sourceGateSet()) {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) {
        throw new Error(`source qualification exceeded its ${RELEASE_CONTRACT.benchmark.timeouts.sourceQualificationMs}ms budget before ${gate.name}`);
      }
      gates.push(executeGate(gate, { ...options, repo, timeout: remaining, environment: verificationState.environment }));
    }
    const receipt = {
      schemaVersion: RECEIPT_SCHEMA,
      kind: "source",
      component: identity,
      gates,
    };
    receipt.receiptSha256 = receiptDigest(receipt);
    writeImmutableJson(file, receipt, "source receipt");
    return { receipt, reused: false, gates };
  } finally {
    fs.rmSync(verificationState.root, { recursive: true, force: true });
  }
}

export function validateSourceReceipt(options = {}) {
  const receipt = validReceiptDigest(options.receipt, "source receipt");
  if (receipt.kind !== "source") throw new Error("source receipt kind is invalid");
  const identity = sourceComponentIdentity(options);
  if (receipt.component?.sha256 !== identity.sha256) {
    throw new Error("source receipt no longer matches current component inputs");
  }
  return receipt;
}

function ensureRegularArtifact(directory, filename) {
  if (path.basename(filename) !== filename) throw new Error("candidate artifact filename must not contain a path");
  const artifact = path.join(directory, filename);
  const resolved = fs.realpathSync(artifact);
  if (path.dirname(resolved) !== directory) throw new Error("candidate artifact escapes its candidate directory");
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("candidate artifact must be a regular file");
  return { artifact: resolved, stat };
}

function executeJson(command, args, options = {}) {
  const output = (options.run ?? run)(command, args, options).trim();
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`${path.basename(command)} returned invalid JSON`);
  }
}

function candidateManifest(adapterName, repo = REPO_ROOT) {
  const manifest = readManifest(adapterName, repo);
  const adapter = RELEASE_CONTRACT.packages[adapterName];
  const expectedDevelopment = adapterName === "development";
  const validVersion = expectedDevelopment
    ? /^\d+\.\d+\.\d+-dev\.(?:0|[1-9]\d*)$/.test(manifest.version)
    : /^\d+\.\d+\.\d+$/.test(manifest.version);
  if (!validVersion) throw new Error(`${adapterName} manifest version is outside its release policy`);
  if (!/^[0-9a-f]{40}$/.test(manifest.agentera?.gitRef ?? "")) {
    throw new Error("candidate manifest has no immutable 40-character agentera.gitRef");
  }
  if (spawnSync("git", ["cat-file", "-e", `${manifest.agentera.gitRef}^{commit}`], {
    cwd: repo,
    env: npmChildEnvironment(process.env),
  }).status !== 0) {
    throw new Error("candidate manifest agentera.gitRef does not name an existing commit");
  }
  validateAdapterSourceProvenance({ repo, adapter, manifest });
  return { manifest, adapter };
}

function normalizedPreparedManifest(manifest) {
  const normalized = structuredClone(manifest);
  delete normalized.version;
  if (normalized.agentera && typeof normalized.agentera === "object") {
    delete normalized.agentera.gitRef;
  }
  return normalized;
}

export function validateAdapterSourceProvenance(options = {}) {
  const { repo = REPO_ROOT, adapter, manifest } = options;
  const provenance = adapter?.sourceProvenance;
  if (!provenance) return;
  const gitRef = manifest?.agentera?.gitRef;
  const label = adapter.manifestPath;
  const inputs = provenance.packagedInputs;
  if (!Array.isArray(inputs) || inputs.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new Error(`${label}: adapter source provenance is missing packaged inputs`);
  }
  const diff = spawnSync("git", ["diff", "--quiet", gitRef, "--", ...inputs], {
    cwd: repo,
    env: npmChildEnvironment(process.env),
  });
  if (diff.status === 1) {
    throw new Error(
      `${label}: agentera.gitRef does not match the stable shim packaged inputs; select the last substantive shim-source commit`,
    );
  }
  if (diff.status !== 0) {
    throw new Error(`${label}: unable to compare agentera.gitRef with stable shim packaged inputs`);
  }
  const selected = spawnSync("git", ["show", `${gitRef}:${adapter.manifestPath}`], {
    cwd: repo,
    encoding: "utf8",
    env: npmChildEnvironment(process.env),
  });
  try {
    if (
      selected.status !== 0
      || canonicalJson(normalizedPreparedManifest(JSON.parse(selected.stdout)))
        !== canonicalJson(normalizedPreparedManifest(manifest))
    ) {
      throw new Error("mismatch");
    }
  } catch {
    throw new Error(
      `${label}: package contract differs from agentera.gitRef outside approved version and agentera.gitRef preparation metadata`,
    );
  }
}

function sameConstructionObservation(dry, packed) {
  const fields = ["name", "version", "fileCount", "packedSize", "unpackedSize", "shasum", "integrity"];
  if (fields.some((field) => dry[field] !== packed[field])) {
    throw new Error("retained artifact does not match dry-pack construction observation");
  }
}

export function isolatedNpmState(prefix = "agentera-release-smoke-", options = {}) {
  const ignoreScripts = options.ignoreScripts !== false;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const home = path.join(root, "home");
  const cache = path.join(root, "cache");
  const npmrc = path.join(root, "npmrc");
  const globalNpmrc = path.join(root, "global-npmrc");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  fs.writeFileSync(npmrc, `registry=https://registry.npmjs.org/\n${ignoreScripts ? "ignore-scripts=true\n" : ""}`, { mode: 0o600, flag: "wx" });
  fs.writeFileSync(globalNpmrc, "", { mode: 0o600, flag: "wx" });
  return {
    root,
    environment: {
      ...npmChildEnvironment(options.environment ?? process.env, npmrc),
      HOME: home,
      XDG_CONFIG_HOME: path.join(root, "config"),
      NPM_CONFIG_CACHE: cache,
      NPM_CONFIG_GLOBALCONFIG: globalNpmrc,
      NPM_CONFIG_AUDIT: "false",
      NPM_CONFIG_FUND: "false",
      ...(ignoreScripts ? { NPM_CONFIG_IGNORE_SCRIPTS: "true" } : {}),
    },
  };
}

export function smokeExactArtifact(options = {}) {
  const { artifact, manifest, adapter } = options;
  const execute = options.run ?? run;
  const state = isolatedNpmState();
  const install = path.join(state.root, "install");
  try {
    execute("npm", ["install", "--prefix", install, "--omit=dev", "--no-audit", "--no-fund", artifact], {
      cwd: state.root,
      env: state.environment,
      timeout: RELEASE_CONTRACT.bounds.commandTimeoutMs,
    });
    const smoke = adapter.localSmoke;
    const bin = path.join(install, "node_modules", ".bin", smoke[0]);
    const output = execute(process.execPath, [bin, ...smoke.slice(1)], {
      cwd: state.root,
      env: state.environment,
      timeout: RELEASE_CONTRACT.bounds.commandTimeoutMs,
    });
    if (!output.includes(manifest.version)) {
      throw new Error(`local exact-artifact smoke did not identify ${manifest.version}`);
    }
    return output;
  } finally {
    fs.rmSync(state.root, { recursive: true, force: true });
  }
}

export function smokePublishedCandidate(options = {}) {
  const { manifest, adapter } = options;
  const execute = options.run ?? run;
  const state = isolatedNpmState("agentera-registry-smoke-");
  const install = path.join(state.root, "install");
  try {
    execute("npm", ["install", "--prefix", install, "--omit=dev", "--no-audit", "--no-fund", `${manifest.name}@${manifest.version}`], {
      cwd: state.root,
      env: state.environment,
      timeout: RELEASE_CONTRACT.bounds.commandTimeoutMs,
    });
    const smoke = adapter.localSmoke;
    const output = execute(process.execPath, [path.join(install, "node_modules", ".bin", smoke[0]), ...smoke.slice(1)], {
      cwd: state.root,
      env: state.environment,
      timeout: RELEASE_CONTRACT.bounds.commandTimeoutMs,
    });
    if (!output.includes(manifest.version)) {
      throw new Error(`registry exact-version smoke did not identify ${manifest.version}`);
    }
    return output;
  } finally {
    fs.rmSync(state.root, { recursive: true, force: true });
  }
}

function releaseMetadataGate(repo, adapterName) {
  run(process.execPath, ["packages/cli/dist/bin/agentera.js", "check", "validate", "release-metadata", "--format", "json"], {
    cwd: repo,
    env: { ...npmChildEnvironment(process.env), AGENTERA_RELEASE_ADAPTER: adapterName },
    timeout: RELEASE_CONTRACT.benchmark.timeouts.sourceQualificationMs,
  });
}

function firstPackEntry(value) {
  const entries = Array.isArray(value) ? value : Object.values(value ?? {});
  if (entries.length !== 1 || !entries[0] || typeof entries[0] !== "object") {
    throw new Error("npm pack returned an ambiguous package manifest");
  }
  return entries[0];
}

function constructCandidatePackage({ repo, adapter, manifest, candidateDirectory, execute }) {
  const packageRoot = path.join(repo, adapter.packagePath);
  if (adapter.construction === "isolatedTypeScriptPackage") {
    return {
      dry: executeJson(process.execPath, ["scripts/pack-package.mjs", "--dry-run", "--json"], {
        cwd: packageRoot,
        run: execute,
      }),
      packed: executeJson(process.execPath, ["scripts/pack-package.mjs", "--output-dir", candidateDirectory, "--json"], {
        cwd: packageRoot,
        run: execute,
      }),
    };
  }
  const state = isolatedNpmState("agentera-shim-candidate-", { ignoreScripts: false });
  try {
    execute("pnpm", ["test"], { cwd: packageRoot, env: state.environment, timeout: RELEASE_CONTRACT.benchmark.timeouts.sourceQualificationMs });
    const dry = firstPackEntry(executeJson("npm", ["pack", "--ignore-scripts", "--dry-run", "--json"], {
      cwd: packageRoot,
      env: state.environment,
      run: execute,
    }));
    const packed = firstPackEntry(executeJson("npm", ["pack", "--ignore-scripts", "--pack-destination", candidateDirectory, "--json"], {
      cwd: packageRoot,
      env: state.environment,
      run: execute,
    }));
    return { dry: { ...dry, warnings: [] }, packed: { ...packed, artifact: path.join(candidateDirectory, packed.filename), warnings: [] } };
  } finally {
    fs.rmSync(state.root, { recursive: true, force: true });
  }
}

export function issueCandidateReceipt(options = {}) {
  const repo = options.repo ?? REPO_ROOT;
  assertCleanCommittedTree(repo);
  const candidateDirectory = assertExternalDirectory(options.candidateDirectory, repo);
  const sourceReceipt = validateSourceReceipt({
    repo,
    receipt: validReceiptDigest(readJson(receiptPath(candidateDirectory, "source-receipt.json"), "source receipt"), "source receipt"),
    toolchain: options.toolchain,
  });
  const { adapter, manifest } = candidateManifest(options.adapterName, repo);
  const metadataCommit = git(["rev-parse", "HEAD"], repo);
  const candidateFile = receiptPath(candidateDirectory, "candidate-receipt.json");
  if (fs.existsSync(candidateFile)) {
    const existing = validReceiptDigest(readJson(candidateFile, "candidate receipt"), "candidate receipt");
    validateCandidateReceipt({ candidateDirectory, receipt: existing, adapterName: options.adapterName, repo });
    return { receipt: existing, reused: true };
  }

  const execute = options.run ?? run;
  const metadataStarted = performance.now();
  try {
    releaseMetadataGate(repo, options.adapterName);
  } catch (error) {
    if (error && typeof error === "object") error.owner ??= "release-metadata";
    throw error;
  }
  const metadataGate = {
    name: "release-metadata",
    outcome: "passed",
    elapsedMs: Math.max(0, Math.round(performance.now() - metadataStarted)),
    executed: "ordered",
    reused: false,
  };
  const constructionStarted = performance.now();
  let constructed;
  try {
    constructed = constructCandidatePackage({ repo, adapter, manifest, candidateDirectory, execute });
  } catch (error) {
    if (error && typeof error === "object") error.owner ??= "dry-pack-observation-equivalence";
    throw error;
  }
  const { dry, packed } = constructed;
  const construction = normalizeConstruction(packed, {
    expectedName: manifest.name,
    expectedVersion: manifest.version,
    expectedTag: adapter.expectedTag,
    artifact: packed.artifact,
    warnings: packed.warnings,
  });
  const dryConstruction = normalizeConstruction(dry, {
    expectedName: manifest.name,
    expectedVersion: manifest.version,
    expectedTag: adapter.expectedTag,
    warnings: dry.warnings,
  });
  sameConstructionObservation(dryConstruction, construction);
  const artifactState = ensureRegularArtifact(candidateDirectory, path.basename(construction.artifact));
  const artifactBytes = fs.readFileSync(artifactState.artifact);
  if (sha512Integrity(artifactBytes) !== construction.integrity) {
    throw new Error("retained artifact integrity does not match construction receipt");
  }
  fs.chmodSync(artifactState.artifact, ARTIFACT_MODE);
  const retainedArtifact = ensureRegularArtifact(candidateDirectory, path.basename(construction.artifact));
  if ((retainedArtifact.stat.mode & 0o777) !== ARTIFACT_MODE) {
    throw new Error("candidate artifact did not retain the required immutable mode");
  }
  const smokeStarted = performance.now();
  let smokeOutput;
  try {
    smokeOutput = smokeExactArtifact({ artifact: retainedArtifact.artifact, manifest, adapter, run: options.smokeRun });
  } catch (error) {
    if (error && typeof error === "object") error.owner ??= "local-exact-artifact-smoke";
    throw error;
  }
  const receipt = {
    schemaVersion: RECEIPT_SCHEMA,
    kind: "candidate",
    sourceReceiptSha256: sourceReceipt.receiptSha256,
    metadataCommit,
    sourceCommit: manifest.agentera.gitRef,
    adapter: options.adapterName,
    package: manifest.name,
    version: manifest.version,
    registry: "https://registry.npmjs.org/",
    expectedTag: adapter.expectedTag,
    candidateTag: `candidate-${manifest.version}`,
    artifact: {
      filename: path.basename(retainedArtifact.artifact),
      sha256: sha256(artifactBytes),
      integrity: construction.integrity,
      bytes: artifactBytes.byteLength,
      mode: ARTIFACT_MODE,
      construction: {
        name: construction.name,
        version: construction.version,
        fileCount: construction.fileCount,
        packedSize: construction.packedSize,
        unpackedSize: construction.unpackedSize,
        shasum: construction.shasum,
      },
      dryPackEquivalent: true,
    },
    gates: [
      metadataGate,
      {
        name: "dry-pack-observation-equivalence",
        outcome: "passed",
        elapsedMs: Math.max(0, Math.round(performance.now() - constructionStarted)),
        executed: "ordered",
        reused: false,
      },
      {
        name: "local-exact-artifact-smoke",
        outcome: "passed",
        elapsedMs: Math.max(0, Math.round(performance.now() - smokeStarted)),
        executed: "ordered",
        reused: false,
        output: smokeOutput.trim(),
      },
    ],
  };
  receipt.receiptSha256 = receiptDigest(receipt);
  writeImmutableJson(candidateFile, receipt, "candidate receipt");
  return { receipt, reused: false };
}

export function validateCandidateReceipt(options = {}) {
  const repo = options.repo ?? REPO_ROOT;
  const candidateDirectory = assertExternalDirectory(options.candidateDirectory, repo, false);
  const receipt = validReceiptDigest(
    options.receipt ?? readJson(receiptPath(candidateDirectory, "candidate-receipt.json"), "candidate receipt"),
    "candidate receipt",
  );
  if (receipt.kind !== "candidate") throw new Error("candidate receipt kind is invalid");
  const { manifest, adapter } = candidateManifest(options.adapterName ?? receipt.adapter, repo);
  const storedSource = validReceiptDigest(
    readJson(receiptPath(candidateDirectory, "source-receipt.json"), "source receipt"),
    "source receipt",
  );
  const source = validateSourceReceipt({ repo, receipt: storedSource, gates: storedSource.component?.gates });
  if (
    receipt.sourceReceiptSha256 !== source.receiptSha256
    || receipt.adapter !== (options.adapterName ?? receipt.adapter)
    || receipt.metadataCommit !== git(["rev-parse", "HEAD"], repo)
    || receipt.package !== manifest.name
    || receipt.version !== manifest.version
    || receipt.sourceCommit !== manifest.agentera.gitRef
    || receipt.expectedTag !== adapter.expectedTag
    || receipt.candidateTag !== `candidate-${manifest.version}`
    || receipt.registry !== "https://registry.npmjs.org/"
    || receipt.artifact?.dryPackEquivalent !== true
  ) {
    throw new Error("candidate receipt no longer matches the selected package metadata or source receipt");
  }
  const artifactState = ensureRegularArtifact(candidateDirectory, receipt.artifact?.filename);
  const bytes = fs.readFileSync(artifactState.artifact);
  if (
    receipt.artifact.sha256 !== sha256(bytes)
    || receipt.artifact.integrity !== sha512Integrity(bytes)
    || receipt.artifact.bytes !== bytes.byteLength
  ) {
    throw new Error("candidate artifact changed after qualification");
  }
  if (
    receipt.artifact.mode !== ARTIFACT_MODE
    || (artifactState.stat.mode & 0o777) !== receipt.artifact.mode
  ) {
    throw new Error("candidate artifact permissions changed after qualification");
  }
  return { receipt, artifact: artifactState.artifact, manifest, adapter };
}

export function issueCandidateApproval(options = {}) {
  const approvedBy = options.approvedBy;
  if (typeof approvedBy !== "string" || !/^[A-Za-z0-9_.@/-]{1,120}$/.test(approvedBy)) {
    throw new Error("approval requires a bounded --approved-by principal");
  }
  const candidate = validateCandidateReceipt(options);
  if ((options.environment ?? process.env).GITHUB_ACTIONS === "true") {
    validateCiAttestation({
      ...options,
      candidate,
      environment: options.environment,
      sourceRunId: options.sourceRunId,
    });
  }
  const approval = {
    schemaVersion: RECEIPT_SCHEMA,
    kind: "approval",
    approvedBy,
    scope: "registry-mutation",
    candidateReceiptSha256: candidate.receipt.receiptSha256,
    package: candidate.receipt.package,
    version: candidate.receipt.version,
    integrity: candidate.receipt.artifact.integrity,
    registry: candidate.receipt.registry,
    expectedTag: candidate.receipt.expectedTag,
  };
  approval.receiptSha256 = receiptDigest(approval);
  const file = receiptPath(options.candidateDirectory, "approval.json");
  writeImmutableJson(file, approval, "candidate approval");
  return approval;
}

export function validateCandidateApproval(options = {}) {
  const candidate = options.candidate ?? validateCandidateReceipt(options);
  const approval = validReceiptDigest(
    options.approval ?? readJson(receiptPath(options.candidateDirectory, "approval.json"), "candidate approval"),
    "candidate approval",
  );
  if (
    approval.kind !== "approval"
    || approval.scope !== "registry-mutation"
    || typeof approval.approvedBy !== "string"
    || !/^[A-Za-z0-9_.@/-]{1,120}$/.test(approval.approvedBy)
    || approval.candidateReceiptSha256 !== candidate.receipt.receiptSha256
    || approval.package !== candidate.receipt.package
    || approval.version !== candidate.receipt.version
    || approval.integrity !== candidate.receipt.artifact.integrity
    || approval.registry !== candidate.receipt.registry
    || approval.expectedTag !== candidate.receipt.expectedTag
  ) {
    throw new Error("candidate approval is not bound to this exact candidate");
  }
  return approval;
}

function validRunId(value) {
  return typeof value === "string" && /^[1-9]\d{0,19}$/.test(value);
}

function qualificationWorkflowIdentity() {
  const ci = RELEASE_CONTRACT.ci;
  const workflow = ci?.qualificationWorkflow;
  if (!ci?.repository || !workflow?.name || !workflow?.path || !workflow?.ref) {
    throw new Error("release publication contract has no qualification workflow identity");
  }
  return {
    repository: ci.repository,
    workflow: workflow.name,
    workflowRef: `${ci.repository}/${workflow.path}@${workflow.ref}`,
  };
}

function assertQualificationWorkflowEnvironment(environment) {
  const expected = qualificationWorkflowIdentity();
  if (
    environment.GITHUB_REPOSITORY !== expected.repository
    || environment.GITHUB_WORKFLOW !== expected.workflow
    || environment.GITHUB_WORKFLOW_REF !== expected.workflowRef
    || !validRunId(environment.GITHUB_RUN_ID)
  ) {
    throw new Error("CI attestation must originate from the contracted qualification repository, workflow, workflow ref, and run identity");
  }
  return expected;
}

export function issueCiAttestation(options = {}) {
  const environment = options.environment ?? process.env;
  if (environment.GITHUB_ACTIONS !== "true") {
    throw new Error("CI attestation can only be issued by a GitHub Actions runner");
  }
  const expected = assertQualificationWorkflowEnvironment(environment);
  const candidate = validateCandidateReceipt(options);
  if (environment.GITHUB_SHA !== candidate.receipt.metadataCommit) {
    throw new Error("CI checkout SHA does not match the candidate metadata commit");
  }
  const attestation = {
    schemaVersion: RECEIPT_SCHEMA,
    kind: "ci-attestation",
    candidateReceiptSha256: candidate.receipt.receiptSha256,
    sourceCommit: candidate.receipt.sourceCommit,
    metadataCommit: candidate.receipt.metadataCommit,
    repository: expected.repository,
    workflow: expected.workflow,
    workflowRef: expected.workflowRef,
    runId: environment.GITHUB_RUN_ID,
  };
  if (Object.values(attestation).some((value) => typeof value !== "string" || value.length === 0) || !validRunId(attestation.runId)) {
    throw new Error("CI attestation requires repository, workflow, and run identity");
  }
  attestation.receiptSha256 = receiptDigest(attestation);
  writeImmutableJson(receiptPath(options.candidateDirectory, "ci-attestation.json"), attestation, "CI attestation");
  return attestation;
}

export function validateCiAttestation(options = {}) {
  const environment = options.environment ?? process.env;
  if (environment.GITHUB_ACTIONS !== "true") {
    throw new Error("CI registry mutation requires a GitHub Actions execution context");
  }
  const expected = qualificationWorkflowIdentity();
  if (environment.GITHUB_REPOSITORY !== expected.repository || !validRunId(options.sourceRunId)) {
    throw new Error("CI registry mutation requires the contracted repository and a source qualification run identity");
  }
  const candidate = options.candidate ?? validateCandidateReceipt(options);
  const attestation = validReceiptDigest(
    options.attestation ?? readJson(receiptPath(options.candidateDirectory, "ci-attestation.json"), "CI attestation"),
    "CI attestation",
  );
  if (
    attestation.kind !== "ci-attestation"
    || attestation.candidateReceiptSha256 !== candidate.receipt.receiptSha256
    || attestation.sourceCommit !== candidate.receipt.sourceCommit
    || attestation.metadataCommit !== candidate.receipt.metadataCommit
    || attestation.repository !== expected.repository
    || attestation.workflow !== expected.workflow
    || attestation.workflowRef !== expected.workflowRef
    || !validRunId(attestation.runId)
    || attestation.runId !== options.sourceRunId
  ) {
    throw new Error("CI attestation is not bound to this candidate and source run");
  }
  return attestation;
}

function runCommand(command, flags) {
  const candidateDirectory = requireArgument(flags, "--candidate-dir");
  const adapterName = flags.get("--adapter") ?? "development";
  const manifest = readManifest(adapterName);
  const json = Boolean(flags.get("--json"));
  const started = performance.now();
  const phase = command === "source" ? "source-qualification" : command === "candidate" ? "candidate-qualification" : command;
  emit(phaseResult({
    packageName: adapterName,
    version: manifest.version,
    phase,
    outcome: "started",
    executed: "pending",
    reused: false,
    nextAction: command === "source" ? "run ordered source gates" : "validate source evidence and retained artifact",
  }), json);
  try {
    const issued = command === "source"
      ? issueSourceReceipt({ candidateDirectory })
      : command === "candidate"
          ? issueCandidateReceipt({ candidateDirectory, adapterName })
          : command === "approval"
          ? {
              receipt: issueCandidateApproval({
                candidateDirectory,
                adapterName,
                approvedBy: requireArgument(flags, "--approved-by"),
                sourceRunId: flags.get("--source-run-id"),
              }),
              reused: false,
            }
          : { receipt: issueCiAttestation({ candidateDirectory, adapterName }), reused: false };
    emit(phaseResult({
      packageName: adapterName,
      version: manifest.version,
      phase,
      outcome: "passed",
      elapsedMs: performance.now() - started,
      executed: issued.reused ? "none" : "ordered gates",
      reused: issued.reused,
      nextAction: command === "source"
        ? "qualify a candidate from this receipt"
        : command === "candidate"
          ? "record explicit candidate approval before staging"
          : command === "approval"
            ? "stage the exact approved candidate"
            : "transfer the attested candidate to the explicitly approved publication workflow",
    }), json);
  } catch (error) {
    emit(phaseResult({
      packageName: adapterName,
      version: manifest.version,
      phase,
      outcome: "failed",
      elapsedMs: performance.now() - started,
      executed: "failed",
      reused: false,
      nextAction: "Correct the reported failure and retry without repairing source automatically.",
      detail: redact(error instanceof Error ? error.message : error, candidateDirectory),
    }), json);
    throw error;
  }
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!["source", "candidate", "approval", "attest"].includes(command)) {
    throw new Error("usage: release-qualification.mjs <source|candidate|approval|attest> --candidate-dir DIR [--adapter development|stable] [--json]");
  }
  runCommand(command, parseArguments(rest));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`release-qualification: ${redact(error instanceof Error ? error.message : error)}\n`);
    process.exitCode = 1;
  }
}
