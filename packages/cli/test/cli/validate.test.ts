import { describe, expect, it } from "vitest";

import { cmdValidate, isDelegatedValidateFamily } from "../../src/cli/commands/validate.js";
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
