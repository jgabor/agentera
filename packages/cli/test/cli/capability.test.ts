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

  it("emits text routing guidance", () => {
    const { rc, out } = capture((io) => cmdCapability("plan", {}, io));
    expect(rc).toBe(0);
    expect(out).toContain("agentera plan");
    expect(out).toContain("invoke: /agentera plan via Agentera skill routing");
    expect(out).toContain("startup context: agentera prime --context plan --format json");
  });

  it("emits a JSON routing payload", () => {
    const { rc, out } = capture((io) => cmdCapability("discuss", { format: "json" }, io));
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.command).toBe("discuss");
    expect(payload.capability).toBe("discuss");
    expect(payload.routing.skill_invocation).toBe("/agentera discuss");
  });

  it("treats yaml like text (only json is structured)", () => {
    const yaml = capture((io) => cmdCapability("optimize", { format: "yaml" }, io));
    const text = capture((io) => cmdCapability("optimize", { format: "text" }, io));
    expect(yaml.out).toBe(text.out);
  });

  it("routes capability names through the dispatcher", () => {
    const { rc, out } = capture((io) => main(["node", "agentera", "vision"], io));
    expect(rc).toBe(0);
    expect(out).toContain("agentera vision");
  });
});
