import path from "node:path";

import { describe, expect, it } from "vitest";

import { MAX_FULL_ENTRIES, MAX_TOTAL_ENTRIES, applyRetentionCaps, parseArtifactMapping, parseDocsYamlMapping, resolveArtifactPath } from "../../src/hooks/common.js";

describe("applyRetentionCaps", () => {
  it("enforces the total and full limits", () => {
    const full = Array.from({ length: 25 }, (_, i) => ({ kind: "full", n: i }));
    const archive = Array.from({ length: 55 }, (_, i) => ({ kind: "oneline", n: i }));
    const result = applyRetentionCaps(full, archive);
    expect(result.filter((e) => e.kind === "full").length).toBe(MAX_FULL_ENTRIES);
    expect(result.length).toBeLessThanOrEqual(MAX_TOTAL_ENTRIES);
  });
});

describe("artifact path resolution", () => {
  it("uses defaults and overrides", () => {
    expect(resolveArtifactPath("/p", "plan")).toBe(path.join("/p", ".agentera/plan.yaml"));
    expect(resolveArtifactPath("/p", "PLAN.md", { plan: "custom/plan.yaml" })).toBe(path.join("/p", "custom/plan.yaml"));
    expect(resolveArtifactPath("/p", "UNKNOWN.md")).toBe(path.join("/p", ".agentera/UNKNOWN.md.yaml"));
  });

  it("parses docs.yaml mapping", () => {
    const text = "mapping:\n- artifact: PLAN.md\n  path: notes/plan.yaml\n- artifact: TODO.md\n  path: TODO.md\nother: x\n";
    expect(parseDocsYamlMapping(text)).toEqual({ plan: "notes/plan.yaml", todo: "TODO.md" });
  });

  it("parses legacy DOCS.md artifact table", () => {
    const text = "| Artifact | Path |\n| --- | --- |\n| PLAN.md | .agentera/plan.yaml |\n| TODO.md | TODO.md |\n\ntext";
    expect(parseArtifactMapping(text)).toEqual({ plan: ".agentera/plan.yaml", todo: "TODO.md" });
  });
});
