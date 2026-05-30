import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { activeAppModel } from "../../src/cli/appContext.js";
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

  it("resolveSourceRootStrict still rejects a non-bundle root missing the source surface", () => {
    seedBundle(bundle, { sentinel: false });
    expect(() => resolveSourceRootStrict({ AGENTERA_BOOTSTRAP_SOURCE_ROOT: bundle })).toThrow(
      /bootstrap source root .* is missing/,
    );
  });
});
