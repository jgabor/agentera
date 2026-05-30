import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cmdCompact } from "../../src/cli/commands/compact.js";
import { main } from "../../src/cli/dispatch.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cli-compact-"));
  fs.mkdirSync(path.join(tmp, ".agentera"), { recursive: true });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function capture(fn: (io: { out: (t: string) => void; err: (t: string) => void }) => number): {
  rc: number;
  out: string;
  err: string;
} {
  let out = "";
  let err = "";
  const rc = fn({ out: (t) => (out += t), err: (t) => (err += t) });
  return { rc, out, err };
}

describe("cli compact", () => {
  it("reports a passing check for an empty project (text, None counts)", () => {
    const { rc, out } = capture((io) => cmdCompact({ project: tmp, mode: "check" }, io));
    expect(rc).toBe(0);
    expect(out).toContain("status=pass | mode=check");
    // null counts render as Python None in text output
    expect(out).toContain("active=None");
    expect(out).toContain("action=missing");
  });

  it("emits a structured JSON payload with null counts", () => {
    const { rc, out } = capture((io) => cmdCompact({ project: tmp, mode: "check", format: "json" }, io));
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.command).toBe("compact");
    expect(payload.summary.status).toBe("pass");
    const changelog = payload.operations.find((o: { artifact: string }) => o.artifact === "CHANGELOG.md");
    expect(changelog.active_count).toBeNull();
  });

  it("validates --mode in the dispatcher", () => {
    const { rc, err } = capture((io) => main(["node", "agentera", "compact", "--mode", "bogus"], io));
    expect(rc).toBe(2);
    expect(err).toContain("argument --mode: invalid choice");
  });

  it("emits a deprecation alias for top-level compact", () => {
    const { err } = capture((io) => main(["node", "agentera", "compact", "--project", tmp], io));
    expect(err).toContain("Deprecation: agentera compact is deprecated; use agentera check compact");
  });
});
