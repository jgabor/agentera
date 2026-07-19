import { spawnSync } from "node:child_process";

import { resolveBackend } from "./resolve.mjs";

const V3_NEXT_COMMAND = "npx -y agentera@next prime";

/**
 * Print the v3 deprecation hint to stderr unless the user opted out via
 * AGENTERA_NO_V3_HINT=1. Called once per dispatch (after the --version
 * early-return) so every v2 invocation surfaces the @next pointer while the
 * Python CLI remains on @latest.
 *
 * @param {{ logStderr?: (message: string) => void }} [options]
 * @returns {void}
 */
export function printV3Hint(options = {}) {
  if (process.env.AGENTERA_NO_V3_HINT === "1") {
    return;
  }
  const log = options.logStderr ?? ((msg) => console.error(msg));
  log("agentera 2.x (Python) is in maintenance; the v3 TypeScript CLI is ready on the @next tag:");
  log(`  ${V3_NEXT_COMMAND}`);
  log("Set AGENTERA_NO_V3_HINT=1 to suppress this message.");
}

/**
 * @typedef {object} RunBackendResult
 * @property {number} exitCode
 * @property {boolean} fallthrough true when the backend is unusable and dispatch should try the next strategy
 */

/**
 * @param {import('./resolve.mjs').ResolveResult} backend
 * @param {string[]} args
 * @param {{ gitRef?: string; gitRepo?: string; cwd?: string }} [meta]
 * @returns {RunBackendResult}
 */
export function runBackend(backend, args, meta = {}) {
  if (backend.kind === "app-home" && backend.scriptPath) {
    const exitCode = spawnChecked("uv", ["run", backend.scriptPath, ...args], {
      cwd: meta.cwd,
    });
    return { exitCode, fallthrough: exitCode !== 0 };
  }

  if (backend.kind === "repo" && backend.repoRoot) {
    return {
      exitCode: spawnChecked("uv", ["run", "scripts/agentera", ...args], {
        cwd: backend.repoRoot,
      }),
      fallthrough: false,
    };
  }

  if (backend.kind === "uvx") {
    const gitRef = backend.gitRef ?? meta.gitRef ?? "v2.7.7";
    const gitRepo = backend.gitRepo ?? meta.gitRepo ?? "https://github.com/jgabor/agentera";
    const from = `git+${gitRepo}@${gitRef}`;
    return {
      exitCode: spawnChecked("uvx", ["--from", from, "agentera", ...args], {}),
      fallthrough: false,
    };
  }

  return { exitCode: 1, fallthrough: false };
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
 * @param {(message: string) => void} [options.logStderr]
 * @returns {number}
 */
export function dispatch(argv, options = {}) {
  const userArgs = argv.slice(2);
  if (userArgs[0] === "--version" || userArgs[0] === "-V") {
    return 0;
  }

  printV3Hint({ logStderr: options.logStderr });

  let backend = resolveBackend({
    cwd: options.cwd,
    env: options.env,
    gitRef: options.gitRef,
    gitRepo: options.gitRepo,
    logStderr: options.logStderr,
  });

  if (backend.kind === "app-home") {
    const result = runBackend(backend, userArgs, {
      gitRef: options.gitRef,
      gitRepo: options.gitRepo,
      cwd: options.cwd,
    });
    if (!result.fallthrough) {
      return result.exitCode;
    }
    console.error(
      `agentera: app-home backend crashed (exit ${result.exitCode}); falling through to next resolution strategy`,
    );
    backend = resolveBackend({
      cwd: options.cwd,
      env: options.env,
      gitRef: options.gitRef,
      gitRepo: options.gitRepo,
      excludeAppHome: true,
    });
  }

  if (backend.kind === "none") {
    const print = options.printInstallHelp ?? printInstallHelp;
    print(backend.reason ?? "no backend available");
    return 1;
  }

  return runBackend(backend, userArgs, {
    gitRef: options.gitRef,
    gitRepo: options.gitRepo,
    cwd: options.cwd,
  }).exitCode;
}

/**
 * @param {string} [reason]
 */
export function printInstallHelp(reason) {
  const lines = [
    "agentera: npm CLI shim (0.x) — native TypeScript CLI ships in Agentera 3.0.",
    reason ? `agentera: ${reason}` : "",
  ];
  if (process.env.AGENTERA_NO_V3_HINT !== "1") {
    lines.push(
      "",
      "The v3 TypeScript CLI is ready now on the @next tag:",
      `  ${V3_NEXT_COMMAND}`,
      "",
      "Preview and install the shared skill plus Agentera-owned runtime resources:",
      "  npx -y agentera@next upgrade --runtime all --dry-run",
      "  npx -y agentera@next upgrade --runtime all --yes",
    );
  }
  lines.push(
    "",
    "Stable 2.x recovery from a clone (requires uv):",
    "  uv run scripts/agentera prime",
    "",
    "https://github.com/jgabor/agentera#install",
  );
  for (const line of lines.filter(Boolean)) {
    console.error(line);
  }
}
