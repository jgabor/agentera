import { spawnSync } from "node:child_process";

import type { NextAction, UnfinishedWork } from "../contracts/orientationState.js";

/** The Git read must leave room inside the startup latency target. */
const GIT_STATUS_TIMEOUT_MS = 2000;
const GIT_STATUS_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

function gitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"]) delete env[name];
  return env;
}

/**
 * The project's uncommitted work: current branch and changed-file count, never
 * file names or content. One read-only `git status` that takes no optional
 * locks, so startup never rewrites the index. An untracked directory counts as
 * one change. A repository without a first commit has nothing to resume: its
 * files are the new project, and init hands off to vision. Any failure (no
 * repository, no Git, timeout, oversized output) means no signal rather than
 * a degraded start.
 */
export function readUnfinishedWork(project: string): UnfinishedWork | null {
  const result = spawnSync("git", ["--no-optional-locks", "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal", "--", "."], {
    cwd: project,
    env: gitEnvironment(),
    encoding: "utf8",
    timeout: GIT_STATUS_TIMEOUT_MS,
    maxBuffer: GIT_STATUS_MAX_BUFFER_BYTES,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0) return null;
  const records = result.stdout.split("\0");
  let branch: string | null = null;
  let unborn = false;
  let changedFiles = 0;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === "# branch.oid (initial)") unborn = true;
    else if (record.startsWith("# branch.head ")) branch = record.slice("# branch.head ".length);
    else if (record.startsWith("1 ") || record.startsWith("u ") || record.startsWith("? ")) changedFiles += 1;
    else if (record.startsWith("2 ")) {
      // A rename or copy carries its original path as the next record.
      changedFiles += 1;
      index += 1;
    }
  }
  if (unborn || branch === null || changedFiles === 0) return null;
  return { branch: branch === "(detached)" ? "detached HEAD" : branch, changed_files: changedFiles };
}

/** The next step that resumes uncommitted work ahead of state-based routing. */
export function resumeNextAction(work: UnfinishedWork): NextAction {
  const files = work.changed_files === 1 ? "1 changed file is" : `${work.changed_files} changed files are`;
  return {
    object: `Resume unfinished work on ${work.branch}`,
    capability: "build",
    reason: `${files} uncommitted on ${work.branch}; finish or commit them before starting new work.`,
    phase: "build",
    unfinished_work: work,
  };
}
