import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { JsonObject } from "../../src/core/jsonValue.js";
import {
  publishImmutableFile,
  publishNumberedArchive,
  type ArchivePublicationFileSystem,
} from "../../src/state/archivePublication.js";
import { discoverNumberedArchives } from "../../src/state/archiveDiscovery.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const roots: string[] = [];

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-archive-publication-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function record(artifact: "progress" | "decisions" | "health", number: number): JsonObject {
  if (artifact === "progress") {
    return {
      number,
      timestamp: "2026-07-13 12:00",
      type: "test",
      phase: "build",
      what: "Validate numbered archive publication",
      context: { intent: "Prove archive publication", constraints: "Keep plan archives unchanged" },
    };
  }
  if (artifact === "decisions") {
    return {
      number,
      date: "2026-07-13",
      question: "Where should immutable records live?",
      context: "The project needs lossless local history.",
      alternatives: [{ name: "Project archive", status: "chosen" }],
      choice: "Use the project archive.",
      reasoning: "It keeps state local and inspectable.",
      confidence: "firm",
    };
  }
  return {
    number,
    date: "2026-07-13",
    dimensions: ["test_health"],
    findings_summary: { critical: 0, warning: 0, info: 0, filtered_by_confidence: 0 },
    trajectory: "stable",
    grades: { test_health: "A" },
  };
}

function fileSystem(overrides: Partial<ArchivePublicationFileSystem> = {}): ArchivePublicationFileSystem {
  return {
    exists: (candidate) => fs.existsSync(candidate),
    mkdir: (directory) => fs.mkdirSync(directory),
    openExclusive: (stage) => fs.openSync(stage, "wx"),
    write: (fd, bytes) => fs.writeFileSync(fd, bytes, "utf8"),
    syncFile: (fd) => fs.fsyncSync(fd),
    close: (fd) => fs.closeSync(fd),
    link: (stage, target) => fs.linkSync(stage, target),
    unlink: (stage) => fs.unlinkSync(stage),
    syncDirectory: (directory) => {
      const fd = fs.openSync(directory, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    },
    ...overrides,
  };
}

describe("numbered archive publication", () => {
  it("publishes each newly created directory entry before the archive file", () => {
    const calls: string[] = [];
    const target = "/project/.agentera/optimize/latency/archive/experiments/0.yaml";
    const archive = path.dirname(path.dirname(target));
    const experiments = path.dirname(target);
    const objective = path.dirname(archive);
    const existing = new Set([objective]);
    publishImmutableFile(target, "record\n", {
      directoryDurabilityRoot: objective,
      fileSystem: {
        exists: (candidate) => existing.has(candidate),
        mkdir: (directory) => { calls.push(`mkdir:${directory}`); existing.add(directory); },
        openExclusive: () => { calls.push("open-stage"); return 7; },
        write: () => { calls.push("write-stage"); },
        syncFile: () => { calls.push("sync-stage"); },
        close: () => { calls.push("close-stage"); },
        link: () => { calls.push("link-target"); },
        unlink: () => { calls.push("unlink-stage"); },
        syncDirectory: (directory) => { calls.push(`sync-dir:${directory}`); },
      },
    });

    expect(calls).toEqual([
      `mkdir:${archive}`,
      `sync-dir:${objective}`,
      `mkdir:${experiments}`,
      `sync-dir:${archive}`,
      "open-stage",
      "write-stage",
      "sync-stage",
      "close-stage",
      "link-target",
      `sync-dir:${experiments}`,
      "unlink-stage",
      `sync-dir:${experiments}`,
    ]);
  });

  it("stops before archive-file publication when a new directory entry sync fails", () => {
    const calls: string[] = [];
    const target = "/project/objective/archive/experiments/0.yaml";
    const archive = path.dirname(path.dirname(target));
    const experiments = path.dirname(target);
    const objective = path.dirname(archive);
    const existing = new Set([objective]);
    expect(() => publishImmutableFile(target, "record\n", {
      directoryDurabilityRoot: objective,
      fileSystem: {
        exists: (candidate) => existing.has(candidate),
        mkdir: (directory) => { existing.add(directory); },
        openExclusive: () => { calls.push("open-stage"); return 7; },
        write: () => { calls.push("write-stage"); },
        syncFile: () => { calls.push("sync-stage"); },
        close: () => { calls.push("close-stage"); },
        link: () => { calls.push("link-target"); },
        unlink: () => { calls.push("unlink-stage"); },
        syncDirectory: (directory) => {
          calls.push(`sync-dir:${directory}`);
          if (directory === archive) throw new Error("injected archive parent sync failure");
        },
      },
    })).toThrow("injected archive parent sync failure");
    expect(calls).not.toContain("open-stage");
    expect(calls).not.toContain("link-target");
  });

  it.each(["progress", "decisions", "health"] as const)(
    "publishes one validated %s record at its stable identity and replays it",
    (artifact) => {
      const root = project();
      const first = publishNumberedArchive(root, artifact, 7, record(artifact, 7), {
        sourceRoot: REPO_ROOT,
      });
      const target = path.join(root, ".agentera", "archive", artifact, "7.yaml");
      const before = fs.readFileSync(target, "utf8");
      const second = publishNumberedArchive(root, artifact, 7, record(artifact, 7), {
        sourceRoot: REPO_ROOT,
      });

      expect(first).toMatchObject({ path: target, stableId: `${artifact}:7`, replay: false });
      expect(second).toMatchObject({ path: target, stableId: `${artifact}:7`, replay: true });
      expect(fs.readFileSync(target, "utf8")).toBe(before);
      expect(discoverNumberedArchives(root, { sourceRoot: REPO_ROOT }).entries).toHaveLength(1);
    },
  );

  it("rejects an immutable collision without changing the original bytes", () => {
    const root = project();
    publishNumberedArchive(root, "progress", 3, record("progress", 3), {
      sourceRoot: REPO_ROOT,
    });
    const target = path.join(root, ".agentera", "archive", "progress", "3.yaml");
    const before = fs.readFileSync(target, "utf8");

    expect(() =>
      publishNumberedArchive(
        root,
        "progress",
        3,
        { ...record("progress", 3), what: "different canonical content" },
        { sourceRoot: REPO_ROOT },
      ),
    ).toThrow(/immutable archive/);
    expect(fs.readFileSync(target, "utf8")).toBe(before);
  });

  it("reports injected disk-full publication failure and leaves no target", () => {
    const root = project();
    const diskFull = Object.assign(new Error("injected disk full"), { code: "ENOSPC" });
    expect(() =>
      publishNumberedArchive(root, "health", 1, record("health", 1), {
        sourceRoot: REPO_ROOT,
        fileSystem: fileSystem({ write: () => { throw diskFull; } }),
      }),
    ).toThrow("injected disk full");
    expect(fs.existsSync(path.join(root, ".agentera", "archive", "health", "1.yaml"))).toBe(false);
  });

  it("rejects a symlinked archive parent before publication", () => {
    const root = project();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-archive-outside-"));
    roots.push(outside);
    fs.mkdirSync(path.join(root, ".agentera", "archive"), { recursive: true });
    fs.symlinkSync(outside, path.join(root, ".agentera", "archive", "progress"), "dir");

    expect(() =>
      publishNumberedArchive(root, "progress", 1, record("progress", 1), {
        sourceRoot: REPO_ROOT,
      }),
    ).toThrow(/symbolic link|escapes/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
