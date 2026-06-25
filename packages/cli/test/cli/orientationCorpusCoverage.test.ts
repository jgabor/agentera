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
    next_action: { object: "none", capability: "status", reason: "none" },
    attention: [],
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
