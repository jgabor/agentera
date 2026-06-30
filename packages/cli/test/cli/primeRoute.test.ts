import { describe, expect, it } from "vitest";

import { cmdPrime } from "../../src/cli/commands/prime.js";
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

describe("cli prime --route", () => {
  it("routes a discuss-stating input to discuss with a confidence score", () => {
    const { rc, out, err } = capture((io) => cmdPrime({ route: "discuss this idea with me" }, io));
    expect(rc).toBe(0);
    expect(err).toBe("");
    const payload = JSON.parse(out);
    expect(payload.command).toBe("prime --route");
    expect(payload.status).toBe("ok");
    expect(payload.route.capability).toBe("discuss");
    expect(payload.route.confidence).toBeGreaterThan(0);
    expect(payload.route.fallback).toBe(false);
    expect(payload.route.candidates).toEqual([]);
    expect(payload.input).toBe("discuss this idea with me");
    expect(payload.source_contract.engine).toBe("layer-3-4");
    expect(payload.source_contract.spec).toBe("references/cli/trigger-schema-enrichment.md");
  });

  it("returns disambiguation candidates for vision and build on 'refine the vision'", () => {
    const { rc, out } = capture((io) => cmdPrime({ route: "refine the vision" }, io));
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.route.fallback).toBe(false);
    expect(payload.route.capability).toBe("vision");
    const caps = payload.route.candidates.map((c: { capability: string }) => c.capability);
    expect(caps).toContain("vision");
    expect(caps).toContain("build");
    for (const c of payload.route.candidates) {
      expect(c.confidence).toBeGreaterThan(0);
    }
  });

  it("falls back to status with low confidence for nonsense input", () => {
    const { rc, out } = capture((io) => cmdPrime({ route: "xyzzy nonsense" }, io));
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.route.fallback).toBe(true);
    expect(payload.route.capability).toBe("status");
    expect(payload.route.confidence).toBe(0);
    expect(payload.route.candidates).toEqual([]);
  });

  it("emits valid JSON with the spec fields under --format json", () => {
    const { rc, out } = capture((io) => cmdPrime({ route: "text", format: "json" }, io));
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.command).toBe("prime --route");
    expect(payload.status).toBe("ok");
    expect(typeof payload.route.capability).toBe("string");
    expect(typeof payload.route.confidence).toBe("number");
    expect(Array.isArray(payload.route.candidates)).toBe(true);
    expect(typeof payload.route.fallback).toBe("boolean");
    expect(payload.input).toBe("text");
  });

  it("defaults to JSON output even without --format", () => {
    const { rc, out, err } = capture((io) => cmdPrime({ route: "audit the codebase for technical debt" }, io));
    expect(rc).toBe(0);
    expect(err).toBe("");
    expect(() => JSON.parse(out)).not.toThrow();
    const payload = JSON.parse(out);
    expect(payload.route.capability).toBe("audit");
  });

  it("does NOT include the state-derived next_action field", () => {
    const { rc, out } = capture((io) => cmdPrime({ route: "text" }, io));
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect("next_action" in payload).toBe(false);
    expect("health" in payload).toBe(false);
    expect("plan" in payload).toBe(false);
    expect("todo" in payload).toBe(false);
  });

  it("documents the actual engine behavior of the spec example 'help me decide'", () => {
    const { rc, out } = capture((io) => cmdPrime({ route: "help me decide" }, io));
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.route.capability).toBe("status");
    expect(payload.route.fallback).toBe(true);
    expect(payload.route.confidence).toBe(0);
  });

  it("rejects --route combined with --context", () => {
    const { rc, err } = capture((io) => cmdPrime({ route: "x", context: "plan" }, io));
    expect(rc).toBe(2);
    expect(err).toContain("mutually exclusive");
  });

  it("rejects --route combined with --dashboard", () => {
    const { rc, err } = capture((io) => cmdPrime({ route: "x", dashboard: true }, io));
    expect(rc).toBe(2);
    expect(err).toContain("mutually exclusive");
  });

  it("rejects --route combined with --guidance", () => {
    const { rc, err } = capture((io) => cmdPrime({ route: "x", guidance: true }, io));
    expect(rc).toBe(2);
    expect(err).toContain("mutually exclusive");
  });
});

describe("cli prime --route dispatch", () => {
  it("routes through the top-level dispatcher", () => {
    const { rc, out } = capture((io) => main(["node", "agentera", "prime", "--route", "plan the next feature"], io));
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.command).toBe("prime --route");
    expect(payload.route.capability).toBe("plan");
    expect(payload.route.fallback).toBe(false);
  });

  it("routes through the dispatcher with --format json", () => {
    const { rc, out } = capture((io) =>
      main(["node", "agentera", "prime", "--route", "audit the codebase", "--format", "json"], io),
    );
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.route.capability).toBe("audit");
  });

  it("supports --route=value form", () => {
    const { rc, out } = capture((io) => main(["node", "agentera", "prime", "--route=discuss this"], io));
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.input).toBe("discuss this");
    expect(payload.route.capability).toBe("discuss");
  });

  it("errors when --route is combined with --context via the dispatcher", () => {
    const { rc, err } = capture((io) =>
      main(["node", "agentera", "prime", "--route", "x", "--context", "plan"], io),
    );
    expect(rc).toBe(2);
    expect(err).toContain("mutually exclusive");
  });

  it("rejects an unrecognized flag alongside --route", () => {
    const { rc } = capture((io) => main(["node", "agentera", "prime", "--route", "x", "--bogus"], io));
    expect(rc).not.toBe(0);
  });
});
