import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { gitSourceTreeDigest } from "./git-source-tree.mjs";

const sourceIdentityFile = ".agentera-build-source.json";
const sourceIdentitySchema = "agentera.generatedBuildSource.v1";

export function generatedOutputRoot(root) {
  return path.join(root, ".agentera-generated");
}

function git(repo, args) {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(`unable to read generated-output source identity: ${String(result.stderr).trim()}`);
  return result.stdout;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function sourceIdentityDigest(value) {
  const { identitySha256: _identitySha256, ...unsigned } = value;
  return createHash("sha256").update(JSON.stringify(canonical(unsigned))).digest("hex");
}

export function sealGeneratedSourceIdentity(unsigned) {
  return { ...unsigned, identitySha256: sourceIdentityDigest(unsigned) };
}

export function validateGeneratedSourceIdentity(value, label = "generated build source identity") {
  if (value?.schemaVersion !== sourceIdentitySchema
    || !/^[0-9a-f]{40}$/.test(value?.commit ?? "")
    || !/^[0-9a-f]{40}$/.test(value?.tree ?? "")
    || !Number.isInteger(value?.files) || value.files < 1
    || !/^[0-9a-f]{64}$/.test(value?.workingTreeSha256 ?? "")
    || value?.identitySha256 !== sourceIdentityDigest(value)) {
    throw new Error(`${label} is malformed or self-inconsistent`);
  }
  return value;
}

export function generatedSourceIdentity(packageRoot) {
  const repo = path.resolve(packageRoot, "../..");
  const repoRoot = String(git(repo, ["rev-parse", "--show-toplevel"])).trim();
  if (fs.realpathSync(repoRoot) !== fs.realpathSync(repo)) {
    throw new Error(`generated-output package root is not inside its expected repository: ${packageRoot}`);
  }
  const workingTree = gitSourceTreeDigest(repo, { includeUntracked: true, label: "generated-output source identity" });
  return sealGeneratedSourceIdentity({
    schemaVersion: sourceIdentitySchema,
    commit: String(git(repo, ["rev-parse", "HEAD"])).trim(),
    tree: String(git(repo, ["rev-parse", "HEAD^{tree}"])).trim(),
    files: workingTree.files,
    workingTreeSha256: workingTree.sha256,
  });
}

export function sameGeneratedSourceIdentity(left, right) {
  return validateGeneratedSourceIdentity(left).identitySha256 === validateGeneratedSourceIdentity(right).identitySha256;
}

export function writeGeneratedSourceIdentity(outputRoot, identity) {
  const bytes = `${JSON.stringify(validateGeneratedSourceIdentity(identity), null, 2)}\n`;
  for (const surface of ["dist", "bundle"]) {
    fs.writeFileSync(path.join(outputRoot, surface, sourceIdentityFile), bytes, { flag: "wx" });
  }
}

export function readGeneratedSourceIdentity(outputRoot) {
  const identities = ["dist", "bundle"].map((surface) => {
    const file = path.join(outputRoot, surface, sourceIdentityFile);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`build source identity must be a regular file at ${file}`);
    return validateGeneratedSourceIdentity(JSON.parse(fs.readFileSync(file, "utf8")), `${surface} build source identity`);
  });
  if (!sameGeneratedSourceIdentity(identities[0], identities[1])) {
    throw new Error(`generated dist and bundle do not share one build source identity at ${outputRoot}`);
  }
  return identities[0];
}

export function validateRegularTree(root, label) {
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`${label} must be a regular directory at ${root}`);
  const canonicalRoot = fs.realpathSync(root);
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
      if (stat.isDirectory()) pending.push(candidate);
      else if (stat.isFile() && stat.nlink === 1) files += 1;
      else throw new Error(`${label} contains a non-regular or multiply linked entry at ${candidate}`);
    }
  }
  return { directories, files, entries: directories + files };
}
