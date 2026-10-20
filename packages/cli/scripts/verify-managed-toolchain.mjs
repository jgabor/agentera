import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { activateBootstrap, prepareBootstrap, provisionVpArchive, VP_VERSION } from "./bootstrap-integrity.mjs";
import { VP_LAUNCHER_RANGE } from "./launcher-range.mjs";

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
  const report = (result) => JSON.parse(result.stdout.slice(result.stdout.indexOf('{\n  "schemaVersion"'))).launcher;
  const positive = run(REQUIRED_NODE, path.join(sandbox, "positive.marker"));
  assert.equal(positive.status, 0, `${positive.stdout}${positive.stderr}`);
  process.stdout.write(positive.stdout);
  assert.equal(report(positive).qualification, "qualified");
  // A launcher that reports a different version but delegates every other
  // command to the verified release binary.
  const fakeLauncher = (name, version) => {
    const file = path.join(sandbox, name);
    fs.writeFileSync(file, `#!/bin/sh\nif [ "$1" = --version ]; then printf 'vp v${version}\\n'; exit 0; fi\nexec '${bootstrap.vp}' "$@"\n`, { mode: 0o755 });
    return file;
  };
  const [major, minor] = VP_VERSION.split(".").map(Number);
  const newerVersion = `${major}.${minor + 1}.0`;
  const newer = run(REQUIRED_NODE, path.join(sandbox, "newer.marker"), fakeLauncher("newer-vp", newerVersion));
  assert.equal(newer.status, 0, `${newer.stdout}${newer.stderr}`);
  const newerReport = report(newer);
  assert.equal(newerReport.version, newerVersion);
  assert.equal(newerReport.qualification, "accepted_unqualified");
  assert.ok(newerReport.unqualifiedResults.length > 0, "newer launcher report omitted its unqualified results");
  assert.match(newer.stderr, /accepted but unqualified/);
  assert.doesNotMatch(`${newer.stdout}${newer.stderr}`, /downgrade|launcher v\S+ rejected/i);
  const prereleaseMarker = path.join(sandbox, "prerelease.marker");
  const prerelease = run(REQUIRED_NODE, prereleaseMarker, fakeLauncher("prerelease-vp", `${newerVersion}-rc.0`));
  assert.notEqual(prerelease.status, 0, "prerelease launcher unexpectedly passed");
  assert.ok(`${prerelease.stdout}${prerelease.stderr}`.includes(`accepted range ${VP_LAUNCHER_RANGE}; only the official ${VP_VERSION} release asset is qualified`));
  assert.equal(fs.existsSync(prereleaseMarker), false, "project commands ran after a prerelease launcher was rejected");
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
  assert.ok(`${stale.stdout}${stale.stderr}`.includes(`accepted range ${VP_LAUNCHER_RANGE}; only the official ${VP_VERSION} release asset is qualified`));
  assert.match(`${stale.stdout}${stale.stderr}`, /vp install --frozen-lockfile/);
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
        vitePlus: VP_VERSION,
        launcherRange: VP_LAUNCHER_RANGE,
        acceptedUnqualifiedLauncher: { version: newerVersion, unqualifiedResults: newerReport.unqualifiedResults },
        rejectedLaunchers: [`${newerVersion}-rc.0`, "0.3.0"],
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
