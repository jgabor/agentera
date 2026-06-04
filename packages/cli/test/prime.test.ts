import { describe, expect, it } from "vitest";

import { cmdPrime } from "../src/cli/commands/prime.js";
import { PRIME_BLOB } from "../src/cli/prime-blob.js";

function capture(fn: (io: { out: (t: string) => void; err: (t: string) => void }) => number): {
  rc: number;
  out: string;
} {
  let out = "";
  const rc = fn({ out: (t) => (out += t), err: () => {} });
  return { rc, out };
}

describe("agentera prime --guidance (Phase 0 spike)", () => {
  it("prints the priming guide exactly, with no trailing newline added", () => {
    const { rc, out } = capture((io) => cmdPrime({ guidance: true }, io));
    expect(rc).toBe(0);
    expect(out).toBe(PRIME_BLOB);
  });

  it("PRIME_BLOB ends with a single trailing newline and no extra", () => {
    expect(PRIME_BLOB.endsWith("repair preview.\n")).toBe(true);
    expect(PRIME_BLOB.endsWith("\n\n")).toBe(false);
  });
});
