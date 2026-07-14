import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../../../src/cli/dispatch.js";
import { lintFullArtifactPayload } from "../../../src/cli/commands/lint.js";
import { dumpYamlMapping, loadYamlMapping } from "../../../src/core/yaml.js";
import { ArtifactSchemaValidator } from "../../../src/hooks/validateArtifact/index.js";
import {
  InjectedMutationFailure,
  withStateMutation,
  type MutationFailureBoundary,
  type StateMutationOptions,
} from "../../../src/state/write/mutation.js";
import {
  executeStateWrite,
  type StateWriteRequest,
} from "../../../src/state/write/transaction.js";
import { operationSpec } from "../../../src/state/write/operations.js";
import { StateWriteInputError } from "../../../src/state/write/errors.js";
import { discoverNumberedArchives } from "../../../src/state/archiveDiscovery.js";
import { publishNumberedArchive } from "../../../src/state/archivePublication.js";
import { discoverPlanArtifacts, planCatalogEntry } from "../../../src/cli/planArtifacts.js";

interface Captured {
  rc: number;
  out: string;
  err: string;
  json: Record<string, any> | null;
}

const roots: string[] = [];

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-state-write-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function run(root: string, args: string[], stdin = ""): Captured {
  let out = "";
  let err = "";
  const argv = ["node", "agentera", "state", ...args, "--project", root];
  const rc = main(argv, {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    stdin: () => stdin,
  });
  let json: Record<string, any> | null = null;
  if (out.trim().startsWith("{")) json = JSON.parse(out) as Record<string, any>;
  return { rc, out, err, json };
}

function progressArgs(what = "Implemented writer"): string[] {
  return [
    "progress",
    "append",
    "--type",
    "feat",
    "--phase",
    "build",
    "--what",
    what,
    "--intent",
    "Ship typed writes",
    "--verified",
    "vitest",
    "--format",
    "json",
  ];
}

function decisionArgs(question = "Where should writes live?"): string[] {
  return [
    "decisions",
    "append",
    "--question",
    question,
    "--context",
    "The read side already lives under state",
    "--alternative-chosen",
    "state family",
    "--alternative-rejected",
    "top-level write",
    "--choice",
    "Use the state family",
    "--reasoning",
    "One artifact namespace",
    "--confidence",
    "firm",
    "--format",
    "json",
  ];
}

function lightPlan(title = "Writer plan", status = "open"): Record<string, unknown> {
  return {
    header: { level: "light", created: "2026-07-10", status, title },
    what: "Implement `state/write` artifact writes.",
    why: "Agents need a safe mutation path.",
    scope: { included: ["state writer"], excluded: ["vision"] },
    tasks: [
      { number: 1, name: "Implement", status: status === "complete" ? "complete" : "pending" },
    ],
  };
}

function historicalOverflowPlan(title = "Historical predecessor"): Record<string, unknown> {
  const plan = lightPlan(title);
  (plan.tasks as Array<Record<string, unknown>>)[0] = {
    number: 1,
    name: "Blocked historical task",
    status: "blocked",
    evaluation: {
      attempt_count: 2,
      failure_count: 2,
      last_verdict: "fail",
      last_failure_evidence: Array.from({ length: 2500 }, () => "src/evaluation.ts").join(" "),
      provenance: {
        attempt_id: "task-1-attempt-2",
        source: "focused audit",
        recorded_at: "2026-07-13 19:10",
        writer_command: "agentera state plan record-evaluation",
      },
    },
  };
  return plan;
}

function progressWrite(
  root: string,
  failAfter?: MutationFailureBoundary,
  options: StateMutationOptions = {},
) {
  const spec = operationSpec("progress", "append");
  if (!spec) throw new Error("progress append operation is unavailable");
  const payload = {
    type: "feat",
    phase: "build",
    what: "Prove transaction recovery",
    timestamp: "2026-07-13 12:00",
    context: { intent: "Test one crash-consistent mutation" },
  };
  const request: StateWriteRequest = {
    artifact: "progress",
    spec,
    projectRoot: root,
    dryRun: false,
    force: false,
    values: payload,
    callerPayload: payload,
    input: null,
  };
  return executeStateWrite(request, { ...options, ...(failAfter ? { failAfter } : {}) });
}

function writerStages(root: string): string[] {
  const stages: string[] = [];
  const walk = (directory: string): void => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(candidate);
      else if (entry.isFile() && entry.name.includes(".writer.")) stages.push(candidate);
    }
  };
  walk(path.join(root, ".agentera"));
  return stages;
}

function fullPlan(taskCount = 9): Record<string, unknown> {
  return {
    header: {
      level: "full",
      created: "2026-07-13",
      status: "open",
      reviewed: "2026-07-13",
      critic_issues: "1 found, 1 addressed, 0 dismissed",
      title: "Plan: Coherent task sequence",
    },
    what: "Deliver one coherent sequence of observable outcomes.",
    why: "The complete outcome depends on ordered work across several cycles.",
    scope: { included: ["coherent outcome"], excluded: ["unrelated work"], deferred: [] },
    design: "Sequence observable outcomes without prescribing implementation.",
    overall_acceptance:
      "GIVEN every task is complete WHEN the plan is evaluated THEN the coherent outcome is available.",
    unknowns: [
      {
        question: "Will the next outcome remain necessary after the prior outcome?",
        affects_task: 2,
        resolve_by: "Use the prior task evidence before beginning the next task.",
      },
    ],
    tasks: Array.from({ length: taskCount }, (_, index) => {
      const number = index + 1;
      const finalStateSync = number === taskCount;
      return {
        number,
        name: finalStateSync ? "Final state sync" : `Outcome ${number}`,
        depends_on: finalStateSync
          ? Array.from({ length: number - 1 }, (_, dependency) => String(dependency + 1))
          : number === 1
            ? []
            : [String(number - 1)],
        status: "pending",
        acceptance: [
          finalStateSync
            ? "GIVEN every prior task is complete WHEN the final state is checked THEN the plan outcome is synchronized."
            : `GIVEN the plan reaches outcome ${number} WHEN behavior is checked THEN outcome ${number} is available.`,
        ],
      };
    }),
    surprises: [],
  };
}

function writeInput(root: string, name: string, value: Record<string, unknown>): string {
  const p = path.join(root, name);
  fs.writeFileSync(p, dumpYamlMapping(value));
  return p;
}

function archiveFiles(root: string): string[] {
  const directory = path.join(root, ".agentera", "archive");
  return fs.existsSync(directory)
    ? fs.readdirSync(directory).filter((name) => name.startsWith("PLAN-")).sort()
    : [];
}

function planAtLastFullLintPass(): Record<string, unknown> {
  const candidate = lightPlan("Budget successor");
  for (let words = 2450; words < 2600; words += 1) {
    candidate.what = Array.from({ length: words }, () => "src/plan.ts").join(" ");
    if (lintFullArtifactPayload("plan", dumpYamlMapping(candidate)).status === "fail") {
      candidate.what = Array.from({ length: words - 1 }, () => "src/plan.ts").join(" ");
      return candidate;
    }
  }
  throw new Error("expected a full-file plan lint boundary");
}

function validAudit(): Record<string, unknown> {
  return {
    date: "2026-07-10",
    dimensions: ["architecture_alignment"],
    findings_summary: { critical: 0, warning: 0, info: 0, filtered_by_confidence: 0 },
    trajectory: "stable",
    grades: { architecture_alignment: "A" },
  };
}

describe("state writer discovery and progress", () => {
  it("explains live fields, defaults, budgets, compaction, and examples", () => {
    const root = project();
    const result = run(root, ["progress", "explain", "--verb", "append", "--format", "json"]);
    expect(result.rc).toBe(0);
    expect(result.json?.schemaVersion).toBe("agentera.stateWriteExplain.v1");
    expect(result.json?.next).toEqual({ number: 1 });
    expect(result.json?.budget).toEqual({
      per_entry_max_words: 500,
      full_file_max_words: 3000,
    });
    expect(result.json?.fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ flag: "--what", required: true })]),
    );
    expect(result.json?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          flag: "--timestamp",
          required: false,
          format: "YYYY-MM-DD HH:MM",
          default: "now",
        }),
      ]),
    );
    expect(result.json?.compaction).toContain("10 active full-detail and 40 archive entries");
    const health = run(root, ["health", "explain", "--verb", "append", "--format", "json"]);
    expect(health.json?.input_schema).toMatchObject({
      root: "one audit entry",
      cli_owned_fields: ["number"],
      groups: ["AUDIT", "DIMENSION", "FINDING", "TRENDS"],
    });
    expect(
      run(root, ["plan", "explain", "--verb", "update", "--format", "json"]).json?.example,
    ).toBe('agentera state plan update --task 1 --name "..." --format json');
    const taskStatus = run(root, ["plan", "explain", "--verb", "set-status", "--format", "json"])
      .json;
    expect(taskStatus?.example).toBe(
      "agentera state plan set-status --task 1 --status complete --format json",
    );
    expect(taskStatus?.fields).toEqual([
      expect.objectContaining({ flag: "--task", required: true }),
      expect.objectContaining({
        flag: "--status",
        valid_values: ["complete", "in_progress", "pending", "blocked"],
        description: "Task execution status. Does not change the plan lifecycle.",
      }),
    ]);
    const planStatus = run(root, ["plan", "explain", "--verb", "set-plan-status", "--format", "json"])
      .json;
    expect(planStatus?.example).toBe(
      "agentera state plan set-plan-status --status complete --format json",
    );
    expect(planStatus?.fields).toEqual([
      expect.objectContaining({
        flag: "--status",
        valid_values: ["open", "complete"],
        description: "Plan lifecycle status. Positional activity is derived from location.",
      }),
    ]);
  });

  it("assigns numbers, publishes schema-valid bytes, and exactly replays retries", () => {
    const root = project();
    const first = run(root, progressArgs());
    expect(first.rc).toBe(0);
    expect(first.json?.assigned.number).toBe(1);
    expect(first.json?.operation.idempotent_replay).toBe(false);
    const target = String(first.json?.path);
    const before = fs.readFileSync(target, "utf8");
    const second = run(root, progressArgs());
    expect(second.json?.operation.idempotent_replay).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe(before);
    const dryReplay = run(root, [...progressArgs().slice(0, -2), "--dry-run", "--format", "json"]);
    expect(dryReplay.json).toMatchObject({ diff: "", before: { cycles: expect.any(Array) } });
    expect(dryReplay.json?.after).toEqual(dryReplay.json?.before);
    const third = run(root, progressArgs("Implemented writer with docs"));
    expect(third.json?.assigned.number).toBe(2);
    const validator = new ArtifactSchemaValidator();
    expect(validator.validateExplicit("progress", target, root)).toEqual([]);
    expect(fs.existsSync(path.join(root, ".agentera", "archive", "progress", "1.yaml"))).toBe(true);
  });

  it("repairs duplicate health history through the validated writer without appending an audit", () => {
    const root = project();
    const target = path.join(root, ".agentera", "health.yaml");
    const audit = { number: 20, ...validAudit() };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      dumpYamlMapping({
        audits: [audit],
        archive: [
          "Audit 14 (2026-04-26): canonical history",
          "Audit 14 (2026-04-26): duplicate history",
          "Audit 13 (2026-04-25): unrelated history",
        ],
      }),
    );
    const beforeBytes = fs.readFileSync(target, "utf8");
    const duplicateText = "Audit 14 (2026-04-26): duplicate history";
    const duplicateOffset = beforeBytes.indexOf(duplicateText);
    expect(duplicateOffset).toBeGreaterThan(0);
    const duplicateLineStart = beforeBytes.lastIndexOf("\n", duplicateOffset - 1) + 1;
    const duplicateLineEnd = beforeBytes.indexOf("\n", duplicateOffset) + 1;
    const expectedBytes = beforeBytes.slice(0, duplicateLineStart) + beforeBytes.slice(duplicateLineEnd);
    const before = loadYamlMapping(fs.readFileSync(target, "utf8"));
    const dry = run(root, ["health", "repair", "--number", "14", "--keep", "first", "--force", "--dry-run", "--format", "json"]);
    expect(dry.rc).toBe(0);
    expect(loadYamlMapping(fs.readFileSync(target, "utf8"))).toEqual(before);

    const repaired = run(root, ["health", "repair", "--number", "14", "--keep", "first", "--force", "--format", "json"]);
    expect(repaired.rc).toBe(0);
    expect(fs.readFileSync(target, "utf8")).toBe(expectedBytes);
    const after = loadYamlMapping(fs.readFileSync(target, "utf8"));
    expect(after.audits).toEqual([audit]);
    expect(after.archive).toEqual([
      "Audit 14 (2026-04-26): canonical history",
      "Audit 13 (2026-04-25): unrelated history",
    ]);
    expect((repaired.json?.written as Record<string, unknown>)?.removed_rows).toBe(1);
    expect((repaired.json?.state as Record<string, unknown>)?.next_number).toBe(21);
    expect(new ArtifactSchemaValidator().validateExplicit("health", target, root)).toEqual([]);
  });

  it("recovers the original number when projection publication stops after archive publication", () => {
    const root = project();
    const target = path.join(root, ".agentera", "progress.yaml");
    const originalRename = fs.renameSync.bind(fs);
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(((from, to) => {
      if (String(from).includes(".writer.") && String(to) === target) {
        throw Object.assign(new Error("injected projection publication failure"), { code: "ENOSPC" });
      }
      return originalRename(from, to);
    }) as typeof fs.renameSync);
    try {
      expect(run(root, progressArgs(), "").rc).toBe(1);
      expect(fs.existsSync(path.join(root, ".agentera", "archive", "progress", "1.yaml"))).toBe(true);
      expect(fs.existsSync(target)).toBe(false);
    } finally {
      rename.mockRestore();
    }

    const retry = run(root, progressArgs());
    expect(retry.rc, retry.err || retry.out).toBe(0);
    expect(retry.json?.operation.idempotent_replay).toBe(true);
    expect(retry.json?.assigned.number).toBe(1);
    const projection = loadYamlMapping(fs.readFileSync(target, "utf8"));
    expect(projection.cycles).toHaveLength(1);
    expect((projection.cycles as Array<Record<string, unknown>>)[0]?.number).toBe(1);
  });

  it("dry-runs the final staged bytes without changing the filesystem", () => {
    const root = project();
    const first = run(root, progressArgs());
    const target = String(first.json?.path);
    const before = fs.readFileSync(target, "utf8");
    const dry = run(root, [
      ...progressArgs("Dry candidate").slice(0, -2),
      "--dry-run",
      "--format",
      "json",
    ]);
    expect(dry.rc).toBe(0);
    expect(dry.json?.operation.dry_run).toBe(true);
    expect(dry.json?.diff).toContain("+  - number: 2");
    expect(dry.json?.after.cycles).toHaveLength(2);
    expect(fs.readFileSync(target, "utf8")).toBe(before);
  });

  it("leaves a fresh project byte-for-byte empty after dry-run", () => {
    const root = project();
    const dry = run(root, [...progressArgs().slice(0, -2), "--dry-run", "--format", "json"]);
    expect(dry.rc).toBe(0);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("does not create a mapped artifact directory during dry-run", () => {
    const root = project();
    const dir = path.join(root, ".agentera");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "docs.yaml"),
      dumpYamlMapping({
        mapping: [{ artifact: "PROGRESS.md", path: "mapped/progress/progress.yaml" }],
      }),
    );

    const dry = run(root, [...progressArgs().slice(0, -2), "--dry-run", "--format", "json"]);
    expect(dry.rc).toBe(0);
    expect(fs.existsSync(path.join(root, "mapped"))).toBe(false);
  });

  it("compacts an eleventh full cycle on the staged file", () => {
    const root = project();
    const dir = path.join(root, ".agentera");
    fs.mkdirSync(dir, { recursive: true });
    const cycles = Array.from({ length: 10 }, (_, index) => ({
      number: 10 - index,
      timestamp: `2026-07-${String(10 - index).padStart(2, "0")} 10:00`,
      type: "feat",
      phase: "build",
      what: `Cycle ${10 - index}`,
      context: { intent: "fixture" },
    }));
    fs.writeFileSync(path.join(dir, "progress.yaml"), dumpYamlMapping({ cycles }));
    for (const cycle of cycles) publishNumberedArchive(root, "progress", cycle.number, cycle);
    const result = run(root, progressArgs("Cycle 11"));
    expect(result.rc).toBe(0);
    expect(result.json?.compaction).toMatchObject({
      changed: true,
      full_before: 11,
      full_after: 10,
      oneline_after: 1,
    });
    const doc = loadYamlMapping(fs.readFileSync(path.join(dir, "progress.yaml"), "utf8"));
    expect(doc.cycles).toHaveLength(10);
    expect(doc.archive).toHaveLength(1);
  });
});

describe("stable plan identity", () => {
  it("assigns identity at publication and retains it with explicit archived provenance", () => {
    const root = project();
    const input = writeInput(root, "plan-input.yaml", lightPlan("Identity transition", "complete"));
    const created = run(root, ["plan", "create", "--input", input, "--format", "json"]);
    expect(created.rc).toBe(0);

    const activePath = path.join(root, ".agentera", "plan.yaml");
    const activeDocument = loadYamlMapping(fs.readFileSync(activePath, "utf8"));
    const stableId = (activeDocument.header as Record<string, unknown>).id;
    expect(stableId).toMatch(/^plan:[0-9a-f-]{36}$/);
    const activeDiscovery = discoverPlanArtifacts(activePath);
    expect(planCatalogEntry(activeDiscovery.active!, activePath, activeDiscovery.identities[0])).toMatchObject({
      stable_id: stableId,
      addressable: true,
      provenance: { lifecycle_position: "active", storage: "active_plan_file" },
    });

    const archived = run(root, ["plan", "archive", "--format", "json"]);
    expect(archived.rc).toBe(0);
    const archivePath = String(archived.json?.state.archive_path);
    const archiveDocument = loadYamlMapping(fs.readFileSync(archivePath, "utf8"));
    expect((archiveDocument.header as Record<string, unknown>).id).toBe(stableId);
    const archivedDiscovery = discoverPlanArtifacts(activePath);
    expect(planCatalogEntry(archivedDiscovery.archived[0]!, activePath, archivedDiscovery.identities[0])).toMatchObject({
      stable_id: stableId,
      addressable: true,
      provenance: { lifecycle_position: "archived", storage: "immutable_plan_archive" },
    });
  });
});

describe("decisions, health, and plan operations", () => {
  it("appends decisions and applies the DV6 satisfaction contract", () => {
    const root = project();
    const appended = run(root, decisionArgs());
    expect(appended.rc).toBe(0);
    expect(appended.json?.written.alternatives).toEqual([
      { name: "state family", status: "chosen" },
      { name: "top-level write", status: "rejected" },
    ]);
    expect(run(root, decisionArgs()).json?.operation.idempotent_replay).toBe(true);
    const bad = run(root, [
      "decisions",
      "update",
      "--number",
      "1",
      "--satisfaction-state",
      "provisionally_satisfied",
      "--format",
      "json",
    ]);
    expect(bad.rc).toBe(2);
    expect(bad.json?.error.class).toBe("schema_violation");
    const updated = run(root, [
      "decisions",
      "update",
      "--number",
      "1",
      "--satisfaction-state",
      "provisionally_satisfied",
      "--satisfaction-evidence",
      "writer tests green",
      "--format",
      "json",
    ]);
    expect(updated.rc).toBe(0);
    expect(updated.json?.written.satisfaction).toEqual({
      state: "provisionally_satisfied",
      evidence: "writer tests green",
    });
    expect(
      run(root, [
        "decisions",
        "update",
        "--number",
        "1",
        "--satisfaction-state",
        "provisionally_satisfied",
        "--satisfaction-evidence",
        "writer tests green",
        "--format",
        "json",
      ]).json?.operation.idempotent_replay,
    ).toBe(true);
    const confirmed = run(root, [
      "decisions",
      "update",
      "--number",
      "1",
      "--satisfaction-state",
      "user_confirmed_satisfied",
      "--confirmed-by",
      "user",
      "--confirmed-at",
      "2026-07-10",
      "--format",
      "json",
    ]);
    expect(confirmed.rc).toBe(0);
    expect(confirmed.json?.written.satisfaction.user_confirmation).toEqual({
      confirmed_by: "user",
      confirmed_at: "2026-07-10",
    });
  });

  it("accepts health YAML/JSON from files or stdin and rejects CLI-owned fields", () => {
    const root = project();
    const input = writeInput(root, "audit.yaml", validAudit());
    const fileResult = run(root, ["health", "append", "--input", input, "--format", "json"]);
    expect(fileResult.rc).toBe(0);
    expect(fileResult.json?.assigned.number).toBe(1);
    expect(
      run(root, ["health", "append", "--input", input, "--format", "json"]).json?.operation
        .idempotent_replay,
    ).toBe(true);
    const stdinAudit = { ...validAudit(), date: "2026-07-11", trajectory: "improving" };
    const stdinResult = run(
      root,
      ["health", "append", "--input", "-", "--format", "json"],
      JSON.stringify(stdinAudit),
    );
    expect(stdinResult.rc).toBe(0);
    expect(stdinResult.json?.assigned.number).toBe(2);
    const owned = run(
      root,
      ["health", "append", "--input", "-", "--format", "json"],
      dumpYamlMapping({ number: 9, ...validAudit() }),
    );
    expect(owned.rc).toBe(2);
    expect(owned.json?.error.class).toBe("schema_violation");
  });

  it("appends health entries when legacy archive summaries are scalars", () => {
    const root = project();
    const dir = path.join(root, ".agentera");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "health.yaml"),
      dumpYamlMapping({
        audits: [{ number: 1, ...validAudit() }],
        archive: ["Audit 0: legacy scalar summary"],
      }),
    );
    const input = writeInput(root, "audit.yaml", {
      ...validAudit(),
      date: "2026-07-11",
      trajectory: "improving",
    });

    const result = run(root, ["health", "append", "--input", input, "--format", "json"]);
    expect(result.rc).toBe(0);
    expect(result.json?.assigned.number).toBe(2);
    expect(loadYamlMapping(fs.readFileSync(path.join(dir, "health.yaml"), "utf8")).archive).toEqual(
      ["Audit 0: legacy scalar summary"],
    );
  });

  it("creates, mutates, closes, archives, and idempotently retries a plan", () => {
    const root = project();
    const input = writeInput(root, "plan.yaml", lightPlan());
    const created = run(root, ["plan", "create", "--input", input, "--format", "json"]);
    expect(created.rc).toBe(0);
    expect(
      run(root, ["plan", "create", "--input", input, "--format", "json"]).json?.operation
        .idempotent_replay,
    ).toBe(true);
    const appended = run(root, [
      "plan",
      "append",
      "--name",
      "Add tests",
      "--depends-on",
      "1",
      "--acceptance",
      "GIVEN a write WHEN retried THEN it replays",
      "--format",
      "json",
    ]);
    expect(appended.json?.assigned.number).toBe(2);
    expect(
      run(root, [
        "plan",
        "append",
        "--name",
        "Add tests",
        "--depends-on",
        "1",
        "--acceptance",
        "GIVEN a write WHEN retried THEN it replays",
        "--format",
        "json",
      ]).json?.operation.idempotent_replay,
    ).toBe(true);
    const updated = run(root, [
      "plan",
      "update",
      "--task",
      "2",
      "--evidence",
      "focused tests",
      "--surprise",
      "validator needed health routing",
      "--format",
      "json",
    ]);
    expect(updated.rc).toBe(0);
    expect(
      run(root, [
        "plan",
        "update",
        "--task",
        "2",
        "--evidence",
        "focused tests",
        "--surprise",
        "validator needed health routing",
        "--format",
        "json",
      ]).json?.operation.idempotent_replay,
    ).toBe(true);
    expect(
      run(root, ["plan", "set-status", "--task", "1", "--status", "complete", "--format", "json"])
        .rc,
    ).toBe(0);
    expect(
      run(root, ["plan", "set-status", "--task", "2", "--status", "complete", "--format", "json"])
        .rc,
    ).toBe(0);
    expect(
      run(root, ["plan", "set-status", "--task", "2", "--status", "complete", "--format", "json"])
        .json?.operation.idempotent_replay,
    ).toBe(true);
    expect(
      run(root, ["plan", "set-plan-status", "--status", "complete", "--format", "json"])
        .rc,
    ).toBe(0);
    const archived = run(root, ["plan", "archive", "--format", "json"]);
    expect(archived.rc).toBe(0);
    expect(fs.existsSync(String(archived.json?.state.archive_path))).toBe(true);
    expect(fs.existsSync(path.join(root, ".agentera", "plan.yaml"))).toBe(false);
    expect(
      run(root, ["plan", "archive", "--format", "json"]).json?.operation.idempotent_replay,
    ).toBe(true);
  });

  it.each(["pending", "in_progress", "blocked"])("accepts the %s task status", (status) => {
    const root = project();
    const input = writeInput(root, "plan.yaml", lightPlan());
    expect(run(root, ["plan", "create", "--input", input, "--format", "json"]).rc).toBe(0);

    const result = run(root, [
      "plan",
      "set-status",
      "--task",
      "1",
      "--status",
      status,
      "--format",
      "json",
    ]);
    expect(result.rc).toBe(0);
    expect(result.json?.written.status).toBe(status);
  });

  it("records idempotent evaluator attempts and blocks the second failed evaluation", () => {
    const root = project();
    const input = writeInput(root, "plan.yaml", lightPlan());
    expect(run(root, ["plan", "create", "--input", input, "--format", "json"]).rc).toBe(0);
    const firstArgs = [
      "plan",
      "record-evaluation",
      "--task",
      "1",
      "--attempt-id",
      "audit-1",
      "--verdict",
      "fail",
      "--failure-evidence",
      "test/state/write/stateWrite.test.ts:1",
      "--provenance",
      "audit report 1",
      "--format",
      "json",
    ];
    const first = run(root, firstArgs);
    expect(first.rc).toBe(0);
    expect(first.json?.assigned).toMatchObject({ number: 1, attempt_count: 1, failure_count: 1 });
    expect(run(root, firstArgs).json?.operation.idempotent_replay).toBe(true);

    const second = run(root, [
      "plan",
      "record-evaluation",
      "--task",
      "1",
      "--attempt-id",
      "audit-2",
      "--verdict",
      "fail",
      "--failure-evidence",
      "test/state/write/stateWrite.test.ts:2",
      "--provenance",
      "audit report 2",
      "--format",
      "json",
    ]);
    expect(second.rc).toBe(0);
    expect(second.json?.written).toMatchObject({
      status: "blocked",
      evaluation: {
        attempt_count: 2,
        failure_count: 2,
        last_verdict: "fail",
        last_failure_evidence: "test/state/write/stateWrite.test.ts:2",
        provenance: { attempt_id: "audit-2", source: "audit report 2" },
      },
    });
    expect(
      run(root, [
        "plan",
        "record-evaluation",
        "--task",
        "1",
        "--attempt-id",
        "audit-3",
        "--verdict",
        "fail",
        "--failure-evidence",
        "third evaluation",
        "--provenance",
        "audit report 3",
        "--format",
        "json",
      ]).json?.error.class,
    ).toBe("conflict");
  });

  it("returns only a dependency-ready pending task from plan write state", () => {
    const root = project();
    const plan = lightPlan();
    plan.tasks = [
      { number: 1, name: "Blocked", status: "blocked" },
      { number: 2, name: "Dependent", status: "pending", depends_on: ["1"] },
    ];
    const input = writeInput(root, "plan.yaml", plan);
    const created = run(root, ["plan", "create", "--input", input, "--format", "json"]);
    expect(created.rc).toBe(0);
    expect(created.json?.state.next_pending_task).toBeNull();
  });

  it("enforces canonical plan writes and isolated status domains", () => {
    for (const status of ["open", "complete"]) {
      const root = project();
      const input = writeInput(root, "plan.yaml", lightPlan("Canonical", status));
      const created = run(root, ["plan", "create", "--input", input, "--format", "json"]);
      expect(created.rc).toBe(0);
      const plan = loadYamlMapping(fs.readFileSync(String(created.json?.path), "utf8"));
      expect(plan.header).toMatchObject({ status });
      expect(plan).not.toHaveProperty("active");
      expect(plan.header as Record<string, unknown>).not.toHaveProperty("active");
    }

    for (const status of ["active", "completed", "unknown"]) {
      const root = project();
      const input = writeInput(root, "plan.yaml", lightPlan("Legacy input", status));
      const rejected = run(root, ["plan", "create", "--input", input, "--format", "json"]);
      expect(rejected.rc).toBe(2);
      expect(rejected.json?.error.class).toBe("schema_violation");
    }

    const root = project();
    const input = writeInput(root, "plan.yaml", lightPlan());
    expect(run(root, ["plan", "create", "--input", input, "--format", "json"]).rc).toBe(0);
    expect(
      run(root, ["plan", "set-status", "--task", "1", "--status", "open", "--format", "json"])
        .json?.error.class,
    ).toBe("invalid_choice");
    expect(
      run(root, ["plan", "set-plan-status", "--status", "pending", "--format", "json"])
        .json?.error.class,
    ).toBe("invalid_choice");
    expect(
      run(root, ["plan", "set-plan-status", "--task", "1", "--status", "open", "--format", "json"])
        .json?.error.class,
    ).toBe("unrecognized_argument");
  });

  it("canonicalizes legacy current plans before archive and replacement", () => {
    const archiveRoot = project();
    const archivePlan = lightPlan("Legacy archive", "completed");
    (archivePlan.tasks as Array<Record<string, unknown>>)[0].status = "complete";
    fs.mkdirSync(path.join(archiveRoot, ".agentera"), { recursive: true });
    fs.writeFileSync(path.join(archiveRoot, ".agentera", "plan.yaml"), dumpYamlMapping(archivePlan));
    const archived = run(archiveRoot, ["plan", "archive", "--format", "json"]);
    expect(archived.rc).toBe(0);
    expect(
      loadYamlMapping(fs.readFileSync(String(archived.json?.state.archive_path), "utf8")).header,
    ).toMatchObject({ status: "complete" });

    const replaceRoot = project();
    const legacyPlan = lightPlan("Legacy predecessor", "completed");
    (legacyPlan.tasks as Array<Record<string, unknown>>)[0].status = "complete";
    fs.mkdirSync(path.join(replaceRoot, ".agentera"), { recursive: true });
    fs.writeFileSync(path.join(replaceRoot, ".agentera", "plan.yaml"), dumpYamlMapping(legacyPlan));
    const successor = writeInput(replaceRoot, "successor.yaml", lightPlan("Successor"));
    const replaced = run(replaceRoot, ["plan", "create", "--input", successor, "--format", "json"]);
    expect(replaced.rc).toBe(0);
    const active = loadYamlMapping(fs.readFileSync(path.join(replaceRoot, ".agentera", "plan.yaml"), "utf8"));
    expect(active.header).toMatchObject({ status: "open" });
    expect(
      loadYamlMapping(fs.readFileSync(String(replaced.json?.state.archive_path), "utf8")).header,
    ).toMatchObject({ status: "complete" });
  });

  it("does not create a mapped plan directory during create dry-run", () => {
    const root = project();
    const dir = path.join(root, ".agentera");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "docs.yaml"),
      dumpYamlMapping({ mapping: [{ artifact: "PLAN.md", path: "mapped/plans/plan.yaml" }] }),
    );
    const input = writeInput(root, "plan.yaml", lightPlan());

    const dry = run(root, ["plan", "create", "--input", input, "--dry-run", "--format", "json"]);
    expect(dry.rc).toBe(0);
    expect(fs.existsSync(path.join(root, "mapped"))).toBe(false);
  });

  it("archives a complete predecessor and injects lineage during plan replacement", () => {
    const root = project();
    const first = writeInput(root, "first.yaml", lightPlan("First", "complete"));
    expect(run(root, ["plan", "create", "--input", first, "--format", "json"]).rc).toBe(0);
    const second = writeInput(root, "second.yaml", lightPlan("Second"));
    const replaced = run(root, ["plan", "create", "--input", second, "--format", "json"]);
    expect(replaced.rc).toBe(0);
    const active = loadYamlMapping(
      fs.readFileSync(path.join(root, ".agentera", "plan.yaml"), "utf8"),
    );
    expect(active.previous_plan_archived).toMatch(/^\.agentera\/archive\/PLAN-/);
    expect(
      run(root, ["plan", "create", "--input", second, "--format", "json"]).json?.operation
        .idempotent_replay,
    ).toBe(true);
  });

  it("preserves exact CLI-owned overflow predecessors only on forced archive and replacement", () => {
    const replaceRoot = project();
    const predecessor = historicalOverflowPlan();
    predecessor.previous_plan_archived = ".agentera/archive/PLAN-prior.yaml";
    const predecessorBytes = dumpYamlMapping(predecessor);
    const target = path.join(replaceRoot, ".agentera", "plan.yaml");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, predecessorBytes);
    expect(lintFullArtifactPayload("plan", predecessorBytes).status).toBe("fail");

    const successor = writeInput(replaceRoot, "successor.yaml", lightPlan("Reviewed continuation"));
    const dryRun = run(replaceRoot, [
      "plan",
      "create",
      "--input",
      successor,
      "--force",
      "--dry-run",
      "--format",
      "json",
    ]);
    expect(dryRun.rc).toBe(0);
    expect(dryRun.json?.validation.diagnostics).toEqual([
      expect.stringContaining("historical predecessor accepted"),
    ]);
    expect(fs.readFileSync(target, "utf8")).toBe(predecessorBytes);
    expect(archiveFiles(replaceRoot)).toEqual([]);

    const replaced = run(replaceRoot, [
      "plan",
      "create",
      "--input",
      successor,
      "--force",
      "--format",
      "json",
    ]);
    expect(replaced.rc).toBe(0);
    const archivePath = String(replaced.json?.state.archive_path);
    expect(fs.readFileSync(archivePath, "utf8")).toBe(predecessorBytes);
    const archived = loadYamlMapping(fs.readFileSync(archivePath, "utf8"));
    expect(archived.tasks).toEqual(predecessor.tasks);
    expect(loadYamlMapping(fs.readFileSync(target, "utf8")).previous_plan_archived).toBe(
      path.relative(replaceRoot, archivePath),
    );

    const retryRoot = project();
    const retryPredecessorBytes = dumpYamlMapping(historicalOverflowPlan("Interrupted historical predecessor"));
    const retryTarget = path.join(retryRoot, ".agentera", "plan.yaml");
    fs.mkdirSync(path.dirname(retryTarget), { recursive: true });
    fs.writeFileSync(retryTarget, retryPredecessorBytes);
    const retrySuccessor = writeInput(retryRoot, "successor.yaml", lightPlan("Retry successor"));
    const originalRename = fs.renameSync.bind(fs);
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(((from, to) => {
      if (String(from).includes(".writer.") && String(to) === retryTarget)
        throw Object.assign(new Error("injected historical replacement interruption"), { code: "ENOSPC" });
      return originalRename(from, to);
    }) as typeof fs.renameSync);
    try {
      expect(
        run(retryRoot, [
          "plan",
          "create",
          "--input",
          retrySuccessor,
          "--force",
          "--format",
          "json",
        ]).rc,
      ).toBe(1);
      expect(fs.readFileSync(retryTarget, "utf8")).toBe(retryPredecessorBytes);
      expect(fs.readFileSync(path.join(retryRoot, ".agentera", "archive", archiveFiles(retryRoot)[0]), "utf8")).toBe(
        retryPredecessorBytes,
      );
    } finally {
      rename.mockRestore();
    }
    expect(
      run(retryRoot, [
        "plan",
        "create",
        "--input",
        retrySuccessor,
        "--force",
        "--format",
        "json",
      ]).rc,
    ).toBe(0);
    expect(archiveFiles(retryRoot)).toHaveLength(1);

    const archiveRoot = project();
    const archiveTarget = path.join(archiveRoot, ".agentera", "plan.yaml");
    fs.mkdirSync(path.dirname(archiveTarget), { recursive: true });
    fs.writeFileSync(archiveTarget, predecessorBytes);
    const archivedResult = run(archiveRoot, ["plan", "archive", "--force", "--format", "json"]);
    expect(archivedResult.rc).toBe(0);
    expect(fs.readFileSync(String(archivedResult.json?.state.archive_path), "utf8")).toBe(
      predecessorBytes,
    );
    expect(fs.existsSync(archiveTarget)).toBe(false);
  });

  it("rejects forced historical exceptions for malformed or user-authored predecessor state", () => {
    const malformedRoot = project();
    const malformedTarget = path.join(malformedRoot, ".agentera", "plan.yaml");
    fs.mkdirSync(path.dirname(malformedTarget), { recursive: true });
    fs.writeFileSync(malformedTarget, "header: [\n");
    const malformed = run(malformedRoot, ["plan", "archive", "--force", "--format", "json"]);
    expect(malformed.rc).toBe(1);
    expect(`${malformed.out}${malformed.err}`).toContain("cannot parse existing artifact");

    const schemaRoot = project();
    const schemaPlan = historicalOverflowPlan("Schema-invalid predecessor");
    (schemaPlan.tasks as Array<Record<string, unknown>>)[0].depends_on = ["missing-task"];
    const schemaTarget = path.join(schemaRoot, ".agentera", "plan.yaml");
    fs.mkdirSync(path.dirname(schemaTarget), { recursive: true });
    fs.writeFileSync(schemaTarget, dumpYamlMapping(schemaPlan));
    const schemaInvalid = run(schemaRoot, ["plan", "archive", "--force", "--format", "json"]);
    expect(schemaInvalid.rc).toBe(1);
    expect(`${schemaInvalid.out}${schemaInvalid.err}`).toContain("is schema-invalid");
    expect(archiveFiles(schemaRoot)).toEqual([]);

    const authoredRoot = project();
    const authoredPlan = historicalOverflowPlan("User-authored overflow");
    authoredPlan.what = Array.from({ length: 2500 }, () => "src/user-plan.ts").join(" ");
    const authoredTarget = path.join(authoredRoot, ".agentera", "plan.yaml");
    fs.mkdirSync(path.dirname(authoredTarget), { recursive: true });
    fs.writeFileSync(authoredTarget, dumpYamlMapping(authoredPlan));
    const authored = run(authoredRoot, ["plan", "archive", "--force", "--format", "json"]);
    expect(authored.rc).toBe(2);
    expect(authored.json?.error.violations).toEqual(
      expect.arrayContaining([expect.stringContaining("user-authored plan content")]),
    );
    expect(archiveFiles(authoredRoot)).toEqual([]);
    expect(fs.readFileSync(authoredTarget, "utf8")).toBe(dumpYamlMapping(authoredPlan));
  });

  it("does not let force bypass a new over-budget candidate", () => {
    const root = project();
    const candidate = writeInput(root, "over-budget.yaml", historicalOverflowPlan("New candidate"));
    const result = run(root, [
      "plan",
      "create",
      "--input",
      candidate,
      "--force",
      "--format",
      "json",
    ]);
    expect(result.rc).toBe(2);
    expect(result.json?.error.violations).toEqual(
      expect.arrayContaining([expect.stringContaining("strict prose lint verbosity")]),
    );
    expect(fs.existsSync(path.join(root, ".agentera", "plan.yaml"))).toBe(false);
  });

  it("recovers exact partial archives and refuses immutable archive collisions", () => {
    const recoverRoot = project();
    const input = writeInput(recoverRoot, "plan.yaml", lightPlan("Recoverable", "complete"));
    run(recoverRoot, ["plan", "create", "--input", input, "--format", "json"]);
    const preview = run(recoverRoot, ["plan", "archive", "--dry-run", "--format", "json"]);
    const archivePath = String(preview.json?.state.archive_path);
    fs.mkdirSync(path.dirname(archivePath), { recursive: true });
    fs.copyFileSync(path.join(recoverRoot, ".agentera", "plan.yaml"), archivePath);
    expect(run(recoverRoot, ["plan", "archive", "--format", "json"]).rc).toBe(0);
    expect(fs.existsSync(path.join(recoverRoot, ".agentera", "plan.yaml"))).toBe(false);

    const collisionRoot = project();
    const collisionInput = writeInput(
      collisionRoot,
      "plan.yaml",
      lightPlan("Collision", "complete"),
    );
    run(collisionRoot, ["plan", "create", "--input", collisionInput, "--format", "json"]);
    const collisionPreview = run(collisionRoot, [
      "plan",
      "archive",
      "--dry-run",
      "--format",
      "json",
    ]);
    const collisionPath = String(collisionPreview.json?.state.archive_path);
    fs.mkdirSync(path.dirname(collisionPath), { recursive: true });
    fs.writeFileSync(collisionPath, "different historical content\n");
    const before = fs.readFileSync(path.join(collisionRoot, ".agentera", "plan.yaml"), "utf8");
    const collision = run(collisionRoot, ["plan", "archive", "--format", "json"]);
    expect(collision.rc).toBe(2);
    expect(collision.json?.error.class).toBe("conflict");
    expect(fs.readFileSync(path.join(collisionRoot, ".agentera", "plan.yaml"), "utf8")).toBe(
      before,
    );
  });

  it("validates final lineaged bytes and rejects lint or schema failures before publication", () => {
    const lintRoot = project();
    const predecessor = writeInput(lintRoot, "predecessor.yaml", lightPlan("Predecessor", "complete"));
    expect(run(lintRoot, ["plan", "create", "--input", predecessor, "--format", "json"]).rc).toBe(0);
    const target = path.join(lintRoot, ".agentera", "plan.yaml");
    const before = fs.readFileSync(target, "utf8");
    const successor = planAtLastFullLintPass();
    expect(lintFullArtifactPayload("plan", dumpYamlMapping(successor)).status).toBe("pass");
    const lintResult = run(lintRoot, [
      "plan",
      "create",
      "--input",
      writeInput(lintRoot, "budget-successor.yaml", successor),
      "--format",
      "json",
    ]);
    expect(lintResult.rc).toBe(2);
    expect(lintResult.json?.error.class).toBe("schema_violation");
    expect(lintResult.json?.error.violations).toEqual(
      expect.arrayContaining([expect.stringContaining("strict prose lint verbosity")]),
    );
    expect(lintResult.json?.error.syntax).toBe(
      "agentera state plan create --input plan.yaml --format json",
    );
    expect(fs.readFileSync(target, "utf8")).toBe(before);
    expect(archiveFiles(lintRoot)).toEqual([]);

    const schemaRoot = project();
    const schemaPredecessor = writeInput(
      schemaRoot,
      "predecessor.yaml",
      lightPlan("Schema predecessor", "complete"),
    );
    expect(run(schemaRoot, ["plan", "create", "--input", schemaPredecessor, "--format", "json"]).rc).toBe(0);
    const schemaTarget = path.join(schemaRoot, ".agentera", "plan.yaml");
    const schemaBefore = fs.readFileSync(schemaTarget, "utf8");
    const invalid = { ...lightPlan("Schema successor"), unsupported_publication_field: true };
    const validate = vi.spyOn(ArtifactSchemaValidator.prototype, "validateYaml");
    try {
      const schemaResult = run(schemaRoot, [
        "plan",
        "create",
        "--input",
        writeInput(schemaRoot, "invalid-successor.yaml", invalid),
        "--format",
        "json",
      ]);
      expect(schemaResult.rc).toBe(2);
      expect(schemaResult.json?.error.violations).toEqual(
        expect.arrayContaining([expect.stringContaining("schema validation")]),
      );
      expect(validate.mock.calls.map(([bytes]) => bytes)).toEqual(
        expect.arrayContaining([
          expect.stringContaining("previous_plan_archived"),
          expect.stringContaining("unsupported_publication_field"),
        ]),
      );
    } finally {
      validate.mockRestore();
    }
    expect(fs.readFileSync(schemaTarget, "utf8")).toBe(schemaBefore);
    expect(archiveFiles(schemaRoot)).toEqual([]);
  });

  it("publishes a full plan with more than eight tasks while preserving dependencies", () => {
    const root = project();
    const input = writeInput(root, "nine-task-plan.yaml", fullPlan());
    const created = run(root, ["plan", "create", "--input", input, "--format", "json"]);

    expect(created.rc, created.err || created.out).toBe(0);
    expect(created.json?.state).toMatchObject({ task_count: 9 });
    const target = String(created.json?.path);
    const published = loadYamlMapping(fs.readFileSync(target, "utf8"));
    const tasks = published.tasks as Array<Record<string, unknown>>;
    expect(tasks).toHaveLength(9);
    expect(tasks.at(-1)).toMatchObject({
      number: 9,
      name: "Final state sync",
      depends_on: ["1", "2", "3", "4", "5", "6", "7", "8"],
    });
    expect(new ArtifactSchemaValidator().validateExplicit("plan", target, root)).toEqual([]);
  });

  it("runs the plan publication pipeline without filesystem mutation in dry-run", () => {
    const root = project();
    const valid = writeInput(root, "valid.yaml", lightPlan("Dry-run candidate"));
    expect(run(root, ["plan", "create", "--input", valid, "--dry-run", "--format", "json"]).rc).toBe(0);
    expect(fs.existsSync(path.join(root, ".agentera"))).toBe(false);

    const invalid = lightPlan("Rejected dry-run candidate");
    invalid.what = "In summary, `state/write` needs validation.";
    const rejected = run(root, [
      "plan",
      "create",
      "--input",
      writeInput(root, "invalid.yaml", invalid),
      "--dry-run",
      "--format",
      "json",
    ]);
    expect(rejected.rc).toBe(2);
    expect(rejected.json?.error.violations).toEqual(
      expect.arrayContaining([expect.stringContaining("strict prose lint filler")]),
    );
    expect(fs.existsSync(path.join(root, ".agentera"))).toBe(false);
  });

  it("keeps documented overall acceptance vocabulary eligible for replay and archive", () => {
    const root = project();
    const plan = lightPlan("Overall acceptance", "complete");
    (plan.tasks as Array<Record<string, unknown>>)[0].acceptance = [
      "GIVEN the documented plan shape WHEN published THEN its overall acceptance remains usable.",
    ];
    const input = writeInput(root, "overall-acceptance.yaml", plan);
    expect(run(root, ["plan", "create", "--input", input, "--format", "json"]).rc).toBe(0);
    expect(
      run(root, ["plan", "create", "--input", input, "--dry-run", "--format", "json"]).rc,
    ).toBe(0);
    expect(run(root, ["plan", "archive", "--dry-run", "--format", "json"]).rc).toBe(0);
  });

  it("converges archive and replacement retries after publication interruptions", () => {
    const archiveRoot = project();
    const archiveInput = writeInput(archiveRoot, "archive.yaml", lightPlan("Interrupted archive", "complete"));
    expect(run(archiveRoot, ["plan", "create", "--input", archiveInput, "--format", "json"]).rc).toBe(0);
    const archiveTarget = path.join(archiveRoot, ".agentera", "plan.yaml");
    const archiveBefore = fs.readFileSync(archiveTarget, "utf8");
    const link = vi.spyOn(fs, "linkSync").mockImplementation(() => {
      throw Object.assign(new Error("injected archive interruption"), { code: "ENOSPC" });
    });
    try {
      expect(run(archiveRoot, ["plan", "archive", "--format", "json"]).rc).toBe(1);
      expect(fs.readFileSync(archiveTarget, "utf8")).toBe(archiveBefore);
      expect(archiveFiles(archiveRoot)).toEqual([]);
    } finally {
      link.mockRestore();
    }
    expect(run(archiveRoot, ["plan", "archive", "--format", "json"]).rc).toBe(0);

    const replaceRoot = project();
    const first = writeInput(replaceRoot, "first.yaml", lightPlan("Interrupted predecessor", "complete"));
    expect(run(replaceRoot, ["plan", "create", "--input", first, "--format", "json"]).rc).toBe(0);
    const replaceTarget = path.join(replaceRoot, ".agentera", "plan.yaml");
    const replaceBefore = fs.readFileSync(replaceTarget, "utf8");
    const successor = writeInput(replaceRoot, "successor.yaml", lightPlan("Recovered successor"));
    const originalRename = fs.renameSync.bind(fs);
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(((from, to) => {
      if (String(from).includes(".writer.") && String(to) === replaceTarget) {
        throw Object.assign(new Error("injected current replacement interruption"), { code: "ENOSPC" });
      }
      return originalRename(from, to);
    }) as typeof fs.renameSync);
    try {
      expect(run(replaceRoot, ["plan", "create", "--input", successor, "--format", "json"]).rc).toBe(1);
      expect(fs.readFileSync(replaceTarget, "utf8")).toBe(replaceBefore);
      expect(archiveFiles(replaceRoot)).toHaveLength(1);
      expect(
        fs.readFileSync(path.join(replaceRoot, ".agentera", "archive", archiveFiles(replaceRoot)[0]), "utf8"),
      ).toBe(replaceBefore);
    } finally {
      rename.mockRestore();
    }
    expect(run(replaceRoot, ["plan", "create", "--input", successor, "--format", "json"]).rc).toBe(0);
    expect(archiveFiles(replaceRoot)).toHaveLength(1);
    expect(fs.readFileSync(replaceTarget, "utf8")).toContain("previous_plan_archived");
  });

  it("reuses the persisted archive identity across a midnight retry", () => {
    const root = project();
    const input = writeInput(root, "midnight.yaml", lightPlan("Midnight archive", "complete"));
    const target = path.join(root, ".agentera", "plan.yaml");
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-10T23:59:59"));
      expect(run(root, ["plan", "create", "--input", input, "--format", "json"]).rc).toBe(0);
      const originalUnlink = fs.unlinkSync.bind(fs);
      const unlink = vi.spyOn(fs, "unlinkSync").mockImplementation(((candidate) => {
        if (String(candidate) === target) {
          throw Object.assign(new Error("injected current removal interruption"), { code: "ENOSPC" });
        }
        return originalUnlink(candidate);
      }) as typeof fs.unlinkSync);
      try {
        expect(run(root, ["plan", "archive", "--format", "json"]).rc).toBe(1);
        expect(archiveFiles(root)).toHaveLength(1);
      } finally {
        unlink.mockRestore();
      }

      const archiveBeforeMidnight = archiveFiles(root);
      vi.setSystemTime(new Date("2026-07-11T00:00:01"));
      expect(run(root, ["plan", "archive", "--format", "json"]).rc).toBe(0);
      expect(archiveFiles(root)).toEqual(archiveBeforeMidnight);

      vi.setSystemTime(new Date("2026-07-12T00:00:01"));
      const replay = run(root, ["plan", "archive", "--format", "json"]);
      expect(replay.rc).toBe(0);
      expect(replay.json?.operation.idempotent_replay).toBe(true);
      expect(archiveFiles(root)).toEqual(archiveBeforeMidnight);
    } finally {
      vi.useRealTimers();
    }
  });

  it("round-trips unknown artifact and entry keys", () => {
    const root = project();
    const dir = path.join(root, ".agentera");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "progress.yaml"),
      dumpYamlMapping({
        custom_top_level: { owner: "project" },
        cycles: [
          {
            number: 1,
            timestamp: "2026-07-09 10:00",
            type: "feat",
            phase: "build",
            what: "Existing",
            custom_entry_field: "preserve",
            context: { intent: "fixture" },
          },
        ],
      }),
    );
    expect(run(root, progressArgs("Second")).rc).toBe(0);
    const doc = loadYamlMapping(fs.readFileSync(path.join(dir, "progress.yaml"), "utf8"));
    expect(doc.custom_top_level).toEqual({ owner: "project" });
    expect((doc.cycles as Array<Record<string, unknown>>)[1].custom_entry_field).toBe("preserve");
  });
});

describe("closed rejection catalog and mutation safety", () => {
  it.each([
    [["progres", "append", "--format", "json"], "unsupported_target"],
    [["vision", "append", "--format", "json"], "unsupported_target"],
    [["progress", "archive", "--format", "json"], "invalid_choice"],
    [["progress", "append", "--type", "feat", "--format", "json"], "missing_argument"],
    [
      [
        "progress",
        "append",
        "--type",
        "feature",
        "--phase",
        "build",
        "--what",
        "x",
        "--intent",
        "y",
        "--format",
        "json",
      ],
      "invalid_choice",
    ],
    [
      [
        "progress",
        "append",
        "--type",
        "feat",
        "--phase",
        "build",
        "--what",
        "x",
        "--intent",
        "y",
        "--timestamp",
        "8 Jul",
        "--format",
        "json",
      ],
      "invalid_format",
    ],
    [
      ["plan", "set-status", "--task", "three", "--status", "complete", "--format", "json"],
      "invalid_int",
    ],
    [["plan", "append", "--name", "x", "--depends-on", "three", "--format", "json"], "invalid_int"],
    [
      [
        "progress",
        "append",
        "--number",
        "4",
        "--type",
        "feat",
        "--phase",
        "build",
        "--what",
        "x",
        "--intent",
        "y",
        "--format",
        "json",
      ],
      "unrecognized_argument",
    ],
    [
      [
        "decisions",
        "append",
        "--question",
        "q",
        "--context",
        "c",
        "--alternative-chosen",
        "a",
        "--alternative-chosen",
        "b",
        "--choice",
        "a",
        "--reasoning",
        "r",
        "--confidence",
        "firm",
        "--format",
        "json",
      ],
      "mutually_exclusive",
    ],
    [["health", "append", "--format", "json"], "missing_argument"],
    [["progress", "append", "--input", "x", "--format", "json"], "mutually_exclusive"],
  ])("classifies %j as %s", (args, errorClass) => {
    const result = run(project(), args as string[]);
    expect(result.rc).toBe(2);
    expect(result.json?.schemaVersion).toBe("agentera.invalidInputEnvelope.v2");
    expect(result.json?.error.class).toBe(errorClass);
  });

  it("rejects malformed input, schema failures, missing targets, and task conflicts without mutation", () => {
    const root = project();
    const malformed = writeInput(root, "placeholder.yaml", { ok: true });
    fs.writeFileSync(malformed, "[not: yaml");
    expect(
      run(root, ["health", "append", "--input", malformed, "--format", "json"]).json?.error.class,
    ).toBe("invalid_format");
    expect(
      run(root, [
        "health",
        "append",
        "--input",
        path.join(root, "missing.yaml"),
        "--format",
        "json",
      ]).json?.error.class,
    ).toBe("unsupported_target");
    expect(
      run(root, ["health", "append", "--input", "-", "--format", "json"], "{}").json?.error.class,
    ).toBe("schema_violation");
    expect(
      run(root, ["plan", "append", "--name", "orphan", "--format", "json"]).json?.error.class,
    ).toBe("unsupported_target");
    const input = writeInput(root, "plan.yaml", lightPlan());
    run(root, ["plan", "create", "--input", input, "--format", "json"]);
    run(root, ["plan", "append", "--name", "same", "--format", "json"]);
    const conflict = run(root, [
      "plan",
      "append",
      "--name",
      "same",
      "--status",
      "blocked",
      "--format",
      "json",
    ]);
    expect(conflict.json?.error.class).toBe("conflict");
    expect(
      run(root, ["plan", "set-status", "--task", "99", "--status", "complete", "--format", "json"])
        .json?.error.class,
    ).toBe("unsupported_target");
    expect(
      fs
        .readdirSync(path.join(root, ".agentera"))
        .some((name) => name.includes(".writer.") || name === ".writer.lock"),
    ).toBe(false);
  });

  it("rejects non-sequential plan-create tasks and unknown dependencies", () => {
    const root = project();
    const numbered = lightPlan();
    (numbered.tasks as Array<Record<string, unknown>>)[0].number = 2;
    const numberedPath = writeInput(root, "numbered.yaml", numbered);
    expect(
      run(root, ["plan", "create", "--input", numberedPath, "--format", "json"]).json?.error.class,
    ).toBe("schema_violation");

    const dependent = lightPlan();
    (dependent.tasks as Array<Record<string, unknown>>)[0].depends_on = ["99"];
    const dependentPath = writeInput(root, "dependent.yaml", dependent);
    expect(
      run(root, ["plan", "create", "--input", dependentPath, "--format", "json"]).json?.error.class,
    ).toBe("schema_violation");

    const cyclic = lightPlan();
    cyclic.tasks = [
      { number: 1, name: "First", status: "pending", depends_on: ["2"] },
      { number: 2, name: "Second", status: "pending", depends_on: ["1"] },
    ];
    const cyclicPath = writeInput(root, "cyclic.yaml", cyclic);
    const cycleResult = run(root, ["plan", "create", "--input", cyclicPath, "--format", "json"]);
    expect(cycleResult.json?.error.class).toBe("schema_violation");
    expect(cycleResult.json?.error.violations).toEqual(
      expect.arrayContaining([expect.stringContaining("circular dependency chain")]),
    );
  });

  it("enforces dependency invariants after plan append and update", () => {
    const root = project();
    const input = writeInput(root, "plan.yaml", lightPlan());
    expect(run(root, ["plan", "create", "--input", input, "--format", "json"]).rc).toBe(0);

    const unknownAppend = run(root, [
      "plan",
      "append",
      "--name",
      "Second",
      "--depends-on",
      "99",
      "--format",
      "json",
    ]);
    expect(unknownAppend.json?.error.class).toBe("schema_violation");

    expect(run(root, ["plan", "append", "--name", "Second", "--format", "json"]).rc).toBe(0);
    expect(
      run(root, ["plan", "update", "--task", "2", "--depends-on", "99", "--format", "json"]).json
        ?.error.class,
    ).toBe("schema_violation");
    expect(
      run(root, ["plan", "update", "--task", "1", "--depends-on", "2", "--format", "json"]).rc,
    ).toBe(0);
    const cycle = run(root, [
      "plan",
      "update",
      "--task",
      "2",
      "--depends-on",
      "1",
      "--format",
      "json",
    ]);
    expect(cycle.json?.error.class).toBe("schema_violation");
    expect(cycle.json?.error.violations).toEqual(
      expect.arrayContaining([expect.stringContaining("circular dependency chain")]),
    );
  });

  it("keeps plan archive writes inside the project realpath boundary", () => {
    const root = project();
    const input = writeInput(root, "plan.yaml", lightPlan("First", "complete"));
    expect(run(root, ["plan", "create", "--input", input, "--format", "json"]).rc).toBe(0);
    const target = path.join(root, ".agentera", "plan.yaml");
    const before = fs.readFileSync(target, "utf8");
    const outside = project();
    fs.symlinkSync(outside, path.join(root, ".agentera", "archive"), "dir");

    const replacement = writeInput(root, "replacement.yaml", lightPlan("Second"));
    const create = run(root, ["plan", "create", "--input", replacement, "--format", "json"]);
    expect(create.rc).toBe(2);
    expect(create.json?.error.class).toBe("unsupported_target");
    expect(fs.readFileSync(target, "utf8")).toBe(before);
    expect(fs.readdirSync(outside)).toEqual([]);

    const archive = run(root, ["plan", "archive", "--format", "json"]);
    expect(archive.rc).toBe(2);
    expect(archive.json?.error.class).toBe("unsupported_target");
    expect(fs.readFileSync(target, "utf8")).toBe(before);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("refuses incomplete-plan archive/create unless force is explicitly applicable", () => {
    const root = project();
    const input = writeInput(root, "plan.yaml", lightPlan());
    run(root, ["plan", "create", "--input", input, "--format", "json"]);
    expect(run(root, ["plan", "archive", "--format", "json"]).json?.error.class).toBe("conflict");
    const replacement = writeInput(root, "replacement.yaml", lightPlan("Replacement"));
    expect(
      run(root, ["plan", "create", "--input", replacement, "--format", "json"]).json?.error.class,
    ).toBe("conflict");
    expect(
      run(root, [
        "plan",
        "create",
        "--input",
        replacement,
        "--force",
        "--dry-run",
        "--format",
        "json",
      ]).rc,
    ).toBe(0);
    expect(run(root, [...progressArgs(), "--force"]).rc).toBe(2);
  });

  it("archives mapped plans beside the current path and keeps forced lifecycle status truthful", () => {
    const mappedRoot = project();
    fs.mkdirSync(path.join(mappedRoot, ".agentera"), { recursive: true });
    fs.writeFileSync(
      path.join(mappedRoot, ".agentera", "docs.yaml"),
      dumpYamlMapping({ mapping: [{ artifact: "PLAN.md", path: "mapped/plans/plan.yaml" }] }),
    );
    const complete = writeInput(mappedRoot, "complete.yaml", lightPlan("Mapped", "complete"));
    expect(run(mappedRoot, ["plan", "create", "--input", complete, "--format", "json"]).rc).toBe(0);
    const archived = run(mappedRoot, ["plan", "archive", "--format", "json"]);
    expect(archived.rc).toBe(0);
    expect(String(archived.json?.state.archive_path)).toContain("mapped/plans/archive/PLAN-");
    expect(loadYamlMapping(fs.readFileSync(String(archived.json?.state.archive_path), "utf8")).header).toMatchObject({ status: "complete" });

    const forcedRoot = project();
    const unfinished = writeInput(forcedRoot, "unfinished.yaml", lightPlan("Forced"));
    expect(run(forcedRoot, ["plan", "create", "--input", unfinished, "--format", "json"]).rc).toBe(0);
    const forced = run(forcedRoot, ["plan", "archive", "--force", "--format", "json"]);
    expect(forced.rc).toBe(0);
    expect(loadYamlMapping(fs.readFileSync(String(forced.json?.state.archive_path), "utf8")).header).toMatchObject({ status: "open" });
  });

  it("keeps decision storage available while exposing protected review pressure", () => {
    const root = project();
    const dir = path.join(root, ".agentera");
    fs.mkdirSync(dir, { recursive: true });
    const decisions = Array.from({ length: 10 }, (_, index) => ({
      number: index + 1,
      date: `2026-06-${String(index + 1).padStart(2, "0")}`,
      question: `Q${index + 1}?`,
      context: "c",
      alternatives: [{ name: "a", status: "chosen" }],
      choice: "a",
      reasoning: "r",
      confidence: "firm",
    }));
    const target = path.join(dir, "decisions.yaml");
    fs.writeFileSync(target, dumpYamlMapping({ decisions }));
    const result = run(root, decisionArgs("Overflow?"));
    expect(result.rc).toBe(0);
    expect(result.json?.compaction).toMatchObject({
      changed: true,
      protected_overflow_count: 1,
    });
    expect(loadYamlMapping(fs.readFileSync(target, "utf8")).decisions).toHaveLength(11);
    expect(fs.existsSync(path.join(dir, "archive", "decisions", "11.yaml"))).toBe(true);
  });

  it("fails closed for malformed docs mapping and symlinked missing-leaf escapes", () => {
    const root = project();
    const dir = path.join(root, ".agentera");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "docs.yaml"), "mapping: [broken");
    const malformed = run(root, progressArgs());
    expect(malformed.rc).toBe(1);
    expect(malformed.err).toContain("failed to load docs path overrides");

    fs.writeFileSync(
      path.join(dir, "docs.yaml"),
      dumpYamlMapping({
        mapping: [{ artifact: "PROGRESS.md", path: "escaped/new/progress.yaml" }],
      }),
    );
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-writer-outside-"));
    roots.push(outside);
    fs.symlinkSync(outside, path.join(root, "escaped"), "dir");
    const escaped = run(root, progressArgs());
    expect(escaped.rc).toBe(2);
    expect(escaped.json?.error.class).toBe("unsupported_target");
    expect(fs.existsSync(path.join(outside, "new", "progress.yaml"))).toBe(false);
  });

  it("leaves corrupt existing YAML untouched", () => {
    const root = project();
    const dir = path.join(root, ".agentera");
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, "progress.yaml");
    fs.writeFileSync(target, "cycles: [broken");
    const before = fs.readFileSync(target, "utf8");
    const result = run(root, progressArgs());
    expect(result.rc).toBe(1);
    expect(result.err).toContain("cannot parse existing artifact");
    expect(fs.readFileSync(target, "utf8")).toBe(before);
  });

  it("cleans the stage, preserves the target, and retains the durable archive when projection fails", () => {
    const root = project();
    const originalRename = fs.renameSync.bind(fs);
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(((from, to) => {
      if (String(from).includes(".writer.")) {
        throw Object.assign(new Error("injected rename ENOSPC"), { code: "ENOSPC" });
      }
      return originalRename(from, to);
    }) as typeof fs.renameSync);
    try {
      const result = run(root, progressArgs());
      expect(result.rc).toBe(1);
      expect(result.err).toContain("injected rename ENOSPC");
      const dir = path.join(root, ".agentera");
      expect(fs.existsSync(path.join(dir, "progress.yaml"))).toBe(false);
      expect(fs.existsSync(path.join(dir, "archive", "progress", "1.yaml"))).toBe(true);
      expect(fs.readdirSync(dir).filter((name) => name.startsWith(".progress.yaml.writer."))).toEqual([]);
    } finally {
      rename.mockRestore();
    }
  });

  it("treats post-compaction validation failure as an invariant error and cleans the stage", () => {
    const root = project();
    const validate = vi
      .spyOn(ArtifactSchemaValidator.prototype, "validateYaml")
      .mockImplementationOnce(() => [])
      .mockImplementationOnce(() => ["injected final-byte violation"]);
    try {
      const result = run(root, progressArgs());
      expect(result.rc).toBe(1);
      expect(result.err).toContain("writer/compactor invariant failure");
      const dir = path.join(root, ".agentera");
      expect(fs.existsSync(path.join(dir, "progress.yaml"))).toBe(false);
      expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
    } finally {
      validate.mockRestore();
    }
  });

  it.each([
    "staged-write",
    "archive-publication",
    "projection-publication",
    "directory-sync",
  ] as MutationFailureBoundary[])(
    "recovers after an injected %s failure without duplicate archive identity",
    (boundary) => {
      const root = project();
      expect(() => progressWrite(root, boundary)).toThrow(InjectedMutationFailure);
      expect(writerStages(root)).toEqual([]);

      const archivePath = path.join(root, ".agentera", "archive", "progress", "1.yaml");
      if (boundary === "staged-write") {
        expect(fs.existsSync(archivePath)).toBe(false);
        expect(fs.existsSync(path.join(root, ".agentera", "progress.yaml"))).toBe(false);
      } else {
        expect(fs.existsSync(archivePath)).toBe(true);
      }

      const retry = progressWrite(root);
      expect(retry.operation).toMatchObject({ idempotent_replay: boundary !== "staged-write" });
      expect(discoverNumberedArchives(root).entries.filter((entry) => entry.stableId === "progress:1")).toHaveLength(1);
      expect(loadYamlMapping(fs.readFileSync(path.join(root, ".agentera", "progress.yaml"), "utf8")).cycles).toHaveLength(1);
    },
  );

  it("does not expose a compacted summary when archive publication interrupts an append", () => {
    const root = project();
    const dir = path.join(root, ".agentera");
    const cycles = Array.from({ length: 10 }, (_, index) => ({
      number: 10 - index,
      timestamp: `2026-07-${String(10 - index).padStart(2, "0")} 10:00`,
      type: "feat",
      phase: "build",
      what: `Cycle ${10 - index}`,
      context: { intent: "interruption fixture" },
    }));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "progress.yaml"), dumpYamlMapping({ cycles }));
    for (const cycle of cycles) publishNumberedArchive(root, "progress", cycle.number, cycle);

    expect(() => progressWrite(root, "archive-publication")).toThrow(InjectedMutationFailure);
    const interrupted = loadYamlMapping(fs.readFileSync(path.join(dir, "progress.yaml"), "utf8"));
    expect(interrupted.cycles).toHaveLength(10);
    expect(interrupted.archive).toBeUndefined();
    expect(discoverNumberedArchives(root).entries.some((entry) => entry.stableId === "progress:11")).toBe(true);

    const retry = progressWrite(root);
    expect(retry.operation.idempotent_replay).toBe(true);
    const recovered = loadYamlMapping(fs.readFileSync(path.join(dir, "progress.yaml"), "utf8"));
    expect(recovered.cycles).toHaveLength(10);
    expect((recovered.archive as Array<Record<string, unknown>>).some((entry) => String(entry.summary).includes("Cycle 1"))).toBe(true);
  });

  it("returns a retryable conflict instead of nesting the writer lock", () => {
    const root = project();
    withStateMutation(
      root,
      () => {
        try {
          progressWrite(root, undefined, { lockTimeoutMs: 1 });
        } catch (error) {
          expect(error).toBeInstanceOf(StateWriteInputError);
          expect((error as StateWriteInputError).body.class).toBe("conflict");
          return;
        }
        throw new Error("nested mutation unexpectedly acquired the writer lock");
      },
      { lockTimeoutMs: 1 },
    );
    expect(writerStages(root)).toEqual([]);
  });
});
