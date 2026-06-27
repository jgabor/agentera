// Regression tests for OpenCode plugin app-home resolution (#8): v3 npm bundle
// evidence must be recognized without relying on vestigial v2 script probes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Agentera } from "../../../../.opencode/plugins/agentera.js";

const {
  hasV3NpxBundleEvidence,
  isRunnableAgenteraAppRoot,
  resolveAgenteraAppHome,
  resolveAgenteraHome,
} = Agentera.__test;

function seedV3BundleEvidence(root: string): void {
  fs.mkdirSync(path.join(root, "skills", "agentera"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", "agentera", "SKILL.md"), "# Agentera\n");
  fs.writeFileSync(path.join(root, "registry.json"), JSON.stringify({ skills: [{ version: "3.0.0" }] }));
  fs.writeFileSync(
    path.join(root, ".agentera-npx-bundle.json"),
    JSON.stringify({ kind: "agentera-npx-bundle", suiteVersion: "3.0.0" }),
  );
}

describe("resolveAgenteraHome", () => {
  let tmp: string;
  let prevAgenteraHome: string | undefined;
  let prevXdgDataHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-app-home-"));
    prevAgenteraHome = process.env.AGENTERA_HOME;
    prevXdgDataHome = process.env.XDG_DATA_HOME;
    delete process.env.AGENTERA_HOME;
    delete process.env.XDG_DATA_HOME;
  });

  afterEach(() => {
    if (prevAgenteraHome === undefined) delete process.env.AGENTERA_HOME;
    else process.env.AGENTERA_HOME = prevAgenteraHome;
    if (prevXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdgDataHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("recognizes a v3 npm bundle via sentinel evidence without v2 scripts", () => {
    const appHome = path.join(tmp, "agentera");
    const managedApp = path.join(appHome, "app");
    fs.mkdirSync(managedApp, { recursive: true });
    seedV3BundleEvidence(managedApp);

    process.env.AGENTERA_HOME = appHome;

    expect(hasV3NpxBundleEvidence(managedApp)).toBe(true);
    expect(isRunnableAgenteraAppRoot(managedApp)).toBe(true);
    expect(resolveAgenteraHome()).toBe(managedApp);
    expect(resolveAgenteraAppHome()).toBe(appHome);
  });

  it("recognizes a v2 managed app that still ships scripts/agentera", () => {
    const appHome = path.join(tmp, "agentera");
    const managedApp = path.join(appHome, "app");
    fs.mkdirSync(path.join(managedApp, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(managedApp, "scripts", "agentera"), "#!/usr/bin/env bash\n");

    process.env.AGENTERA_HOME = appHome;

    expect(isRunnableAgenteraAppRoot(managedApp)).toBe(true);
    expect(resolveAgenteraHome()).toBe(managedApp);
    expect(resolveAgenteraAppHome()).toBe(appHome);
  });

  it("rejects a directory without v3 bundle evidence or v2 scripts", () => {
    const dataHome = path.join(tmp, "xdg-share");
    const appHome = path.join(dataHome, "agentera");
    const managedApp = path.join(appHome, "app");
    fs.mkdirSync(managedApp, { recursive: true });

    process.env.XDG_DATA_HOME = dataHome;
    process.env.AGENTERA_HOME = appHome;

    expect(isRunnableAgenteraAppRoot(managedApp)).toBe(false);
    expect(resolveAgenteraHome()).toBeNull();
    expect(resolveAgenteraAppHome()).toBeNull();
  });

  it("rejects partial v3 evidence when the npx sentinel is missing", () => {
    const dataHome = path.join(tmp, "xdg-share");
    const appHome = path.join(dataHome, "agentera");
    const managedApp = path.join(appHome, "app");
    fs.mkdirSync(path.join(managedApp, "skills", "agentera"), { recursive: true });
    fs.writeFileSync(path.join(managedApp, "skills", "agentera", "SKILL.md"), "# Agentera\n");
    fs.writeFileSync(path.join(managedApp, "registry.json"), JSON.stringify({ skills: [] }));

    process.env.XDG_DATA_HOME = dataHome;
    process.env.AGENTERA_HOME = appHome;

    expect(hasV3NpxBundleEvidence(managedApp)).toBe(false);
    expect(isRunnableAgenteraAppRoot(managedApp)).toBe(false);
    expect(resolveAgenteraHome()).toBeNull();
  });

  it("resolves the default platform app home when AGENTERA_HOME is unset", () => {
    const dataHome = path.join(tmp, "xdg-share");
    const appHome = path.join(dataHome, "agentera");
    const managedApp = path.join(appHome, "app");
    fs.mkdirSync(managedApp, { recursive: true });
    seedV3BundleEvidence(managedApp);

    process.env.XDG_DATA_HOME = dataHome;

    expect(resolveAgenteraHome()).toBe(managedApp);
    expect(resolveAgenteraAppHome()).toBe(appHome);
  });

  it("injects the validated app home through shell.env when AGENTERA_HOME is absent", async () => {
    const dataHome = path.join(tmp, "xdg-share");
    const appHome = path.join(dataHome, "agentera");
    const managedApp = path.join(appHome, "app");
    fs.mkdirSync(managedApp, { recursive: true });
    seedV3BundleEvidence(managedApp);

    process.env.XDG_DATA_HOME = dataHome;
    delete process.env.AGENTERA_HOME;

    const hooks = await Agentera({}, {});
    const output = { env: {} as Record<string, string> };
    await hooks["shell.env"]({}, output);

    expect(output.env.AGENTERA_HOME).toBe(appHome);
  });
});
