import { describe, expect, it } from "vitest";

import { loadYamlMapping } from "../../src/core/yaml.js";

describe("loadYamlMapping", () => {
  it("returns an empty object for empty and whitespace documents", () => {
    expect(loadYamlMapping("")).toEqual({});
    expect(loadYamlMapping("   \n")).toEqual({});
  });

  it("throws for a non-mapping root", () => {
    expect(() => loadYamlMapping("- item\n")).toThrow(/mapping/);
  });

  it("parses a mapping root", () => {
    expect(loadYamlMapping("a: 1\nb: two\n")).toEqual({ a: 1, b: "two" });
  });
});
