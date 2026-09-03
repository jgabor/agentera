import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { assertRaceInvariant, concurrentPublication, publicationProcess, waitForFiles } from "../helpers/entityPublicationRace.js";

import { allocateEntityId, canonicalEntityEnvelope, canonicalEntityRecordViolations, discoverEntities, publishEntity, validateEntityState } from "../../src/state/entityStorage.js";
import { canonicalRecordJson } from "../../src/state/archiveDiscovery.js";

const roots: string[] = [];

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-entities-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".agentera"));
  fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
  return root;
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("entity identity allocation", () => {
  it("uses injectable candidates and retries project-wide collisions", () => {
    const root = project();
    publishEntity({
      projectRoot: root,
      artifact: "progress",
      boundary: "progress_cycle",
      id: "aaaaaaaaaa",
      record: {},
    });
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
    publishEntity({
      projectRoot: root,
      artifact: "progress",
      boundary: "progress_cycle",
      id: "aaaaaaaaaa",
      record: {},
    });
    publishEntity({
      projectRoot: root,
      artifact: "decisions",
      boundary: "decision",
      id: "bbbbbbbbbb",
      record: {
        date: "2026-07-17",
        question: "Q?",
        context: "C",
        alternatives: [],
        choice: "A",
        reasoning: "R",
        confidence: "firm",
      },
    });

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
    fs.mkdirSync(path.join(root, ".agentera"), { recursive: true });
    fs.writeFileSync(path.join(outside, "escape.yaml"), "id: aaaaaaaaaa\nartifact: progress\nrecord: {}\n");
    fs.symlinkSync(outside, path.join(root, ".agentera/entities"));

    const result = discoverEntities(root);
    expect(result.entities).toEqual([expect.objectContaining({ classification: "unsafe", relativePath: ".agentera/entities" })]);
    expect(result.issues).toEqual([expect.objectContaining({ code: "unsafe_path", path: ".agentera/entities" })]);
  });

  it("publishes separate files, replays identical content, and rejects divergent same-ID content", () => {
    const root = project();
    const first = publishEntity({
      projectRoot: root,
      artifact: "progress",
      boundary: "progress_cycle",
      id: "aaaaaaaaaa",
      record: { what: "one" },
    });
    const second = publishEntity({
      projectRoot: root,
      artifact: "decisions",
      boundary: "decision",
      id: "bbbbbbbbbb",
      record: { topic: "two" },
    });
    const replay = publishEntity({
      projectRoot: root,
      artifact: "progress",
      boundary: "progress_cycle",
      id: "aaaaaaaaaa",
      record: { what: "one" },
    });

    expect(first.replay).toBe(false);
    expect(second.path).not.toBe(first.path);
    expect(replay.replay).toBe(true);
    expect(() =>
      publishEntity({
        projectRoot: root,
        artifact: "progress",
        boundary: "progress_cycle",
        id: "aaaaaaaaaa",
        record: { what: "changed" },
      }),
    ).toThrow(/divergent content.*aaaaaaaaaa/);
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
    expect(() =>
      publishEntity({
        projectRoot: root,
        artifact: "progress",
        boundary: "progress_cycle",
        id: "aaaaaaaaaa",
        record: { ordered: ["last", { c: 3, d: 4 }], outer: { a: 1, b: 2 } },
      }),
    ).toThrow(/divergent content.*aaaaaaaaaa/);
    expect(fs.readFileSync(first.path, "utf8")).toBe(original);
  });

  it("serializes multiprocess cross-artifact publication so exactly one writer wins", async () => {
    const root = project();
    const { results } = await concurrentPublication(root);
    expect(results.filter(({ published }) => published)).toHaveLength(1);
    expect(results.filter(({ published }) => !published)).toEqual([
      expect.objectContaining({
        published: false,
        error: expect.stringMatching(/already exists.*owned by boundary/),
      }),
    ]);
    expect(discoverEntities(root).entities.filter(({ id }) => id === "zzzzzzzzzz")).toHaveLength(1);
    expect(fs.existsSync(path.join(root, ".agentera/.writer.lock"))).toBe(false);
  }, 30_000);

  it("waits across atomic owner publication and reports the canonical duplicate-ID loser", async () => {
    const root = project();
    const healthResult = path.join(root, "health-live-result.json");
    const healthReady = path.join(root, "health-live.ready");
    const healthStart = path.join(root, "health-live.start");
    const ownerOpenedPath = path.join(root, "health-live.owner-opened");
    const continuePath = path.join(root, "health-live.continue");
    const first = publicationProcess(root, "health", "health_audit", healthResult, healthReady, healthStart, {
      ownerOpenedPath,
      continuePath,
    });
    await waitForFiles([healthReady]);
    fs.writeFileSync(healthStart, "start\n");
    await waitForFiles([ownerOpenedPath]);
    const privateDirectory = fs.readdirSync(path.join(root, ".agentera")).find((name) => name.startsWith(".writer.") && name.endsWith(".tmp"));
    expect(privateDirectory).toBeDefined();
    expect(fs.readdirSync(path.join(root, ".agentera", privateDirectory!))).toEqual([".owner.json.tmp"]);

    const decisionsResult = path.join(root, "decisions-live-result.json");
    const decisionsReady = path.join(root, "decisions-live.ready");
    const decisionsStart = path.join(root, "decisions-live.start");
    const waitingPath = path.join(root, "decisions-live.waiting");
    const second = publicationProcess(root, "decisions", "decision", decisionsResult, decisionsReady, decisionsStart, {
      waitingPath,
    });
    await waitForFiles([decisionsReady]);
    fs.writeFileSync(decisionsStart, "start\n");
    try {
      await waitForFiles([waitingPath], 2_000);
      expect(fs.existsSync(healthResult)).toBe(false);
      expect(fs.existsSync(decisionsResult)).toBe(false);
    } finally {
      fs.writeFileSync(continuePath, "continue\n");
    }
    await Promise.all([first, second]);
    const results = [healthResult, decisionsResult].map((file) => JSON.parse(fs.readFileSync(file, "utf8")) as { published: boolean; error?: string });
    expect(results.filter(({ published }) => published)).toHaveLength(1);
    expect(results.filter(({ published }) => !published)).toEqual([
      expect.objectContaining({
        published: false,
        error: expect.stringMatching(/entity ID 'zzzzzzzzzz' already exists.*owned by boundary/),
      }),
    ]);
    expect(discoverEntities(root).entities.filter(({ id }) => id === "zzzzzzzzzz")).toHaveLength(1);
    expect(fs.readdirSync(path.join(root, ".agentera")).filter((name) => name.startsWith(".writer."))).toEqual([]);
  }, 30_000);

  it("gives simultaneous stale-lock reclaimers one publisher, one explicit loser, and no residue", async () => {
    const root = project();
    const lockPath = path.join(root, ".agentera/.writer.lock");
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(
      path.join(lockPath, "owner.json"),
      JSON.stringify({
        pid: 999_999_999,
        token: "seeded-dead-owner",
        created_at: "2020-01-01T00:00:00Z",
      }),
    );
    const race = await concurrentPublication(root, "-stale-source", { reclaimBarrier: true });
    const { results } = race;
    expect(race.reclaimOverlap).toBe(true);
    expect(results.filter(({ published }) => published)).toHaveLength(1);
    const losers = results.filter(({ published }) => !published);
    assertRaceInvariant(1, "explicit duplicate loser", losers.length === 1 && /entity ID 'zzzzzzzzzz' already exists.*owned by boundary/.test(losers[0]?.error ?? ""), results);
    expect(discoverEntities(root).entities.filter(({ id }) => id === "zzzzzzzzzz")).toHaveLength(1);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.readdirSync(path.join(root, ".agentera")).filter((name) => name.startsWith(".writer."))).toEqual([]);
  }, 30_000);

  it.each([
    ["nonzero", "worker completion", "injected worker failure"],
    ["malformed", "valid worker result", "malformed result"],
    ["timeout", "worker timeout", '"timedOut":true'],
  ] as const)("bounds and names %s worker infrastructure failures", async (fault, invariant, detail) => {
    const root = project();
    let failure: Error | undefined;
    try {
      await concurrentPublication(root, `-${fault}`, {
        repetition: 17,
        fault,
        timeoutMs: fault === "timeout" ? 100 : 2_000,
      });
    } catch (error) {
      failure = error as Error;
    }
    expect(failure?.message).toContain(`stale-lock race repetition 17 violated invariant '${invariant}'`);
    expect(failure?.message).toContain(detail);
    expect(Buffer.byteLength(failure?.message ?? "", "utf8")).toBeLessThanOrEqual(1_200);
    expect(fs.existsSync(path.join(root, ".agentera/.writer.lock"))).toBe(false);
    expect(fs.readdirSync(path.join(root, ".agentera")).filter((name) => name.startsWith(".writer."))).toEqual([]);
  });

  it("cleans the project-wide claim after publication fails and permits recovery", () => {
    const root = project();
    const blockingPath = path.join(root, ".agentera/entities/health");
    fs.mkdirSync(path.dirname(blockingPath), { recursive: true });
    fs.writeFileSync(blockingPath, "not a directory\n");

    expect(() =>
      publishEntity({
        projectRoot: root,
        artifact: "health",
        boundary: "health_audit",
        id: "aaaaaaaaaa",
        record: {},
      }),
    ).toThrow();
    expect(fs.existsSync(path.join(root, ".agentera/.writer.lock"))).toBe(false);

    fs.unlinkSync(blockingPath);
    expect(
      publishEntity({
        projectRoot: root,
        artifact: "health",
        boundary: "health_audit",
        id: "aaaaaaaaaa",
        record: {},
      }),
    ).toMatchObject({ replay: false });
    expect(discoverEntities(root).entities.filter(({ id }) => id === "aaaaaaaaaa")).toHaveLength(1);
  });

  it("rejects a duplicate ID owned by another artifact", () => {
    const root = project();
    publishEntity({
      projectRoot: root,
      artifact: "progress",
      boundary: "progress_cycle",
      id: "aaaaaaaaaa",
      record: {},
    });
    expect(() =>
      publishEntity({
        projectRoot: root,
        artifact: "health",
        boundary: "health_audit",
        id: "aaaaaaaaaa",
        record: {},
      }),
    ).toThrow(/already exists.*progress_cycle/);
  });
});

describe("whole-state entity validation", () => {
  const planRecord = {
    header: { title: "Plan", created: "2026-07-17", status: "open" },
    what: "Validate `.agentera/entities`.",
    why: "Relationships must resolve.",
    scope: { included: [], excluded: [] },
  };
  const taskRecord = (plan: string) => ({
    plan,
    name: "Validate",
    status: "pending",
    depends_on: [],
    acceptance: [],
  });
  it("reports duplicate IDs, invalid artifacts, unresolved links, and conflicting ownership with recovery", () => {
    const root = project();
    publishEntity({
      projectRoot: root,
      artifact: "plan",
      boundary: "plan",
      id: "aaaaaaaaaa",
      record: planRecord,
    });
    publishEntity({
      projectRoot: root,
      artifact: "plan",
      boundary: "plan_task",
      id: "bbbbbbbbbb",
      record: taskRecord("missinglink"),
    });

    const entityRoot = path.join(root, ".agentera/entities");
    fs.mkdirSync(path.join(entityRoot, "bogus/decision"), { recursive: true });
    fs.writeFileSync(path.join(entityRoot, "bogus/decision/cccccccccc.yaml"), "id: cccccccccc\nartifact: bogus\nrecord: {}\n");
    fs.mkdirSync(path.join(entityRoot, "health/decision"), { recursive: true });
    fs.writeFileSync(path.join(entityRoot, "health/decision/aaaaaaaaaa.yaml"), "id: aaaaaaaaaa\nartifact: health\nrecord: {}\n");

    const result = validateEntityState(root);
    expect(result.valid).toBe(false);
    expect(new Set(result.issues.map((issue) => issue.code))).toEqual(new Set(["duplicate_id", "invalid_artifact", "malformed_entity", "unresolved_relation", "conflicting_ownership"]));
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
    publishEntity({
      projectRoot: root,
      artifact: "plan",
      boundary: "plan",
      id: "aaaaaaaaaa",
      record: planRecord,
    });
    publishEntity({
      projectRoot: root,
      artifact: "plan",
      boundary: "plan_task",
      id: "bbbbbbbbbb",
      record: taskRecord("aaaaaaaaaa"),
    });
    expect(validateEntityState(root)).toMatchObject({ valid: true, issues: [], entityCount: 2 });
  });

  it("accepts exact degraded-summary records and rejects malformed provenance or identity aliases", () => {
    const root = project();
    const directory = path.join(root, ".agentera/entities/decisions/decision_summary");
    fs.mkdirSync(directory, { recursive: true });
    const source = {
      number: 1,
      summary: "retained decision evidence",
      satisfaction: { state: "user_confirmed_satisfied" },
    };
    const source_record_sha256 = createHash("sha256").update(canonicalRecordJson(source)).digest("hex");
    fs.writeFileSync(path.join(root, ".agentera/decisions.yaml"), `archive:\n  - number: 1\n    summary: retained decision evidence\n    satisfaction:\n      state: user_confirmed_satisfied\n`);
    fs.writeFileSync(
      path.join(directory, "aaaaaaaaaa.yaml"),
      `id: aaaaaaaaaa\nartifact: decisions\nrecord:\n  summary: retained decision evidence\n  satisfaction:\n    state: user_confirmed_satisfied\n  migration_provenance:\n    source_path: .agentera/decisions.yaml\n    source_record_sha256: ${source_record_sha256}\n`,
    );
    expect(validateEntityState(root)).toMatchObject({ valid: true, issues: [], entityCount: 1 });

    fs.writeFileSync(path.join(directory, "bbbbbbbbbb.yaml"), `id: bbbbbbbbbb\nartifact: decisions\nrecord:\n  number: 1\n  summary: retained decision evidence\n  migration_provenance:\n    source_path: .agentera/decisions.yaml\n    source_record_sha256: uppercase\n    extra: forbidden\n`);
    const invalid = validateEntityState(root);
    expect(invalid.valid).toBe(false);
    expect(invalid.issues.find((issue) => issue.path.endsWith("bbbbbbbbbb.yaml"))?.message).toContain("number is forbidden");
    expect(() =>
      publishEntity({
        projectRoot: root,
        artifact: "health",
        boundary: "health_summary",
        id: "cccccccccc",
        record: {
          summary: "ordinary writes must not publish summaries",
          migration_provenance: {
            source_path: ".agentera/health.yaml",
            source_record_sha256: "b".repeat(64),
          },
        },
      }),
    ).toThrow(/immutable migration-only/);
  });

  it("requires degraded-summary provenance to bind one declared source record and retained body", () => {
    const root = project();
    const directory = path.join(root, ".agentera/entities/progress/progress_summary");
    fs.mkdirSync(directory, { recursive: true });
    const source = { number: 1, summary: "retained progress evidence" };
    const digest = createHash("sha256").update(canonicalRecordJson(source)).digest("hex");
    const sourcePath = path.join(root, ".agentera/progress.yaml");
    const target = path.join(directory, "aaaaaaaaaa.yaml");
    const writeTarget = (summary = source.summary, sourceDigest = digest, provenancePath = ".agentera/progress.yaml") => {
      fs.writeFileSync(target, `id: aaaaaaaaaa\nartifact: progress\nrecord:\n  summary: ${summary}\n  migration_provenance:\n    source_path: ${provenancePath}\n    source_record_sha256: ${sourceDigest}\n`);
    };
    const writeSource = (rows = [source]) => fs.writeFileSync(sourcePath, `archive:\n${rows.map((row) => `  - number: ${row.number}\n    summary: ${row.summary}\n`).join("")}`);

    writeSource();
    writeTarget();
    expect(validateEntityState(root)).toMatchObject({ valid: true, issues: [] });
    const record = {
      summary: source.summary,
      migration_provenance: {
        source_path: ".agentera/progress.yaml",
        source_record_sha256: digest,
      },
    };
    expect(canonicalEntityRecordViolations("progress_summary", record)).toContain("migration_provenance requires a source binding context for a compacted summary");
    expect(() =>
      canonicalEntityEnvelope(fs.readFileSync(target, "utf8"), {
        artifact: "progress",
        boundary: "progress_summary",
        id: "aaaaaaaaaa",
      }),
    ).toThrow(/requires a source binding context/);
    expect(() =>
      canonicalEntityEnvelope(fs.readFileSync(target, "utf8"), { artifact: "progress", boundary: "progress_summary", id: "aaaaaaaaaa" }, undefined, {
        kind: "git_commit",
        commit: "not-a-commit",
        readSource: () => "archive: []\n",
      }),
    ).toThrow(/requires an immutable commit ID/);
    expect(
      canonicalEntityRecordViolations("progress_summary", record, undefined, {
        kind: "project",
        projectRoot: root,
      }),
    ).toEqual([]);
    expect(canonicalEntityEnvelope(fs.readFileSync(target, "utf8"), { artifact: "progress", boundary: "progress_summary", id: "aaaaaaaaaa" }, undefined, { kind: "project", projectRoot: root }).record).toEqual(record);

    writeTarget("fabricated retained content");
    expect(validateEntityState(root).issues[0]?.message).toContain("does not bind");
    writeTarget(source.summary, "b".repeat(64));
    expect(validateEntityState(root).issues[0]?.message).toContain("does not bind");
    writeTarget(source.summary, digest, ".agentera/decisions.yaml");
    expect(validateEntityState(root).issues[0]?.message).toContain("authority-declared preserved aggregate path");
    writeTarget();
    fs.rmSync(sourcePath);
    expect(validateEntityState(root).issues[0]?.message).toContain("is missing");
    writeSource([source, source]);
    expect(validateEntityState(root)).toMatchObject({ valid: true, issues: [] });
    fs.writeFileSync(sourcePath, "archive: [\n");
    expect(validateEntityState(root).issues[0]?.message).toContain("invalid YAML");
    fs.rmSync(sourcePath);
    const external = path.join(root, "outside-progress.yaml");
    fs.writeFileSync(external, "archive: []\n");
    fs.symlinkSync(external, sourcePath);
    expect(validateEntityState(root).issues[0]?.message).toContain("unsafe");
  });
});
