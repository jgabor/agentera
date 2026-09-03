import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../../src/cli/dispatch.js";
import { dumpYamlMapping } from "../../../src/core/yaml.js";
import { validateEntityState } from "../../../src/state/entityStorage.js";
import { getDecisionEntity } from "../../../src/state/decisionEntities.js";
import { getPlanEntity } from "../../../src/state/planEntities.js";

interface Captured {
  rc: number;
  out: string;
  err: string;
  json: Record<string, any> | null;
}

const roots: string[] = [];

function project(entity = true): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-state-write-"));
  roots.push(root);
  if (entity) {
    fs.mkdirSync(path.join(root, ".agentera"));
    fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function run(root: string, args: string[], stdin = ""): Captured {
  if (!stdin && args.includes("--input") && args[args.indexOf("--input") + 1] === "-") {
    if (args[0] === "progress" && args[1] === "append")
      stdin = JSON.stringify({
        type: "test",
        phase: "build",
        what: "Entity writer",
        context: { intent: "Verify entity publication" },
      });
    else if (args[0] === "decisions" && args[1] === "append")
      stdin = JSON.stringify({
        question: "Where should state live?",
        context: "Parallel writes",
        alternatives: { chosen: "Entities", rejected: ["Aggregates"] },
        choice: "Entities",
        reasoning: "Independent ownership",
        confidence: "firm",
      });
    else if (args[0] === "decisions" && args[1] === "amend") stdin = JSON.stringify({ choice: "Canonical entities" });
  }
  let out = "";
  let err = "";
  const rc = main(["node", "agentera", "state", ...args, "--project", root], {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    stdin: () => stdin,
  });
  return { rc, out, err, json: out.trim().startsWith("{") ? JSON.parse(out) : null };
}

function files(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function walk(directory: string): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(target);
      else result[path.relative(root, target)] = fs.readFileSync(target, "utf8");
    }
  }
  walk(root);
  return result;
}

function progressArgs(what = "Entity writer"): string[] {
  return ["progress", "append", "--input", "-", "--format", "json"];
}

function decisionArgs(confidence = "firm"): string[] {
  return ["decisions", "append", "--input", "-", "--format", "json"];
}

describe("typed state writer on active entity authority", () => {
  it("discovers entity paths, bare selectors, budgets, and examples", () => {
    const root = project();
    for (const [artifact, verb] of [
      ["progress", "append"],
      ["decisions", "amend"],
      ["health", "append"],
      ["plan", "set-status"],
    ]) {
      const explained = run(root, [artifact, "explain", "--verb", verb, "--format", "json"]);
      expect(explained.rc, explained.err).toBe(0);
      expect(explained.json?.path).toContain(`.agentera/entities/${artifact}/`);
      expect(explained.json?.budget).toBeTruthy();
      expect(explained.json?.example).toContain(`agentera state ${artifact}`);
      expect(JSON.stringify(explained.json)).not.toMatch(/entry_number|artifact_id|stable_id/);
    }
    const amend = run(root, ["decisions", "explain", "--verb", "amend", "--format", "json"]).json;
    expect(amend?.fields.map((field: any) => field.flag)).toEqual(expect.arrayContaining(["--id", "--base-sha256"]));
    expect(amend?.fields.map((field: any) => field.flag)).not.toContain("--number");
  });

  it("rejects non-Git marker-absent writes with read-only recovery", () => {
    const root = project(false);
    for (const args of [progressArgs(), ["backfill", "--apply", "--force", "--format", "json"], ["unknown-repair", "--apply", "--format", "json"]]) {
      const rejected = run(root, args);
      expect(rejected.rc).toBe(1);
      expect(rejected.json?.error).toMatchObject({
        class: "migration_required",
        recovery: expect.stringContaining("upgrade --channel development"),
      });
      expect(rejected.json?.error.recovery).toContain("--dry-run");
      expect(rejected.json?.error.recovery).not.toContain("--yes");
      expect(fs.readdirSync(root)).toEqual([]);
    }
  });

  it("keeps progress dry-run side-effect free and publishes one canonical entity", () => {
    const root = project();
    const before = files(root);
    const dry = run(root, [...progressArgs(), "--dry-run"]);
    expect(dry.rc, dry.err).toBe(0);
    expect(dry.json?.operation).toMatchObject({ dry_run: true });
    expect(files(root)).toEqual(before);
    const applied = run(root, progressArgs());
    expect(applied.rc, applied.err).toBe(0);
    expect(applied.json).toMatchObject({
      artifact: "progress",
      id: expect.stringMatching(/^[a-z]{10}$/),
      record: { what: "Entity writer" },
    });
    expect(fs.existsSync(path.join(root, ".agentera/progress.yaml"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".agentera/archive"))).toBe(false);
    expect(validateEntityState(root)).toMatchObject({ valid: true, entityCount: 1 });
  });

  it("converges exact public progress and decision appends without consuming IDs or order", () => {
    const root = project();
    const progressPath = path.join(root, "progress-replay.yaml");
    const progressInput = {
      timestamp: "2026-07-31 08:00",
      type: "fix",
      phase: "build",
      what: "exact progress replay",
      context: { intent: "prove logical replay" },
      verified: "same record converges",
    };
    fs.writeFileSync(progressPath, dumpYamlMapping(progressInput));
    const progressDry = run(root, ["progress", "append", "--input", progressPath, "--dry-run", "--format", "json"]);
    expect(progressDry.rc).toBe(0);
    expect(progressDry.json?.operation).toMatchObject({ dry_run: true, idempotent_replay: false });
    expect(validateEntityState(root).entityCount).toBe(0);
    const progressFirst = run(root, ["progress", "append", "--input", progressPath, "--format", "json"]);
    const progressRetry = run(root, ["progress", "append", "--input", "-", "--format", "json"], JSON.stringify(progressInput));
    const progressDryReplay = run(root, ["progress", "append", "--input", progressPath, "--dry-run", "--format", "json"]);
    const progressDifferent = run(root, ["progress", "append", "--input", "-", "--format", "json"], JSON.stringify({ ...progressInput, what: "different progress record" }));
    expect(progressFirst.rc).toBe(0);
    expect(progressRetry).toMatchObject({
      rc: 0,
      json: {
        id: progressFirst.json?.id,
        record: { publication_order: progressFirst.json?.record.publication_order },
        operation: { idempotent_replay: true },
      },
    });
    expect(progressDryReplay.json?.operation).toMatchObject({
      dry_run: true,
      idempotent_replay: true,
    });
    expect(progressDifferent.rc).toBe(0);
    expect(progressDifferent.json?.id).not.toBe(progressFirst.json?.id);
    expect(progressDifferent.json?.record.publication_order).toBe(progressFirst.json?.record.publication_order + 1);

    const decisionInput = {
      date: "2026-07-31",
      question: "What is the replay boundary?",
      context: "Public append retries must converge.",
      alternatives: { chosen: "Logical content", rejected: ["Generated identity"] },
      choice: "Logical content",
      reasoning: "IDs are writer-owned metadata.",
      confidence: "firm",
    };
    const decisionDry = run(root, ["decisions", "append", "--input", "-", "--dry-run", "--format", "json"], JSON.stringify(decisionInput));
    expect(decisionDry.rc).toBe(0);
    expect(decisionDry.json?.operation).toMatchObject({ dry_run: true, idempotent_replay: false });
    const decisionFirst = run(root, ["decisions", "append", "--input", "-", "--format", "json"], JSON.stringify(decisionInput));
    fs.writeFileSync(path.join(root, "decision-replay.json"), JSON.stringify(decisionInput));
    const decisionRetry = run(root, ["decisions", "append", "--input", path.join(root, "decision-replay.json"), "--format", "json"]);
    const decisionDryReplay = run(root, ["decisions", "append", "--input", path.join(root, "decision-replay.json"), "--dry-run", "--format", "json"]);
    const decisionDifferent = run(
      root,
      ["decisions", "append", "--input", "-", "--format", "json"],
      JSON.stringify({
        ...decisionInput,
        alternatives: {
          chosen: "Logical content",
          rejected: ["Generated identity", "Different order"],
        },
      }),
    );
    expect(decisionFirst.rc).toBe(0);
    expect(decisionRetry).toMatchObject({
      rc: 0,
      json: { id: decisionFirst.json?.id, operation: { idempotent_replay: true } },
    });
    expect(decisionDryReplay.json?.operation).toMatchObject({
      dry_run: true,
      idempotent_replay: true,
    });
    expect(decisionDifferent.rc).toBe(0);
    expect(decisionDifferent.json?.id).not.toBe(decisionFirst.json?.id);
  });

  it("validates decision input before effects and composes satisfaction and amendments", () => {
    const root = project();
    const invalid = run(
      root,
      decisionArgs(),
      JSON.stringify({
        question: "q",
        context: "c",
        alternatives: { chosen: "a" },
        choice: "a",
        reasoning: "r",
        confidence: "high",
      }),
    );
    expect(invalid.rc).toBe(2);
    expect(invalid.json?.error.class).toBe("schema_violation");
    expect(validateEntityState(root).entityCount).toBe(0);

    const appended = run(root, decisionArgs());
    expect(appended.rc).toBe(0);
    const id = String(appended.json?.id);
    const base = String((getDecisionEntity(root, id) as any).entry.effective_sha256);
    const provisional = run(root, ["decisions", "update", "--id", id, "--satisfaction-state", "provisionally_satisfied", "--satisfaction-evidence", "focused tests", "--format", "json"]);
    expect(provisional.rc).toBe(0);
    const amendment = run(root, ["decisions", "amend", "--id", id, "--base-sha256", base, "--input", "-", "--dry-run", "--format", "json"], JSON.stringify({ choice: "Canonical entities" }));
    expect(amendment.rc).toBe(0);
    expect(amendment.json?.operation.dry_run).toBe(true);
    expect(fs.existsSync(path.join(root, ".agentera/entities/decisions/decision_revision"))).toBe(false);
    expect(run(root, ["decisions", "amend", "--id", id, "--base-sha256", base, "--input", "-", "--format", "json"], JSON.stringify({ choice: "Canonical entities" })).rc).toBe(0);
    const effective = (getDecisionEntity(root, id) as any).entry;
    expect(effective.record).toMatchObject({
      choice: "Canonical entities",
      satisfaction: { state: "provisionally_satisfied", evidence: "focused tests" },
    });
    expect(effective.provenance.revisions).toHaveLength(1);
  });

  it("parses health input from stdin, rejects CLI-owned identity, and publishes atomically", () => {
    const root = project();
    const audit = {
      date: "2026-07-19",
      dimensions: ["architecture_alignment"],
      findings_summary: { critical: 0, warning: 0, info: 0, filtered_by_confidence: 0 },
      trajectory: "stable",
      grades: { architecture_alignment: "A" },
    };
    const dry = run(root, ["health", "append", "--input", "-", "--dry-run", "--format", "json"], JSON.stringify(audit));
    expect(dry.rc).toBe(0);
    expect(validateEntityState(root).entityCount).toBe(0);
    const rejected = run(root, ["health", "append", "--input", "-", "--format", "json"], JSON.stringify({ id: "aaaaaaaaaa", ...audit }));
    expect(rejected.rc).not.toBe(0);
    expect(validateEntityState(root).entityCount).toBe(0);
    const applied = run(root, ["health", "append", "--input", "-", "--format", "json"], JSON.stringify(audit));
    expect(applied.rc, applied.err).toBe(0);
    expect(applied.json).toMatchObject({
      artifact: "health",
      id: expect.stringMatching(/^[a-z]{10}$/),
    });
    expect(validateEntityState(root).valid).toBe(true);
  });

  it("publishes plan and task entities with dependencies and isolated statuses", () => {
    const root = project();
    const input = path.join(root, "plan.yaml");
    fs.writeFileSync(
      input,
      dumpYamlMapping({
        header: {
          level: "light",
          created: "2026-07-19",
          status: "open",
          title: "Entity writer plan",
        },
        what: "Verify plan publication.",
        why: "Dependencies must remain valid.",
        scope: { included: ["writer"], excluded: ["legacy aggregate"] },
        tasks: [
          { number: 1, name: "First", status: "complete", depends_on: [] },
          { number: 2, name: "Second", status: "pending", depends_on: ["1"] },
          { number: 3, name: "Third", status: "pending", depends_on: ["2"] },
        ],
      }),
    );
    const before = files(root);
    expect(run(root, ["plan", "create", "--input", input, "--dry-run", "--format", "json"]).rc).toBe(0);
    expect(files(root)).toEqual(before);
    const created = run(root, ["plan", "create", "--input", input, "--format", "json"]);
    expect(created.rc, created.err || created.out).toBe(0);
    expect(created.json?.tasks).toHaveLength(3);
    expect(created.json?.tasks[1].record.depends_on).toEqual([created.json?.tasks[0].id]);
    expect(run(root, ["plan", "set-status", "--id", created.json?.tasks[1].id, "--status", "in_progress", "--format", "json"]).rc).toBe(0);
    const invalid = run(root, ["plan", "update", "--plan", created.json?.id, "--id", created.json?.tasks[0].id, "--input", "-", "--format", "json"], JSON.stringify({ depends_on: [created.json?.tasks[2].id] }));
    expect(invalid.rc, JSON.stringify(invalid)).toBe(2);
    expect(invalid.json?.error.message).toMatch(/cycle|depends/i);
    expect(validateEntityState(root).valid).toBe(true);
  });

  it("fails before publication for malformed input and unsafe project paths", () => {
    const root = project();
    const before = files(root);
    const malformed = run(root, ["plan", "create", "--input", "-", "--format", "json"], "tasks: [");
    expect(malformed.rc).not.toBe(0);
    expect(files(root)).toEqual(before);

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-state-outside-"));
    roots.push(outside);
    fs.mkdirSync(path.join(root, ".agentera/entities"));
    fs.symlinkSync(outside, path.join(root, ".agentera/entities/progress"));
    const unsafe = run(root, progressArgs("unsafe"));
    expect(unsafe.rc).not.toBe(0);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(validateEntityState(root).valid).toBe(false);
    expect(fs.existsSync(path.join(root, ".agentera/entities/progress/progress_cycle"))).toBe(false);
  });
});

describe("retained entity writer contract matrix", () => {
  it.each([
    ["progress", "append"],
    ["decisions", "append"],
    ["health", "append"],
    ["plan", "create"],
    ["objective", "create"],
    ["experiments", "publish"],
    ["todo", "create"],
    ["docs", "create"],
  ])("discovers %s %s through canonical entity paths", (artifact, verb) => {
    const explained = run(project(), [artifact, "explain", "--verb", verb, "--format", "json"]);
    expect(explained.rc, explained.err).toBe(0);
    expect(explained.json).toMatchObject({ artifact, requested_verb: verb });
    expect(explained.json?.path).toContain(`.agentera/entities/${artifact}/`);
    expect(JSON.stringify(explained.json)).not.toMatch(/entry_number|artifact_id|stable_id/);
  });

  it("keeps durable progress selection and release-attempt detail in writer-owned guidance", () => {
    const explained = run(project(), ["progress", "explain", "--verb", "append", "--format", "json"]);
    expect(explained.rc, explained.err).toBe(0);
    expect(explained.json?.input_schema.semantics.progress_write_policy).toEqual({
      schemaVersion: "agentera.progressWritePolicy.v1",
      append: {
        mode: "conditional",
        allowed_when: ["durable_project_truth_needed_by_future_work", "required_glossary_caveat", "plan_completion_sweep"],
        required_when: ["required_glossary_caveat", "plan_completion_sweep"],
        no_append_required_when: ["ordinary_build_or_release_attempt_without_durable_project_truth_change", "durable_outcome_not_needed_by_future_work"],
        guidance: expect.stringContaining("require no progress append"),
      },
      receipt_detail: {
        owners: ["qualification_receipt", "publication_receipt"],
        fields: ["timings", "integrity", "digests", "retries", "replay"],
        guidance: expect.stringContaining("do not duplicate receipt detail in progress"),
      },
    });
    expect(explained.json?.guidance).toEqual(expect.arrayContaining([expect.stringContaining("durable project truth that future work needs"), expect.stringContaining("Qualification and publication receipts own timings, integrity, digests, retries, and replay")]));
    expect(explained.json?.input_schema.owned_fields).toEqual(["id", "artifact", "publication_order"]);
  });

  it.each(["feat", "fix", "docs", "refactor", "chore", "test"])("publishes progress type %s as one canonical entity", (type) => {
    const root = project();
    const result = run(
      root,
      ["progress", "append", "--input", "-", "--format", "json"],
      JSON.stringify({
        type,
        phase: "build",
        what: `Published ${type}`,
        context: { intent: "Exercise allowed type" },
      }),
    );
    expect(result.rc, result.err).toBe(0);
    expect(result.json).toMatchObject({
      artifact: "progress",
      id: expect.stringMatching(/^[a-z]{10}$/),
      record: { type, what: `Published ${type}` },
    });
    expect(validateEntityState(root)).toMatchObject({ valid: true, entityCount: 1 });
  });

  it.each(["firm", "provisional", "exploratory"])("publishes current decision confidence %s", (confidence) => {
    const root = project();
    const result = run(
      root,
      decisionArgs(confidence),
      JSON.stringify({
        question: "q",
        context: "c",
        alternatives: { chosen: "a" },
        choice: "a",
        reasoning: "r",
        confidence,
      }),
    );
    expect(result.rc, result.err).toBe(0);
    expect(result.json?.record.confidence).toBe(confidence);
    expect(validateEntityState(root).valid).toBe(true);
  });

  it.each(["high", "medium", "low", "certain"])("rejects retired decision confidence %s before publication", (confidence) => {
    const root = project();
    const result = run(
      root,
      decisionArgs(),
      JSON.stringify({
        question: "q",
        context: "c",
        alternatives: { chosen: "a" },
        choice: "a",
        reasoning: "r",
        confidence,
      }),
    );
    expect(result.rc).toBe(2);
    expect(result.json?.error.class).toBe("schema_violation");
    expect(validateEntityState(root).entityCount).toBe(0);
  });

  it.each(["pending", "in_progress", "blocked", "complete"])("sets plan task status %s without changing plan lifecycle", (status) => {
    const root = project();
    const input = path.join(root, "single-plan.yaml");
    fs.writeFileSync(
      input,
      dumpYamlMapping({
        header: {
          level: "light",
          created: "2026-07-19",
          status: "open",
          title: `Status ${status}`,
        },
        what: "Verify typed task status publication in packages/cli/src/state/planEntities.ts.",
        why: "Plan and task lifecycle statuses must remain isolated while preserving validated dependencies.",
        scope: { included: ["entity writer"], excluded: ["legacy aggregate authority"] },
        tasks: [{ number: 1, name: "Publish one task status", status: "pending", depends_on: [] }],
      }),
    );
    const created = run(root, ["plan", "create", "--input", input, "--format", "json"]);
    expect(created.rc, created.err).toBe(0);
    const changed = run(root, ["plan", "set-status", "--id", created.json?.tasks[0].id, "--status", status, "--format", "json"]);
    expect(changed.rc, changed.err).toBe(0);
    expect(changed.json?.record.status).toBe(status);
    expect((getPlanEntity(root, created.json?.id) as any).entry.record.header.status).toBe("open");
  });

  it.each([
    ["state backfill", ["backfill", "--apply", "--force", "--format", "json"]],
    ["unknown repair", ["unknown-repair", "--apply", "--format", "json"]],
    ["progress append", progressArgs("blocked")],
    ["decision append", decisionArgs()],
    ["health append", ["health", "append", "--input", "-", "--format", "json"]],
    ["plan create", ["plan", "create", "--input", "-", "--format", "json"]],
    ["objective create", ["objective", "create", "--input", "-", "--format", "json"]],
    ["todo create", ["todo", "create", "--input", "-", "--format", "json"]],
    ["docs create", ["docs", "create", "--document", "Blocked", "--path", "blocked.md", "--status", "current", "--format", "json"]],
    ["compact mutation", ["query", "progress", "--format", "json"]],
  ])("gates non-Git marker-absent %s with read-only recovery", (_label, args) => {
    const root = project(false);
    const result = run(root, args as string[], "{}");
    expect(result.rc).toBe(1);
    expect(result.json?.error).toMatchObject({
      class: "migration_required",
      recovery: expect.stringContaining("upgrade --channel development"),
    });
    expect(result.json?.error.recovery).toContain("--dry-run");
    expect(result.json?.error.recovery).not.toContain("--yes");
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it.each([
    ["missing progress input", ["progress", "append", "--format", "json"], "missing_argument"],
    ["retired progress content flag", ["progress", "append", "--type", "test", "--format", "json"], "unrecognized_argument"],
    ["retired decision content flag", ["decisions", "append", "--question", "q", "--format", "json"], "unrecognized_argument"],
    ["missing decision input", ["decisions", "append", "--format", "json"], "missing_argument"],
    ["missing health input", ["health", "append", "--format", "json"], "missing_argument"],
    ["decision satisfaction input", ["decisions", "update", "--id", "aaaaaaaaaa", "--input", "-", "--format", "json"], "mutually_exclusive"],
    ["numeric plan selector", ["plan", "set-status", "--task", "1", "--status", "complete", "--format", "json"], "unrecognized_argument"],
    ["missing decision target", ["decisions", "update", "--satisfaction-state", "open", "--format", "json"], "missing_argument"],
    ["unknown write verb", ["progress", "archive", "--format", "json"], "invalid_request"],
  ])("rejects %s before entity publication", (_label, args, classification) => {
    const root = project();
    const result = run(root, args as string[]);
    expect(result.rc).not.toBe(0);
    expect(result.json?.error.class).toBe(classification);
    expect(validateEntityState(root).entityCount).toBe(0);
  });

  it.each([
    ["malformed YAML", "type: [", "invalid_format"],
    ["owned progress field", "id: aaaaaaaaaa\ntype: test\nphase: build\nwhat: x\ncontext:\n  intent: y\n", "schema_violation"],
    ["unknown decision field", "question: q\ncontext: c\nalternatives:\n  chosen: a\nchoice: a\nreasoning: r\nconfidence: firm\nnumber: 4\n", "schema_violation"],
  ])("rejects structured %s before publication", (_label, stdin, classification) => {
    const root = project();
    const args = _label === "unknown decision field" ? ["decisions", "append", "--input", "-", "--format", "json"] : ["progress", "append", "--input", "-", "--format", "json"];
    const result = run(root, args, stdin);
    expect(result.rc).not.toBe(0);
    expect(result.json?.error.class).toBe(classification);
    expect(validateEntityState(root).entityCount).toBe(0);
  });

  it.each([
    ["provisional without evidence", "provisionally_satisfied", []],
    ["confirmed without metadata", "user_confirmed_satisfied", []],
    ["invented state", "invented", []],
    ["provisional with empty evidence", "provisionally_satisfied", ["--satisfaction-evidence", ""]],
    ["confirmed with only actor", "user_confirmed_satisfied", ["--confirmed-by", "user"]],
    ["confirmed with only time", "user_confirmed_satisfied", ["--confirmed-at", "2026-07-19T12:00:00Z"]],
  ])("rejects invalid satisfaction shape: %s", (_label, state, extra) => {
    const root = project();
    const appended = run(root, decisionArgs());
    const result = run(root, ["decisions", "update", "--id", appended.json?.id, "--satisfaction-state", state, ...(extra as string[]), "--format", "json"]);
    expect(result.rc).not.toBe(0);
    expect(fs.existsSync(path.join(root, ".agentera/entities/decisions/decision_satisfaction"))).toBe(false);
    expect(validateEntityState(root).valid).toBe(true);
  });

  it.each(["progress", "decisions", "health", "plan"])("keeps %s dry-run free of entity publications", (artifact) => {
    const root = project();
    let args: string[];
    let stdin = "";
    if (artifact === "progress") args = [...progressArgs("dry"), "--dry-run"];
    else if (artifact === "decisions") args = [...decisionArgs(), "--dry-run"];
    else if (artifact === "health") {
      args = ["health", "append", "--input", "-", "--dry-run", "--format", "json"];
      stdin = JSON.stringify({
        date: "2026-07-19",
        dimensions: ["test_health"],
        findings_summary: { critical: 0, warning: 0, info: 0, filtered_by_confidence: 0 },
        trajectory: "stable",
        grades: { test_health: "A" },
      });
    } else {
      const input = path.join(root, "dry-plan.yaml");
      fs.writeFileSync(
        input,
        dumpYamlMapping({
          header: {
            level: "light",
            created: "2026-07-19",
            status: "open",
            title: "Dry-run plan",
          },
          what: "Verify packages/cli/src/state/planEntities.ts without creating entity files.",
          why: "Dry-run must validate production-shaped input while retaining the exact filesystem snapshot.",
          scope: { included: ["entity writer"], excluded: ["legacy aggregate authority"] },
          tasks: [
            {
              number: 1,
              name: "Validate dry-run publication",
              status: "pending",
              depends_on: [],
            },
          ],
        }),
      );
      args = ["plan", "create", "--input", input, "--dry-run", "--format", "json"];
    }
    const before = files(root);
    const result = run(root, args, stdin);
    expect(result.rc, result.err || result.out).toBe(0);
    expect(result.json?.operation.dry_run).toBe(true);
    expect(files(root)).toEqual(before);
    expect(validateEntityState(root).entityCount).toBe(0);
  });
});
