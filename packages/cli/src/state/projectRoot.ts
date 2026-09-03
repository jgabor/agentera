import fs from "node:fs";
import path from "node:path";

interface ProjectRootPathIdentity {
  absolute: string;
  dev: bigint;
  ino: bigint;
  type: "directory";
}

export interface ValidatedProjectRoot {
  path: string;
  identities: readonly ProjectRootPathIdentity[];
}

function directoryPrefixes(absolute: string): string[] {
  const parsed = path.parse(absolute);
  const segments = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  return [parsed.root, ...segments.map((_, index) => path.join(parsed.root, ...segments.slice(0, index + 1)))];
}

export function assertValidatedProjectRoot(root: ValidatedProjectRoot): void {
  const stable = root.identities.every((identity) => {
    try {
      const current = fs.lstatSync(identity.absolute, { bigint: true });
      return identity.type === "directory" && current.isDirectory() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino;
    } catch {
      return false;
    }
  });
  if (!stable) {
    throw new Error(`project root '${root.path}' changed after validation; restore the exact real directory and retry`);
  }
}

export function validateRealProjectRoot(projectRoot: string): ValidatedProjectRoot {
  const root = path.resolve(projectRoot);
  let stat: fs.BigIntStats;
  try {
    stat = fs.lstatSync(root, { bigint: true });
  } catch {
    throw new Error(`project root '${root}' does not exist; choose an existing, real directory and retry`);
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`project root '${root}' is a symbolic link; choose an existing, real directory and retry`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`project root '${root}' is not a directory; choose an existing, real directory and retry`);
  }
  try {
    if (fs.realpathSync(root) !== root) {
      throw new Error(`project root '${root}' traverses a symbolic link; choose an existing, real directory and retry`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("project root '")) throw error;
    throw new Error(`project root '${root}' cannot be resolved safely; choose an existing, real directory and retry`);
  }
  const identities = directoryPrefixes(root).map((absolute): ProjectRootPathIdentity => {
    const current = fs.lstatSync(absolute, { bigint: true });
    return { absolute, dev: current.dev, ino: current.ino, type: "directory" };
  });
  const validated = { path: root, identities };
  const rootIdentity = identities.at(-1)!;
  if (rootIdentity.dev !== stat.dev || rootIdentity.ino !== stat.ino) {
    throw new Error(`project root '${root}' changed during validation; restore the exact real directory and retry`);
  }
  assertValidatedProjectRoot(validated);
  return validated;
}
