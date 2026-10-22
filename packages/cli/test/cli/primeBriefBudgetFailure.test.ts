import { describe, expect, it, vi } from "vite-plus/test";

import { BriefBudgetError } from "../../src/cli/commands/prime/briefByteBudget.js";

// Bare prime takes no input, so an unfittable brief must never be reported as
// an input error. The command is replaced so the dispatcher's failure mapping
// is exercised without constructing state that defeats every brief tier.
const failure = vi.hoisted(() => ({ error: null as Error | null }));
vi.mock("../../src/cli/commands/prime.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/cli/commands/prime.js")>("../../src/cli/commands/prime.js");
  return {
    ...actual,
    cmdPrime: () => {
      throw failure.error;
    },
  };
});

const { runPrime } = await import("../../src/cli/dispatch/prime.js");

function dispatch(error: Error): { rc: number; out: string; err: string } {
  failure.error = error;
  let out = "";
  let err = "";
  const rc = runPrime("prime", [], { out: (text) => (out += text), err: (text) => (err += text) }, "agentera");
  return { rc, out, err };
}

describe("prime brief budget failure", () => {
  it("reports an unfittable brief as an output failure with the status continuation", () => {
    const { rc, out, err } = dispatch(new BriefBudgetError(12_000, 12_290));

    expect(rc).toBe(1);
    expect(err).toBe("");
    expect(out).not.toContain("unsupported_target");
    expect(out).not.toContain("Correct the input");
    expect(JSON.parse(out)).toEqual({
      command: "prime",
      outcome: "blocked",
      error: {
        class: "brief_output_budget",
        message: "brief budget 12000 bytes cannot contain the minimum routing envelope (12290 bytes); use prime --context status",
        budget_utf8_bytes: 12_000,
        minimum_utf8_bytes: 12_290,
        recovery: "Run `npx -y agentera@next prime --context status`.",
      },
    });
  });

  it("keeps other unexpected prime failures on the generic input envelope", () => {
    const { rc, out } = dispatch(new Error("unexpected"));

    expect(rc).toBe(2);
    expect(JSON.parse(out)).toMatchObject({ error: { class: "unsupported_target", message: "unexpected" } });
  });
});
