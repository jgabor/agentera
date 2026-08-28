import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  coordinateDevelopmentReadiness,
  READINESS_CONTRACT,
} from "../../scripts/release-readiness.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const SCRIPT = path.join(REPO_ROOT, "packages/cli/scripts/release-readiness.mjs");
const temporary: string[] = [];

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function writeManifest(repo: string, version: string, gitRef: string): void {
  const file = path.join(repo, "packages/cli/package.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({
    name: "agentera",
    version,
    agentera: { suiteVersion: "3.0.0", gitRef },
  }, null, 2)}\n`);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-release-readiness-test-"));
  temporary.push(root);
  const repo = path.join(root, "repo");
  const candidateDirectory = path.join(root, "candidate");
  fs.mkdirSync(repo);
  git(repo, "init", "--quiet");
  git(repo, "config", "user.name", "Release Readiness Test");
  git(repo, "config", "user.email", "release-readiness@example.invalid");
  git(repo, "config", "commit.gpgsign", "false");
  writeManifest(repo, "3.0.0-dev.42", "0".repeat(40));
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "seed");
  const priorCommit = git(repo, "rev-parse", "HEAD");
  writeManifest(repo, "3.0.0-dev.42", priorCommit);
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "source ready");
  const sourceCommit = git(repo, "rev-parse", "HEAD");
  return {
    root,
    repo,
    candidateDirectory,
    sourceCommit,
  };
}

function operations() {
  const counters = {
    sourceIssues: 0,
    sourceChecks: 0,
    candidateIssues: 0,
    candidateChecks: 0,
    candidateConstructions: 0,
  };
  const artifactName = "agentera-3.0.0-dev.42.tgz";
  const artifactBytes = Buffer.from("exact retained readiness candidate");
  return {
    counters,
    artifactName,
    artifactBytes,
    issueSource: async ({ candidateDirectory }: { candidateDirectory: string }) => {
      counters.sourceIssues += 1;
      fs.mkdirSync(candidateDirectory, { recursive: true });
      fs.writeFileSync(path.join(candidateDirectory, "source-receipt.json"), "valid-source\n", { flag: "wx" });
      return {
        reused: false,
        receipt: { receiptSha256: "a".repeat(64) },
        gates: Array.from({ length: 11 }, (_, index) => ({ name: `gate-${index + 1}` })),
      };
    },
    checkSource: ({ candidateDirectory }: { candidateDirectory: string }) => {
      counters.sourceChecks += 1;
      if (fs.readFileSync(path.join(candidateDirectory, "source-receipt.json"), "utf8") !== "valid-source\n") {
        throw new Error("source receipt no longer matches current component inputs");
      }
      return { receiptSha256: "a".repeat(64) };
    },
    issueCandidate: (input: {
      candidateDirectory: string;
      sourceCommit: string;
    }) => {
      expect(input).not.toHaveProperty("targetVersion");
      const { candidateDirectory, sourceCommit } = input;
      counters.candidateIssues += 1;
      counters.candidateConstructions += 1;
      expect(sourceCommit).toMatch(/^[0-9a-f]{40}$/);
      fs.writeFileSync(path.join(candidateDirectory, artifactName), artifactBytes, { flag: "wx", mode: 0o444 });
      fs.writeFileSync(path.join(candidateDirectory, "candidate-receipt.json"), "valid-candidate\n", { flag: "wx" });
      return { reused: false, receipt: { receiptSha256: "b".repeat(64) } };
    },
    validateCandidate: ({ candidateDirectory }: { candidateDirectory: string }) => {
      counters.candidateChecks += 1;
      if (
        fs.readFileSync(path.join(candidateDirectory, "candidate-receipt.json"), "utf8") !== "valid-candidate\n"
        || !fs.readFileSync(path.join(candidateDirectory, artifactName)).equals(artifactBytes)
      ) {
        throw new Error("package artifact changed after verification");
      }
      return { receipt: { receiptSha256: "b".repeat(64) } };
    },
  };
}

function request(value: ReturnType<typeof fixture>, metadataCommit?: string) {
  return {
    adapter: "development",
    candidateDirectory: value.candidateDirectory,
    sourceCommit: value.sourceCommit,
    ...(metadataCommit ? { metadataCommit } : {}),
  };
}

afterEach(() => {
  while (temporary.length) fs.rmSync(temporary.pop()!, { recursive: true, force: true });
});

describe("development release readiness coordinator", () => {
  it("runs each owner once across the review pause and reuses both receipts on replay", async () => {
    const value = fixture();
    const owners = operations();
    const before = {
      head: git(value.repo, "rev-parse", "HEAD"),
      manifest: fs.readFileSync(path.join(value.repo, "packages/cli/package.json")),
    };
    const options = {
      repo: value.repo,
      issueSource: owners.issueSource,
      checkSource: owners.checkSource,
      issueCandidate: owners.issueCandidate,
      validateCandidate: owners.validateCandidate,
    };

    const fresh = await coordinateDevelopmentReadiness(request(value), options);
    expect(fresh).toMatchObject({
      schemaVersion: "agentera.releaseReadiness.v1",
      outcome: "paused",
      state: "awaiting_metadata_review",
      phase: "metadata-review",
      source: { status: "created", executed: "ordered-gates", reused: false },
      candidate: { status: "blocked_by_metadata_review", executed: "none", reused: false },
      execution: {
        sourceQualificationInvocations: 1,
        sourceGateExecutions: 11,
        candidateQualificationInvocations: 0,
        candidateConstructionExecutions: 0,
      },
      prohibitedEffects: {
        metadataChanged: false,
        commitCreated: false,
        approvalCreated: false,
        candidateRebuilt: false,
        registryMutated: false,
      },
    });
    expect(owners.counters).toEqual({
      sourceIssues: 1,
      sourceChecks: 0,
      candidateIssues: 0,
      candidateChecks: 0,
      candidateConstructions: 0,
    });
    expect(git(value.repo, "rev-parse", "HEAD")).toBe(before.head);
    expect(fs.readFileSync(path.join(value.repo, "packages/cli/package.json"))).toEqual(before.manifest);
    expect(fs.readdirSync(value.candidateDirectory)).toEqual(["source-receipt.json"]);

    const pausedReplay = await coordinateDevelopmentReadiness(request(value), options);
    expect(pausedReplay).toMatchObject({
      outcome: "paused",
      source: { status: "reused", executed: "none", reused: true },
      execution: {
        sourceQualificationInvocations: 0,
        sourceGateExecutions: 0,
        candidateQualificationInvocations: 0,
        candidateConstructionExecutions: 0,
      },
    });

    const metadataCommit = git(value.repo, "rev-parse", "HEAD");
    const ready = await coordinateDevelopmentReadiness(request(value, metadataCommit), options);
    expect(ready).toMatchObject({
      outcome: "ready",
      state: "ready_for_approval",
      phase: "candidate-readiness",
      package: "development",
      version: "3.0.0-dev.42",
      expectedTag: "next",
      executed: "candidate-qualification",
      reused: false,
      source: { status: "reused", executed: "none", reused: true },
      candidate: { status: "created", executed: "ordered-gates", reused: false },
      execution: {
        sourceQualificationInvocations: 0,
        sourceGateExecutions: 0,
        candidateQualificationInvocations: 1,
        candidateConstructionExecutions: 1,
      },
    });
    expect(owners.counters).toEqual({
      sourceIssues: 1,
      sourceChecks: 2,
      candidateIssues: 1,
      candidateChecks: 0,
      candidateConstructions: 1,
    });

    const artifact = path.join(value.candidateDirectory, owners.artifactName);
    const candidateReceipt = path.join(value.candidateDirectory, "candidate-receipt.json");
    const retained = {
      artifact: fs.readFileSync(artifact),
      artifactMtime: fs.statSync(artifact).mtimeMs,
      receipt: fs.readFileSync(candidateReceipt),
      receiptMtime: fs.statSync(candidateReceipt).mtimeMs,
    };
    const replay = await coordinateDevelopmentReadiness(request(value, metadataCommit), options);
    expect(replay).toMatchObject({
      outcome: "ready",
      executed: "none",
      reused: true,
      source: { status: "reused", executed: "none", reused: true },
      candidate: { status: "reused", executed: "none", reused: true },
      execution: {
        sourceQualificationInvocations: 0,
        sourceGateExecutions: 0,
        candidateQualificationInvocations: 0,
        candidateConstructionExecutions: 0,
      },
    });
    expect(owners.counters.candidateIssues).toBe(1);
    expect(owners.counters.candidateConstructions).toBe(1);
    expect(owners.counters.candidateChecks).toBe(1);
    expect(fs.readFileSync(artifact)).toEqual(retained.artifact);
    expect(fs.statSync(artifact).mtimeMs).toBe(retained.artifactMtime);
    expect(fs.readFileSync(candidateReceipt)).toEqual(retained.receipt);
    expect(fs.statSync(candidateReceipt).mtimeMs).toBe(retained.receiptMtime);

    fs.chmodSync(artifact, 0o644);
    fs.appendFileSync(artifact, "tampered");
    const rejected = await coordinateDevelopmentReadiness(request(value, metadataCommit), options);
    expect(rejected).toMatchObject({
      outcome: "rejected",
      phase: "candidate-readiness",
      candidate: { status: "rejected", executed: "none", reused: false },
      execution: {
        candidateQualificationInvocations: 0,
        candidateConstructionExecutions: 0,
      },
      detail: "package artifact changed after verification",
    });
    expect(owners.counters.candidateIssues).toBe(1);
    expect(owners.counters.candidateConstructions).toBe(1);
  });

  it("rejects stale source evidence before metadata or candidate effects", async () => {
    const value = fixture();
    const owners = operations();
    const options = {
      repo: value.repo,
      issueSource: owners.issueSource,
      checkSource: owners.checkSource,
      issueCandidate: owners.issueCandidate,
      validateCandidate: owners.validateCandidate,
    };
    await coordinateDevelopmentReadiness(request(value), options);
    const manifest = fs.readFileSync(path.join(value.repo, "packages/cli/package.json"));
    const head = git(value.repo, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(value.candidateDirectory, "source-receipt.json"), "stale-source\n");

    const rejected = await coordinateDevelopmentReadiness(request(value), options);
    expect(rejected).toMatchObject({
      outcome: "rejected",
      state: "rejected",
      phase: "source-readiness",
      source: { status: "rejected", executed: "none", reused: false },
      candidate: { status: "blocked", executed: "none", reused: false },
      execution: {
        sourceQualificationInvocations: 0,
        sourceGateExecutions: 0,
        candidateQualificationInvocations: 0,
        candidateConstructionExecutions: 0,
      },
    });
    expect(owners.counters.sourceIssues).toBe(1);
    expect(owners.counters.sourceChecks).toBe(1);
    expect(owners.counters.candidateIssues).toBe(0);
    expect(fs.readFileSync(path.join(value.repo, "packages/cli/package.json"))).toEqual(manifest);
    expect(git(value.repo, "rev-parse", "HEAD")).toBe(head);
    expect(fs.readdirSync(value.candidateDirectory)).toEqual(["source-receipt.json"]);
  });

  it("has stable help, JSON failure output, stderr diagnostics, and documented exits", () => {
    const help = spawnSync(process.execPath, [SCRIPT, "--help"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(help.status).toBe(READINESS_CONTRACT.exitCodes.paused);
    expect(help.stdout).toContain("release-readiness.mjs development");
    expect(help.stdout).not.toContain("--target-version");
    expect(help.stdout).toContain("Exit codes: 0 paused or ready; 1 rejected or invalid usage.");
    expect(help.stderr).toBe("");

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-release-readiness-cli-"));
    temporary.push(root);
    const candidateDirectory = path.join(root, "candidate");
    const before = fs.readFileSync(path.join(REPO_ROOT, "packages/cli/package.json"));
    const rejected = spawnSync(process.execPath, [
      SCRIPT,
      "development",
      "--candidate-dir",
      candidateDirectory,
      "--source-commit",
      "invalid",
      "--json",
    ], { cwd: REPO_ROOT, encoding: "utf8" });
    expect(rejected.status).toBe(READINESS_CONTRACT.exitCodes.rejected);
    expect(JSON.parse(rejected.stdout)).toMatchObject({
      schemaVersion: "agentera.releaseReadiness.v1",
      outcome: "rejected",
      state: "rejected",
      phase: "preflight",
      source: { status: "not_checked", executed: "none", reused: false },
      candidate: { status: "blocked", executed: "none", reused: false },
    });
    expect(rejected.stderr).toContain("release-readiness: --source-commit must be an explicit");
    expect(fs.existsSync(candidateDirectory)).toBe(false);
    expect(fs.readFileSync(path.join(REPO_ROOT, "packages/cli/package.json"))).toEqual(before);

    const obsolete = spawnSync(process.execPath, [
      SCRIPT,
      "development",
      "--candidate-dir",
      candidateDirectory,
      "--target-version",
      "3.0.0-dev.73",
      "--source-commit",
      "0".repeat(40),
      "--json",
    ], { cwd: REPO_ROOT, encoding: "utf8" });
    expect(obsolete.status).toBe(READINESS_CONTRACT.exitCodes.rejected);
    expect(obsolete.stderr).toContain("unexpected argument '--target-version'");
    expect(fs.existsSync(candidateDirectory)).toBe(false);
  });
});
