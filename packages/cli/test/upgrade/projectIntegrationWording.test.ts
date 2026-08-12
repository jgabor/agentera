import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { APP_OUTDATED, APP_REPAIR_NEEDED, APP_UP_TO_DATE } from "../../src/upgrade/doctor.js";
import { summarizeProjectIntegration } from "../../src/upgrade/projectIntegration.js";
import { NPX_BUNDLE_SENTINEL } from "../../src/core/sourceRoot.js";
import { detectV1ArtifactPairs } from "../../src/upgrade/migrateArtifactsV2ToV3.js";
import { resolveInvokedUpdateChannel } from "../../src/upgrade/channels.js";
import { classifyInstall } from "../../src/upgrade/compatibility.js";
import { isStableSuccessorAnnounced } from "../../src/upgrade/nextMajorDoctor.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/v2-runtime-cursor-full/project/.cursor/hooks.json",
);

let tmp: string;

function platformDefaultAppHome(home: string): string {
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "agentera");
  }
  if (process.platform === "win32") {
    return path.join(home, "AppData", "Roaming", "agentera");
  }
  return path.join(home, ".local", "share", "agentera");
}

function seedNpxBundle(root: string): void {
  fs.mkdirSync(path.join(root, "skills", "agentera"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", "agentera", "SKILL.md"), "# Agentera\n");
  fs.writeFileSync(path.join(root, "registry.json"), JSON.stringify({ skills: [{ version: "3.0.0-next.1" }] }));
  fs.writeFileSync(
    path.join(root, NPX_BUNDLE_SENTINEL),
    JSON.stringify({ kind: "agentera-npx-bundle", suiteVersion: "3.0.0-next.1" }),
  );
  fs.cpSync(path.join(REPO_ROOT, "references"), path.join(root, "references"), { recursive: true });
}

function managedPlatformAppHome(appHome: string, marker: string | null): void {
  const app = path.join(appHome, "app");
  fs.mkdirSync(path.join(app, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(app, "scripts", "agentera"), "#!/usr/bin/env python3\nsub.add_parser('hej')\n");
  fs.mkdirSync(path.join(app, "skills", "agentera"), { recursive: true });
  fs.writeFileSync(path.join(app, "skills", "agentera", "SKILL.md"), "x");
  fs.writeFileSync(
    path.join(app, "registry.json"),
    JSON.stringify({ skills: [{ name: "agentera", version: "current" }] }),
  );
  if (marker !== null) {
    fs.writeFileSync(
      path.join(app, ".agentera-bundle.json"),
      JSON.stringify({ schemaVersion: "agentera.bundle.v1", version: marker }),
    );
  }
}

function baseArgs(project: string, overrides: Record<string, unknown> = {}) {
  return {
    project,
    sourceRoot: REPO_ROOT,
    home: path.join(tmp, "home"),
    env: {},
    installRoot: path.join(tmp, "app-home"),
    bundleStatus: APP_OUTDATED,
    crossMajorBoundary: false,
    ...overrides,
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "proj-int-word-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("summarizeProjectIntegration wording", () => {
  it("uses update language when only the app bundle is outdated", () => {
    const project = path.join(tmp, "project");
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(path.join(tmp, "app-home"), { recursive: true });

    const summary = summarizeProjectIntegration(baseArgs(project));

    expect(summary.recommendation).toBe("upgrade");
    expect(summary.message).toContain("app bundle needs update");
    expect(summary.message).toContain("Preview");
  });

  it("uses repair language when the app bundle needs repair", () => {
    const project = path.join(tmp, "project-repair");
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(path.join(tmp, "broken-home"), { recursive: true });

    const summary = summarizeProjectIntegration(
      baseArgs(project, {
        installRoot: path.join(tmp, "broken-home"),
        bundleStatus: APP_REPAIR_NEEDED,
      }),
    );

    expect(summary.recommendation).toBe("upgrade");
    expect(summary.message).toContain("app bundle needs update");
    expect(summary.message).toContain("Preview");
  });

  it("recommends upgrade for v1 Markdown project", () => {
    const project = path.join(tmp, "v1-project");
    fs.mkdirSync(path.join(project, ".agentera"), { recursive: true });
    fs.writeFileSync(
      path.join(project, ".agentera", "PROGRESS.md"),
      "# Progress\n\n## Cycle 1 · 2026-01-01 00:00 · feat\n\n**What**: fixture\n",
    );
    fs.mkdirSync(path.join(tmp, "app-home"), { recursive: true });

    const summary = summarizeProjectIntegration(
      baseArgs(project, {
        bundleStatus: "up_to_date",
        crossMajorBoundary: false,
      }),
    );

    expect(summary.recommendation).toBe("upgrade");
    expect(summary.message).toContain("project state needs migration");
    expect(summary.dry_run_command).toContain("upgrade");
  });

  it("recommends upgrade for python-managed project hooks", () => {
    const project = path.join(tmp, "runtime-project");
    fs.mkdirSync(path.join(project, ".cursor"), { recursive: true });
    fs.copyFileSync(FIXTURES, path.join(project, ".cursor", "hooks.json"));
    fs.mkdirSync(path.join(tmp, "app-home"), { recursive: true });

    const summary = summarizeProjectIntegration(
      baseArgs(project, {
        bundleStatus: "up_to_date",
        crossMajorBoundary: false,
      }),
    );

    expect(summary.recommendation).toBe("upgrade");
    expect(summary.message).toContain("project state needs migration");
    expect(summary.pending_artifacts).toBeGreaterThan(0);
    expect(summary.dry_run_command).not.toContain("--runtime");
  });

  it("recommends app upgrade when npx bundle is current but platform app home is outdated", () => {
    const bundle = path.join(tmp, "npx-bundle");
    seedNpxBundle(bundle);

    const userHome = path.join(tmp, "user-home");
    fs.mkdirSync(userHome, { recursive: true });
    const platformHome = platformDefaultAppHome(userHome);
    fs.mkdirSync(path.dirname(platformHome), { recursive: true });
    managedPlatformAppHome(platformHome, "v1");

    const project = path.join(tmp, "npx-platform-stale");
    fs.mkdirSync(project, { recursive: true });

    const summary = summarizeProjectIntegration({
      project,
      sourceRoot: bundle,
      home: userHome,
      env: { XDG_DATA_HOME: path.join(userHome, ".local", "share") },
      installRoot: bundle,
      bundleStatus: APP_UP_TO_DATE,
      crossMajorBoundary: false,
    });

    expect(summary.recommendation).toBe("upgrade");
    expect(summary.message).toContain("app bundle needs update");
    expect(summary.dry_run_command).toContain("upgrade");
  });

  it("does not displace npx routing for an absent optional XDG platform app", () => {
    const bundle = path.join(tmp, "npx-bundle");
    seedNpxBundle(bundle);
    const userHome = path.join(tmp, "user-home");
    const xdgData = path.join(tmp, "isolated-xdg-data");
    fs.mkdirSync(userHome, { recursive: true });
    const project = path.join(tmp, "npx-platform-missing");
    fs.mkdirSync(project, { recursive: true });

    const summary = summarizeProjectIntegration({
      project,
      sourceRoot: bundle,
      home: userHome,
      env: { XDG_DATA_HOME: xdgData },
      installRoot: bundle,
      bundleStatus: APP_UP_TO_DATE,
      crossMajorBoundary: false,
    });

    expect(summary).toMatchObject({
      recommendation: "stay",
      aggregate_status: "stay",
      pending_artifacts: 0,
      phases: { app: { counts: { blocked: 0 }, blockers: [] } },
    });
    expect(summary.message).toContain("No app or project-state upgrade is required");
    expect(summary.message).not.toContain("manual review");
  });

  it("uses cross-major narrative when boundary is announced", () => {
    const authorityRoot = path.join(tmp, "announced");
    fs.mkdirSync(path.join(authorityRoot, ".git"), { recursive: true });
    fs.mkdirSync(path.join(authorityRoot, "skills", "agentera"), { recursive: true });
    fs.writeFileSync(path.join(authorityRoot, "skills", "agentera", "SKILL.md"), "x");
    fs.copyFileSync(path.join(REPO_ROOT, "registry.json"), path.join(authorityRoot, "registry.json"));
    fs.cpSync(path.join(REPO_ROOT, "references"), path.join(authorityRoot, "references"), { recursive: true });
    fs.writeFileSync(path.join(authorityRoot, "references/cli/update-channels.yaml"),
      fs.readFileSync(path.join(REPO_ROOT, "references/cli/update-channels.yaml"), "utf8").replace("announced: false", "announced: true"),
    );

    const project = path.join(tmp, "cross-major");
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(path.join(tmp, "app-home"), { recursive: true });
    managedPlatformAppHome(path.join(tmp, "app-home"), "2.7.7");

    const summary = summarizeProjectIntegration(
      baseArgs(project, {
        sourceRoot: authorityRoot,
        bundleStatus: "up_to_date",
        crossMajorBoundary: true,
        crossMajorBoundaryDetected: true,
      }),
    );

    expect(summary.recommendation).toBe("upgrade");
    expect(summary.message).toContain("cross-major");
    expect(summary.message).toContain("Preview");
  });

  it("keeps clean integration at stay with a zero exit meaning", () => {
    const project = path.join(tmp, "clean");
    fs.mkdirSync(project, { recursive: true });

    const summary = summarizeProjectIntegration(
      baseArgs(project, {
        bundleStatus: APP_UP_TO_DATE,
      }),
    );

    expect(summary.recommendation).toBe("stay");
    expect(summary.aggregate_status).toBe("stay");
    expect(summary.exit).toEqual({ code: 0, meaning: "no_changes_needed" });
    expect(summary.retry.guidance).toContain("No retry");
  });

  it("reuses an enclosing V1 scan and selected channel without changing output", () => {
    const project = path.join(tmp, "precomputed-v1");
    fs.mkdirSync(path.join(project, ".agentera"), { recursive: true });
    fs.writeFileSync(path.join(project, ".agentera/PLAN.md"), "# Legacy plan\n");
    const args = baseArgs(project, { bundleStatus: APP_UP_TO_DATE });
    const detected = detectV1ArtifactPairs(project);

    const standalone = summarizeProjectIntegration(args);
    const resolvedChannel = resolveInvokedUpdateChannel({
      channel: standalone.update_channel,
      env: args.env,
      home: args.home,
      sourceRoot: args.sourceRoot,
    });
    const reused = summarizeProjectIntegration({
      ...args,
      channel: standalone.update_channel,
      resolvedChannel,
      installClassification: classifyInstall({ appHome: args.installRoot, sourceRoot: args.sourceRoot }),
      successorAnnounced: isStableSuccessorAnnounced(args.sourceRoot, "stable"),
      precomputedV1Artifacts: detected,
    });

    expect(detected).toEqual([".agentera/PLAN.md"]);
    expect(reused).toEqual(standalone);
    expect(summarizeProjectIntegration({
      ...args,
      channel: standalone.update_channel,
      precomputedV1Artifacts: [],
    }).pending_artifacts).toBe(standalone.pending_artifacts - 1);
  });

});
