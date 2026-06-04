import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MAX_TOTAL_ENTRIES,
  buildBookmark,
  compactEntries,
  detectModifiedArtifacts,
  formatSessionYaml,
  getArtifactPaths,
  parseSessionEntries,
  writeSessionBookmark,
} from "../../src/hooks/sessionStop.js";
import { resolveSessionPath } from "../../src/hooks/common.js";

const SESSION_WITH_ENTRIES =
  "# Sessions\n\n## 2026-04-03 15:00\n\nArtifacts modified: health, plan\nSummary: Ran audit and planned next steps\n\n## 2026-04-03 10:00\n\nArtifacts modified: progress\nSummary: Completed cycle 80\n\n## 2026-04-02 14:00 (Previous session summary)\n";

describe("getArtifactPaths", () => {
  it("builds default paths and honors overrides", () => {
    const def = getArtifactPaths("/project", null);
    expect(def[".agentera/health.yaml"]).toBe("health");
    const ov = getArtifactPaths("/project", { health: "custom/health.yaml" });
    expect(ov["custom/health.yaml"]).toBe("health");
    expect(".agentera/health.yaml" in ov).toBe(false);
  });
});

describe("detectModifiedArtifacts", () => {
  it("maps modified files to artifact names", () => {
    const result = detectModifiedArtifacts("/p", null, () => [".agentera/health.yaml", ".agentera/plan.yaml"]);
    expect(result).toEqual(["health", "plan"]);
  });
  it("ignores non-artifact files", () => {
    expect(detectModifiedArtifacts("/p", null, () => ["src/main.py", "README.md"])).toEqual([]);
  });
});

describe("parseSessionEntries", () => {
  it("parses full and one-line markdown entries", () => {
    const entries = parseSessionEntries(SESSION_WITH_ENTRIES);
    expect(entries.length).toBe(3);
    expect(entries[0].kind).toBe("full");
    expect(entries[0].artifacts).toContain("health");
    expect(entries[0].summary).toBe("Ran audit and planned next steps");
    expect(entries[2].kind).toBe("oneline");
  });
  it("returns no entries for an empty session", () => {
    expect(parseSessionEntries("# Sessions\n")).toEqual([]);
  });
});

describe("compactEntries / formatSessionYaml / buildBookmark", () => {
  it("keeps ten full entries and compacts the rest", () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({
      timestamp: `2026-04-${String(i + 1).padStart(2, "0")} 10:00`,
      artifacts: ["plan"],
      summary: `Entry ${i + 1}`,
      kind: "full",
    }));
    const result = compactEntries(entries);
    expect(result.filter((e) => e.kind === "full").length).toBe(10);
    expect(result.filter((e) => e.kind === "oneline").length).toBe(2);
  });
  it("drops entries beyond the total limit", () => {
    const entries = Array.from({ length: 59 }, (_, i) => ({
      timestamp: `2026-04-${String(i + 1).padStart(2, "0")} 10:00`,
      artifacts: ["plan"],
      summary: `Entry ${i + 1}`,
      kind: "full",
    }));
    expect(compactEntries(entries).length).toBe(MAX_TOTAL_ENTRIES);
  });
  it("formats full and one-line entries", () => {
    const full = formatSessionYaml([{ timestamp: "2026-04-03 15:00", artifacts: ["health"], summary: "Ran audit", kind: "full" }]);
    expect(full.startsWith("bookmarks:\n")).toBe(true);
    expect(full).toContain("timestamp: 2026-04-03 15:00");
    expect(full).toContain("- health");
    const oneline = formatSessionYaml([{ timestamp: "2026-04-03 15:00", summary: "Ran audit", kind: "oneline" }]);
    expect(oneline).toContain("archive:");
    expect(oneline).toContain("summary: Ran audit");
  });
  it("builds a bookmark with a UTC timestamp and artifact count", () => {
    const ts = new Date(Date.UTC(2026, 3, 3, 15, 0));
    const bm = buildBookmark(["health", "plan"], ts);
    expect(bm.timestamp).toBe("2026-04-03 15:00");
    expect(bm.artifacts).toEqual(["health", "plan"]);
    expect(buildBookmark(["health"]).summary).toContain("1 artifact(s)");
  });
});

describe("writeSessionBookmark", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ss-stop-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("writes a new session file under the data home", () => {
    const env = { XDG_DATA_HOME: path.join(tmp, "data") };
    const ts = new Date(Date.UTC(2026, 3, 3, 15, 0));
    const written = writeSessionBookmark(tmp, null, ["health", "plan"], { timestamp: ts, env });
    expect(written).toBe(true);
    const sessionPath = resolveSessionPath(tmp, env);
    expect(fs.existsSync(sessionPath)).toBe(true);
    expect(sessionPath.startsWith(path.join(tmp, "data", "agentera", "sessions"))).toBe(true);
    const content = fs.readFileSync(sessionPath, "utf8");
    expect(content).toContain("bookmarks:");
    expect(content).toContain("timestamp: 2026-04-03 15:00");
    expect(content).toContain("health");
  });

  it("skips writing when no artifacts changed", () => {
    const env = { XDG_DATA_HOME: path.join(tmp, "data") };
    expect(writeSessionBookmark(tmp, null, [], { env })).toBe(false);
    expect(fs.existsSync(resolveSessionPath(tmp, env))).toBe(false);
  });

  it("compacts old entries when appending", () => {
    const env = { XDG_DATA_HOME: path.join(tmp, "data") };
    const sessionPath = resolveSessionPath(tmp, env);
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    const entries = Array.from({ length: 11 }, (_, i) => ({
      timestamp: `2026-04-${String(i + 1).padStart(2, "0")} 10:00`,
      artifacts: ["plan"],
      summary: `Entry ${i + 1}`,
      kind: "full",
    }));
    fs.writeFileSync(sessionPath, formatSessionYaml(entries));
    writeSessionBookmark(tmp, null, ["health"], { timestamp: new Date(Date.UTC(2026, 3, 15, 15, 0)), env });
    const parsed = parseSessionEntries(fs.readFileSync(sessionPath, "utf8"));
    expect(parsed.filter((e) => e.kind === "full").length).toBe(10);
    expect(parsed.filter((e) => e.kind === "oneline").length).toBe(2);
  });
});
