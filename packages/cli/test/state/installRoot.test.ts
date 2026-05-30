import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  classifyInstallRoot,
  classifyResolvedRoot,
  defaultAppHome,
  formatDiagnostic,
  isForeignPlatformDefaultAppHome,
  knownPlatformDefaultAppHomes,
  toDict,
} from "../../src/state/installRoot.js";
import { resolvePath } from "../../src/core/paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const MODEL = path.join(REPO_ROOT, ".agentera", "install_root_interface_model.yaml");
const INVENTORY = path.join(REPO_ROOT, ".agentera", "install_root_behavior_inventory.yaml");

function readYaml(p: string): any {
  return YAML.parse(fs.readFileSync(p, "utf8"));
}

function writeSetupRoot(root: string): void {
  // Node-era setup evidence: app data surfaces (no Python scripts/hooks).
  for (const entry of ["skills", "skills/agentera/SKILL.md", "registry.json"]) {
    const target = path.join(root, entry);
    if (path.basename(target).includes(".")) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "fixture\n");
    } else {
      fs.mkdirSync(target, { recursive: true });
    }
  }
}

function writeUpgradeRoot(
  root: string,
  opts: { markerVersion?: string | null; commands?: string[] } = {},
): void {
  const markerVersion = opts.markerVersion === undefined ? "current" : opts.markerVersion;
  const commands = opts.commands ?? ["hej"];
  const script = path.join(root, "scripts", "agentera");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  const commandLines = commands.map((name) => `sub.add_parser(${JSON.stringify(name)})\n`).join("");
  fs.writeFileSync(
    script,
    "#!/usr/bin/env python3\n" +
      "import argparse\n" +
      "parser = argparse.ArgumentParser(prog='agentera')\n" +
      "sub = parser.add_subparsers(dest='command')\n" +
      commandLines +
      "parser.parse_args()\n",
  );
  fs.chmodSync(script, 0o755);
  fs.mkdirSync(path.join(root, "hooks"), { recursive: true });
  const skill = path.join(root, "skills", "agentera", "SKILL.md");
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, "---\nname: agentera\n---\n");
  fs.writeFileSync(
    path.join(root, "registry.json"),
    JSON.stringify({ skills: [{ name: "agentera", version: "current" }] }),
  );
  if (markerVersion !== null) {
    fs.writeFileSync(
      path.join(root, ".agentera-bundle.json"),
      JSON.stringify({ schemaVersion: "agentera.bundle.v1", version: markerVersion }),
    );
  }
}

function snapshot(root: string): Map<string, [boolean, string | null]> {
  const out = new Map<string, [boolean, string | null]>();
  if (!fs.existsSync(root)) return out;
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      const rel = path.relative(root, p);
      if (st.isFile()) {
        out.set(rel, [true, fs.readFileSync(p, "utf8")]);
      } else {
        out.set(rel, [false, null]);
        walk(p);
      }
    }
  };
  out.set(".", [false, null]);
  walk(root);
  return out;
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ir-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("install-root classification", () => {
  it("matches the approved behavior matrix for characterized shapes", () => {
    const model = readYaml(MODEL);
    const inventory = readYaml(INVENTORY);
    const shapeMap = model.inventory_links.behavior_shape_map as Record<string, string>;

    const setupValid = path.join(tmp, "setup-valid");
    const envValid = path.join(tmp, "env-valid");
    const defaultValid = path.join(tmp, "default-valid");
    const fresh = path.join(tmp, "fresh");
    const staleMissingMarker = path.join(tmp, "stale-missing-marker");
    const staleVersion = path.join(tmp, "stale-version");
    const fileRoot = path.join(tmp, "file-root");
    const unmanaged = path.join(tmp, "unmanaged");
    writeSetupRoot(setupValid);
    writeSetupRoot(envValid);
    writeSetupRoot(defaultValid);
    writeUpgradeRoot(fresh);
    writeUpgradeRoot(staleMissingMarker, { markerVersion: null });
    writeUpgradeRoot(staleVersion, { markerVersion: "old" });
    fs.writeFileSync(fileRoot, "not a directory\n");
    fs.mkdirSync(unmanaged);

    const cases: Record<string, [string, string]> = {
      "valid setup root": [setupValid, "explicit"],
      "missing explicit setup root": [path.join(tmp, "missing-setup"), "explicit"],
      "file explicit setup root": [fileRoot, "explicit"],
      "unmanaged explicit setup directory": [unmanaged, "explicit"],
      "env-derived valid setup root": [envValid, "environment"],
      "auto-detect/default setup root": [defaultValid, "default"],
      "fresh managed upgrade root": [fresh, "explicit"],
      "stale managed upgrade root": [staleVersion, "explicit"],
      "missing explicit or AGENTERA_HOME upgrade root": [path.join(tmp, "missing-env"), "environment"],
      "missing default upgrade root": [path.join(tmp, "missing-default"), "default"],
      "file upgrade root": [fileRoot, "explicit"],
      "unmanaged upgrade directory": [unmanaged, "explicit"],
      "OpenCode runtime AGENTERA_HOME candidate": [fresh, "environment"],
    };

    for (const entry of inventory.behavior_matrix as Array<{ shape: string }>) {
      const shape = entry.shape;
      const [root, source] = cases[shape];
      const result = classifyResolvedRoot(root, { source, expectedVersion: "current" });
      const expectedKind = shapeMap[shape];
      const contract = model.root_kinds[expectedKind];
      expect(result.kind, shape).toBe(expectedKind);
      expect(result.managed_status, shape).toBe(contract.managed_status);
      expect(result.stale_status, shape).toBe(contract.stale_status);
      expect(result.safe_action, shape).toBe(contract.safe_action);
      expect(result.diagnostic.code, shape).toBe(contract.diagnostic.code);
    }

    // Node model: full app data without a bundle marker is a ready setup root
    // (managed_fresh). The Python-era "lost marker -> stale" concept is gone.
    const missingMarker = classifyResolvedRoot(staleMissingMarker, {
      source: "explicit",
      expectedVersion: "current",
    });
    expect(missingMarker.kind).toBe("managed_fresh");
  });

  it("is read-only for existing and missing roots", () => {
    const existing = path.join(tmp, "existing");
    writeUpgradeRoot(existing, { markerVersion: "old" });
    const missing = path.join(tmp, "missing-default");
    const before = snapshot(existing);

    const stale = classifyResolvedRoot(existing, { source: "explicit", expectedVersion: "current" });
    const missingResult = classifyResolvedRoot(missing, { source: "default", expectedVersion: "current" });

    expect(stale.kind).toBe("managed_stale");
    expect(missingResult.kind).toBe("missing_default");
    expect(snapshot(existing)).toEqual(before);
    expect(fs.existsSync(missing)).toBe(false);
  });

  it("stale diagnostic exposes expected and current versions without refresh", () => {
    const root = path.join(tmp, "stale");
    writeUpgradeRoot(root, { markerVersion: "old" });

    const result = classifyResolvedRoot(root, { source: "explicit", expectedVersion: "current" });

    expect(result.safe_action).toBe("preview_refresh");
    expect(result.expected_version).toBe("current");
    expect(result.current_version).toBe("old");
    expect(result.diagnostic.evidence.expectedVersion).toBe("current");
    expect(result.diagnostic.evidence.currentVersion).toBe("old");
    expect(result.diagnostic.evidence.reason).toBe("version_mismatch");
    expect(fs.readdirSync(root).some((n) => n.startsWith(".refresh"))).toBe(false);
  });

  it("display text does not replace structured diagnostic data", () => {
    const root = path.join(tmp, "unmanaged");
    fs.mkdirSync(root);

    const result = classifyResolvedRoot(root, { source: "explicit", expectedVersion: "current" });
    const text = formatDiagnostic(result);
    const data = toDict(result) as any;

    expect(text).toContain("files Agentera does not recognize");
    expect(data.diagnostic.code).toBe("install_root.unmanaged_directory");
    expect(data.diagnostic.evidence.path).toBe(resolvePath(root));
    expect(data.safe_action).toBe("reject_unmanaged_directory");
  });

  it("honors explicit > environment > default source precedence", () => {
    const explicit = path.join(tmp, "explicit");
    const envRoot = path.join(tmp, "env");
    const def = path.join(tmp, "default");
    for (const root of [explicit, envRoot, def]) writeSetupRoot(root);
    const home = path.join(tmp, "home");

    const explicitResult = classifyInstallRoot(explicit, {
      env: { AGENTERA_HOME: envRoot, AGENTERA_DEFAULT_INSTALL_ROOT: def },
      home,
      expectedVersion: "current",
    });
    const envResult = classifyInstallRoot(null, {
      env: { AGENTERA_HOME: envRoot, AGENTERA_DEFAULT_INSTALL_ROOT: def },
      home,
      expectedVersion: "current",
    });
    const defaultResult = classifyInstallRoot(null, {
      env: { AGENTERA_DEFAULT_INSTALL_ROOT: def },
      home,
      expectedVersion: "current",
    });

    expect([explicitResult.source, explicitResult.path]).toEqual(["explicit", resolvePath(explicit)]);
    expect([envResult.source, envResult.path]).toEqual(["environment", resolvePath(envRoot)]);
    expect([defaultResult.source, defaultResult.path]).toEqual(["default", resolvePath(def)]);
  });

  it("detects foreign platform defaults on darwin", () => {
    const home = path.join(tmp, "home");
    const env: Record<string, string | undefined> = {};
    const linuxDefault = path.join(home, ".local", "share", "agentera");
    const macDefault = path.join(home, "Library", "Application Support", "agentera");

    expect(resolvePath(defaultAppHome(env, home, "darwin"))).toBe(resolvePath(macDefault));
    expect(isForeignPlatformDefaultAppHome(linuxDefault, { env, home, platform: "darwin" })).toBe(true);
    expect(isForeignPlatformDefaultAppHome(macDefault, { env, home, platform: "darwin" })).toBe(false);
  });

  it("known platform default app homes cover all OS defaults", () => {
    const home = path.join(tmp, "home");
    const env = {
      APPDATA: path.join(home, "AppData", "Roaming"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
    };
    const known = knownPlatformDefaultAppHomes(env, home);
    expect(known.has(resolvePath(path.join(home, ".local", "share", "agentera")))).toBe(true);
    expect(known.has(resolvePath(path.join(home, "Library", "Application Support", "agentera")))).toBe(true);
    expect(known.has(resolvePath(path.join(home, "AppData", "Roaming", "agentera")))).toBe(true);
  });
});
