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

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function run(nodeVersion, home, marker) {
  return spawnSync("vp", ["env", "exec", "--node", nodeVersion, "node", PROOF], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: GLOBAL_PATH,
      VP_HOME: home,
      AGENTERA_PROJECT_COMMAND_MARKER: marker,
    },
    maxBuffer: 20 * 1024 * 1024,
  });
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-managed-toolchain-"));
const lockBefore = sha256(LOCK);
try {
  const positive = run("24.19.0", path.join(sandbox, "positive-vp-home"), path.join(sandbox, "positive.marker"));
  assert.equal(positive.status, 0, `${positive.stdout}${positive.stderr}`);
  process.stdout.write(positive.stdout);

  const negativeMarker = path.join(sandbox, "negative.marker");
  const negative = run("24.20.0", path.join(sandbox, "negative-vp-home"), negativeMarker);
  assert.notEqual(negative.status, 0, "wrong managed runtime unexpectedly passed");
  assert.match(`${negative.stdout}${negative.stderr}`, /integration must use the pinned Node\.js/);
  assert.equal(fs.existsSync(negativeMarker), false, "project commands ran under the wrong managed runtime");

  const lockAfter = sha256(LOCK);
  assert.equal(lockAfter, lockBefore, "managed toolchain proof changed pnpm-lock.yaml");
  console.log(
    JSON.stringify(
      {
        hostNode: process.version,
        managedNode: "v24.19.0",
        rejectedManagedNode: "v24.20.0",
        pnpm: "10.30.3",
        vitePlus: "0.3.0",
        lockSha256: lockAfter,
        vpHome: "disposable",
      },
      null,
      2,
    ),
  );
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
