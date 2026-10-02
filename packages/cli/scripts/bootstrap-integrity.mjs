import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Reviewed immutable release bytes. Never learn expected digests at runtime.
// See references/analysis/bootstrap-integrity.md for provenance and trust roots.
export const VP_VERSION = "1.0.0";
export const VP_ARCHIVE_URL = "https://github.com/voidzero-dev/vite-plus/releases/download/v1.0.0/vp-x86_64-unknown-linux-gnu.tar.gz";
export const VP_ARCHIVE_SHA256 = "2adca8386c8f7e158eea4abe1a3eda9f89313c869145f788409a0be45979dd6a";
export const PNPM_REFERENCE = "pnpm@10.30.3+sha512.c961d1e0a2d8e354ecaa5166b822516668b7f44cb5bd95122d590dd81922f606f5473b6d23ec4a5be05e7fcd18e8488d47d978bbe981872f1145d06e9a740017";
const ROOT = path.resolve(import.meta.dirname, "../../..");
const NODE_VERSION = fs.readFileSync(path.join(ROOT, ".node-version"), "utf8").trim();

export function verifiedVpArchive(bytes) {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), VP_ARCHIVE_SHA256, "Vite+ archive integrity mismatch");
  return bytes;
}

export function run(command, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${command} ${args.join(" ")} exited ${code}\n${output}`));
      else resolve(output);
    });
  });
}

export async function provisionVpArchive(parent) {
  const response = await fetch(VP_ARCHIVE_URL, { signal: AbortSignal.timeout(30_000) });
  assert.equal(response.ok, true, `Vite+ download failed: ${response.status}`);
  const bytes = verifiedVpArchive(Buffer.from(await response.arrayBuffer()));
  const home = fs.mkdtempSync(path.join(parent, "vp-provision-"));
  const archive = path.join(home, "vp.tgz");
  fs.writeFileSync(archive, bytes, { flag: "wx" });
  return archive;
}

// Only Linux x64 glibc is qualified. Check the complete archive before tar reads
// one member to stdout; never unpack downloaded paths or execute an installer.
export function prepareBootstrap(parent, archive) {
  assert.equal(process.platform, "linux", "Linux x64 glibc bootstrap required");
  assert.equal(process.arch, "x64", "Linux x64 glibc bootstrap required");
  const bytes = verifiedVpArchive(fs.readFileSync(archive));
  const home = fs.mkdtempSync(path.join(parent, "bootstrap-"));
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  const checkedArchive = path.join(home, "vp.tgz");
  fs.writeFileSync(checkedArchive, bytes, { flag: "wx" });
  const binary = execFileSync("/bin/tar", ["--use-compress-program=/bin/gzip", "-xOf", checkedArchive, "vp"], { env: {}, maxBuffer: 32 * 1024 * 1024 });
  const vp = path.join(bin, "vp");
  fs.writeFileSync(vp, binary, { flag: "wx", mode: 0o755 });
  // No ambient Node, pnpm, vp, npm credentials/config, OIDC, NODE_OPTIONS,
  // proxy/mirror overrides, or previous runtime/cache is inherited.
  for (const command of ["sh", "sed", "dirname", "uname"]) fs.symlinkSync(`/bin/${command}`, path.join(bin, command));
  const env = {
    HOME: home,
    PATH: bin,
    CI: "true",
    VP_HOME: path.join(home, "vp-home"),
    VP_NODE_VERSION: NODE_VERSION,
    VP_PACKAGE_MANAGER: PNPM_REFERENCE,
    VP_PNPM_VERSION: PNPM_REFERENCE.slice("pnpm@".length),
    XDG_CACHE_HOME: path.join(home, "cache"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_DATA_HOME: path.join(home, "data"),
    TMPDIR: home,
    npm_config_userconfig: path.join(home, "npmrc"),
    npm_config_globalconfig: path.join(home, "global-npmrc"),
    npm_config_store_dir: path.join(home, "store"),
    npm_config_cache: path.join(home, "npm-cache"),
    npm_config_manage_package_manager_versions: "false",
    npm_config_verify_store_integrity: "true",
    npm_config_registry: "https://registry.npmjs.org",
  };
  fs.writeFileSync(env.npm_config_userconfig, "");
  fs.writeFileSync(env.npm_config_globalconfig, "");
  const execute = (args, cwd, overrides = {}) => run(vp, args, cwd, { ...env, ...overrides });
  return { home, env, vp, execute };
}

export async function activateBootstrap(bootstrap, cwd) {
  assert.equal(fs.existsSync(path.join(cwd, ".npmrc")), false, "project .npmrc is not allowed in the isolated bootstrap");
  assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")).packageManager, "pnpm@10.30.3", "project packageManager pin rejected");
  assert.equal(fs.readFileSync(path.join(cwd, ".node-version"), "utf8").trim(), NODE_VERSION, "project Node pin rejected");
  assert.match(await bootstrap.execute(["--version"], bootstrap.home), /^vp v1\.0\.0\s*$/m, "standalone Vite+ pin rejected");
  await bootstrap.execute(["env", "on"], cwd);
  await bootstrap.execute(["env", "setup"], cwd);
  assert.equal((await bootstrap.execute(["node", "--version"], cwd)).trim(), `v${NODE_VERSION}`, "managed Node pin rejected");
  assert.equal((await bootstrap.execute(["env", "exec", "pnpm", "--version"], cwd)).trim(), "10.30.3", "managed pnpm pin rejected");
  const node = (await bootstrap.execute(["env", "which", "node"], cwd)).trim();
  assert.ok(node.startsWith(`${bootstrap.env.VP_HOME}/`), "managed Node escaped private VP_HOME");
  // Direct Node/npm/npx are from the same managed distribution. pnpm uses the
  // native shim with the explicit digest pin, not a host/global package manager.
  const nodeBin = path.dirname(node);
  for (const command of ["node", "npm", "npx"]) fs.symlinkSync(path.join(nodeBin, command), path.join(bootstrap.home, "bin", command));
  fs.symlinkSync(path.join(bootstrap.env.VP_HOME, "bin", "pnpm"), path.join(bootstrap.home, "bin", "pnpm"));
  const npmVersion = JSON.parse(fs.readFileSync(path.resolve(nodeBin, "../lib/node_modules/npm/package.json"), "utf8")).version;
  for (const command of ["npm", "npx"]) assert.equal((await run(path.join(bootstrap.home, "bin", command), ["--version"], cwd, bootstrap.env)).trim(), npmVersion, `managed ${command} entrypoint rejected`);
}

export async function setupWorkflow(parent, ignoreScripts = false, cwd = ROOT) {
  const bootstrap = prepareBootstrap(parent, await provisionVpArchive(parent));
  await activateBootstrap(bootstrap, cwd);
  const output = await bootstrap.execute(["install", "--", "--frozen-lockfile", "--verify-store-integrity", ...(ignoreScripts ? ["--ignore-scripts"] : [])], cwd);
  fs.writeFileSync(path.join(bootstrap.home, "install.log"), output);
  console.log(output.trim());
  assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, "node_modules/vite-plus/package.json"), "utf8")).version, VP_VERSION, "root-local Vite+ pin rejected");
  const version = await bootstrap.execute(["--version"], cwd);
  assert.match(version, /vite-plus\s+v?1\.0\.0/, "root-local Vite+ entrypoint rejected");
  return bootstrap;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 1 && args[0] === "--ignore-scripts"), "usage: bootstrap-integrity.mjs [--ignore-scripts]");
  assert.ok(process.env.RUNNER_TEMP && process.env.GITHUB_ENV && process.env.GITHUB_PATH, "workflow environment files and RUNNER_TEMP required");
  const bootstrap = await setupWorkflow(process.env.RUNNER_TEMP, args.includes("--ignore-scripts"));
  // Export only after successful activation and installation. Later trusted job
  // code is not sandboxed; runner OS tools remain behind these private tools.
  for (const [key, value] of Object.entries(bootstrap.env)) {
    if (key !== "PATH") fs.appendFileSync(process.env.GITHUB_ENV, `${key}=${value}\n`);
  }
  fs.appendFileSync(process.env.GITHUB_PATH, `${bootstrap.env.PATH}\n`);
  console.log(`Verified managed bootstrap: ${bootstrap.home}`);
}
