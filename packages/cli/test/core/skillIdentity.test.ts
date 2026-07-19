import { describe, expect, it } from "vitest";

import { declaresAgenteraSkill } from "../../src/core/skillIdentity.js";

describe("Agentera skill identity", () => {
  it.each([
    ["valid canonical frontmatter", "---\nname: agentera\ndescription: canonical\n---\nBody", true],
    ["unrelated metadata with body marker", "---\nname: unrelated\ndescription: user-owned\n---\nExample:\nname: agentera", false],
    ["body-only marker", "Example:\nname: agentera", false],
    ["missing name", "---\ndescription: user-owned\n---\nname: agentera", false],
    ["unclosed frontmatter", "---\nname: agentera\ndescription: user-owned", false],
    ["malformed metadata", "---\nname: agentera\ndescription: [unclosed\n---\n", false],
    ["ambiguous duplicate names", "---\nname: agentera\nname: unrelated\n---\n", false],
  ])("classifies %s", (_label, text, expected) => {
    expect(declaresAgenteraSkill(text)).toBe(expected);
  });
});
