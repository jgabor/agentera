import { describe, expect, it } from "vitest";

import { STATE_FAMILY_FALLBACK_COMMANDS } from "../../src/cli/capabilityContext/types.js";

describe("fallback commands use non-deprecated state forms", () => {
  it("every STATE_FAMILY_FALLBACK_COMMANDS value starts with agentera state", () => {
    for (const [family, command] of Object.entries(STATE_FAMILY_FALLBACK_COMMANDS)) {
      expect(command, `family=${family}`).toMatch(/^agentera state /);
    }
  });

  it("no STATE_FAMILY_FALLBACK_COMMANDS value uses a deprecated top-level alias", () => {
    const deprecatedPrefixes = [
      "agentera plan ",
      "agentera docs ",
      "agentera progress ",
      "agentera health ",
      "agentera todo ",
      "agentera decisions ",
      "agentera objective ",
      "agentera experiments ",
      "agentera query ",
    ];
    for (const [family, command] of Object.entries(STATE_FAMILY_FALLBACK_COMMANDS)) {
      for (const prefix of deprecatedPrefixes) {
        expect(command, `family=${family} must not use deprecated "${prefix.trim()}"`).not.toMatch(
          new RegExp("^" + prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        );
      }
    }
  });
});
