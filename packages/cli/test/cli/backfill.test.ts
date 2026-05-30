import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cmdBackfill } from "../../src/cli/commands/backfill.js";
import { main } from "../../src/cli/dispatch.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cli-backfill-"));
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

describe("cli backfill", () => {
  it("returns noop when the progress artifact is absent", () => {
    const project = path.join(tmp, "empty");
    fs.mkdirSync(project, { recursive: true });
    const { rc, out } = capture((io) => cmdBackfill({ project, format: "json" }, io));
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.status).toBe("noop");
    expect(payload.message).toContain("progress artifact not found");
  });

  it("checks a synthetic progress artifact with a pending commit", () => {
    const project = path.join(tmp, "proj");
    fs.mkdirSync(path.join(project, ".agentera"), { recursive: true });
    fs.writeFileSync(
      path.join(project, ".agentera", "progress.yaml"),
      "progress:\n  1:\n    cycle: 1\n    commit: pending\n",
    );
    const { rc, out } = capture((io) => cmdBackfill({ project, format: "json" }, io));
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.command).toBe("backfill");
    expect(["ok", "noop", "fixed"]).toContain(payload.status);
  });

  it("routes `check backfill` and validates --mode/--cycle", () => {
    const good = capture((io) => main(["node", "agentera", "check", "backfill", "--project", tmp], io));
    expect(good.rc).toBe(0);
    const badMode = capture((io) => main(["node", "agentera", "check", "backfill", "--mode", "bogus"], io));
    expect(badMode.rc).toBe(2);
    expect(badMode.err).toContain("agentera check backfill: error: argument --mode: invalid choice");
    const badCycle = capture((io) => main(["node", "agentera", "check", "backfill", "--cycle", "abc"], io));
    expect(badCycle.rc).toBe(2);
    expect(badCycle.err).toContain("invalid int value: 'abc'");
  });
});
