import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writeFileAtomic } from "../../src/upgrade/atomicWriter.js";
import { type MigrationPhaseItem } from "../../src/upgrade/migrateArtifactsV2ToV3.js";
import { applyRuntimeMigrationItem } from "../../src/upgrade/runtimeMigration.js";

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

const npxCommands = {
  cliEntrypoint: "npx -y agentera@next",
  validate: "npx -y agentera@next hook validate-artifact",
  cursorSessionStart: "npx -y agentera@next hook cursor-session-start",
  cursorSessionStop: "npx -y agentera@next hook session-stop",
  cursorPreTool: "npx -y agentera@next hook cursor-pre-tool-use",
};

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

  it("diskFullMidCopy: a mid-copy ENOSPC marks the item failed; a re-run after space recovers succeeds", () => {
    const source = path.join(tmp, "plugin-src.js");
    const target = path.join(tmp, "config", "plugins", "agentera.js");
    fs.writeFileSync(source, "module.exports = () => {};\n");

    const buildItem = (): MigrationPhaseItem => ({
      status: "pending",
      action: "copy-plugin",
      runtime: "opencode",
      source,
      target,
      message: "will copy managed OpenCode plugin",
    });

    const failed = buildItem();
    vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
      throw enospcError();
    });
    applyRuntimeMigrationItem(failed, npxCommands);
    expect(failed.status).toBe("failed");
    expect(failed.message).toMatch(/copy-plugin failed/);
    expect(fs.existsSync(target)).toBe(false);

    const retry = buildItem();
    applyRuntimeMigrationItem(retry, npxCommands);
    expect(retry.status).toBe("applied");
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe(fs.readFileSync(source, "utf8"));
  });
});
