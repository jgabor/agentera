import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  allocateEntityId,
  discoverEntities,
  publishEntity,
  validateEntityState,
} from "../../src/state/entityStorage.js";

const roots: string[] = [];
function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-entities-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("entity identity allocation", () => {
  it("uses injectable candidates and retries project-wide collisions", () => {
    const root = project();
    publishEntity({ projectRoot: root, artifact: "progress", boundary: "progress_cycle", id: "aaaaaaaaaa", record: {} });
    const candidates = ["aaaaaaaaaa", "bbbbbbbbbb"];
    expect(allocateEntityId(root, () => candidates.shift()!)).toBe("bbbbbbbbbb");
  });

  it("generates exactly ten lowercase letters with secure production randomness", () => {
    const id = allocateEntityId(project());
    expect(id).toMatch(/^[a-z]{10}$/);
  });
});

describe("entity discovery and publication", () => {
  it("classifies valid, duplicate, malformed, and unsafe entities deterministically", () => {
    const root = project();
    publishEntity({ projectRoot: root, artifact: "progress", boundary: "progress_cycle", id: "aaaaaaaaaa", record: {} });
    publishEntity({ projectRoot: root, artifact: "decisions", boundary: "decision", id: "bbbbbbbbbb", record: {} });

    const duplicate = path.join(root, ".agentera/entities/health/health_audit/aaaaaaaaaa.yaml");
    fs.mkdirSync(path.dirname(duplicate), { recursive: true });
    fs.writeFileSync(duplicate, "id: aaaaaaaaaa\nartifact: health\nrecord: {}\n");
    const malformed = path.join(root, ".agentera/entities/decisions/decision/NOT-AN-ID.yaml");
    fs.writeFileSync(malformed, "id: NOT-AN-ID\nartifact: decisions\nrecord: {}\n");
    fs.symlinkSync(os.tmpdir(), path.join(root, ".agentera/entities/plan"));

    const result = discoverEntities(root);
    expect(result.entities.map(({ classification, relativePath }) => [classification, relativePath])).toEqual([
      ["duplicate", ".agentera/entities/health/health_audit/aaaaaaaaaa.yaml"],
      ["duplicate", ".agentera/entities/progress/progress_cycle/aaaaaaaaaa.yaml"],
      ["malformed", ".agentera/entities/decisions/decision/NOT-AN-ID.yaml"],
      ["unsafe", ".agentera/entities/plan"],
      ["valid", ".agentera/entities/decisions/decision/bbbbbbbbbb.yaml"],
    ]);
    expect(result.issues.some((issue) => issue.code === "unsafe_path" && issue.path === ".agentera/entities/plan")).toBe(true);
  });

  it("does not traverse a symlinked entity root", () => {
    const root = project();
    const outside = project();
    fs.mkdirSync(path.join(root, ".agentera"));
    fs.writeFileSync(path.join(outside, "escape.yaml"), "id: aaaaaaaaaa\nartifact: progress\nrecord: {}\n");
    fs.symlinkSync(outside, path.join(root, ".agentera/entities"));

    const result = discoverEntities(root);
    expect(result.entities).toEqual([
      expect.objectContaining({ classification: "unsafe", relativePath: ".agentera/entities" }),
    ]);
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "unsafe_path", path: ".agentera/entities" }),
    ]);
  });

  it("publishes separate files, replays identical content, and rejects divergent same-ID content", () => {
    const root = project();
    const first = publishEntity({ projectRoot: root, artifact: "progress", boundary: "progress_cycle", id: "aaaaaaaaaa", record: { what: "one" } });
    const second = publishEntity({ projectRoot: root, artifact: "decisions", boundary: "decision", id: "bbbbbbbbbb", record: { topic: "two" } });
    const replay = publishEntity({ projectRoot: root, artifact: "progress", boundary: "progress_cycle", id: "aaaaaaaaaa", record: { what: "one" } });

    expect(first.replay).toBe(false);
    expect(second.path).not.toBe(first.path);
    expect(replay.replay).toBe(true);
    expect(() => publishEntity({ projectRoot: root, artifact: "progress", boundary: "progress_cycle", id: "aaaaaaaaaa", record: { what: "changed" } })).toThrow(/divergent content.*aaaaaaaaaa/);
    expect(fs.readFileSync(first.path, "utf8")).toContain("what: one");
  });

  it("rejects a duplicate ID owned by another artifact", () => {
    const root = project();
    publishEntity({ projectRoot: root, artifact: "progress", boundary: "progress_cycle", id: "aaaaaaaaaa", record: {} });
    expect(() => publishEntity({ projectRoot: root, artifact: "health", boundary: "health_audit", id: "aaaaaaaaaa", record: {} })).toThrow(/already exists.*progress_cycle/);
  });
});

describe("whole-state entity validation", () => {
  it("reports duplicate IDs, invalid artifacts, unresolved links, and conflicting ownership with recovery", () => {
    const root = project();
    publishEntity({ projectRoot: root, artifact: "plan", boundary: "plan", id: "aaaaaaaaaa", record: {} });
    publishEntity({ projectRoot: root, artifact: "plan", boundary: "plan_task", id: "bbbbbbbbbb", record: { plan: "missinglink", depends_on: [] } });

    const entityRoot = path.join(root, ".agentera/entities");
    fs.mkdirSync(path.join(entityRoot, "bogus/decision"), { recursive: true });
    fs.writeFileSync(path.join(entityRoot, "bogus/decision/cccccccccc.yaml"), "id: cccccccccc\nartifact: bogus\nrecord: {}\n");
    fs.mkdirSync(path.join(entityRoot, "health/decision"), { recursive: true });
    fs.writeFileSync(path.join(entityRoot, "health/decision/aaaaaaaaaa.yaml"), "id: aaaaaaaaaa\nartifact: health\nrecord: {}\n");

    const result = validateEntityState(root);
    expect(result.valid).toBe(false);
    expect(new Set(result.issues.map((issue) => issue.code))).toEqual(new Set([
      "duplicate_id",
      "invalid_artifact",
      "unresolved_relation",
      "conflicting_ownership",
    ]));
    for (const issue of result.issues) {
      expect(issue.path).toMatch(/^\.agentera\/entities\//);
      expect(issue.recovery).toMatch(/agentera check validate state/);
    }
    expect(result.issues.find((issue) => issue.code === "unresolved_relation")).toMatchObject({
      id: "bbbbbbbbbb",
      relation: "plan",
      targetId: "missinglink",
    });
  });

  it("accepts declared relationships that resolve to exactly one target boundary", () => {
    const root = project();
    publishEntity({ projectRoot: root, artifact: "plan", boundary: "plan", id: "aaaaaaaaaa", record: {} });
    publishEntity({ projectRoot: root, artifact: "plan", boundary: "plan_task", id: "bbbbbbbbbb", record: { plan: "aaaaaaaaaa", depends_on: [] } });
    expect(validateEntityState(root)).toMatchObject({ valid: true, issues: [], entityCount: 2 });
  });
});
