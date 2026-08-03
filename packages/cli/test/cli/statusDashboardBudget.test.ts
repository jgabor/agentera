import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildStatusCapabilityContextPayload, collectOrientationState, finalizeStatusCapabilityContextPayload } from "../../src/cli/commands/prime.js";
import { PRIME_STATUS_CONTEXT_MAX_UTF8_BYTES } from "../../src/cli/commands/prime/orientationOutput.js";
import { briefUtf8Bytes } from "../../src/cli/commands/prime/briefOrientation.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");

function withSyntheticState<T>(run: (state: ReturnType<typeof collectOrientationState>) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "status-aggregation-"));
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  const before = process.cwd();
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  process.chdir(project);
  try {
    return run(collectOrientationState({
      home,
      env: { ...process.env, HOME: home, AGENTERA_HOME: path.join(home, "agentera"), AGENTERA_BOOTSTRAP_SOURCE_ROOT: REPO_ROOT },
    }));
  } finally {
    process.chdir(before);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("status startup budget", () => {
  it("fits instructions, one availability projection, and dashboard state in the 22,500-byte budget", () => {
    withSyntheticState((state) => {
      const payload = buildStatusCapabilityContextPayload(state) as Record<string, any>;
      const capsule = payload.capability_context;
      const dashboard = capsule.context.status_context;

      expect(briefUtf8Bytes(payload)).toBeLessThanOrEqual(PRIME_STATUS_CONTEXT_MAX_UTF8_BYTES);
      expect(payload.outcome).toBe(capsule.startup.outcome);
      expect(dashboard.outcome).toBe(capsule.startup.outcome);
      expect(capsule.startup.availability).toEqual(expect.arrayContaining([
        expect.objectContaining({ family: "decisions", availability: "deferred", detail_command: "agentera state decisions list --format json" }),
      ]));
      expect(dashboard).not.toHaveProperty("profile");
      expect(JSON.stringify(payload)).not.toContain('"write_contract"');
    });
  });

  it("keeps the status view bounded when omitted dashboard detail is adversarial", () => {
    withSyntheticState((state) => {
      state.attention = Array.from({ length: 100 }, () => "attention ".repeat(500));
      const payload = buildStatusCapabilityContextPayload(state) as Record<string, any>;
      const finalized = finalizeStatusCapabilityContextPayload(payload, state) as Record<string, any>;

      expect(briefUtf8Bytes(finalized)).toBeLessThanOrEqual(PRIME_STATUS_CONTEXT_MAX_UTF8_BYTES);
      expect(finalized.capability_context.context.status_context.outcome).toBe(finalized.capability_context.startup.outcome);
    });
  });
});
