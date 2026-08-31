import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cmdCompact, cmdGate } from "../../src/cli/commands/compact.js";
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

function activate(): void {
  fs.writeFileSync(path.join(tmp, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
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

  it("reports pending TODO summary formatting without calling it over-limit", () => {
    const rows = Array.from(
      { length: 50 },
      (_, i) => `- [x] [fix:3.0.0] resolved item ${i + 1} carries enough inline detail to require summary formatting before the bounded queue can report a clean state`,
    );
    fs.writeFileSync(
      path.join(tmp, "TODO.md"),
      ["# TODO", "", "## → Normal", "", "## ✓ Resolved", "", ...rows, ""].join("\n"),
    );

    const { rc, out } = capture((io) => cmdGate({ project: tmp, format: "json" }, io));
    const payload = JSON.parse(out);
    const todo = payload.operations.find((o: { artifact: string }) => o.artifact === "todo#Resolved");
    expect(rc).toBe(1);
    expect(todo.action).toBe("formatting");
    expect(todo.over_limit_count).toBe(0);
    expect(todo.pending_summarization_count).toBe(40);
    expect(payload.summary.over_limit_count).toBe(0);
    expect(payload.summary.formatting_count).toBe(1);
    expect(payload.summary.guidance).toContain("Summary formatting is pending");
  });

  it("validates --mode in the dispatcher", () => {
    const { rc, out, err } = capture((io) => main(["node", "agentera", "compact", "--mode", "bogus"], io));
    expect(rc).toBe(2);
    expect(err).toBe("");
    expect(JSON.parse(out).error.message).toContain("argument --mode: invalid choice");
  });

  it("keeps the top-level compact alias JSON-only", () => {
    activate();
    const { out, err } = capture((io) => main(["node", "agentera", "compact", "--project", tmp], io));
    expect(JSON.parse(out).status).toBe("pass");
    expect(err).toBe("");
  });
});


describe("cli check compact", () => {
  it("routes check compact (check mode) to the gate and check compact --mode fix to compact", () => {
    activate();
    const gate = capture((io) => main(["node", "agentera", "check", "compact", "--project", tmp], io));
    expect(gate.rc).toBe(0);
    expect(JSON.parse(gateJson(tmp)).command).toBe("check compact");
    const fix = capture((io) => main(["node", "agentera", "check", "compact", "--mode", "fix", "--project", tmp, "--format", "json"], io));
    expect(fix.rc).toBe(0);
  });

  it("routes check compact --apply to the fix path", () => {
    activate();
    const fix = capture((io) =>
      main(["node", "agentera", "check", "compact", "--apply", "--project", tmp, "--format", "json"], io),
    );
    expect(fix.rc).toBe(0);
    const payload = JSON.parse(fix.out);
    expect(payload.command).toBe("check compact");
    expect(payload.summary.mode).toBe("fix");
  });

  it("rejects text output before a fix can run", () => {
    activate();
    const result = capture((io) => main(["node", "agentera", "check", "compact", "--mode", "fix", "--project", tmp, "--format", "text"], io));
    expect(result.rc).toBe(2);
    expect(JSON.parse(result.out).error.valid_values).toEqual(["json"]);
    expect(result.err).toBe("");
  });
});

function gateJson(project: string): string {
  let out = "";
  cmdGate({ project, format: "json" }, { out: (t) => (out += t), err: () => {} });
  return out;
}
