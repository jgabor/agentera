import { describe, expect, it } from "vitest";

import { CAPABILITY_NAMES } from "../../src/cli/capabilityContext/types.js";
import { CAPABILITY_INSTRUCTIONS } from "../../src/capabilities/index.js";

function capabilityNameSetsMatch(
  names: readonly string[],
  instructions: Record<string, string>,
): boolean {
  const fromInstructions = Object.keys(instructions);
  if (names.length !== fromInstructions.length) return false;
  const instructionSet = new Set(fromInstructions);
  return names.every((name) => instructionSet.has(name));
}

describe("CAPABILITY_NAMES dedup (#33)", () => {
  it("synchronized: CAPABILITY_NAMES equals Object.keys(CAPABILITY_INSTRUCTIONS)", () => {
    expect(capabilityNameSetsMatch(CAPABILITY_NAMES, CAPABILITY_INSTRUCTIONS)).toBe(true);
    expect([...CAPABILITY_NAMES].sort()).toEqual(Object.keys(CAPABILITY_INSTRUCTIONS).sort());
  });

  it("drift-introduced: divergent sources are detected", () => {
    const extraName = [...CAPABILITY_NAMES, "phantom-capability"];
    expect(capabilityNameSetsMatch(extraName, CAPABILITY_INSTRUCTIONS)).toBe(false);

    const extraInstructions = { ...CAPABILITY_INSTRUCTIONS, "phantom-capability": "x" };
    expect(capabilityNameSetsMatch(CAPABILITY_NAMES, extraInstructions)).toBe(false);
  });
});
