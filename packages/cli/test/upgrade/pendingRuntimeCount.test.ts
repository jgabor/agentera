import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MigrationPhaseItem } from "../../src/upgrade/migrateArtifactsV2ToV3.js";
import * as migrate from "../../src/upgrade/migrateArtifactsV2ToV3.js";
import { APP_UP_TO_DATE } from "../../src/upgrade/doctor.js";
import { summarizeProjectIntegration } from "../../src/upgrade/projectIntegration.js";
import type { RuntimeLifecycleSnapshot } from "../../src/runtime/lifecycleSnapshot.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

let tmp: string;

function retireHooksItem(runtime: string, source: string, index: number): MigrationPhaseItem {
  return {
    status: "pending",
    action: "retire-hooks",
    message: `fixture ${runtime} ${index}`,
    runtime,
    source,
  };
}

function fourItemsForRuntimes(runtimes: readonly string[]): MigrationPhaseItem[] {
  const homeSource = path.join(tmp, "home", "hooks.json");
  if (runtimes.length === 1) {
    return [0, 1, 2, 3].map((index) => retireHooksItem(runtimes[0], homeSource, index));
  }
  return [
    retireHooksItem(runtimes[0], homeSource, 0),
    retireHooksItem(runtimes[0], homeSource, 1),
    retireHooksItem(runtimes[1], homeSource, 2),
    retireHooksItem(runtimes[1], homeSource, 3),
  ];
}

function mockRuntimePhase(items: MigrationPhaseItem[]): void {
  vi.spyOn(migrate, "planRuntimeRewirePhase").mockReturnValue({
    name: "runtime",
    status: "pending",
    summary: {
      pending: items.length,
      applied: 0,
      noop: 0,
      blocked: 0,
      failed: 0,
    },
    items,
  });
}

function emptyLifecycleSnapshot(): RuntimeLifecycleSnapshot {
  return {
    schemaVersion: "agentera.runtimeLifecycleSnapshot.v1",
    projectionVersion: "agentera.runtimeLifecycleProjection.v1",
    snapshotId: "sha256:empty-pending-runtime-fixture",
    statusVocabularyVersion: "agentera.runtimeLifecycleStatus.v1",
    authority: "fixture",
    activeRuntimeIds: ["opencode", "codex", "cursor", "copilot"],
    selection: { runtimeIds: ["opencode", "codex", "cursor", "copilot"] },
    releaseBlocked: false,
    sharedResources: [],
    actions: [],
    counts: { total: 0, repairableOwned: 0, manualVerification: 0, unobservableGap: 0, commandEligible: 0 },
    runtimes: [],
  };
}

function summarizeWithPendingItems(
  pending: MigrationPhaseItem[],
  projectDir = path.join(tmp, "project"),
): ReturnType<typeof summarizeProjectIntegration> {
  const home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(home, "agentera"), { recursive: true });
  fs.writeFileSync(path.join(home, "hooks.json"), "{}");
  mockRuntimePhase(pending);
  const actions = pending.map((item, index) => ({
    id: `operation:fixture-${index}`,
    runtimeIds: item.runtime ? [item.runtime] : [],
    surfaceId: "cli",
    category: "hooks" as const,
    resourceId: "fixture",
    destination: item.target ?? path.join(home, `fixture-${index}`),
    applicability: "required" as const,
    ownership: "managed" as const,
    actionClass: "repairable_owned" as const,
    required: true,
    reason: item.message,
    operation: "update" as const,
    commandEligibility: { preview: true, apply: true, manual: false, diagnostic: false },
    manual: null,
  }));
  const lifecycleSnapshot = {
    schemaVersion: "agentera.runtimeLifecycleSnapshot.v1" as const,
    projectionVersion: "agentera.runtimeLifecycleProjection.v1" as const,
    snapshotId: "sha256:pending-runtime-fixture",
    statusVocabularyVersion: "agentera.runtimeLifecycleStatus.v1" as const,
    authority: "fixture",
    activeRuntimeIds: ["opencode", "codex", "cursor", "copilot"],
    selection: { runtimeIds: ["opencode", "codex", "cursor", "copilot"] },
    releaseBlocked: false,
    sharedResources: [],
    actions,
    counts: {
      total: actions.length,
      repairableOwned: actions.length,
      manualVerification: 0,
      unobservableGap: 0,
      commandEligible: actions.length,
    },
    runtimes: [],
  } as unknown as RuntimeLifecycleSnapshot;
  return summarizeProjectIntegration({
    project: projectDir,
    sourceRoot: REPO_ROOT,
    home,
    env: { HOME: home },
    installRoot: path.join(home, "agentera"),
    bundleStatus: APP_UP_TO_DATE,
    crossMajorBoundary: false,
    lifecycleSnapshot,
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pending-runtime-count-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("pending_runtime counts runtimes not migration items (#40)", () => {
  it.each([
    {
      label: "4 items / 1 runtime",
      runtimes: ["opencode"] as const,
      expectedRuntimeCount: 1,
    },
    {
      label: "4 items / 2 runtimes",
      runtimes: ["opencode", "cursor"] as const,
      expectedRuntimeCount: 2,
    },
  ])("$label: pending_runtime matches pending_runtimes length (V5 pass)", ({ runtimes, expectedRuntimeCount }) => {
    const pending = fourItemsForRuntimes(runtimes);
    const summary = summarizeWithPendingItems(pending);

    expect(summary.recommendation).toBe("upgrade");
    expect(pending).toHaveLength(4);
    expect(summary.pending_runtime).toBe(expectedRuntimeCount);
    expect(summary.pending_runtimes).toEqual([...runtimes].sort());
    expect(summary.pending_runtime).toBe(summary.pending_runtimes.length);
  });

  it.each([
    {
      label: "4 items / 1 runtime",
      runtimes: ["opencode"] as const,
      wrongItemCount: 4,
    },
    {
      label: "4 items / 2 runtimes",
      runtimes: ["opencode", "cursor"] as const,
      wrongItemCount: 4,
    },
  ])("$label: pending_runtime is not the migration item count (V5 fail)", ({ runtimes, wrongItemCount }) => {
    const pending = fourItemsForRuntimes(runtimes);
    const summary = summarizeWithPendingItems(pending);

    expect(summary.pending_runtime).not.toBe(wrongItemCount);
    expect(summary.pending_runtime).toBeLessThan(wrongItemCount);
  });

  it("0 items: pending_runtime is 0 (V5 pass)", () => {
    const home = path.join(tmp, "home-empty");
    const project = path.join(tmp, "empty-project");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(path.join(home, "agentera"), { recursive: true });

    const summary = summarizeProjectIntegration({
      project,
      sourceRoot: REPO_ROOT,
      home,
      env: { HOME: home },
      installRoot: path.join(home, "agentera"),
      bundleStatus: APP_UP_TO_DATE,
      crossMajorBoundary: false,
      lifecycleSnapshot: emptyLifecycleSnapshot(),
    });

    expect(summary.recommendation).toBe("stay");
    expect(summary.pending_runtime).toBe(0);
    expect(summary.pending_runtimes).toEqual([]);
  });

  it("0 items: pending_runtime is not confused with a nonzero item count (V5 fail)", () => {
    const home = path.join(tmp, "home-empty-fail");
    const project = path.join(tmp, "empty-project-fail");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(path.join(home, "agentera"), { recursive: true });

    const summary = summarizeProjectIntegration({
      project,
      sourceRoot: REPO_ROOT,
      home,
      env: { HOME: home },
      installRoot: path.join(home, "agentera"),
      bundleStatus: APP_UP_TO_DATE,
      crossMajorBoundary: false,
      lifecycleSnapshot: emptyLifecycleSnapshot(),
    });

    expect(summary.pending_runtime).not.toBeGreaterThan(0);
    expect(summary.pending_runtimes).toHaveLength(0);
  });
});
