import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import YAML from "yaml";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const REQUIRED_PNPM = "10.30.3";
const REQUIRED_PACKAGE_MANAGER = `pnpm@${REQUIRED_PNPM}`;
const REQUIRED_VP = "0.3.0";
const REQUIRED_SETUP_VP = "1.18.0";
const REQUIRED_SETUP_VP_COMMIT = "1b32467adbe183473499fd9d5d372c3ed9641754";
const REQUIRED_NODE = fs.readFileSync(path.join(REPO_ROOT, ".node-version"), "utf8").trim();
const SCRIPT_PACKAGE_VERSION = `1.0.0-${Date.now()}`;
const COREPACK = process.platform === "win32" ? "corepack.cmd" : "corepack";

export function loadToolchainBaseline() {
  return YAML.parse(
    fs.readFileSync(path.join(REPO_ROOT, "references/analysis/toolchain-baseline.yaml"), "utf8"),
  );
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function run(command, args, options = {}) {
  const started = performance.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    maxBuffer: 20 * 1024 * 1024,
  });
  return { ...result, elapsedSeconds: (performance.now() - started) / 1000 };
}

function commandFailure(label, result) {
  return `${label} failed (${result.status ?? result.error?.message ?? "no status"})\n${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function requireSuccess(label, result) {
  assert.equal(result.status, 0, commandFailure(label, result));
  return result;
}

function requireFailure(label, result) {
  assert.notEqual(result.status, 0, `${label} unexpectedly passed`);
  return result;
}

function runPnpm(cwd, args, env) {
  return run(COREPACK, ["pnpm", ...args], { cwd, env });
}

function requirePinnedPnpm(cwd, env) {
  const manifest = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
  assert.equal(manifest.packageManager, REQUIRED_PACKAGE_MANAGER, "packageManager pin rejected");
  const result = requireSuccess("pinned pnpm probe", runPnpm(cwd, ["--version"], env));
  assert.equal(result.stdout.trim(), REQUIRED_PNPM, "Corepack did not activate the pinned pnpm");
  return result.stdout.trim();
}

function makeScriptPackage(root, name) {
  fs.mkdirSync(root, { recursive: true });
  writeJson(path.join(root, "package.json"), {
    name,
    version: SCRIPT_PACKAGE_VERSION,
    scripts: { install: "node install.cjs" },
  });
  fs.writeFileSync(
    path.join(root, "install.cjs"),
    [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const name = require("./package.json").name;',
      "const root = process.env.AGENTERA_TOOLCHAIN_MARKERS;",
      'if (!root) throw new Error("missing marker directory");',
      "fs.mkdirSync(root, { recursive: true });",
      'fs.writeFileSync(path.join(root, `${name}.marker`), "executed\\n");',
      "",
    ].join("\n"),
  );
}

function packScriptPackage(fixture, source, artifacts, name, env) {
  makeScriptPackage(source, name);
  requireSuccess(`pack ${name}`, runPnpm(source, ["pack", "--pack-destination", artifacts], env));
  const tarball = path.join(artifacts, `${name}-${SCRIPT_PACKAGE_VERSION}.tgz`);
  assert.ok(fs.existsSync(tarball), `${name} tarball was not created`);
  return `file:${path.relative(fixture, tarball)}`;
}

function parseJsonOutput(label, result) {
  requireSuccess(label, result);
  try {
    return JSON.parse(result.stdout);
  } catch {
    assert.fail(`${label} did not return JSON: ${result.stdout}${result.stderr}`);
  }
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-toolchain-baseline-"));
try {
  assert.equal(process.version, `v${REQUIRED_NODE}`, "integration must use the pinned Node.js");
  const retainedBaseline = loadToolchainBaseline();
  assert.equal(retainedBaseline.selection.vite_plus.version, REQUIRED_VP);
  assert.equal(retainedBaseline.selection.setup_vp.selected.version, REQUIRED_SETUP_VP);
  assert.equal(
    retainedBaseline.selection.setup_vp.selected.action_commit,
    REQUIRED_SETUP_VP_COMMIT,
  );
  assert.equal(retainedBaseline.selection.setup_vp.selected.classification, "accepted_risk");
  assert.equal(
    retainedBaseline.selection.setup_vp.selected.boundary,
    "non_oidc_install_or_build_jobs_only",
  );

  const fixture = path.join(sandbox, "project");
  const sources = path.join(sandbox, "package-sources");
  const artifacts = path.join(fixture, "artifacts");
  const markers = path.join(sandbox, "markers");
  const npmrc = path.join(sandbox, "empty.npmrc");
  fs.mkdirSync(fixture, { recursive: true });
  fs.mkdirSync(artifacts, { recursive: true });
  fs.mkdirSync(markers, { recursive: true });
  fs.writeFileSync(npmrc, "");

  const env = { ...process.env };
  for (const key of [
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "NODE_AUTH_TOKEN",
    "NPM_TOKEN",
  ]) {
    delete env[key];
  }
  env.NPM_CONFIG_USERCONFIG = npmrc;
  env.PNPM_CONFIG_USERCONFIG = npmrc;
  env.AGENTERA_TOOLCHAIN_MARKERS = markers;

  const livePnpm = requirePinnedPnpm(REPO_ROOT, env);
  const livePolicy = parseJsonOutput(
    "live onlyBuiltDependencies probe",
    runPnpm(REPO_ROOT, ["config", "get", "onlyBuiltDependencies", "--json"], env),
  );
  assert.deepEqual(livePolicy, ["esbuild"], "live dependency-script policy drifted");

  const rejectedPinRoot = path.join(sandbox, "rejected-pin");
  fs.mkdirSync(rejectedPinRoot);
  writeJson(path.join(rejectedPinRoot, "package.json"), {
    name: "rejected-pnpm-pin",
    private: true,
    packageManager: "pnpm@latest",
  });
  assert.throws(() => requirePinnedPnpm(rejectedPinRoot, env), /packageManager pin rejected/);

  const allowedTarball = packScriptPackage(
    fixture,
    path.join(sources, "esbuild"),
    artifacts,
    "esbuild",
    env,
  );
  const blockedTarball = packScriptPackage(
    fixture,
    path.join(sources, "blocked-build"),
    artifacts,
    "blocked-build",
    env,
  );
  writeJson(path.join(fixture, "package.json"), {
    name: "agentera-toolchain-baseline-fixture",
    private: true,
    packageManager: REQUIRED_PACKAGE_MANAGER,
    devDependencies: {
      "blocked-build": blockedTarball,
      esbuild: allowedTarball,
      "vite-plus": REQUIRED_VP,
    },
  });
  fs.copyFileSync(
    path.join(REPO_ROOT, "pnpm-workspace.yaml"),
    path.join(fixture, "pnpm-workspace.yaml"),
  );

  const staleBin = path.join(sandbox, "stale-bin");
  const staleMarker = path.join(markers, "stale-vp.marker");
  fs.mkdirSync(staleBin);
  fs.writeFileSync(
    path.join(staleBin, "vp"),
    `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(staleMarker)}, "executed\\n");\nconsole.log("vp 0.1.19");\n`,
    { mode: 0o755 },
  );
  const staleEnv = { ...env, PATH: `${staleBin}${path.delimiter}${env.PATH}` };
  const staleProbe = requireSuccess(
    "stale global vp probe",
    run("vp", ["--version"], {
      cwd: fixture,
      env: staleEnv,
    }),
  );
  assert.match(staleProbe.stdout, /0\.1\.19/);
  assert.ok(fs.existsSync(staleMarker), "stale vp probe did not execute the stale binary");

  requireSuccess(
    "fixture lockfile generation",
    runPnpm(fixture, ["install", "--lockfile-only", "--prefer-offline"], staleEnv),
  );
  fs.rmSync(path.join(fixture, "node_modules"), { recursive: true, force: true });
  fs.rmSync(markers, { recursive: true, force: true });

  const freshInstall = requireSuccess(
    "fresh frozen install",
    runPnpm(fixture, ["install", "--frozen-lockfile", "--prefer-offline"], staleEnv),
  );
  assert.ok(
    fs.existsSync(path.join(markers, "esbuild.marker")),
    "allowed esbuild script did not run",
  );
  assert.ok(
    !fs.existsSync(path.join(markers, "blocked-build.marker")),
    "unlisted dependency script was not suppressed",
  );

  const rootVp = requireSuccess(
    "root-local Vite+ probe",
    runPnpm(fixture, ["exec", "vp", "--version"], staleEnv),
  );
  assert.match(`${rootVp.stdout}${rootVp.stderr}`, /(?:vp\s+)?0\.3\.0/);
  assert.ok(!fs.existsSync(staleMarker), "stale global vp owned the root-local probe");

  const delegatedInstall = requireSuccess(
    "root-local Vite+ frozen install",
    runPnpm(fixture, ["exec", "vp", "install", "--frozen-lockfile"], staleEnv),
  );
  assert.ok(!fs.existsSync(staleMarker), "stale global vp owned the project install");
  assert.ok(
    !fs.existsSync(path.join(markers, "blocked-build.marker")),
    "unlisted dependency script ran during the delegated install",
  );

  const manifest = JSON.parse(fs.readFileSync(path.join(fixture, "package.json"), "utf8"));
  manifest.devDependencies["vite-plus"] = "0.2.9";
  writeJson(path.join(fixture, "package.json"), manifest);
  const rejectedFrozen = requireFailure(
    "outdated frozen lockfile",
    runPnpm(fixture, ["install", "--frozen-lockfile"], staleEnv),
  );
  assert.match(`${rejectedFrozen.stdout}${rejectedFrozen.stderr}`, /ERR_PNPM_OUTDATED_LOCKFILE/);

  console.log(
    JSON.stringify(
      {
        schemaVersion: "agentera.toolchainBaselineIntegration.v1",
        status: "pass",
        node: REQUIRED_NODE,
        pnpm: {
          accepted: livePnpm,
          rejected: "pnpm@latest",
        },
        dependencyScriptPolicy: {
          liveOnlyBuiltDependencies: livePolicy,
          allowedExecuted: "esbuild",
          rejectedSuppressed: "blocked-build",
        },
        ownership: {
          freshBareVp: staleProbe.stdout.trim(),
          installedRootVp: `${rootVp.stdout}${rootVp.stderr}`.trim(),
          staleOwnedProjectCommands: false,
        },
        frozenLockfile: {
          accepted: true,
          rejectedError: "ERR_PNPM_OUTDATED_LOCKFILE",
        },
        timingsSeconds: {
          freshFrozenInstall: Number(freshInstall.elapsedSeconds.toFixed(3)),
          installedVpFrozenInstall: Number(delegatedInstall.elapsedSeconds.toFixed(3)),
        },
        timingInterpretation: "observational only; not a budget",
      },
      null,
      2,
    ),
  );
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
