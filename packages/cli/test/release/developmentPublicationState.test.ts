import { describe, expect, it } from "vitest";

import { classifyDevelopmentPublication } from "../../scripts/development-publication-state.mjs";

const candidate = { version: "3.0.0-dev.10", integrity: "sha512-exact", source: "a".repeat(40) };
const exact = { integrity: candidate.integrity, source: candidate.source };

describe("development publication state", () => {
  it.each([
    ["forward-publish", { currentNext: "3.0.0-dev.9", published: {} }],
    ["forward-retag", { currentNext: "3.0.0-dev.9", published: exact }],
    ["exact-replay", { currentNext: candidate.version, published: exact }],
    ["superseded-replay", { currentNext: "3.0.0-dev.11", published: exact }],
  ])("classifies %s", (expected, registry) => {
    expect(classifyDevelopmentPublication({ ...candidate, ...registry })).toBe(expected);
  });

  it.each([
    ["equal mismatch", { currentNext: candidate.version, published: { ...exact, source: "b".repeat(40) } }],
    ["absent older", { currentNext: "3.0.0-dev.11", published: {} }],
    ["conflicting older", { currentNext: "3.0.0-dev.11", published: { ...exact, integrity: "sha512-other" } }],
    ["malformed manifest", { version: "3.0.0", currentNext: "3.0.0-dev.9", published: {} }],
    ["malformed next", { currentNext: "latest", published: {} }],
  ])("rejects %s", (_label, registry) => {
    expect(() => classifyDevelopmentPublication({ ...candidate, ...registry })).toThrow();
  });
});
