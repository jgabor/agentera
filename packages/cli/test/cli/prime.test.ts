import { describe, expect, it } from "vitest";

import { cmdPrime } from "../../src/cli/commands/prime.js";
import { PRIME_BLOB } from "../../src/cli/prime-blob.js";

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

describe("cli prime", () => {
  it("prints the static guidance for --guidance", () => {
    const { rc, out } = capture((io) => cmdPrime({ guidance: true }, io));
    expect(rc).toBe(0);
    expect(out).toBe(PRIME_BLOB);
  });

  it("renders the default text orientation briefing", () => {
    const { rc, out } = capture((io) => cmdPrime({ command: "prime" }, io));
    expect(rc).toBe(0);
    expect(out.startsWith("agentera prime\n")).toBe(true);
    expect(out).toContain("app_home: status=");
    expect(out).toContain("mode: ");
    expect(out).toContain("issues: critical=");
    expect(out).toContain("next_action:");
    expect(out).toContain("source_contract:");
    expect(out).toContain("capability_startup_complete=true");
  });

  it("rejects mutually-exclusive prime modes", () => {
    expect(capture((io) => cmdPrime({ context: "planera", dashboard: true }, io)).rc).toBe(2);
    expect(capture((io) => cmdPrime({ context: "planera", guidance: true }, io)).rc).toBe(2);
    expect(capture((io) => cmdPrime({ dashboard: true, guidance: true }, io)).rc).toBe(2);
  });

  it("reports JSON/dashboard/context paths as not yet ported", () => {
    const json = capture((io) => cmdPrime({ format: "json" }, io));
    expect(json.rc).toBe(1);
    expect(json.err).toContain("not yet ported");
    const ctx = capture((io) => cmdPrime({ context: "planera", format: "json" }, io));
    expect(ctx.rc).toBe(1);
  });
});
