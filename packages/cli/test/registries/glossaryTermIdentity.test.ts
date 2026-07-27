import { describe, expect, it } from "vitest";

import { unicodeCaselessExact } from "../../src/registries/glossaryTermIdentity.js";

describe("shared glossary term identity", () => {
  it.each([
    ["Ship Shape", "sHIP sHAPE"],
    ["ΟΣ", "οσ"],
    ["ΟΣ", "ος"],
    ["𐐀", "𐐨"],
    ["A+B (draft)?", "a+b (DRAFT)?"],
    ["line\nTERM\u0000", "LINE\nterm\u0000"],
  ])("treats %j and %j as Unicode caseless-exact", (left, right) => {
    expect(unicodeCaselessExact(left, right)).toBe(true);
    expect(unicodeCaselessExact(right, left)).toBe(true);
  });

  it.each([
    ["é", "e\u0301"],
    ["resume", "résumé"],
    ["i", "İ"],
    ["I", "ı"],
    ["ß", "SS"],
    [".*", "anything"],
    ["[term]", "t"],
    ["line\nterm", "line\nterm\n"],
  ])("keeps canonically or literally distinct %j and %j separate", (left, right) => {
    expect(unicodeCaselessExact(left, right)).toBe(false);
    expect(unicodeCaselessExact(right, left)).toBe(false);
  });
});
