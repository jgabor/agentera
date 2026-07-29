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
  return runCli(project, [
    "state", "progress", "append", "--project", project,
    "--type", "test", "--phase", "build", "--what", `process ${suffix}`,
    "--intent", "prove serialization", "--format", "json",
    ...(caveat ? [
      "--glossary-caveat-event", "current",
      "--glossary-caveat-reason", "inferred_equivalence",
      "--glossary-caveat-ownership-state", "review_required",
    ] : []),
  ]);
}

function runCli(
  project: string,
  args: string[],
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
      const args = ["state", "decisions", "amend", "--project", project, "--id", id, "--base-sha256", sha256, "--choice", "Entity revisions", "--format", "json"];
      const results = await Promise.all(Array.from({ length: 8 }, () => runCli(project, args)));
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
