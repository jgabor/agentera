import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildStatusCapabilityContextPayload, collectOrientationState, finalizeStatusCapabilityContextPayload } from "../../src/cli/commands/prime.js";
import { PRIME_STATUS_CONTEXT_MAX_UTF8_BYTES } from "../../src/cli/commands/prime/orientationOutput.js";
import { briefUtf8Bytes } from "../../src/cli/commands/prime/briefOrientation.js";

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
      env: { ...process.env, HOME: home, AGENTERA_HOME: path.join(home, "agentera"), AGENTERA_BOOTSTRAP_SOURCE_ROOT: REPO_ROOT },
    });
  } finally {
    process.chdir(before);
  }
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("status startup budget", () => {
  it("fits instructions, one availability projection, and dashboard state in the 22,500-byte budget", () => {
    const payload = buildStatusCapabilityContextPayload(state) as Record<string, any>;
    const capsule = payload.capability_context;
    const dashboard = capsule.context.status_context;

    expect(briefUtf8Bytes(payload)).toBeLessThanOrEqual(PRIME_STATUS_CONTEXT_MAX_UTF8_BYTES);
    expect(payload.outcome).toBe(capsule.startup.outcome);
    expect(dashboard.outcome).toBe(capsule.startup.outcome);
    expect(capsule.startup.availability).toEqual(expect.arrayContaining([
      expect.objectContaining({ family: "decisions", availability: "deferred", detail_command: "npx -y agentera@next state decisions list" }),
    ]));
    expect(dashboard).not.toHaveProperty("profile");
    expect(JSON.stringify(payload)).not.toContain('"write_contract"');
  });

  it("keeps the status view bounded when omitted dashboard detail is adversarial", () => {
    const adversarialState = { ...state, attention: Array.from({ length: 100 }, () => "attention ".repeat(500)) };
    const payload = buildStatusCapabilityContextPayload(adversarialState) as Record<string, any>;
    const finalized = finalizeStatusCapabilityContextPayload(payload, adversarialState) as Record<string, any>;

    expect(briefUtf8Bytes(finalized)).toBeLessThanOrEqual(PRIME_STATUS_CONTEXT_MAX_UTF8_BYTES);
    expect(finalized.capability_context.context.status_context.outcome).toBe(finalized.capability_context.startup.outcome);
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
    expect(briefUtf8Bytes(payload)).toBeLessThanOrEqual(PRIME_STATUS_CONTEXT_MAX_UTF8_BYTES);
  });
});
