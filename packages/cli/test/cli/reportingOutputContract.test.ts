import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch.js";

const roots: string[] = [];

afterEach(() => {
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

    const implicit = capture(["usage", "--corpus", corpus]);
    const explicit = capture(["usage", "--corpus", corpus, "--format", "json"]);
    expect(implicit).toEqual(explicit);
    expect(implicit.rc).toBe(0);
    expect(JSON.parse(implicit.out)).toBeTypeOf("object");
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
