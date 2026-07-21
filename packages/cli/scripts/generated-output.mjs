import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const generatedDirectory = ".agentera-generated";
const identityFile = ".agentera-generation.json";
const guardFile = ".agentera-generation.guard";
const guardSchema = "agentera.generatedGuard.v1";
const retainedGenerationLimit = 2;

function generatedPaths(root) {
  const generatedRoot = path.join(root, generatedDirectory);
  return {
    generatedRoot,
    generationsRoot: path.join(generatedRoot, "generations"),
    leasesRoot: path.join(generatedRoot, "leases"),
    current: path.join(generatedRoot, "current"),
  };
}

function optionalLstat(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function requireOwnedDirectory(directory, label, create = false) {
  if (create) fs.mkdirSync(directory, { recursive: true });
  const stat = optionalLstat(directory);
  if (!stat) throw new Error(`${label} is missing at ${directory}`);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular directory at ${directory}`);
  }
  return fs.realpathSync(directory);
}

function readJsonFile(file, label) {
  const stat = optionalLstat(file);
  if (!stat) throw new Error(`${label} is missing at ${file}`);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file at ${file}`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${label} is invalid at ${file}: ${error.message}`);
  }
}

function readIdentity(file, label) {
  const parsed = readJsonFile(file, `${label} identity`);
  if (parsed?.schemaVersion !== "agentera.generatedGeneration.v1" || typeof parsed?.id !== "string") {
    throw new Error(`${label} identity has an invalid contract at ${file}`);
  }
  return parsed;
}

function readGuard(file, label = "generation guard") {
  const parsed = readJsonFile(file, label);
  if (parsed?.schemaVersion !== guardSchema || typeof parsed?.id !== "string") {
    throw new Error(`${label} has an invalid contract at ${file}`);
  }
  return parsed;
}

function processIdentity(pid) {
  if (process.platform !== "linux") return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    return fields[19] ? `linux-start:${fields[19]}` : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function ownerEvidence() {
  return { pid: process.pid, processIdentity: processIdentity(process.pid) };
}

function ownerState(owner) {
  if (!Number.isInteger(owner?.pid)) return "unknown";
  if (!processIsAlive(owner.pid)) return "stale";
  if (typeof owner.processIdentity !== "string") return "active";
  const observed = processIdentity(owner.pid);
  if (observed === null) return "unknown";
  return observed === owner.processIdentity ? "active" : "stale";
}

function assertDirectGeneration(root, selected) {
  const { generationsRoot } = generatedPaths(root);
  const governed = requireOwnedDirectory(generationsRoot, "generated-output generations root");
  const canonical = fs.realpathSync(selected);
  const relative = path.relative(governed, canonical);
  if (!relative || path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`) || relative.includes(path.sep)) {
    throw new Error(`generated-output selection escapes its governed generations root: ${canonical}; correction: run pnpm -C packages/cli build`);
  }
  const stat = fs.lstatSync(path.join(governed, relative));
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`generated-output generation must be a regular direct child at ${path.join(governed, relative)}`);
  }
  return { canonical, name: relative };
}

function assertGenerationId(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || id === "." || id === "..") {
    throw new Error(`generated-output identity is not a safe generation name: ${JSON.stringify(id)}`);
  }
}

export function validateGeneration(generationRoot, expectedId) {
  assertGenerationId(expectedId);
  const rootStat = optionalLstat(generationRoot);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`generated generation must be a regular directory at ${generationRoot}`);
  }
  for (const surface of ["dist", "bundle"]) {
    const surfaceRoot = path.join(generationRoot, surface);
    const stat = optionalLstat(surfaceRoot);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${surface} surface must be a regular directory at ${surfaceRoot}`);
    }
  }
  const identities = [
    readIdentity(path.join(generationRoot, identityFile), "generation"),
    readIdentity(path.join(generationRoot, "dist", identityFile), "dist"),
    readIdentity(path.join(generationRoot, "bundle", identityFile), "bundle"),
  ];
  if (identities.some(({ id }) => id !== expectedId)) {
    throw new Error(`generated surfaces do not share generation ${JSON.stringify(expectedId)} at ${generationRoot}`);
  }
  return { id: expectedId, root: generationRoot };
}

export function writeGenerationIdentity(generationRoot, id) {
  assertGenerationId(id);
  const payload = JSON.stringify({
    schemaVersion: "agentera.generatedGeneration.v1",
    id,
    createdAt: new Date().toISOString(),
    owner: ownerEvidence(),
  }, null, 2) + "\n";
  fs.writeFileSync(path.join(generationRoot, identityFile), payload);
  for (const surface of ["dist", "bundle"]) fs.writeFileSync(path.join(generationRoot, surface, identityFile), payload);
  fs.writeFileSync(path.join(generationRoot, guardFile), JSON.stringify({ schemaVersion: guardSchema, id }) + "\n", { flag: "wx" });
}

export function writeStagingOwner(stagedRoot) {
  fs.mkdirSync(stagedRoot, { recursive: true });
  fs.writeFileSync(path.join(stagedRoot, ".owner.json"), JSON.stringify(ownerEvidence()) + "\n", { flag: "wx" });
}

export function selectGeneratedGeneration(root) {
  const { current } = generatedPaths(root);
  const stat = optionalLstat(current);
  if (!stat) throw new Error(`generated-output current selection is missing at ${current}; correction: run pnpm -C packages/cli build`);
  if (!stat.isSymbolicLink()) {
    throw new Error(`generated-output current selection is not a symbolic link at ${current}; correction: run pnpm -C packages/cli build to preserve and replace it`);
  }
  let selected;
  try {
    const lexicalTarget = path.resolve(path.dirname(current), fs.readlinkSync(current));
    const targetStat = fs.lstatSync(lexicalTarget);
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
      throw new Error(`selection target must be a regular generation directory at ${lexicalTarget}`);
    }
    selected = fs.realpathSync(lexicalTarget);
  } catch (error) {
    throw new Error(`generated-output current selection is broken at ${current}: ${error.message}; correction: run pnpm -C packages/cli build`);
  }
  const confined = assertDirectGeneration(root, selected);
  const identity = readIdentity(path.join(confined.canonical, identityFile), "generation");
  if (identity.id !== confined.name) {
    throw new Error(`generated-output selection name ${JSON.stringify(confined.name)} does not match identity ${JSON.stringify(identity.id)}; correction: run pnpm -C packages/cli build`);
  }
  return validateGeneration(confined.canonical, identity.id);
}

function ensureLeasesRoot(root) {
  const { generatedRoot, leasesRoot } = generatedPaths(root);
  requireOwnedDirectory(generatedRoot, "generated-output root", true);
  return requireOwnedDirectory(leasesRoot, "generated-output leases root", true);
}

function leaseName(kind) {
  const owner = ownerEvidence();
  const identity = owner.processIdentity === null ? "none" : Buffer.from(owner.processIdentity).toString("base64url");
  return `${randomUUID()}.${owner.pid}.${identity}.${kind}.lease`;
}

function createLease(root, generationRoot, generationId, kind) {
  const leasesRoot = ensureLeasesRoot(root);
  const guard = path.join(generationRoot, guardFile);
  if (readGuard(guard).id !== generationId) throw new Error(`generation guard does not match ${JSON.stringify(generationId)} at ${guard}`);
  const leasePath = path.join(leasesRoot, leaseName(kind));
  fs.linkSync(guard, leasePath);
  let released = false;
  return {
    leasePath,
    release() {
      if (released) return;
      released = true;
      fs.rmSync(leasePath, { force: true });
    },
  };
}

export function pinGeneratedGeneration(root) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const selected = selectGeneratedGeneration(root);
      const lease = createLease(root, selected.root, selected.id, "reader");
      return { ...selected, leasePath: lease.leasePath, release: lease.release };
    } catch (error) {
      lastError = error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  throw new Error(`generated-output reader could not pin a stable generation after 3 attempts: ${lastError?.message ?? "selection changed"}; correction: rerun pnpm -C packages/cli build`);
}

export function legacyPublicationLockPath(root) {
  const identity = createHash("sha256").update(fs.realpathSync(root)).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), `agentera-generated-publication-${identity}.lock`);
}

function rejectLegacyRecoveryResidue(root) {
  const legacyLock = legacyPublicationLockPath(root);
  if (fs.existsSync(legacyLock)) {
    let owner;
    try {
      owner = JSON.parse(fs.readFileSync(path.join(legacyLock, "owner.json"), "utf8"));
    } catch {
      owner = null;
    }
    const ageMs = Date.now() - fs.statSync(legacyLock).mtimeMs;
    if (!owner && ageMs < 30_000) {
      throw new Error(`legacy generated-output lock has no complete owner record at ${legacyLock}; correction: retry after 30 seconds or preserve it for inspection`);
    }
    const state = owner ? ownerState(owner) : "stale";
    if (state === "active" || state === "unknown") {
      const detail = Number.isInteger(owner?.pid) ? ` PID ${owner.pid}` : "";
      const activity = state === "active" ? "is active" : "has uncertain identity";
      throw new Error(`legacy generated-output publisher${detail} ${activity} at ${legacyLock}; correction: wait for it to finish or preserve the lock for inspection`);
    }
    fs.rmSync(legacyLock, { recursive: true, force: true });
  }
  const residue = fs.readdirSync(root)
    .filter((name) => name === ".agentera-generated-publication.json"
      || name.startsWith(".dist.agentera-backup-")
      || name.startsWith(".bundle.agentera-backup-"))
    .sort();
  if (residue.length > 0) {
    const shown = residue.slice(0, 3).map((name) => path.join(root, name));
    throw new Error(`legacy generated-output recovery residue must be preserved for inspection: ${shown.join(", ")}${residue.length > shown.length ? ` (${residue.length - shown.length} more)` : ""}; correction: verify or remove the legacy residue, then rerun build`);
  }
}

function readLease(file) {
  const match = /^([0-9a-f-]+)\.(\d+)\.([A-Za-z0-9_-]+)\.(reader|publisher)\.lease$/.exec(path.basename(file));
  if (!match) throw new Error(`generated-output lease has an invalid name at ${file}`);
  const guard = readGuard(file, "generated-output lease");
  const processIdentity = match[3] === "none" ? null : Buffer.from(match[3], "base64url").toString();
  return { generationId: guard.id, pid: Number(match[2]), processIdentity, kind: match[4] };
}

function scanLeases(root) {
  const { leasesRoot } = generatedPaths(root);
  if (!optionalLstat(leasesRoot)) return { liveIds: new Set(), stale: [], unknown: [] };
  requireOwnedDirectory(leasesRoot, "generated-output leases root");
  const liveIds = new Set();
  const stale = [];
  const unknown = [];
  for (const name of fs.readdirSync(leasesRoot).sort()) {
    const file = path.join(leasesRoot, name);
    if (!name.endsWith(".lease")) {
      unknown.push(file);
      continue;
    }
    try {
      const lease = readLease(file);
      const state = ownerState(lease);
      if (state === "active") liveIds.add(lease.generationId);
      else if (state === "stale") stale.push(file);
      else unknown.push(file);
    } catch {
      unknown.push(file);
    }
  }
  return { liveIds, stale, unknown };
}

function classifyStaging(generatedRoot, name) {
  const candidate = path.join(generatedRoot, name);
  const match = /^\.staging-(\d+)-[0-9a-f-]+$/.exec(name);
  if (!match || !optionalLstat(candidate)?.isDirectory()) return { candidate, state: "unknown" };
  const ownerFile = path.join(candidate, ".owner.json");
  if (!optionalLstat(ownerFile)) {
    return { candidate, state: processIsAlive(Number(match[1])) ? "unknown" : "stale" };
  }
  try {
    return { candidate, state: ownerState(readJsonFile(ownerFile, "generated-output staging owner")) };
  } catch {
    return { candidate, state: "unknown" };
  }
}

function recoveryError(paths) {
  const shown = paths.slice(0, 3);
  return new Error(`generated-output state has unknown ownership: ${shown.join(", ")}${paths.length > shown.length ? ` (${paths.length - shown.length} more)` : ""}; correction: preserve it for inspection, remove only confirmed residue, then rerun pnpm -C packages/cli run generated:cleanup -- --force`);
}

function preserveInvalidCurrent(root, dryRun, report) {
  const { generatedRoot, current } = generatedPaths(root);
  const stat = optionalLstat(current);
  if (!stat) return;
  try {
    selectGeneratedGeneration(root);
    return;
  } catch {
    const preserved = path.join(generatedRoot, `.preserved-current-${randomUUID()}`);
    report.preserved.push(preserved);
    if (!dryRun) fs.renameSync(current, preserved);
  }
}

function reportResult(report) {
  return Object.fromEntries(Object.entries(report).map(([key, values]) => [key, {
    count: values.length,
    paths: values.slice(0, 10),
    omitted: Math.max(0, values.length - 10),
  }]));
}

export function cleanupGeneratedState(root, options = {}) {
  const dryRun = options.dryRun === true;
  const retention = options.retention ?? retainedGenerationLimit;
  const report = { removed: [], restored: [], preserved: [], retained: [] };
  const { generatedRoot, generationsRoot } = generatedPaths(root);
  if (!optionalLstat(generatedRoot)) return reportResult(report);
  requireOwnedDirectory(generatedRoot, "generated-output root");

  const staging = fs.readdirSync(generatedRoot).filter((name) => name.startsWith(".staging-")).map((name) => classifyStaging(generatedRoot, name));
  const unknown = staging.filter(({ state }) => state === "unknown").map(({ candidate }) => candidate);
  const leases = scanLeases(root);
  unknown.push(...leases.unknown);
  for (const name of fs.readdirSync(generatedRoot).filter((entry) => entry.startsWith(".current-"))) {
    const candidate = path.join(generatedRoot, name);
    if (!/^\.current-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) || !optionalLstat(candidate)?.isSymbolicLink()) unknown.push(candidate);
  }
  if (unknown.length > 0) throw recoveryError(unknown.sort());
  let currentRoot = null;
  try {
    currentRoot = selectGeneratedGeneration(root).root;
  } catch {
    // Missing current is valid before first publication and after preserved corruption.
  }
  const liveIds = leases.liveIds;
  const complete = [];
  const interrupted = [];
  let lexicalCurrent = null;
  try {
    const { current } = generatedPaths(root);
    if (optionalLstat(current)?.isSymbolicLink()) lexicalCurrent = fs.realpathSync(path.resolve(path.dirname(current), fs.readlinkSync(current)));
  } catch {
    // Invalid current is preserved after all uncertain state has been classified.
  }
  if (optionalLstat(generationsRoot)) {
    requireOwnedDirectory(generationsRoot, "generated-output generations root");
    for (const name of fs.readdirSync(generationsRoot).sort()) {
      const candidate = path.join(generationsRoot, name);
      try {
        const confined = assertDirectGeneration(root, candidate);
        const identity = readIdentity(path.join(confined.canonical, identityFile), "generation");
        if (identity.id !== name) throw new Error("generation name mismatch");
        validateGeneration(confined.canonical, identity.id);
        const guard = path.join(confined.canonical, guardFile);
        const retiring = fs.readdirSync(confined.canonical).filter((entry) => entry.startsWith(`${guardFile}.retiring-`));
        if (retiring.length > 1 || (retiring.length === 1 && optionalLstat(guard))) throw new Error("generation has conflicting guard state");
        if (retiring.length === 1) {
          if (readGuard(path.join(confined.canonical, retiring[0])).id !== identity.id) throw new Error("retiring guard identity mismatch");
          interrupted.push({ candidate: confined.canonical, guard: path.join(confined.canonical, retiring[0]), id: identity.id });
        } else {
          const hasGuard = optionalLstat(guard) !== null;
          if (hasGuard && readGuard(guard).id !== identity.id) throw new Error("generation guard identity mismatch");
          complete.push({ candidate: confined.canonical, guard: hasGuard ? guard : null, id: identity.id, mtimeMs: fs.statSync(confined.canonical).mtimeMs });
        }
      } catch {
        unknown.push(candidate);
      }
    }
  }
  if (unknown.length > 0) throw recoveryError(unknown.sort());

  preserveInvalidCurrent(root, dryRun, report);
  const removable = [
    ...staging.filter(({ state }) => state === "stale").map(({ candidate }) => candidate),
    ...leases.stale,
    ...fs.readdirSync(generatedRoot)
      .filter((name) => /^\.current-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name))
      .map((name) => path.join(generatedRoot, name)),
  ];
  for (const candidate of removable) {
    report.removed.push(candidate);
    if (!dryRun) fs.rmSync(candidate, { recursive: true, force: true });
  }
  if (!optionalLstat(generationsRoot)) return reportResult(report);

  for (const item of interrupted) {
    if (liveIds.has(item.id) || item.candidate === lexicalCurrent) {
      const target = path.join(item.candidate, guardFile);
      report.restored.push(target);
      if (!dryRun) fs.renameSync(item.guard, target);
    } else {
      report.removed.push(item.candidate);
      if (!dryRun) fs.rmSync(item.candidate, { recursive: true, force: true });
    }
  }

  const protectedIds = new Set(liveIds);
  if (currentRoot) protectedIds.add(path.basename(currentRoot));
  for (const item of complete.sort((left, right) => right.mtimeMs - left.mtimeMs)) {
    if (protectedIds.size >= retention || protectedIds.has(item.id)) continue;
    protectedIds.add(item.id);
  }
  for (const item of complete) {
    if (protectedIds.has(item.id)) {
      report.retained.push(item.candidate);
      continue;
    }
    if (dryRun) {
      report.removed.push(item.candidate);
      continue;
    }
    if (!item.guard) {
      fs.rmSync(item.candidate, { recursive: true, force: true });
      report.removed.push(item.candidate);
      continue;
    }
    const retiring = `${item.guard}.retiring-${randomUUID()}`;
    fs.renameSync(item.guard, retiring);
    if (scanLeases(root).liveIds.has(item.id)) {
      fs.renameSync(retiring, item.guard);
      report.restored.push(item.candidate);
    } else {
      fs.rmSync(item.candidate, { recursive: true, force: true });
      report.removed.push(item.candidate);
    }
  }
  return reportResult(report);
}

export function publishGeneratedGeneration(root, stagedRoot, generationId, options = {}) {
  assertGenerationId(generationId);
  rejectLegacyRecoveryResidue(root);
  validateGeneration(stagedRoot, generationId);
  if (options.faultAt === "after-validation") throw new Error("injected interruption at after-validation");

  const { generatedRoot, generationsRoot, current } = generatedPaths(root);
  requireOwnedDirectory(generatedRoot, "generated-output root", true);
  requireOwnedDirectory(generationsRoot, "generated-output generations root", true);
  const generationRoot = path.join(generationsRoot, generationId);
  if (optionalLstat(generationRoot)) throw new Error(`generated generation already exists at ${generationRoot}`);
  const publicationLease = createLease(root, stagedRoot, generationId, "publisher");
  try {
    fs.renameSync(stagedRoot, generationRoot);
    if (options.faultAt === "after-generation-rename") throw new Error("injected interruption at after-generation-rename");
    options.onBeforePointer?.();
    if (options.holdBeforePointerMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, options.holdBeforePointerMs);
    const temporaryPointer = path.join(generatedRoot, `.current-${generationId}`);
    fs.symlinkSync(path.relative(generatedRoot, generationRoot), temporaryPointer, "dir");
    if (options.faultAt === "after-temporary-pointer") throw new Error("injected interruption at after-temporary-pointer");
    preserveInvalidCurrent(root, false, { preserved: [] });
    fs.renameSync(temporaryPointer, current);
    if (options.faultAt === "after-pointer") throw new Error("injected interruption at after-pointer");
    return selectGeneratedGeneration(root);
  } finally {
    publicationLease.release();
  }
}

export const GENERATED_RETENTION_LIMIT = retainedGenerationLimit;
