import { describe, expect, it } from "vitest";

import {
  cmdValidate,
  cmdValidateCapability,
  cmdValidateCapabilityContract,
  isDelegatedValidateFamily,
} from "../../src/cli/commands/validate.js";
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

describe("cli validate (delegated families)", () => {
  it("recognizes the delegated families", () => {
    expect(isDelegatedValidateFamily("cross-capability")).toBe(true);
    expect(isDelegatedValidateFamily("lifecycle-adapters")).toBe(true);
    expect(isDelegatedValidateFamily("app-home-contract")).toBe(true);
    expect(isDelegatedValidateFamily("capability")).toBe(false);
  });

  it("validates the cross-capability graph against the repo (text)", () => {
    const { rc, out } = capture((io) => cmdValidate("cross-capability", {}, io));
    expect(rc).toBe(0);
    expect(out.trim()).toBe("cross-capability artifact graph ok");
  });

  it("emits a structured envelope for cross-capability (json)", () => {
    const { rc, out } = capture((io) => cmdValidate("cross-capability", { format: "json" }, io));
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.command).toBe("validate");
    expect(payload.status).toBe("pass");
    expect(payload.target_family).toBe("cross-capability");
    expect(payload.engine.command).toBe("validate_cross_capability.py");
    expect(payload.engine.stdout).toContain("cross-capability artifact graph ok");
  });

  it("validates lifecycle adapters against the repo", () => {
    const { rc, out } = capture((io) => cmdValidate("lifecycle-adapters", {}, io));
    expect(rc).toBe(0);
    expect(out.trim()).toBe("lifecycle adapter metadata ok");
  });

  it("validates the app-home contract against the repo", () => {
    const { rc, out } = capture((io) => cmdValidate("app-home-contract", {}, io));
    expect(rc).toBe(0);
    expect(out.trim()).toBe("OK: app-home contract terminology is release-ready");
  });

  it("throws for an unsupported family", () => {
    expect(() => cmdValidate("bogus", {}, {})).toThrow();
  });
});

describe("cli dispatch: validate routing", () => {
  it("routes check validate cross-capability", () => {
    const { rc } = capture((io) => main(["node", "agentera", "check", "validate", "cross-capability"], io));
    expect(rc).toBe(0);
  });

  it("emits a deprecation alias for top-level validate", () => {
    const { err } = capture((io) => main(["node", "agentera", "validate", "cross-capability"], io));
    expect(err).toContain("Deprecation: agentera validate is deprecated; use agentera check validate");
  });

  it("requires a family", () => {
    const { rc, err } = capture((io) => main(["node", "agentera", "check", "validate"], io));
    expect(rc).toBe(2);
    expect(err).toContain("validate_family");
  });
});


describe("cli validate capability (structure; exact output covered by parity harness)", () => {
  it("prints the validation header and contract line (text)", () => {
    const { out } = capture((io) => cmdValidateCapability("hej", {}, io));
    expect(out).toContain("Validating capability:");
    expect(out).toContain("Using contract: skills/agentera/capability_schema_contract.yaml");
  });

  it("emits a single-capability JSON envelope with the target", () => {
    const { out } = capture((io) => cmdValidateCapability("planera", { format: "json" }, io));
    const payload = JSON.parse(out);
    expect(payload.command).toBe("validate");
    expect(payload.target_family).toBe("capability");
    expect(payload.target).toBe("planera");
  });

  it("rejects an unknown capability name", () => {
    expect(() => cmdValidateCapability("notacapability", {}, {})).toThrow(/unsupported capability target/);
  });
});

describe("cli validate capability-contract (structure)", () => {
  it("prints both contract and protocol headers (text)", () => {
    const { out } = capture((io) => cmdValidateCapabilityContract({}, io));
    expect(out).toContain("Self-validating contract: skills/agentera/capability_schema_contract.yaml");
    expect(out).toContain("Validating protocol: skills/agentera/protocol.yaml");
  });

  it("emits a two-check JSON envelope", () => {
    const { out } = capture((io) => cmdValidateCapabilityContract({ format: "json" }, io));
    const payload = JSON.parse(out);
    expect(payload.target_family).toBe("capability-contract");
    expect(payload.checks).toHaveLength(2);
    expect(payload.checks.map((c: { target_family: string }) => c.target_family)).toEqual([
      "capability-contract-self",
      "capability-protocol",
    ]);
  });
});
