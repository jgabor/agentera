import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cmdLint, lintFullArtifactPayload, lintPayload } from "../../src/cli/commands/lint.js";
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

  it("preserves non-verbosity findings when full-file word lint is unlimited", () => {
    const payload = lintFullArtifactPayload(
      "DECISIONS.md",
      "In summary, we should probably improve the system somehow",
    );
    const checks = Object.fromEntries(
      (payload.checks as Array<{ name: string; status: string; detail: string }>).map((check) => [check.name, check]),
    );
    expect(checks.verbosity.status).toBe("pass");
    expect(checks.abstraction.status).toBe("fail");
    expect(checks.abstraction.detail).toContain("abstraction creep");
    expect(checks.filler.status).toBe("fail");
    expect(checks.filler.detail).toContain("summary preambles");
  });

  it("reads from a file and reports it as the source (full-artifact budget)", () => {
    const f = path.join(tmp, "draft.yaml");
    fs.writeFileSync(f, "x");
    const payload = lintPayload({ artifact: "PLAN.md", file: f });
    expect(payload.source).toBe(f);
  });
});

describe("cli lint: command output", () => {
  it.each([false, true])("emits human text and returns 0 on pass (strict=%s)", (strict) => {
    const { rc, out } = capture((io) =>
      cmdLint({ artifact: "PLAN.md", text: "wrote scripts/agentera at line 42", strict }, io),
    );
    expect(rc).toBe(0);
    expect(out).toContain("lint pass: PLAN.md (text)");
    expect(out).toContain("all self-audit checks passed");
  });

  it("keeps finding payloads identical while only strict mode exits nonzero", () => {
    const args = {
      artifact: "PLAN.md",
      text: "we should probably improve things",
      format: "json",
    };
    const advisory = capture((io) => cmdLint(args, io));
    const strict = capture((io) => cmdLint({ ...args, strict: true }, io));
    expect(advisory.rc).toBe(0);
    expect(strict.rc).toBe(1);

    const advisoryPayload = JSON.parse(advisory.out);
    const strictPayload = JSON.parse(strict.out);
    expect(advisoryPayload.status).toBe("fail");
    expect(strictPayload.status).toBe("fail");
    expect(advisoryPayload.checks).toEqual(strictPayload.checks);
    expect(advisoryPayload.summary.failed).toBeGreaterThan(0);
    expect(advisoryPayload.summary.failed).toBe(strictPayload.summary.failed);
    expect(advisoryPayload.strict).toBe(false);
    expect(advisoryPayload.summary.advisory).toBe(true);
    expect(strictPayload.strict).toBe(true);
    expect(strictPayload.summary.advisory).toBe(false);
  });

  it.each([false, true])("returns nonzero for authority-loading failures (strict=%s)", (strict) => {
    const previous = process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
    process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = tmp;
    try {
      const { rc, out } = capture((io) =>
        cmdLint(
          {
            artifact: "PLAN.md",
            text: "wrote scripts/agentera at line 42",
            strict,
            format: "json",
          },
          io,
        ),
      );
      expect(rc).toBe(1);
      const payload = JSON.parse(out);
      expect(payload.status).toBe("fail");
      expect(payload.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "verbosity",
            status: "fail",
            detail: expect.stringContaining("verbosity authority error"),
            action: expect.stringContaining("Repair the verbosity budget authority"),
          }),
        ]),
      );
    } finally {
      if (previous === undefined) delete process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
      else process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = previous;
    }
  });

  it.each([false, true])("returns nonzero with recovery guidance for invalid input (strict=%s)", (strict) => {
    const argv = ["node", "agentera", "check", "lint", "--text", "draft"];
    if (strict) argv.push("--strict");
    const { rc, err } = capture((io) => main(argv, io));
    expect(rc).toBe(2);
    expect(err).toContain("the following arguments are required: --artifact");
    expect(err).toContain("Recovery: Correct the input and retry; no state was changed.");
  });

  it("keeps internal full-artifact lint strict for publication callers", () => {
    const payload = lintFullArtifactPayload(
      "plan",
      "In summary, we should probably improve the system somehow",
    );
    expect(payload.strict).toBe(true);
    expect(payload.summary.advisory).toBe(false);
    expect(payload.status).toBe("fail");
  });
});

describe("cli dispatch: lint routing", () => {
  it("routes `check lint` and validates required --artifact", () => {
    const f = path.join(tmp, "d.yaml");
    fs.writeFileSync(f, "x");
    const ok = capture((io) => main(["node", "agentera", "check", "lint", "--artifact", "PLAN.md", "--file", f], io));
    expect(ok.rc).toBe(0);
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
