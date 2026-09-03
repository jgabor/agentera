import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { cmdCapability, CAPABILITY_ROUTING_NAMES } from "../../src/cli/commands/capability.js";
import { main } from "../../src/cli/dispatch.js";

function capture(fn: (io: { out: (t: string) => void; err: (t: string) => void }) => number): {
  rc: number;
  out: string;
  err: string;
} {
  let out = "";
  let err = "";
  const rc = fn({ out: (t) => (out += t), err: (t) => (err += t) });
  return { rc, out, err };
}

describe("cli capability routing", () => {
  it("lists the routable capability names (status excluded)", () => {
    expect(CAPABILITY_ROUTING_NAMES).toContain("vision");
    expect(CAPABILITY_ROUTING_NAMES).not.toContain("status");
    expect(CAPABILITY_ROUTING_NAMES).toHaveLength(11);
  });

  it("emits JSON routing guidance without a selector", () => {
    const { rc, out } = capture((io) => cmdCapability("plan", {}, io));
    expect(rc).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ command: "plan", capability: "plan" });
  });

  it("emits a JSON routing payload", () => {
    const { rc, out } = capture((io) => cmdCapability("discuss", { format: "json" }, io));
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.command).toBe("discuss");
    expect(payload.capability).toBe("discuss");
    expect(payload.routing.skill_invocation).toBe("/agentera discuss");
  });

  it("rejects a non-JSON selector with JSON only", () => {
    const result = capture((io) => main(["node", "agentera", "optimize", "--format", "yaml"], io));
    expect(result.rc).toBe(2);
    expect(result.err).toBe("");
    expect(JSON.parse(result.out).error.class).toBe("invalid_choice");
  });

  it("gates capability startup through the dispatcher before cutover", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-capability-gate-"));
    try {
      const { rc, out } = capture((io) => main(["node", "agentera", "vision", "--project", root, "--format", "json"], io));
      expect(rc).toBe(1);
      expect(JSON.parse(out).error).toMatchObject({
        class: "migration_required",
        recovery: expect.stringContaining("upgrade --channel development"),
      });
      expect(fs.readdirSync(root)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
