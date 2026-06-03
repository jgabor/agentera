import fs from "node:fs";
import path from "node:path";

const DEFAULT_GIT_REPO = "https://github.com/jgabor/agentera";
const APP_SCRIPT_REL = path.join("app", "scripts", "agentera");
const REPO_SCRIPT_REL = path.join("scripts", "agentera");

/**
 * @typedef {'app-home' | 'repo' | 'uvx' | 'none'} BackendKind
 */

/**
 * @typedef {object} ResolveResult
 * @property {BackendKind} kind
 * @property {string} [scriptPath]
 * @property {string} [repoRoot]
 * @property {string} [gitRef]
 * @property {string} [gitRepo]
 * @property {string} [reason]
 */

/**
 * @param {string | undefined} command
 * @returns {boolean}
 */
export function commandOnPath(command) {
  if (!command) {
    return false;
  }
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      // continue
    }
  }
  return false;
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
export function isRunnableFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * @param {string} startDir
 * @returns {string | null}
 */
export function findRepoRoot(startDir) {
  let current = path.resolve(startDir);
  for (;;) {
    const scriptPath = path.join(current, REPO_SCRIPT_REL);
    if (isRunnableFile(scriptPath)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/**
 * @param {string | undefined} agenteraHome
 * @returns {string | null}
 */
export function findAppHomeScript(agenteraHome) {
  if (!agenteraHome) {
    return null;
  }
  const scriptPath = path.join(path.resolve(agenteraHome), APP_SCRIPT_REL);
  return isRunnableFile(scriptPath) ? scriptPath : null;
}

/**
 * @param {object} options
 * @param {string} [options.cwd]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.gitRef]
 * @param {string} [options.gitRepo]
 * @returns {ResolveResult}
 */
export function resolveBackend({
  cwd = process.cwd(),
  env = process.env,
  gitRef = "v2.7.7",
  gitRepo = DEFAULT_GIT_REPO,
} = {}) {
  const scriptPath = findAppHomeScript(env.AGENTERA_HOME);
  if (scriptPath) {
    return { kind: "app-home", scriptPath };
  }

  const repoRoot = findRepoRoot(cwd);
  if (repoRoot && commandOnPath("uv")) {
    return { kind: "repo", repoRoot };
  }

  if (commandOnPath("uv")) {
    return { kind: "uvx", gitRef, gitRepo };
  }

  if (repoRoot) {
    return {
      kind: "none",
      reason: "found scripts/agentera in a checkout but uv is not on PATH",
    };
  }

  return {
    kind: "none",
    reason: "no installed app, no repo checkout, and uv is not on PATH",
  };
}
