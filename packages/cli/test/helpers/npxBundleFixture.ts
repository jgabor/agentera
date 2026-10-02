import fs from "node:fs";
import path from "node:path";
import { NPX_BUNDLE_SENTINEL } from "../../src/core/sourceRoot.js";
import { loadHostSkillSource } from "../../src/setup/hostSkillLifecycle.js";

const repo = path.resolve(import.meta.dirname, "../../../..");

/** Source-owned bundle shape for root-selection tests, not package extraction evidence. */
export function npxBundleFixture(root: string): string {
  const source = loadHostSkillSource(repo);
  for (const directory of ["references", "skills"]) fs.cpSync(path.join(repo, directory), path.join(root, directory), { recursive: true });
  fs.copyFileSync(path.join(repo, "registry.json"), path.join(root, "registry.json"));
  const host = path.join(root, source.selection.path);
  fs.mkdirSync(host, { recursive: true });
  fs.copyFileSync(source.source, path.join(host, "SKILL.md"));
  fs.writeFileSync(path.join(root, NPX_BUNDLE_SENTINEL), JSON.stringify({ kind: "agentera-npx-bundle", suiteVersion: source.version }));
  return root;
}
