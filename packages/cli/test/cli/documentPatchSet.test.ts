import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { main } from "../../src/cli/dispatch.js";

const repo = path.resolve(import.meta.dirname, "../../../..");
let root: string, previousCwd: string;
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-document-patch-"));
  write(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
  write(path.join(root, ".agentera/docs.yaml"), "conventions:\n  doc_root: docs\n  style: concise\nmapping: []\n");
  write(path.join(root, "TODO.md"), "# TODO\n");
  vi.stubEnv("HOME", root);
  vi.stubEnv("AGENTERA_HOME", path.join(root, "app"));
  vi.stubEnv("AGENTERA_PROFILE_DIR", path.join(root, "profile"));
  vi.stubEnv("PROFILERA_PROFILE_DIR", path.join(root, "profile"));
  vi.stubEnv("AGENTERA_BOOTSTRAP_SOURCE_ROOT", repo);
  previousCwd = process.cwd();
  process.chdir(root);
});
afterEach(() => {
  process.chdir(previousCwd);
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});
function run(args: string[], code = 0): any {
  let out = "",
    err = "";
  const actual = main(["node", "agentera", ...args], {
    out: (text) => (out += text),
    err: (text) => (err += text),
  });
  expect(actual, out + err).toBe(code);
  return JSON.parse(out);
}
function mutate(verb: string, record: object, id?: string, code = 0) {
  run(["state", "docs", "explain", "--verb", verb, "--section", "detail"]);
  const input = path.join(root, "input.json");
  write(input, JSON.stringify(record));
  return run(["state", "docs", verb, ...(id ? ["--id", id] : []), "--input", input], code);
}
const get = (id: string) => run(["state", "docs", "get", "--id", id]).entry.record;

it("serves one bounded factual approval gate and removes contradictory per-finding/raw-index advice", () => {
  // Static contract regression, not proof that an LLM host follows the instructions.
  const detail = run(["prime", "--context", "document", "--detail", "instructions", "--section", "instructions", "--limit", "20"]);
  expect(detail.completeness.complete).toBe(true);
  const body = detail.items.map((part: { content: string }) => part.content).join("");
  expect(body).toContain("without per-finding questions or a second draft confirmation");
  expect(body).toContain("Apply this factual documentation patch set and its inventory updates?");
  expect(body).toContain("No, silence or planning-only approval means no documentation or inventory writes");
  expect(body).toContain("A changed disclosed patch set needs renewed approval");
  expect(body).toContain("do not silently rewrite them or file TODOs, plans or other work");
  expect(body).toContain("Intent-first drafts define intended behavior: obtain explicit approval");
  expect(body).toContain("state docs update --id ID --input PATH");
  expect(body).toContain("Update is replacement, not a partial patch");
  expect(body).toContain("read back affected entries");
  expect(body).not.toMatch(/For each finding, offer to|Present drafts and get confirmation|Edit specific YAML entries|Read `.agentera\/docs.yaml` for current index|Update `.agentera\/docs.yaml` with:|Add or update the relevant entry in/);
  expect(body).not.toContain("Document the divergence as an issue in TODO.md");
});

it("records a verified two-file factual patch through existing inventory create/update without changing policy or TODO", () => {
  const mapping = fs.readFileSync(path.join(root, ".agentera/docs.yaml"));
  const todo = fs.readFileSync(path.join(root, "TODO.md"));
  const record = {
    document: "Usage guide",
    path: "docs/usage.md",
    last_updated: "2026-09-01",
    status: "stale",
    description: "CLI usage",
    audience: "contributors",
  };
  write(path.join(root, record.path), "Use --json.\n");
  const created = mutate("create", record);
  expect(fs.readFileSync(path.join(root, record.path), "utf8")).toBe("Use --json.\n");
  // Explicitly approved fixture patch, applied by the host, not by the inventory writer.
  write(path.join(root, record.path), "Use --format json.\n");
  write(path.join(root, "README.md"), "See [usage](docs/usage.md).\n");
  const fixtureCli = path.join(root, "fixture-cli.mjs");
  write(fixtureCli, "console.log('Usage: fixture --format json');\n");
  expect(execFileSync(process.execPath, [fixtureCli, "--help"], { encoding: "utf8" })).toContain("--format json");
  expect(fs.readFileSync(path.join(root, "README.md"), "utf8")).toContain(record.path);
  expect(fs.readFileSync(path.join(root, record.path), "utf8")).toBe("Use --format json.\n");
  const full = { ...get(created.id), status: "current", last_updated: "2026-09-22" };
  mutate("update", full, created.id);
  const added = mutate("create", {
    document: "README",
    path: "README.md",
    last_updated: "2026-09-22",
    status: "current",
  });
  expect(get(created.id)).toEqual(full);
  expect(get(added.id).path).toBe("README.md");
  expect(mutate("update", full, created.id).operation.idempotent_replay).toBe(true);
  expect(run(["state", "docs", "list"]).entries).toHaveLength(2);
  expect(fs.readFileSync(path.join(root, ".agentera/docs.yaml"))).toEqual(mapping);
  expect(fs.readFileSync(path.join(root, "TODO.md"))).toEqual(todo);
});

it("rejects partial or writer-owned inventory inputs and preserves the record and referenced document", () => {
  const record = {
    document: "Usage guide",
    path: "docs/usage.md",
    last_updated: "2026-09-01",
    status: "stale",
  };
  write(path.join(root, record.path), "Unverified content must stay stale.\n");
  const created = mutate("create", record);
  for (const invalid of [{ status: "current" }, { ...record, id: created.id }]) {
    mutate("update", invalid, created.id, 2);
    expect(get(created.id)).toEqual(record);
    expect(fs.readFileSync(path.join(root, record.path), "utf8")).toBe("Unverified content must stay stale.\n");
  }
});
