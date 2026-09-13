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
const REQUIRED_TOOLS = {
  vite: "8.2.2",
  vitest: "4.1.11",
  oxlint: "1.79.0",
  oxfmt: "0.64.0",
};
const REQUIRED_SETUP_VP = "1.18.0";
const REQUIRED_SETUP_VP_COMMIT = "1b32467adbe183473499fd9d5d372c3ed9641754";
const REQUIRED_NODE = fs.readFileSync(path.join(REPO_ROOT, ".node-version"), "utf8").trim();
const SCRIPT_PACKAGE_VERSION = `1.0.0-${Date.now()}`;
// Use the standalone launcher, not the node_modules shim (which needs host Node).
const VP =
  process.env.AGENTERA_TOOLCHAIN_VP ??
  process.env.PATH.split(path.delimiter)
    .filter((entry) => !entry.includes("node_modules"))
    .map((entry) => path.resolve(entry, "vp"))
    .find((file) => fs.existsSync(file));
const RECOVERY = "Use the standalone Vite+ 0.3.0 launcher; run vp env on, then vp install --frozen-lockfile from the repository root. Do not install Node, pnpm or Corepack separately.";

export function loadToolchainBaseline() {
  return YAML.parse(fs.readFileSync(path.join(REPO_ROOT, "references/analysis/toolchain-baseline.yaml"), "utf8"));
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

function runVp(cwd, args, env) {
  return run(VP, args, { cwd, env });
}

function requirePinnedPnpm(cwd, env) {
  const manifest = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
  assert.equal(manifest.packageManager, REQUIRED_PACKAGE_MANAGER, `packageManager pin rejected; restore ${REQUIRED_PACKAGE_MANAGER}. ${RECOVERY}`);
  const result = requireSuccess("pinned pnpm probe", runVp(cwd, ["exec", "pnpm", "--version"], env));
  assert.equal(result.stdout.trim(), REQUIRED_PNPM, `Vite+ did not activate the pinned pnpm. ${RECOVERY}`);
  return result.stdout.trim();
}

function makeScriptPackage(root, name) {
  fs.mkdirSync(root, { recursive: true });
  writeJson(path.join(root, "package.json"), {
    name,
    version: SCRIPT_PACKAGE_VERSION,
    packageManager: REQUIRED_PACKAGE_MANAGER,
    scripts: { install: "node install.cjs" },
  });
  fs.writeFileSync(path.join(root, ".node-version"), `${REQUIRED_NODE}\n`);
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
  requireSuccess(`pack ${name}`, runVp(source, ["pm", "pack", "--pack-destination", artifacts], env));
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
  assert.equal(process.version, `v${REQUIRED_NODE}`, `integration must use the pinned Node.js. ${RECOVERY}`);
  assert.ok(VP && path.isAbsolute(VP), `Standalone launcher not found. ${RECOVERY} For this proof, AGENTERA_TOOLCHAIN_VP may name its absolute path.`);
  const retainedBaseline = loadToolchainBaseline();
  assert.equal(retainedBaseline.selection.vite_plus.version, REQUIRED_VP);
  assert.equal(retainedBaseline.selection.setup_vp.selected.version, REQUIRED_SETUP_VP);
  assert.equal(retainedBaseline.selection.setup_vp.selected.action_commit, REQUIRED_SETUP_VP_COMMIT);
  assert.equal(retainedBaseline.selection.setup_vp.selected.classification, "replaced_pending_hosted_acceptance");
  assert.equal(retainedBaseline.selection.setup_vp.selected.boundary, "non_oidc_install_or_build_jobs_only");

  const fixture = path.join(sandbox, "project");
  const sources = path.join(sandbox, "package-sources");
  const artifacts = path.join(fixture, "artifacts");
  const markers = path.join(sandbox, "markers");
  const npmrc = path.join(sandbox, "empty.npmrc");
  fs.mkdirSync(fixture, { recursive: true });
  fs.mkdirSync(artifacts, { recursive: true });
  fs.mkdirSync(markers, { recursive: true });
  fs.writeFileSync(npmrc, "");

  const env = {
    PATH: process.env.PATH,
    HOME: path.join(sandbox, "home"),
    XDG_CONFIG_HOME: path.join(sandbox, "config"),
    XDG_CACHE_HOME: path.join(sandbox, "cache"),
    VP_HOME: path.join(sandbox, "vp"),
    TMPDIR: sandbox,
    CI: "true",
  };
  for (const dir of [env.HOME, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.VP_HOME]) fs.mkdirSync(dir);
  env.NPM_CONFIG_USERCONFIG = npmrc;
  env.NPM_CONFIG_GLOBALCONFIG = npmrc;
  env.PNPM_CONFIG_USERCONFIG = npmrc;
  env.AGENTERA_TOOLCHAIN_MARKERS = markers;

  const launcher = requireSuccess(RECOVERY, run(VP, ["--version"], { cwd: sandbox, env }));
  assert.match(launcher.stdout, /^vp v0\.3\.0\s*$/m, RECOVERY);
  if (process.env.AGENTERA_PROJECT_COMMAND_MARKER) fs.writeFileSync(process.env.AGENTERA_PROJECT_COMMAND_MARKER, "started\n");
  requireSuccess("enable Vite-managed runtime", run(VP, ["env", "on"], { cwd: sandbox, env }));

  const livePnpm = requirePinnedPnpm(REPO_ROOT, env);
  const rootManifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const workspaceConfig = YAML.parse(fs.readFileSync(path.join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8"));
  assert.equal(rootManifest.scripts.bootstrap, "vp install --frozen-lockfile");
  assert.equal(rootManifest.devDependencies["vite-plus"], "catalog:");
  assert.equal(workspaceConfig.catalog["vite-plus"], REQUIRED_VP);
  for (const [name, version] of Object.entries(REQUIRED_TOOLS)) assert.equal(workspaceConfig.catalog[name], version);
  const liveVp = requireSuccess("workspace Vite+ probe", runVp(REPO_ROOT, ["exec", "vp", "--version"], env));
  for (const [name, version] of Object.entries({ "vite-plus": REQUIRED_VP, ...REQUIRED_TOOLS })) {
    assert.match(`${liveVp.stdout}${liveVp.stderr}`, new RegExp(`${name}\\s+v?${version.replaceAll(".", "\\.")}`));
  }
  const livePolicy = parseJsonOutput("live onlyBuiltDependencies probe", runVp(REPO_ROOT, ["pm", "config", "get", "onlyBuiltDependencies", "--json"], env));
  assert.deepEqual(livePolicy, ["esbuild"], "live dependency-script policy drifted");

  const rejectedPinRoot = path.join(sandbox, "rejected-pin");
  fs.mkdirSync(rejectedPinRoot);
  writeJson(path.join(rejectedPinRoot, "package.json"), {
    name: "rejected-pnpm-pin",
    private: true,
    packageManager: "pnpm@latest",
  });
  assert.throws(() => requirePinnedPnpm(rejectedPinRoot, env), /packageManager pin rejected/);

  const allowedTarball = packScriptPackage(fixture, path.join(sources, "esbuild"), artifacts, "esbuild", env);
  const blockedTarball = packScriptPackage(fixture, path.join(sources, "blocked-build"), artifacts, "blocked-build", env);
  writeJson(path.join(fixture, "package.json"), {
    name: "agentera-toolchain-baseline-fixture",
    private: true,
    packageManager: REQUIRED_PACKAGE_MANAGER,
    scripts: { bootstrap: rootManifest.scripts.bootstrap, build: rootManifest.scripts.build },
    devDependencies: {
      "blocked-build": blockedTarball,
      esbuild: allowedTarball,
      "vite-plus": REQUIRED_VP,
    },
  });
  fs.writeFileSync(path.join(fixture, ".node-version"), `${REQUIRED_NODE}\n`);
  fs.copyFileSync(path.join(REPO_ROOT, "pnpm-workspace.yaml"), path.join(fixture, "pnpm-workspace.yaml"));

  const staleBin = path.join(sandbox, "stale-bin");
  const staleMarker = path.join(markers, "stale-vp.marker");
  fs.mkdirSync(staleBin);
  fs.writeFileSync(path.join(staleBin, "vp"), `#!/bin/sh\nprintf 'executed\\n' > '${staleMarker}'\nprintf 'vp 0.1.19\\n'\n`, { mode: 0o755 });
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

  // These fail if a contributor command leaks out of Vite's managed PATH.
  const hostMarker = path.join(sandbox, "host-tool.marker");
  for (const tool of ["node", "pnpm", "corepack"]) {
    fs.writeFileSync(path.join(staleBin, tool), `#!/bin/sh\nprintf '%s\\n' '${tool}' >> '${hostMarker}'\nexit 97\n`, { mode: 0o755 });
  }

  requireSuccess("fixture lockfile generation", runVp(fixture, ["install", "--lockfile-only", "--prefer-offline"], staleEnv));
  fs.rmSync(path.join(fixture, "node_modules"), { recursive: true, force: true });
  fs.rmSync(markers, { recursive: true, force: true });

  const freshInstall = requireSuccess("fresh frozen install", runVp(fixture, ["install", "--frozen-lockfile", "--prefer-offline"], staleEnv));
  assert.ok(fs.existsSync(path.join(markers, "esbuild.marker")), "allowed esbuild script did not run");
  assert.ok(!fs.existsSync(path.join(markers, "blocked-build.marker")), "unlisted dependency script was not suppressed");

  const rootVp = requireSuccess("root-local Vite+ probe", runVp(fixture, ["exec", "vp", "--version"], staleEnv));
  assert.match(`${rootVp.stdout}${rootVp.stderr}`, /(?:vp\s+)?0\.3\.0/);
  assert.ok(!fs.existsSync(staleMarker), "stale global vp owned the root-local probe");

  const lockfile = path.join(fixture, "pnpm-lock.yaml");
  const lockfileBeforeInstall = fs.readFileSync(lockfile);
  const delegatedInstall = requireSuccess("root bootstrap frozen install", run(VP, ["run", "bootstrap"], { cwd: fixture, env: staleEnv }));
  assert.deepEqual(fs.readFileSync(lockfile), lockfileBeforeInstall, "vp install changed the authoritative pnpm lockfile");
  assert.ok(!fs.existsSync(staleMarker), "stale global vp owned the project install");
  assert.ok(!fs.existsSync(path.join(markers, "blocked-build.marker")), "unlisted dependency script ran during the delegated install");
  assert.equal(fs.existsSync(hostMarker), false, "ambient JavaScript tools owned a contributor command");

  const child = path.join(fixture, "packages/cli");
  const taskLog = path.join(sandbox, "task-runs.jsonl");
  fs.mkdirSync(child, { recursive: true });
  writeJson(path.join(child, "package.json"), {
    name: "task-target",
    private: true,
    scripts: { build: "node record.cjs" },
  });
  fs.writeFileSync(
    path.join(child, "record.cjs"),
    `
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
fs.appendFileSync(${JSON.stringify(taskLog)}, JSON.stringify({
  cwd: process.cwd(), args: process.argv.slice(2), node: process.version,
  pnpm: spawnSync("pnpm", ["--version"], { encoding: "utf8" }).stdout.trim(),
}) + "\\n");
if (process.argv.includes("--fail")) process.exit(23);
`,
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    requireSuccess("uncached root wrapper", run(VP, ["run", "build", "--", "--flag", "two words"], { cwd: fixture, env: staleEnv }));
  }
  const taskRuns = fs
    .readFileSync(taskLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    taskRuns,
    Array.from({ length: 2 }, () => ({
      cwd: child,
      args: ["--", "--flag", "two words"],
      node: `v${REQUIRED_NODE}`,
      pnpm: REQUIRED_PNPM,
    })),
    "root wrapper changed cwd, args, runtime or uncached execution",
  );
  requireFailure("child task failure propagation", run(VP, ["run", "build", "--", "--fail"], { cwd: fixture, env: staleEnv }));
  assert.equal(fs.existsSync(hostMarker), false, "root wrapper used ambient JavaScript tools");

  const manifest = JSON.parse(fs.readFileSync(path.join(fixture, "package.json"), "utf8"));
  manifest.devDependencies["vite-plus"] = "0.2.9";
  writeJson(path.join(fixture, "package.json"), manifest);
  const rejectedFrozen = requireFailure("outdated frozen lockfile", runVp(fixture, ["install", "--frozen-lockfile"], staleEnv));
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
          ambientJavaScriptToolsExecuted: false,
          launcher: VP,
        },
        frozenLockfile: {
          accepted: true,
          rejectedError: "ERR_PNPM_OUTDATED_LOCKFILE",
        },
        rootWrapper: { runs: taskRuns, childFailurePropagated: true },
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
