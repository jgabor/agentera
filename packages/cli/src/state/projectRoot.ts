import fs from "node:fs";
import path from "node:path";

export function validateRealProjectRoot(projectRoot: string): string {
  const root = path.resolve(projectRoot);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(root);
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
  return root;
}
