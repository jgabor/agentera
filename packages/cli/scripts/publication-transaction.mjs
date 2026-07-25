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
  projectConstruction,
} from "./package-construction.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");
const contractPath = path.join(repoRoot, "references/adapters/package-publication.json");
export const PUBLICATION_CONTRACT = JSON.parse(fs.readFileSync(contractPath, "utf8"));
export const PACKAGE_ADAPTERS = PUBLICATION_CONTRACT.packages;
const REQUIRED_RESULT_FIELDS = PUBLICATION_CONTRACT.invariants.output;

function incrementVersion(version, preparation) {
  if (preparation === "incrementDevPrerelease") {
    const match = /^(\d+)\.(\d+)\.(\d+)-dev\.(\d+)$/.exec(version);
    if (!match) throw new Error(`development version '${version}' must match X.Y.Z-dev.N`);
    return `${match[1]}.${match[2]}.${match[3]}-dev.${Number(match[4]) + 1}`;
  }
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`stable version '${version}' must match X.Y.Z`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function result(adapterName, version, phase, outcome, nextAction, detail) {
  const receipt = {
    package: adapterName,
    version,
    expectedTag: PACKAGE_ADAPTERS[adapterName].expectedTag,
    phase,
    outcome,
    nextAction,
  };
  if (detail)
    receipt.detail = String(detail).slice(0, PUBLICATION_CONTRACT.bounds.diagnosticCharacters);
  return receipt;
}

export function validateResult(value) {
  return REQUIRED_RESULT_FIELDS.filter(
    (field) => typeof value?.[field] !== "string" || value[field].length === 0,
  );
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
    env: options.env ?? process.env,
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
    process.stdout.write(
      `${receipt.package}@${receipt.version} ${receipt.expectedTag} ${receipt.phase}: ${receipt.outcome}; next: ${receipt.nextAction}${receipt.detail ? `; ${receipt.detail}` : ""}\n`,
    );
    if (receipt.construction) {
      process.stdout.write(
        `${formatConstruction(receipt.construction, verbose ? "verbose" : "default")}\n`,
      );
    }
  }
}

function readManifest(adapter) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, adapter.manifestPath), "utf8"));
}

function metadataCommitted(adapter) {
  const tracked = spawnSync("git", ["diff", "--quiet", "HEAD", "--", adapter.manifestPath], {
    cwd: repoRoot,
  });
  return tracked.status === 0;
}

function gitRefExists(gitRef) {
  if (!/^[0-9a-f]{40}$/.test(gitRef ?? "")) return false;
  return spawnSync("git", ["cat-file", "-e", `${gitRef}^{commit}`], { cwd: repoRoot }).status === 0;
}

function npmJson(args, options = {}) {
  const output = run("npm", [...args, "--json"], options);
  return output ? JSON.parse(output) : null;
}

function npmPack(args, options = {}) {
  const invocation = spawnSync("npm", [...args, "--json"], {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
    timeout: options.timeout ?? PUBLICATION_CONTRACT.bounds.commandTimeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
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
}

function isRegistryNotFound(error) {
  return /(?:E404|404 Not Found|is not in this registry|No match found)/i.test(error.message);
}

function optionalNpmJson(args) {
  try {
    return npmJson(args);
  } catch (error) {
    if (isRegistryNotFound(error)) return null;
    throw error;
  }
}

function registryState(manifest, adapter) {
  let exact;
  exact = optionalNpmJson(["view", `${manifest.name}@${manifest.version}`, "dist.integrity"]);
  const tags = optionalNpmJson(["view", manifest.name, "dist-tags"]) ?? {};
  return {
    exists: exact !== null,
    integrity: typeof exact === "string" ? exact : exact?.["dist.integrity"],
    expectedTagVersion: tags?.[adapter.expectedTag] ?? null,
    tagged: tags?.[adapter.expectedTag] === manifest.version,
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
    ? "No rollback was attempted; inspect the conflicting registry state and retry the same committed version."
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
  execute("pnpm", ["test"], { cwd: path.join(repoRoot, adapter.packagePath) });
  const npmrc = path.join(temporary, "pack-npmrc");
  let packed;
  try {
    fs.writeFileSync(npmrc, "", { mode: 0o600, flag: "wx" });
    packed = executeNpmPack(["pack", "--ignore-scripts", "--pack-destination", temporary], {
      cwd: path.join(repoRoot, adapter.packagePath),
      env: npmChildEnvironment(process.env, npmrc),
    });
  } finally {
    fs.rmSync(npmrc, { force: true });
  }
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
}

export function withNpmCredentials(temporary, callback, environment = process.env) {
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
    return callback(npmChildEnvironment(environment, npmrc));
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
    "Retry the same committed version; publication will replay without republishing once registry state matches.",
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
      "No rollback was attempted; correct the smoke failure and retry the same committed version.",
    );
  }
  record(
    result(adapterName, manifest.version, "smoke", "passed", "publication transaction complete"),
  );
  record(result(adapterName, manifest.version, "complete", "passed", "none"));
  return receipts;
}

async function publish(adapterName, json, verbose, authorized) {
  const adapter = PACKAGE_ADAPTERS[adapterName];
  if (!adapter) throw new Error(`unknown package '${adapterName}'; use development or stable`);
  const manifest = readManifest(adapter);
  let currentPhase = "preflight";
  let temporary;
  try {
    const preflight = preflightPublication(adapterName, manifest, {
      authorized,
      dirty: git(["status", "--porcelain"]).length > 0,
      metadataCommitted: metadataCommitted(adapter),
      gitRefExists: gitRefExists(manifest.agentera?.gitRef),
    });
    emit(preflight, json, verbose);
    if (preflight.outcome === "failed") {
      const error = new Error(preflight.nextAction);
      error.receiptEmitted = true;
      throw error;
    }

    temporary = fs.mkdtempSync(path.join(os.tmpdir(), `agentera-${adapterName}-publication-`));
    currentPhase = "construction";
    const packed = constructPackage(adapterName, adapter, manifest, temporary);
    const tarball = packed.artifact;
    const constructionReceipt = result(
      adapterName,
      manifest.version,
      "construction",
      "passed",
      "inspect registry state",
    );
    constructionReceipt.construction = projectConstruction(packed, json || verbose);
    emit(constructionReceipt, json, verbose);

    currentPhase = "publication";
    await executePublication(adapterName, manifest, packed, {
      publishPackage: () =>
        withNpmCredentials(temporary, (env) => {
          run("npm", ["publish", tarball, "--access", "public", "--tag", adapter.expectedTag], {
            cwd: repoRoot,
            env,
          });
        }),
      smokePackage: () => {
        const smoke = adapter.smoke.map((part) => part.replace("{version}", manifest.version));
        return run(smoke[0], smoke.slice(1), { cwd: temporary });
      },
      onReceipt: (receipt) => {
        currentPhase = receipt.phase;
        emit(receipt, json);
      },
    });
  } catch (error) {
    currentPhase = error.publicationPhase ?? currentPhase;
    if (!error.receiptEmitted) {
      emit(
        result(
          adapterName,
          manifest.version,
          currentPhase,
          "failed",
          error.nextAction ?? "Correct the reported failure and safely retry the same command.",
          error.message,
        ),
        json,
      );
      error.receiptEmitted = true;
    }
    throw error;
  } finally {
    if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
  }
}

async function main() {
  const [phase, adapterName] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  const json = process.argv.includes("--json");
  const verbose = process.argv.includes("--verbose");
  if (!PACKAGE_ADAPTERS[adapterName] || !["prepare", "publish"].includes(phase)) {
    throw new Error(
      "usage: publication-transaction.mjs <prepare|publish> <development|stable> [--authorize] [--json|--verbose]",
    );
  }
  if (phase === "prepare") {
    const adapter = PACKAGE_ADAPTERS[adapterName];
    const prepared = prepareMetadata(
      adapterName,
      readManifest(adapter),
      git(["rev-parse", "HEAD"]),
    );
    fs.writeFileSync(
      path.join(repoRoot, adapter.manifestPath),
      `${JSON.stringify(prepared.manifest, null, 2)}\n`,
    );
    emit(prepared.receipt, json);
    return;
  }
  await publish(adapterName, json, verbose, process.argv.includes("--authorize"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    const [phase, adapterName] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
    if (!error.receiptEmitted && PACKAGE_ADAPTERS[adapterName]) {
      let version = "unknown";
      try {
        version = readManifest(PACKAGE_ADAPTERS[adapterName]).version;
      } catch {}
      emit(
        result(
          adapterName,
          version,
          phase === "prepare" ? "preparation" : "preflight",
          "failed",
          "Correct the reported failure and retry.",
          message,
        ),
        process.argv.includes("--json"),
      );
    }
    process.stderr.write(
      `publication-transaction: ${message.slice(0, PUBLICATION_CONTRACT.bounds.diagnosticCharacters)}\n`,
    );
    process.exitCode = 1;
  });
}
