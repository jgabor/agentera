import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { doctorRoots, isCorruptSuiteVersion, loadSuiteVersion, readSuiteVersion, resolveActiveAppModel, resolveInstallRoot } from "../../src/upgrade/appModel.js";
import { PackageRegistry, RegistryError, loadRegistry } from "../../src/registries/packageRegistry.js";
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
    expect(resolveInstallRoot(null, REPO_ROOT, home, { XDG_DATA_HOME: xdg })).toBe(resolvePath(platformDefaultAppHome(home, xdg)));
  });

  it("uses AGENTERA_DEFAULT_INSTALL_ROOT when present", () => {
    const dflt = path.join(home, "dflt");
    expect(resolveInstallRoot(null, REPO_ROOT, home, { AGENTERA_DEFAULT_INSTALL_ROOT: dflt })).toBe(resolvePath(dflt));
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
  it("reads skills[0].version from registry.json", () => {
    fs.writeFileSync(path.join(home, "registry.json"), JSON.stringify({ skills: [{ version: "1.2.3-test" }] }));
    expect(loadSuiteVersion(home)).toBe("1.2.3-test");
  });

  it("returns null when registry.json is absent", () => {
    expect(loadSuiteVersion(home)).toBeNull();
  });
});

describe("readSuiteVersion", () => {
  const writeRegistry = (body: string) => fs.writeFileSync(path.join(home, "registry.json"), body);
  const contractWithSelector = (selector: string) => () => {
    const record = structuredClone(loadRegistry().get("agentera"));
    record.version_authority.selector = selector;
    return new PackageRegistry([record]);
  };

  it("returns the version for valid authority", () => {
    writeRegistry(JSON.stringify({ skills: [{ version: "3.0.0" }] }));
    const result = readSuiteVersion(home);
    expect(result).toEqual({ kind: "ok", version: "3.0.0", path: path.join(home, "registry.json") });
    expect(isCorruptSuiteVersion(result)).toBe(false);
  });

  it("classifies a missing authority file as missing, not corrupt", () => {
    const result = readSuiteVersion(home);
    expect(result).toMatchObject({ kind: "failure", reason: "missing" });
    expect(isCorruptSuiteVersion(result)).toBe(false);
  });

  it("classifies an unreadable authority file", () => {
    writeRegistry(JSON.stringify({ skills: [{ version: "3.0.0" }] }));
    const realRead = fs.readFileSync;
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
      if (file === path.join(home, "registry.json")) {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      }
      return realRead(file, options as BufferEncoding);
    }) as typeof fs.readFileSync);
    try {
      const result = readSuiteVersion(home);
      expect(result).toMatchObject({ kind: "failure", reason: "unreadable" });
      expect(isCorruptSuiteVersion(result)).toBe(true);
    } finally {
      spy.mockRestore();
    }
    fs.rmSync(path.join(home, "registry.json"));
    fs.mkdirSync(path.join(home, "registry.json"));
    const directory = readSuiteVersion(home);
    expect(directory).toMatchObject({ kind: "failure", reason: "unreadable" });
    expect(isCorruptSuiteVersion(directory)).toBe(true);
  });

  it("classifies malformed JSON", () => {
    writeRegistry("{ broken");
    expect(readSuiteVersion(home)).toMatchObject({ kind: "failure", reason: "malformed" });
  });

  it("classifies absent or empty skills data", () => {
    writeRegistry(JSON.stringify({ skills: [] }));
    expect(readSuiteVersion(home)).toMatchObject({ kind: "failure", reason: "empty_skills" });
    writeRegistry("null");
    expect(readSuiteVersion(home)).toMatchObject({ kind: "failure", reason: "empty_skills" });
  });

  it("classifies a first skill without a usable version", () => {
    writeRegistry(JSON.stringify({ skills: [{ name: "agentera", version: "" }] }));
    expect(readSuiteVersion(home)).toMatchObject({ kind: "failure", reason: "invalid_version" });
  });

  it("classifies a contract that selects another version field", () => {
    writeRegistry(JSON.stringify({ skills: [{ version: "3.0.0" }] }));
    expect(readSuiteVersion(home, contractWithSelector("skills[0].version"))).toMatchObject({ kind: "ok", version: "3.0.0" });
    expect(readSuiteVersion(home, contractWithSelector("version"))).toMatchObject({ kind: "failure", reason: "selector_mismatch" });
  });

  it("classifies an unreadable package contract instead of throwing", () => {
    writeRegistry(JSON.stringify({ skills: [{ version: "3.0.0" }] }));
    const result = readSuiteVersion(home, () => {
      throw new RegistryError("PackageManifest registry validation failed");
    });
    expect(result).toMatchObject({ kind: "failure", reason: "contract_unreadable", path: null });
    expect(isCorruptSuiteVersion(result)).toBe(true);
    expect(loadSuiteVersion(home)).toBe("3.0.0");
  });
});
