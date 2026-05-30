import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { activeAppModel } from "../../src/cli/appContext.js";
import { buildDoctorStatus } from "../../src/upgrade/doctor.js";
import { cmdUpgrade } from "../../src/cli/commands/upgrade.js";
import { resolveSourceRootStrict } from "../../src/upgrade/appModel.js";

/**
 * Self-contained npx bundle: the published `agentera` package stages app data
 * under <pkg>/bundle with a sentinel so the CLI treats the bundle as the
 * authoritative app home, making `npx agentera` work with no checkout and no
 * AGENTERA_HOME. These tests exercise the sentinel-gated branches.
 */
describe("self-contained npx bundle resolution", () => {
  let bundle: string;

  function seedBundle(root: string, opts: { sentinel: boolean }): void {
    fs.mkdirSync(path.join(root, "skills", "agentera"), { recursive: true });
    fs.writeFileSync(path.join(root, "skills", "agentera", "SKILL.md"), "# Agentera\n");
    fs.writeFileSync(path.join(root, "registry.json"), JSON.stringify({ skills: [{ version: "9.9.9" }] }));
    if (opts.sentinel) {
      fs.writeFileSync(
        path.join(root, ".agentera-npx-bundle.json"),
        JSON.stringify({ kind: "agentera-npx-bundle", suiteVersion: "9.9.9" }),
      );
    }
  }

  beforeEach(() => {
    bundle = fs.mkdtempSync(path.join(os.tmpdir(), "npxbundle-"));
  });
  afterEach(() => {
    fs.rmSync(bundle, { recursive: true, force: true });
  });

  it("treats a sentinel bundle as the authoritative bundled app home", () => {
    seedBundle(bundle, { sentinel: true });
    const model = activeAppModel({ AGENTERA_BOOTSTRAP_SOURCE_ROOT: bundle });
    const real = fs.realpathSync(bundle);
    expect(model.appHomeSource).toBe("bundled app");
    expect(model.authoritativeRoot).toBe(real);
    expect(model.skillRoot).toBe(path.join(real, "skills", "agentera"));
    expect(model.appHome).toBe(real);
  });

  it("does NOT treat a data dir without the sentinel as a bundled app", () => {
    seedBundle(bundle, { sentinel: false });
    const model = activeAppModel({ AGENTERA_BOOTSTRAP_SOURCE_ROOT: bundle });
    // No sentinel and no scripts/agentera checkout marker -> falls back to the
    // default platform app-home model, never the bundled-app branch.
    expect(model.appHomeSource).not.toBe("bundled app");
  });

  it("an explicit AGENTERA_HOME overrides the bundled-app branch", () => {
    seedBundle(bundle, { sentinel: true });
    const model = activeAppModel({ AGENTERA_BOOTSTRAP_SOURCE_ROOT: bundle, AGENTERA_HOME: bundle });
    expect(model.appHomeSource).not.toBe("bundled app");
  });

  it("resolveSourceRootStrict accepts a sentinel bundle lacking the Python source surface", () => {
    seedBundle(bundle, { sentinel: true });
    const resolved = resolveSourceRootStrict({ AGENTERA_BOOTSTRAP_SOURCE_ROOT: bundle });
    expect(resolved).toBe(fs.realpathSync(bundle));
  });

  it("resolveSourceRootStrict still rejects a root missing the source surface", () => {
    // An empty directory lacks skills/ and registry.json -> not a valid source root.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "npxempty-"));
    try {
      expect(() => resolveSourceRootStrict({ AGENTERA_BOOTSTRAP_SOURCE_ROOT: empty })).toThrow(
        /bootstrap source root .* is missing/,
      );
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("self-contained doctor/upgrade semantics", () => {
  let bundle: string;
  function seed(root: string): void {
    fs.mkdirSync(path.join(root, "skills", "agentera"), { recursive: true });
    fs.writeFileSync(path.join(root, "skills", "agentera", "SKILL.md"), "# Agentera\n");
    fs.writeFileSync(path.join(root, "registry.json"), JSON.stringify({ skills: [{ version: "9.9.9" }] }));
    fs.writeFileSync(path.join(root, ".agentera-npx-bundle.json"), JSON.stringify({ kind: "agentera-npx-bundle" }));
  }
  beforeEach(() => {
    bundle = fs.mkdtempSync(path.join(os.tmpdir(), "npxdoctor-"));
  });
  afterEach(() => {
    fs.rmSync(bundle, { recursive: true, force: true });
  });

  it("buildDoctorStatus reports a sentinel bundle as the up-to-date app", () => {
    seed(bundle);
    const status = buildDoctorStatus(bundle, {
      rootSource: "default app home",
      sourceRoot: bundle,
      home: os.homedir(),
      project: bundle,
      expectedVersion: "9.9.9",
      probeCli: false,
    });
    expect(status.status).toBe("up_to_date");
    expect(status.appHome).toBe(bundle);
    expect(status.appHomeSource).toBe("bundled app");
    expect(status.managedAppRoot).toBe(bundle);
    expect(status.signals).toEqual([]);
    expect(status.dryRunCommand).toBeNull();
    expect(status.applyCommand).toBeNull();
    expect(status.markerVersion).toBe("9.9.9");
  });

  it("cmdUpgrade rejects --yes with --dry-run", () => {
    let err = "";
    const rc = cmdUpgrade({ yes: true, dryRun: true }, { out: () => {}, err: (t) => (err += t) });
    expect(rc).toBe(2);
    expect(err).toContain("mutually exclusive");
  });

  it("cmdUpgrade reports the self-contained model for a sentinel bundle", () => {
    seed(bundle);
    const prev = process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
    process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = bundle;
    try {
      let out = "";
      const rc = cmdUpgrade(
        { expectedVersion: "9.9.9", format: "json" },
        { out: (t) => (out += t), err: () => {} },
      );
      expect(rc).toBe(0);
      const payload = JSON.parse(out);
      expect(payload.mode).toBe("self_contained");
      expect(payload.status).toBe("up_to_date");
      expect(payload.updateCommand).toBe("npx -y agentera@latest");
      expect(payload.currentVersion).toBe("9.9.9");
    } finally {
      if (prev === undefined) delete process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
      else process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = prev;
    }
  });
});
