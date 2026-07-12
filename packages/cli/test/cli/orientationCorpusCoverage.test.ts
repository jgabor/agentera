import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildOrientationAttention } from "../../src/cli/orientation/attention.js";
import {
  corpusCoverageAttention,
  corpusCoverageSummary,
} from "../../src/cli/orientation/corpusCoverage.js";
import type { OrientationState } from "../../src/cli/contracts/orientationState.js";
import { projectIntegrationAttention } from "../../src/upgrade/projectIntegration.js";
import type {
  LifecycleProjectedAction,
  RuntimeLifecycleSnapshot,
} from "../../src/runtime/lifecycleSnapshot.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const V2_APP_HOME_FIXTURE = path.join(__dirname, "../upgrade/fixtures/v2-app-home");

let tmp: string;

function minimalOrientationState(corpusCoverage: OrientationState["corpus_coverage"]): OrientationState {
  return {
    schemas_dir: "",
    schemas: {},
    app: { status: "ok", appHome: "/tmp", appHomeSource: "test", managedAppRoot: "/tmp", userDataRoot: "/tmp" },
    mode: "returning",
    profile_dict: { status: "loaded", path: "/tmp/PROFILE.md" },
    profile_status: "loaded",
    profile: "/tmp/PROFILE.md",
    v1_migration: {
      detected: false,
      affected_files: [],
      dry_run_command: null,
      apply_command: null,
      requires_confirmation: false,
      update_channel: "next",
    },
    project_integration: {
      recommendation: "none",
      message: "",
      pending_artifacts: 0,
      pending_runtime: 0,
      upgrade_only: false,
    },
    plan: { exists: false, status: "absent" },
    docs: { exists: false, status: "absent" },
    progress: { exists: false },
    health: { exists: false },
    objective: { exists: false },
    state_presence: {
      active: {},
      available: {},
      any_active: false,
      absence_explained: true,
      absence: {},
    },
    corpus_coverage: corpusCoverage,
    todo_items: [],
    counts: { critical: 0, degraded: 0, normal: 0, annoying: 0 },
    decision_attention: null,
    next_action: {
      recommended: { object: "none", capability: "status", reason: "none", phase: "audit" },
      alternatives: [],
    },
    attention: [],
  };
}

function lifecycleAction(
  actionClass: LifecycleProjectedAction["actionClass"],
  runtimeIds: string[],
  instruction?: string,
): LifecycleProjectedAction {
  return {
    id: `${actionClass}:${runtimeIds.join(",")}`,
    runtimeIds,
    surfaceId: "cli",
    category: "skills",
    resourceId: "canonical_skill",
    destination: "/tmp/agentera",
    applicability: "required",
    ownership: actionClass === "repairable_owned" ? "claimable" : "user_owned",
    actionClass,
    required: true,
    reason: instruction ?? `${actionClass} fixture`,
    operation: actionClass === "repairable_owned" ? "create" : null,
    commandEligibility: {
      preview: actionClass === "repairable_owned",
      apply: actionClass === "repairable_owned",
      manual: actionClass === "manual_verification",
      diagnostic: actionClass === "unobservable_gap",
    },
    manual:
      actionClass === "manual_verification"
        ? { command: "/skills list", instruction: instruction ?? "Run `/skills list` in the host." }
        : null,
  };
}

function lifecycleSnapshot(actions: LifecycleProjectedAction[]): RuntimeLifecycleSnapshot {
  const runtimes = ["opencode", "codex", "cursor", "copilot"].map((runtimeId) => ({
    runtimeId,
    displayName: runtimeId,
    status: "blocked" as const,
    readiness: "blocked" as const,
    canonicalSkill: { path: "/tmp/agentera", detected: true as const },
    diagnosisComplete: true,
    supportFloor: { met: false, releaseBlocking: true, unmet: [], violations: [] },
    surfaces: [],
    blockers: [],
    counts: {
      total: actions.filter((action) => action.runtimeIds.includes(runtimeId)).length,
      repairableOwned: 0,
      manualVerification: 0,
      unobservableGap: 0,
      commandEligible: 0,
    },
    actionCount: actions.filter((action) => action.runtimeIds.includes(runtimeId)).length,
  }));
  return {
    schemaVersion: "agentera.runtimeLifecycleSnapshot.v1",
    projectionVersion: "agentera.runtimeLifecycleProjection.v1",
    snapshotId: "sha256:orientation-fixture",
    statusVocabularyVersion: "agentera.runtimeLifecycleStatus.v1",
    authority: "fixture",
    activeRuntimeIds: runtimes.map((runtime) => runtime.runtimeId),
    selection: { runtimeIds: runtimes.map((runtime) => runtime.runtimeId) },
    releaseBlocked: true,
    sharedResources: [],
    actions,
    counts: {
      total: actions.length,
      repairableOwned: actions.filter((action) => action.actionClass === "repairable_owned").length,
      manualVerification: actions.filter((action) => action.actionClass === "manual_verification").length,
      unobservableGap: actions.filter((action) => action.actionClass === "unobservable_gap").length,
      commandEligible: actions.length,
    },
    runtimes,
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-attn-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("corpus coverage attention", () => {
  it("builds flagged attention when available_but_not_selected is non-empty", () => {
    const attention = corpusCoverageAttention({
      path: path.join(tmp, "corpus.json"),
      status: "loaded",
      available_runtimes: ["opencode", "codex"],
      selected_runtimes: ["codex"],
      available_but_not_selected: [{ runtime: "opencode", reason: "disabled_by_flag", store_path: "/tmp/opencode.db" }],
    });
    expect(attention).toContain("flagged:");
    expect(attention).toContain("EX2");
    expect(attention).toContain("opencode (disabled_by_flag)");
  });

  it("returns null attention when coverage gap is empty", () => {
    expect(
      corpusCoverageAttention({
        path: path.join(tmp, "corpus.json"),
        status: "loaded",
        available_runtimes: ["opencode"],
        selected_runtimes: ["opencode"],
        available_but_not_selected: [],
      }),
    ).toBeNull();
  });

  it("loads coverage metadata from corpus envelope", () => {
    const profileDir = path.join(tmp, "profile");
    const corpusPath = path.join(profileDir, "intermediate", "corpus.json");
    fs.mkdirSync(path.dirname(corpusPath), { recursive: true });
    fs.writeFileSync(
      corpusPath,
      JSON.stringify({
        metadata: {
          available_runtimes: ["opencode"],
          selected_runtimes: [],
          available_but_not_selected: [{ runtime: "opencode", reason: "disabled_by_flag", store_path: "/tmp/opencode.db" }],
        },
        records: [],
      }),
    );
    const summary = corpusCoverageSummary({ AGENTERA_PROFILE_DIR: profileDir }, "linux");
    expect(summary.status).toBe("loaded");
    expect(summary.available_but_not_selected).toEqual([
      { runtime: "opencode", reason: "disabled_by_flag", store_path: "/tmp/opencode.db" },
    ]);
  });

  it("includes coverage-loss item in orientation attention", () => {
    const attention = buildOrientationAttention(
      minimalOrientationState({
        path: path.join(tmp, "corpus.json"),
        status: "loaded",
        available_runtimes: ["codex"],
        selected_runtimes: [],
        available_but_not_selected: [{ runtime: "codex", reason: "disabled_by_flag" }],
      }),
    );
    expect(attention.some((item) => item.includes("corpus coverage loss (EX2)"))).toBe(true);
  });
});

describe("coexistence attention", () => {
  it("includes a coexistence warning when a v2 managed app is staged at the app home", () => {
    const appHome = path.join(tmp, "v2-app-home");
    fs.cpSync(V2_APP_HOME_FIXTURE, appHome, { recursive: true });
    const state = minimalOrientationState({
      path: "",
      status: "missing",
      available_runtimes: [],
      selected_runtimes: [],
      available_but_not_selected: [],
    });
    state.app.appHome = appHome;
    const attention = buildOrientationAttention(state);
    expect(attention.some((item) => item.includes("v2/v3 coexistence") && item.includes("pick one line"))).toBe(true);
  });

  it("does not include a coexistence warning when no v2 install is present", () => {
    const state = minimalOrientationState({
      path: "",
      status: "missing",
      available_runtimes: [],
      selected_runtimes: [],
      available_but_not_selected: [],
    });
    state.app.appHome = path.join(tmp, "clean-app-home");
    const attention = buildOrientationAttention(state);
    expect(attention.some((item) => item.includes("v2/v3 coexistence"))).toBe(false);
  });
});

describe("lifecycle attention", () => {
  it("keeps executable and blocker lifecycle rows bounded and truthful", () => {
    const state = minimalOrientationState({
      path: "",
      status: "missing",
      available_runtimes: [],
      selected_runtimes: [],
      available_but_not_selected: [],
    });
    state.project_integration = {
      ...state.project_integration,
      recommendation: "upgrade",
      message: "This project needs an Agentera upgrade (runtime wiring needs sync). Preview the upgrade command.",
      pending_runtime: 1,
      pending_artifacts: 0,
      aggregate_status: "upgrade",
      dry_run_command: "npx -y agentera@next upgrade --dry-run --runtime codex",
    } as typeof state.project_integration;
    state.runtime_lifecycle_snapshot = lifecycleSnapshot([
      lifecycleAction("repairable_owned", ["codex"]),
      lifecycleAction("manual_verification", ["opencode", "codex", "cursor", "copilot"], "Run `/skills list` in the host."),
      lifecycleAction("unobservable_gap", ["cursor"], "No verified safe remediation is declared."),
    ]);

    const integrationRow = projectIntegrationAttention(state.project_integration);
    const lifecyclePresentation = buildOrientationAttention(state).filter(
      (item) => item === integrationRow || item.includes("lifecycle action_class="),
    );

    expect(lifecyclePresentation).toHaveLength(2);
    expect(lifecyclePresentation.filter((item) => item.includes("lifecycle action_class="))).toHaveLength(2);
    expect(lifecyclePresentation).not.toContain(integrationRow);
    expect(lifecyclePresentation[0]).toContain("action_class=repairable_owned");
    expect(lifecyclePresentation[0]).toContain("preview=`npx -y agentera@next upgrade --dry-run --runtime codex`");
    expect(lifecyclePresentation[1]).toContain("action_class=manual_verification+unobservable_gap");
    expect(lifecyclePresentation[1]).toContain("+1 more runtimes");
    expect(lifecyclePresentation[1]).toContain("procedure=/skills list: Run `/skills list` in the host.");
    expect(lifecyclePresentation[1]).toContain("doctor=`agentera doctor --format json`");
    expect(lifecyclePresentation.join("\n")).not.toContain("--yes");
    expect(lifecyclePresentation.join(" ").split(/\s+/).length).toBeLessThanOrEqual(120);
  });

  it("does not duplicate generic integration guidance for blocker-only lifecycle work", () => {
    const state = minimalOrientationState({
      path: "",
      status: "missing",
      available_runtimes: [],
      selected_runtimes: [],
      available_but_not_selected: [],
    });
    state.project_integration = {
      ...state.project_integration,
      recommendation: "upgrade",
      message: "This project needs an Agentera upgrade because lifecycle blockers need review.",
      pending_runtime: 0,
      pending_artifacts: 0,
      aggregate_status: "blocked",
      dry_run_command: null,
      phases: {
        app: { status: "stay", counts: { total: 0, pending: 0, blocked: 0 }, blockers: [] },
        lifecycle: {
          status: "blocked",
          counts: { total: 2, pending: 0, blocked: 2 },
          blockers: ["manual_verification: host action", "unobservable_gap: no safe probe"],
        },
      },
    } as typeof state.project_integration;
    state.runtime_lifecycle_snapshot = lifecycleSnapshot([
      lifecycleAction("manual_verification", ["copilot"], "Run `/skills list` in the host."),
      lifecycleAction("unobservable_gap", ["cursor"], "No verified safe remediation is declared."),
    ]);

    const integrationRow = projectIntegrationAttention(state.project_integration);
    const attention = buildOrientationAttention(state);
    const lifecyclePresentation = attention.filter(
      (item) => item === integrationRow || item.includes("lifecycle action_class="),
    );

    expect(lifecyclePresentation).toHaveLength(1);
    expect(lifecyclePresentation[0]).not.toBe(integrationRow);
    expect(lifecyclePresentation[0]).toContain("action_class=manual_verification+unobservable_gap");
    expect(lifecyclePresentation[0]).toContain("procedure=/skills list: Run `/skills list` in the host.");
    expect(lifecyclePresentation[0]).toContain("doctor=`agentera doctor --format json`");
    expect(lifecyclePresentation[0]).not.toContain("--yes");
  });

  it("bounds long manual guidance while preserving the exact host command", () => {
    const state = minimalOrientationState({
      path: "",
      status: "missing",
      available_runtimes: [],
      selected_runtimes: [],
      available_but_not_selected: [],
    });
    const longInstruction = Array.from({ length: 200 }, (_, index) => `instruction-${index}`).join(" ");
    state.runtime_lifecycle_snapshot = lifecycleSnapshot([
      lifecycleAction("manual_verification", ["copilot"], longInstruction),
    ]);

    const row = buildOrientationAttention(state).find((item) => item.includes("lifecycle action_class="));

    expect(row).toBeTruthy();
    expect(row).toContain("procedure=/skills list:");
    expect(row).toContain("instruction-10…");
    expect(row?.split(/\s+/).length ?? 0).toBeLessThan(120);
  });

  it("bounds fallback manual reasons when procedure metadata is absent", () => {
    const state = minimalOrientationState({
      path: "",
      status: "missing",
      available_runtimes: [],
      selected_runtimes: [],
      available_but_not_selected: [],
    });
    const action = lifecycleAction(
      "manual_verification",
      ["copilot"],
      Array.from({ length: 200 }, (_, index) => `reason-${index}`).join(" "),
    );
    action.manual = null;
    state.runtime_lifecycle_snapshot = lifecycleSnapshot([action]);

    const row = buildOrientationAttention(state).find((item) => item.includes("lifecycle action_class="));

    expect(row).toContain("procedure=reason-0");
    expect(row).toContain("reason-10…");
    expect(row?.split(/\s+/).length ?? 0).toBeLessThan(120);
  });

  it("omits lifecycle attention rows when the canonical projection is clean", () => {
    const state = minimalOrientationState({
      path: "",
      status: "missing",
      available_runtimes: [],
      selected_runtimes: [],
      available_but_not_selected: [],
    });
    state.runtime_lifecycle_snapshot = lifecycleSnapshot([]);

    expect(buildOrientationAttention(state).filter((item) => item.includes("lifecycle action_class="))).toEqual([]);
    expect(state.runtime_lifecycle_snapshot.counts).toEqual({
      total: 0,
      repairableOwned: 0,
      manualVerification: 0,
      unobservableGap: 0,
      commandEligible: 0,
    });
  });
});
