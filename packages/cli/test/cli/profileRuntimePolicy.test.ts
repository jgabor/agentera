import { describe, expect, it } from "vitest";

import { CAPABILITY_INSTRUCTIONS } from "../../src/capabilities/index.js";
import profileInstructions from "../../src/capabilities/profile/instructions.js";

describe("served profile runtime policy", () => {
  it("keeps the module export as the static base while serving glossary instructions dynamically", () => {
    expect(profileInstructions).not.toContain("### Personal Glossary section");
    expect(CAPABILITY_INSTRUCTIONS.profile).toContain("### Personal Glossary section");
  });

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

  it("integrates authorized personal publication into Profile Full without claiming consumer lookup", () => {
    const profile = CAPABILITY_INSTRUCTIONS.profile;
    expect(profile).toContain("### Personal Glossary section");
    expect(profile).toContain("npx -y agentera@next report personal-glossary-publish");
    expect(profile).toContain("agentera.personalGlossaryPublishRequest.v1");
    expect(profile).toContain("Publish only current explicit automatic decisions");
    expect(profile).toContain("Host classification is semantic evidence, never admission authority");
    expect(profile).toContain("Without a question channel, ask nothing and rely on the durable queue");
    expect(profile).not.toContain("Profile Full does not invoke");
    expect(profile).not.toContain("report profile-glossary");
    expect(profile).not.toContain("Invoke `updatePersonalGlossaryProfile`");
    expect(profile).toContain("agentera.personalGlossarySection.v1");
    expect(profile).toContain("It never reads a project glossary");
    expect(profile).toContain("Profile performs no consumer lookup");
    expect(profile).toContain("Discuss, Plan, and Build obtain active consumer behavior separately");
  });
});
