import { describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch.js";
import { DISPATCHER_TOP_LEVEL_COMMANDS } from "../../src/cli/dispatch/commands.js";

describe("retired agentera hook command", () => {
  it("rejects the retired top-level command before reading stdin", () => {
    let err = "";
    let reads = 0;

    const rc = main(["node", "agentera", "hook", "validate-artifact"], {
      err: (text) => { err += text; },
      stdin: () => { reads += 1; return "{}"; },
    });

    expect(rc).toBe(2);
    expect(reads).toBe(0);
    expect(err).toContain("unknown or not-yet-ported command: hook");
  });

  it("does not advertise hook as a routine command", () => {
    expect(DISPATCHER_TOP_LEVEL_COMMANDS).not.toContain("hook");
  });
});
