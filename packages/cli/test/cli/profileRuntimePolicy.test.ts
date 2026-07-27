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

  it("serves active personal glossary output without claiming consumer lookup", () => {
    const profile = CAPABILITY_INSTRUCTIONS.profile;
    expect(profile).toContain("### Personal Glossary section");
    expect(profile).toContain("agentera report profile-glossary --input - --format json");
    expect(profile).toContain("agentera.personalGlossaryUpdateRequest.v1");
    expect(profile).not.toContain("Invoke `updatePersonalGlossaryProfile`");
    expect(profile).toContain("agentera.personalGlossarySection.v1");
    expect(profile).toContain("It never reads a project glossary");
    expect(profile).toContain("Profile itself performs no consumer lookup");
    expect(profile).toContain("Discuss, Plan, and Build obtain that active behavior separately");
  });
});
