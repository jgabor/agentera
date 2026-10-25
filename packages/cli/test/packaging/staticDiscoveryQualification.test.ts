import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { beforeAll, describe, expect, inject, it } from "vite-plus/test";

import { privatePackageCopy } from "../helpers/packageFixtureIsolation.js";

const fixture = inject("packageFixture");

describe("extracted one-file static discovery", () => {
  // Discovery runs with real dependencies instead of the checkout link. Build
  // that once in a private copy; parallel package files execute the shared
  // extraction, so it must never be swapped in place.
  let root: string;
  beforeAll(() => {
    root = privatePackageCopy(fixture.packageRoot, path.join(fixture.root, "static-discovery-package"), { standaloneDependencies: true });
  });

  // Partition by existing owner, not a repeated home/state/platform matrix.
  it.each(["schema", "prime", "state", "route", "report:0", "report:1", "report:2", "check", "upgrade", "doctor", "app-home"])("traverses every returned %s detail and continuation without companion or checkout reads", (owner) => {
    const home = path.join(fixture.root, `static-${owner}`);
    const host = path.join(home, ".agents/skills/agentera");
    fs.mkdirSync(host, { recursive: true });
    fs.copyFileSync(path.join(root, "bundle/host/agentera/SKILL.md"), path.join(host, "SKILL.md"));
    expect(fs.lstatSync(path.join(root, "node_modules")).isSymbolicLink()).toBe(false);
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local/share"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
    };
    const result = spawnSync(process.execPath, [path.resolve(import.meta.dirname, "../helpers/staticDiscoveryQualification.mjs"), root, owner], {
      cwd: home,
      env,
      encoding: "utf8",
      timeout: 110_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    expect(result.status, `${result.error ?? ""}\n${result.stderr}\n${result.stdout}`).toBe(0);
    const evidence = JSON.parse(result.stdout);
    expect(evidence.counts[owner.split(":")[0]]).toBeGreaterThan(0);
    expect(fs.readdirSync(host)).toEqual(["SKILL.md"]);
    process.stdout.write(
      JSON.stringify({
        staticDiscoveryQualification: evidence,
        tarballSha256: fixture.deterministicBytes.sha256,
        sourceIdentity: fixture.sourceIdentity,
      }) + "\n",
    );
  });
});
