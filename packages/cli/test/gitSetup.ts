import { execFileSync } from "node:child_process";

// Hooks export repository-local Git variables. Remove Git's complete list at
// the fixture boundary, before any test can initialize/configure/commit a repo.
for (const name of execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" }).trim().split(/\r?\n/)) {
  delete process.env[name];
}
