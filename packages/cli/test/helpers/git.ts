import { spawnSync } from "node:child_process";

export function historicalPluginFixture(root: string): Buffer {
  const object = "aa33870df05d53745ebad5351b8a352b7dad7780:.opencode/plugins/agentera.js";
  const result = spawnSync("git", ["show", object], { cwd: root, encoding: null });
  if (result.status !== 0) {
    throw new Error(`Historical plugin fixture requires git and repository object ${object}; make that history available in this checkout (shallow checkouts may omit it). ${result.error?.message ?? result.stderr?.toString().trim()}`);
  }
  return result.stdout;
}

export function gitCommitArgs(...args: string[]): string[] {
  return ["-c", "user.name=Agentera Test", "-c", "user.email=agentera-test@example.invalid", "-c", "commit.gpgsign=false", "commit", ...args];
}
