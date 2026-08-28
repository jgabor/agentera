#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { npmChildEnvironment } from "./package-construction.mjs";
import { parseReleaseFlags } from "./release-arguments.mjs";
import { classifyDevelopmentPublication } from "./development-publication-state.mjs";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const diagnostic = options.capture ? (result.stderr || result.stdout).trim() : "";
    throw new Error(`${command} ${args.join(" ")} failed${diagnostic ? `: ${diagnostic}` : ""}`);
  }
  return result.stdout?.trim() ?? "";
}

function isolatedNpmEnvironment(root, token) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const home = path.join(root, "home");
  const cache = path.join(root, "cache");
  const npmrc = path.join(root, "npmrc");
  const globalNpmrc = path.join(root, "global-npmrc");
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(cache, { mode: 0o700 });
  fs.writeFileSync(globalNpmrc, "", { mode: 0o600 });
  fs.writeFileSync(
    npmrc,
    token
      ? `registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=${token}\n`
      : "registry=https://registry.npmjs.org/\n",
    { mode: 0o600 },
  );
  return {
    ...npmChildEnvironment(process.env, npmrc, globalNpmrc),
    HOME: home,
    NPM_CONFIG_CACHE: cache,
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
  };
}

function npmView(args, env) {
  const result = spawnSync("npm", ["view", ...args, "--json"], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
  if (result.status !== 0 && /(?:E404|404 Not Found|No match found)/i.test(result.stderr)) return null;
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm view failed: ${(result.stderr || result.stdout).trim()}`);
  return JSON.parse(result.stdout);
}

export function validateDevelopmentTarball({ tarball, packageVersion, gitRef }) {
  if (!/^3\.0\.0-dev\.(?:0|[1-9]\d*)$/.test(packageVersion)) throw new Error("invalid development package version");
  if (!/^[0-9a-f]{40}$/.test(gitRef)) throw new Error("invalid git ref");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-development-smoke-"));
  try {
    run("tar", ["-xzf", tarball, "-C", root]);
    const packageRoot = path.join(root, "package");
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    if (manifest.name !== "agentera" || manifest.version !== packageVersion || manifest.agentera?.gitRef !== gitRef) {
      throw new Error("tarball package name, version, or agentera.gitRef does not match the push");
    }
    const bin = path.join(packageRoot, "dist/bin/agentera.js");
    if ((fs.statSync(bin).mode & 0o777) !== 0o755) throw new Error("tarball CLI is not executable");
    const installRoot = path.join(root, "install");
    fs.mkdirSync(installRoot);
    run("npm", ["install", tarball, "--ignore-scripts", "--no-package-lock"], {
      cwd: installRoot,
      env: isolatedNpmEnvironment(path.join(root, "npm")),
      capture: true,
    });
    const output = run(path.join(installRoot, "node_modules/.bin/agentera"), ["--version"], {
      cwd: installRoot,
      capture: true,
    });
    if (output !== packageVersion) throw new Error(`unexpected CLI version output: ${output}`);
    return { manifest, integrity: `sha512-${crypto.createHash("sha512").update(fs.readFileSync(tarball)).digest("base64")}` };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export function publishDevelopmentTarball(options) {
  const { manifest, integrity } = validateDevelopmentTarball(options);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-development-publish-"));
  try {
    const inspectEnv = isolatedNpmEnvironment(root);
    const tags = npmView([manifest.name, "dist-tags"], inspectEnv) ?? {};
    const publishedIntegrity = npmView([`${manifest.name}@${manifest.version}`, "dist.integrity"], inspectEnv);
    const publishedSource = npmView([`${manifest.name}@${manifest.version}`, "agentera.gitRef"], inspectEnv);
    const state = classifyDevelopmentPublication({
      version: manifest.version,
      integrity,
      source: manifest.agentera.gitRef,
      currentNext: tags.next,
      published: { integrity: publishedIntegrity, source: publishedSource },
    });
    if (state === "exact-replay" || state === "superseded-replay") {
      console.log(`${manifest.name}@${manifest.version} is an ${state} with identical bytes and source`);
      return;
    }
    if (!process.env.NPM_TOKEN) throw new Error("NPM_TOKEN is required for npm mutation");
    const mutationEnv = isolatedNpmEnvironment(fs.mkdtempSync(path.join(root, "mutation-")), process.env.NPM_TOKEN);
    if (state === "forward-publish") {
      run("npm", ["publish", options.tarball, "--access", "public", "--tag", "next", "--ignore-scripts"], { env: mutationEnv });
    } else {
      run("npm", ["dist-tag", "add", `${manifest.name}@${manifest.version}`, "next"], { env: mutationEnv });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const [command] = process.argv.slice(2);
if (!["validate", "publish"].includes(command)) throw new Error("usage: publish-development.mjs <validate|publish> --tarball FILE --package-version VERSION --git-ref SHA");
const flags = parseReleaseFlags(process.argv.slice(3), { value: ["--tarball", "--package-version", "--git-ref"] });
const options = {
  tarball: path.resolve(flags.get("--tarball") ?? ""),
  packageVersion: flags.get("--package-version"),
  gitRef: flags.get("--git-ref"),
};
if (!options.tarball || !options.packageVersion || !options.gitRef) throw new Error("--tarball, --package-version, and --git-ref are required");
if (command === "validate") {
  validateDevelopmentTarball(options);
  console.log(`validated ${options.packageVersion} from ${options.gitRef}`);
} else {
  publishDevelopmentTarball(options);
}
