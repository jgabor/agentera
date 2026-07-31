import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { canonicalRecordJson } from "../../../src/state/archiveDiscovery.js";
import { dumpYamlMapping, loadYamlMapping } from "../../../src/core/yaml.js";
import { sourceBuildOutputRoot, sourceSubprocessEnv } from "../../helpers/sourceSubprocess.js";

const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const CLI = path.join(sourceBuildOutputRoot(), "bin/agentera.js");

function runProcess(
  project: string,
  suffix: string,
  caveat = false,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return runCli(project, ["state", "progress", "append", "--project", project, "--input", "-", "--format", "json"], JSON.stringify({
    timestamp: "2026-07-17 12:00", type: "test", phase: "build", what: `process ${suffix}`, context: { intent: "prove serialization" },
    ...(caveat ? { glossary_caveat: { event: "current", reason: "inferred_equivalence", ownership_state: "review_required" } } : {}),
  }));
}

function runCli(
  project: string,
  args: string[],
  stdin = "",
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: REPO_ROOT,
      env: sourceSubprocessEnv({ ...process.env, AGENTERA_BOOTSTRAP_SOURCE_ROOT: REPO_ROOT }),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

function decision(project: string): { id: string; sha256: string } {
  const id = "aaaaaaaaaa";
  const record = {
    date: "2026-07-29",
    question: "Where should decision state live?",
    context: "Concurrency must preserve one owner.",
    alternatives: [{ name: "Entities", status: "chosen" }],
    choice: "Canonical entities",
    reasoning: "One writer owns each mutation boundary.",
    confidence: "firm",
  };
  const directory = path.join(project, ".agentera/entities/decisions/decision");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${id}.yaml`), dumpYamlMapping({ id, artifact: "decisions", record }));
  return { id, sha256: createHash("sha256").update(canonicalRecordJson(record)).digest("hex") };
}

function entityProject(prefix: string): string {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(project, ".agentera"));
  fs.writeFileSync(path.join(project, ".agentera", "state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
  return project;
}

describe("real-process writer concurrency", () => {
  it("serializes concurrent current caveat replay to one progress entity", async () => {
    const project = entityProject("agentera-writer-caveat-");
    try {
      const results = await Promise.all([
        runProcess(project, "one", true),
        runProcess(project, "two", true),
      ]);
      expect(results.map((result) => result.code), JSON.stringify(results)).toEqual([0, 0]);
      const directory = path.join(project, ".agentera/entities/progress/progress_cycle");
      expect(fs.readdirSync(directory)).toHaveLength(1);
      const payloads = results.map((result) => JSON.parse(result.stdout));
      expect(new Set(payloads.map((payload) => payload.id)).size).toBe(1);
      expect(payloads.filter((payload) => payload.operation.idempotent_replay)).toHaveLength(1);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it("publishes concurrent same-artifact entities without lost entries or duplicate IDs", async () => {
    const project = entityProject("agentera-writer-same-");
    try {
      const results = await Promise.all([
        runProcess(project, "one"),
        runProcess(project, "two"),
      ]);
      expect(
        results.map((result) => result.code),
        JSON.stringify(results),
      ).toEqual([0, 0]);
      const directory = path.join(project, ".agentera/entities/progress/progress_cycle");
      const names = fs.readdirSync(directory);
      expect(names).toHaveLength(2);
      expect(new Set(names.map((name) => name.replace(/\.yaml$/, ""))).size).toBe(2);
      const records = names.map((name) => loadYamlMapping(fs.readFileSync(path.join(directory, name), "utf8")).record as Record<string, unknown>);
      expect(new Set(records.map((record) => record.what))).toEqual(new Set(["process one", "process two"]));
      expect(fs.existsSync(path.join(project, ".agentera/progress.yaml"))).toBe(false);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it("converges concurrent identical public progress appends", async () => {
    const project = entityProject("agentera-writer-progress-identical-");
    const args = ["state", "progress", "append", "--project", project, "--input", "-", "--format", "json"];
    const input = JSON.stringify({ timestamp: "2026-07-31 08:10", type: "fix", phase: "build", what: "identical public progress", context: { intent: "prove concurrent logical replay" } });
    try {
      const results = await Promise.all(Array.from({ length: 8 }, () => runCli(project, args, input)));
      expect(results.map(({ code }) => code), JSON.stringify(results)).toEqual(Array(8).fill(0));
      const payloads = results.map(({ stdout }) => JSON.parse(stdout));
      expect(new Set(payloads.map(({ id }) => id)).size).toBe(1);
      expect(payloads.filter(({ operation }) => operation.idempotent_replay)).toHaveLength(7);
      const directory = path.join(project, ".agentera/entities/progress/progress_cycle");
      expect(fs.readdirSync(directory)).toHaveLength(1);
      const record = loadYamlMapping(fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0]), "utf8")).record as Record<string, unknown>;
      expect(record.publication_order).toBe(1);
      expect(payloads.every(({ record: receipt }) => receipt.publication_order === 1)).toBe(true);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it("converges concurrent identical public decision appends", async () => {
    const project = entityProject("agentera-writer-decision-identical-");
    const args = ["state", "decisions", "append", "--project", project, "--input", "-", "--format", "json"];
    const input = JSON.stringify({ date: "2026-07-31", question: "Can decision append replay?", context: "Identical public requests share logical content.", alternatives: { chosen: "Yes", rejected: ["No"] }, choice: "Yes", reasoning: "The record is its logical identity.", confidence: "firm" });
    try {
      const results = await Promise.all(Array.from({ length: 8 }, () => runCli(project, args, input)));
      expect(results.map(({ code }) => code), JSON.stringify(results)).toEqual(Array(8).fill(0));
      const payloads = results.map(({ stdout }) => JSON.parse(stdout));
      expect(new Set(payloads.map(({ id }) => id)).size).toBe(1);
      expect(payloads.filter(({ operation }) => operation.idempotent_replay)).toHaveLength(7);
      expect(fs.readdirSync(path.join(project, ".agentera/entities/decisions/decision"))).toHaveLength(1);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it("converges concurrent satisfaction updates on one owner", async () => {
    const project = entityProject("agentera-writer-decision-update-");
    const { id } = decision(project);
    try {
      const args = ["state", "decisions", "update", "--project", project, "--id", id, "--satisfaction-state", "provisionally_satisfied", "--satisfaction-evidence", "verified", "--format", "json"];
      const results = await Promise.all(Array.from({ length: 8 }, () => runCli(project, args)));
      expect(results.map(({ code }) => code), JSON.stringify(results)).toEqual(Array(8).fill(0));
      const directory = path.join(project, ".agentera/entities/decisions/decision_satisfaction");
      expect(fs.readdirSync(directory)).toHaveLength(1);
      const payloads = results.map(({ stdout }) => JSON.parse(stdout));
      expect(new Set(payloads.map(({ id: owner }) => owner)).size).toBe(1);
      expect(payloads.filter(({ operation }) => operation.idempotent_replay)).toHaveLength(7);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it("converges concurrent identical amendments on one revision", async () => {
    const project = entityProject("agentera-writer-decision-amend-");
    const { id, sha256 } = decision(project);
    try {
      const args = ["state", "decisions", "amend", "--project", project, "--id", id, "--base-sha256", sha256, "--input", "-", "--format", "json"];
      const results = await Promise.all(Array.from({ length: 8 }, () => runCli(project, args, JSON.stringify({ choice: "Entity revisions" }))));
      expect(results.map(({ code }) => code), JSON.stringify(results)).toEqual(Array(8).fill(0));
      const directory = path.join(project, ".agentera/entities/decisions/decision_revision");
      expect(fs.readdirSync(directory)).toHaveLength(1);
      const payloads = results.map(({ stdout }) => JSON.parse(stdout));
      expect(new Set(payloads.map(({ id: owner }) => owner)).size).toBe(1);
      expect(payloads.filter(({ operation }) => operation.idempotent_replay)).toHaveLength(7);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

});
