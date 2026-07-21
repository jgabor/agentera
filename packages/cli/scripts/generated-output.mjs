import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const generatedDirectory = ".agentera-generated";
const identityFile = ".agentera-generation.json";
const guardFile = ".agentera-generation.guard";
const guardSchema = "agentera.generatedGuard.v1";
const retainedGenerationLimit = 2;
const mutationLockName = ".mutation-lock";
const mutationLockWaitMs = 30_000;

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

export function processStartIdentity(pid, options = {}) {
  const platform = options.platform ?? process.platform;
  const readFile = options.readFile ?? ((file) => fs.readFileSync(file, "utf8"));
  const run = options.spawnSync ?? spawnSync;
  try {
    if (platform === "linux") {
      const stat = readFile(`/proc/${pid}/stat`);
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      return fields[19] ? `linux-start:${fields[19]}` : null;
    }
    if (platform === "darwin") {
      const result = run("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
      const started = result.status === 0 ? result.stdout?.trim() : "";
      return started ? `darwin-start:${started.replace(/\s+/g, " ")}` : null;
    }
    if (platform === "win32") {
      const command = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`;
      const result = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", windowsHide: true });
      const started = result.status === 0 ? result.stdout?.trim() : "";
      return /^\d+$/.test(started) ? `win32-start:${started}` : null;
    }
  } catch {
    // Unsupported or unavailable process inspection is represented explicitly.
  }
  return null;
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
  return { pid: process.pid, processIdentity: processStartIdentity(process.pid) };
}

export function classifyProcessOwner(owner, options = {}) {
  const isAlive = options.isAlive ?? processIsAlive;
  const identityForPid = options.identityForPid ?? processStartIdentity;
  if (!Number.isInteger(owner?.pid)) return "unknown";
  if (!isAlive(owner.pid)) return "stale";
  if (typeof owner.processIdentity !== "string") return "unknown";
  const observed = identityForPid(owner.pid);
  if (observed === null) return "unknown";
  return observed === owner.processIdentity ? "active" : "stale";
}

function ownerState(owner) {
  return classifyProcessOwner(owner);
}

function pathIsWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

export function validateRegularTree(root, label) {
  const canonicalRoot = requireOwnedDirectory(root, label);
  const pending = [canonicalRoot];
  let directories = 0;
  let files = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    directories += 1;
    for (const name of fs.readdirSync(directory)) {
      const candidate = path.join(directory, name);
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink()) throw new Error(`${label} contains a symbolic link at ${candidate}`);
      const canonical = fs.realpathSync(candidate);
      if (!pathIsWithin(canonicalRoot, canonical)) throw new Error(`${label} entry escapes its governed root at ${candidate}`);
      if (stat.isDirectory()) pending.push(candidate);
      else if (stat.isFile()) {
        if (stat.nlink !== 1) throw new Error(`${label} contains a multiply linked file at ${candidate}`);
        files += 1;
      } else {
        throw new Error(`${label} contains a non-regular entry at ${candidate}`);
      }
    }
  }
  return { directories, files, entries: directories + files };
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
  const inventory = {};
  for (const surface of ["dist", "bundle"]) {
    const surfaceRoot = path.join(generationRoot, surface);
    inventory[surface] = validateRegularTree(surfaceRoot, `${surface} surface`);
  }
  const identities = [
    readIdentity(path.join(generationRoot, identityFile), "generation"),
    readIdentity(path.join(generationRoot, "dist", identityFile), "dist"),
    readIdentity(path.join(generationRoot, "bundle", identityFile), "bundle"),
  ];
  if (identities.some(({ id }) => id !== expectedId)) {
    throw new Error(`generated surfaces do not share generation ${JSON.stringify(expectedId)} at ${generationRoot}`);
  }
  return { id: expectedId, root: generationRoot, inventory };
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
  if (!optionalLstat(leasesRoot)) return { liveIds: new Set(), uncertainIds: new Set(), stale: [], uncertain: [], unknown: [] };
  requireOwnedDirectory(leasesRoot, "generated-output leases root");
  const liveIds = new Set();
  const uncertainIds = new Set();
  const stale = [];
  const uncertain = [];
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
      else {
        uncertainIds.add(lease.generationId);
        uncertain.push(file);
      }
    } catch {
      unknown.push(file);
    }
  }
  return { liveIds, uncertainIds, stale, uncertain, unknown };
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

function acquireGeneratedMutationLock(root) {
  const { generatedRoot } = generatedPaths(root);
  requireOwnedDirectory(generatedRoot, "generated-output root", true);
  const lock = path.join(generatedRoot, mutationLockName);
  const deadline = Date.now() + mutationLockWaitMs;
  while (true) {
    const token = randomUUID();
    try {
      fs.mkdirSync(lock);
      try {
        fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ ...ownerEvidence(), token }) + "\n", { flag: "wx" });
      } catch (error) {
        fs.rmSync(lock, { recursive: true, force: true });
        throw error;
      }
      return () => {
        try {
          const owner = readJsonFile(path.join(lock, "owner.json"), "generated-output mutation owner");
          if (owner.token === token) fs.rmSync(lock, { recursive: true, force: true });
        } catch {
          // Never remove a lock that no longer proves this caller owns it.
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    let owner = null;
    try {
      owner = readJsonFile(path.join(lock, "owner.json"), "generated-output mutation owner");
    } catch {
      const stat = optionalLstat(lock);
      if (!stat) continue;
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`generated-output mutation lock is not a regular directory at ${lock}`);
      if (Date.now() - stat.mtimeMs >= mutationLockWaitMs) owner = { pid: -1, processIdentity: "stale-ownerless-lock" };
    }
    const state = owner === null ? "active" : owner.pid === -1 ? "stale" : ownerState(owner);
    if (state === "unknown") {
      throw new Error(`generated-output mutation owner identity is unavailable at ${lock}; correction: preserve the lock for inspection and rerun on Linux, macOS, or Windows with process-start inspection available`);
    }
    if (state === "stale") {
      const claimed = path.join(generatedRoot, `${mutationLockName}.reclaim-${randomUUID()}`);
      try {
        fs.renameSync(lock, claimed);
        fs.rmSync(claimed, { recursive: true, force: true });
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`generated-output mutation lock remained active for ${mutationLockWaitMs} ms at ${lock}; correction: wait for the owning build or cleanup to finish, then retry`);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

export function withGeneratedStateLock(root, operation) {
  const release = acquireGeneratedMutationLock(root);
  try {
    return operation();
  } finally {
    release();
  }
}

function cleanupGeneratedStateUnlocked(root, options = {}) {
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
  const leaseProtectedIds = new Set([...leases.liveIds, ...leases.uncertainIds]);
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
    if (leaseProtectedIds.has(item.id) || item.candidate === lexicalCurrent) {
      const target = path.join(item.candidate, guardFile);
      report.restored.push(target);
      if (!dryRun) fs.renameSync(item.guard, target);
    } else {
      report.removed.push(item.candidate);
      if (!dryRun) fs.rmSync(item.candidate, { recursive: true, force: true });
    }
  }

  const protectedIds = new Set(leaseProtectedIds);
  const currentId = currentRoot ? path.basename(currentRoot) : null;
  if (currentId) protectedIds.add(currentId);
  let ordinaryRetained = currentId === null ? 0 : 1;
  for (const item of complete.sort((left, right) => right.mtimeMs - left.mtimeMs)) {
    if (protectedIds.has(item.id) || ordinaryRetained >= retention) continue;
    protectedIds.add(item.id);
    ordinaryRetained += 1;
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
    const refreshedLeases = scanLeases(root);
    if (refreshedLeases.liveIds.has(item.id) || refreshedLeases.uncertainIds.has(item.id)) {
      fs.renameSync(retiring, item.guard);
      report.restored.push(item.candidate);
    } else {
      fs.rmSync(item.candidate, { recursive: true, force: true });
      report.removed.push(item.candidate);
    }
  }
  if (leases.uncertain.length > 0) {
    const shown = leases.uncertain.slice(0, 3);
    throw new Error(`generated-output cleanup retained ${leases.uncertain.length} lease(s) with unavailable process-start identity: ${shown.join(", ")}${leases.uncertain.length > shown.length ? ` (${leases.uncertain.length - shown.length} more)` : ""}; correction: preserve them for inspection and rerun cleanup where process-start identity is available`);
  }
  return reportResult(report);
}

export function cleanupGeneratedState(root, options = {}) {
  if (options.lockHeld) return cleanupGeneratedStateUnlocked(root, options);
  if (!optionalLstat(generatedPaths(root).generatedRoot)) return reportResult({ removed: [], restored: [], preserved: [], retained: [] });
  return withGeneratedStateLock(root, () => cleanupGeneratedStateUnlocked(root, { ...options, lockHeld: true }));
}

function publishGeneratedGenerationUnlocked(root, stagedRoot, generationId, options = {}) {
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

export function publishGeneratedGeneration(root, stagedRoot, generationId, options = {}) {
  if (options.lockHeld) return publishGeneratedGenerationUnlocked(root, stagedRoot, generationId, options);
  return withGeneratedStateLock(root, () => publishGeneratedGenerationUnlocked(root, stagedRoot, generationId, { ...options, lockHeld: true }));
}

export const GENERATED_RETENTION_LIMIT = retainedGenerationLimit;
