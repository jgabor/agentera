import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cmdQuery } from "../../src/cli/commands/query.js";
import { main } from "../../src/cli/dispatch.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cli-query-"));
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

describe("cli query", () => {
  it("lists artifact schema names as text (against the repo schemas)", () => {
    const { rc, out } = capture((io) => cmdQuery({ list_artifacts: true }, io));
    expect(rc).toBe(0);
    const names = out.trim().split("\n");
    expect(names).toContain("progress");
    expect(names).toContain("decisions");
    // sorted
    expect([...names].sort()).toEqual(names);
  });

  it("lists artifacts as a structured location contract (json)", () => {
    const { rc, out } = capture((io) => cmdQuery({ list_artifacts: true, format: "json" }, io));
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.schemaVersion).toBe("agentera.query.list_artifacts.v2");
    expect(payload.command).toBe("query");
    expect(Array.isArray(payload.names)).toBe(true);
    expect(Array.isArray(payload.artifacts)).toBe(true);
    const progress = payload.artifacts.find((a: { artifact_id: string }) => a.artifact_id === "progress");
    expect(progress.normal_read_command).toBe("agentera progress --format json");
  });

  it("requires a pattern when --list-artifacts is absent", () => {
    const { rc, err } = capture((io) => cmdQuery({}, io));
    expect(rc).toBe(1);
    expect(err).toContain("query pattern required");
  });

  it("redirects routine artifact names to their state command", () => {
    const { rc, err } = capture((io) => cmdQuery({ query: "progress" }, io));
    expect(rc).toBe(1);
    expect(err).toContain("Unsupported routine query: progress");
  });

  it("rejects path-like query names", () => {
    expect(() => cmdQuery({ query: "../escape" }, {})).toThrow();
  });

  it("reports unknown queries", () => {
    const { rc, err } = capture((io) => cmdQuery({ query: "definitelynotanartifact" }, io));
    expect(rc).toBe(1);
    expect(err).toContain("Unknown query: definitelynotanartifact");
  });
});

describe("cli dispatch: query routing", () => {
  it("routes state query --list-artifacts", () => {
    const { rc } = capture((io) => main(["node", "agentera", "state", "query", "--list-artifacts"], io));
    expect(rc).toBe(0);
  });

  it("emits a deprecation alias for top-level query", () => {
    const { err } = capture((io) => main(["node", "agentera", "query", "--list-artifacts"], io));
    expect(err).toContain("Deprecation: agentera query is deprecated; use agentera state query");
  });
});
