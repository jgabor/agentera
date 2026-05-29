import { describe, expect, it } from "vitest";

import {
  canonicalArtifactLabel,
  hashLabel,
  parseTimestamp,
  redactForStartupOutput,
} from "../../src/state/startupAnalysis.js";

describe("startup analysis: redaction core", () => {
  it("hashes private labels deterministically and salted", () => {
    const a = hashLabel("session", "sess-abc", "S");
    expect(a).toMatch(/^session:[0-9a-f]{16}$/);
    expect(hashLabel("session", "sess-abc", "S")).toBe(a);
    expect(hashLabel("session", "sess-abc", "OTHER")).not.toBe(a);
  });

  it("requires a salt", () => {
    expect(() => hashLabel("session", "x", "")).toThrow(/salt is required/);
  });

  it("maps known artifact paths to canonical labels", () => {
    expect(canonicalArtifactLabel(".agentera/plan.yaml")).toBe("PLAN.md");
    expect(canonicalArtifactLabel(".agentera/decisions.yaml")).toBe("DECISIONS.md");
    expect(canonicalArtifactLabel("/repo/.agentera/objective.yaml")).toBe("OBJECTIVE.md");
    expect(canonicalArtifactLabel("/etc/passwd")).toBeNull();
  });

  it("redacts transcript text, session ids, and paths recursively", () => {
    const sample = {
      session_id: "sess-abc",
      path: ".agentera/plan.yaml",
      cwd: "/home/u/project",
      content: "secret transcript text",
      nested: { text: "more secret", store_path: ".agentera/decisions.yaml", keep: "value" },
      list: [{ prompt: "p", session_id: "sess-2" }],
    };
    const redacted = redactForStartupOutput(sample, "S");
    expect(redacted.content).toBe("<redacted:transcript_text>");
    expect(redacted.session_id).toMatch(/^session:[0-9a-f]{16}$/);
    expect(redacted.path).toBe("PLAN.md");
    expect(redacted.cwd).toMatch(/^path:[0-9a-f]{16}$/);
    expect(redacted.nested.text).toBe("<redacted:transcript_text>");
    expect(redacted.nested.store_path).toBe("DECISIONS.md");
    expect(redacted.nested.keep).toBe("value");
    expect(redacted.list[0].prompt).toBe("<redacted:transcript_text>");
    expect(redacted.list[0].session_id).toMatch(/^session:[0-9a-f]{16}$/);
  });
});

describe("startup analysis: timestamp parsing", () => {
  it("parses ISO timestamps with Z suffix", () => {
    const d = parseTimestamp("2026-01-01T00:00:00Z");
    expect(d).not.toBeNull();
    expect(d!.getTime()).toBe(Date.parse("2026-01-01T00:00:00+00:00"));
  });
  it("returns null for non-strings and bad values", () => {
    expect(parseTimestamp(123)).toBeNull();
    expect(parseTimestamp("")).toBeNull();
    expect(parseTimestamp("not-a-date")).toBeNull();
  });
});
