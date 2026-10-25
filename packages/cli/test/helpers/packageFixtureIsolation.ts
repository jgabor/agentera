import fs from "node:fs";
import path from "node:path";

/** One line per entry under the shared package roots, keyed by absolute path. */
export type SharedTreeStamp = Record<string, string>;

// Package test files run in parallel workers against one extracted package and
// one construction root. A test that changes either one, even briefly and with
// the bytes restored afterwards, breaks CLI runs in other files. Inode, mtime,
// and ctime change on every write, unlink, or replacement, so a restored
// mutation still shows up. Links are recorded, never followed.
export function sharedTreeStamp(roots: readonly string[]): SharedTreeStamp {
  const stamp: SharedTreeStamp = {};
  const visit = (target: string): void => {
    const stat = fs.lstatSync(target, { bigint: true });
    const link = stat.isSymbolicLink() ? ` link=${fs.readlinkSync(target)}` : "";
    stamp[target] = `ino=${stat.ino} mode=${stat.mode} size=${stat.size} mtime=${stat.mtimeNs} ctime=${stat.ctimeNs}${link}`;
    if (stat.isDirectory()) for (const name of fs.readdirSync(target).sort()) visit(path.join(target, name));
  };
  for (const root of roots) visit(root);
  return stamp;
}

export function sharedTreeChanges(before: SharedTreeStamp, after: SharedTreeStamp): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((entry) => before[entry] !== after[entry]).sort();
}

export function assertSharedTreeUnchanged(before: SharedTreeStamp, roots: readonly string[]): void {
  const changes = sharedTreeChanges(before, sharedTreeStamp(roots));
  if (changes.length > 0) {
    throw new Error(`shared package fixture changed while package tests ran in parallel; change a private copy from privatePackageCopy() instead: ${changes.slice(0, 10).join(", ")}${changes.length > 10 ? ` (+${changes.length - 10} more)` : ""}`);
  }
}

/**
 * Copy the shared extracted package for a test that must change it. With
 * `standaloneDependencies`, the copy gets real copies of the declared
 * dependencies instead of the link to the checkout's installed graph.
 */
export function privatePackageCopy(packageRoot: string, destination: string, { standaloneDependencies = false }: { standaloneDependencies?: boolean } = {}): string {
  fs.cpSync(packageRoot, destination, { recursive: true, verbatimSymlinks: true });
  if (standaloneDependencies) {
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    const modules = path.join(destination, "node_modules");
    fs.rmSync(modules, { recursive: true, force: true });
    fs.mkdirSync(modules);
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      fs.cpSync(fs.realpathSync(path.join(packageRoot, "node_modules", name)), path.join(modules, name), { recursive: true });
    }
  }
  return destination;
}
