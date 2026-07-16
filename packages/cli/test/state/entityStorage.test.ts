import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  allocateEntityId,
  discoverEntities,
  publishEntity,
  validateEntityState,
} from "../../src/state/entityStorage.js";

const roots: string[] = [];
const publicationWorker = fileURLToPath(new URL("./entityPublicationWorker.mjs", import.meta.url));

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-entities-"));
  roots.push(root);
  return root;
}

function publicationProcess(
  root: string,
  artifact: string,
  boundary: string,
  resultPath: string,
  readyPath: string,
  startPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [publicationWorker], {
      cwd: path.resolve(import.meta.dirname, "../.."),
      env: {
        ...process.env,
        AGENTERA_ENTITY_TEST_ROOT: root,
        AGENTERA_ENTITY_TEST_ARTIFACT: artifact,
        AGENTERA_ENTITY_TEST_BOUNDARY: boundary,
        AGENTERA_ENTITY_TEST_RESULT: resultPath,
        AGENTERA_ENTITY_TEST_READY: readyPath,
        AGENTERA_ENTITY_TEST_START: startPath,
      },
      stdio: "pipe",
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`publication worker exited ${code}: ${stderr}`)));
  });
}

async function waitForFiles(paths: string[], timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!paths.every((candidate) => fs.existsSync(candidate))) {
    if (Date.now() >= deadline) throw new Error(`publication workers did not become ready: ${paths.join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function concurrentPublication(root: string, suffix = ""): Promise<Array<{ published: boolean; error?: string }>> {
  const healthResult = path.join(root, `health${suffix}-result.json`);
  const decisionsResult = path.join(root, `decisions${suffix}-result.json`);
  const healthReady = path.join(root, `health${suffix}.ready`);
  const decisionsReady = path.join(root, `decisions${suffix}.ready`);
  const startPath = path.join(root, `publication${suffix}.start`);
  const workers = [
    publicationProcess(root, "health", "health_audit", healthResult, healthReady, startPath),
    publicationProcess(root, "decisions", "decision", decisionsResult, decisionsReady, startPath),
  ];
  await waitForFiles([healthReady, decisionsReady]);
  fs.writeFileSync(startPath, "start\n");
  await Promise.all(workers);
  return [healthResult, decisionsResult].map((file) => JSON.parse(fs.readFileSync(file, "utf8")) as { published: boolean; error?: string });
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

  it("replays recursively reordered mapping keys without changing the published bytes", () => {
    const root = project();
    const first = publishEntity({
      projectRoot: root,
      artifact: "progress",
      boundary: "progress_cycle",
      id: "aaaaaaaaaa",
      record: { outer: { a: 1, b: 2 }, ordered: [{ c: 3, d: 4 }, "last"] },
    });
    const original = fs.readFileSync(first.path, "utf8");

    const replay = publishEntity({
      projectRoot: root,
      artifact: "progress",
      boundary: "progress_cycle",
      id: "aaaaaaaaaa",
      record: { ordered: [{ d: 4, c: 3 }, "last"], outer: { b: 2, a: 1 } },
    });

    expect(replay.replay).toBe(true);
    expect(fs.readFileSync(first.path, "utf8")).toBe(original);
    expect(() => publishEntity({
      projectRoot: root,
      artifact: "progress",
      boundary: "progress_cycle",
      id: "aaaaaaaaaa",
      record: { ordered: ["last", { c: 3, d: 4 }], outer: { a: 1, b: 2 } },
    })).toThrow(/divergent content.*aaaaaaaaaa/);
    expect(fs.readFileSync(first.path, "utf8")).toBe(original);
  });

  it("serializes multiprocess cross-artifact publication so exactly one writer wins", async () => {
    const root = project();
    const results = await concurrentPublication(root);
    expect(results.filter(({ published }) => published)).toHaveLength(1);
    expect(results.filter(({ published }) => !published)).toEqual([
      expect.objectContaining({ published: false, error: expect.stringMatching(/already exists.*owned by boundary/) }),
    ]);
    expect(discoverEntities(root).entities.filter(({ id }) => id === "zzzzzzzzzz")).toHaveLength(1);
    expect(fs.existsSync(path.join(root, ".agentera/.writer.lock"))).toBe(false);
  }, 30_000);

  it("repeatedly gives simultaneous stale-lock reclaimers one publisher and one explicit loser", async () => {
    for (const repeat of [1, 2, 3]) {
      const root = project();
      const lockPath = path.join(root, ".agentera/.writer.lock");
      fs.mkdirSync(lockPath, { recursive: true });
      fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
        pid: 999_999_999,
        token: "seeded-dead-owner",
        created_at: "2020-01-01T00:00:00Z",
      }));
      const results = await concurrentPublication(root, `-stale-${repeat}`);
      expect(results.filter(({ published }) => published), `repeat ${repeat}`).toHaveLength(1);
      expect(results.filter(({ published }) => !published), `repeat ${repeat}`).toEqual([
        expect.objectContaining({ published: false, error: expect.stringMatching(/already exists.*owned by boundary/) }),
      ]);
      expect(discoverEntities(root).entities.filter(({ id }) => id === "zzzzzzzzzz"), `repeat ${repeat}`).toHaveLength(1);
      expect(fs.existsSync(lockPath), `repeat ${repeat}`).toBe(false);
      expect(
        fs.readdirSync(path.join(root, ".agentera")).filter((name) => name.startsWith(".writer.")),
        `repeat ${repeat}`,
      ).toEqual([]);
    }
  }, 30_000);

  it("cleans the project-wide claim after publication fails and permits recovery", () => {
    const root = project();
    const blockingPath = path.join(root, ".agentera/entities/health");
    fs.mkdirSync(path.dirname(blockingPath), { recursive: true });
    fs.writeFileSync(blockingPath, "not a directory\n");

    expect(() => publishEntity({ projectRoot: root, artifact: "health", boundary: "health_audit", id: "aaaaaaaaaa", record: {} })).toThrow();
    expect(fs.existsSync(path.join(root, ".agentera/.writer.lock"))).toBe(false);

    fs.unlinkSync(blockingPath);
    expect(publishEntity({ projectRoot: root, artifact: "health", boundary: "health_audit", id: "aaaaaaaaaa", record: {} })).toMatchObject({ replay: false });
    expect(discoverEntities(root).entities.filter(({ id }) => id === "aaaaaaaaaa")).toHaveLength(1);
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
