import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeFileAtomic } from "../../src/upgrade/atomicWriter.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-writer-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
  it("writes string content to the target and leaves no tmp file", () => {
    const target = path.join(tmp, "out.txt");
    writeFileAtomic(target, "hello world");
    expect(fs.readFileSync(target, "utf8")).toBe("hello world");
    const entries = fs.readdirSync(tmp);
    expect(entries).toEqual(["out.txt"]);
  });

  it("writes Buffer content as binary", () => {
    const target = path.join(tmp, "bin.dat");
    const data = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]);
    writeFileAtomic(target, data);
    const written = fs.readFileSync(target);
    expect(written.equals(data)).toBe(true);
  });

  it("replaces an existing file with new content atomically", () => {
    const target = path.join(tmp, "replace.txt");
    fs.writeFileSync(target, "old content");
    writeFileAtomic(target, "new content");
    expect(fs.readFileSync(target, "utf8")).toBe("new content");
    const entries = fs.readdirSync(tmp);
    expect(entries).toEqual(["replace.txt"]);
  });

  it("honours an explicit encoding for string data", () => {
    const target = path.join(tmp, "latin1.txt");
    writeFileAtomic(target, "café", "latin1");
    const raw = fs.readFileSync(target);
    expect(raw.equals(Buffer.from("café", "latin1"))).toBe(true);
  });

  it("cleans up the tmp file on write failure and rethrows", () => {
    const target = path.join(tmp, "missing-subdir", "out.txt");
    expect(() => writeFileAtomic(target, "data")).toThrow();
    expect(fs.readdirSync(tmp).some((e) => e.includes(".tmp."))).toBe(false);
  });
});
