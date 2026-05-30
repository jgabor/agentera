import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  cmdValidate,
  cmdValidateCapability,
  cmdValidateCapabilityContract,
  cmdValidateArtifact,
  cmdValidateDescriptors,
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


describe("cli validate descriptors", () => {
  it("validates agent descriptors against the repo (text)", () => {
    const { rc, out } = capture((io) => cmdValidateDescriptors({}, io));
    expect(out).toMatch(/descriptor validation (pass|fail): \d+ passed, \d+ failed/);
    expect([0, 1]).toContain(rc);
  });

  it("emits a structured descriptors envelope (json)", () => {
    const { out } = capture((io) => cmdValidateDescriptors({ format: "json" }, io));
    const payload = JSON.parse(out);
    expect(payload.command).toBe("validate");
    expect(payload.target_family).toBe("descriptors");
    expect(payload.target).toBe("agent-descriptors");
    // 12 capabilities x 2 runtimes = 24 checks
    expect(payload.checks).toHaveLength(24);
    expect(payload.summary.passed + payload.summary.failed).toBe(24);
  });
});


describe("cli validate artifact", () => {
  it("validates a canonical artifact against the repo (text)", () => {
    const repo = path.resolve(process.cwd(), "..", "..");
    const artifact = fs.existsSync(path.join(repo, ".agentera/plan.yaml")) ? "PLAN.md" : "PROGRESS.md";
    const { rc, out } = capture((io) => cmdValidateArtifact({ artifact, cwd: repo }, io));
    expect(rc).toBe(0);
    expect(out).toContain(`status=pass | artifact=${artifact}`);
    expect(out).toContain("path_source=docs_mapped_default");
  });

  it("emits a wrapped JSON envelope", () => {
    const repo = path.resolve(process.cwd(), "..", "..");
    const { rc, out } = capture((io) => cmdValidateArtifact({ artifact: "PROGRESS.md", cwd: repo, format: "json" }, io));
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.command).toBe("validate");
    expect(payload.target_family).toBe("artifact");
    expect(payload.target).toBe("PROGRESS.md");
    expect(payload.engine).toEqual({ command: "validate-artifact", exit_code: 0 });
  });

  it("fails an invalid artifact file (rc 2)", () => {
    const f = fs.mkdtempSync(path.join(os.tmpdir(), "va-"));
    const bad = path.join(f, "bad.yaml");
    fs.writeFileSync(bad, "x");
    const { rc, out } = capture((io) => cmdValidateArtifact({ artifact: "PLAN.md", file: bad, format: "json" }, io));
    expect(rc).toBe(2);
    const payload = JSON.parse(out);
    expect(payload.status).toBe("fail");
    expect(payload.violations.length).toBeGreaterThan(0);
    fs.rmSync(f, { recursive: true, force: true });
  });

  it("rejects an unsupported artifact label", () => {
    expect(() => cmdValidateArtifact({ artifact: "BOGUS.md" }, {})).toThrow(/unsupported artifact/);
  });
});

