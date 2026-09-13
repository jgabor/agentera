import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const PROOF = path.join(ROOT, "packages/cli/scripts/verify-toolchain-baseline.mjs");
const LOCK = path.join(ROOT, "pnpm-lock.yaml");
const GLOBAL_PATH = process.env.PATH.split(path.delimiter)
  .filter((entry) => !entry.includes(`${path.sep}node_modules${path.sep}.bin`))
  .join(path.delimiter);
const VP =
  process.env.AGENTERA_TOOLCHAIN_VP ??
  GLOBAL_PATH.split(path.delimiter)
    .map((entry) => path.resolve(entry, "vp"))
    .find((file) => fs.existsSync(file));
const REQUIRED_NODE = fs.readFileSync(path.join(ROOT, ".node-version"), "utf8").trim();

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function run(nodeVersion, home, marker, proofLauncher = VP) {
  fs.mkdirSync(home, { recursive: true });
  return spawnSync(VP, ["env", "exec", "--node", nodeVersion, "node", PROOF], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      PATH: GLOBAL_PATH,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, "config"),
      XDG_CACHE_HOME: path.join(home, "cache"),
      VP_HOME: path.join(home, "vp"),
      TMPDIR: sandbox,
      AGENTERA_TOOLCHAIN_VP: proofLauncher,
      AGENTERA_PROJECT_COMMAND_MARKER: marker,
    },
    maxBuffer: 20 * 1024 * 1024,
  });
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-managed-toolchain-"));
const lockBefore = sha256(LOCK);
try {
  assert.ok(VP && path.isAbsolute(VP), "Use standalone Vite+ 0.3.0; AGENTERA_TOOLCHAIN_VP may specify its absolute path for this proof.");
  const positive = run(REQUIRED_NODE, path.join(sandbox, "positive-vp-home"), path.join(sandbox, "positive.marker"));
  assert.equal(positive.status, 0, `${positive.stdout}${positive.stderr}`);
  process.stdout.write(positive.stdout);

  const negativeMarker = path.join(sandbox, "negative.marker");
  const negative = run("24.20.0", path.join(sandbox, "negative-vp-home"), negativeMarker);
  assert.notEqual(negative.status, 0, "wrong managed runtime unexpectedly passed");
  assert.match(`${negative.stdout}${negative.stderr}`, /integration must use the pinned Node\.js/);
  assert.equal(fs.existsSync(negativeMarker), false, "project commands ran under the wrong managed runtime");

  const staleLauncher = path.join(sandbox, "stale-vp");
  fs.writeFileSync(staleLauncher, "#!/bin/sh\nprintf 'vp v0.1.19\\n'\n", { mode: 0o755 });
  const staleMarker = path.join(sandbox, "stale.marker");
  const stale = run(REQUIRED_NODE, path.join(sandbox, "positive-vp-home"), staleMarker, staleLauncher);
  assert.notEqual(stale.status, 0, "unsupported launcher unexpectedly passed");
  assert.match(`${stale.stdout}${stale.stderr}`, /standalone Vite\+ 0\.3\.0.*vp install --frozen-lockfile/);
  assert.equal(fs.existsSync(staleMarker), false, "project commands ran after the launcher pin was rejected");

  const lockAfter = sha256(LOCK);
  assert.equal(lockAfter, lockBefore, "managed toolchain proof changed pnpm-lock.yaml");
  console.log(
    JSON.stringify(
      {
        hostNode: process.version,
        managedNode: `v${REQUIRED_NODE}`,
        rejectedManagedNode: "v24.20.0",
        pnpm: "10.30.3",
        vitePlus: "0.3.0",
        rejectedVitePlus: "0.1.19",
        lockSha256: lockAfter,
        vpHome: "disposable",
        launcher: VP,
      },
      null,
      2,
    ),
  );
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
