import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cmdLint, lintPayload } from "../../src/cli/commands/lint.js";
import { main } from "../../src/cli/dispatch.js";
import { hasControlChars, pathStem, validatePathValue } from "../../src/cli/argvalidate.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cli-lint-"));
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

describe("cli argvalidate", () => {
  it("detects control chars and computes path stems", () => {
    expect(hasControlChars("ok")).toBe(false);
    expect(hasControlChars("bad\u0000")).toBe(true);
    expect(pathStem("PLAN.md")).toBe("PLAN");
    expect(pathStem("archive.tar.gz")).toBe("archive.tar");
    expect(() => validatePathValue("../escape", "path")).toThrow();
  });
});

describe("cli lint: payload", () => {
  it("passes inline text with a concrete anchor", () => {
    const payload = lintPayload({ artifact: "PLAN.md", text: "wrote scripts/agentera at line 42" });
    expect(payload.command).toBe("lint");
    expect(payload.source).toBe("text");
    expect(payload.status).toBe("pass");
    expect(payload.checks).toHaveLength(3);
  });

  it("flags abstraction creep with no anchor", () => {
    const payload = lintPayload({ artifact: "PLAN.md", text: "we should probably improve the system somehow" });
    expect(payload.status).toBe("fail");
    const abstraction = (payload.checks as Array<{ name: string; status: string }>).find(
      (c) => c.name === "abstraction",
    );
    expect(abstraction?.status).toBe("fail");
  });

  it("reads from a file and reports it as the source (full-artifact budget)", () => {
    const f = path.join(tmp, "draft.yaml");
    fs.writeFileSync(f, "x");
    const payload = lintPayload({ artifact: "PLAN.md", file: f });
    expect(payload.source).toBe(f);
  });
});

describe("cli lint: command output", () => {
  it("emits human text and returns 0 on pass", () => {
    const { rc, out } = capture((io) =>
      cmdLint({ artifact: "PLAN.md", text: "wrote scripts/agentera at line 42" }, io),
    );
    expect(rc).toBe(0);
    expect(out).toContain("lint pass: PLAN.md (text)");
    expect(out).toContain("all self-audit checks passed");
  });

  it("emits JSON and returns 1 on fail", () => {
    const { rc, out } = capture((io) =>
      cmdLint({ artifact: "PLAN.md", text: "we should probably improve things", format: "json" }, io),
    );
    expect(rc).toBe(1);
    const parsed = JSON.parse(out);
    expect(parsed.command).toBe("lint");
    expect(parsed.status).toBe("fail");
  });
});

describe("cli dispatch: lint routing", () => {
  it("routes `check lint` and validates required --artifact", () => {
    const f = path.join(tmp, "d.yaml");
    fs.writeFileSync(f, "x");
    const ok = capture((io) => main(["node", "agentera", "check", "lint", "--artifact", "PLAN.md", "--file", f], io));
    expect(ok.rc === 0 || ok.rc === 1).toBe(true);
    const missing = capture((io) => main(["node", "agentera", "check", "lint", "--file", f], io));
    expect(missing.rc).toBe(2);
    expect(missing.err).toContain("--artifact");
  });

  it("emits a deprecation alias for top-level `lint`", () => {
    const { err } = capture((io) =>
      main(["node", "agentera", "lint", "--artifact", "PLAN.md", "--text", "wrote foo/bar.ts line 3"], io),
    );
    expect(err).toContain("Deprecation: agentera lint is deprecated; use agentera check lint");
  });

  it("rejects mutually-exclusive --file and --text", () => {
    const f = path.join(tmp, "d.yaml");
    fs.writeFileSync(f, "x");
    const { rc, err } = capture((io) =>
      main(["node", "agentera", "check", "lint", "--artifact", "PLAN.md", "--file", f, "--text", "y"], io),
    );
    expect(rc).toBe(2);
    expect(err).toContain("not allowed with argument --file");
  });
});
