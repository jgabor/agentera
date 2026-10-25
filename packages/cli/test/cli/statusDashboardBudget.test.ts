import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { buildStatusCapabilityContextPayload, collectOrientationState, finalizeStatusCapabilityContextPayload } from "../../src/cli/commands/prime.js";
import { statusStateUtf8Bytes, STATUS_STATE_MAX_UTF8_BYTES, STATUS_STATE_TARGET_UTF8_BYTES } from "../../src/cli/commands/prime/orientationOutput.js";
import { expectStatusWithinBudget, statusParts, STATUS_ROW } from "../helpers/statusBudget.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
let root = "";
let state: ReturnType<typeof collectOrientationState>;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "status-aggregation-"));
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  const before = process.cwd();
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  process.chdir(project);
  try {
    state = collectOrientationState({
      home,
      env: {
        ...process.env,
        HOME: home,
        AGENTERA_HOME: path.join(home, "agentera"),
        AGENTERA_BOOTSTRAP_SOURCE_ROOT: REPO_ROOT,
      },
    });
  } finally {
    process.chdir(before);
  }
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("status startup budget", () => {
  it("fits instructions, one availability projection, and dashboard state without trimming", () => {
    const payload = buildStatusCapabilityContextPayload(state) as Record<string, any>;
    const capsule = payload.capability_context;
    const dashboard = capsule.context.status_context;

    expect(statusStateUtf8Bytes(payload)).toBeLessThanOrEqual(STATUS_STATE_MAX_UTF8_BYTES);
    expect(dashboard).not.toHaveProperty("state_budget");
    expectStatusWithinBudget(JSON.stringify(payload, null, 2) + "\n");
    expect(payload.outcome).toBe(capsule.startup.outcome);
    expect(dashboard.outcome).toBe(capsule.startup.outcome);
    expect(capsule.startup.availability).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          family: "decisions",
          availability: "deferred",
          detail_command: "npx -y agentera@next state decisions list",
        }),
      ]),
    );
    expect(dashboard).not.toHaveProperty("profile");
    expect(JSON.stringify(payload)).not.toContain('"write_contract"');
  });

  it("trims over-budget state instead of refusing and reports what it omitted", () => {
    const adversarialState = {
      ...state,
      attention: Array.from({ length: 100 }, () => "attention ".repeat(500)),
      next_action: {
        recommended: state.next_action.recommended,
        alternatives: Array.from({ length: 20 }, () => ({
          ...state.next_action.recommended,
          object: "Secondary suggestion ".repeat(10),
          reason: "Read the exact continuation for this lower-ranked suggestion. ".repeat(4),
        })),
      },
    };
    const payload = buildStatusCapabilityContextPayload(adversarialState) as Record<string, any>;
    const finalized = finalizeStatusCapabilityContextPayload(payload, adversarialState) as Record<string, any>;
    const dashboard = finalized.capability_context.context.status_context;

    expect(dashboard.attention.length).toBeLessThanOrEqual(5);
    expect(dashboard.state_budget).toMatchObject({ omitted: true, omission_reason: "status_state_budget", max_utf8_bytes: STATUS_STATE_MAX_UTF8_BYTES });
    expect(dashboard.state_budget.within_budget).toBe(statusStateUtf8Bytes(finalized) <= STATUS_STATE_MAX_UTF8_BYTES);
    expect(dashboard.next_action.object).toBe(state.next_action.recommended.object);
    expect(dashboard.outcome).toBe(finalized.capability_context.startup.outcome);
    expectStatusWithinBudget(JSON.stringify(finalized, null, 2) + "\n");
  });

  it("holds the served instructions to their ratchet ceiling", () => {
    // Instructions are fixed per release. The ceiling is their bytes rounded
    // up to 1000, so a cut of 1000 bytes or more must lower it too.
    const { instructions } = statusParts(buildStatusCapabilityContextPayload(state) as Record<string, any>);
    expect(STATUS_ROW.instruction_byte_budget).toBe(Math.ceil(instructions / 1000) * 1000);
  });

  it("splits the status output budget into instructions and state", () => {
    expect(STATUS_ROW.byte_budget).toBe(STATUS_ROW.instruction_byte_budget + STATUS_ROW.state_byte_budget);
    expect(STATUS_ROW.state_target_byte_budget).toBe(STATUS_STATE_TARGET_UTF8_BYTES);
  });

  it("carries action-required TODO reconciliation once in the startup aggregation", () => {
    const reconciliationState = {
      ...state,
      todo_reconciliation: {
        state: "unsafe_active",
        status: "action_required",
        counts: { matched: 0, converted: 0, retained: 0, duplicate: 0, stale: 1, conflicting: 0 },
        omitted_count: 0,
        preview_command: "agentera state todo repair --dry-run",
        apply_command: "agentera state todo repair --yes",
        recovery_command: "Run the preview, review it, then run its exact apply command.",
      },
    };
    const payload = buildStatusCapabilityContextPayload(reconciliationState) as Record<string, any>;
    const capsule = payload.capability_context;

    expect(capsule.startup.todo_reconciliation).toEqual(reconciliationState.todo_reconciliation);
    expect(capsule.context.status_context).not.toHaveProperty("todo_reconciliation");
    expectStatusWithinBudget(JSON.stringify(payload, null, 2) + "\n");
  });

  it("reserves the complete capsule for the primary action and upgrade offer before secondary suggestions", () => {
    const offer = {
      question: "Agentera’s installed skill needs an update. Update it now? Your project files will not change.",
      approval: "explicit_yes_only",
      blocking: false,
      apply_command: "npx -y agentera@next upgrade --shared-skill --home /tmp/home --install-root /tmp/app --yes --authorization sha256:" + "a".repeat(64),
    };
    const crowded = {
      ...state,
      shared_skill: { ...state.shared_skill, upgrade_offer: offer },
      next_action: {
        recommended: state.next_action.recommended,
        alternatives: Array.from({ length: 30 }, () => ({
          ...state.next_action.recommended,
          object: "Secondary suggestion ".repeat(10),
          reason: "Read the exact continuation for this lower-ranked suggestion. ".repeat(4),
        })),
      },
    };
    const payload = buildStatusCapabilityContextPayload(crowded) as Record<string, any>;
    expectStatusWithinBudget(JSON.stringify(payload, null, 2) + "\n");
    expect(payload.shared_skill.upgrade_offer).toEqual(offer);
    expect(payload.capability_context.instructions).toBe((buildStatusCapabilityContextPayload(state) as Record<string, any>).capability_context.instructions);
    const next = payload.capability_context.context.status_context.next_action;
    expect(next.object).toBe(state.next_action.recommended.object);
    expect(next.alternatives.length).toBeLessThanOrEqual(2);
    expect(next.alternatives_omission).toEqual({
      omitted_count: 30 - next.alternatives.length,
      retrieval: "npx -y agentera@next prime --fields next_action",
    });
  });
});
