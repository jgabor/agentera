#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { npmChildEnvironment, normalizeConstruction } from "./package-construction.mjs";
import { readGeneratedSourceIdentity, sameGeneratedSourceIdentity, validateGeneratedSourceIdentity, validateRegularTree } from "./generated-output.mjs";
import { gitSourceTreeDigest } from "./git-source-tree.mjs";
import { performanceEvidenceRecords } from "./performance-evidence.mjs";
import { parseReleaseFlags } from "./release-arguments.mjs";
import "./source-loader-register.mjs";

const { loadPackagePublicationModel } = await import("../src/registries/packagePublication.ts");
const {
  PACKAGE_SNAPSHOT_DIRECTORY,
  PACKAGE_SNAPSHOT_SCHEMA,
  activationPackageIdentityViolations,
  removeRetainedPackageSnapshot,
} = await import("../src/validate/activationArtifactEvidence.ts");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(scriptDir, "../../..");
const CONTRACT_PATH = path.join(REPO_ROOT, "references/adapters/package-publication.json");
export const RELEASE_CONTRACT = JSON.parse(fs.readFileSync(CONTRACT_PATH, "utf8"));
export const RELEASE_MODEL = loadPackagePublicationModel(REPO_ROOT);
const RECEIPT_SCHEMA = "agentera.releaseQualification.v1";
const ARTIFACT_MODE = Number.parseInt(RELEASE_CONTRACT.qualification.candidate.retainedArtifactMode, 8);

export function validateDevelopmentCiCandidateBinding(options = {}) {
  const environment = options.environment ?? process.env;
  const expected = publicationWorkflowIdentity("development");
  const contractedCi = environment.GITHUB_ACTIONS === "true"
    && environment.GITHUB_REPOSITORY === expected.repository
    && environment.GITHUB_WORKFLOW === expected.workflow
    && environment.GITHUB_WORKFLOW_REF === expected.workflowRef;
  if (options.adapterName !== "development" || !contractedCi) return;
  assertQualificationWorkflowEnvironment(environment, "development");
  if (options.sourceCommit !== environment.GITHUB_SHA) {
    throw new Error("development CI source commit must equal GITHUB_SHA");
  }
  if (environment.GITHUB_SHA !== git(["rev-parse", "HEAD"], options.repo ?? REPO_ROOT)) {
    throw new Error("development CI checkout HEAD must equal GITHUB_SHA");
  }
}

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

export function formatPhaseResult(receipt) {
  return `${receipt.package}@${receipt.version} ${receipt.phase}: ${receipt.outcome}; executed:${receipt.executed}; reused:${receipt.reused}; ${receipt.elapsedMs}ms; next: ${receipt.nextAction}${receipt.detail ? `; ${receipt.detail}` : ""}`;
}

function emit(receipt, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    return;
  }
  process.stdout.write(`${formatPhaseResult(receipt)}\n`);
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

function packageManifestSourceBytes(repo = REPO_ROOT, bytes) {
  const manifest = bytes
    ? JSON.parse(bytes.toString("utf8"))
    : readManifest("development", repo);
  delete manifest.version;
  if (manifest.agentera) delete manifest.agentera.gitRef;
  return Buffer.from(canonicalJson(manifest));
}

function stagedSourceBytes(repo, relative) {
  const invoked = spawnSync("git", ["show", `:${relative}`], {
    cwd: repo,
    encoding: null,
    env: npmChildEnvironment(process.env),
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (invoked.status !== 0) throw new Error("unable to read the staged source tree");
  return invoked.stdout;
}

function trackedSourceHash(repo = REPO_ROOT) {
  return gitSourceTreeDigest(repo, {
    source: "index",
    label: "release source identity",
    transformBytes: (relative, bytes) => relative === "packages/cli/package.json"
      ? packageManifestSourceBytes(repo, bytes)
      : bytes,
  }).sha256;
}

function assertStagedSourceMatchesWorking(repo) {
  const transformBytes = (relative, bytes) => relative === "packages/cli/package.json"
    ? packageManifestSourceBytes(repo, bytes)
    : bytes;
  const staged = gitSourceTreeDigest(repo, {
    source: "index",
    label: "release staged source identity",
    transformBytes,
  });
  const working = gitSourceTreeDigest(repo, {
    label: "release working source identity",
    transformBytes,
  });
  if (staged.sha256 === working.sha256) return;
  if (
    !packageManifestSourceBytes(repo).equals(
      packageManifestSourceBytes(repo, stagedSourceBytes(repo, "packages/cli/package.json")),
    )
  ) {
    throw new Error("staged and working package inputs differ outside version and agentera.gitRef");
  }
  throw new Error("staged and working source inputs differ");
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
  return RELEASE_MODEL.sourceGates;
}

function governedSourceGates(gates = sourceGateSet()) {
  const governed = sourceGateSet();
  if (canonicalJson(gates) !== canonicalJson(governed)) {
    throw new Error("source verification must use the exact governed gate set");
  }
  return governed;
}

export function sourceComponentIdentity(options = {}) {
  const repo = options.repo ?? REPO_ROOT;
  const gateSet = governedSourceGates(options.gates);
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
    throw new Error("source verification requires a clean committed tree; commit governed source before verifying");
  }
}

export function qualificationPreflight(options = {}) {
  const repo = options.repo ?? REPO_ROOT;
  const candidateDirectory = path.resolve(options.candidateDirectory);
  const relative = path.relative(repo, candidateDirectory);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..")) {
    throw new Error("artifact directory must be outside the repository checkout");
  }
  if (fs.existsSync(candidateDirectory)) {
    throw new Error("package verification preflight requires a new empty artifact directory");
  }
  const parent = fs.realpathSync(path.dirname(candidateDirectory));
  const fromRepo = path.relative(repo, parent);
  if (fromRepo === "" || (!fromRepo.startsWith(`..${path.sep}`) && fromRepo !== "..")) {
    throw new Error("artifact directory parent resolves inside the repository checkout");
  }
  assertCleanCommittedTree(repo);
  const { manifest, adapter } = candidateManifest(options.adapterName ?? "development", repo);
  return { candidateDirectory, manifest, adapter };
}

function assertExternalDirectory(directory, repo = REPO_ROOT, create = true) {
  const candidate = path.resolve(directory);
  const relative = path.relative(repo, candidate);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..")) {
    throw new Error("artifact directory must be outside the repository checkout");
  }
  if (create) fs.mkdirSync(candidate, { recursive: true, mode: 0o700 });
  else if (!fs.existsSync(candidate)) throw new Error("artifact directory is missing");
  const resolved = fs.realpathSync(candidate);
  const fromRepo = path.relative(repo, resolved);
  if (fromRepo === "" || (!fromRepo.startsWith(`..${path.sep}`) && fromRepo !== "..")) {
    throw new Error("artifact directory resolves inside the repository checkout");
  }
  return resolved;
}

function receiptPath(directory, name) {
  return path.join(directory, name);
}

function containedRegularReceipt(directory, filename, label) {
  const file = receiptPath(directory, filename);
  if (!fs.existsSync(file)) throw new Error(`${label} is missing from the artifact directory`);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || path.dirname(fs.realpathSync(file)) !== directory) {
    throw new Error(`${label} must be a regular file inside the artifact directory`);
  }
  return file;
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

const SOURCE_DAG = RELEASE_MODEL.sourceDag;
const SOURCE_BATCH_A = SOURCE_DAG.batchA;
const SOURCE_PERFORMANCE_BARRIER = SOURCE_DAG.performanceBarrier;
const SOURCE_CAPACITY_BARRIER = SOURCE_DAG.capacityBarrier;
const SOURCE_BARRIER_B = SOURCE_DAG.barrierB;
const GENERATED_OVERLAP_ORIGINS = SOURCE_DAG.generatedOverlapOrigins;
const OVERLAP_PARTICIPANTS = GENERATED_OVERLAP_ORIGINS.filter((name) => name !== "generated-overlap");

function sourceGateMap(gates) {
  const required = sourceGateSet();
  if (!Array.isArray(gates) || gates.length !== required.length) throw new Error(`source verification gate set must contain exactly the ${required.length} governed gates`);
  const entries = new Map();
  for (let index = 0; index < required.length; index += 1) {
    const expected = required[index];
    const gate = gates[index];
    if (!gate || gate.name !== expected.name || entries.has(gate.name) || canonicalJson(gate) !== canonicalJson(expected)) {
      throw new Error(`source verification gate ${index} must exactly match '${expected.name}'`);
    }
    entries.set(gate.name, gate);
  }
  return entries;
}

function isGovernedParticipantCommand(name, command, governed, buildRoot) {
  if (name !== "build") return canonicalJson(command) === canonicalJson(governed);
  if (!Array.isArray(command) || canonicalJson(command.slice(0, governed.length)) !== canonicalJson(governed)) return false;
  const suffix = command.slice(governed.length);
  return suffix.length === 3
    && suffix[0] === "--"
    && suffix[1] === "--output-root"
    && typeof suffix[2] === "string"
    && suffix[2].length > 0
    && (buildRoot === undefined || suffix[2] === buildRoot);
}

function sourceProcessFailure(name, detail, status) {
  const error = new Error(detail);
  error.owner = name;
  error.sourceStatus = status;
  return error;
}

function sourceDiagnostic(value) {
  return String(value)
    .replaceAll(REPO_ROOT, "<repository>")
    .replaceAll(os.homedir(), "<home>")
    .replaceAll(os.tmpdir(), "<tmp>")
    .trim()
    .slice(-RELEASE_CONTRACT.bounds.diagnosticCharacters);
}

function killProcessGroup(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function requestCooperativeStop(child) {
  if (!child.pid) return;
  try {
    child.kill("SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function defaultStartSourceOwner(specification) {
  const started = performance.now();
  const stream = fs.createWriteStream(specification.reportFile, { flags: "wx", mode: 0o600 });
  const command = specification.command[0] === "node" ? process.execPath : specification.command[0];
  const child = spawn(command, specification.command.slice(1), {
    cwd: specification.repo,
    env: specification.environment,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const outputLimit = 1024 * 1024;
  let stdout = "";
  let stderr = "";
  let closed = false;
  let cancelled = false;
  let timedOut = false;
  let forceTimer;
  const capture = (current, chunk) => `${current}${chunk}`.slice(-outputLimit);
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout = capture(stdout, chunk);
    stream.write(chunk);
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr = capture(stderr, chunk);
    stream.write(chunk);
  });
  const cancel = () => {
    if (closed || !specification.cancellable) return;
    cancelled = true;
    killProcessGroup(child, "SIGTERM");
    forceTimer ??= setTimeout(() => {
      if (!closed) killProcessGroup(child, "SIGKILL");
    }, 2000);
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    if (specification.cancellable) cancel();
    else if (specification.cooperativeStop) requestCooperativeStop(child);
  }, Math.max(1, specification.timeoutMs));
  const promise = new Promise((resolve, reject) => {
    child.on("error", (error) => {
      reject(sourceProcessFailure(specification.name, error.message, cancelled ? "cancelled" : "failed"));
    });
    child.on("close", (code, signal) => {
      closed = true;
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      stream.end();
      const elapsedMs = Math.max(0, Math.round(performance.now() - started));
      if (timedOut) {
        reject(sourceProcessFailure(
          specification.name,
          `${specification.name} exceeded the source verification deadline`,
          "failed",
        ));
      } else if (cancelled) {
        reject(sourceProcessFailure(specification.name, `${specification.name} cancelled after peer failure`, "cancelled"));
      } else if (code !== 0) {
        reject(sourceProcessFailure(
          specification.name,
          sourceDiagnostic(stderr || stdout || `exit ${code ?? signal ?? "unknown"}`),
          "failed",
        ));
      } else {
        resolve({ name: specification.name, elapsedMs, stdout, stderr });
      }
    });
  });
  return { name: specification.name, cancellable: specification.cancellable, promise, cancel };
}

function normalizedOwnerFailure(handle, error) {
  return {
    name: error?.owner ?? handle.name,
    status: error?.sourceStatus ?? "failed",
    detail: sourceDiagnostic(error instanceof Error ? error.message : error),
  };
}

async function runConcurrentSourceOwners(specifications, options = {}) {
  const createState = options.createState ?? ((name) => {
    const state = isolatedNpmState(`agentera-release-${name}-`, {
      environment: options.environment,
      ignoreScripts: false,
    });
    return { ...state, cleanup: () => fs.rmSync(state.root, { recursive: true, force: true }) };
  });
  const startOwner = options.startOwner ?? defaultStartSourceOwner;
  const states = specifications.map((specification) => createState(specification.name));
  const handles = specifications.map((specification, index) => startOwner({
    ...specification,
    environment: { ...states[index].environment, ...specification.environment },
    reportFile: path.join(states[index].root, "owner-report.log"),
  }));
  let firstFailure;
  try {
    const settled = await Promise.all(handles.map((handle) => handle.promise.then(
      (value) => ({ status: "passed", value }),
      (error) => {
        const failure = normalizedOwnerFailure(handle, error);
        if (!firstFailure) {
          firstFailure = failure;
          for (const peer of handles) {
            if (peer !== handle && peer.cancellable) peer.cancel();
          }
        }
        return { status: "failed", failure };
      },
    )));
    if (firstFailure) {
      const failures = settled.filter((entry) => entry.status === "failed").map((entry) => entry.failure);
      const completed = settled.filter((entry) => entry.status === "passed").map((entry) => entry.value.name);
      const summary = failures.map((failure) => `${failure.name}:${failure.status}`).join(", ");
      const error = sourceProcessFailure(
        firstFailure.name,
        `${firstFailure.name}: ${firstFailure.detail}; settled failures: ${summary}; completed: ${completed.join(", ") || "none"}`,
        firstFailure.status,
      );
      error.firstFailure = firstFailure;
      error.failures = failures;
      error.completed = completed;
      throw error;
    }
    return Object.fromEntries(settled.map((entry) => [entry.value.name, entry.value]));
  } finally {
    for (const state of states) state.cleanup?.();
  }
}

function validateOverlapEvidence(evidence, gates) {
  const schema = RELEASE_CONTRACT.qualification.source.overlapEvidenceSchema;
  try {
    validateGeneratedSourceIdentity(evidence.source_identity, "generated-overlap source identity");
  } catch {
    throw sourceProcessFailure("generated-overlap", "generated-overlap source identity is incomplete", "failed");
  }
  if (
    evidence.schemaVersion !== schema
    || evidence.status !== "pass"
    || evidence.reader?.observed !== true
    || evidence.reader?.all_observations_complete !== true
    || evidence.reader?.identity_mismatches !== 0
    || evidence.reader?.surface_validation_failures !== 0
    || typeof evidence.generation !== "string"
    || typeof evidence.build_root !== "string"
    || evidence.activation_evidence?.checks !== RELEASE_MODEL.activationConjunction.checkIds.length
    || !/^[0-9a-f]{64}$/.test(evidence.activation_evidence?.digest ?? "")
    || evidence.activation_evidence?.path !== `private-build/${evidence.generation}/activation-evidence.json`
    || activationPackageIdentityViolations(evidence.activation_evidence?.package_identity).length !== 0
    || evidence.activation_evidence?.package_snapshot?.schemaVersion !== PACKAGE_SNAPSHOT_SCHEMA
    || evidence.activation_evidence?.package_snapshot?.path !== PACKAGE_SNAPSHOT_DIRECTORY
    || evidence.activation_evidence?.package_snapshot?.identityDigest !== evidence.activation_evidence?.package_identity?.identityDigest
    || !/^[a-f0-9]{64}$/.test(evidence.activation_evidence?.child_evidence?.source?.digest ?? "")
    || !/^source-owner-[a-f0-9]{64}\.json$/.test(evidence.activation_evidence?.child_evidence?.source?.path ?? "")
    || !/^[a-f0-9]{64}$/.test(evidence.activation_evidence?.child_evidence?.package?.digest ?? "")
    || !/^package-owner-[a-f0-9]{64}\.json$/.test(evidence.activation_evidence?.child_evidence?.package?.path ?? "")
    || evidence.activation_evidence?.child_evidence?.package?.digest !== evidence.activation_evidence?.package_identity?.packageEvidenceDigest
    || evidence.activation_evidence?.child_evidence?.packageIdentity?.digest !== evidence.activation_evidence?.package_identity?.identityDigest
    || !/^package-identity-[a-f0-9]{64}\.json$/.test(evidence.activation_evidence?.child_evidence?.packageIdentity?.path ?? "")
    || !/^[a-f0-9]{64}$/.test(evidence.activation_evidence?.child_evidence?.generated?.digest ?? "")
    || evidence.activation_evidence?.child_evidence?.generated?.path !== "embedded:generated-owner"
    || !["source", "package", "stress", "performance", "capacity"].every(
      (name) => Number.isInteger(evidence.inventory?.[name]) && evidence.inventory[name] >= 0,
    )
  ) {
    throw sourceProcessFailure("generated-overlap", "generated-overlap evidence is incomplete", "failed");
  }
  for (const name of OVERLAP_PARTICIPANTS) {
    const participant = evidence.participants?.[name];
    if (
      !isGovernedParticipantCommand(name, participant?.command, gates.get(name).command, evidence.build_root)
      || !Number.isFinite(participant?.elapsedMs)
      || participant.elapsedMs < 0
    ) {
      throw sourceProcessFailure("generated-overlap", `generated-overlap did not execute the exact ${name} command`, "failed");
    }
  }
  if (
    evidence.participants.source.files !== evidence.inventory.source
    || evidence.participants.package.files !== evidence.inventory.package
    || !Number.isInteger(evidence.participants.source.tests)
    || !Number.isInteger(evidence.participants.package.tests)
    || !Array.isArray(evidence.participants.source.pending)
    || !Array.isArray(evidence.participants.package.pending)
    || evidence.participants.build.status !== "pass"
  ) {
    throw sourceProcessFailure("generated-overlap", "generated-overlap inventory or build evidence does not reconcile", "failed");
  }
  return evidence;
}

function parseOverlapEvidence(result, gates) {
  const schema = RELEASE_CONTRACT.qualification.source.overlapEvidenceSchema;
  const records = result.stdout.split("\n").flatMap((line) => {
    try {
      const parsed = JSON.parse(line);
      return parsed?.schemaVersion === schema ? [parsed] : [];
    } catch {
      return [];
    }
  });
  if (records.length !== 1) {
    throw sourceProcessFailure("generated-overlap", "generated-overlap returned invalid JSON evidence", "failed");
  }
  return validateOverlapEvidence(records[0], gates);
}

function generatedState(buildRoot, generation, sourceIdentity) {
  if (!sameGeneratedSourceIdentity(readGeneratedSourceIdentity(buildRoot), sourceIdentity)) {
    throw sourceProcessFailure("reader-barrier", "private build source identity changed", "failed");
  }
  validateRegularTree(path.join(buildRoot, "dist"), "private generated dist");
  validateRegularTree(path.join(buildRoot, "bundle"), "private generated bundle");
  return {
    generation,
    root: buildRoot,
    leases: [],
  };
}

function outputObservation(result) {
  return {
    stdoutSha256: sha256(result.stdout),
    stdoutBytes: Buffer.byteLength(result.stdout),
    stderrSha256: sha256(result.stderr),
    stderrBytes: Buffer.byteLength(result.stderr),
  };
}

function isOutputObservation(observation) {
  return /^[0-9a-f]{64}$/.test(observation?.stdoutSha256 ?? "")
    && Number.isInteger(observation?.stdoutBytes)
    && observation.stdoutBytes >= 0
    && /^[0-9a-f]{64}$/.test(observation?.stderrSha256 ?? "")
    && Number.isInteger(observation?.stderrBytes)
    && observation.stderrBytes >= 0;
}

function validateSourceGateRecords(records) {
  const governed = sourceGateSet();
  if (!Array.isArray(records) || canonicalJson(records.map((record) => record?.name)) !== canonicalJson(governed.map((gate) => gate.name))) {
    throw new Error("source receipt gates must contain the exact governed gate set in order");
  }
  const gateContracts = new Map(governed.map((gate) => [gate.name, gate]));
  const overlapOrigins = new Set(GENERATED_OVERLAP_ORIGINS);
  const barrierOwners = new Set(SOURCE_BARRIER_B);
  const performanceOwners = new Set(SOURCE_PERFORMANCE_BARRIER);
  const capacityOwners = new Set(SOURCE_CAPACITY_BARRIER);
  for (const record of records) {
    const expectedOrigin = overlapOrigins.has(record.name) ? "generated-overlap" : record.name;
    const expectedPhase = barrierOwners.has(record.name)
      ? "barrier-b"
      : performanceOwners.has(record.name)
        ? "performance-barrier"
        : capacityOwners.has(record.name)
          ? "capacity-barrier"
        : "batch-a";
    const expectedExecuted = OVERLAP_PARTICIPANTS.includes(record.name)
      ? "generated-overlap participant"
      : "command";
    if (
      record.origin !== expectedOrigin
      || record.phase !== expectedPhase
      || record.outcome !== "passed"
      || !Number.isFinite(record.elapsedMs)
      || record.elapsedMs < 0
      || record.executed !== expectedExecuted
      || record.reused !== false
      || !record.observation
      || typeof record.observation !== "object"
      || Array.isArray(record.observation)
    ) {
      throw new Error(`source receipt gate '${record.name}' has invalid execution evidence`);
    }
    const observation = record.observation;
    if (OVERLAP_PARTICIPANTS.includes(record.name)) {
      if (!isGovernedParticipantCommand(record.name, observation.command, gateContracts.get(record.name).command)) {
        throw new Error(`source receipt gate '${record.name}' has the wrong command origin`);
      }
      if (record.name === "build") {
        if (observation.status !== "pass" || typeof observation.generation !== "string" || observation.generation.length === 0) {
          throw new Error("source receipt build observation is incomplete");
        }
      } else if (
        !Number.isInteger(observation.files)
        || observation.files < 0
        || !Number.isInteger(observation.tests)
        || observation.tests < 0
        || !Array.isArray(observation.pending)
      ) {
        throw new Error(`source receipt gate '${record.name}' inventory observation is incomplete`);
      }
    } else if (record.name === "generated-overlap") {
      validateOverlapEvidence(observation, gateContracts);
    } else if (record.name === "performance") {
      if (
        !Number.isInteger(observation.inventoryFiles)
        || observation.inventoryFiles < 0
        || observation.evidence?.schemaVersion !== RELEASE_CONTRACT.qualification.source.performanceEvidenceSchema
        || observation.evidence?.status !== "pass"
        || !/^[0-9a-f]{64}$/.test(observation.evidence?.sha256 ?? "")
        || !Number.isInteger(observation.evidence?.bytes)
        || observation.evidence.bytes < 0
        || !Number.isInteger(observation.evidence?.samples)
        || observation.evidence.samples < 0
        || !observation.evidence?.maxima
        || !observation.evidence?.runner
        || observation.evidence.runner.authority?.authoritative !== true
        || typeof observation.evidence.runner.authority?.identity !== "string"
        || observation.evidence.runner.authority.identity.length === 0
      ) {
        throw new Error("source receipt performance observation is incomplete");
      }
    } else {
      if (!isOutputObservation(observation)) {
        throw new Error(`source receipt gate '${record.name}' output observation is incomplete`);
      }
      if (["stress", "capacity"].includes(record.name) && (!Number.isInteger(observation.inventoryFiles) || observation.inventoryFiles < 0)) {
        throw new Error(`source receipt ${record.name} inventory observation is incomplete`);
      }
      if (barrierOwners.has(record.name) && (typeof observation.generation !== "string" || observation.generation.length === 0)) {
        throw new Error(`source receipt gate '${record.name}' generation observation is incomplete`);
      }
    }
  }
}

function validateSourceReceiptSemantics(receipt) {
  if (receipt.schemaVersion !== RECEIPT_SCHEMA) throw new Error("source receipt schema is invalid");
  if (receipt.kind !== "source") throw new Error("source receipt kind is invalid");
  validateSourceGateRecords(receipt.gates);
  if (canonicalJson(receipt.component?.gates) !== canonicalJson(sourceGateSet())) {
    throw new Error("source receipt component does not bind the governed gate set");
  }
}

function performanceObservation(result, inventoryFiles, requireAuthoritative) {
  const schema = RELEASE_CONTRACT.qualification.source.performanceEvidenceSchema;
  const records = performanceEvidenceRecords(result.stdout, schema);
  if (records.length !== 1 || records[0].status !== "pass") {
    throw sourceProcessFailure("performance", "performance owner returned no unique passing evidence record", "failed");
  }
  const record = records[0];
  if (requireAuthoritative && record.runner?.authority?.authoritative !== true) {
    throw sourceProcessFailure(
      "performance",
      "authoritative performance evidence requires the pinned remote runner identity declared by verification policy",
      "failed",
    );
  }
  return {
    inventoryFiles,
    evidence: {
      schemaVersion: record.schemaVersion,
      status: record.status,
      sha256: sha256(`${JSON.stringify(record)}\n`),
      bytes: Buffer.byteLength(`${JSON.stringify(record)}\n`),
      samples: Array.isArray(record.samples) ? record.samples.length : 0,
      maxima: record.maxima,
      runner: record.runner,
    },
  };
}

async function executeSourceQualificationDag(options, overlapRoot) {
  const repo = options.repo ?? REPO_ROOT;
  const gateSet = governedSourceGates(options.gates);
  const gates = sourceGateMap(gateSet);
  const clock = options.clock ?? (() => performance.now());
  const wallClock = options.wallClock ?? (() => Date.now());
  const started = options.startedAt ?? clock();
  const deadlineMs = RELEASE_MODEL.sourceQualificationMs;
  const cleanupMarginMs = SOURCE_DAG.overlapCleanupMarginMs;
  const reconciliationMarginMs = SOURCE_DAG.overlapParentReconciliationMarginMs;
  const remaining = () => Math.floor(deadlineMs - (clock() - started));
  const sourceDeadlineEpochMs = wallClock() + remaining();
  const runConcurrent = options.runConcurrent ?? runConcurrentSourceOwners;
  const common = {
    repo,
    createState: options.createState,
    startOwner: options.startOwner,
    environment: options.environment,
  };
  const batchStarted = clock();
  const batchTimeout = remaining();
  if (batchTimeout <= cleanupMarginMs) {
    throw sourceProcessFailure("full-qualification", "source verification has no safe overlap execution window before its cleanup margin", "failed");
  }
  const batch = await runConcurrent(SOURCE_BATCH_A.map((name) => ({
    name,
    command: gates.get(name).command,
    repo,
    timeoutMs: batchTimeout - (name === "generated-overlap" ? cleanupMarginMs : reconciliationMarginMs),
    cancellable: name !== "generated-overlap",
    cooperativeStop: name === "generated-overlap",
    environment: name === "generated-overlap" ? {
      AGENTERA_SOURCE_DEADLINE_EPOCH_MS: String(sourceDeadlineEpochMs),
      AGENTERA_SOURCE_CLEANUP_MARGIN_MS: String(cleanupMarginMs),
      AGENTERA_GENERATED_OVERLAP_ROOT: overlapRoot,
    } : undefined,
  })), common);
  const batchElapsedMs = Math.max(0, Math.round(clock() - batchStarted));
  const overlap = parseOverlapEvidence(batch["generated-overlap"], gates);
  const expectedBuildRoot = path.join(overlapRoot, "private-build", overlap.generation);
  if (overlap.build_root !== expectedBuildRoot) {
    throw sourceProcessFailure("generated-overlap", "generated-overlap returned a build outside its parent-owned root", "failed");
  }
  const readState = options.readGeneratedState ?? (() => generatedState(overlap.build_root, overlap.generation, overlap.source_identity));
  const afterBatch = readState(repo);
  if (afterBatch.generation !== overlap.generation || afterBatch.leases.length !== 0) {
    throw sourceProcessFailure("reader-barrier", "generated-overlap did not settle one lease-free generation", "failed");
  }
  const performanceStarted = clock();
  const performanceRemaining = remaining();
  if (performanceRemaining <= reconciliationMarginMs) {
    throw sourceProcessFailure("performance", "source verification has no safe performance execution window before reconciliation", "failed");
  }
  const performanceResult = (await runConcurrent(SOURCE_PERFORMANCE_BARRIER.map((name) => ({
    name,
    command: gates.get(name).command,
    repo,
    timeoutMs: performanceRemaining - reconciliationMarginMs,
    cancellable: true,
    environment: { AGENTERA_SOURCE_DEADLINE_EPOCH_MS: String(sourceDeadlineEpochMs) },
  })), common)).performance;
  const performanceElapsedMs = Math.max(0, Math.round(clock() - performanceStarted));
  const performanceEvidence = performanceObservation(
    performanceResult,
    overlap.inventory.performance,
    options.requireAuthoritativePerformance === true,
  );
  const afterPerformance = readState(repo);
  if (afterPerformance.generation !== afterBatch.generation || afterPerformance.leases.length !== 0) {
    throw sourceProcessFailure("performance", "performance barrier changed the settled generation or retained leases", "failed");
  }
  const capacityStarted = clock();
  const capacityRemaining = remaining();
  if (capacityRemaining <= reconciliationMarginMs) {
    throw sourceProcessFailure("capacity", "source verification has no safe capacity execution window before reconciliation", "failed");
  }
  const capacityResult = (await runConcurrent(SOURCE_CAPACITY_BARRIER.map((name) => ({
    name,
    command: gates.get(name).command,
    repo,
    timeoutMs: capacityRemaining - reconciliationMarginMs,
    cancellable: true,
    environment: { AGENTERA_SOURCE_DEADLINE_EPOCH_MS: String(sourceDeadlineEpochMs) },
  })), common)).capacity;
  const capacityElapsedMs = Math.max(0, Math.round(clock() - capacityStarted));
  const beforeBarrier = readState(repo);
  if (beforeBarrier.generation !== afterPerformance.generation || beforeBarrier.leases.length !== 0) {
    throw sourceProcessFailure("capacity", "capacity barrier changed the settled generation or retained leases", "failed");
  }
  const barrierStarted = clock();
  const barrierTimeout = remaining();
  const requiredBarrierWindowMs = Math.max(...SOURCE_BARRIER_B.map((name) => SOURCE_DAG.minimumExecutionWindowMs[name]));
  if (barrierTimeout < requiredBarrierWindowMs + reconciliationMarginMs) {
    throw sourceProcessFailure(
      "reader-barrier",
      `source verification requires ${requiredBarrierWindowMs}ms for barrier B plus ${reconciliationMarginMs}ms reconciliation; ${barrierTimeout}ms remain`,
      "failed",
    );
  }
  const freshGenerationRoot = beforeBarrier.root ?? overlap.build_root;
  const freshCli = path.join(freshGenerationRoot, "dist/bin/agentera.js");
  let barrier;
  let barrierFailure;
  try {
    barrier = await runConcurrent(SOURCE_BARRIER_B.map((name) => ({
      name,
      command: gates.get(name).command[0] === "node"
        ? ["node", freshCli, ...gates.get(name).command.slice(2)]
        : gates.get(name).command,
      repo,
      timeoutMs: Math.max(SOURCE_DAG.minimumExecutionWindowMs[name], barrierTimeout - reconciliationMarginMs),
      cancellable: true,
      environment: {
        AGENTERA_BOOTSTRAP_SOURCE_ROOT: repo,
        AGENTERA_ACTIVATION_GENERATION_ID: beforeBarrier.generation,
        AGENTERA_ACTIVATION_GENERATION_ROOT: freshGenerationRoot,
        AGENTERA_ACTIVATION_EVIDENCE_DIGEST: overlap.activation_evidence.digest,
        AGENTERA_ACTIVATION_PACKAGE_IDENTITY: JSON.stringify(overlap.activation_evidence.package_identity),
      },
    })), common);
  } catch (error) {
    barrierFailure = error;
  }
  try {
    if (beforeBarrier.root) removeRetainedPackageSnapshot(freshGenerationRoot);
  } catch {
    if (!barrierFailure) throw sourceProcessFailure("reader-barrier", "retained package snapshot cleanup failed", "failed");
  }
  if (barrierFailure) throw barrierFailure;
  const barrierElapsedMs = Math.max(0, Math.round(clock() - barrierStarted));
  const afterBarrier = readState(repo);
  if (afterBarrier.generation !== beforeBarrier.generation || afterBarrier.leases.length !== 0) {
    throw sourceProcessFailure("reader-barrier", "barrier B changed the selected generation or retained leases", "failed");
  }
  const elapsedMs = Math.max(0, Math.round(clock() - started));
  if (elapsedMs >= deadlineMs) {
    throw sourceProcessFailure("full-qualification", `source verification exceeded its ${deadlineMs}ms budget`, "failed");
  }
  const unattributedElapsedMs = elapsedMs - batchElapsedMs - performanceElapsedMs - capacityElapsedMs - barrierElapsedMs;
  if (unattributedElapsedMs < 0) {
    throw sourceProcessFailure("full-qualification", "source verification phase timings do not reconcile", "failed");
  }
  const originEntries = Object.fromEntries(OVERLAP_PARTICIPANTS.map((name) => [name, {
    name,
    origin: "generated-overlap",
    phase: "batch-a",
    outcome: "passed",
    elapsedMs: Math.round(overlap.participants[name].elapsedMs),
    executed: "generated-overlap participant",
    reused: false,
    observation: name === "build"
      ? {
          command: overlap.participants.build.command,
          status: overlap.participants.build.status,
          generation: overlap.generation,
        }
      : {
          command: overlap.participants[name].command,
          files: overlap.participants[name].files,
          tests: overlap.participants[name].tests,
          pending: overlap.participants[name].pending,
        },
  }]));
  const entries = {
    ...originEntries,
    "generated-overlap": {
      name: "generated-overlap",
      origin: "generated-overlap",
      phase: "batch-a",
      outcome: "passed",
      elapsedMs: batch["generated-overlap"].elapsedMs,
      executed: "command",
      reused: false,
      observation: overlap,
    },
    stress: {
      name: "stress",
      origin: "stress",
      phase: "batch-a",
      outcome: "passed",
      elapsedMs: batch.stress.elapsedMs,
      executed: "command",
      reused: false,
      observation: { inventoryFiles: overlap.inventory.stress, ...outputObservation(batch.stress) },
    },
    performance: {
      name: "performance",
      origin: "performance",
      phase: "performance-barrier",
      outcome: "passed",
      elapsedMs: performanceResult.elapsedMs,
      executed: "command",
      reused: false,
      observation: performanceEvidence,
    },
    capacity: {
      name: "capacity",
      origin: "capacity",
      phase: "capacity-barrier",
      outcome: "passed",
      elapsedMs: capacityResult.elapsedMs,
      executed: "command",
      reused: false,
      observation: { inventoryFiles: overlap.inventory.capacity, ...outputObservation(capacityResult) },
    },
    typecheck: {
      name: "typecheck",
      origin: "typecheck",
      phase: "batch-a",
      outcome: "passed",
      elapsedMs: batch.typecheck.elapsedMs,
      executed: "command",
      reused: false,
      observation: outputObservation(batch.typecheck),
    },
    compact: {
      name: "compact",
      origin: "compact",
      phase: "barrier-b",
      outcome: "passed",
      elapsedMs: barrier.compact.elapsedMs,
      executed: "command",
      reused: false,
      observation: { generation: afterBarrier.generation, ...outputObservation(barrier.compact) },
    },
    "capability-contract": {
      name: "capability-contract",
      origin: "capability-contract",
      phase: "barrier-b",
      outcome: "passed",
      elapsedMs: barrier["capability-contract"].elapsedMs,
      executed: "command",
      reused: false,
      observation: { generation: afterBarrier.generation, ...outputObservation(barrier["capability-contract"]) },
    },
    "activation-conjunction": {
      name: "activation-conjunction",
      origin: "activation-conjunction",
      phase: "barrier-b",
      outcome: "passed",
      elapsedMs: barrier["activation-conjunction"].elapsedMs,
      executed: "command",
      reused: false,
      observation: { generation: afterBarrier.generation, ...outputObservation(barrier["activation-conjunction"]) },
    },
  };
  return {
    gates: gateSet.map((gate) => entries[gate.name]),
    execution: {
      strategy: "parallel-overlap-dag",
      deadlineMs,
      overlapCleanupMarginMs: cleanupMarginMs,
      overlapParentReconciliationMarginMs: SOURCE_DAG.overlapParentReconciliationMarginMs,
      elapsedMs,
      batchAElapsedMs: batchElapsedMs,
      performanceElapsedMs,
      capacityElapsedMs,
      barrierBElapsedMs: barrierElapsedMs,
      unattributedElapsedMs,
      reconciled: batchElapsedMs + performanceElapsedMs + capacityElapsedMs + barrierElapsedMs + unattributedElapsedMs === elapsedMs,
      generation: afterBarrier.generation,
      leasesAfterBarrier: afterBarrier.leases.length,
      activationEvidence: overlap.activation_evidence,
    },
  };
}

export async function runSourceQualificationDag(options = {}) {
  const overlapRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-release-overlap-"));
  try {
    return await executeSourceQualificationDag(options, overlapRoot);
  } finally {
    fs.rmSync(overlapRoot, { recursive: true, force: true });
  }
}

export async function issueSourceReceipt(options = {}) {
  const repo = options.repo ?? REPO_ROOT;
  const clock = options.clock ?? (() => performance.now());
  const started = clock();
  const gates = governedSourceGates(options.gates);
  assertCleanCommittedTree(repo);
  const candidateDirectory = assertExternalDirectory(options.candidateDirectory, repo);
  const identity = sourceComponentIdentity({
    repo,
    gates,
    toolchain: options.toolchain,
    probeToolVersion: options.probeToolVersion,
  });
  const file = receiptPath(candidateDirectory, "source-receipt.json");
  if (fs.existsSync(file)) {
    const existing = validReceiptDigest(readJson(file, "source receipt"), "source receipt");
    validateSourceReceiptSemantics(existing);
    if (existing.component?.sha256 !== identity.sha256) {
      throw new Error("source receipt inputs changed; use a new empty artifact directory and rerun source verification");
    }
    return { receipt: existing, reused: true, gates: [] };
  }
  assertSourceQualificationWorkflowAuthority(repo, options.environment ?? process.env, options.adapterName);
  const qualification = await (options.runDag ?? runSourceQualificationDag)({
    ...options,
    repo,
    gates,
    startedAt: started,
    requireAuthoritativePerformance: true,
  });
  const receipt = {
    schemaVersion: RECEIPT_SCHEMA,
    kind: "source",
    component: identity,
    gates: qualification.gates,
    execution: qualification.execution,
  };
  validateSourceGateRecords(receipt.gates);
  receipt.receiptSha256 = receiptDigest(receipt);
  writeImmutableJson(file, receipt, "source receipt");
  return { receipt, reused: false, gates: qualification.gates };
}

export function sourceQualificationGateIdentity() {
  return sha256(canonicalJson({
    gates: sourceGateSet(),
    dag: {
      batchA: SOURCE_BATCH_A,
      performanceBarrier: SOURCE_PERFORMANCE_BARRIER,
      capacityBarrier: SOURCE_CAPACITY_BARRIER,
      barrierB: SOURCE_BARRIER_B,
      generatedOverlapOrigins: GENERATED_OVERLAP_ORIGINS,
    },
    activation: RELEASE_CONTRACT.qualification.source.activationConjunction.gateIdentity,
  }));
}

/** Run the receipt-qualified DAG against the current tree without issuing authority. */
export async function runSourceConjunction(options = {}) {
  const repo = options.repo ?? REPO_ROOT;
  const started = performance.now();
  const gates = governedSourceGates(options.gates);
  try {
    const result = await (options.runDag ?? runSourceQualificationDag)({
      ...options,
      repo,
      gates,
      startedAt: started,
      environment: {
        ...process.env,
        ...options.environment,
        AGENTERA_OFFLINE: "1",
        AGENTERA_ISOLATION_TMP_ROOT: process.env.AGENTERA_ISOLATION_TMP_ROOT ?? process.env.TMPDIR ?? os.tmpdir(),
      },
    });
    return {
      schemaVersion: "agentera.releaseConjunction.v1",
      gate_identity: sourceQualificationGateIdentity(),
      status: "pass",
      gate_count: gates.length,
      gates: result.gates.map(({ name, phase, outcome, elapsedMs, origin }) => ({ name, phase, outcome, elapsedMs, origin })),
      execution: result.execution,
      first_failure: null,
      owner: null,
      correction: null,
      generated_artifact: {
        generation: result.execution.generation,
        path: `private-build/${result.execution.generation}/dist/bin/agentera.js`,
      },
      side_effects: { receipt: false, candidate: false, registry: false, activation: false, publication: false },
    };
  } catch (error) {
    const owner = error?.owner ?? "full-qualification";
    const gate = gates.find((entry) => entry.name === owner);
    return {
      schemaVersion: "agentera.releaseConjunction.v1",
      gate_identity: sourceQualificationGateIdentity(),
      status: "fail",
      gate_count: gates.length,
      gates: [],
      execution: { elapsedMs: Math.max(0, Math.round(performance.now() - started)) },
      first_failure: owner,
      owner: gate?.owner ?? `packages/cli/scripts/release-qualification.mjs#${owner}`,
      violation: sourceDiagnostic(error instanceof Error ? error.message : error),
      correction: gate?.correction ?? (gate ? gate.command.join(" ") : "pnpm -C packages/cli run verify:release"),
      generated_artifact: null,
      side_effects: { receipt: false, candidate: false, registry: false, activation: false, publication: false },
    };
  }
}

export function validateSourceReceipt(options = {}) {
  const receipt = validReceiptDigest(options.receipt, "source receipt");
  validateSourceReceiptSemantics(receipt);
  const identity = sourceComponentIdentity({ ...options, gates: sourceGateSet() });
  if (receipt.component?.sha256 !== identity.sha256) {
    throw new Error("source receipt no longer matches current component inputs");
  }
  return receipt;
}

export function checkSourceReceipt(options = {}) {
  const repo = options.repo ?? REPO_ROOT;
  const candidateDirectory = assertExternalDirectory(options.candidateDirectory, repo, false);
  const file = containedRegularReceipt(candidateDirectory, "source-receipt.json", "source receipt");
  assertStagedSourceMatchesWorking(repo);
  return validateSourceReceipt({
    ...options,
    repo,
    receipt: readJson(file, "source receipt"),
  });
}

function ensureRegularArtifact(directory, filename) {
  if (path.basename(filename) !== filename) throw new Error("package artifact filename must not contain a path");
  const artifact = path.join(directory, filename);
  const stat = fs.lstatSync(artifact);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("package artifact must be a regular file");
  const resolved = fs.realpathSync(artifact);
  if (path.dirname(resolved) !== directory) throw new Error("package artifact escapes its artifact directory");
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

function candidateManifest(adapterName, repo = REPO_ROOT, sourceCommit) {
  const manifest = readManifest(adapterName, repo);
  if (sourceCommit) {
    if (adapterName !== "development") throw new Error("source identity injection supports only development");
    manifest.agentera = { ...manifest.agentera, gitRef: sourceCommit };
  }
  const adapter = RELEASE_CONTRACT.packages[adapterName];
  const expectedDevelopment = adapterName === "development";
  const validVersion = expectedDevelopment
    ? /^\d+\.\d+\.\d+-dev\.(?:0|[1-9]\d*)$/.test(manifest.version)
    : /^\d+\.\d+\.\d+$/.test(manifest.version);
  if (!validVersion) throw new Error(`${adapterName} manifest version is outside its release policy`);
  if (!/^[0-9a-f]{40}$/.test(manifest.agentera?.gitRef ?? "")) {
    throw new Error("package manifest has no immutable 40-character agentera.gitRef");
  }
  if (spawnSync("git", ["cat-file", "-e", `${manifest.agentera.gitRef}^{commit}`], {
    cwd: repo,
    env: npmChildEnvironment(process.env),
  }).status !== 0) {
    throw new Error("package manifest agentera.gitRef does not name an existing commit");
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
  const tmp = path.join(root, "tmp");
  const npmrc = path.join(root, "npmrc");
  const globalNpmrc = path.join(root, "global-npmrc");
  const offline = options.offline === true || options.environment?.AGENTERA_OFFLINE === "1";
  for (const directory of [home, cache, tmp, path.join(root, "data"), path.join(root, "config"), path.join(root, "state"), path.join(root, "agentera"), path.join(root, "reports"), path.join(root, "output")]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const registry = offline ? `file://${path.join(root, "registry")}` : "https://registry.npmjs.org/";
  fs.writeFileSync(npmrc, `registry=${registry}\n${offline ? "offline=true\n" : ""}${ignoreScripts ? "ignore-scripts=true\n" : ""}`, { mode: 0o600, flag: "wx" });
  fs.writeFileSync(
    globalNpmrc,
    options.registryInGlobalConfig ? `registry=${registry}\n` : "",
    { mode: 0o600, flag: "wx" },
  );
  return {
    root,
    environment: {
      ...npmChildEnvironment(options.environment ?? process.env, npmrc),
      HOME: home,
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_CACHE_HOME: cache,
      XDG_STATE_HOME: path.join(root, "state"),
      TMPDIR: tmp,
      AGENTERA_HOME: path.join(root, "agentera"),
      AGENTERA_REPORT_ROOT: path.join(root, "reports"),
      AGENTERA_OUTPUT_ROOT: path.join(root, "output"),
      NPM_CONFIG_CACHE: cache,
      NPM_CONFIG_USERCONFIG: npmrc,
      NPM_CONFIG_GLOBALCONFIG: globalNpmrc,
      ...(offline ? { NPM_CONFIG_OFFLINE: "true" } : {}),
      NPM_CONFIG_AUDIT: "false",
      NPM_CONFIG_FUND: "false",
      NO_UPDATE_NOTIFIER: "1",
      DO_NOT_TRACK: "1",
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

function releaseMetadataGate(repo, adapterName, manifest, execute = run) {
  execute(process.execPath, ["packages/cli/dist/bin/agentera.js", "check", "validate", "release-metadata"], {
    cwd: repo,
    env: {
      ...npmChildEnvironment(process.env),
      AGENTERA_RELEASE_ADAPTER: adapterName,
      ...(adapterName === "development" ? {
        AGENTERA_RELEASE_PACKAGE_VERSION: manifest.version,
        AGENTERA_RELEASE_GIT_REF: manifest.agentera.gitRef,
      } : {}),
    },
    timeout: RELEASE_CONTRACT.benchmark.timeouts.sourceQualificationMs,
  });
}

function monotonicDuration(started, ended, label) {
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) {
    throw new Error(`${label} returned invalid monotonic timing`);
  }
  return Math.floor(ended - started);
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
    return executeJson(
      process.execPath,
      [
        "scripts/pack-package.mjs", "--output-dir", candidateDirectory, "--with-dry-run", "--json",
        "--git-ref", manifest.agentera.gitRef,
      ],
      { cwd: packageRoot, run: execute },
    );
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

function validateCandidateReceiptSemantics(receipt) {
  if (receipt.schemaVersion !== RECEIPT_SCHEMA) throw new Error("package receipt schema is invalid");
  if (receipt.kind !== "candidate") throw new Error("package receipt kind must be 'candidate'");
  const expectedGates = RELEASE_CONTRACT.qualification.candidate.gates;
  if (
    !Array.isArray(receipt.gates)
    || canonicalJson(receipt.gates.map((gate) => gate?.name)) !== canonicalJson(expectedGates)
  ) {
    throw new Error("package receipt gates must contain the exact governed gate set in order");
  }
  for (const gate of receipt.gates) {
    if (
      gate.outcome !== "passed"
      || !Number.isSafeInteger(gate.elapsedMs)
      || gate.elapsedMs < 0
      || gate.executed !== "ordered"
      || gate.reused !== false
      || (gate.name === "local-exact-artifact-smoke"
        && (typeof gate.output !== "string" || !gate.output.includes(receipt.version)))
    ) {
      throw new Error(`package receipt gate '${gate.name}' has invalid execution evidence`);
    }
  }
  const ownerElapsedMs = receipt.gates.reduce((total, gate) => total + gate.elapsedMs, 0);
  const execution = receipt.execution;
  if (
    execution?.strategy !== "ordered-non-overlapping"
    || !Number.isSafeInteger(execution.elapsedMs)
    || execution.elapsedMs < 0
    || !Number.isSafeInteger(execution.ownerElapsedMs)
    || execution.ownerElapsedMs !== ownerElapsedMs
    || !Number.isSafeInteger(execution.unattributedElapsedMs)
    || execution.unattributedElapsedMs < 0
    || execution.reconciled !== true
    || execution.ownerElapsedMs + execution.unattributedElapsedMs !== execution.elapsedMs
  ) {
    throw new Error("package receipt execution timing does not reconcile");
  }
  const construction = receipt.artifact?.construction;
  if (
    construction?.name !== receipt.package
    || construction?.version !== receipt.version
    || !Number.isSafeInteger(construction.fileCount)
    || construction.fileCount < 1
    || !Number.isSafeInteger(construction.packedSize)
    || construction.packedSize !== receipt.artifact?.bytes
    || !Number.isSafeInteger(construction.unpackedSize)
    || construction.unpackedSize < 0
    || typeof construction.shasum !== "string"
    || construction.shasum.length === 0
  ) {
    throw new Error("package receipt construction observation is incomplete");
  }
}

export function issueCandidateReceipt(options = {}) {
  const clock = options.clock ?? (() => performance.now());
  const candidateStarted = clock();
  const repo = options.repo ?? REPO_ROOT;
  assertCleanCommittedTree(repo);
  const candidateDirectory = assertExternalDirectory(options.candidateDirectory, repo);
  const sourceReceipt = validateSourceReceipt({
    repo,
    receipt: validReceiptDigest(readJson(receiptPath(candidateDirectory, "source-receipt.json"), "source receipt"), "source receipt"),
    toolchain: options.toolchain,
  });
  if (options.targetVersion !== undefined) {
    throw new Error("development candidate does not accept targetVersion; commit the package version in the manifest");
  }
  if (options.sourceCommit !== undefined && !/^[0-9a-f]{40}$/.test(options.sourceCommit)) {
    throw new Error("development candidate --source-commit must be a 40-character commit SHA");
  }
  validateDevelopmentCiCandidateBinding({
    repo,
    adapterName: options.adapterName,
    sourceCommit: options.sourceCommit,
    environment: options.environment ?? process.env,
  });
  const { adapter, manifest } = candidateManifest(options.adapterName, repo, options.sourceCommit);
  const metadataCommit = git(["rev-parse", "HEAD"], repo);
  const candidateFile = receiptPath(candidateDirectory, "candidate-receipt.json");
  if (fs.existsSync(candidateFile)) {
    const existing = validateCandidateReceipt({ candidateDirectory, adapterName: options.adapterName, repo });
    if (
      options.sourceCommit
      && existing.receipt.sourceCommit !== options.sourceCommit
    ) {
      throw new Error("existing package receipt does not match the requested development metadata");
    }
    return { receipt: existing.receipt, reused: true };
  }

  const execute = options.run ?? run;
  const metadataStarted = clock();
  try {
    releaseMetadataGate(repo, options.adapterName, manifest, options.metadataRun);
  } catch (error) {
    if (error && typeof error === "object") error.owner ??= "release-metadata";
    throw error;
  }
  const metadataEnded = clock();
  const metadataGate = {
    name: "release-metadata",
    outcome: "passed",
    elapsedMs: monotonicDuration(metadataStarted, metadataEnded, "release-metadata"),
    executed: "ordered",
    reused: false,
  };
  const constructionStarted = clock();
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
    throw new Error("package artifact did not retain the required immutable mode");
  }
  const constructionEnded = clock();
  const constructionGate = {
    name: "dry-pack-observation-equivalence",
    outcome: "passed",
    elapsedMs: monotonicDuration(constructionStarted, constructionEnded, "dry-pack-observation-equivalence"),
    executed: "ordered",
    reused: false,
  };
  const smokeStarted = clock();
  let smokeOutput;
  try {
    smokeOutput = smokeExactArtifact({ artifact: retainedArtifact.artifact, manifest, adapter, run: options.smokeRun });
  } catch (error) {
    if (error && typeof error === "object") error.owner ??= "local-exact-artifact-smoke";
    throw error;
  }
  const smokeEnded = clock();
  const smokeGate = {
    name: "local-exact-artifact-smoke",
    outcome: "passed",
    elapsedMs: monotonicDuration(smokeStarted, smokeEnded, "local-exact-artifact-smoke"),
    executed: "ordered",
    reused: false,
    output: smokeOutput.trim(),
  };
  const candidateEnded = clock();
  const candidateElapsedMs = monotonicDuration(candidateStarted, candidateEnded, "candidate-qualification");
  const ownerElapsedMs = metadataGate.elapsedMs + constructionGate.elapsedMs + smokeGate.elapsedMs;
  const unattributedElapsedMs = candidateElapsedMs - ownerElapsedMs;
  if (unattributedElapsedMs < 0) throw new Error("package verification timing intervals overlap");
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
    gates: [metadataGate, constructionGate, smokeGate],
    execution: {
      strategy: "ordered-non-overlapping",
      elapsedMs: candidateElapsedMs,
      ownerElapsedMs,
      unattributedElapsedMs,
      reconciled: ownerElapsedMs + unattributedElapsedMs === candidateElapsedMs,
    },
  };
  receipt.receiptSha256 = receiptDigest(receipt);
  writeImmutableJson(candidateFile, receipt, "package receipt");
  return { receipt, reused: false };
}

export function validateCandidateReceipt(options = {}) {
  const repo = options.repo ?? REPO_ROOT;
  const candidateDirectory = assertExternalDirectory(options.candidateDirectory, repo, false);
  const receipt = validReceiptDigest(
    options.receipt ?? readJson(
      containedRegularReceipt(candidateDirectory, "candidate-receipt.json", "package receipt"),
      "package receipt",
    ),
    "package receipt",
  );
  validateCandidateReceiptSemantics(receipt);
  const adapterName = options.adapterName ?? receipt.adapter;
  const sourceCommit = adapterName === "development" ? receipt.sourceCommit : undefined;
  const { manifest, adapter } = candidateManifest(adapterName, repo, sourceCommit);
  const source = checkSourceReceipt({ repo, candidateDirectory });
  if (
    receipt.sourceReceiptSha256 !== source.receiptSha256
    || receipt.adapter !== adapterName
    || receipt.metadataCommit !== git(["rev-parse", "HEAD"], repo)
    || receipt.package !== manifest.name
    || receipt.version !== manifest.version
    || receipt.sourceCommit !== manifest.agentera.gitRef
    || receipt.expectedTag !== adapter.expectedTag
    || receipt.candidateTag !== `candidate-${manifest.version}`
    || receipt.registry !== "https://registry.npmjs.org/"
    || receipt.artifact?.dryPackEquivalent !== true
  ) {
    throw new Error("package receipt no longer matches the selected package metadata or source receipt");
  }
  const artifactState = ensureRegularArtifact(candidateDirectory, receipt.artifact?.filename);
  const bytes = fs.readFileSync(artifactState.artifact);
  if (
    receipt.artifact.sha256 !== sha256(bytes)
    || receipt.artifact.integrity !== sha512Integrity(bytes)
    || receipt.artifact.bytes !== bytes.byteLength
    || receipt.artifact.construction.shasum !== createHash("sha1").update(bytes).digest("hex")
  ) {
    throw new Error("package artifact changed after verification");
  }
  if (
    receipt.artifact.mode !== ARTIFACT_MODE
    || (artifactState.stat.mode & 0o777) !== receipt.artifact.mode
  ) {
    throw new Error("package artifact permissions changed after verification");
  }
  return { receipt, artifact: artifactState.artifact, manifest, adapter };
}

export function issueCandidateApproval(options = {}) {
  const approvedBy = options.approvedBy;
  if (typeof approvedBy !== "string" || !/^[A-Za-z0-9_.@/-]{1,120}$/.test(approvedBy)) {
    throw new Error("approval requires a bounded --approved-by principal");
  }
  const candidate = options.candidate ?? validateCandidateReceipt(options);
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
    throw new Error("artifact approval is not bound to this exact package artifact");
  }
  return approval;
}

function validRunId(value) {
  return typeof value === "string" && /^[1-9]\d{0,19}$/.test(value);
}

export function publicationWorkflowIdentity(kind = "development") {
  const ci = RELEASE_CONTRACT.ci;
  const workflow = kind === "stable"
    ? ci?.stablePublicationWorkflow
    : ci?.developmentPublicationWorkflow;
  const ref = kind === "stable"
    ? workflow?.ref
    : workflow?.refAuthority === "ci.developmentPush.ref"
      ? ci?.developmentPush?.ref
      : undefined;
  if (
    !ci?.repository
    || !workflow?.name
    || !workflow?.path
    || typeof ref !== "string"
    || !ref.startsWith("refs/heads/")
    || ref.length === "refs/heads/".length
  ) {
    throw new Error("release publication contract has no publication workflow identity");
  }
  return {
    repository: ci.repository,
    workflow: workflow.name,
    workflowPath: workflow.path,
    ref,
    branch: ref.slice("refs/heads/".length),
    workflowRef: `${ci.repository}/${workflow.path}@${ref}`,
  };
}

function assertQualificationWorkflowEnvironment(environment, adapterName = "development") {
  const expected = publicationWorkflowIdentity(adapterName === "stable" ? "stable" : "development");
  if (
    environment.GITHUB_REPOSITORY !== expected.repository
    || environment.GITHUB_WORKFLOW !== expected.workflow
    || environment.GITHUB_WORKFLOW_REF !== expected.workflowRef
    || !validRunId(environment.GITHUB_RUN_ID)
  ) {
    throw new Error("CI attestation must originate from the contracted verification repository, workflow, workflow ref, and run identity");
  }
  return expected;
}

function assertSourceQualificationWorkflowAuthority(repo, environment, adapterName) {
  if (environment.GITHUB_ACTIONS !== "true") {
    throw new Error("source receipt authority requires the contracted GitHub Actions verification workflow");
  }
  assertQualificationWorkflowEnvironment(environment, adapterName);
  if (environment.GITHUB_SHA !== git(["rev-parse", "HEAD"], repo)) {
    throw new Error("source receipt checkout SHA does not match the committed verification source");
  }
}

export function issueCiAttestation(options = {}) {
  const environment = options.environment ?? process.env;
  if (environment.GITHUB_ACTIONS !== "true") {
    throw new Error("CI attestation can only be issued by a GitHub Actions runner");
  }
  const expected = assertQualificationWorkflowEnvironment(environment, options.adapterName);
  const candidate = options.candidate ?? validateCandidateReceipt(options);
  const checkoutHead = git(["rev-parse", "HEAD"], options.repo ?? REPO_ROOT);
  if (
    environment.GITHUB_SHA !== checkoutHead
    || environment.GITHUB_SHA !== candidate.receipt.metadataCommit
    || (options.adapterName === "development" && environment.GITHUB_SHA !== candidate.receipt.sourceCommit)
  ) {
    throw new Error("CI checkout SHA does not match the package receipt commits");
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
  const adapterName = options.adapterName ?? options.candidate?.receipt?.adapter ?? "development";
  const expected = publicationWorkflowIdentity(adapterName === "stable" ? "stable" : "development");
  if (environment.GITHUB_REPOSITORY !== expected.repository || !validRunId(options.sourceRunId)) {
    throw new Error("CI registry mutation requires the contracted repository and a source verification run identity");
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
    throw new Error("CI attestation is not bound to this package and source run");
  }
  return attestation;
}

async function runCommand(command, flags) {
  const candidateDirectory = requireArgument(flags, "--candidate-dir");
  const adapterName = flags.get("--adapter") ?? "development";
  const sourceCommit = flags.get("--source-commit");
  const manifest = adapterName === "development" && sourceCommit
    ? candidateManifest(adapterName, REPO_ROOT, sourceCommit).manifest
    : readManifest(adapterName);
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
    nextAction: command === "source" ? "run source verification" : "verify the package from the source receipt",
  }), json);
  try {
    const issued = command === "source"
      ? await issueSourceReceipt({ candidateDirectory, adapterName })
      : command === "candidate"
          ? issueCandidateReceipt({
              candidateDirectory,
              adapterName,
              sourceCommit,
              environment: process.env,
            })
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
        ? "build and verify the package from this receipt"
        : command === "candidate"
          ? "record explicit artifact approval before staging"
          : command === "approval"
            ? "stage the approved package"
            : "transfer the verified package to the publication workflow",
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

export function runSourceReceiptCheckCommand(flags, options = {}) {
  const repo = options.repo ?? REPO_ROOT;
  const candidateDirectory = requireArgument(flags, "--candidate-dir");
  const manifest = readManifest("development", repo);
  const json = Boolean(flags.get("--json"));
  const output = options.emit ?? emit;
  const started = performance.now();
  try {
    checkSourceReceipt({
      repo,
      candidateDirectory,
      toolchain: options.toolchain,
      probeToolVersion: options.probeToolVersion,
    });
    const result = phaseResult({
      packageName: manifest.name,
      version: manifest.version,
      phase: "source-receipt-check",
      outcome: "passed",
      elapsedMs: performance.now() - started,
      executed: "none",
      reused: true,
      nextAction: "reuse source evidence for the pre-commit test policy only",
    });
    output(result, json);
    return result;
  } catch (error) {
    output(phaseResult({
      packageName: manifest.name,
      version: manifest.version,
      phase: "source-receipt-check",
      outcome: "failed",
      elapsedMs: performance.now() - started,
      executed: "none",
      reused: false,
      nextAction: "run the existing broader pre-commit test policy",
      detail: redact(error instanceof Error ? error.message : error, candidateDirectory),
    }), json);
    throw error;
  }
}

export async function runNoReceiptVerificationCommand(flags, options = {}) {
  const result = await runSourceConjunction(options);
  const json = Boolean(flags.get("--json"));
  if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else process.stdout.write(`release verification ${result.status}; gates:${result.gate_count}; generation:${result.generated_artifact?.generation ?? "none"}; first failure:${result.first_failure ?? "none"}; correction:${result.correction ?? "none"}\n`);
  if (result.status !== "pass") process.exitCode = 1;
  return result;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!["verify", "source", "source-check", "candidate", "approval", "attest"].includes(command)) {
    throw new Error("usage: release-qualification.mjs <verify|source|source-check|candidate|approval|attest> [--candidate-dir DIR] [--adapter development|stable] [--json]");
  }
  const valueFlags = command === "verify" ? [] : command === "source-check" ? ["--candidate-dir"] : ["--candidate-dir", "--adapter"];
  if (command === "candidate") valueFlags.push("--source-commit");
  if (command === "approval") valueFlags.push("--approved-by", "--source-run-id");
  const flags = parseReleaseFlags(rest, {
    boolean: ["verify", "source-check"].includes(command) ? ["--json"] : ["--json", "--verbose"],
    value: valueFlags,
  });
  if (command === "verify") await runNoReceiptVerificationCommand(flags);
  else if (command === "source-check") runSourceReceiptCheckCommand(flags);
  else await runCommand(command, flags);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`release-qualification: ${redact(error instanceof Error ? error.message : error)}\n`);
    process.exitCode = 1;
  });
}
