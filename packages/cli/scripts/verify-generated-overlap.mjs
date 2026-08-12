#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  generatedSourceIdentity,
  pinGeneratedGeneration,
  sameGeneratedSourceIdentity,
  selectGeneratedGeneration,
} from "./generated-output.mjs";
import { validatePendingTests } from "./overlap-pending.mjs";
import { npmChildEnvironment } from "./package-construction.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const defaultPackageRoot = path.resolve(path.dirname(scriptPath), "..");
const defaultRepoRoot = path.resolve(defaultPackageRoot, "../..");
const participants = {
  source: ["pnpm", "-C", "packages/cli", "run", "test:source"],
  build: ["pnpm", "-C", "packages/cli", "build"],
  package: ["pnpm", "-C", "packages/cli", "run", "verify:package"],
};

function overlapFailure(message) {
  const error = new Error(message);
  error.owner = "generated-overlap";
  error.sourceStatus = "failed";
  return error;
}

export function generatedOverlapParticipantEnvironment(name, environment = process.env) {
  const sourceWorkers = environment.AGENTERA_GENERATED_OVERLAP_SOURCE_WORKERS;
  if (name !== "source" || sourceWorkers === undefined) return {};
  if (!/^[1-9]\d*$/.test(sourceWorkers)) {
    throw overlapFailure("generated-overlap source worker allocation must be a positive integer");
  }
  return { VITEST_MAX_WORKERS: sourceWorkers };
}

export async function writeActivationEvidence({ repoRoot, generationRoot, generation, sourceEvidenceDirectory, packageEvidenceDirectory, packageIdentityDirectory, packageSnapshotDirectory }) {
  const evidence = await import(pathToFileURL(path.join(generationRoot, "dist/validate/activationEvidenceManifest.js")).href);
  const artifacts = await import(pathToFileURL(path.join(generationRoot, "dist/validate/activationArtifactEvidence.js")).href);
  const conjunction = await import(pathToFileURL(path.join(generationRoot, "dist/validate/activationConjunction.js")).href);
  const sourceEvidence = artifacts.readContentAddressedOwnerEvidence(sourceEvidenceDirectory, "source-owner");
  const packageIdentity = artifacts.readContentAddressedPackageIdentity(packageIdentityDirectory);
  const packageEvidence = artifacts.readContentAddressedOwnerEvidence(packageEvidenceDirectory, "package-owner");
  const productionInputs = conjunction.loadActivationProductionInputs(repoRoot, generationRoot);
  const productionEvidence = conjunction.collectActivationProductionEvidence(repoRoot, productionInputs);
  const packageSnapshot = artifacts.installRetainedPackageSnapshot(packageSnapshotDirectory, generationRoot, packageIdentity);
  const assembled = evidence.assembleAndValidateActivationEvidence({
    root: repoRoot,
    generationRoot,
    generation,
    productionInputs,
    productionEvidence,
    packageEvidence,
    expectedPackageIdentity: packageIdentity,
  });
  const manifest = assembled.manifest;
  const target = path.join(generationRoot, evidence.ACTIVATION_EVIDENCE_FILE);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${artifacts.canonicalObservationJson(manifest)}\n`, { flag: "wx", mode: 0o600 });
  fs.renameSync(temporary, target);
  return {
    path: target,
    digest: manifest.manifestDigest,
    checks: manifest.checks.length,
    packageIdentity,
    packageSnapshot,
    childEvidence: {
      source: { path: path.basename(fs.readdirSync(sourceEvidenceDirectory)[0]), digest: sourceEvidence.evidenceDigest },
      package: { path: path.basename(fs.readdirSync(packageEvidenceDirectory)[0]), digest: packageEvidence.evidenceDigest },
      packageIdentity: { path: path.basename(fs.readdirSync(packageIdentityDirectory)[0]), digest: packageIdentity.identityDigest },
      generated: { path: "embedded:generated-owner", digest: manifest.producers.generated.evidenceDigest },
    },
  };
}

function killGroup(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      const tree = spawnSync(
        "taskkill",
        ["/PID", String(child.pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])],
        { windowsHide: true, stdio: "ignore" },
      );
      if (!tree.error && tree.status === 0) return;
      child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function defaultWithDeadline(promise, deadline, label, now) {
  const remaining = Math.floor(deadline - now());
  if (remaining <= 0) return Promise.reject(overlapFailure(`generated-overlap deadline expired before ${label}`));
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(overlapFailure(`generated-overlap deadline expired during ${label}`)), remaining);
    }),
  ]).finally(() => clearTimeout(timer));
}

function startChild({ name, command, repoRoot, root, barrier, cleanupMarginMs, now, sourceIdentity }) {
  const started = now();
  const output = path.join(root, `${name}.log`);
  const stream = fs.createWriteStream(output, { flags: "wx", mode: 0o600 });
  const stateRoot = path.join(root, `${name}-npm-state`);
  const home = path.join(stateRoot, "home");
  const cache = path.join(stateRoot, "cache");
  const userConfig = path.join(stateRoot, "user.npmrc");
  const globalConfig = path.join(stateRoot, "global.npmrc");
  const childTmp = process.env.AGENTERA_ISOLATION_TMP_ROOT
    ? path.join(process.env.AGENTERA_ISOLATION_TMP_ROOT, `.go-${createHash("sha256").update(root).digest("hex").slice(0, 8)}-${name}`)
    : path.join(stateRoot, "tmp");
  const offline = process.env.AGENTERA_OFFLINE === "1";
  for (const directory of [home, cache, path.join(stateRoot, "data"), path.join(stateRoot, "config"), path.join(stateRoot, "state"), childTmp, path.join(stateRoot, "agentera"), path.join(stateRoot, "reports"), path.join(stateRoot, "output")]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const registry = offline ? `file://${path.join(stateRoot, "registry")}` : "https://registry.npmjs.org/";
  fs.writeFileSync(userConfig, `registry=${registry}\n${offline ? "offline=true\n" : ""}`, { mode: 0o600, flag: "wx" });
  fs.writeFileSync(globalConfig, `registry=${registry}\n${offline ? "offline=true\n" : ""}`, { mode: 0o600, flag: "wx" });
  const child = spawn(command[0], command.slice(1), {
    cwd: repoRoot,
    env: {
      ...npmChildEnvironment(process.env, userConfig, globalConfig),
      HOME: home,
      XDG_DATA_HOME: path.join(stateRoot, "data"),
      XDG_CONFIG_HOME: path.join(stateRoot, "config"),
      XDG_CACHE_HOME: cache,
      XDG_STATE_HOME: path.join(stateRoot, "state"),
      TMPDIR: childTmp,
      AGENTERA_HOME: path.join(stateRoot, "agentera"),
      AGENTERA_REPORT_ROOT: path.join(stateRoot, "reports"),
      AGENTERA_OUTPUT_ROOT: path.join(stateRoot, "output"),
      AGENTERA_GENERATED_SOURCE_IDENTITY: JSON.stringify(sourceIdentity),
      NPM_CONFIG_CACHE: cache,
      NPM_CONFIG_OFFLINE: offline ? "true" : "false",
      AGENTERA_VERIFICATION_BARRIER: barrier,
      AGENTERA_VERIFICATION_PARTICIPANT: name,
      ...generatedOverlapParticipantEnvironment(name),
      ...(name === "build" || name === "invocation" ? {} : { AGENTERA_VERIFICATION_RESULT: path.join(root, `${name}.json`) }),
      ...(name === "source" ? { AGENTERA_ACTIVATION_SOURCE_EVIDENCE_OUTPUT: path.join(root, "activation-owner-evidence", "source") } : {}),
      ...(name === "package" ? { AGENTERA_ACTIVATION_PACKAGE_EVIDENCE_OUTPUT: path.join(root, "activation-owner-evidence", "package") } : {}),
      ...(name === "package" ? { AGENTERA_ACTIVATION_PACKAGE_IDENTITY_OUTPUT: path.join(root, "activation-owner-evidence", "package-identity") } : {}),
      ...(name === "package" ? { AGENTERA_ACTIVATION_PACKAGE_SNAPSHOT_OUTPUT: path.join(root, "activation-package-snapshot") } : {}),
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let closed = false;
  let forceTimer;
  let stdout = "";
  let stderr = "";
  const capture = (current, chunk) => `${current}${chunk}`.slice(-1000);
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout = capture(stdout, chunk);
    stream.write(chunk);
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr = capture(stderr, chunk);
    stream.write(chunk);
  });
  const cancel = () => {
    if (closed) return;
    killGroup(child, "SIGTERM");
    forceTimer ??= setTimeout(() => {
      if (!closed) killGroup(child, "SIGKILL");
    }, Math.min(2000, Math.max(1, Math.floor(cleanupMarginMs / 2))));
  };
  const promise = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      closed = true;
      if (forceTimer) clearTimeout(forceTimer);
      stream.end();
      if (code === 0) {
        resolve({
          command,
          elapsedMs: Math.max(0, Math.round(now() - started)),
          log: output,
          stdout: stdout.trim(),
        });
      } else {
        let failures = "";
        const resultFile = path.join(root, `${name}.json`);
        try {
          const report = JSON.parse(fs.readFileSync(resultFile, "utf8"));
          failures = (report.testResults ?? [])
            .filter((suite) => suite.status === "failed")
            .slice(0, 5)
            .map((suite) => `${path.relative(repoRoot, suite.name)}: ${(suite.assertionResults ?? []).filter((assertion) => assertion.status === "failed").slice(0, 3).map((assertion) => `${assertion.fullName ?? assertion.title} [${String(assertion.failureMessages?.[0] ?? "no detail").replace(/\s+/g, " ").slice(0, 240)}]`).join(" | ")}`)
            .join("; ");
        } catch {
          failures = "";
        }
        reject(overlapFailure(`${name} overlap command failed with exit ${code ?? signal ?? "unknown"}; tail: ${(stderr || stdout).trim() || "no output"}; failures: ${failures || "unavailable"}`));
      }
    });
  });
  return {
    name,
    promise: promise.finally(() => fs.rmSync(childTmp, { recursive: true, force: true })),
    cancel,
  };
}

function cleanupGeneratedSurfaces(packageRoot) {
  for (const target of [".agentera-generated", "dist", "bundle"]) {
    fs.rmSync(path.join(packageRoot, target), { recursive: true, force: true });
  }
}

function readReleaseContract(repoRoot) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, "references/adapters/package-publication.json"), "utf8"));
}

function readInventory(packageRoot, timeoutMs) {
  const result = spawnSync(process.execPath, ["scripts/verify-lane.mjs", "inventory", "--json"], {
    cwd: packageRoot,
    encoding: "utf8",
    timeout: Math.max(1, timeoutMs),
  });
  if (result.status !== 0) throw overlapFailure(`verification inventory failed: ${result.stderr || result.stdout || result.error?.message}`);
  return JSON.parse(result.stdout);
}

async function waitForReady(names, barrier, operationDeadline, now) {
  while (!names.every((name) => fs.existsSync(path.join(barrier, `${name}.ready`)))) {
    if (now() >= operationDeadline) throw overlapFailure(`generated-overlap deadline expired while waiting under ${barrier}`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(20, Math.max(1, operationDeadline - now()))));
  }
}

function startReader(packageRoot, sourceIdentity) {
  let observed = false;
  let identityMismatches = 0;
  let surfaceValidationFailures = 0;
  let error;
  const generations = new Set();
  const timer = setInterval(() => {
    try {
      if (!fs.existsSync(path.join(packageRoot, ".agentera-generated", "current"))) return;
      const pinned = pinGeneratedGeneration(packageRoot, { sourceIdentity });
      try {
        const dist = JSON.parse(fs.readFileSync(path.join(pinned.root, "dist", ".agentera-generation.json"), "utf8")).id;
        const bundle = JSON.parse(fs.readFileSync(path.join(pinned.root, "bundle", ".agentera-generation.json"), "utf8")).id;
        if (pinned.id !== dist || pinned.id !== bundle) {
          identityMismatches += 1;
          throw new Error(`reader mixed ${pinned.id}, ${dist}, and ${bundle}`);
        }
        if (pinned.inventory.dist.entries < 1 || pinned.inventory.bundle.entries < 1) {
          surfaceValidationFailures += 1;
          throw new Error(`reader observed an empty generated surface in ${pinned.id}`);
        }
        observed = true;
        generations.add(pinned.id);
      } finally {
        pinned.release();
      }
    } catch (readerError) {
      error ??= readerError;
    }
  }, 10);
  return {
    stop: () => clearInterval(timer),
    evidence: () => ({ observed, identityMismatches, surfaceValidationFailures, generations: [...generations], error }),
  };
}

export async function runGeneratedOverlap(options = {}) {
  const packageRoot = options.packageRoot ?? defaultPackageRoot;
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const now = options.now ?? (() => Date.now());
  const contract = options.contract ?? readReleaseContract(repoRoot);
  const sourceIdentity = options.sourceIdentity ?? generatedSourceIdentity(packageRoot);
  const cleanupMarginMs = contract.qualification.source.dag.overlapCleanupMarginMs;
  const parentReconciliationMarginMs = contract.qualification.source.dag.overlapParentReconciliationMarginMs;
  const suppliedMargin = options.environment?.AGENTERA_SOURCE_CLEANUP_MARGIN_MS ?? process.env.AGENTERA_SOURCE_CLEANUP_MARGIN_MS;
  if (
    !Number.isInteger(cleanupMarginMs)
    || cleanupMarginMs <= 0
    || !Number.isInteger(parentReconciliationMarginMs)
    || parentReconciliationMarginMs <= 0
    || parentReconciliationMarginMs >= cleanupMarginMs
    || (suppliedMargin !== undefined && Number(suppliedMargin) !== cleanupMarginMs)
  ) {
    throw overlapFailure("generated-overlap cleanup margin does not match the release contract");
  }
  const suppliedDeadline = options.environment?.AGENTERA_SOURCE_DEADLINE_EPOCH_MS ?? process.env.AGENTERA_SOURCE_DEADLINE_EPOCH_MS;
  const overallDeadline = suppliedDeadline === undefined
    ? now() + contract.benchmark.timeouts.sourceQualificationMs
    : Number(suppliedDeadline);
  if (!Number.isFinite(overallDeadline) || overallDeadline - now() <= cleanupMarginMs) {
    throw overlapFailure("generated-overlap received no safe source qualification deadline");
  }
  const operationDeadline = overallDeadline - cleanupMarginMs;
  const handoffDeadline = overallDeadline - parentReconciliationMarginMs;
  const ownedSettlementDeadline = operationDeadline
    + Math.floor((cleanupMarginMs - parentReconciliationMarginMs) / 2);
  const root = options.workRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), "agentera-real-overlap-"));
  const barrier = path.join(root, "barrier");
  const cleanupGenerated = options.cleanupGenerated ?? (() => cleanupGeneratedSurfaces(packageRoot));
  const withDeadline = options.withDeadline
    ?? ((promise, deadline, label) => defaultWithDeadline(promise, deadline, label, now));
  const start = options.startParticipant
    ?? ((name, command) => startChild({ name, command, repoRoot, root, barrier, cleanupMarginMs, now, sourceIdentity }));
  const loadInventory = options.loadInventory
    ?? (() => readInventory(packageRoot, operationDeadline - now()));
  const ready = options.waitForReady
    ?? ((names) => waitForReady(names, barrier, operationDeadline, now));
  const policyBytes = options.policyBytes
    ?? fs.readFileSync(path.join(repoRoot, "references/analysis/verification-policy.yaml"));
  const handles = [];
  const observations = [];
  let primaryFailure;
  let failureResolve;
  let stopResolve;
  let reader;
  let passed = false;
  const failureSignal = new Promise((resolve) => { failureResolve = resolve; });
  const stopSignal = new Promise((resolve) => { stopResolve = resolve; });
  const setPrimaryFailure = (error) => {
    if (primaryFailure) return;
    primaryFailure = error?.owner ? error : overlapFailure(error instanceof Error ? error.message : String(error));
    failureResolve(primaryFailure);
  };
  const cancelAll = () => {
    for (const handle of handles) handle.cancel();
  };
  const observe = (handle) => handle.promise.then(
    (value) => ({ status: "fulfilled", value }),
    (error) => {
      setPrimaryFailure(error);
      cancelAll();
      return { status: "rejected", reason: error };
    },
  );
  const settlement = () => Promise.all(observations);
  const awaitWork = (promise, deadline, label) => Promise.race([
    withDeadline(promise, deadline, label),
    failureSignal.then((error) => { throw error; }),
    stopSignal.then((error) => { throw error; }),
  ]);
  const onSigterm = () => stopResolve(overlapFailure("generated-overlap received its cooperative deadline stop"));
  if (options.handleSignals !== false) process.once("SIGTERM", onSigterm);
  try {
    cleanupGenerated();
    if (now() >= operationDeadline) throw overlapFailure("generated-overlap deadline expired before inventory");
    const inventory = loadInventory();
    for (const [name, command] of Object.entries(participants)) {
      if (now() >= operationDeadline) throw overlapFailure(`generated-overlap deadline expired before starting ${name}`);
      const handle = start(name, command);
      handles.push(handle);
      observations.push(observe(handle));
    }
    await awaitWork(Promise.resolve(ready(Object.keys(participants))), operationDeadline, "participant readiness");
    if (now() >= operationDeadline) throw overlapFailure("generated-overlap deadline expired before releasing participants");
    fs.writeFileSync(path.join(barrier, "release"), "release\n");
    reader = options.startReader?.() ?? startReader(packageRoot, sourceIdentity);
    const settled = await awaitWork(settlement(), operationDeadline, "source/build/package settlement");
    const failed = settled.find((entry) => entry.status === "rejected");
    if (failed) throw primaryFailure ?? failed.reason;
    const completed = {};
    for (let index = 0; index < handles.length; index += 1) completed[handles[index].name] = settled[index].value;
    const readerEvidence = reader.evidence();
    reader.stop();
    reader = undefined;
    if (readerEvidence.error) throw overlapFailure(`continuous generated reader failed: ${readerEvidence.error.message}`);
    if (!readerEvidence.observed) throw overlapFailure("continuous generated reader observed no selected generation during full-owner overlap");
    const readOwnerResult = options.readOwnerResult ?? ((owner) => {
      const bytes = fs.readFileSync(path.join(root, `${owner}.json`));
      const expectedFiles = inventory.files[owner];
      const pending = validatePendingTests(owner, bytes, Buffer.from(JSON.stringify(expectedFiles)), policyBytes, repoRoot, process.platform);
      return { files: expectedFiles.length, tests: JSON.parse(bytes.toString("utf8")).numTotalTests, pending };
    });
    if (now() >= operationDeadline) throw overlapFailure("generated-overlap deadline expired before reading source evidence");
    const source = readOwnerResult("source");
    if (now() >= operationDeadline) throw overlapFailure("generated-overlap deadline expired before reading package evidence");
    const packageResult = readOwnerResult("package");
    if (source.files !== inventory.counts.source || packageResult.files !== inventory.counts.package) {
      throw overlapFailure(`real overlap owner count mismatch: ${JSON.stringify({ source, package: packageResult, inventory: inventory.counts })}`);
    }
    if (now() >= operationDeadline) throw overlapFailure("generated-overlap deadline expired before selecting generated output");
    const settledSourceIdentity = generatedSourceIdentity(packageRoot);
    if (!sameGeneratedSourceIdentity(settledSourceIdentity, sourceIdentity)) {
      throw overlapFailure("generated-overlap source changed while owners were executing");
    }
    const selected = (options.selectGeneration ?? (() => selectGeneratedGeneration(packageRoot, { sourceIdentity })))();
    const generationRoot = selected.root ?? path.join(packageRoot, ".agentera-generated/generations", selected.id);
    const activationEvidence = await withDeadline((options.writeActivationEvidence ?? writeActivationEvidence)({
      repoRoot,
      generationRoot,
      generation: selected.id,
      sourceEvidenceDirectory: path.join(root, "activation-owner-evidence", "source"),
      packageEvidenceDirectory: path.join(root, "activation-owner-evidence", "package"),
      packageIdentityDirectory: path.join(root, "activation-owner-evidence", "package-identity"),
      packageSnapshotDirectory: path.join(root, "activation-package-snapshot"),
    }), operationDeadline, "activation evidence manifest");
    if (now() >= operationDeadline) throw overlapFailure("generated-overlap deadline expired before selected CLI invocation");
    const invocation = start("invocation", [process.execPath, path.join(packageRoot, "dist/bin/agentera.js"), "--version"]);
    handles.push(invocation);
    const invocationObservation = observe(invocation);
    observations.push(invocationObservation);
    const invocationResult = await awaitWork(invocationObservation, operationDeadline, "selected CLI invocation");
    if (invocationResult.status === "rejected") throw primaryFailure ?? invocationResult.reason;
    passed = true;
    return {
      schemaVersion: "agentera.generatedOverlapEvidence.v1",
      status: "pass",
      source_identity: sourceIdentity,
      inventory: inventory.counts,
      participants: {
        source: { ...source, command: completed.source.command, elapsedMs: completed.source.elapsedMs },
        package: { ...packageResult, command: completed.package.command, elapsedMs: completed.package.elapsedMs },
        build: { command: completed.build.command, elapsedMs: completed.build.elapsedMs, status: "pass" },
      },
      reader: {
        observed: readerEvidence.observed,
        all_observations_complete: readerEvidence.identityMismatches === 0 && readerEvidence.surfaceValidationFailures === 0,
        identity_mismatches: readerEvidence.identityMismatches,
        surface_validation_failures: readerEvidence.surfaceValidationFailures,
        generations: readerEvidence.generations,
      },
      generation: selected.id,
      activation_evidence: {
        digest: activationEvidence.digest,
        checks: activationEvidence.checks,
        path: `packages/cli/.agentera-generated/generations/${selected.id}/activation-evidence.json`,
        package_identity: activationEvidence.packageIdentity ?? null,
        package_snapshot: activationEvidence.packageSnapshot ?? null,
        child_evidence: activationEvidence.childEvidence ?? null,
      },
      invocation: invocationResult.value.stdout,
    };
  } catch (error) {
    setPrimaryFailure(error);
    cancelAll();
    try {
      await withDeadline(settlement(), ownedSettlementDeadline, "owned process cleanup");
    } catch (cleanupError) {
      if (!primaryFailure) setPrimaryFailure(cleanupError);
    }
    try {
      cleanupGenerated();
    } catch (cleanupError) {
      primaryFailure.cleanupFailure = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    }
    if (now() >= handoffDeadline) primaryFailure.handoffDeadlineExceeded = true;
    throw primaryFailure;
  } finally {
    reader?.stop();
    if (options.handleSignals !== false) process.removeListener("SIGTERM", onSigterm);
    if (passed || options.retainFailureArtifacts === false) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch (cleanupError) {
        if (passed) throw cleanupError;
      }
    }
  }
}

async function main() {
  process.stdout.write(`${JSON.stringify(await runGeneratedOverlap())}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    console.error(`verify-generated-overlap: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
