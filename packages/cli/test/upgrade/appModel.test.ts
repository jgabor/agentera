import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  doctorRoots,
  loadSuiteVersion,
  resolveActiveAppModel,
  resolveInstallRoot,
} from "../../src/upgrade/appModel.js";
import { parseToml } from "../../src/core/toml.js";
import { resolvePath } from "../../src/core/paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

function platformDefaultAppHome(home: string, xdg?: string): string {
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "agentera");
  }
  if (process.platform === "win32") {
    return path.join(home, "AppData", "Roaming", "agentera");
  }
  const base = xdg ?? path.join(home, ".local", "share");
  return path.join(base, "agentera");
}

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "am-"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("resolveInstallRoot", () => {
  it("honors an explicit value", () => {
    expect(resolveInstallRoot("/opt/foo", REPO_ROOT, home, {})).toBe(resolvePath("/opt/foo"));
  });

  it("uses AGENTERA_HOME when set and not legacy/foreign", () => {
    const custom = path.join(home, "custom");
    expect(resolveInstallRoot(null, REPO_ROOT, home, { AGENTERA_HOME: custom })).toBe(resolvePath(custom));
  });

  it("falls back to the platform default when no env is set", () => {
    const xdg = path.join(home, ".local", "share");
    expect(resolveInstallRoot(null, REPO_ROOT, home, { XDG_DATA_HOME: xdg })).toBe(
      resolvePath(platformDefaultAppHome(home, xdg)),
    );
  });

  it("uses AGENTERA_DEFAULT_INSTALL_ROOT when present", () => {
    const dflt = path.join(home, "dflt");
    expect(resolveInstallRoot(null, REPO_ROOT, home, { AGENTERA_DEFAULT_INSTALL_ROOT: dflt })).toBe(
      resolvePath(dflt),
    );
  });

  it("recovers from a stale legacy default app home to the platform default", () => {
    const legacy = path.join(home, ".agents", "agentera"); // no bundle evidence -> stale
    const xdg = path.join(home, ".local", "share");
    const resolved = resolveInstallRoot(null, REPO_ROOT, home, {
      AGENTERA_HOME: legacy,
      XDG_DATA_HOME: xdg,
    });
    expect(resolved).toBe(resolvePath(platformDefaultAppHome(home, xdg)));
  });
});

describe("resolveActiveAppModel", () => {
  it("returns the app-model roots", () => {
    const xdg = path.join(home, ".local", "share");
    const model = resolveActiveAppModel(null, { home, env: { XDG_DATA_HOME: xdg } });
    const appHome = resolvePath(platformDefaultAppHome(home, xdg));
    expect(model.appHome).toBe(appHome);
    expect(model.managedAppRoot).toBe(path.join(appHome, "app"));
    expect(model.authoritativeRoot).toBe(model.managedAppRoot);
    expect(model.skillRoot).toBe(path.join(model.activeBundleRoot, "skills", "agentera"));
  });
});

describe("doctorRoots", () => {
  it("selects app/ as the active bundle root when bundle evidence exists there", () => {
    const appHome = path.join(home, "managed");
    const app = path.join(appHome, "app");
    fs.mkdirSync(path.join(app, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(app, "scripts", "agentera"), "#!/usr/bin/env node\n");
    fs.mkdirSync(path.join(app, "skills", "agentera"), { recursive: true });
    fs.writeFileSync(path.join(app, "skills", "agentera", "SKILL.md"), "x");

    expect(doctorRoots(appHome).activeBundleRoot).toBe(app);
  });

  it("falls back to the app home when no app/ exists", () => {
    const appHome = path.join(home, "bare");
    fs.mkdirSync(appHome, { recursive: true });
    expect(doctorRoots(appHome).activeBundleRoot).toBe(appHome);
  });
});

describe("loadSuiteVersion", () => {
  it("reads skills[0].version from the repo registry.json", () => {
    const registry = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "registry.json"), "utf8"));
    expect(loadSuiteVersion(REPO_ROOT)).toBe(registry.skills[0].version);
  });

  it("returns null when registry.json is absent", () => {
    expect(loadSuiteVersion(home)).toBeNull();
  });
});

describe("parseToml", () => {
  it("parses TOML into an object", () => {
    expect(parseToml('[project]\nversion = "1.2.3"\n')).toEqual({ project: { version: "1.2.3" } });
  });
});
