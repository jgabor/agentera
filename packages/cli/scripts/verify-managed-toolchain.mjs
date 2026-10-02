import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { activateBootstrap, prepareBootstrap, provisionVpArchive } from "./bootstrap-integrity.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const PROOF = path.join(ROOT, "packages/cli/scripts/verify-toolchain-baseline.mjs");
const LOCK = path.join(ROOT, "pnpm-lock.yaml");
const REQUIRED_NODE = fs.readFileSync(path.join(ROOT, ".node-version"), "utf8").trim();
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-managed-toolchain-"));
const lockBefore = sha256(LOCK);
try {
  const bootstrap = prepareBootstrap(sandbox, await provisionVpArchive(sandbox));
  await activateBootstrap(bootstrap, ROOT);
  const run = (version, marker, launcher = bootstrap.vp) =>
    spawnSync(bootstrap.vp, ["env", "exec", "--node", version, "node", PROOF], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...bootstrap.env,
        AGENTERA_TOOLCHAIN_VP: launcher,
        AGENTERA_PROJECT_COMMAND_MARKER: marker,
      },
      maxBuffer: 20 * 1024 * 1024,
      timeout: 180_000,
    });
  const positive = run(REQUIRED_NODE, path.join(sandbox, "positive.marker"));
  assert.equal(positive.status, 0, `${positive.stdout}${positive.stderr}`);
  process.stdout.write(positive.stdout);
  const negativeMarker = path.join(sandbox, "negative.marker");
  const negative = run("24.20.0", negativeMarker);
  assert.notEqual(negative.status, 0, "wrong managed runtime unexpectedly passed");
  assert.match(`${negative.stdout}${negative.stderr}`, /integration must use the pinned Node\.js/);
  assert.equal(fs.existsSync(negativeMarker), false, "project commands ran under the wrong managed runtime");
  const staleLauncher = path.join(sandbox, "stale-vp");
  fs.writeFileSync(staleLauncher, "#!/bin/sh\nprintf 'vp v0.3.0\\n'\n", { mode: 0o755 });
  const staleMarker = path.join(sandbox, "stale.marker");
  const stale = run(REQUIRED_NODE, staleMarker, staleLauncher);
  assert.notEqual(stale.status, 0, "unsupported launcher unexpectedly passed");
  assert.match(`${stale.stdout}${stale.stderr}`, /standalone Vite\+ 1\.0\.0.*vp install --frozen-lockfile/);
  assert.equal(fs.existsSync(staleMarker), false, "project commands ran after the launcher pin was rejected");
  assert.equal(sha256(LOCK), lockBefore, "managed toolchain proof changed pnpm-lock.yaml");
  console.log(
    JSON.stringify(
      {
        status: "pass",
        hostNode: process.version,
        managedNode: `v${REQUIRED_NODE}`,
        rejectedManagedNode: "v24.20.0",
        pnpm: "10.30.3",
        vitePlus: "1.0.0",
        rejectedVitePlus: "0.3.0",
        lockSha256: lockBefore,
        vpHome: "disposable",
      },
      null,
      2,
    ),
  );
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
