import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Reviewed npm artifact provenance and the host prerequisite are documented in
// references/analysis/bootstrap-integrity.md. Never learn these hashes at runtime.
export const COREPACK_SHA512 = "a585c47dc0fa929dee1e92686ffd14b438ed591ef1a6d933b5bfb616adca3d58b9d872ec83bb5ecd72a30bdabecac896756150c4f363732d17c2f010225ec631";
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
