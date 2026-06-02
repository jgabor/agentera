import { describe, it, expect, vi } from "vitest";
import { main } from "../../src/cli/dispatch.js";

const DENY_PAYLOAD = JSON.stringify({
  runtime: "opencode",
  hook_event_name: "tool.execute.before",
  cwd: "/tmp/hooktest",
  tool_input: {
    file_path: "/tmp/hooktest/TODO.md",
    content: "# TODO\n\njust some text\n",
  },
});

describe("agentera hook dispatch", () => {
  it("requires a hook name", () => {
    let err = "";
    const rc = main(["node", "agentera", "hook"], { err: (t) => (err += t) });
    expect(rc).toBe(2);
    expect(err).toContain("required");
  });

  it("rejects an unknown hook name", () => {
    let err = "";
    const rc = main(["node", "agentera", "hook", "bogus"], { err: (t) => (err += t), stdin: () => "" });
    expect(rc).toBe(2);
    expect(err).toContain("unknown hook 'bogus'");
  });

  it("validate-artifact reports violations to stderr and exits 2", () => {
    let err = "";
    const rc = main(["node", "agentera", "hook", "validate-artifact"], {
      err: (t) => (err += t),
      stdin: () => DENY_PAYLOAD,
    });
    expect(rc).toBe(2);
    expect(err).toContain("missing severity sections");
  });

  it("cursor-pre-tool-use denies an invalid write with exit 0", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const rc = main(["node", "agentera", "hook", "cursor-pre-tool-use"], { stdin: () => DENY_PAYLOAD });
      expect(rc).toBe(0);
      const out = spy.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toContain('"permission": "deny"');
    } finally {
      spy.mockRestore();
    }
  });

  it("session-start succeeds on a minimal event", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const rc = main(["node", "agentera", "hook", "session-start"], { stdin: () => "{}" });
      expect(rc).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("agentera usage dispatch", () => {
  it("rejects an invalid --format with the four-question envelope", () => {
    let err = "";
    const rc = main(["node", "agentera", "usage", "--format", "xml"], { err: (t) => (err += t) });
    expect(rc).toBe(2);
    expect(err).toContain("What happened:");
    expect(err).toContain("unsupported usage format 'xml'");
    expect(err).toContain("valid formats: text, json");
  });

  it("rejects an unrecognized argument", () => {
    let err = "";
    const rc = main(["node", "agentera", "usage", "--bogus"], { err: (t) => (err += t) });
    expect(rc).toBe(2);
    expect(err).toContain("What happened:");
    expect(err).toContain("unrecognized arguments: --bogus");
  });
});

describe("agentera upgrade dispatch", () => {
  it("rejects --yes together with --dry-run", () => {
    let err = "";
    const rc = main(["node", "agentera", "upgrade", "--yes", "--dry-run"], { err: (t) => (err += t) });
    expect(rc).toBe(2);
    expect(err).toContain("mutually exclusive");
  });

  it("rejects an unrecognized argument", () => {
    let err = "";
    const rc = main(["node", "agentera", "upgrade", "--bogus"], { err: (t) => (err += t) });
    expect(rc).toBe(2);
    expect(err).toContain("unrecognized arguments: --bogus");
  });
});
