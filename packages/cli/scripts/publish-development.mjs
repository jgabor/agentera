#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { npmChildEnvironment } from "./package-construction.mjs";
import { parseReleaseFlags } from "./release-arguments.mjs";
import { classifyDevelopmentPublication } from "./development-publication-state.mjs";

const CLASSIFICATION_SCHEMA = "agentera.developmentPublicationClassification.v1";
const PUBLICATION_OUTCOMES = new Set([
  "exact-replay",
  "superseded-replay",
  "forward-publish",
  "forward-retag",
]);

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

function requireCredentialFreeCoordinatorEnvironment(environment) {
  const hasCredentials = Object.keys(environment).some((key) => {
    const normalized = key.toUpperCase();
    return normalized === "NPM_TOKEN"
      || normalized === "NODE_AUTH_TOKEN"
      || (normalized.startsWith("NPM_CONFIG_") && /(?:AUTH|USERCONFIG|GLOBALCONFIG)/.test(normalized));
  });
  if (hasCredentials) throw new Error("development publication coordinator environment contains npm credentials or auth configuration");
}

function isolatedNpmEnvironment(root, environment = process.env, userConfig) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const home = path.join(root, "home");
  const cache = path.join(root, "cache");
  const npmrc = userConfig ?? path.join(root, "npmrc");
  const globalNpmrc = path.join(root, "global-npmrc");
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(cache, { mode: 0o700 });
  fs.writeFileSync(globalNpmrc, "", { mode: 0o600 });
  if (!userConfig) fs.writeFileSync(npmrc, "registry=https://registry.npmjs.org/\n", { mode: 0o600 });
  return {
    ...npmChildEnvironment(environment, npmrc, globalNpmrc),
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

function tarballIntegrity(tarball) {
  return `sha512-${crypto.createHash("sha512").update(fs.readFileSync(tarball)).digest("base64")}`;
}

function inspectDevelopmentRegistry(candidate, view, root, environment) {
  const inspectEnv = isolatedNpmEnvironment(root, environment);
  const tags = view([candidate.package, "dist-tags"], inspectEnv) ?? {};
  const publishedIntegrity = view([`${candidate.package}@${candidate.version}`, "dist.integrity"], inspectEnv);
  const publishedSource = view([`${candidate.package}@${candidate.version}`, "agentera.gitRef"], inspectEnv);
  return classifyDevelopmentPublication({
    version: candidate.version,
    integrity: candidate.integrity,
    source: candidate.gitRef,
    currentNext: tags.next,
    published: { integrity: publishedIntegrity, source: publishedSource },
  });
}

function requireDevelopmentClassification(value) {
  const expectedKeys = ["gitRef", "integrity", "outcome", "package", "schemaVersion", "version"];
  if (!value || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error("invalid development publication classification");
  }
  if (value.schemaVersion !== CLASSIFICATION_SCHEMA || value.package !== "agentera"
    || !PUBLICATION_OUTCOMES.has(value.outcome)
    || !/^3\.0\.0-dev\.(?:0|[1-9]\d*)$/.test(value.version)
    || !/^[0-9a-f]{40}$/.test(value.gitRef)
    || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value.integrity)) {
    throw new Error("invalid development publication classification");
  }
  return value;
}

export function writeDevelopmentClassification(file, classification) {
  const value = requireDevelopmentClassification(classification);
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

export function readDevelopmentClassification(file) {
  const content = fs.readFileSync(file, "utf8");
  if (Buffer.byteLength(content) > 1024) throw new Error("development publication classification is too large");
  return requireDevelopmentClassification(JSON.parse(content));
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
    return { manifest, integrity: tarballIntegrity(tarball) };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export function classifyDevelopmentTarball(options, dependencies = {}) {
  const validate = dependencies.validate ?? validateDevelopmentTarball;
  const view = dependencies.view ?? npmView;
  const environment = dependencies.environment ?? process.env;
  requireCredentialFreeCoordinatorEnvironment(environment);
  const { manifest, integrity } = validate(options);
  const classification = {
    schemaVersion: CLASSIFICATION_SCHEMA,
    outcome: null,
    package: manifest.name,
    version: manifest.version,
    gitRef: manifest.agentera.gitRef,
    integrity,
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-development-classify-"));
  try {
    classification.outcome = inspectDevelopmentRegistry(classification, view, root, environment);
    return requireDevelopmentClassification(classification);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export function mutateDevelopmentTarball(options, classification, dependencies = {}) {
  const authConfig = dependencies.authConfig ?? options.authConfig;
  let root;
  try {
    const environment = dependencies.environment ?? process.env;
    requireCredentialFreeCoordinatorEnvironment(environment);
    const value = requireDevelopmentClassification(classification);
    if (!value.outcome.startsWith("forward-")) throw new Error("classification does not authorize npm mutation");
    if (value.version !== options.packageVersion || value.gitRef !== options.gitRef
      || value.integrity !== tarballIntegrity(options.tarball)) {
      throw new Error("classification does not match the exact tarball, version, and git ref");
    }
    const view = dependencies.view ?? npmView;
    const execute = dependencies.run ?? run;
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-development-mutate-"));
    const state = inspectDevelopmentRegistry(value, view, root, environment);
    if (state === "exact-replay" || state === "superseded-replay") {
      console.log(`${value.package}@${value.version} became an ${state}; no mutation is needed`);
      return state;
    }
    if (!authConfig) throw new Error("temporary npm auth config is required for npm mutation");
    const authStat = fs.statSync(authConfig);
    if (!authStat.isFile() || (authStat.mode & 0o777) !== 0o600) {
      throw new Error("temporary npm auth config must be a mode-0600 regular file");
    }
    const mutationEnv = isolatedNpmEnvironment(
      fs.mkdtempSync(path.join(root, "mutation-")),
      environment,
      authConfig,
    );
    if (state === "forward-publish") {
      execute("npm", ["publish", options.tarball, "--access", "public", "--tag", "next", "--ignore-scripts"], { env: mutationEnv });
    } else {
      execute("npm", ["dist-tag", "add", `${value.package}@${value.version}`, "next"], { env: mutationEnv });
    }
    return state;
  } finally {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    if (authConfig) fs.rmSync(authConfig, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command] = process.argv.slice(2);
  if (!["validate", "classify", "mutate"].includes(command)) throw new Error("usage: publish-development.mjs <validate|classify|mutate> --tarball FILE --package-version VERSION --git-ref SHA [--classification FILE] [--auth-config FILE]");
  const flags = parseReleaseFlags(process.argv.slice(3), { value: ["--tarball", "--package-version", "--git-ref", "--classification", "--auth-config"] });
  const options = {
    tarball: path.resolve(flags.get("--tarball") ?? ""),
    packageVersion: flags.get("--package-version"),
    gitRef: flags.get("--git-ref"),
  };
  if (!options.tarball || !options.packageVersion || !options.gitRef) throw new Error("--tarball, --package-version, and --git-ref are required");
  const classificationFile = flags.get("--classification");
  if (command === "validate") {
    validateDevelopmentTarball(options);
    console.log(`validated ${options.packageVersion} from ${options.gitRef}`);
  } else if (!classificationFile) {
    throw new Error("--classification is required for classify and mutate");
  } else if (command === "classify") {
    const classification = classifyDevelopmentTarball(options);
    writeDevelopmentClassification(path.resolve(classificationFile), classification);
    console.log(classification.outcome);
  } else {
    const authConfig = flags.get("--auth-config");
    mutateDevelopmentTarball(
      { ...options, ...(authConfig ? { authConfig: path.resolve(authConfig) } : {}) },
      readDevelopmentClassification(path.resolve(classificationFile)),
    );
  }
}
