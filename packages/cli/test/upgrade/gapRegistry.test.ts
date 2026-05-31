import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  GAP_IDS,
  DEFAULT_RUNTIME_MATRIX,
  TRACKED_GAPS,
  gapSkipReason,
  isGapClosed,
} from "./gapRegistry.js";
import { planRuntimeRewirePhase } from "../../src/upgrade/migrateArtifactsV2ToV3.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gap-v2v3-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("gapRegistry", () => {
  it("lists tracked migration gaps with stable ids", () => {
    const ids = TRACKED_GAPS.map((gap) => gap.id);
    expect(ids).toContain(GAP_IDS.OPENCODE_RUNTIME_REWIRE);
    expect(ids).toContain(GAP_IDS.STALE_SURFACE_CLEANUP);
    expect(ids).toContain(GAP_IDS.CHANNEL_AWARE_NPX_DIST);
  });

  it("documents default runtime matrix statuses for sandbox reports", () => {
    expect(DEFAULT_RUNTIME_MATRIX.opencode).toBe("expected_fail");
    expect(DEFAULT_RUNTIME_MATRIX.codex).toBe("applied");
    expect(DEFAULT_RUNTIME_MATRIX.cursor).toBe("applied");
  });

  it("documents opencode runtime rewire gap until closed", () => {
    if (isGapClosed(GAP_IDS.OPENCODE_RUNTIME_REWIRE)) {
      return;
    }
    const home = path.join(tmp, "home");
    fs.cpSync(path.join(FIXTURES, "v2-runtime-opencode"), home, { recursive: true });
    const phase = planRuntimeRewirePhase({
      appHome: path.join(home, "agentera"),
      project: path.join(home, "project"),
      home,
    });
    expect(phase.items.some((item) => item.runtime === "opencode" && item.status === "applied")).toBe(false);
  });

  it("skips opencode gap test until gap closes", () => {
    if (isGapClosed(GAP_IDS.OPENCODE_RUNTIME_REWIRE)) {
      return;
    }
    expect(gapSkipReason(GAP_IDS.OPENCODE_RUNTIME_REWIRE)).toContain(GAP_IDS.OPENCODE_RUNTIME_REWIRE);
  });
});
