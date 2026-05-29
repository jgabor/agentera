import { spawnSync } from "node:child_process";

export interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run `git` in `cwd`; return `null` if git cannot be invoked. */
export function gitRun(args: string[], cwd: string): GitResult | null {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error) {
    return null;
  }
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export type AncestorState = "ancestor" | "stale" | "unknown" | "unavailable";

/**
 * Classify `token` relative to HEAD: `ancestor` (already in history), `stale`
 * (resolves but not an ancestor of HEAD), `unknown` (not a commit object here),
 * or `unavailable` (git/HEAD missing). Faithful port of progress_commit.ancestor_state.
 */
export function ancestorState(token: string, cwd: string): AncestorState {
  const head = gitRun(["rev-parse", "--verify", "--quiet", "HEAD"], cwd);
  if (head === null || head.status !== 0) {
    return "unavailable";
  }
  const exists = gitRun(["rev-parse", "--verify", "--quiet", `${token}^{commit}`], cwd);
  if (exists === null) {
    return "unavailable";
  }
  if (exists.status !== 0) {
    return "unknown";
  }
  const ancestor = gitRun(["merge-base", "--is-ancestor", token, "HEAD"], cwd);
  if (ancestor === null) {
    return "unavailable";
  }
  if (ancestor.status === 0) {
    return "ancestor";
  }
  if (ancestor.status === 1) {
    return "stale";
  }
  return "unavailable";
}
