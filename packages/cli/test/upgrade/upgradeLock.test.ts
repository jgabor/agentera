import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { acquireUpgradeLock, releaseUpgradeLock, upgradeLockPath } from "../../src/upgrade/upgradeLock.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function root(name: string): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), `upgrade-lock-${name}-`));
  roots.push(value);
  return value;
}

describe("upgrade mutation ownership", () => {
  it("serializes a same-project mutation race", () => {
    const project = root("project");
    const owner = acquireUpgradeLock(project, "project");

    expect(() => acquireUpgradeLock(project, "project")).toThrow(`inspect ${upgradeLockPath(project, "project")}`);
    expect(JSON.parse(fs.readFileSync(owner.path, "utf8"))).toEqual({ token: owner.token });

    releaseUpgradeLock(owner);
  });

  it("serializes a shared-runtime mutation race", () => {
    const home = root("runtime");
    const firstApp = path.join(home, "agentera-a");
    const secondApp = path.join(home, "agentera-b");
    fs.mkdirSync(firstApp);
    fs.mkdirSync(secondApp);
    const owner = acquireUpgradeLock(home, "runtime");

    expect(() => acquireUpgradeLock(home, "runtime")).toThrow("upgrade mutation is locked");
    expect(fs.existsSync(firstApp)).toBe(true);
    expect(fs.existsSync(secondApp)).toBe(true);

    releaseUpgradeLock(owner);
    expect(fs.existsSync(path.join(home, ".agentera"))).toBe(false);
  });

  it("does not block an independent mutation domain", () => {
    const sharedRoot = root("independent");
    const projectOwner = acquireUpgradeLock(sharedRoot, "project");
    const runtimeOwner = acquireUpgradeLock(sharedRoot, "runtime");

    expect(fs.existsSync(projectOwner.path)).toBe(true);
    expect(fs.existsSync(runtimeOwner.path)).toBe(true);

    releaseUpgradeLock(runtimeOwner);
    releaseUpgradeLock(projectOwner);
  });

  it("checks ownership on release and leaves stale state for manual recovery", () => {
    const project = root("release");
    const owner = acquireUpgradeLock(project, "project");
    fs.writeFileSync(
      owner.path,
      `${JSON.stringify({
        token: "stale-owner",
      })}\n`,
    );

    expect(() => releaseUpgradeLock(owner)).toThrow(`inspect ${owner.path}, remove that file only if no upgrade owns it, then rerun`);
    expect(fs.existsSync(owner.path)).toBe(true);
    expect(() => acquireUpgradeLock(project, "project")).toThrow("remove that file only if no upgrade owns it");
  });
});
