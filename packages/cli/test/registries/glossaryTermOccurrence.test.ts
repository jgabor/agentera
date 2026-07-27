import { describe, expect, it } from "vitest";

import { containsGlossaryTerm } from "../../src/registries/glossaryTermOccurrence.js";

describe("shared glossary term occurrence", () => {
  const decomposed = "e\u0301";

  it.each([
    [`${decomposed}Suffix`, decomposed],
    [`Prefix${decomposed}`, decomposed],
    [`${decomposed}\u0301`, decomposed],
    [`${decomposed}_next`, decomposed],
    [`${decomposed}2`, decomposed],
    [`${decomposed}\u200Cnext`, decomposed],
    [`${decomposed}\u200Dnext`, decomposed],
    [`next\u200C${decomposed}`, decomposed],
    [`next\u200D${decomposed}`, decomposed],
    ["A+BSuffix", "A+B"],
  ])("rejects %j as a bounded occurrence of %j", (line, term) => {
    expect(containsGlossaryTerm(line, term)).toBe(false);
  });

  it.each([
    [decomposed, decomposed],
    [`(${decomposed})`, decomposed],
    [`value = ${decomposed};`, decomposed],
    ["before.A+B,after", "A+B"],
    ["const value = 𐐨x;", "𐐨x"],
  ])("accepts the standalone or punctuation-delimited occurrence in %j", (line, term) => {
    expect(containsGlossaryTerm(line, term)).toBe(true);
  });

  it("is exact-case and non-normalizing", () => {
    expect(containsGlossaryTerm("TERM", "term")).toBe(false);
    expect(containsGlossaryTerm("é", decomposed)).toBe(false);
    expect(containsGlossaryTerm(decomposed, "é")).toBe(false);
  });
});
