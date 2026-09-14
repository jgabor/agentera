import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadReadOnlyYamlAuthorityFile, loadYamlMapping, withReadOnlyYamlMappingCache } from "../../src/core/yaml.js";

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
function fixture(text: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-static-yaml-"));
  directories.push(directory);
  const file = path.join(directory, "authority.yaml");
  fs.writeFileSync(file, text);
  return { file, read: () => loadReadOnlyYamlAuthorityFile(file) };
}

describe("read-only static authority parsing", () => {
  it("reuses immutable values and comments while reading current bytes on every call", () => {
    const setup = fixture("# before\n\nroot:\n  # nested\n  items: [one, two] # after\n");
    const read = vi.spyOn(fs, "readFileSync");
    const first = setup.read();
    const second = setup.read();
    expect(read).toHaveBeenCalledTimes(2);
    expect(second.value).toBe(first.value);
    expect(second.comments).toBe(first.comments);
    expect(first.comments.map(({ text }) => text.trim())).toEqual(["before", "nested", "after"]);
    expect(first.comments.some((comment) => comment.path.join(".") === "root.items")).toBe(true);
    expect(() => ((first.value.root as any).items[0] = "poisoned")).toThrow();
    expect(() => first.comments[0].path.push("poisoned")).toThrow();
    withReadOnlyYamlMappingCache(() => expect(loadYamlMapping(first.text)).toBe(first.value));
    const mutable = loadYamlMapping(first.text);
    (mutable.root as any).items[0] = "changed";
    expect((setup.read().value.root as any).items[0]).toBe("one");
  });

  it("invalidates equal-length bytes even when file timestamps are unchanged", () => {
    const setup = fixture("nested: {value: first}\n");
    const first = setup.read();
    const stat = fs.statSync(setup.file);
    fs.writeFileSync(setup.file, "nested: {value: later}\n");
    fs.utimesSync(setup.file, stat.atime, stat.mtime);
    const later = setup.read();
    expect(later.value).not.toBe(first.value);
    expect(later.value).toEqual({ nested: { value: "later" } });
  });

  it("invalidates comment-only edits and keeps selected roots independent", () => {
    const first = fixture("value: shared # original\n");
    const other = fixture("value: shared # original\n");
    const original = first.read();
    expect(other.read().value).toBe(original.value);
    fs.writeFileSync(other.file, "value: shared # revision\n");
    expect(other.read().comments.map(({ text }) => text)).toEqual([" revision"]);
    expect(first.read().comments).toEqual(original.comments);
  });

  it.each(["invalid: [", "same: first\nsame: second\n", "%YAML 1.3\n---\nvalue: warning\n", "[]", "{}"])("rejects malformed or warning-bearing bytes after a cached success (%#)", (text) => {
    const setup = fixture("value: valid\n");
    const valid = setup.read();
    fs.writeFileSync(setup.file, text);
    expect(setup.read).toThrow();
    fs.writeFileSync(setup.file, valid.text);
    expect(setup.read().value).toEqual({ value: "valid" });
  });

  it("does not hide missing or unreadable files behind cached content", () => {
    const setup = fixture("value: readable\n");
    const valid = setup.read();
    fs.unlinkSync(setup.file);
    expect(setup.read).toThrow();
    fs.writeFileSync(setup.file, valid.text);
    const read = vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("EACCES");
    });
    expect(setup.read).toThrow("EACCES");
    read.mockRestore();
    expect(setup.read().value).toEqual(valid.value);
  });

  it("bounds retained parse entries", () => {
    const setup = fixture("value: entry-limit-original\n");
    const original = setup.read();
    for (let i = 0; i < 65; i++) {
      fs.writeFileSync(setup.file, `value: entry-limit-${i}\n`);
      setup.read();
    }
    fs.writeFileSync(setup.file, original.text);
    expect(setup.read().value).not.toBe(original.value);
  });

  it("bounds retained source bytes independently of the entry count", () => {
    const setup = fixture(`value: ${"a".repeat(750_000)}\n`);
    const original = setup.read();
    for (const letter of ["b", "c"]) {
      fs.writeFileSync(setup.file, `value: ${letter.repeat(750_000)}\n`);
      setup.read();
    }
    fs.writeFileSync(setup.file, original.text);
    expect(setup.read().value).not.toBe(original.value);
  });
});
