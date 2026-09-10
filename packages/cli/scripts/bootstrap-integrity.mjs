import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Reviewed npm artifact provenance and the host prerequisite are documented in
// references/analysis/bootstrap-integrity.md. Never learn these hashes at runtime.
export const COREPACK_SHA512 = "a585c47dc0fa929dee1e92686ffd14b438ed591ef1a6d933b5bfb616adca3d58b9d872ec83bb5ecd72a30bdabecac896756150c4f363732d17c2f010225ec631";
export const COREPACK_ARCHIVE_INTEGRITY = "sha512-9BuIGHDFE7Zieor1CeRsvt7X7AJFEuJ6OnbSbsVprq83ChDFoBh1wP98NeUS9FT3ZwlzFllPElXcz/OiDf0YGw==";
export const PNPM_REFERENCE = "pnpm@10.30.3+sha512.c961d1e0a2d8e354ecaa5166b822516668b7f44cb5bd95122d590dd81922f606f5473b6d23ec4a5be05e7fcd18e8488d47d978bbe981872f1145d06e9a740017";
const ROOT = path.resolve(import.meta.dirname, "../../..");

export function verifiedCorepackBytes(file) {
  const bytes = fs.readFileSync(file);
  assert.equal(createHash("sha512").update(bytes).digest("hex"), COREPACK_SHA512, "host Corepack integrity mismatch");
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
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${command} ${args.join(" ")} exited ${code}\n${output}`));
      else resolve(output);
    });
  });
}

// registry is a transport seam for deterministic failure proofs, not a digest
// override. A mirror must still supply the exact pinned pnpm archive.
export function prepareBootstrap(parent, hostCorepack, registry = "https://registry.npmjs.org") {
  assert.equal(process.versions.node, fs.readFileSync(path.join(ROOT, ".node-version"), "utf8").trim(), "pinned host Node required");
  const bytes = verifiedCorepackBytes(hostCorepack);
  const home = fs.mkdtempSync(path.join(parent, "bootstrap-"));
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  const corepack = path.join(home, "corepack.cjs");
  fs.writeFileSync(corepack, bytes, { flag: "wx" });
  // Corepack resolves its own package location when it launches pnpm. This
  // static data enables self-resolution without loading another host file.
  fs.writeFileSync(
    path.join(home, "package.json"),
    JSON.stringify({
      name: "corepack",
      version: "0.35.0",
      exports: { "./package.json": "./package.json" },
    }),
  );
  // Execute the checked copy directly, not an unchecked host shim or package.
  const launcher = `require(${JSON.stringify(corepack)}).runMain(process.argv.slice(1))`;
  const env = {
    HOME: home,
    PATH: bin,
    CI: "true",
    COREPACK_HOME: path.join(home, "corepack-home"),
    COREPACK_DEFAULT_TO_LATEST: "0",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    COREPACK_NPM_REGISTRY: registry,
    COREPACK_ENABLE_NETWORK: "1",
    XDG_CACHE_HOME: path.join(home, "cache"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    npm_config_userconfig: path.join(home, "npmrc"),
    npm_config_globalconfig: path.join(home, "global-npmrc"),
    npm_config_store_dir: path.join(home, "store"),
    npm_config_cache: path.join(home, "npm-cache"),
    npm_config_manage_package_manager_versions: "false",
  };
  fs.writeFileSync(env.npm_config_userconfig, "");
  fs.writeFileSync(env.npm_config_globalconfig, "");
  // Scripts may use sh, but no inherited Node, pnpm, vp, credential, config,
  // NODE_OPTIONS, NODE_PATH, compile cache, or previous installation is inherited.
  fs.symlinkSync("/bin/sh", path.join(bin, "sh"));
  const pnpm = (args, cwd) => run(process.execPath, ["-e", launcher, "--", PNPM_REFERENCE, ...args], cwd, env);
  return {
    home,
    env,
    pnpm,
    install: (cwd) => run(process.execPath, ["-e", launcher, "--", "install", "--global", PNPM_REFERENCE], cwd, env),
  };
}

export function verifiedCorepackArchive(bytes) {
  assert.equal(`sha512-${createHash("sha512").update(bytes).digest("base64")}`, COREPACK_ARCHIVE_INTEGRITY, "Corepack archive integrity mismatch");
  return bytes;
}

// No downloaded package or installer is loaded to provision Corepack. The
// trusted host tar/gzip only reads one member after the whole archive is checked.
export async function provisionCorepack(parent) {
  const response = await fetch("https://registry.npmjs.org/corepack/-/corepack-0.35.0.tgz", {
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.ok, true, `Corepack download failed: ${response.status}`);
  const bytes = verifiedCorepackArchive(Buffer.from(await response.arrayBuffer()));
  const home = fs.mkdtempSync(path.join(parent, "corepack-provision-"));
  const archive = path.join(home, "corepack.tgz");
  fs.writeFileSync(archive, bytes, { flag: "wx" });
  const bundle = execFileSync("/bin/tar", ["--use-compress-program=/bin/gzip", "-xOf", archive, "package/dist/lib/corepack.cjs"], {
    env: {},
    maxBuffer: 8 * 1024 * 1024,
  });
  const file = path.join(home, "corepack.cjs");
  fs.writeFileSync(file, bundle, { flag: "wx" });
  verifiedCorepackBytes(file);
  return file;
}

export async function setupWorkflow(parent, ignoreScripts = false) {
  assert.equal(process.versions.node, fs.readFileSync(path.join(ROOT, ".node-version"), "utf8").trim(), "pinned host Node required");
  const bootstrap = prepareBootstrap(parent, await provisionCorepack(parent));
  const log = async (name, result) => {
    const output = await result;
    fs.writeFileSync(path.join(bootstrap.home, `${name}.log`), output);
    console.log(output.trim());
  };
  await log("corepack-install", bootstrap.install(ROOT));
  await log("install", bootstrap.pnpm(["install", "--frozen-lockfile", "--verify-store-integrity", ...(ignoreScripts ? ["--ignore-scripts"] : [])], ROOT));
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules/vite-plus/package.json"), "utf8")).version, "0.3.0");

  const bin = bootstrap.env.PATH;
  const node = fs.realpathSync(process.execPath);
  // npm is part of the same trusted Node distribution, not the runner's global
  // npm. Refuse a host layout that cannot provide that prerequisite.
  const npmRoot = path.resolve(path.dirname(node), "../lib/node_modules/npm");
  const npmVersion = JSON.parse(fs.readFileSync(path.join(npmRoot, "package.json"), "utf8")).version;
  fs.symlinkSync(path.join(npmRoot, "bin/npm-cli.js"), path.join(bin, "npm"));
  fs.symlinkSync(path.join(npmRoot, "bin/npx-cli.js"), path.join(bin, "npx"));
  fs.symlinkSync(path.join(ROOT, "node_modules/vite-plus/bin/vp"), path.join(bin, "vp"));
  fs.writeFileSync(path.join(bin, "pnpm"), `#!${node}\nrequire(${JSON.stringify(path.join(bootstrap.home, "corepack.cjs"))}).runMain([${JSON.stringify(PNPM_REFERENCE)}, ...process.argv.slice(2)]);\n`, { flag: "wx", mode: 0o755 });
  for (const [command, expected] of [
    ["node", `v${process.versions.node}`],
    ["npm", npmVersion],
    ["npx", npmVersion],
    ["pnpm", "10.30.3"],
  ]) {
    assert.equal((await run(path.join(bin, command), ["--version"], ROOT, bootstrap.env)).trim(), expected);
  }
  await log("vp-version", run(path.join(bin, "vp"), ["--version"], ROOT, bootstrap.env));
  return bootstrap;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 1 && args[0] === "--ignore-scripts"), "usage: bootstrap-integrity.mjs [--ignore-scripts]");
  assert.ok(process.env.RUNNER_TEMP && process.env.GITHUB_ENV && process.env.GITHUB_PATH, "workflow environment files and RUNNER_TEMP required");
  const bootstrap = await setupWorkflow(process.env.RUNNER_TEMP, args.includes("--ignore-scripts"));
  // Publish only after install and all entrypoint checks pass. Keep ordinary
  // runner tools available to later jobs; our Node/npm/pnpm/vp take precedence.
  for (const [key, value] of Object.entries(bootstrap.env)) {
    if (key !== "PATH") fs.appendFileSync(process.env.GITHUB_ENV, `${key}=${value}\n`);
  }
  fs.appendFileSync(process.env.GITHUB_PATH, `${bootstrap.env.PATH}\n`);
  console.log(`Verified bootstrap: ${bootstrap.home}`);
}
