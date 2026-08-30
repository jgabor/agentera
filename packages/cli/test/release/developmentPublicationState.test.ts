import { describe, expect, it } from "vitest";

import {
  allocateDevelopmentVersion,
  classifyDevelopmentPublication,
} from "../../scripts/development-publication-state.mjs";

const candidate = { version: "3.0.0-dev.10", integrity: "sha512-exact", source: "a".repeat(40) };
const exact = { integrity: candidate.integrity, source: candidate.source };

describe("development publication state", () => {
  it.each([[4, "3.0.0-dev.84"], [5, "3.0.0-dev.85"], [6, "3.0.0-dev.86"]])(
    "allocates run %s as %s",
    (runNumber, expected) => expect(allocateDevelopmentVersion("3.0.0-dev.84", runNumber)).toBe(expected),
  );

  it("replays the same run and increases monotonically without registry input", () => {
    expect(allocateDevelopmentVersion("3.0.0-dev.84", "5")).toBe(allocateDevelopmentVersion("3.0.0-dev.84", "5"));
    expect(allocateDevelopmentVersion("3.0.0-dev.84", 6)).toBe("3.0.0-dev.86");
  });

  it.each([0, -1, 1.5, "", "05", "x", Number.MAX_SAFE_INTEGER])("rejects invalid run number %s", (runNumber) => {
    expect(() => allocateDevelopmentVersion("3.0.0-dev.84", runNumber)).toThrow();
  });

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
