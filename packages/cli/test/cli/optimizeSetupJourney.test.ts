import { describe, expect, it } from "vite-plus/test";
import { main } from "../../src/cli/dispatch/index.js";
import instructions from "../../src/capabilities/optimize/instructions.js";
import { optimizeScenarios, optimizeSetupJourney } from "../helpers/optimizeSetupJourney.mjs";

function sourceCli(root: string, args: string[], input?: unknown) {
  const previous = process.cwd();
  let output = "";
  let error = "";
  try {
    process.chdir(root);
    const rc = main(["node", "agentera", ...args], {
      out: (text) => {
        output += text;
      },
      err: (text) => {
        error += text;
      },
      stdin: () => JSON.stringify(input),
    });
    expect(rc, error || output).toBe(0);
    return JSON.parse(output);
  } finally {
    process.chdir(previous);
  }
}

describe("Optimize setup, cooperative host trace with real typed writers and measurement", () => {
  it("serves approval before effects and removes conflicting automatic actions", () => {
    expect(instructions.indexOf("Show ONE concrete proposal")).toBeLessThan(instructions.indexOf("### Activate"));
    expect(instructions).toContain("These are host execution instructions, not a CLI consent enforcement boundary");
    expect(instructions).not.toMatch(/Pre-spawn Git commit|Merge the worktree|edit objective.yaml directly|Formulate a different hypothesis/);
  });
  it.each(optimizeScenarios)("%s", (scenario) => {
    const result = optimizeSetupJourney(sourceCli, scenario);
    expect(result.trace[0].kind).toBe("proposal");
    expect(result.trace[1].kind).toBe("host-response");
  });
});
