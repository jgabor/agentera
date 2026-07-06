import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { statusBundleStatus } from "../../src/cli/commands/prime/bundleStatus.js";
import { resetUpdateChannelsAuthorityCache } from "../../src/upgrade/channels.js";
import { BUNDLE_MARKER } from "../../src/state/installRoot.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

let tmp: string;
let home: string;
let prevCwd: string;

function writeSkill(root: string, version: string): string {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, "SKILL.md"),
    `---\nname: agentera\nversion: "${version}"\n---\n# agentera\n`,
  );
  return root;
}

function managedV2(appHome: string, marker = "2.7.7"): void {
  const app = path.join(appHome, "app");
  fs.mkdirSync(path.join(app, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(app, "scripts", "agentera"), "#!/usr/bin/env python3\n");
  fs.mkdirSync(path.join(app, "skills", "agentera"), { recursive: true });
  fs.writeFileSync(path.join(app, "skills", "agentera", "SKILL.md"), "x");
  fs.writeFileSync(
    path.join(app, "registry.json"),
    JSON.stringify({ skills: [{ name: "agentera", version: "current" }] }),
  );
  fs.writeFileSync(
    path.join(appHome, BUNDLE_MARKER),
    JSON.stringify({ schemaVersion: "agentera.bundle.v1", version: marker }),
  );
}

beforeEach(() => {
  resetUpdateChannelsAuthorityCache();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-divergence-"));
  home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  prevCwd = process.cwd();
  process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = REPO_ROOT;
  process.env.HOME = home;
  process.env.AGENTERA_HOME = path.join(home, "agentera");
});

afterEach(() => {
  resetUpdateChannelsAuthorityCache();
  process.chdir(prevCwd);
  delete process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  delete process.env.AGENTERA_UPDATE_CHANNEL;
  delete process.env.HOME;
  delete process.env.AGENTERA_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("bundle-status skill-root divergence detection (D78)", () => {
  it("forces outdated and surfaces a skill_root_divergence signal when ~/.agents is below expected", () => {
    const appHome = process.env.AGENTERA_HOME as string;
    managedV2(appHome);
    const project = path.join(tmp, "proj");
    fs.mkdirSync(project, { recursive: true });
    process.chdir(project);
    writeSkill(path.join(home, ".agents", "skills", "agentera"), "2.7.11");

    const status = statusBundleStatus({ home, installRoot: appHome, env: process.env });

    expect(status.status).toBe("outdated");
    const divergence = status.signals.filter((s) => s.kind === "skill_root_divergence");
    expect(divergence).toHaveLength(1);
    expect(divergence[0]?.actual).toBe("2.7.11");
    expect(divergence[0]?.expected).toBe("3.0.0");
    expect(divergence[0]?.message).toContain(path.join(".agents", "skills", "agentera"));
  });

  it("leaves status unchanged when the agent-compatible root matches expected", () => {
    const appHome = process.env.AGENTERA_HOME as string;
    managedV2(appHome);
    const project = path.join(tmp, "proj-match");
    fs.mkdirSync(project, { recursive: true });
    process.chdir(project);
    writeSkill(path.join(home, ".agents", "skills", "agentera"), "3.0.0");

    const status = statusBundleStatus({ home, installRoot: appHome, env: process.env });

    const divergence = status.signals.filter((s) => s.kind === "skill_root_divergence");
    expect(divergence).toHaveLength(0);
  });

  it("skips recognized roots that are absent (no SKILL.md)", () => {
    const appHome = process.env.AGENTERA_HOME as string;
    managedV2(appHome);
    const project = path.join(tmp, "proj-absent");
    fs.mkdirSync(project, { recursive: true });
    process.chdir(project);

    const status = statusBundleStatus({ home, installRoot: appHome, env: process.env });

    const divergence = status.signals.filter((s) => s.kind === "skill_root_divergence");
    expect(divergence).toHaveLength(0);
  });

  it("flags the agent-compatible root the doctor lists as default-skill-root (consistency)", () => {
    const appHome = process.env.AGENTERA_HOME as string;
    managedV2(appHome);
    const project = path.join(tmp, "proj-consistency");
    fs.mkdirSync(project, { recursive: true });
    process.chdir(project);
    writeSkill(path.join(home, ".agents", "skills", "agentera"), "2.7.11");

    const status = statusBundleStatus({ home, installRoot: appHome, env: process.env });

    const divergence = status.signals.filter((s) => s.kind === "skill_root_divergence");
    expect(divergence).toHaveLength(1);
    expect(divergence[0]?.message).toContain(path.join(home, ".agents", "skills", "agentera"));
  });
});
