import { describe, expect, it } from "vitest";

/**
 * Template for parity / regression bug demonstration (lazygit EXPECTED/ACTUAL).
 * Authority: references/cli/parity-expected-actual-template.md
 *
 * Demonstrate commit: ACTUAL asserted, EXPECTED in comment — passes on broken code.
 * Fix commit: remove markers; only the correct assertion remains.
 */

function prefixBroken(value: string): string {
  return `${value}_wrong`;
}

function prefixFixed(value: string): string {
  return value;
}

describe("EXPECTED/ACTUAL parity template (documented pattern)", () => {
  it("demonstrate pass: documents wrong behavior before fix", () => {
    const input = "parity-row";
    /* EXPECTED:
    expect(prefixFixed(input)).toBe(input);
    ACTUAL: */
    expect(prefixBroken(input)).toBe(`${input}_wrong`);
  });

  it("fix pass: correct assertion only (replace demonstrate test after fix)", () => {
    const input = "parity-row";
    expect(prefixFixed(input)).toBe(input);
  });
});
