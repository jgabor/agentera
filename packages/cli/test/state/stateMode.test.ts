import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { detectStateMode } from "../../src/state/stateMode.js";

const VALID_MARKER = "schemaVersion: agentera.stateMode.v1\nmode: entities\n";
const roots: string[] = [];

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-state-mode-"));
  roots.push(root);
  return root;
}

function marker(root: string, bytes = VALID_MARKER): string {
  const markerPath = path.join(root, ".agentera/state-mode.yaml");
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, bytes);
  return markerPath;
}

function replaceWithSymlink(target: string, external: string): void {
  fs.rmSync(target, { force: true });
  fs.symlinkSync(external, target);
}

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("state mode marker boundary", () => {
  it("returns legacy without writes when the marker is absent from a valid root", () => {
    const root = project();
    const write = vi.spyOn(fs, "writeFileSync");
    const mkdir = vi.spyOn(fs, "mkdirSync");
    const rename = vi.spyOn(fs, "renameSync");

    expect(detectStateMode(root)).toBe("legacy");
    expect(write).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, ".agentera"))).toBe(false);
  });

  it("rejects a symlinked project root", () => {
    const realRoot = project();
    const parent = project();
    const linkedRoot = path.join(parent, "linked-project");
    fs.symlinkSync(realRoot, linkedRoot);

    expect(() => detectStateMode(linkedRoot)).toThrow(/project root .* symbolic link.*real directory/i);
  });

  it("rejects a real-directory root replacement between validation and marker inspection", () => {
    const parent = project();
    const root = path.join(parent, "project");
    const held = path.join(parent, "held");
    const replacement = path.join(parent, "replacement");
    fs.mkdirSync(root);
    fs.mkdirSync(replacement);
    marker(replacement);
    const originalRead = fs.readFileSync.bind(fs);
    let replaced = false;

    vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
      if (
        !replaced
        && typeof args[0] === "string"
        && args[0].endsWith("references/artifacts/state-storage-authority.yaml")
      ) {
        fs.renameSync(root, held);
        fs.renameSync(replacement, root);
        replaced = true;
      }
      return Reflect.apply(originalRead, fs, args);
    });

    expect(() => detectStateMode(root)).toThrow(/project root .* changed after validation.*exact real directory/i);
    expect(replaced).toBe(true);
    expect(fs.existsSync(path.join(held, ".agentera"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".agentera/entities"))).toBe(false);
  });

  it("rejects missing, non-directory, and symlink-traversing project selectors", () => {
    const parent = project();
    const missing = path.join(parent, "missing");
    const file = path.join(parent, "project-file");
    fs.writeFileSync(file, "not a directory\n");
    const realParent = project();
    const realRoot = path.join(realParent, "project");
    fs.mkdirSync(realRoot);
    const linkedParent = path.join(parent, "linked-parent");
    fs.symlinkSync(realParent, linkedParent);

    expect(() => detectStateMode(missing)).toThrow(/does not exist.*real directory/i);
    expect(() => detectStateMode(file)).toThrow(/not a directory.*real directory/i);
    expect(() => detectStateMode(path.join(linkedParent, "project"))).toThrow(/traverses a symbolic link.*real directory/i);
  });

  it("rejects static links and non-files at the marker path", () => {
    const external = project();
    const externalMarker = marker(external);
    const linked = project();
    fs.mkdirSync(path.join(linked, ".agentera"));
    fs.symlinkSync(externalMarker, path.join(linked, ".agentera/state-mode.yaml"));
    const directory = project();
    fs.mkdirSync(path.join(directory, ".agentera/state-mode.yaml"), { recursive: true });

    expect(() => detectStateMode(linked)).toThrow(/unsafe path.*restore.*project-local marker/i);
    expect(() => detectStateMode(directory)).toThrow(/not a regular file.*restore/i);
  });

  it.each([
    ["malformed bytes", "mode: [\n", /corrupt[\s\S]*restore/i],
    ["wrong schema", "schemaVersion: old\nmode: entities\n", /must declare schemaVersion.*restore/i],
    ["wrong mode", "schemaVersion: agentera.stateMode.v1\nmode: legacy\n", /must declare schemaVersion.*restore/i],
  ])("fails closed for %s", (_name, bytes, expected) => {
    const root = project();
    marker(root, bytes as string);
    expect(() => detectStateMode(root)).toThrow(expected as RegExp);
  });

  it("rejects external replacement before open without reading outside bytes", () => {
    const root = project();
    const target = marker(root, "invalid: local\n");
    const external = project();
    const externalMarker = marker(external);
    const originalOpen = fs.openSync.bind(fs);
    const originalRead = fs.readFileSync.bind(fs);
    let replaced = false;
    let readExternalPath = false;
    let openFlags: number | string | undefined;

    vi.spyOn(fs, "openSync").mockImplementation((candidate, flags, mode) => {
      if (!replaced && typeof candidate === "string" && path.resolve(candidate) === target) {
        replaceWithSymlink(target, externalMarker);
        replaced = true;
        openFlags = flags;
      }
      return originalOpen(candidate, flags, mode);
    });
    vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
      if (typeof args[0] === "string" && path.resolve(args[0]) === externalMarker) readExternalPath = true;
      return Reflect.apply(originalRead, fs, args);
    });

    expect(() => detectStateMode(root)).toThrow(/changed or became unsafe.*retry/i);
    expect(replaced).toBe(true);
    expect(readExternalPath).toBe(false);
    if (typeof fs.constants.O_NOFOLLOW === "number" && typeof openFlags === "number") {
      expect(openFlags & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW);
    }
  });

  it("rejects marker replacement after descriptor read and closes the descriptor", () => {
    const root = project();
    const target = marker(root);
    const external = project();
    const externalMarker = marker(external);
    const originalOpen = fs.openSync.bind(fs);
    const originalRead = fs.readFileSync.bind(fs);
    const originalClose = fs.closeSync.bind(fs);
    let descriptor: number | undefined;
    let replaced = false;
    const closed: number[] = [];

    vi.spyOn(fs, "openSync").mockImplementation((candidate, flags, mode) => {
      const opened = originalOpen(candidate, flags, mode);
      if (typeof candidate === "string" && path.resolve(candidate) === target) descriptor = opened;
      return opened;
    });
    vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
      const bytes = Reflect.apply(originalRead, fs, args);
      if (!replaced && args[0] === descriptor) {
        replaceWithSymlink(target, externalMarker);
        replaced = true;
      }
      return bytes;
    });
    vi.spyOn(fs, "closeSync").mockImplementation((fd) => {
      closed.push(fd);
      return originalClose(fd);
    });

    expect(() => detectStateMode(root)).toThrow(/changed or became unsafe.*retry/i);
    expect(replaced).toBe(true);
    expect(descriptor).toBeDefined();
    expect(closed).toContain(descriptor);
  });

  it("rejects .agentera ancestor replacement after open", () => {
    const root = project();
    const target = marker(root);
    const external = project();
    marker(external);
    const held = path.join(root, ".agentera-held");
    const ancestor = path.dirname(target);
    const originalOpen = fs.openSync.bind(fs);
    const originalRead = fs.readFileSync.bind(fs);
    let descriptor: number | undefined;
    let replaced = false;

    vi.spyOn(fs, "openSync").mockImplementation((candidate, flags, mode) => {
      const opened = originalOpen(candidate, flags, mode);
      if (typeof candidate === "string" && path.resolve(candidate) === target) descriptor = opened;
      return opened;
    });
    vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
      const bytes = Reflect.apply(originalRead, fs, args);
      if (!replaced && args[0] === descriptor) {
        fs.renameSync(ancestor, held);
        fs.symlinkSync(path.join(external, ".agentera"), ancestor);
        replaced = true;
      }
      return bytes;
    });

    expect(() => detectStateMode(root)).toThrow(/changed or became unsafe.*retry/i);
    expect(replaced).toBe(true);
  });

  it("rejects a marker that vanishes before open", () => {
    const root = project();
    const target = marker(root);
    const originalOpen = fs.openSync.bind(fs);
    let removed = false;

    vi.spyOn(fs, "openSync").mockImplementation((candidate, flags, mode) => {
      if (!removed && typeof candidate === "string" && path.resolve(candidate) === target) {
        fs.rmSync(target);
        removed = true;
      }
      return originalOpen(candidate, flags, mode);
    });

    expect(() => detectStateMode(root)).toThrow(/changed or became unsafe.*retry/i);
    expect(removed).toBe(true);
  });
});
