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
import {
  checkSourceReceipt,
  isolatedNpmState,
  smokePublishedCandidate,
  validateCandidateApproval,
  validateCandidateReceipt,
  validateCiAttestation,
  validateAdapterSourceProvenance,
} from "./release-qualification.mjs";
import { parseReleaseFlags } from "./release-arguments.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");
const contractPath = path.join(repoRoot, "references/adapters/package-publication.json");
export const PUBLICATION_CONTRACT = JSON.parse(fs.readFileSync(contractPath, "utf8"));
export const PACKAGE_ADAPTERS = PUBLICATION_CONTRACT.packages;
const REQUIRED_RESULT_FIELDS = ["package", "version", "expectedTag", "phase", "outcome", "nextAction", "executed"];

function incrementVersion(version, preparation) {
  if (preparation === "incrementDevPrerelease") {
    const match = /^(\d+)\.(\d+)\.(\d+)-dev\.(\d+)$/.exec(version);
    if (!match) throw new Error(`development version '${version}' must match X.Y.Z-dev.N`);
    return `${match[1]}.${match[2]}.${match[3]}-dev.${BigInt(match[4]) + 1n}`;
  }
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`stable version '${version}' must match X.Y.Z`);
  return `${match[1]}.${match[2]}.${BigInt(match[3]) + 1n}`;
}

function result(adapterName, version, phase, outcome, nextAction, detail, execution = {}) {
  const receipt = {
    package: adapterName,
    version,
    expectedTag: PACKAGE_ADAPTERS[adapterName].expectedTag,
    phase,
    outcome,
    elapsedMs: execution.elapsedMs ?? 0,
    executed: execution.executed ?? "ordered",
    reused: execution.reused ?? false,
    nextAction,
  };
  if (detail)
    receipt.detail = String(detail).slice(0, PUBLICATION_CONTRACT.bounds.diagnosticCharacters);
  return receipt;
}

export function formatPublicationResult(receipt) {
  return `${receipt.package}@${receipt.version} ${receipt.expectedTag} ${receipt.phase}: ${receipt.outcome}; ${receipt.executed}; ${receipt.elapsedMs}ms; next: ${receipt.nextAction}${receipt.detail ? `; ${receipt.detail}` : ""}`;
}

export function publicationFailureResult(adapterName, version, fallbackPhase, error) {
  return result(
    adapterName,
    version,
    error.publicationPhase ?? fallbackPhase,
    "failed",
    error.nextAction ?? "Correct the reported failure and retry.",
    redactedDiagnostic(error instanceof Error ? error.message : error),
  );
}

function redactedDiagnostic(value) {
  return String(value)
    .replaceAll(repoRoot, "<repository>")
    .replaceAll(os.homedir(), "<private>")
    .replace(/(?:NPM_TOKEN|NODE_AUTH_TOKEN)=\S+/g, "$1=<redacted>")
    .slice(0, PUBLICATION_CONTRACT.bounds.diagnosticCharacters);
}

export function validateResult(value) {
  const missing = REQUIRED_RESULT_FIELDS.filter(
    (field) => typeof value?.[field] !== "string" || value[field].length === 0,
  );
  if (!Number.isFinite(value?.elapsedMs) || value.elapsedMs < 0) missing.push("elapsedMs");
  if (typeof value?.reused !== "boolean") missing.push("reused");
  return missing;
}

export function prepareMetadata(adapterName, manifest, head) {
  const adapter = PACKAGE_ADAPTERS[adapterName];
  if (!adapter) throw new Error(`unknown package '${adapterName}'; use development or stable`);
  if (!/^[0-9a-f]{40}$/.test(head))
    throw new Error("gitRef source must be a 40-character commit SHA");
  const next = structuredClone(manifest);
  next.version = incrementVersion(next.version, adapter.preparation);
  next.agentera = { ...next.agentera, gitRef: head };
  return {
    manifest: next,
    receipt: result(
      adapterName,
      next.version,
      "preparation",
      "prepared",
      `Review and commit ${adapter.manifestPath}, then run the ${adapterName} publisher with --authorize.`,
    ),
  };
}

export function prepareTargetMetadata(adapterName, manifest, targetVersion, sourceCommit) {
  const adapter = PACKAGE_ADAPTERS[adapterName];
  if (!adapter) throw new Error(`unknown package '${adapterName}'; use development or stable`);
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
    throw new Error("source commit must be a 40-character commit SHA");
  }
  if (manifest.version === targetVersion && manifest.agentera?.gitRef === sourceCommit) {
    return { manifest: structuredClone(manifest), changed: false };
  }
  const expected = incrementVersion(manifest.version, adapter.preparation);
  if (targetVersion !== expected) {
    throw new Error(
      `target version '${targetVersion}' is not the next ${adapterName} version '${expected}'; stale, skipped, and out-of-policy targets are rejected`,
    );
  }
  const next = structuredClone(manifest);
  next.version = targetVersion;
  next.agentera = { ...next.agentera, gitRef: sourceCommit };
  return { manifest: next, changed: true };
}

export function validatePreparedSourceProvenance(adapterName, manifest, projectRoot = repoRoot) {
  const adapter = PACKAGE_ADAPTERS[adapterName];
  if (!adapter) throw new Error(`unknown package '${adapterName}'; use development or stable`);
  validateAdapterSourceProvenance({ repo: projectRoot, adapter, manifest });
}

export function preflightPublication(adapterName, manifest, state) {
  const corrections = [];
  if (!state.authorized) corrections.push("rerun with --authorize");
  if (state.dirty) corrections.push("commit or stash all worktree changes");
  if (!state.metadataCommitted)
    corrections.push(`commit ${PACKAGE_ADAPTERS[adapterName].manifestPath}`);
  if (!publishableVersion(adapterName, manifest.version)) {
    corrections.push(
      adapterName === "development"
        ? "set a development version matching X.Y.Z-dev.N and commit it"
        : "set a stable version matching X.Y.Z and commit it",
    );
  }
  if (!state.gitRefExists)
    corrections.push("set agentera.gitRef to an existing immutable commit and commit it");
  return result(
    adapterName,
    manifest.version,
    "preflight",
    corrections.length === 0 ? "passed" : "failed",
    corrections.length === 0 ? "construct and verify the package" : `${corrections.join("; ")}.`,
  );
}

function run(command, args, options = {}) {
  const invocation = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: options.env ?? npmChildEnvironment(process.env),
    input: options.input,
    timeout: options.timeout ?? PUBLICATION_CONTRACT.bounds.commandTimeoutMs,
    stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
  });
  if (invocation.error) throw invocation.error;
  if (invocation.status !== 0) {
    const diagnostic = (
      invocation.stderr ||
      invocation.stdout ||
      `exit ${invocation.status}`
    ).trim();
    throw new Error(`${command} ${args.join(" ")} failed: ${diagnostic}`);
  }
  return invocation.stdout.trim();
}

function git(args) {
  return run("git", args, { cwd: repoRoot });
}

function emit(receipt, json, verbose = false) {
  const missing = validateResult(receipt);
  if (missing.length) throw new Error(`publication result missing: ${missing.join(", ")}`);
  if (json) {
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } else {
    process.stdout.write(`${formatPublicationResult(receipt)}\n`);
    if (receipt.construction) {
      process.stdout.write(
        `${formatConstruction(receipt.construction, verbose ? "verbose" : "default")}\n`,
      );
    }
  }
}

function readManifest(adapter, projectRoot = repoRoot) {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, adapter.manifestPath), "utf8"));
}

function metadataCommitted(adapter) {
  const tracked = spawnSync("git", ["diff", "--quiet", "HEAD", "--", adapter.manifestPath], {
    cwd: repoRoot,
    env: npmChildEnvironment(process.env),
  });
  return tracked.status === 0;
}

function gitRefExists(gitRef, projectRoot = repoRoot) {
  if (!/^[0-9a-f]{40}$/.test(gitRef ?? "")) return false;
  return spawnSync("git", ["cat-file", "-e", `${gitRef}^{commit}`], {
    cwd: projectRoot,
    env: npmChildEnvironment(process.env),
  }).status === 0;
}

export function prepareReleaseMetadata(adapterName, request, options = {}) {
  const adapter = PACKAGE_ADAPTERS[adapterName];
  if (!adapter) throw new Error(`unknown package '${adapterName}'; use development or stable`);
  const projectRoot = options.repo ?? repoRoot;
  const targetVersion = request.targetVersion;
  const sourceCommit = request.sourceCommit;
  if (adapterName === "development" && targetVersion !== undefined) {
    throw new Error("development prepare does not accept --target-version; commit the package version in the manifest");
  }
  if ((adapterName === "stable" && !targetVersion) || !sourceCommit) {
    throw new Error(
      adapterName === "stable"
        ? "prepare requires --target-version X.Y.Z and --source-commit SHA; preparation never infers a target"
        : "development prepare requires --source-commit SHA",
    );
  }
  if (adapterName === "development") {
    if (!request.candidateDirectory) {
      throw new Error(
        "development prepare requires --candidate-dir DIR containing a current valid source receipt",
      );
    }
    checkSourceReceipt({ repo: projectRoot, candidateDirectory: request.candidateDirectory });
    if (!gitRefExists(sourceCommit, projectRoot)) {
      throw new Error("source commit does not name an existing immutable commit");
    }
    const manifest = readManifest(adapter, projectRoot);
    if (!publishableVersion("development", manifest.version)) {
      throw new Error("development manifest version must match X.Y.Z-dev.N");
    }
    return result(
      adapterName,
      manifest.version,
      "preparation",
      "noop",
      "manifest version is already committed; qualify it with the supplied source identity",
      undefined,
      { executed: "none", reused: true },
    );
  }
  if (!gitRefExists(sourceCommit, projectRoot)) {
    throw new Error("source commit does not name an existing immutable commit");
  }
  const prepared = prepareTargetMetadata(
    adapterName,
    readManifest(adapter, projectRoot),
    targetVersion,
    sourceCommit,
  );
  validatePreparedSourceProvenance(adapterName, prepared.manifest, projectRoot);
  if (request.check) {
    if (prepared.changed) {
      throw new Error(
        "requested target is not prepared; rerun without --check to create the reviewable metadata diff",
      );
    }
    return result(
      adapterName,
      targetVersion,
      "preparation",
      "noop",
      "target metadata already matches; review or qualify it",
      undefined,
      { executed: "none", reused: true },
    );
  }
  if (prepared.changed) {
    fs.writeFileSync(
      path.join(projectRoot, adapter.manifestPath),
      `${JSON.stringify(prepared.manifest, null, 2)}\n`,
    );
  }
  return result(
    adapterName,
    targetVersion,
    "preparation",
    prepared.changed ? "prepared" : "noop",
    prepared.changed
      ? `Review and commit ${adapter.manifestPath}, then qualify the candidate.`
      : "target metadata already matches; review or qualify it",
    undefined,
    prepared.changed ? undefined : { executed: "none", reused: true },
  );
}

const NPM_COMMAND_FAILURE = Symbol("npm-command-failure");

export function parseNpmRegistryJson(output) {
  if (!output) throw new Error("npm registry shape error: empty JSON response");
  try {
    return JSON.parse(output);
  } catch {
    throw new Error("npm registry shape error: invalid JSON response");
  }
}

function npmJson(args, options = {}) {
  const state = options.env ? null : isolatedNpmState("agentera-registry-query-");
  try {
    let output;
    try {
      output = run("npm", [...args, "--json"], {
        ...options,
        env: options.env ?? state.environment,
      });
    } catch (error) {
      if (error && typeof error === "object") error[NPM_COMMAND_FAILURE] = true;
      throw error;
    }
    return parseNpmRegistryJson(output);
  } finally {
    if (state) fs.rmSync(state.root, { recursive: true, force: true });
  }
}

function npmPack(args, options = {}) {
  const state = options.env ? null : isolatedNpmState("agentera-registry-pack-");
  const invocation = spawnSync("npm", [...args, "--json"], {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: options.env ?? state.environment,
    timeout: options.timeout ?? PUBLICATION_CONTRACT.bounds.commandTimeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    if (invocation.error) throw invocation.error;
    if (invocation.status !== 0) {
      const diagnostic = (
        invocation.stderr ||
        invocation.stdout ||
        `exit ${invocation.status}`
      ).trim();
      throw new Error(`npm ${args.join(" ")} failed: ${diagnostic}`);
    }
    return {
      manifest: invocation.stdout ? JSON.parse(invocation.stdout) : null,
      warnings: invocation.stderr
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    };
  } finally {
    if (state) fs.rmSync(state.root, { recursive: true, force: true });
  }
}

function isRegistryNotFound(error) {
  return (
    error?.[NPM_COMMAND_FAILURE] === true &&
    /(?:E404|404 Not Found|is not in this registry|No match found)/i.test(error.message)
  );
}

const REGISTRY_NOT_FOUND = Symbol("registry-not-found");

function optionalNpmJson(args, query = npmJson) {
  try {
    return query(args);
  } catch (error) {
    if (isRegistryNotFound(error)) return REGISTRY_NOT_FOUND;
    throw error;
  }
}

function registryShapeError(field, reason) {
  return new Error(`npm registry shape error for ${field}: ${reason}`);
}

export function normalizeRegistryField(response, field) {
  let value = response;
  if (Array.isArray(value)) {
    if (value.length !== 1)
      throw registryShapeError(field, `expected one result, received ${value.length}`);
    value = value[0];
    if (Array.isArray(value)) throw registryShapeError(field, "nested arrays are ambiguous");
  }
  if (typeof value === "string" && value.length > 0) return value;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw registryShapeError(field, "expected a non-empty string or plain object");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw registryShapeError(field, "expected a plain object");

  const candidates = [];
  if (Object.hasOwn(value, field)) candidates.push(value[field]);
  const parts = field.split(".");
  if (parts.length > 1 && Object.hasOwn(value, parts[0])) {
    let nested = value;
    for (const part of parts) {
      if (
        nested === null ||
        typeof nested !== "object" ||
        Array.isArray(nested) ||
        !Object.hasOwn(nested, part)
      ) {
        throw registryShapeError(field, "nested queried field is malformed");
      }
      nested = nested[part];
    }
    candidates.push(nested);
  }
  if (candidates.length === 0) throw registryShapeError(field, "queried field is absent");
  if (candidates.some((candidate) => typeof candidate !== "string" || candidate.length === 0))
    throw registryShapeError(field, "queried field must be a non-empty string");
  if (new Set(candidates).size !== 1)
    throw registryShapeError(field, "contradictory duplicate fields");
  return candidates[0];
}

export function normalizeRegistryTag(response, tag) {
  const value = Array.isArray(response) && response.length === 1 ? response[0] : response;
  if (
    value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && !Object.hasOwn(value, tag)
  ) return null;
  return normalizeRegistryField(response, tag);
}

export function registryState(manifest, adapter, query = npmJson) {
  const exact = optionalNpmJson(
    ["view", `${manifest.name}@${manifest.version}`, "dist.integrity"],
    query,
  );
  const tags = optionalNpmJson(["view", manifest.name, "dist-tags"], query);
  const integrity = exact === REGISTRY_NOT_FOUND ? null : normalizeRegistryField(exact, "dist.integrity");
  const expectedTagVersion =
    tags === REGISTRY_NOT_FOUND ? null : normalizeRegistryTag(tags, adapter.expectedTag);
  return {
    exists: exact !== REGISTRY_NOT_FOUND,
    integrity,
    expectedTagVersion,
    tagged: expectedTagVersion === manifest.version,
  };
}

const MAX_SAFE_INTEGER_IDENTIFIER = String(Number.MAX_SAFE_INTEGER);

function compareNumericIdentifiers(left, right) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function versionParts(version) {
  if (typeof version !== "string" || version.length > 256) return null;
  const numeric = "(0|[1-9]\\d*)";
  const match = new RegExp(`^${numeric}\\.${numeric}\\.${numeric}(?:-dev\\.${numeric})?$`).exec(
    version,
  );
  if (
    !match ||
    match
      .slice(1, 4)
      .some((part) => compareNumericIdentifiers(part, MAX_SAFE_INTEGER_IDENTIFIER) > 0)
  )
    return null;
  return match.slice(1);
}

function publishableVersion(adapterName, version) {
  const parts = versionParts(version);
  return Boolean(
    parts && (adapterName === "development" ? parts[3] !== undefined : parts[3] === undefined),
  );
}

function compareVersions(left, right) {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  if (!leftParts || !rightParts) return null;
  for (let index = 0; index < 3; index++) {
    const comparison = compareNumericIdentifiers(leftParts[index], rightParts[index]);
    if (comparison !== 0) return comparison;
  }
  if (leftParts[3] === rightParts[3]) return 0;
  if (leftParts[3] === undefined) return 1;
  if (rightParts[3] === undefined) return -1;
  return compareNumericIdentifiers(leftParts[3], rightParts[3]);
}

function publicationError(message, phase, nextAction) {
  const error = new Error(message);
  error.publicationPhase = phase;
  error.nextAction = nextAction;
  return error;
}

function assertRegistryCompatible(
  manifest,
  adapter,
  integrity,
  state,
  phase,
  mutationAttempted = false,
) {
  const correction = mutationAttempted
    ? "No rollback was attempted; inspect the conflicting registry state and retry the same verified version."
    : "No registry mutation was attempted.";
  if (state.exists && state.integrity !== integrity) {
    throw publicationError(
      `${manifest.name}@${manifest.version} already exists with conflicting integrity; prepare a new version`,
      phase,
      mutationAttempted ? correction : `Prepare and commit a new version; ${correction}`,
    );
  }
  if (!state.expectedTagVersion || state.expectedTagVersion === manifest.version) return;
  const comparison = compareVersions(state.expectedTagVersion, manifest.version);
  if (comparison === null || comparison > 0) {
    throw publicationError(
      `@${adapter.expectedTag} already points to ${state.expectedTagVersion}, which is incompatible with committed ${manifest.version}`,
      phase,
      mutationAttempted
        ? correction
        : `Prepare a version newer than the expected tag; ${correction}`,
    );
  }
}

export function constructPackage(adapterName, adapter, manifest, temporary, dependencies = {}) {
  const execute = dependencies.run ?? run;
  const executeNpmPack = dependencies.npmPack ?? npmPack;
  if (adapter.construction === "isolatedTypeScriptPackage") {
    const packed = JSON.parse(
      execute(process.execPath, ["scripts/pack-package.mjs", "--output-dir", temporary, "--json"], {
        cwd: path.join(repoRoot, adapter.packagePath),
      }),
    );
    return normalizeConstruction(packed, {
      expectedName: manifest.name,
      expectedVersion: manifest.version,
      expectedTag: adapter.expectedTag,
      artifact: packed.artifact,
      warnings: packed.warnings,
    });
  }
  const state = isolatedNpmState("agentera-stable-construction-", { ignoreScripts: false });
  try {
    execute("pnpm", ["test"], {
      cwd: path.join(repoRoot, adapter.packagePath),
      env: state.environment,
    });
    const packed = executeNpmPack(["pack", "--ignore-scripts", "--pack-destination", temporary], {
      cwd: path.join(repoRoot, adapter.packagePath),
      env: state.environment,
    });
    const entry = Array.isArray(packed.manifest)
      ? packed.manifest[0]
      : Object.values(packed.manifest)[0];
    return normalizeConstruction(entry, {
      expectedName: manifest.name,
      expectedVersion: manifest.version,
      expectedTag: adapter.expectedTag,
      artifact: path.join(temporary, entry.filename),
      warnings: packed.warnings,
    });
  } finally {
    fs.rmSync(state.root, { recursive: true, force: true });
  }
}

export function withNpmCredentials(temporary, callback, environment = process.env, isolatedEnvironment = environment) {
  const token = environment.NPM_TOKEN;
  if (!token) throw new Error("NPM_TOKEN is absent; export a publish-capable token and retry");
  const npmrc = path.join(temporary, "npmrc");
  try {
    fs.writeFileSync(
      npmrc,
      `registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=${token}\n`,
      {
        mode: 0o600,
        flag: "wx",
      },
    );
    const childEnvironment = npmChildEnvironment(
      isolatedEnvironment,
      npmrc,
      isolatedEnvironment.NPM_CONFIG_GLOBALCONFIG,
    );
    for (const key of [
      "HOME",
      "XDG_CONFIG_HOME",
      "NPM_CONFIG_CACHE",
      "NPM_CONFIG_AUDIT",
      "NPM_CONFIG_FUND",
      "NPM_CONFIG_IGNORE_SCRIPTS",
    ]) {
      if (isolatedEnvironment[key] !== undefined) childEnvironment[key] = isolatedEnvironment[key];
    }
    return callback(childEnvironment);
  } finally {
    fs.rmSync(npmrc, { force: true });
  }
}

async function waitForConvergence(manifest, adapter, integrity, dependencies = {}) {
  const inspect = dependencies.inspectRegistry ?? (() => registryState(manifest, adapter));
  const attempts = dependencies.registryAttempts ?? PUBLICATION_CONTRACT.bounds.registryAttempts;
  const sleep =
    dependencies.sleep ?? ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
  let state;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    state = inspect();
    assertRegistryCompatible(
      manifest,
      adapter,
      integrity,
      state,
      "convergence",
      dependencies.mutationAttempted,
    );
    if (state.exists && state.integrity === integrity && state.tagged) return state;
    if (attempt < attempts) await sleep(PUBLICATION_CONTRACT.bounds.registryDelayMs);
  }
  const observed = state?.exists
    ? `integrity ${state.integrity ?? "missing"}`
    : "exact version absent";
  throw publicationError(
    `registry did not converge after ${attempts} attempts: ${observed}; @${adapter.expectedTag} points to ${state?.expectedTagVersion ?? "nothing"}`,
    "convergence",
    "Retry the same verified version; publication will replay without republishing once registry state matches.",
  );
}

export async function executePublication(adapterName, manifest, packed, dependencies = {}) {
  const adapter = PACKAGE_ADAPTERS[adapterName];
  if (!adapter) throw new Error(`unknown package '${adapterName}'; use development or stable`);
  if (!publishableVersion(adapterName, manifest.version)) {
    const expected = adapterName === "development" ? "X.Y.Z-dev.N" : "X.Y.Z";
    throw publicationError(
      `${adapterName} version '${manifest.version}' must match ${expected}`,
      "preflight",
      `Set and commit a version matching ${expected}; no registry mutation was attempted.`,
    );
  }
  const inspect = dependencies.inspectRegistry ?? (() => registryState(manifest, adapter));
  const receipts = [];
  const record = (receipt) => {
    receipts.push(receipt);
    dependencies.onReceipt?.(receipt);
  };
  let existing = inspect();
  assertRegistryCompatible(manifest, adapter, packed.integrity, existing, "publication");

  if (!existing.exists && existing.expectedTagVersion === manifest.version) {
    existing = await waitForConvergence(manifest, adapter, packed.integrity, dependencies);
  }

  if (existing.exists) {
    record(
      result(
        adapterName,
        manifest.version,
        "publication",
        "replayed",
        existing.tagged ? "run exact-version smoke" : "wait for expected tag convergence",
      ),
    );
    if (!existing.tagged) {
      await waitForConvergence(manifest, adapter, packed.integrity, dependencies);
      record(
        result(adapterName, manifest.version, "convergence", "passed", "run exact-version smoke"),
      );
    }
  } else {
    if (typeof dependencies.publishPackage !== "function") {
      throw new Error("publication dependency is missing publishPackage");
    }
    await dependencies.publishPackage();
    record(
      result(
        adapterName,
        manifest.version,
        "publication",
        "published",
        "wait for exact registry convergence",
      ),
    );
    await waitForConvergence(manifest, adapter, packed.integrity, {
      ...dependencies,
      mutationAttempted: true,
    });
    record(
      result(adapterName, manifest.version, "convergence", "passed", "run exact-version smoke"),
    );
  }

  let smokeOutput;
  try {
    smokeOutput = await dependencies.smokePackage?.();
    if (!String(smokeOutput).includes(manifest.version)) {
      throw new Error(`exact-version smoke output did not identify ${manifest.version}`);
    }
  } catch (error) {
    throw publicationError(
      `exact-version smoke failed: ${error.message}`,
      "smoke",
      "No rollback was attempted; correct the smoke failure and retry the same verified version.",
    );
  }
  record(
    result(adapterName, manifest.version, "smoke", "passed", "publication transaction complete"),
  );
  record(result(adapterName, manifest.version, "complete", "passed", "none"));
  return receipts;
}

function candidateAdapter(adapter, tag) {
  return { ...adapter, expectedTag: tag };
}

function isolatedRegistryInspector(manifest, adapter, environment) {
  return () => registryState(manifest, adapter, (args) => npmJson(args, { env: environment }));
}

function candidatePacked(candidate) {
  return {
    integrity: candidate.receipt.artifact.integrity,
    artifact: candidate.artifact,
  };
}

function assertQualifiedApproval(adapterName, candidateDirectory, options = {}) {
  const candidate = validateCandidateReceipt({ candidateDirectory, adapterName });
  validateCandidateApproval({ candidateDirectory, candidate });
  if ((options.environment ?? process.env).GITHUB_ACTIONS === "true") {
    validateCiAttestation({
      candidateDirectory,
      candidate,
      sourceRunId: options.sourceRunId,
      environment: options.environment,
    });
  }
  return candidate;
}

export async function stageQualifiedCandidate(adapterName, candidateDirectory, options = {}) {
  const environment = options.environment ?? process.env;
  const candidate = options.candidate ?? assertQualifiedApproval(adapterName, candidateDirectory, options);
  const { manifest, adapter } = candidate;
  const state = isolatedNpmState("agentera-registry-stage-");
  try {
    const inspectPublic = options.inspectPublic
      ?? isolatedRegistryInspector(manifest, adapter, state.environment);
    const publicState = inspectPublic();
    assertRegistryCompatible(manifest, adapter, candidate.receipt.artifact.integrity, publicState, "staging");
    if (!publicState.exists && publicState.expectedTagVersion === manifest.version) {
      throw publicationError(
        `@${adapter.expectedTag} already points to ${manifest.version}, but that exact version is absent`,
        "staging",
        "Wait for registry consistency or prepare a new version without moving the public tag backward; No registry mutation was attempted.",
      );
    }
    if (publicState.exists && publicState.tagged) {
      const output = smokePublishedCandidate({ manifest, adapter });
      return [
        result(adapterName, manifest.version, "staging", "replayed", "package artifact is already promoted", "matching public tag required no upload"),
        result(adapterName, manifest.version, "registry-smoke", "passed", "run no additional mutation", output),
      ];
    }
    const stagingAdapter = candidateAdapter(adapter, candidate.receipt.candidateTag);
    return executePublication(adapterName, manifest, candidatePacked(candidate), {
      inspectRegistry: options.inspectCandidate
        ?? isolatedRegistryInspector(manifest, stagingAdapter, state.environment),
      publishPackage: options.publishPackage ?? (() => {
        const credentialsRoot = path.join(state.root, "mutation-credentials");
        fs.mkdirSync(credentialsRoot, { mode: 0o700 });
        return withNpmCredentials(credentialsRoot, (childEnvironment) => {
          run("npm", ["publish", candidate.artifact, "--access", "public", "--tag", candidate.receipt.candidateTag], {
            cwd: repoRoot,
            env: childEnvironment,
          });
        }, environment, state.environment);
      }),
      smokePackage: options.smokePackage ?? (() => smokePublishedCandidate({ manifest, adapter })),
      registryAttempts: options.registryAttempts,
      sleep: options.sleep,
    });
  } finally {
    fs.rmSync(state.root, { recursive: true, force: true });
  }
}

export async function promoteQualifiedCandidate(adapterName, candidateDirectory, options = {}) {
  const environment = options.environment ?? process.env;
  const candidate = assertQualifiedApproval(adapterName, candidateDirectory, options);
  const { manifest, adapter } = candidate;
  const state = isolatedNpmState("agentera-registry-promote-");
  try {
    const inspectPublic = isolatedRegistryInspector(manifest, adapter, state.environment);
    const publicState = inspectPublic();
    assertRegistryCompatible(manifest, adapter, candidate.receipt.artifact.integrity, publicState, "promotion");
    if (publicState.exists && publicState.tagged) {
      const output = smokePublishedCandidate({ manifest, adapter });
      return [
        result(adapterName, manifest.version, "promotion", "replayed", "package artifact is already promoted", "matching public tag required no mutation"),
        result(adapterName, manifest.version, "registry-smoke", "passed", "run no additional mutation", output),
      ];
    }
    const stagingAdapter = candidateAdapter(adapter, candidate.receipt.candidateTag);
    const staged = isolatedRegistryInspector(manifest, stagingAdapter, state.environment)();
    assertRegistryCompatible(manifest, stagingAdapter, candidate.receipt.artifact.integrity, staged, "promotion");
    if (!staged.exists || !staged.tagged) {
      throw publicationError(
        `${manifest.name}@${manifest.version} is not staged on @${candidate.receipt.candidateTag}`,
        "promotion",
        "Stage the package and complete the staged package migration smoke test before promoting the public tag; no registry mutation was attempted.",
      );
    }
    const credentialsRoot = path.join(state.root, "mutation-credentials");
    fs.mkdirSync(credentialsRoot, { mode: 0o700 });
    withNpmCredentials(credentialsRoot, (childEnvironment) => {
      run("npm", ["dist-tag", "add", `${manifest.name}@${manifest.version}`, adapter.expectedTag], {
        cwd: repoRoot,
        env: childEnvironment,
      });
    }, environment, state.environment);
    await waitForConvergence(manifest, adapter, candidate.receipt.artifact.integrity, {
      inspectRegistry: inspectPublic,
      mutationAttempted: true,
      registryAttempts: options.registryAttempts,
      sleep: options.sleep,
    });
    const output = smokePublishedCandidate({ manifest, adapter });
    return [
      result(adapterName, manifest.version, "promotion", "promoted", "run any consumer-owned exact-version checks", "expected tag advanced forward only"),
      result(adapterName, manifest.version, "registry-smoke", "passed", "complete", output),
    ];
  } finally {
    fs.rmSync(state.root, { recursive: true, force: true });
  }
}

export function smokeQualifiedCandidate(adapterName, candidateDirectory, options = {}) {
  const candidate = assertQualifiedApproval(adapterName, candidateDirectory, options);
  const { manifest, adapter } = candidate;
  const state = isolatedNpmState("agentera-registry-qualified-smoke-");
  try {
    const publicState = isolatedRegistryInspector(manifest, adapter, state.environment)();
    assertRegistryCompatible(
      manifest,
      adapter,
      candidate.receipt.artifact.integrity,
      publicState,
      "staged package migration smoke",
    );
    if (!publicState.tagged) {
      const stagingAdapter = candidateAdapter(adapter, candidate.receipt.candidateTag);
      const staged = isolatedRegistryInspector(manifest, stagingAdapter, state.environment)();
      assertRegistryCompatible(
        manifest,
        stagingAdapter,
        candidate.receipt.artifact.integrity,
        staged,
        "staged package migration smoke",
      );
      if (!staged.exists || !staged.tagged) {
        throw publicationError(
          `${manifest.name}@${manifest.version} is not staged on @${candidate.receipt.candidateTag}`,
          "candidate-migration-smoke",
          "Stage the same package before retrying publication; no rollback was attempted.",
        );
      }
    }
    const output = smokePublishedCandidate({ manifest, adapter });
    return [
      result(
        adapterName,
        manifest.version,
        "candidate-migration-smoke",
        "passed",
        "continue to promotion",
        output,
      ),
    ];
  } finally {
    fs.rmSync(state.root, { recursive: true, force: true });
  }
}

async function main() {
  const [phase, adapterName, ...rest] = process.argv.slice(2);
  if (!PACKAGE_ADAPTERS[adapterName] || !["prepare", "stage", "smoke", "promote"].includes(phase)) {
    throw new Error(
      "usage: publication-transaction.mjs <prepare|stage|smoke|promote> <development|stable> [--candidate-dir DIR] [--approve] [--json|--verbose]",
    );
  }
  const flags = parseReleaseFlags(rest, {
    boolean: phase === "prepare"
      ? ["--check", "--json", "--verbose"]
      : ["--approve", "--json", "--verbose"],
    value: phase === "prepare"
      ? [
          ...(adapterName === "stable" ? ["--target-version"] : []),
          "--source-commit",
          ...(adapterName === "development" ? ["--candidate-dir"] : []),
        ]
      : ["--candidate-dir", "--source-run-id"],
  });
  const json = Boolean(flags.get("--json"));
  const verbose = Boolean(flags.get("--verbose"));
  if (phase === "prepare") {
    emit(prepareReleaseMetadata(adapterName, {
      targetVersion: flags.get("--target-version"),
      sourceCommit: flags.get("--source-commit"),
      candidateDirectory: flags.get("--candidate-dir"),
      check: Boolean(flags.get("--check")),
    }), json);
    return;
  }
  const candidateDirectory = flags.get("--candidate-dir");
  if (!candidateDirectory) throw new Error(`${phase} requires --candidate-dir DIR for the verified artifact`);
  if (!flags.get("--approve")) {
    throw new Error(`${phase} requires --approve and an immutable artifact-bound approval receipt`);
  }
  const sourceRunId = flags.get("--source-run-id");
  const manifest = readManifest(PACKAGE_ADAPTERS[adapterName]);
  const started = performance.now();
  emit(
    result(adapterName, manifest.version, phase, "started", "validate the verified artifact before registry inspection", undefined, {
      executed: "pending",
    }),
    json,
    verbose,
  );
  try {
    const receipts = phase === "stage"
      ? await stageQualifiedCandidate(adapterName, candidateDirectory, { sourceRunId })
      : phase === "smoke"
        ? smokeQualifiedCandidate(adapterName, candidateDirectory, { sourceRunId })
        : await promoteQualifiedCandidate(adapterName, candidateDirectory, { sourceRunId });
    for (const receipt of receipts) emit(receipt, json, verbose);
    emit(
      result(adapterName, manifest.version, phase, "passed", "complete", undefined, {
        elapsedMs: performance.now() - started,
        executed: "candidate transaction",
        reused: phase !== "smoke"
          && receipts.every((receipt) => receipt.outcome === "replayed" || receipt.outcome === "passed"),
      }),
      json,
      verbose,
    );
  } catch (error) {
    const publicationFailure = error instanceof Error ? error : new Error(String(error));
    publicationFailure.publicationPhase ??= phase;
    publicationFailure.nextAction ??= "Correct the reported failure and retry the same verified artifact.";
    throw publicationFailure;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = redactedDiagnostic(error instanceof Error ? error.message : error);
    const [phase, adapterName] = process.argv.slice(2);
    if (!error.receiptEmitted && PACKAGE_ADAPTERS[adapterName]) {
      let version = "unknown";
      try {
        version = readManifest(PACKAGE_ADAPTERS[adapterName]).version;
      } catch {}
      emit(publicationFailureResult(
        adapterName,
        version,
        phase === "prepare" ? "preparation" : phase ?? "preflight",
        error,
      ), process.argv.includes("--json"));
    }
    process.stderr.write(
      `publication-transaction: ${message.slice(0, PUBLICATION_CONTRACT.bounds.diagnosticCharacters)}\n`,
    );
    process.exitCode = 1;
  });
}
