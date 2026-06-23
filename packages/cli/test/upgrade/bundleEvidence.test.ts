import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  hasBundleRootEvidence,
  readScriptHead,
} from "../../src/upgrade/bundleEvidence.js";
import { classifyInstall } from "../../src/upgrade/compatibility.js";
import { doctorRoots } from "../../src/upgrade/appModel.js";
import { isV2ManagedInstallAtAppHome } from "../../src/upgrade/coexistenceProbe.js";
import { buildDoctorStatus } from "../../src/upgrade/doctor.js";
import { setSuccessorAnnouncedOverrideForTests } from "../../src/upgrade/nextMajorDoctor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-evidence-"));
  setSuccessorAnnouncedOverrideForTests(true);
});
afterEach(() => {
  setSuccessorAnnouncedOverrideForTests(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface ManagedInstallOpts {
  script?: string | null;
  skill?: boolean;
  marker?: boolean;
  unreadableScript?: boolean;
}

function writeBundle(bundleRoot: string, opts: ManagedInstallOpts = {}): void {
  const scriptsDir = path.join(bundleRoot, "scripts");
  fs.mkdirSync(scriptsDir, { recursive: true });
  if (opts.script !== null && opts.script !== undefined) {
    const scriptPath = path.join(scriptsDir, "agentera");
    fs.writeFileSync(scriptPath, opts.script);
    if (opts.unreadableScript) {
      fs.chmodSync(scriptPath, 0o000);
    }
  }
  if (opts.skill !== false) {
    fs.mkdirSync(path.join(bundleRoot, "skills", "agentera"), { recursive: true });
    fs.writeFileSync(path.join(bundleRoot, "skills", "agentera", "SKILL.md"), "x");
  }
  if (opts.marker) {
    fs.writeFileSync(
      path.join(bundleRoot, ".agentera-bundle.json"),
      JSON.stringify({ schemaVersion: "agentera.bundle.v1", version: "v9" }),
    );
  }
}

function chmodBack(bundleRoot: string): void {
  const scriptPath = path.join(bundleRoot, "scripts", "agentera");
  if (fs.existsSync(scriptPath)) {
    try {
      fs.chmodSync(scriptPath, 0o644);
    } catch {}
  }
}

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

describe("hasBundleRootEvidence (shared module)", () => {
  it("returns true when scripts/agentera, skills/agentera/SKILL.md, and a readable shebang are present", () => {
    const bundleRoot = path.join(tmp, "healthy-bundle");
    writeBundle(bundleRoot, {
      script: "#!/usr/bin/env node\nconsole.log('hi');\n",
      skill: true,
      marker: true,
    });
    expect(hasBundleRootEvidence(bundleRoot)).toBe(true);
  });

  it("returns false when scripts/agentera is missing even if SKILL.md is present", () => {
    const bundleRoot = path.join(tmp, "no-script");
    writeBundle(bundleRoot, { script: null, skill: true });
    expect(hasBundleRootEvidence(bundleRoot)).toBe(false);
  });

  it("returns false when skills/agentera/SKILL.md is missing even if scripts/agentera is present", () => {
    const bundleRoot = path.join(tmp, "no-skill");
    writeBundle(bundleRoot, {
      script: "#!/usr/bin/env node\n",
      skill: false,
    });
    expect(hasBundleRootEvidence(bundleRoot)).toBe(false);
  });

  it("returns false when the script shebang is unreadable (post-Task-4 stricter check)", () => {
    const bundleRoot = path.join(tmp, "unreadable");
    writeBundle(bundleRoot, {
      script: "#!/usr/bin/env node\n",
      skill: true,
      marker: true,
      unreadableScript: true,
    });
    try {
      expect(readScriptHead(path.join(bundleRoot, "scripts", "agentera"))).toBeNull();
      expect(hasBundleRootEvidence(bundleRoot)).toBe(false);
    } finally {
      chmodBack(bundleRoot);
    }
  });
});

describe("hasBundleRootEvidence — uniform application across the 4 call sites", () => {
  it("treats a healthy managed install as bundle evidence in doctor, compatibility, appModel, and coexistenceProbe", () => {
    const bundleRoot = path.join(tmp, "healthy-all-sites");
    writeBundle(bundleRoot, {
      script: "#!/usr/bin/env node\n",
      skill: true,
      marker: true,
    });

    expect(hasBundleRootEvidence(bundleRoot)).toBe(true);

    const appHome = path.join(tmp, "app-home");
    fs.mkdirSync(path.join(appHome, "app"), { recursive: true });
    fs.cpSync(
      path.join(bundleRoot, "scripts"),
      path.join(appHome, "app", "scripts"),
      { recursive: true },
    );
    fs.cpSync(
      path.join(bundleRoot, "skills"),
      path.join(appHome, "app", "skills"),
      { recursive: true },
    );
    if (fs.existsSync(path.join(bundleRoot, ".agentera-bundle.json"))) {
      fs.copyFileSync(
        path.join(bundleRoot, ".agentera-bundle.json"),
        path.join(appHome, "app", ".agentera-bundle.json"),
      );
    }

    const roots = doctorRoots(appHome);
    expect(hasBundleRootEvidence(roots.activeBundleRoot)).toBe(true);

    const install = classifyInstall({ appHome, sourceRoot: REPO_ROOT });
    expect(install.kind).toBe("v2_managed_app_home");

    expect(isV2ManagedInstallAtAppHome(appHome)).toBe(true);

    const doctorStatus = buildDoctorStatus(appHome, {
      rootSource: "explicit --install-root",
      sourceRoot: REPO_ROOT,
      home: "/tmp/bundle-evidence-home",
      project: "/tmp/bundle-evidence-proj",
      expectedVersion: "v9",
      probeCli: false,
    });
    expect(doctorStatus.signals.some((s: { kind?: string }) => s.kind === "missing_bundle")).toBe(false);
  });

  it("treats an unreadable managed script as no bundle evidence in all 4 call sites (post-Task-4 stricter check, applied uniformly)", () => {
    const appHome = path.join(tmp, "unreadable-app-home");
    writeBundle(path.join(appHome, "app"), {
      script: "#!/usr/bin/env node\n",
      skill: true,
      marker: true,
    });

    try {
      fs.chmodSync(path.join(appHome, "app", "scripts", "agentera"), 0o000);

      expect(hasBundleRootEvidence(path.join(appHome, "app"))).toBe(false);

      const roots = doctorRoots(appHome);
      expect(hasBundleRootEvidence(roots.activeBundleRoot)).toBe(false);

      const install = classifyInstall({ appHome, sourceRoot: REPO_ROOT });
      expect(install.kind).not.toBe("v2_managed_app_home");

      expect(isV2ManagedInstallAtAppHome(appHome)).toBe(false);

      const doctorStatus = buildDoctorStatus(appHome, {
        rootSource: "explicit --install-root",
        sourceRoot: REPO_ROOT,
        home: "/tmp/bundle-evidence-home",
        project: "/tmp/bundle-evidence-proj",
        expectedVersion: "v9",
        probeCli: false,
      });
      expect(doctorStatus.status).not.toBe("up_to_date");
    } finally {
      chmodBack(path.join(appHome, "app"));
    }
  });
});

describe("hasBundleRootEvidence refactor surface (acceptance criterion 4)", () => {
  it("defines hasBundleRootEvidence exactly once and imports it from each of the 4 call sites", () => {
    const definitions: string[] = [];
    const stack = [path.join(REPO_ROOT, "packages/cli/src/upgrade")];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.name.endsWith(".ts")) {
          const text = fs.readFileSync(full, "utf8");
          for (const line of text.split("\n")) {
            if (/^\s*(export\s+)?function\s+hasBundleRootEvidence\b/.test(line)) {
              definitions.push(full);
            }
          }
        }
      }
    }

    expect(definitions).toEqual([
      path.join(REPO_ROOT, "packages/cli/src/upgrade/bundleEvidence.ts"),
    ]);

    for (const relativePath of [
      "packages/cli/src/upgrade/doctor.ts",
      "packages/cli/src/upgrade/compatibility.ts",
      "packages/cli/src/upgrade/appModel.ts",
      "packages/cli/src/upgrade/coexistenceProbe.ts",
    ]) {
      const source = readSource(relativePath);
      expect(source).toMatch(
        /import\s*\{[^}]*\bhasBundleRootEvidence\b[^}]*\}\s*from\s*["']\.\/bundleEvidence\.js["']/,
      );
    }

    expect(readSource("packages/cli/src/upgrade/bundleEvidence.ts")).toMatch(
      /export\s+function\s+hasBundleRootEvidence/,
    );
  });
});
