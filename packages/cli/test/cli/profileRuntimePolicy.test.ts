import { describe, expect, it } from "vitest";

import { CAPABILITY_INSTRUCTIONS } from "../../src/capabilities/index.js";

describe("served profile runtime policy", () => {
  it("uses the four-runtime authority and consent-gated historical import", () => {
    const profile = CAPABILITY_INSTRUCTIONS.profile;

    expect(profile).toContain("exactly `opencode`, `codex`, `cursor`, and `copilot`");
    expect(profile).toContain("`source_class=historical_import`");
    expect(profile).toContain("`source_product=claude-code`");
    expect(profile).toContain("`active_runtime=false`");
    expect(profile).toContain("--import-source claude");
    expect(profile).toContain("secrets, file contents, and command output");
    expect(profile).not.toContain("all supported runtimes (codex, claude-code");
    expect(profile).not.toContain("--no-claude");
  });
});
