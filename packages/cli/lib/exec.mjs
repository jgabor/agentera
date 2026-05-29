import { spawnSync } from "node:child_process";
import path from "node:path";

import { resolveBackend } from "./resolve.mjs";

/**
 * @param {import('./resolve.mjs').ResolveResult} backend
 * @param {string[]} args
 * @param {{ gitRef?: string; gitRepo?: string }} [meta]
 * @returns {number}
 */
export function runBackend(backend, args, meta = {}) {
  if (backend.kind === "app-home" && backend.scriptPath) {
    const appRoot = path.dirname(path.dirname(backend.scriptPath));
    return spawnChecked("uv", ["run", backend.scriptPath, ...args], {
      cwd: appRoot,
    });
  }

  if (backend.kind === "repo" && backend.repoRoot) {
    return spawnChecked("uv", ["run", "scripts/agentera", ...args], {
      cwd: backend.repoRoot,
    });
  }

  if (backend.kind === "uvx") {
    const gitRef = backend.gitRef ?? meta.gitRef ?? "v2.7.6";
    const gitRepo = backend.gitRepo ?? meta.gitRepo ?? "https://github.com/jgabor/agentera";
    const from = `git+${gitRepo}@${gitRef}`;
    return spawnChecked("uvx", ["--from", from, "agentera", ...args], {});
  }

  return 1;
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string }} options
 * @returns {number}
 */
function spawnChecked(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) {
    console.error(`agentera: failed to run ${command}: ${result.error.message}`);
    return 1;
  }
  if (result.signal) {
    return 128;
  }
  return result.status ?? 1;
}

/**
 * @param {string[]} argv
 * @param {object} options
 * @param {string} [options.cwd]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.gitRef]
 * @param {string} [options.gitRepo]
 * @param {(message: string) => void} [options.printInstallHelp]
 * @returns {number}
 */
export function dispatch(argv, options = {}) {
  const userArgs = argv.slice(2);
  if (userArgs[0] === "--version" || userArgs[0] === "-V") {
    return 0;
  }

  const backend = resolveBackend({
    cwd: options.cwd,
    env: options.env,
    gitRef: options.gitRef,
    gitRepo: options.gitRepo,
  });

  if (backend.kind === "none") {
    const print = options.printInstallHelp ?? printInstallHelp;
    print(backend.reason ?? "no backend available");
    return 1;
  }

  return runBackend(backend, userArgs, {
    gitRef: options.gitRef,
    gitRepo: options.gitRepo,
  });
}

/**
 * @param {string} [reason]
 */
export function printInstallHelp(reason) {
  const lines = [
    "agentera: npm CLI shim (0.x) — native TypeScript CLI ships in Agentera 3.0.",
    reason ? `agentera: ${reason}` : "",
    "",
    "Install Agentera for your runtime:",
    "  npx skills add jgabor/agentera -g -a claude-code --skill agentera -y",
    "  npx skills add jgabor/agentera -g -a opencode --skill agentera -y",
    "",
    "Upgrade / app-home CLI (requires uv):",
    "  uvx --from git+https://github.com/jgabor/agentera agentera upgrade",
    "",
    "From a clone:",
    "  uv run scripts/agentera prime",
    "",
    "https://github.com/jgabor/agentera#install",
  ].filter(Boolean);
  for (const line of lines) {
    console.error(line);
  }
}
