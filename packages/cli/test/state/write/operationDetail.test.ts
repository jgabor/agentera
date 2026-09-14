import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../../../src/cli/dispatch/index.js";
import { runStateWrite } from "../../../src/cli/commands/state/write.js";
import { runStateExplainDetail } from "../../../src/cli/commands/state/explainDetail.js";
import { buildExplain } from "../../../src/state/write/explain.js";
import { currentOperationDetail } from "../../../src/state/write/operationDetail.js";
import { WRITABLE_ARTIFACTS, verbsForArtifact, type WritableArtifact } from "../../../src/state/write/operations.js";
import { inspectTodoCreateBatch } from "../../../src/state/todoCreateBatch.js";
import { inspectTodoUpdateBatch } from "../../../src/state/todoUpdateBatch.js";
import { parseTodoTransitionBatch } from "../../../src/state/todoTransitionBatch.js";
import { shellCommandArgs } from "../../helpers/shellCommand.js";
import { validateEntityState } from "../../../src/state/entityStorage.js";
import { todoInputViolations } from "../../../src/state/todoDocsEntityValidation.js";
import { todoOwnerCorrectionInputViolations } from "../../../src/state/todoReconciliationRepair.js";
import { getDecisionEntity } from "../../../src/state/decisionEntities.js";
import { getPlanTaskEntity } from "../../../src/state/planEntities.js";
import { explainedOperationSection } from "../../helpers/operationDetail.js";

const roots: string[] = [];
function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-operation-detail-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".agentera"));
  fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function detail(artifact: WritableArtifact, verb: string): any {
  const result = currentOperationDetail(artifact, verb, buildExplain(artifact, "/", verb, true));
  // Writer probes consume what the public static section actually returns.
  return { ...result, examples: explainedOperationSection(artifact, verb) };
}
function query(artifact: string, argv: string[]) {
  let out = "";
  const code = runStateExplainDetail(artifact, argv, {
    out: (text) => {
      out += text;
    },
  });
  return { code, out, json: JSON.parse(out) };
}
function write(root: string, artifact: string, verb: string, input?: unknown, flags: string[] = []) {
  let out = "";
  const code = runStateWrite(artifact, [verb, "--project", root, ...(input === undefined ? [] : ["--input", "-"]), ...flags], {
    out: (text) => {
      out += text;
    },
    stdin: () => JSON.stringify(input),
  });
  return { code, json: JSON.parse(out) };
}

describe("current typed operation detail", () => {
  it("covers the code-owned writer matrix with operation semantics and bounded reachable detail", () => {
    for (const artifact of WRITABLE_ARTIFACTS) {
      for (const verb of verbsForArtifact(artifact).filter((verb) => verb !== "explain")) {
        const contract = detail(artifact, verb);
        expect(contract.constraints_effects_replay.length, `${artifact}.${verb}`).toBeGreaterThan(0);
        expect(contract.examples.commands.length).toBeGreaterThan(0);
        expect(contract.recovery).toBeTruthy();
        const response = query(artifact, ["--verb", verb, "--section", "detail"]);
        expect(response.code, response.out).toBe(0);
        expect(Buffer.byteLength(response.out)).toBeLessThanOrEqual(32768);
        expect(response.json.schemaVersion).toBe("agentera.guidanceDetail.v1");
        expect(response.json.command).toBe(`state ${artifact} explain`);
      }
    }
  });

  it("preserves old explanation envelopes and advertises the selected detail action", () => {
    const old = buildExplain("plan", "/", "append");
    expect(old).toMatchObject({
      schemaVersion: "agentera.stateWriteExplain.v1",
      requested_verb: "append",
      input: { mode: "structured" },
      detail_command: "npx -y agentera@next state plan explain --verb append --section detail",
    });
    expect((buildExplain("todo", "/", "resolve").fields as any[]).find((field) => field.flag === "--date")).not.toHaveProperty("default");
    expect(detail("plan", "create").constraints_effects_replay.join(" ")).toContain("exact real Git worktree root with no .agentera directory");
  });

  it("rejects operational selectors, stale cursors and unknown semantic sections", () => {
    for (const args of [["--input", "-"], ["--yes"], ["--dry-run"], ["--project", "/tmp"], ["--verb", "append", "--all"], ["--limit", "0"], ["--limit", "101"], ["--cursor", "bad"], ["--section", "../plan.yaml"], ["--verb", "invented"], ["--verb", "append", "--verb", "append"]]) {
      const result = query("progress", args);
      expect(result.code, JSON.stringify(args) + result.out).toBe(64);
    }
  });

  it("paginates all operations losslessly with selection-bound cursors", () => {
    let result = query("plan", ["--all", "--section", "detail", "--limit", "1"]);
    const names: string[] = [];
    while (true) {
      expect(result.code, result.out).toBe(0);
      expect(Buffer.byteLength(result.out)).toBeLessThanOrEqual(32768);
      names.push(...result.json.items.map((item: any) => item.name));
      const next = result.json.next_command;
      if (!next) break;
      const tokens = shellCommandArgs(next.replace(/^npx -y agentera@next /, "agentera "));
      const start = tokens.indexOf("explain") + 1;
      result = query("plan", tokens.slice(start));
    }
    expect(names.length).toBe(verbsForArtifact("plan").length - 1);
    expect(new Set(names).size).toBe(names.length);
  });

  it("runs statically before corrupt/legacy project gates and never asks for stdin", () => {
    const root = project();
    fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "invalid: [");
    const cwd = process.cwd();
    try {
      process.chdir(root);
      let out = "";
      expect(
        main(["node", "agentera", "state", "plan", "explain", "--verb", "create", "--section", "detail"], {
          out: (text) => {
            out += text;
          },
          stdin: () => {
            throw new Error("must not read stdin");
          },
        }),
      ).toBe(0);
      expect(JSON.parse(out).qualifications.static).toBe(true);
      expect(fs.readFileSync(path.join(root, ".agentera/state-mode.yaml"), "utf8")).toBe("invalid: [");
      expect(fs.readdirSync(path.join(root, ".agentera"))).toEqual(["state-mode.yaml"]);
    } finally {
      process.chdir(cwd);
    }
  });

  it("validates returned example inputs through the actual CLI writers without hidden fields", () => {
    for (const [artifact, verb] of [
      ["progress", "append"],
      ["decisions", "append"],
      ["health", "append"],
      ["plan", "create"],
      ["objective", "create"],
      ["docs", "create"],
    ] as const) {
      const root = project();
      const result = write(root, artifact, verb, detail(artifact, verb).examples.input, ["--dry-run"]);
      expect(result.code, `${artifact}.${verb}: ${JSON.stringify(result.json)}`).toBe(0);
      expect(fs.readdirSync(path.join(root, ".agentera"))).toEqual(["state-mode.yaml"]);
      const applied = write(root, artifact, verb, detail(artifact, verb).examples.input);
      expect(applied.code, JSON.stringify(applied.json)).toBe(0);
      expect(validateEntityState(root).valid).toBe(true);
    }
  });

  it("validates returned patch and experiment examples against entities created from returned examples", () => {
    const root = project();
    const objective = write(root, "objective", "create", detail("objective", "create").examples.input);
    expect(objective.code, JSON.stringify(objective.json)).toBe(0);
    for (const [artifact, verb, flags] of [
      ["objective", "update", ["--id", objective.json.id]],
      ["experiments", "publish", ["--objective", objective.json.id]],
    ] as const) {
      const result = write(root, artifact, verb, detail(artifact, verb).examples.input, [...flags]);
      expect(result.code, JSON.stringify(result.json)).toBe(0);
    }
    const plan = write(root, "plan", "create", detail("plan", "create").examples.input);
    expect(plan.code, JSON.stringify(plan.json)).toBe(0);
    const append = write(root, "plan", "append", detail("plan", "append").examples.input, ["--plan", plan.json.id]);
    expect(append.code, JSON.stringify(append.json)).toBe(0);
    expect(write(root, "plan", "update", detail("plan", "update").examples.input, ["--id", append.json.id, "--dry-run"]).code).toBe(0);
  });

  it("requires experiment regression evidence even for the returned baseline and preserves immutable replay", () => {
    const root = project();
    const objective = write(root, "objective", "create", detail("objective", "create").examples.input);
    const explanation = detail("experiments", "publish");
    expect(explanation.input.fields.find((field: any) => field.path === "regression").required).toBe(true);
    const input = explanation.examples.input;
    const invalid = structuredClone(input);
    delete invalid.regression;
    const flags = ["--objective", objective.json.id];
    expect(write(root, "experiments", "publish", invalid, flags).code).not.toBe(0);
    expect(validateEntityState(root).entityCount).toBe(1);
    const published = write(root, "experiments", "publish", input, flags);
    expect(published.code, JSON.stringify(published.json)).toBe(0);
    const replay = write(root, "experiments", "publish", input, [...flags, "--id", published.json.id]);
    expect(replay.json.operation.idempotent_replay).toBe(true);
    expect(write(root, "experiments", "publish", { ...input, conclusion: "Divergent evidence" }, [...flags, "--id", published.json.id]).code).not.toBe(0);
    expect(validateEntityState(root)).toMatchObject({ valid: true, entityCount: 2 });
  });

  it.each(["create", "replace"])("discovers and roundtrips retained full-plan task fields through %s", (verb) => {
    const root = project();
    const fields = explainedOperationSection("plan", verb, "input").fields;
    for (const name of ["evidence", "blocked_reason"]) {
      expect(fields.find((field: any) => field.path === `tasks[].${name}`)).toMatchObject({
        required: false,
        type: "any",
      });
    }
    const input = explainedOperationSection("plan", verb).full_input;
    Object.assign(input.tasks[0], {
      evidence: ["Existing scoped verification passed"],
      blocked_reason: "Awaiting authorized execution",
    });
    // Complete-plan publication retains values without the field-specific type
    // checks of task append/update; null is stored, not treated as a patch clear.
    Object.assign(input.tasks[1], {
      evidence: { source: "Scoped verification" },
      blocked_reason: null,
    });
    const flags: string[] = [];
    if (verb === "replace") {
      const predecessor = write(root, "plan", "create", explainedOperationSection("plan", "create").full_input);
      expect(predecessor.code, JSON.stringify(predecessor.json)).toBe(0);
      flags.push("--predecessor", predecessor.json.id);
    }
    const snapshot = () =>
      Object.fromEntries(
        fs
          .readdirSync(root, { recursive: true, encoding: "utf8" })
          .filter((name) => fs.statSync(path.join(root, name)).isFile())
          .map((name) => [name, fs.readFileSync(path.join(root, name), "utf8")]),
      );
    const before = snapshot();
    const preview = write(root, "plan", verb, input, [...flags, "--dry-run"]);
    expect(preview.code, JSON.stringify(preview.json)).toBe(0);
    expect(snapshot()).toEqual(before);
    const applied = write(root, "plan", verb, input, flags);
    expect(applied.code, JSON.stringify(applied.json)).toBe(0);
    for (const [index, task] of applied.json.tasks.entries()) {
      const expected = {
        evidence: input.tasks[index].evidence,
        blocked_reason: input.tasks[index].blocked_reason,
      };
      expect(preview.json.tasks[index].record).toMatchObject(expected);
      expect(task.record).toMatchObject(expected);
      expect((getPlanTaskEntity(root, task.id).entry as any).record).toMatchObject(expected);
    }
    expect(validateEntityState(root).valid).toBe(true);
  });

  it("replaces a documentation entry with the returned complete record and rejects incomplete replacement without effects", () => {
    const root = project();
    const created = write(root, "docs", "create", detail("docs", "create").examples.input);
    const input = detail("docs", "update").examples.input;
    const flags = ["--id", created.json.id];
    const replay = write(root, "docs", "update", input, flags);
    expect(replay.code, JSON.stringify(replay.json)).toBe(0);
    expect(replay.json.operation.idempotent_replay).toBe(true);
    const file = path.resolve(root, created.json.path);
    const before = fs.readFileSync(file, "utf8");
    expect(write(root, "docs", "update", { document: "Replacement" }, flags).code).not.toBe(0);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    const updated = write(root, "docs", "update", { ...input, status: "stale" }, flags);
    expect(updated.code, JSON.stringify(updated.json)).toBe(0);
    expect(updated.json.record.status).toBe("stale");
    expect(fs.existsSync(path.join(root, input.path))).toBe(false);
  });

  it("validates complete TODO batch example shapes through each actual batch parser", () => {
    expect(inspectTodoCreateBatch(detail("todo", "create").input.batch.example)?.violations).toEqual([]);
    expect(inspectTodoUpdateBatch(detail("todo", "update").input.batch.example)?.violations).toEqual([]);
    for (const verb of ["set-severity", "resolve"] as const) expect(parseTodoTransitionBatch(detail("todo", verb).input.batch.example, verb)?.entries).toHaveLength(1);
  });

  it("validates TODO single and owner-correction examples with their current input contracts", () => {
    for (const verb of ["create", "update"] as const) expect(todoInputViolations(detail("todo", verb).examples.input, verb)).toEqual([]);
    expect(todoOwnerCorrectionInputViolations(detail("todo", "correct-owners").examples.input)).toEqual([]);
  });

  it("validates glossary example with its explained fixture, preserves rejection and exact replay", () => {
    const root = project();
    const explanation = detail("glossary", "publish");
    for (const [name, bytes] of Object.entries(explanation.examples.fixture_preconditions)) fs.writeFileSync(path.join(root, name), bytes as string);
    const input = explanation.examples.input;
    const invalid = structuredClone(input);
    invalid.confirmation.confirmed_by = "agent";
    expect(write(root, "glossary", "publish", invalid).code).not.toBe(0);
    expect(fs.existsSync(path.join(root, ".agentera/glossary.yaml"))).toBe(false);
    const result = write(root, "glossary", "publish", input);
    expect(result.code, JSON.stringify(result.json)).toBe(0);
    const before = fs.readFileSync(path.join(root, ".agentera/glossary.yaml"), "utf8");
    expect(write(root, "glossary", "publish", input).code).toBe(0);
    expect(fs.readFileSync(path.join(root, ".agentera/glossary.yaml"), "utf8")).toBe(before);
    fs.writeFileSync(path.join(root, "value.ts"), "changed source\n");
    expect(write(root, "glossary", "publish", input).code).not.toBe(0);
    expect(fs.readFileSync(path.join(root, ".agentera/glossary.yaml"), "utf8")).toBe(before);
  });

  it("exercises decision patch, satisfaction and stale/legacy rejection with returned inputs", () => {
    const root = project();
    const record = write(root, "decisions", "append", detail("decisions", "append").examples.input);
    expect(record.code, JSON.stringify(record.json)).toBe(0);
    const hash = (getDecisionEntity(root, record.json.id).entry as any).effective_sha256;
    const amendment = detail("decisions", "amend").examples.input;
    const flags = ["--id", record.json.id, "--base-sha256", hash];
    expect(write(root, "decisions", "amend", amendment, flags).code).toBe(0);
    expect(write(root, "decisions", "amend", amendment, flags).code).toBe(0);
    expect(write(root, "decisions", "amend", { reasoning: "Divergent patch" }, flags).code).not.toBe(0);
    expect(
      write(root, "decisions", "append", {
        ...detail("decisions", "append").examples.input,
        confidence: "high",
      }).code,
    ).not.toBe(0);
    expect(write(root, "decisions", "update", undefined, ["--id", record.json.id, "--satisfaction-state", "provisionally_satisfied", "--satisfaction-evidence", "Example contract verified"]).code).toBe(0);
    const invalid = write(root, "decisions", "update", undefined, ["--id", record.json.id, "--satisfaction-state", "user_confirmed_satisfied", "--confirmed-by", "user"]);
    expect(invalid.code).not.toBe(0);
    // Unlike glossary approval, these are non-empty attribution strings, not
    // parser-enforced literal-user or timestamp-format constraints.
    expect(detail("decisions", "update").constraints_effects_replay.join(" ")).toContain("does not enforce the literal user or a timestamp format");
    const confirmed = write(root, "decisions", "update", undefined, ["--id", record.json.id, "--satisfaction-state", "user_confirmed_satisfied", "--confirmed-by", "fixture-user", "--confirmed-at", "fixture-confirmation"]);
    expect(confirmed.code, JSON.stringify(confirmed.json)).toBe(0);
    expect(validateEntityState(root).valid).toBe(true);
  });
});
