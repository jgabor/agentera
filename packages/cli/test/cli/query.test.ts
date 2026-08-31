import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cmdQuery } from "../../src/cli/commands/query.js";
import { main } from "../../src/cli/dispatch.js";
import { STATE_FAMILY_LIST_COMMANDS } from "../../src/cli/capabilityContext/types.js";

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
    const progress = payload.artifacts.find((a: { artifact: string }) => a.artifact === "progress");
    expect(progress.normal_read_command).toBe(STATE_FAMILY_LIST_COMMANDS.progress);
    const glossary = payload.artifacts.find((a: { artifact: string }) => a.artifact === "glossary");
    expect(glossary).toMatchObject({
      implementation_status: "active",
      producer: ["build"],
      path: {
        default_path: ".agentera/glossary.yaml",
        resolution_source: "registry default",
        docs_yaml_can_override_path: true,
      },
    });
  });

  it("requires a pattern when --list-artifacts is absent", () => {
    const { rc, err } = capture((io) => cmdQuery({}, io));
    expect(rc).toBe(1);
    expect(err).toContain("query pattern required");
  });

  it("rejects routine aliases instead of reading marker-absent aggregates", () => {
    fs.mkdirSync(path.join(tmp, ".agentera"));
    fs.writeFileSync(path.join(tmp, ".agentera/progress.yaml"), "cycles:\n  - phase: build\n    what: legacy\n");
    const prior = process.cwd();
    process.chdir(tmp);
    try {
      const alias = capture((io) => cmdQuery({ query: "progresss" }, io));
      expect(alias.rc).toBe(1);
      expect(alias.err).toContain("Use `agentera state progress --format text` instead");
      expect(alias.out).not.toContain("legacy");
    } finally {
      process.chdir(prior);
    }
  });

  it("rejects path-like query names", () => {
    expect(() => cmdQuery({ query: "../escape" }, {})).toThrow();
  });

  it("reports unknown queries", () => {
    const { rc, err } = capture((io) => cmdQuery({ query: "definitelynotanartifact" }, io));
    expect(rc).toBe(1);
    expect(err).toContain("Unknown query: definitelynotanartifact");
  });

  it("routes structured changelog reads through the shared projection", () => {
    fs.writeFileSync(path.join(tmp, "CHANGELOG.md"), "## [Unreleased]\n## [1.2.3] - 2026-07-30\n");
    const prior = process.cwd();
    process.chdir(tmp);
    try {
      const { rc, out } = capture((io) => cmdQuery({ query: "changelog", format: "json" }, io));
      expect(rc).toBe(0);
      expect(JSON.parse(out)).toMatchObject({
        status: "available",
        recognized_headings: ["## [Unreleased]", "## [1.2.3] - 2026-07-30"],
        boundary: "## [Unreleased]",
        source_provenance: {
          command: "agentera state query changelog",
          scanner: "agentera.changelogHeadingScanner.v1",
        },
      });
    } finally {
      process.chdir(prior);
    }
  });

  it("leaves other generic structured artifact queries unchanged", () => {
    const prior = process.cwd();
    process.chdir(tmp);
    try {
      const { rc, out } = capture((io) => cmdQuery({ query: "vision", format: "json" }, io));
      expect(rc).toBe(0);
      const payload = JSON.parse(out);
      expect(payload).toMatchObject({ command: "vision", status: "empty", entries: [] });
      expect(payload).not.toHaveProperty("recognized_headings");
    } finally {
      process.chdir(prior);
    }
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
