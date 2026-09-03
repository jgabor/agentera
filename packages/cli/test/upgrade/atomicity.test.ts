import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writeFileAtomic } from "../../src/upgrade/atomicWriter.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atomicity-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function enospcError(): NodeJS.ErrnoException {
  const err = new Error("write ENOSPC: no space left on device") as NodeJS.ErrnoException;
  err.code = "ENOSPC";
  return err;
}

describe("atomicity", () => {
  it("renameUnderKill: a failed write leaves the existing target old-content, never partial", () => {
    const target = path.join(tmp, "out.txt");
    fs.writeFileSync(target, "old content");

    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw enospcError();
    });

    expect(() => writeFileAtomic(target, "new content")).toThrow();

    expect(fs.readFileSync(target, "utf8")).toBe("old content");
    expect(fs.readdirSync(tmp).some((e) => e.includes(".tmp."))).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("renameUnderENOSPC: tmp is created, rename fails, and the original file is intact", () => {
    const target = path.join(tmp, "out.txt");
    fs.writeFileSync(target, "old content");

    const spy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw enospcError();
    });

    expect(() => writeFileAtomic(target, "new content")).toThrow();

    expect(fs.readFileSync(target, "utf8")).toBe("old content");
    expect(fs.readdirSync(tmp).some((e) => e.includes(".tmp."))).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
