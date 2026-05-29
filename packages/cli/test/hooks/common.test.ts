import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  MAX_FULL_ENTRIES,
  MAX_TOTAL_ENTRIES,
  applyRetentionCaps,
  compactSessionBookmarkEntries,
  parseArtifactMapping,
  parseDocsYamlMapping,
  resolveArtifactPath,
  resolveSessionPath,
} from "../../src/hooks/common.js";

describe("applyRetentionCaps", () => {
  it("enforces the total and full limits", () => {
    const full = Array.from({ length: 15 }, (_, i) => ({ kind: "full", n: i }));
    const archive = Array.from({ length: 50 }, (_, i) => ({ kind: "oneline", n: i }));
    const result = applyRetentionCaps(full, archive);
    expect(result.length).toBe(MAX_TOTAL_ENTRIES);
    expect(result.filter((e) => e.kind === "full").length).toBe(MAX_FULL_ENTRIES);
  });
});

describe("compactSessionBookmarkEntries", () => {
  it("keeps newest full entries and compacts the rest under 10/40/50", () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({
      timestamp: `2026-04-${String(i + 1).padStart(2, "0")} 10:00`,
      artifacts: ["PLAN.md"],
      summary: `Entry ${i + 1}`,
      kind: "full",
    }));
    const result = compactSessionBookmarkEntries(entries);
    expect(result.length).toBe(12);
    expect(result.filter((e) => e.kind === "full").length).toBe(MAX_FULL_ENTRIES);
    // Newest (highest timestamp) kept as full.
    expect(result[0].summary).toBe("Entry 12");
    // Overflow converted to oneline with empty artifacts.
    const oneline = result.find((e) => e.kind === "oneline") as any;
    expect(oneline.artifacts).toEqual([]);
  });
});

describe("resolveSessionPath", () => {
  it("derives a deterministic per-project session bookmark path", () => {
    const env = { AGENTERA_HOME: "/tmp/agentera-home" };
    const home = os.homedir();
    const a = resolveSessionPath("/work/my project!", env, home);
    const b = resolveSessionPath("/work/my project!", env, home);
    expect(a).toBe(b);
    expect(a.startsWith(path.join("/tmp/agentera-home", "sessions"))).toBe(true);
    expect(a.endsWith("session.yaml")).toBe(true);
    expect(a).toMatch(/my-project-[0-9a-f]{16}\/session\.yaml$/);
  });
});

describe("artifact path resolution", () => {
  it("uses defaults and overrides", () => {
    expect(resolveArtifactPath("/p", "PLAN.md")).toBe(path.join("/p", ".agentera/plan.yaml"));
    expect(resolveArtifactPath("/p", "PLAN.md", { "PLAN.md": "custom/plan.yaml" })).toBe(
      path.join("/p", "custom/plan.yaml"),
    );
    expect(resolveArtifactPath("/p", "UNKNOWN.md")).toBe(path.join("/p", ".agentera/UNKNOWN.md"));
  });

  it("parses docs.yaml mapping", () => {
    const text = "mapping:\n- artifact: PLAN.md\n  path: notes/plan.yaml\n- artifact: TODO.md\n  path: TODO.md\nother: x\n";
    expect(parseDocsYamlMapping(text)).toEqual({ "PLAN.md": "notes/plan.yaml", "TODO.md": "TODO.md" });
  });

  it("parses legacy DOCS.md artifact table", () => {
    const text = "| Artifact | Path |\n| --- | --- |\n| PLAN.md | .agentera/plan.yaml |\n| TODO.md | TODO.md |\n\ntext";
    expect(parseArtifactMapping(text)).toEqual({ "PLAN.md": ".agentera/plan.yaml", "TODO.md": "TODO.md" });
  });
});
