import { describe, expect, it } from "vitest";

import { dumpYamlMapping, loadYamlMapping } from "../../src/core/yaml.js";

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

describe("dumpYamlMapping", () => {
  it("preserves insertion order and emits multiline prose as a literal block scalar", () => {
    const source = { first: 1, prose: "line one\nline two", last: ["value"] };
    const dumped = dumpYamlMapping(source);
    expect(dumped).toMatch(/prose: \|-?\n  line one\n  line two/);
    expect(dumped.indexOf("first:")).toBeLessThan(dumped.indexOf("prose:"));
    expect(dumped.indexOf("prose:")).toBeLessThan(dumped.indexOf("last:"));
    expect(loadYamlMapping(dumped)).toEqual(source);
  });
});
