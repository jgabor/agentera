import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import { loadStateStorageAuthority } from "../../src/state/stateStorageAuthority.js";

const roots: string[] = [];

function sourceRoot(marker: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-state-authority-"));
  roots.push(root);
  const directory = path.join(root, "references", "artifacts");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "state-storage-authority.yaml"), `marker: ${marker}\nnested:\n  values: [one, two]\n`);
  return root;
}

function authorityPath(root: string): string {
  return path.join(root, "references", "artifacts", "state-storage-authority.yaml");
}

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("state storage authority loader", () => {
  it("parses unchanged exact bytes once and reparses changed bytes", () => {
    const root = sourceRoot("first");
    const parse = vi.spyOn(YAML, "parse");
    const first = loadStateStorageAuthority(root);
    const second = loadStateStorageAuthority(root);

    expect(first.authorityPath).toBe(path.resolve(authorityPath(root)));
    expect(second.document).toBe(first.document);
    expect(parse).toHaveBeenCalledTimes(1);
    fs.writeFileSync(authorityPath(root), "marker: second\nnested:\n  values: [one, two]\n");

    const changed = loadStateStorageAuthority(root);
    expect(changed.document).not.toBe(first.document);
    expect(changed.document.marker).toBe("second");
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("retains only the most recent root without returning stale data", () => {
    const firstRoot = sourceRoot("first");
    const secondRoot = sourceRoot("second");
    const first = loadStateStorageAuthority(firstRoot);
    const second = loadStateStorageAuthority(secondRoot);
    const reloadedFirst = loadStateStorageAuthority(firstRoot);

    expect(second.document.marker).toBe("second");
    expect(reloadedFirst.document.marker).toBe("first");
    expect(reloadedFirst.document).not.toBe(first.document);
  });

  it("parses every malformed attempt and reuses preserved cached bytes after restoration", () => {
    const root = sourceRoot("preserved");
    const original = fs.readFileSync(authorityPath(root));
    const parse = vi.spyOn(YAML, "parse");
    const preserved = loadStateStorageAuthority(root).document;
    fs.writeFileSync(authorityPath(root), "marker: [\n");

    expect(() => loadStateStorageAuthority(root)).toThrow();
    expect(() => loadStateStorageAuthority(root)).toThrow();
    expect(parse).toHaveBeenCalledTimes(3);
    fs.writeFileSync(authorityPath(root), original);
    expect(loadStateStorageAuthority(root).document).toBe(preserved);
    expect(parse).toHaveBeenCalledTimes(3);
  });

  it("does not expose mutable shared parsed data", () => {
    const document = loadStateStorageAuthority(sourceRoot("fixed")).document;
    const nested = document.nested as { values: string[] };

    expect(() => { document.marker = "changed"; }).toThrow(TypeError);
    expect(() => nested.values.push("three")).toThrow(TypeError);
    expect(document.marker).toBe("fixed");
    expect(nested.values).toEqual(["one", "two"]);
  });
});
