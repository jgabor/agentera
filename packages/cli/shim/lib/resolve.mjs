import fs from "node:fs";
import path from "node:path";

const DEFAULT_GIT_REPO = "https://github.com/jgabor/agentera";
const APP_SCRIPT_REL = path.join("app", "scripts", "agentera");
const REPO_SCRIPT_REL = path.join("scripts", "agentera");

const HEAD_READ_BYTES = 2048;
const APP_HOME_MISMATCH_PREFIX = "agentera: app-home backend unavailable: shebang/content mismatch";

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
 * @typedef {object} ResolveOptions
 * @property {string} [cwd]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {string} [gitRef]
 * @property {string} [gitRepo]
 * @property {boolean} [excludeAppHome]
 * @property {(message: string) => void} [logStderr]
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
 * @param {string} filePath
 * @returns {string | null}
 */
function readHead(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(HEAD_READ_BYTES);
    const bytes = fs.readSync(fd, buf, 0, HEAD_READ_BYTES, 0);
    return buf.slice(0, bytes).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * @param {string} shebang
 * @returns {'js' | 'python' | 'unknown'}
 */
function shebangRuntime(shebang) {
  if (/\bnode\b/.test(shebang)) {
    return "js";
  }
  if (/\bpython\d*\b/.test(shebang) || /\buv\b[^\n]*\brun\b/.test(shebang)) {
    return "python";
  }
  return "unknown";
}

/**
 * @param {string} body
 * @returns {'js' | 'python' | 'unknown'}
 */
function contentLanguage(body) {
  if (body.includes("# /// script")) {
    return "python";
  }
  if (/\brequire\s*\(/.test(body) || /\bmodule\.exports\b/.test(body)) {
    return "js";
  }
  if (/^\s*import\s+[^'"\n]+\s+from\s+['"]/m.test(body)) {
    return "js";
  }
  if (/^\s*import\s+['"]/m.test(body)) {
    return "js";
  }
  const lines = body.split("\n").slice(0, 30);
  for (const raw of lines) {
    const t = raw.trimStart();
    if (
      /^import\s+\w+\s*$/.test(t) ||
      t.startsWith("from ") ||
      t.startsWith("def ") ||
      t.startsWith("class ")
    ) {
      return "python";
    }
    if (
      t.startsWith("const ") ||
      t.startsWith("let ") ||
      t.startsWith("var ") ||
      t.startsWith("export ")
    ) {
      return "js";
    }
  }
  return "unknown";
}

/**
 * @param {string} filePath
 * @returns {string | null}
 */
export function detectShebangContentMismatch(filePath) {
  const head = readHead(filePath);
  if (head === null) {
    return null;
  }
  const nl = head.indexOf("\n");
  const shebang = (nl >= 0 ? head.slice(0, nl) : head).trim();
  if (!shebang.startsWith("#!")) {
    return null;
  }
  const body = nl >= 0 ? head.slice(nl + 1) : "";
  const expected = shebangRuntime(shebang);
  const actual = contentLanguage(body);
  if (expected === "unknown" || actual === "unknown") {
    return null;
  }
  if (expected !== actual) {
    return `shebang=${expected} content=${actual}`;
  }
  return null;
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
 * @param {{ logStderr?: (message: string) => void }} [options]
 * @returns {string | null}
 */
export function findAppHomeScript(agenteraHome, options = {}) {
  if (!agenteraHome) {
    return null;
  }
  const scriptPath = path.join(path.resolve(agenteraHome), APP_SCRIPT_REL);
  if (!isRunnableFile(scriptPath)) {
    return null;
  }
  const mismatch = detectShebangContentMismatch(scriptPath);
  if (mismatch) {
    const log = options.logStderr ?? ((msg) => console.error(msg));
    log(`${APP_HOME_MISMATCH_PREFIX} (${mismatch}) at ${scriptPath}`);
    return null;
  }
  return scriptPath;
}

/**
 * @param {ResolveOptions} [options]
 * @returns {ResolveResult}
 */
export function resolveBackend({
  cwd = process.cwd(),
  env = process.env,
  gitRef = "v2.7.7",
  gitRepo = DEFAULT_GIT_REPO,
  excludeAppHome = false,
  logStderr,
} = {}) {
  if (!excludeAppHome) {
    const scriptPath = findAppHomeScript(env.AGENTERA_HOME, { logStderr });
    if (scriptPath) {
      return { kind: "app-home", scriptPath };
    }
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
