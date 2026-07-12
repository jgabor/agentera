import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../../../src/cli/dispatch.js";
import { lintFullArtifactPayload } from "../../../src/cli/commands/lint.js";
import { dumpYamlMapping, loadYamlMapping } from "../../../src/core/yaml.js";
import { ArtifactSchemaValidator } from "../../../src/hooks/validateArtifact/index.js";

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
    expect(result.json?.compaction).toContain("10 full, 40 archive");
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
    expect(lintResult.json?.error.syntax).toContain("check lint");
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

  it("rejects protected decision overflow with byte-identical target", () => {
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
    const before = fs.readFileSync(target, "utf8");
    const result = run(root, decisionArgs("Overflow?"));
    expect(result.json?.error.class).toBe("conflict");
    expect(fs.readFileSync(target, "utf8")).toBe(before);
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

  it("cleans the stage and preserves the target when atomic publication fails", () => {
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
      expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
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
});
