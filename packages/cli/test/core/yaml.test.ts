import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { dumpYamlMapping, loadYamlMapping, loadYamlMappingFile, withReadOnlyYamlMappingCache, withYamlMappingCache } from "../../src/core/yaml.js";

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

  it("invalidates file mappings by content and does not expose cached objects", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-yaml-"));
    const pathname = path.join(directory, "mapping.yaml");
    try {
      withYamlMappingCache(() => {
        fs.writeFileSync(pathname, "value: first\n", "utf8");
        const first = loadYamlMappingFile(pathname);
        first.value = "mutated";
        expect(loadYamlMappingFile(pathname)).toEqual({ value: "first" });

        fs.writeFileSync(pathname, "value: second\n", "utf8");
        expect(loadYamlMappingFile(pathname)).toEqual({ value: "second" });
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("shares frozen mappings only within a read-only cache scope", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-yaml-read-only-"));
    const pathname = path.join(directory, "mapping.yaml");
    try {
      fs.writeFileSync(pathname, "value: first\n", "utf8");
      withReadOnlyYamlMappingCache(() => {
        const first = loadYamlMappingFile(pathname);
        expect(loadYamlMappingFile(pathname)).toBe(first);
        expect(Object.isFrozen(first)).toBe(true);
        expect(() => {
          first.value = "mutated";
        }).toThrow();
      });
      fs.writeFileSync(pathname, "value: second\n", "utf8");
      expect(withReadOnlyYamlMappingCache(() => loadYamlMappingFile(pathname))).toEqual({
        value: "second",
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
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
