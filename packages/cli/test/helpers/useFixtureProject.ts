import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Checked-in fixture roots under `packages/cli/test/fixtures/repo-state/`. */
export const REPO_STATE_FIXTURES_DIR = path.resolve(__dirname, "../fixtures/repo-state");

export const REPO_STATE_FIXTURE_NAMES = [
  "ok",
  "todo-resolved-over-limit",
  "progress-at-cap",
  "progress-over-limit",
  "invalid-progress-yaml",
] as const;

export type RepoStateFixtureName = (typeof REPO_STATE_FIXTURE_NAMES)[number];

export function repoStateFixturePath(name: RepoStateFixtureName): string {
  return path.join(REPO_STATE_FIXTURES_DIR, name);
}

/**
 * Copy a named repo-state fixture into an isolated temp directory.
 * Each call returns a fresh tree so parallel tests do not share mutations.
 */
export function useFixtureProject(name: RepoStateFixtureName): string {
  const src = repoStateFixturePath(name);
  if (!fs.existsSync(src)) {
    throw new Error(`unknown repo-state fixture: ${name} (expected ${src})`);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `repo-state-${name}-`));
  fs.cpSync(src, tmp, { recursive: true });
  return tmp;
}

export function cleanupFixtureProject(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}
