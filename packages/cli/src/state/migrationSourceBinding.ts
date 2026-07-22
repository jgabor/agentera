import type { ValidatedProjectRoot } from "./projectRoot.js";
import { validateRealProjectRoot } from "./projectRoot.js";
import { readProjectFileSnapshot } from "./safeProjectFile.js";

export type MigrationSourceBindingContext =
  | { kind: "project"; projectRoot: string }
  | { kind: "git_commit"; commit: string; readSource: (path: string) => string | undefined };

export type BoundMigrationSource =
  | { kind: "file"; bytes: string }
  | { kind: "missing" }
  | { kind: "unsafe"; reason: string };

function projectSource(project: ValidatedProjectRoot, sourcePath: string): BoundMigrationSource {
  const snapshot = readProjectFileSnapshot(project, sourcePath);
  return snapshot.kind === "file"
    ? { kind: "file", bytes: snapshot.bytes.toString("utf8") }
    : snapshot.kind === "missing" ? { kind: "missing" } : { kind: "unsafe", reason: snapshot.reason };
}

/** Read one authority-approved provenance source from one pinned project or Git snapshot. */
export function readBoundMigrationSource(binding: MigrationSourceBindingContext, sourcePath: string): BoundMigrationSource {
  if (binding.kind === "project") {
    try { return projectSource(validateRealProjectRoot(binding.projectRoot), sourcePath); }
    catch (error) { return { kind: "unsafe", reason: (error as Error).message }; }
  }
  if (!/^[a-f0-9]{40,64}$/.test(binding.commit)) return { kind: "unsafe", reason: "Git binding requires an immutable commit ID" };
  try {
    const bytes = binding.readSource(sourcePath);
    return bytes === undefined ? { kind: "missing" } : { kind: "file", bytes };
  } catch (error) {
    return { kind: "unsafe", reason: `cannot read commit '${binding.commit}': ${(error as Error).message}` };
  }
}
