import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildVerifyPayload,
  cmdVerify,
  validateVerifyRequest,
  VerifyArgs,
} from "../../src/cli/commands/verify.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const SEMANTIC_FIXTURE = path.join(repoRoot, "fixtures", "semantic", "hej-bare-message.md");

function run(args: VerifyArgs): { rc: number; out: string; err: string } {
  let out = "";
  let err = "";
  const rc = cmdVerify(args, { out: (t) => (out += t), err: (t) => (err += t) });
  return { rc, out, err };
}

describe("verify request validation", () => {
  it("rejects an unknown family", () => {
    expect(() => validateVerifyRequest({ family: "bogus", target: "x" })).toThrow(
      /unsupported verify family 'bogus'/,
    );
  });
  it("rejects an unknown target for a family", () => {
    expect(() => validateVerifyRequest({ family: "eval", target: "bogus" })).toThrow(
      /unsupported verify target 'bogus' for family 'eval'/,
    );
  });
  it("rejects semantic without fixtures", () => {
    expect(() => validateVerifyRequest({ family: "eval", target: "semantic", fixtures: [] })).toThrow(
      /semantic verify requires explicit fixture/,
    );
  });
  it("rejects eval skills combining --run and --dry-run", () => {
    expect(() =>
      validateVerifyRequest({ family: "eval", target: "skills", run: true, dryRun: true }),
    ).toThrow(/combines --run and --dry-run/);
  });
  it("rejects an unknown eval skills runtime", () => {
    expect(() =>
      validateVerifyRequest({ family: "eval", target: "skills", runtime: "bogus" }),
    ).toThrow(/unsupported eval skills runtime 'bogus'/);
  });
  it("rejects live-hosts --live without --yes", () => {
    expect(() =>
      validateVerifyRequest({ family: "smoke", target: "live-hosts", live: true, yes: false }),
    ).toThrow(/requires explicit non-interactive consent/);
  });
});

describe("cmdVerify", () => {
  it("emits an Error and rc 2 for an invalid request", () => {
    const { rc, err } = run({ family: "eval", target: "semantic", fixtures: [], format: "json" });
    expect(rc).toBe(2);
    expect(err).toContain("Error: semantic verify requires explicit fixture");
  });

  it("runs the semantic eval engine in-process and passes a valid fixture", () => {
    const { rc, out } = run({
      family: "eval",
      target: "semantic",
      fixtures: [SEMANTIC_FIXTURE],
      format: "json",
    });
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.status).toBe("pass");
    expect(payload.family).toBe("eval");
    expect(payload.target).toBe("semantic");
    expect(payload.engine.exit_code).toBe(0);
    // diagnostics capture the engine's JSON report (ensure_ascii escaped)
    expect(payload.diagnostics.stdout.join("\n")).toContain('"status": "pass"');
  });

  it("runs eval skills --dry-run in-process", () => {
    const { rc, out } = run({ family: "eval", target: "skills", dryRun: true, format: "json" });
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.status).toBe("pass");
    expect(payload.safety.mode).toBe("dry-run");
  });

  it("reports smoke families as unavailable in the self-contained package", () => {
    const { rc, out } = run({ family: "smoke", target: "installed-skills", format: "json" });
    expect(rc).toBe(127);
    const payload = JSON.parse(out);
    expect(payload.status).toBe("fail");
    expect(payload.engine.exit_code).toBe(127);
    expect(payload.diagnostics.stderr.join("\n")).toContain("not available in the self-contained");
    expect(payload.safety.mode).toBe("offline");
  });
});

describe("buildVerifyPayload", () => {
  it("bounds diagnostics output to the line limit", () => {
    const manyLines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const payload = buildVerifyPayload(
      "eval",
      "semantic",
      "json",
      { command: ["x"], returncode: 0, stdout: manyLines, stderr: "" },
      { mode: "offline-fixtures", summary: "s", live: false, long_running_default: false },
    );
    expect(payload.diagnostics.stdout.length).toBe(21); // 20 + truncation marker
    expect(payload.diagnostics.stdout[20]).toContain("truncated 30 line(s)");
  });
});
