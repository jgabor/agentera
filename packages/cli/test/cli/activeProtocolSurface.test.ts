import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch/index.js";
import { printStateHelp } from "../../src/cli/help.js";
import { dumpYamlMapping } from "../../src/core/yaml.js";
import { semanticFindings } from "./retiredVocabulary.js";

let project = "";

function entity(artifact: string, boundary: string, id: string, record: Record<string, unknown>): void {
  const file = path.join(project, ".agentera/entities", artifact, boundary, `${id}.yaml`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, dumpYamlMapping({ id, artifact, record }));
}

function capture(args: string[]): { rc: number; output: unknown; stderr: string } {
  const previous = process.cwd();
  let stdout = "", stderr = "";
  process.chdir(project);
  try {
    const rc = main(["node", "agentera", ...args], { out: (text) => stdout += text, err: (text) => stderr += text });
    const trimmed = stdout.trim();
    return { rc, output: trimmed.startsWith("{") ? JSON.parse(trimmed) : trimmed, stderr };
  } finally {
    process.chdir(previous);
  }
}

beforeAll(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-active-protocol-"));
  fs.mkdirSync(path.join(project, ".agentera"));
  fs.writeFileSync(path.join(project, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
  entity("progress", "progress_cycle", "aaaaaaaaaa", { timestamp: "2026-07-17 12:00", type: "fix", phase: "build", what: "scan", context: { intent: "test" } });
  entity("plan", "plan", "bbbbbbbbbb", { header: { level: "light", created: "2026-07-17", status: "open", title: "Scan plan" }, what: "test", why: "test", scope: { included: ["state"], excluded: [] } });
});

afterAll(() => fs.rmSync(project, { recursive: true, force: true }));

describe("public runtime vocabulary", () => {
  it("does not emit retired identity or selector vocabulary", () => {
    const rootHelp = capture(["--help"]);
    const stateHelp = ["progress", "decisions", "health", "plan", "objective", "experiments", "todo", "docs"].map(printStateHelp);
    const schema = capture(["schema", "--format", "json"]);
    const explain = capture(["state", "progress", "explain", "--format", "json"]);
    const error = capture(["state", "plan", "get", "--id", "zzzzzzzzzz", "--format", "json"]);
    const prime = capture(["prime", "--format", "json"]);

    expect(rootHelp.rc).toBe(0);
    expect(schema.rc).toBe(0);
    expect(explain.rc).toBe(0);
    expect(error.rc).toBe(1);
    expect(prime.rc).toBe(0);
    expect(semanticFindings("runtime://public-cli", { rootHelp, stateHelp, schema, explain, error, prime })).toEqual([]);
  });
});
