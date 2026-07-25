#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  if (detail) receipt.detail = String(detail).slice(0, PUBLICATION_CONTRACT.bounds.diagnosticCharacters);
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
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("gitRef source must be a 40-character commit SHA");
  const next = structuredClone(manifest);
  next.version = incrementVersion(next.version, adapter.preparation);
  next.agentera = { ...(next.agentera ?? {}), gitRef: head };
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
  if (!state.metadataCommitted) corrections.push(`commit ${PACKAGE_ADAPTERS[adapterName].manifestPath}`);
  if (!state.gitRefExists) corrections.push("set agentera.gitRef to an existing immutable commit and commit it");
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
    const diagnostic = (invocation.stderr || invocation.stdout || `exit ${invocation.status}`).trim();
    throw new Error(`${command} ${args.join(" ")} failed: ${diagnostic}`);
  }
  return invocation.stdout.trim();
}

function git(args) {
  return run("git", args, { cwd: repoRoot });
}

function emit(receipt, json) {
  const missing = validateResult(receipt);
  if (missing.length) throw new Error(`publication result missing: ${missing.join(", ")}`);
  if (json) {
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } else {
    process.stdout.write(
      `${receipt.package}@${receipt.version} ${receipt.expectedTag} ${receipt.phase}: ${receipt.outcome}; next: ${receipt.nextAction}${receipt.detail ? `; ${receipt.detail}` : ""}\n`,
    );
  }
}

function readManifest(adapter) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, adapter.manifestPath), "utf8"));
}

function metadataCommitted(adapter) {
  const tracked = spawnSync("git", ["diff", "--quiet", "HEAD", "--", adapter.manifestPath], { cwd: repoRoot });
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

function registryState(manifest, adapter) {
  let exact;
  try {
    exact = npmJson(["view", `${manifest.name}@${manifest.version}`, "dist.integrity"]);
  } catch {
    return { exists: false };
  }
  const tags = npmJson(["view", manifest.name, "dist-tags"]);
  return {
    exists: true,
    integrity: typeof exact === "string" ? exact : exact?.["dist.integrity"],
    tagged: tags?.[adapter.expectedTag] === manifest.version,
  };
}

export function constructPackage(adapterName, adapter, temporary, dependencies = {}) {
  const execute = dependencies.run ?? run;
  const executeNpmJson = dependencies.npmJson ?? npmJson;
  if (adapter.construction === "isolatedTypeScriptPackage") {
    return JSON.parse(
      execute(process.execPath, [
        "scripts/pack-package.mjs",
        "--output-dir",
        temporary,
        "--json",
      ], { cwd: path.join(repoRoot, adapter.packagePath) }),
    );
  }
  execute("pnpm", ["test"], { cwd: path.join(repoRoot, adapter.packagePath) });
  const packed = executeNpmJson(
    ["pack", "--ignore-scripts", "--pack-destination", temporary],
    { cwd: path.join(repoRoot, adapter.packagePath) },
  );
  return Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
}

function credentialEnvironment(temporary) {
  const token = process.env.NPM_TOKEN;
  if (!token) throw new Error("NPM_TOKEN is absent; export a publish-capable token and retry");
  const npmrc = path.join(temporary, "npmrc");
  fs.writeFileSync(npmrc, `registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=${token}\n`, { mode: 0o600 });
  return { ...process.env, NPM_CONFIG_USERCONFIG: npmrc };
}

async function waitForConvergence(manifest, adapter, integrity) {
  for (let attempt = 1; attempt <= PUBLICATION_CONTRACT.bounds.registryAttempts; attempt++) {
    const state = registryState(manifest, adapter);
    if (state.exists && state.integrity === integrity && state.tagged) return;
    if (attempt < PUBLICATION_CONTRACT.bounds.registryAttempts) {
      await new Promise((resolve) => setTimeout(resolve, PUBLICATION_CONTRACT.bounds.registryDelayMs));
    }
  }
  throw new Error(`registry did not converge on exact integrity and @${adapter.expectedTag} within the bounded retry window`);
}

async function publish(adapterName, json, authorized) {
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
    emit(preflight, json);
    if (preflight.outcome === "failed") {
      const error = new Error(preflight.nextAction);
      error.receiptEmitted = true;
      throw error;
    }

    temporary = fs.mkdtempSync(path.join(os.tmpdir(), `agentera-${adapterName}-publication-`));
    currentPhase = "construction";
    const packed = constructPackage(adapterName, adapter, temporary);
    const tarball = path.join(temporary, packed.filename);
    emit(result(adapterName, manifest.version, "construction", "passed", "inspect registry state", packed.filename), json);

    currentPhase = "publication";
    const existing = registryState(manifest, adapter);
    if (existing.exists) {
      if (existing.integrity !== packed.integrity) {
        throw new Error(`agentera@${manifest.version} already exists with conflicting integrity; prepare a new version`);
      }
      emit(result(adapterName, manifest.version, "publication", "replayed", existing.tagged ? "run exact-version smoke" : "wait for expected tag convergence"), json);
      if (!existing.tagged) {
        currentPhase = "convergence";
        await waitForConvergence(manifest, adapter, packed.integrity);
        emit(result(adapterName, manifest.version, "convergence", "passed", "run exact-version smoke"), json);
      }
    } else {
      const env = credentialEnvironment(temporary);
      run("npm", ["publish", tarball, "--access", "public", "--tag", adapter.expectedTag], { cwd: repoRoot, env });
      emit(result(adapterName, manifest.version, "publication", "published", "wait for exact registry convergence"), json);
      currentPhase = "convergence";
      await waitForConvergence(manifest, adapter, packed.integrity);
      emit(result(adapterName, manifest.version, "convergence", "passed", "run exact-version smoke"), json);
    }

    currentPhase = "smoke";
    const smoke = adapter.smoke.map((part) => part.replace("{version}", manifest.version));
    const smokeOutput = run(smoke[0], smoke.slice(1), { cwd: temporary });
    if (!smokeOutput.includes(manifest.version)) throw new Error(`exact-version smoke output did not identify ${manifest.version}`);
    emit(result(adapterName, manifest.version, "smoke", "passed", "publication transaction complete"), json);
    emit(result(adapterName, manifest.version, "complete", "passed", "none"), json);
  } catch (error) {
    if (!error.receiptEmitted) {
      emit(result(adapterName, manifest.version, currentPhase, "failed", "Correct the reported failure and safely retry the same command.", error.message), json);
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
  if (!PACKAGE_ADAPTERS[adapterName] || !["prepare", "publish"].includes(phase)) {
    throw new Error("usage: publication-transaction.mjs <prepare|publish> <development|stable> [--authorize] [--json]");
  }
  if (phase === "prepare") {
    const adapter = PACKAGE_ADAPTERS[adapterName];
    const prepared = prepareMetadata(adapterName, readManifest(adapter), git(["rev-parse", "HEAD"]));
    fs.writeFileSync(path.join(repoRoot, adapter.manifestPath), `${JSON.stringify(prepared.manifest, null, 2)}\n`);
    emit(prepared.receipt, json);
    return;
  }
  await publish(adapterName, json, process.argv.includes("--authorize"));
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
      emit(result(adapterName, version, phase === "prepare" ? "preparation" : "preflight", "failed", "Correct the reported failure and retry.", message), process.argv.includes("--json"));
    }
    process.stderr.write(`publication-transaction: ${message.slice(0, PUBLICATION_CONTRACT.bounds.diagnosticCharacters)}\n`);
    process.exitCode = 1;
  });
}
