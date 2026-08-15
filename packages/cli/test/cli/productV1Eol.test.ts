import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch/index.js";

const roots: string[] = [];

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v1-eol-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".agentera"));
  fs.writeFileSync(path.join(root, ".agentera", "PROGRESS.md"), "# Product v1 progress\n");
  fs.writeFileSync(path.join(root, "keep.txt"), "user owned\n");
  return root;
}

function snapshot(root: string): string {
  const hash = createHash("sha256");
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(directory, entry.name);
      hash.update(path.relative(root, target)).update(entry.isDirectory() ? "directory" : "file");
      if (entry.isDirectory()) visit(target);
      else hash.update(fs.readFileSync(target));
    }
  };
  visit(root);
  return hash.digest("hex");
}

function run(root: string, args: string[]): { rc: number; out: string; err: string } {
  const previous = process.cwd();
  let out = "";
  let err = "";
  process.chdir(root);
  try {
    const rc = main(["node", "agentera", ...args], {
      out: (text) => { out += text; },
      err: (text) => { err += text; },
    });
    return { rc, out, err };
  } finally {
    process.chdir(previous);
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("product v1 EOL execution gate", () => {
  it("blocks ordinary read-only and stateful commands with the future reset workflow without mutation", () => {
    const root = fixture();
    const before = snapshot(root);

    for (const args of [
      ["state", "query", "--list-artifacts", "--format", "json"],
      ["state", "plan", "create", "--input", "-", "--format", "json"],
    ]) {
      const result = run(root, args);
      expect(result.rc).toBe(1);
      expect(JSON.parse(result.out).error).toMatchObject({
        class: "product_v1_eol",
        message: expect.stringContaining("end-of-life"),
        reset_workflow: expect.arrayContaining([expect.stringContaining("Explicitly approve apply")]),
        recovery: expect.stringContaining("did not change state"),
      });
      expect(snapshot(root)).toBe(before);
    }
  });

  it("keeps help and version available without mutation", () => {
    const root = fixture();
    const before = snapshot(root);

    const help = run(root, ["state", "plan", "--help"]);
    const version = run(root, ["--version"]);

    expect(help).toMatchObject({ rc: 0, err: "" });
    expect(help.out).toContain("agentera state plan");
    expect(version).toMatchObject({ rc: 0, err: "" });
    expect(version.out.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(snapshot(root)).toBe(before);
  });

  it("also gates declared product-v1 installation evidence", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v1-eol-clean-"));
    const install = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v1-install-"));
    roots.push(root, install);
    fs.writeFileSync(path.join(install, "registry.json"), JSON.stringify({ skills: [{ version: "1.9.0" }] }));
    const previous = process.env.AGENTERA_HOME;
    process.env.AGENTERA_HOME = install;
    try {
      const before = snapshot(root);
      const result = run(root, ["state", "query", "--list-artifacts", "--format", "json"]);
      expect(result.rc).toBe(1);
      expect(JSON.parse(result.out).error).toMatchObject({
        class: "product_v1_eol",
        evidence: [path.join(install, "registry.json")],
      });
      expect(snapshot(root)).toBe(before);
    } finally {
      if (previous === undefined) delete process.env.AGENTERA_HOME;
      else process.env.AGENTERA_HOME = previous;
    }
  });
});
