import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { dumpYamlMapping } from "../../src/core/yaml.js";
import { runBackfill } from "../../src/cli/commands/backfill.js";
import { main } from "../../src/cli/dispatch/index.js";
import { publishNumberedArchive } from "../../src/state/archivePublication.js";
import {
  applyGitBackfill,
  inspectGitBackfill,
  previewGitBackfill,
} from "../../src/state/gitBackfill.js";

const sourceRoot = path.resolve(import.meta.dirname, "../../../..");
const gitEvidence = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "../fixtures/git-backfill-real-repository-evidence.json"), "utf8"),
) as {
  expected_total_calls: number;
  expected_categories: Record<string, number>;
  forbidden_operations: string[];
};
const roots: string[] = [];

function project(prefix = "agentera-git-backfill-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function git(root: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return String(result.stdout ?? "").trim();
}

function init(root: string): void {
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "backfill-test@example.invalid"]);
  git(root, ["config", "user.name", "Backfill Test"]);
  git(root, ["config", "commit.gpgsign", "false"]);
}

function progress(number: number, what: string): Record<string, unknown> {
  return {
    number,
    timestamp: "2026-07-13 18:00",
    type: "test",
    phase: "build",
    what,
    context: { intent: "Exercise exact Git backfill" },
  };
}

function writeProgress(root: string, records: Record<string, unknown>[], file = ".agentera/progress.yaml"): void {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, dumpYamlMapping({ cycles: records }));
}

function commit(root: string, message: string): string {
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
}

function addRefFixtures(root: string): void {
  git(root, ["branch", "fixture-head"]);
  git(root, ["tag", "fixture-tag"]);
  git(root, ["update-ref", "refs/remotes/origin/fixture", "HEAD"]);
  git(root, ["update-ref", "refs/custom/fixture", "HEAD"]);
}

function readProjection(root: string): string {
  return fs.readFileSync(path.join(root, ".agentera/progress.yaml"), "utf8");
}

function realGitRunner(args: string[], cwd: string) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    timedOut: false,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Git legacy backfill", () => {
  it("inventories provenance and previews immutable bytes without writing", () => {
    const root = project();
    init(root);
    writeProgress(root, [progress(1, "Recover this exact cycle")]);
    const commitHash = commit(root, "legacy cycle");
    const projectionBefore = readProjection(root);

    const inventory = inspectGitBackfill(root, { artifact: "progress", number: 1 }, { sourceRoot, runGit: realGitRunner });
    expect(inventory.entries[0]).toMatchObject({
      entry_id: "progress:1",
      commit: commitHash,
      path: ".agentera/progress.yaml",
      ambiguity_reason: "none",
      eligible: true,
      reachable: true,
    });
    expect(inventory.entries[0]?.blob_id).toMatch(/^[0-9a-f]{40}$/);
    expect(inventory.entries[0]?.content_hash).toMatch(/^[0-9a-f]{64}$/);

    const preview = previewGitBackfill(root, { artifact: "progress", number: 1 }, { sourceRoot, runGit: realGitRunner });
    expect(preview).toMatchObject({
      mode: "preview",
      status: "complete",
      read_only: true,
      scan: { commits_limit: 500, history_bytes_limit: 16777216 },
      source_contract: {
        supported_artifacts: ["progress", "decisions", "health"],
        limits: { results: 100, history_units: 500, history_bytes: 16777216 },
        reachable_refs: ["HEAD", "refs/heads", "refs/tags"],
        excluded_refs: ["refs/remotes", "custom_refs"],
        consent: { preview: "optional_read_only", apply: "--apply --force" },
        revalidation: expect.stringContaining("immutable-target"),
        ambiguity_reasons: expect.arrayContaining(["changed_head", "candidate_changed", "immutable_conflict"]),
        recovery: {
          operation: expect.stringContaining("same exact selectors"),
          retry: "identical_publication_is_idempotent",
        },
        traceability: {
          provenance_fields: ["commit", "path", "blob_id", "entry_id", "content_hash", "reachable"],
        },
      },
    });
    expect(preview.entries[0]?.proposed_archive_bytes).toContain("schemaVersion: agentera.stateArchiveEntry.v1");
    expect(fs.existsSync(path.join(root, ".agentera/archive/progress/1.yaml"))).toBe(false);
    expect(readProjection(root)).toBe(projectionBefore);
  });

  it("persists real-repository Git call evidence and scans only allowed refs", () => {
    const root = project("agentera-git-backfill-real-refs-");
    init(root);
    writeProgress(root, [progress(15, "Real ref evidence")]);
    commit(root, "real ref evidence");
    addRefFixtures(root);
    const calls: string[][] = [];
    const runner = (args: string[], cwd: string) => {
      calls.push([...args]);
      return realGitRunner(args, cwd);
    };

    const result = previewGitBackfill(
      root,
      { artifact: "progress", number: 15 },
      { sourceRoot, runGit: runner },
    );
    expect(result.status).toBe("complete");
    expect(result.scan.reachable_refs).toEqual(
      expect.arrayContaining(["HEAD", "refs/heads/fixture-head", "refs/tags/fixture-tag"]),
    );
    expect(result.scan.reachable_refs).not.toEqual(expect.arrayContaining(["refs/remotes/origin/fixture", "refs/custom/fixture"]));
    expect(git(root, ["show-ref", "refs/remotes/origin/fixture"])).toMatch(/[0-9a-f]+/);
    expect(git(root, ["show-ref", "refs/custom/fixture"])).toMatch(/[0-9a-f]+/);
    expect(calls.length).toBe(gitEvidence.expected_total_calls);
    const categories = Object.fromEntries(
      [...new Set(calls.map((args) => args[0] ?? ""))]
        .sort()
        .map((command) => [command, calls.filter((args) => args[0] === command).length]),
    );
    expect(categories).toEqual(gitEvidence.expected_categories);
    expect(
      calls.some((args) => args.some((value) => gitEvidence.forbidden_operations.some((forbidden) => value.includes(forbidden)))),
    ).toBe(false);
    expect(
      calls.filter((args) => args[0] === "for-each-ref").every(
        (args) => args.includes("refs/heads") && args.includes("refs/tags") && !args.includes("refs/remotes"),
      ),
    ).toBe(true);
    expect(calls.filter((args) => args[0] === "log").every((args) =>
      args.some((value) => value.startsWith("refs/heads/")) &&
      args.some((value) => value.startsWith("refs/tags/")) &&
      !args.some((value) => value.startsWith("refs/remotes/")),
    )).toBe(true);
  });

  it("applies directly with force and revalidates changed candidates", () => {
    const root = project("agentera-git-backfill-direct-apply-");
    init(root);
    writeProgress(root, [progress(16, "Direct apply")]);
    commit(root, "direct apply");

    const direct = applyGitBackfill(root, { artifact: "progress", number: 16 }, { sourceRoot, runGit: realGitRunner });
    expect(direct).toMatchObject({ mode: "apply", status: "complete", counts: { applied: 1 } });
    expect(direct).not.toHaveProperty("preview_token");
    expect(direct).not.toHaveProperty("preview_receipt");

    const changed = project("agentera-git-backfill-changed-candidate-");
    init(changed);
    writeProgress(changed, [progress(17, "Original candidate")]);
    commit(changed, "changed candidate");
    let catFiles = 0;
    const changedCandidateRunner = (args: string[], cwd: string) => {
      const result = realGitRunner(args, cwd);
      if (args[0] === "cat-file" && args[1] === "-p") {
        catFiles += 1;
        if (catFiles === 2) return { ...result, stdout: dumpYamlMapping({ cycles: [progress(17, "Changed candidate")] }) };
      }
      return result;
    };
    const changedCandidate = applyGitBackfill(
      changed,
      { artifact: "progress", number: 17 },
      { sourceRoot, runGit: changedCandidateRunner },
    );
    expect(changedCandidate).toMatchObject({ status: "blocked", entries: [{ ambiguity_reason: "candidate_changed" }] });
    expect(changedCandidate).not.toHaveProperty("preview_receipt");
    expect(fs.existsSync(path.join(changed, ".agentera/archive/progress/17.yaml"))).toBe(false);
  });

  it("applies only after explicit intent and converges to replay without projection changes", () => {
    const root = project();
    init(root);
    writeProgress(root, [progress(2, "Publish exactly once")]);
    commit(root, "legacy cycle");
    const projectionBefore = readProjection(root);

    const first = applyGitBackfill(
      root,
      { artifact: "progress", number: 2 },
      { sourceRoot, runGit: realGitRunner },
    );
    expect(first.status).toBe("complete");
    expect(first.counts.applied).toBe(1);
    const archivePath = path.join(root, ".agentera/archive/progress/2.yaml");
    const archiveBefore = fs.readFileSync(archivePath, "utf8");

    const retry = applyGitBackfill(
      root,
      { artifact: "progress", number: 2 },
      { sourceRoot, runGit: realGitRunner },
    );
    expect(retry.status).toBe("complete");
    expect(retry.counts.replayed).toBe(1);
    expect(fs.readFileSync(archivePath, "utf8")).toBe(archiveBefore);
    expect(readProjection(root)).toBe(projectionBefore);
  });

  it("refuses conflicting versions and preserves projections and immutable bytes", () => {
    const root = project();
    init(root);
    writeProgress(root, [progress(3, "First version")]);
    commit(root, "first version");
    writeProgress(root, [progress(3, "Second version")]);
    commit(root, "second version");
    const projectionBefore = readProjection(root);

    const preview = previewGitBackfill(root, { artifact: "progress", number: 3 }, { sourceRoot, runGit: realGitRunner });
    expect(preview.entries[0]?.ambiguity_reason).toBe("conflicting_versions");
    expect(preview.entries[0]?.proposed_archive_bytes).toBeUndefined();

    const applied = applyGitBackfill(
      root,
      { artifact: "progress", number: 3 },
      { sourceRoot, runGit: realGitRunner },
    );
    expect(applied.status).toBe("blocked");
    expect(applied.counts.applied).toBe(0);
    expect(fs.existsSync(path.join(root, ".agentera/archive/progress/3.yaml"))).toBe(false);
    expect(readProjection(root)).toBe(projectionBefore);
  });

  it("reports shallow history as degraded and never applies it", () => {
    const origin = project("agentera-git-backfill-origin-");
    init(origin);
    writeProgress(origin, [progress(4, "Older cycle")]);
    commit(origin, "older cycle");
    writeProgress(origin, [progress(4, "Older cycle"), progress(5, "Newest cycle")]);
    commit(origin, "newest cycle");

    const shallow = project("agentera-git-backfill-shallow-");
    git(shallow, ["clone", "--quiet", "--depth", "1", "--no-local", origin, "."]);
    git(shallow, ["config", "user.email", "backfill-test@example.invalid"]);
    git(shallow, ["config", "user.name", "Backfill Test"]);
    const preview = previewGitBackfill(shallow, { artifact: "progress", number: 5 }, { sourceRoot, runGit: realGitRunner });
    expect(preview.status).toBe("degraded");
    expect(preview.entries[0]?.ambiguity_reason).toBe("shallow_history");

    const applied = applyGitBackfill(
      shallow,
      { artifact: "progress", number: 5 },
      { sourceRoot, runGit: realGitRunner },
    );
    expect(applied.status).toBe("blocked");
    expect(fs.existsSync(path.join(shallow, ".agentera/archive/progress/5.yaml"))).toBe(false);
  });

  it("distinguishes rewritten, missing, and historical paths", () => {
    const rewritten = project();
    init(rewritten);
    writeProgress(rewritten, [progress(6, "Rewritten full record")]);
    const oldCommit = commit(rewritten, "full record later rewritten");
    git(rewritten, ["checkout", "--quiet", "--orphan", "replacement"]);
    git(rewritten, ["branch", "-D", "main"]);
    fs.rmSync(path.join(rewritten, ".agentera"), { recursive: true, force: true });
    writeProgress(rewritten, [{ number: 6, summary: "Legacy summary only" }]);
    commit(rewritten, "replacement summary");
    const rewrittenResult = inspectGitBackfill(
      rewritten,
      { artifact: "progress", number: 6 },
      { sourceRoot, runGit: realGitRunner },
    );
    expect(rewrittenResult.entries.some((entry) => entry.ambiguity_reason === "history_rewritten")).toBe(true);
    expect(rewrittenResult.entries.some((entry) => entry.commit === oldCommit && !entry.reachable)).toBe(true);

    const missing = project();
    init(missing);
    writeProgress(missing, [progress(7, "Uncommitted only")]);
    const missingResult = inspectGitBackfill(
      missing,
      { artifact: "progress", number: 7 },
      { sourceRoot, runGit: realGitRunner },
    );
    expect(missingResult.entries[0]?.ambiguity_reason).toBe("missing_history");

    const renamed = project();
    init(renamed);
    writeProgress(renamed, [progress(8, "Path history")]);
    commit(renamed, "old path");
    fs.copyFileSync(
      path.join(renamed, ".agentera/progress.yaml"),
      path.join(renamed, ".agentera/progress-legacy.yaml"),
    );
    commit(renamed, "copy projection path history");
    const pathResult = inspectGitBackfill(
      renamed,
      { artifact: "progress", number: 8 },
      { sourceRoot, runGit: realGitRunner },
    );
    expect(pathResult.entries.some((entry) => entry.path?.startsWith(".agentera/progress"))).toBe(true);
  });

  it("bounds the final combined result when every target has rewritten provenance", () => {
    const root = project("agentera-git-backfill-result-bound-");
    init(root);
    writeProgress(root, Array.from({ length: 100 }, (_, index) => progress(index + 1, "Original full record")));
    const oldCommit = commit(root, "original full records");
    git(root, ["checkout", "--quiet", "--orphan", "replacement"]);
    git(root, ["branch", "-D", "main"]);
    fs.rmSync(path.join(root, ".agentera"), { recursive: true, force: true });
    writeProgress(
      root,
      Array.from({ length: 100 }, (_, index) => ({ number: index + 1, summary: "Replacement summary only" })),
    );
    commit(root, "replacement summaries");
    const calls: string[][] = [];
    const runner = (args: string[], cwd: string) => {
      calls.push([...args]);
      return realGitRunner(args, cwd);
    };

    const first = inspectGitBackfill(root, { artifact: "progress" }, { sourceRoot, runGit: runner });
    const second = inspectGitBackfill(root, { artifact: "progress" }, { sourceRoot, runGit: runner });

    expect(first.entries).toHaveLength(100);
    expect(first.entries.every((entry) => entry.commit === oldCommit && !entry.reachable)).toBe(true);
    expect(first).toMatchObject({
      status: "degraded",
      omitted: true,
      omitted_count: 100,
      omission_reason: "result_limit",
      continuation: {
        available: false,
        guidance: expect.stringContaining("--artifact ARTIFACT --number N"),
      },
      counts: { targets: 100 },
    });
    expect(second.entries).toEqual(first.entries);
    expect(second.omitted_count).toBe(first.omitted_count);
    expect(
      calls.some((args) => args.some((value) => gitEvidence.forbidden_operations.some((forbidden) => value.includes(forbidden)))),
    ).toBe(false);
  });

  it("shares the 500-commit budget with rewritten probes and keeps classification deterministic", () => {
    const root = project("agentera-git-backfill-history-budget-");
    init(root);
    writeProgress(root, [progress(14, "Current projection")]);
    const head = "f".repeat(40);
    const reachable = Array.from({ length: 499 }, (_, index) => (index + 1).toString(16).padStart(40, "0"));
    const rewritten = "e".repeat(40);
    const truncated = "d".repeat(40);
    const blob = "c".repeat(40);
    const reachableLog = reachable.map((commitHash) => `${commitHash}\nM\t.agentera/progress.yaml`).join("\n");

    function runnerFixture(): { calls: string[][]; runner: typeof realGitRunner } {
      const calls: string[][] = [];
      let logCalls = 0;
      const runner = (args: string[], cwd: string) => {
        calls.push([...args]);
        if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return { status: 0, stdout: "true\n", timedOut: false };
        if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { status: 0, stdout: `${root}\n`, timedOut: false };
        if (args[0] === "rev-parse" && args[1] === "--verify") return { status: 0, stdout: `${head}\n`, timedOut: false };
        if (args[0] === "rev-parse" && args[1] === "--is-shallow-repository") return { status: 0, stdout: "false\n", timedOut: false };
        if (args[0] === "for-each-ref") return { status: 0, stdout: "refs/heads/main\n", timedOut: false };
        if (args[0] === "log") {
          logCalls += 1;
          return { status: 0, stdout: logCalls === 1 ? reachableLog : "", timedOut: false };
        }
        if (args[0] === "reflog") return { status: 0, stdout: `${rewritten}\n${truncated}\n`, timedOut: false };
        if (args[0] === "ls-tree" && args.includes(rewritten)) {
          return { status: 0, stdout: `100644 blob ${blob}\t.agentera/progress.yaml\0`, timedOut: false };
        }
        if (args[0] === "cat-file" && args[1] === "-p") {
          return { status: 0, stdout: dumpYamlMapping({ cycles: [progress(14, "Rewritten projection")] }), timedOut: false };
        }
        return { status: 0, stdout: "", timedOut: false };
      };
      return { calls, runner };
    }

    const firstFixture = runnerFixture();
    const first = inspectGitBackfill(root, { artifact: "progress", number: 14 }, { sourceRoot, runGit: firstFixture.runner });
    const secondFixture = runnerFixture();
    const second = inspectGitBackfill(root, { artifact: "progress", number: 14 }, { sourceRoot, runGit: secondFixture.runner });

    expect(first.scan).toMatchObject({ commits_limit: 500, commits_used: 500, bounded: true });
    expect(first.scan.bounded_reasons).toContain("commit_count");
    expect(first.entries.filter((entry) => entry.ambiguity_reason === "history_rewritten")).toHaveLength(2);
    expect(first.entries).toEqual(second.entries);
    expect(firstFixture.calls.find((args) => args[0] === "reflog")).toEqual(
      expect.arrayContaining(["--max-count", "1"]),
    );
    expect(firstFixture.calls.some((args) => args.includes(truncated))).toBe(false);
    for (const calls of [firstFixture.calls, secondFixture.calls]) {
      expect(
        calls.some((args) => args.some((value) => gitEvidence.forbidden_operations.some((forbidden) => value.includes(forbidden)))),
      ).toBe(false);
    }
  });

  it("does not let an unreachable reflog occurrence satisfy a pin", () => {
    const root = project();
    init(root);
    writeProgress(root, [progress(11, "Old reachable only before rewrite")]);
    const oldCommit = commit(root, "old pinned occurrence");
    git(root, ["checkout", "--quiet", "--orphan", "replacement"]);
    git(root, ["branch", "-D", "main"]);
    fs.rmSync(path.join(root, ".agentera"), { recursive: true, force: true });
    writeProgress(root, [progress(11, "Current replacement occurrence")]);
    commit(root, "replacement occurrence");

    const result = inspectGitBackfill(
      root,
      { artifact: "progress", number: 11, commit: oldCommit },
      { sourceRoot, runGit: realGitRunner },
    );
    expect(result.status).toBe("blocked");
    expect(result.entries[0]).toMatchObject({
      ambiguity_reason: "no_matching_pin",
      eligible: false,
      reachable: false,
    });
    expect(result.entries[0]?.provenance.some((value) => value.commit === oldCommit && !value.reachable)).toBe(true);
  });

  it("reports unavailable Git as actionable without blocking local state and excludes remote refs", () => {
    const root = project("agentera-git-backfill-unavailable-");
    const calls: string[][] = [];
    const unavailableRunner = (args: string[], cwd: string) => {
      calls.push(args);
      return { status: 128, stdout: "", timedOut: false, error: "not_repository" };
    };
    const result = previewGitBackfill(
      root,
      { artifact: "progress", number: 13 },
      { sourceRoot, runGit: unavailableRunner },
    );
    expect(result).toMatchObject({
      status: "unavailable",
      read_only: true,
      remote_contact: false,
      active_projections_unchanged: true,
    });
    expect(result.entries[0]).toMatchObject({
      entry_id: "progress:13",
      ambiguity_reason: "git_unavailable",
      eligible: false,
    });
    expect(calls.some((args) => args.some((value) => /remote|custom|fetch|pull|push|ls-remote/.test(value)))).toBe(false);
    expect(fs.existsSync(path.join(root, ".agentera", "archive"))).toBe(false);
  });

  it("refuses an interrupted exact apply before publication and only probes allowed refs", () => {
    const root = project("agentera-git-backfill-interrupted-");
    init(root);
    writeProgress(root, [progress(14, "Interrupted recovery")]);
    commit(root, "interrupted recovery");
    const calls: string[][] = [];
    let refEnumeration = 0;
    const interruptedRunner = (args: string[], cwd: string) => {
      calls.push(args);
      if (args[0] === "for-each-ref") {
        refEnumeration += 1;
        if (refEnumeration === 2) return { status: null, stdout: "", timedOut: true, error: "ETIMEDOUT" };
      }
      return realGitRunner(args, cwd);
    };
    const result = applyGitBackfill(
      root,
      { artifact: "progress", number: 14 },
      { sourceRoot, runGit: interruptedRunner },
    );
    expect(result).toMatchObject({ status: "blocked", remote_contact: false });
    expect(result.entries[0]).toMatchObject({
      entry_id: "progress:14",
      ambiguity_reason: "candidate_changed",
      operation: "refused",
    });
    expect(fs.existsSync(path.join(root, ".agentera", "archive", "progress", "14.yaml"))).toBe(false);
    expect(
      calls
        .filter((args) => args[0] === "for-each-ref")
        .every((args) => args.includes("refs/heads") && args.includes("refs/tags") && !args.includes("refs/remotes")),
    ).toBe(true);
    expect(calls.some((args) => args.some((value) => /fetch|pull|push|ls-remote|refs\/remotes|custom_refs/.test(value)))).toBe(false);
  });

  it("retains provenance for malformed historical content", () => {
    const root = project();
    init(root);
    fs.mkdirSync(path.join(root, ".agentera"), { recursive: true });
    fs.writeFileSync(path.join(root, ".agentera/progress.yaml"), "cycles: [malformed\n");
    const oldCommit = commit(root, "malformed historical projection");
    git(root, ["checkout", "--quiet", "--orphan", "replacement"]);
    git(root, ["branch", "-D", "main"]);
    fs.rmSync(path.join(root, ".agentera"), { recursive: true, force: true });
    writeProgress(root, [progress(12, "Current valid projection")]);
    commit(root, "valid replacement projection");

    const result = inspectGitBackfill(
      root,
      { artifact: "progress", number: 12 },
      { sourceRoot, runGit: realGitRunner },
    );
    expect(result.entries[0]?.ambiguity_reason).toBe("corrupt_history");
    expect(result.entries[0]?.provenance.some((value) => value.commit === oldCommit && value.content_hash === null)).toBe(true);
  });

  it("reports and enforces the shared history byte budget", () => {
    const root = project();
    init(root);
    writeProgress(root, [progress(13, "Bounded history")]);
    commit(root, "bounded history");
    const oversizedRunner = (args: string[], cwd: string) => {
      const result = realGitRunner(args, cwd);
      if (args[0] === "cat-file" && args[1] === "-p") {
        return { ...result, stdout: "x".repeat(16_777_217) };
      }
      return result;
    };

    const result = inspectGitBackfill(
      root,
      { artifact: "progress", number: 13 },
      { sourceRoot, runGit: oversizedRunner },
    );
    expect(result.status).toBe("degraded");
    expect(result.scan.history_bytes_used).toBeLessThanOrEqual(result.scan.history_bytes_limit);
    expect(result.scan.bounded_reasons).toContain("history_bytes");
    expect(result.entries[0]?.ambiguity_reason).toBe("scan_bounded");
  });

  it("refuses immutable conflicts and changed HEAD before publication", () => {
    const root = project();
    init(root);
    const record = progress(9, "Original immutable content");
    writeProgress(root, [record]);
    commit(root, "legacy cycle");
    publishNumberedArchive(root, "progress", 9, progress(9, "Different archive content"), { sourceRoot });
    const archivePath = path.join(root, ".agentera/archive/progress/9.yaml");
    const archiveBefore = fs.readFileSync(archivePath, "utf8");
    const projectionBefore = readProjection(root);
    const conflict = applyGitBackfill(
      root,
      { artifact: "progress", number: 9 },
      { sourceRoot, runGit: realGitRunner },
    );
    expect(conflict.status).toBe("blocked");
    expect(conflict.entries[0]?.ambiguity_reason).toBe("immutable_conflict");
    expect(fs.readFileSync(archivePath, "utf8")).toBe(archiveBefore);
    expect(readProjection(root)).toBe(projectionBefore);

    const changed = project();
    init(changed);
    writeProgress(changed, [progress(10, "Changed head guard")]);
    commit(changed, "legacy cycle");
    let headReads = 0;
    const changedHeadRunner = (args: string[], cwd: string) => {
      const result = realGitRunner(args, cwd);
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD^{commit}") {
        headReads += 1;
        if (headReads === 2) return { ...result, stdout: `${result.stdout.trim()}changed\n` };
      }
      return result;
    };
    const changedResult = applyGitBackfill(
      changed,
      { artifact: "progress", number: 10 },
      { sourceRoot, runGit: changedHeadRunner },
    );
    expect(changedResult.status).toBe("blocked");
    expect(changedResult.head.status).toBe("changed");
    expect(fs.existsSync(path.join(changed, ".agentera/archive/progress/10.yaml"))).toBe(false);
  });

  it("exposes the authority namespace and requires explicit force", () => {
    let out = "";
    const rc = main(["node", "agentera", "state", "backfill", "--apply", "--format", "json"], {
      out: (text) => (out += text),
      err: () => undefined,
    });
    expect(rc).toBe(2);
    expect(JSON.parse(out)).toMatchObject({
      schemaVersion: "agentera.invalidInputEnvelope.v2",
      error: {
        class: "invalid_request",
        message: "--apply requires explicit --force intent",
        syntax: expect.stringContaining("agentera state backfill"),
      },
    });

    const missingProjectRoot = project("agentera-git-backfill-missing-project-");
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(missingProjectRoot);
    let missingProjectOut = "";
    try {
      const missingProjectRc = runBackfill(
        ["--artifact", "progress", "--number", "1", "--apply", "--force", "--format", "json"],
        { out: (text) => (missingProjectOut += text), err: () => undefined },
        sourceRoot,
      );
      expect(missingProjectRc).toBe(2);
      expect(JSON.parse(missingProjectOut)).toMatchObject({
        schemaVersion: "agentera.invalidInputEnvelope.v2",
        error: {
          class: "invalid_request",
          message: "--apply requires explicit --project PATH",
          example: "agentera state backfill --project PATH --artifact progress --number 1 --apply --force --format json",
        },
      });
      expect(fs.existsSync(path.join(missingProjectRoot, ".agentera", "archive"))).toBe(false);
    } finally {
      cwd.mockRestore();
    }

    const root = project("agentera-git-backfill-cli-direct-apply-");
    init(root);
    writeProgress(root, [progress(1, "CLI direct apply")]);
    commit(root, "CLI direct apply");
    let forcedOut = "";
    const forcedRc = runBackfill(
      ["--project", root, "--artifact", "progress", "--number", "1", "--apply", "--force", "--format", "json"],
      { out: (text) => (forcedOut += text), err: () => undefined },
      sourceRoot,
    );
    expect(forcedRc).toBe(0);
    expect(JSON.parse(forcedOut)).toMatchObject({
      mode: "apply",
      status: "complete",
      counts: { applied: 1 },
      source_contract: {
        apply_requires: ["--apply", "--force", "--project PATH", "--artifact ARTIFACT", "--number N"],
      },
    });
    expect(JSON.parse(forcedOut)).not.toHaveProperty("preview_token");
    expect(JSON.parse(forcedOut)).not.toHaveProperty("preview_receipt");
  });

  it("fails before parsing or scanning when the authority cannot be loaded", () => {
    const root = project("agentera-git-backfill-authority-");
    const authority = path.join(root, "references/artifacts/state-storage-authority.yaml");
    fs.mkdirSync(path.dirname(authority), { recursive: true });
    fs.writeFileSync(authority, "schema_version: unsupported\n");
    let out = "";
    const rc = runBackfill(["--dry-run", "--format", "json"], { out: (text) => (out += text), err: () => undefined }, root);
    expect(rc).toBe(1);
    expect(JSON.parse(out)).toMatchObject({
      schemaVersion: "agentera.stateFailure.v1",
      status: "fail",
      error: {
        class: "unsupported_state",
        syntax: expect.stringContaining("agentera state backfill"),
        recovery: expect.stringContaining("no state was changed"),
      },
    });
  });
});
