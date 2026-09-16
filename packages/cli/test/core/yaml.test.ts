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

describe("loadYamlMapping shared string cache", () => {
  const largeText = `${Array.from({ length: 150 }, (_, i) => `key${String(i).padStart(3, "0")}: value ${i}`).join("\n")}\n`;

  it("gives ordinary callers distinct mutable copies of a cached large mapping", () => {
    const first = loadYamlMapping(largeText);
    const second = loadYamlMapping(largeText);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(() => {
      first.key000 = "mutated";
    }).not.toThrow();
    expect(loadYamlMapping(largeText).key000).toBe("value 0");
  });

  it("shares one frozen value across loads in a read-only scope", () => {
    withReadOnlyYamlMappingCache(() => {
      const first = loadYamlMapping(largeText);
      expect(Object.isFrozen(first)).toBe(true);
      expect(loadYamlMapping(largeText)).toBe(first);
    });
  });

  it("invalidates cached string parses by content", () => {
    const changed = largeText.replace("value 0", "changed 0");
    expect(loadYamlMapping(changed).key000).toBe("changed 0");
    expect(loadYamlMapping(largeText).key000).toBe("value 0");
  });

  it("re-parses sub-threshold texts without caching", () => {
    const smallText = "key: value\n";
    withReadOnlyYamlMappingCache(() => {
      const first = loadYamlMapping(smallText);
      expect(Object.isFrozen(first)).toBe(false);
      expect(loadYamlMapping(smallText)).not.toBe(first);
    });
  });

  it("does not cache empty or non-mapping documents", () => {
    const largeBlank = "   \n".repeat(600);
    const first = loadYamlMapping(largeBlank);
    expect(first).toEqual({});
    expect(Object.isFrozen(first)).toBe(false);
    expect(loadYamlMapping(largeBlank)).not.toBe(first);
    const largeSequence = `${Array.from({ length: 300 }, (_, i) => `- item ${i}`).join("\n")}\n`;
    expect(() => loadYamlMapping(largeSequence)).toThrow(/mapping/);
    expect(() => loadYamlMapping(largeSequence)).toThrow(/mapping/);
  });

  it("stays correct and bounded beyond the cache entry limit", () => {
    const texts = Array.from({ length: 40 }, (_, n) => `${Array.from({ length: 150 }, (_, i) => `k${n}_${String(i).padStart(3, "0")}: value ${i}`).join("\n")}\n`);
    texts.forEach((text, n) => {
      expect(loadYamlMapping(text)[`k${n}_000`]).toBe("value 0");
    });
    expect(loadYamlMapping(texts[0]).k0_000).toBe("value 0");
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
