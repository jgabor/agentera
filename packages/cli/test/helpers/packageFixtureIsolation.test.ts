import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { assertSharedTreeUnchanged, privatePackageCopy, sharedTreeStamp } from "./packageFixtureIsolation.js";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

// A miniature extracted package: a startup authority and a node_modules link
// to an installed dependency graph, as package setup leaves it.
function sharedPackage(): { packageRoot: string; protocol: string; modules: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-package-isolation-"));
  roots.push(root);
  const installed = path.join(root, "installed");
  fs.mkdirSync(path.join(installed, "yaml/dist"), { recursive: true });
  fs.writeFileSync(path.join(installed, "yaml/dist/index.js"), "module.exports = {};\n");
  const packageRoot = path.join(root, "package");
  const protocol = path.join(packageRoot, "bundle/skills/agentera/protocol.yaml");
  fs.mkdirSync(path.dirname(protocol), { recursive: true });
  fs.writeFileSync(protocol, "OPERATING_RULES: []\n");
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ dependencies: { yaml: "2.0.0" } }));
  const modules = path.join(packageRoot, "node_modules");
  fs.symlinkSync(installed, modules, "dir");
  return { packageRoot, protocol, modules };
}

// The tampers package tests used to apply in place, each restored afterwards.
const tampers = {
  "dependency link swap": ({ modules }: ReturnType<typeof sharedPackage>) => {
    const link = fs.readlinkSync(modules);
    fs.unlinkSync(modules);
    fs.mkdirSync(modules);
    fs.rmSync(modules, { recursive: true });
    fs.symlinkSync(link, modules, "dir");
  },
  "startup authority rewrite": ({ protocol }: ReturnType<typeof sharedPackage>) => {
    const original = fs.readFileSync(protocol);
    fs.unlinkSync(protocol);
    fs.writeFileSync(protocol, "OPERATING_RULES: [invalid");
    fs.writeFileSync(protocol, original);
  },
};

describe("shared package fixture isolation", () => {
  it.each(Object.keys(tampers) as Array<keyof typeof tampers>)("detects a restored in-place %s of the shared package", async (name) => {
    const shared = sharedPackage();
    const stamp = sharedTreeStamp([shared.packageRoot]);
    // File times use a coarse kernel clock; real fixtures are minutes old.
    await delay(25);
    tampers[name](shared);
    expect(fs.readFileSync(shared.protocol, "utf8")).toBe("OPERATING_RULES: []\n");
    expect(() => assertSharedTreeUnchanged(stamp, [shared.packageRoot])).toThrow(/shared package fixture changed/);
  });

  it.each(Object.keys(tampers) as Array<keyof typeof tampers>)("keeps the shared package unchanged when a private copy takes the %s", async (name) => {
    const shared = sharedPackage();
    const stamp = sharedTreeStamp([shared.packageRoot]);
    await delay(25);
    const copy = privatePackageCopy(shared.packageRoot, path.join(path.dirname(shared.packageRoot), "copy"));
    tampers[name]({ packageRoot: copy, protocol: path.join(copy, "bundle/skills/agentera/protocol.yaml"), modules: path.join(copy, "node_modules") });
    const standalone = privatePackageCopy(shared.packageRoot, path.join(path.dirname(shared.packageRoot), "standalone"), { standaloneDependencies: true });
    expect(fs.lstatSync(path.join(standalone, "node_modules")).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(standalone, "node_modules/yaml/dist/index.js"), "utf8")).toBe("module.exports = {};\n");
    expect(() => assertSharedTreeUnchanged(stamp, [shared.packageRoot])).not.toThrow();
  });
});
