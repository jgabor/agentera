import { describe, expect, it } from "vitest";

import { SequenceMatcher, splitLinesKeepEnds, unifiedDiff } from "../../src/core/difflib.js";

function ud(a: string, b: string): string {
  return unifiedDiff(
    splitLinesKeepEnds(a),
    splitLinesKeepEnds(b),
    "config.toml (current)",
    "config.toml (proposed)",
    "",
    "",
    3,
  ).join("");
}

describe("difflib: unifiedDiff", () => {
  it("returns empty for identical inputs", () => {
    expect(ud("same\nsame\n", "same\nsame\n")).toBe("");
  });

  it("emits a header and hunk for a fresh file", () => {
    const out = ud("", "[a]\nx = 1\n");
    expect(out).toBe(
      "--- config.toml (current)\n+++ config.toml (proposed)\n@@ -0,0 +1,2 @@\n+[a]\n+x = 1\n",
    );
  });

  it("emits a replace hunk with context", () => {
    const out = ud("l1\nl2\nl3\nl4\nl5\n", "l1\nlX\nl3\nl4\nl5\n");
    expect(out).toBe(
      "--- config.toml (current)\n+++ config.toml (proposed)\n@@ -1,5 +1,5 @@\n l1\n-l2\n+lX\n l3\n l4\n l5\n",
    );
  });

  it("handles inputs without a trailing newline", () => {
    const out = ud("a\nb", "a\nc");
    expect(out).toContain("-b");
    expect(out).toContain("+c");
  });
});

describe("difflib: SequenceMatcher", () => {
  it("computes opcodes for a simple replace", () => {
    const sm = new SequenceMatcher(null, ["a", "b", "c"], ["a", "x", "c"]);
    expect(sm.getOpcodes()).toEqual([
      ["equal", 0, 1, 0, 1],
      ["replace", 1, 2, 1, 2],
      ["equal", 2, 3, 2, 3],
    ]);
  });
});
