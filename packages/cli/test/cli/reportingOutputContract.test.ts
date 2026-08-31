import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../../src/cli/dispatch.js";

const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function capture(args: string[]): { rc: number; out: string; err: string } {
  let out = "";
  let err = "";
  const rc = main(["node", "agentera", ...args], {
    out: (text) => (out += text),
    err: (text) => (err += text),
  });
  return { rc, out, err };
}

describe("reporting output contract", () => {
  it("keeps usage's omitted selector equivalent to explicit JSON", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-usage-output-"));
    roots.push(root);
    const corpus = path.join(root, "corpus.json");
    fs.writeFileSync(corpus, JSON.stringify({ records: [{ source_kind: "conversation_turn", data: { text: "hello" } }] }));

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T12:00:00Z"));
    const implicit = capture(["usage", "--corpus", corpus]);
    vi.setSystemTime(new Date("2026-08-31T12:00:01Z"));
    const explicit = capture(["usage", "--corpus", corpus, "--format", "json"]);
    const { generated_at: implicitGeneratedAt, ...implicitPayload } = JSON.parse(implicit.out);
    const { generated_at: explicitGeneratedAt, ...explicitPayload } = JSON.parse(explicit.out);
    expect(implicit.rc).toBe(explicit.rc);
    expect(implicit.err).toBe(explicit.err);
    expect(implicitPayload).toEqual(explicitPayload);
    for (const generatedAt of [implicitGeneratedAt, explicitGeneratedAt]) {
      expect(generatedAt).toBeTypeOf("string");
      expect(Number.isNaN(Date.parse(generatedAt))).toBe(false);
    }
    expect(implicit.rc).toBe(0);
  });

  it("keeps report preview JSON and rejects malformed report arguments as JSON", () => {
    const preview = capture(["report", "refresh", "--dry-run"]);
    expect(preview.rc).toBe(0);
    expect(JSON.parse(preview.out)).toMatchObject({ status: "dry_run" });

    const rejected = capture(["report", "--bogus"]);
    expect(rejected.rc).toBe(2);
    expect(rejected.err).toBe("");
    expect(JSON.parse(rejected.out).error.class).toBe("unrecognized_argument");
    expect(Buffer.byteLength(rejected.out)).toBeLessThanOrEqual(32_768);
  });

  it.each(["usage", "report"])("rejects %s text output before work", (command) => {
    const result = capture([command, "--format", "text"]);
    expect(result.rc).toBe(2);
    expect(result.err).toBe("");
    expect(JSON.parse(result.out).error).toMatchObject({ class: "invalid_choice", valid_values: ["json"] });
  });
});
