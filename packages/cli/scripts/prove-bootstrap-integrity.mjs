import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { prepareBootstrap, run, verifiedCorepackBytes } from "./bootstrap-integrity.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const [hostCorepack, output] = process.argv.slice(2);
assert.ok(hostCorepack && output, "usage: node scripts/prove-bootstrap-integrity.mjs HOST_COREPACK_CJS NEW_EVIDENCE_DIRECTORY");
fs.mkdirSync(output); // Existing evidence is never reused as successful setup.
const report = { status: "failed", checks: [] };
const json = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const check = (name) => report.checks.push(name);

try {
  // A missing/altered prerequisite is rejected without executing its marker.
  const badCorepack = path.join(output, "altered-corepack.cjs");
  const marker = path.join(output, "unverified-executed");
  fs.writeFileSync(badCorepack, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`);
  assert.throws(() => verifiedCorepackBytes(badCorepack), /integrity mismatch/);
  assert.throws(() => verifiedCorepackBytes(path.join(output, "absent-corepack.cjs")), /ENOENT/);
  assert.equal(fs.existsSync(marker), false);
  check("altered and absent host Corepack rejected before execution");

  // This is a manifest-only fixture using the unchanged repository lockfile,
  // not a second checkout or a generated dependency qualification profile.
  const fixture = path.join(output, "project");
  fs.mkdirSync(path.join(fixture, "packages/cli"), { recursive: true });
  for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "packages/cli/package.json"]) {
    fs.copyFileSync(path.join(ROOT, name), path.join(fixture, name));
  }
  fs.writeFileSync(path.join(fixture, "entry.ts"), "export const answer: number = 42;\n");
  fs.writeFileSync(path.join(fixture, "vite.config.ts"), "import { defineConfig } from 'vite-plus';\nexport default defineConfig({ build: { lib: { entry: 'entry.ts', formats: ['es'], fileName: 'proof' } } });\n");
  const bootstrap = prepareBootstrap(output, hostCorepack);
  fs.writeFileSync(path.join(output, "corepack-install.log"), await bootstrap.install(fixture));
  assert.equal((await bootstrap.pnpm(["--version"], fixture)).trim(), "10.30.3");
  check("fresh Corepack home downloaded integrity-bound pnpm 10.30.3");
  const install = await bootstrap.pnpm(["install", "--frozen-lockfile", "--ignore-scripts", "--verify-store-integrity"], fixture);
  fs.writeFileSync(path.join(output, "install.log"), install);
  assert.deepEqual(fs.readFileSync(path.join(fixture, "pnpm-lock.yaml")), fs.readFileSync(path.join(ROOT, "pnpm-lock.yaml")));
  const localPackage = JSON.parse(fs.readFileSync(path.join(fixture, "node_modules/vite-plus/package.json"), "utf8"));
  assert.equal(localPackage.version, "0.3.0");
  const vp = path.join(fixture, "node_modules/vite-plus/bin/vp");
  fs.writeFileSync(path.join(output, "build.log"), await run(process.execPath, [vp, "build"], fixture, bootstrap.env));
  const built = await import(pathToFileURL(path.join(fixture, "dist/proof.mjs")).href);
  assert.equal(built.answer, 42);
  check("frozen lockfile unchanged; lifecycle disabled; local Vite+ 0.3.0 built executable TypeScript output without global PATH tools");

  // Serve a valid but altered archive, not malformed bytes that fail before
  // reaching the digest comparison. Its executable would leave a marker.
  const payload = path.join(output, "payload");
  fs.mkdirSync(path.join(payload, "package/bin"), { recursive: true });
  json(path.join(payload, "package/package.json"), {
    name: "pnpm",
    version: "10.30.3",
    bin: { pnpm: "bin/pnpm.cjs" },
  });
  fs.copyFileSync(badCorepack, path.join(payload, "package/bin/pnpm.cjs"));
  const archive = path.join(output, "altered-pnpm.tgz");
  await run("/bin/tar", ["--use-compress-program=/bin/gzip", "-cf", archive, "-C", payload, "package"], output, bootstrap.env);
  let unavailable = false;
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    if (unavailable) {
      response.writeHead(503).end("unavailable");
    } else if (request.url.endsWith(".tgz")) {
      response.end(fs.readFileSync(archive));
    } else {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ dist: { tarball: `http://127.0.0.1:${server.address().port}/pnpm.tgz` } }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const registry = `http://127.0.0.1:${server.address().port}`;
    const altered = prepareBootstrap(output, hostCorepack, registry);
    await assert.rejects(altered.pnpm(["--version"], fixture), /Mismatch hashes/);
    assert.equal(fs.existsSync(marker), false);
    check("altered valid pnpm archive rejected by fixed digest before executable marker");
    const rejectedProject = path.join(output, "rejected-project");
    fs.mkdirSync(path.join(rejectedProject, "packages/cli"), { recursive: true });
    for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "packages/cli/package.json"]) {
      fs.copyFileSync(path.join(ROOT, name), path.join(rejectedProject, name));
    }
    const dependencyBootstrap = prepareBootstrap(output, hostCorepack);
    await dependencyBootstrap.install(rejectedProject);
    await assert.rejects(dependencyBootstrap.pnpm(["install", "--frozen-lockfile", "--ignore-scripts", `--registry=${registry}`, "--fetch-retries=0"], rejectedProject), /ERR_PNPM_TARBALL_INTEGRITY/);
    assert.equal(fs.existsSync(path.join(rejectedProject, "node_modules/vite-plus/bin/vp")), false);
    assert.equal(fs.existsSync(marker), false);
    check("altered dependency archive rejected against existing lockfile in fresh store before local Vite+ becomes executable");
    unavailable = true;
    const absent = prepareBootstrap(output, hostCorepack, registry);
    await assert.rejects(absent.install(fixture), /503/);
    assert.equal(fs.existsSync(marker), false);
    check("unavailable expected pnpm input rejected despite earlier successful setup; no shared cached success");
    report.rejectionRequests = requests;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  report.status = "passed";
} catch (error) {
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  json(path.join(output, "report.json"), report);
  console.log(JSON.stringify(report, null, 2));
}
