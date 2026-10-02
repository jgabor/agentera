import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { prepareBootstrap, run, setupWorkflow, verifiedVpArchive } from "./bootstrap-integrity.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const [output] = process.argv.slice(2);
assert.ok(output, "usage: node scripts/prove-bootstrap-integrity.mjs NEW_EVIDENCE_DIRECTORY");
fs.mkdirSync(output);
const report = { status: "failed", checks: [] };
const json = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const check = (name) => report.checks.push(name);
const fixture = path.join(output, "project");
let server;

try {
  const bad = path.join(output, "altered-vp.tgz");
  fs.writeFileSync(bad, "unverified executable");
  assert.throws(() => verifiedVpArchive(fs.readFileSync(bad)), /integrity mismatch/);
  assert.throws(() => prepareBootstrap(output, bad), /integrity mismatch/);
  assert.throws(() => prepareBootstrap(output, path.join(output, "absent-vp.tgz")), /ENOENT/);
  check("altered and absent native Vite+ archives rejected before extraction or execution");

  // Manifest-only fixture, not another checkout. The authoritative lockfile is
  // unchanged; install cannot run checkout hooks or mutate its dependencies.
  fs.mkdirSync(path.join(fixture, "packages/cli"), { recursive: true });
  for (const name of [".node-version", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "packages/cli/package.json"]) {
    fs.copyFileSync(path.join(ROOT, name), path.join(fixture, name));
  }
  fs.writeFileSync(path.join(fixture, "entry.ts"), "export const answer: number = 42;\n");
  fs.writeFileSync(path.join(fixture, "vite.config.ts"), "import { defineConfig } from 'vite-plus';\nexport default defineConfig({ build: { lib: { entry: 'entry.ts', formats: ['es'], fileName: 'proof' } } });\n");
  process.env.NPM_TOKEN = "bootstrap-proof-not-a-credential";
  process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "bootstrap-proof-not-an-oidc-token";
  process.env.NPM_CONFIG_USERCONFIG = path.join(output, "untrusted.npmrc");
  fs.writeFileSync(process.env.NPM_CONFIG_USERCONFIG, "registry=https://untrusted.invalid\n");
  const bootstrap = await setupWorkflow(output, true, fixture);
  const archive = path.join(bootstrap.home, "vp.tgz");
  json(path.join(output, "environment.json"), bootstrap.env);
  const leakedKeys = JSON.parse(await bootstrap.execute(["node", "-e", "console.log(JSON.stringify(['NPM_TOKEN','ACTIONS_ID_TOKEN_REQUEST_TOKEN','NPM_CONFIG_USERCONFIG','NODE_OPTIONS','NODE_PATH'].filter(key => process.env[key] !== undefined)))"], fixture));
  assert.deepEqual(leakedKeys, [], "bootstrap inherited credential/config/runtime settings");
  check("hostile inherited npm/OIDC configuration absent from managed child environment");
  fs.writeFileSync(path.join(output, "runtime.json"), await bootstrap.execute(["env", "current", "--json"], fixture));
  check("verified native Vite+ 1.0.0 acquired managed Node 24.19.0 and digest-bound pnpm 10.30.3 in fresh private roots");
  fs.copyFileSync(path.join(bootstrap.home, "install.log"), path.join(output, "install.log"));
  assert.deepEqual(fs.readFileSync(path.join(fixture, "pnpm-lock.yaml")), fs.readFileSync(path.join(ROOT, "pnpm-lock.yaml")));
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture, "node_modules/vite-plus/package.json"), "utf8")).version, "1.0.0");
  fs.writeFileSync(path.join(output, "build.log"), await bootstrap.execute(["build"], fixture));
  const built = await import(pathToFileURL(path.join(fixture, "dist/proof.mjs")).href);
  assert.equal(built.answer, 42);
  for (const [command, expected] of [
    ["node", "v24.19.0"],
    ["pnpm", "10.30.3"],
  ]) {
    assert.equal((await run(path.join(bootstrap.home, "bin", command), ["--version"], fixture, bootstrap.env)).trim(), expected);
  }
  check("frozen lockfile unchanged; lifecycle disabled; local Vite+ built executable TypeScript without ambient JavaScript tools");

  const manifestPath = path.join(fixture, "package.json");
  const manifestBytes = fs.readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  manifest.devDependencies["vite-plus"] = "0.3.0";
  json(manifestPath, manifest);
  await assert.rejects(bootstrap.execute(["install", "--frozen-lockfile", "--ignore-scripts"], fixture), /ERR_PNPM_OUTDATED_LOCKFILE/);
  fs.writeFileSync(manifestPath, manifestBytes);
  check("changed manifest rejected by frozen install");

  const payload = path.join(output, "payload");
  fs.mkdirSync(path.join(payload, "package/bin"), { recursive: true });
  const marker = path.join(output, "unverified-executed");
  json(path.join(payload, "package/package.json"), {
    name: "pnpm",
    version: "10.30.3",
    bin: { pnpm: "bin/pnpm.cjs" },
  });
  fs.writeFileSync(path.join(payload, "package/bin/pnpm.cjs"), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad');`);
  const alteredArchive = path.join(output, "altered-pnpm.tgz");
  await run("/bin/tar", ["--use-compress-program=/bin/gzip", "-cf", alteredArchive, "-C", payload, "package"], output, {});
  let unavailable = false;
  const requests = [];
  server = http.createServer((request, response) => {
    requests.push(request.url);
    if (unavailable) response.writeHead(503).end("unavailable");
    else response.end(fs.readFileSync(alteredArchive));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const registry = `http://127.0.0.1:${server.address().port}`;
  const offline = {
    VP_NODE_DIST_MIRROR: registry,
    npm_config_registry: registry,
    NPM_CONFIG_REGISTRY: registry,
  };
  fs.writeFileSync(path.join(output, "warm-offline-runtime.log"), await bootstrap.execute(["node", "--version"], fixture, offline));
  fs.writeFileSync(path.join(output, "warm-offline-pnpm.log"), await bootstrap.execute(["env", "exec", "pnpm", "--version"], fixture, offline));
  fs.writeFileSync(path.join(output, "warm-offline-install.log"), await bootstrap.execute(["install", "--offline", "--frozen-lockfile", "--ignore-scripts"], fixture, offline));
  assert.equal(requests.length, 0, "warm offline use made a network request");
  check("warm managed runtime/pnpm cache and dependency store work offline without requests");

  // New VP_HOME, but reuse the proven Node distribution only. pnpm must be
  // acquired in a fresh manager cache and reject a valid altered tarball.
  const altered = prepareBootstrap(output, archive);
  const runtimeDir = path.join(altered.env.VP_HOME, "js_runtime");
  fs.mkdirSync(altered.env.VP_HOME, { recursive: true });
  fs.symlinkSync(path.join(bootstrap.env.VP_HOME, "js_runtime"), runtimeDir);
  await altered.execute(["env", "on"], fixture);
  await assert.rejects(altered.execute(["env", "exec", "pnpm", "--version"], fixture, offline), /[Hh]ash.*mismatch|[Ii]ntegrity.*mismatch/);
  assert.equal(fs.existsSync(marker), false);
  check("altered valid pnpm archive rejected by the fixed digest before executable marker");

  const rejectedProject = path.join(output, "rejected-project");
  fs.mkdirSync(path.join(rejectedProject, "packages/cli"), { recursive: true });
  for (const name of [".node-version", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "packages/cli/package.json"]) fs.copyFileSync(path.join(ROOT, name), path.join(rejectedProject, name));
  await assert.rejects(bootstrap.execute(["install", "--", "--frozen-lockfile", "--ignore-scripts", `--registry=${registry}`, "--fetch-retries=0", `--store-dir=${path.join(output, "fresh-dependency-store")}`], rejectedProject), /ERR_PNPM_TARBALL_INTEGRITY/);
  assert.equal(fs.existsSync(path.join(rejectedProject, "node_modules/vite-plus/bin/vp")), false);
  assert.equal(fs.existsSync(marker), false);
  check("altered dependency archive rejected against unchanged lockfile before local Vite+ is executable");

  unavailable = true;
  await assert.rejects(altered.execute(["env", "exec", "pnpm", "--version"], fixture, offline), /503/);
  const absent = prepareBootstrap(output, archive);
  await absent.execute(["env", "on"], fixture);
  await assert.rejects(absent.execute(["node", "--version"], fixture, offline), /503/);
  check("empty offline manager/runtime caches fail closed without ambient fallback");
  json(path.join(output, "negative-requests.json"), requests);
  report.status = "pass";
} catch (error) {
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  json(path.join(output, "report.json"), report);
  console.log(JSON.stringify(report, null, 2));
}
