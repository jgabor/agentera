import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import { dumpYamlMapping } from "../../src/core/yaml.js";
import { runStateGet } from "../../src/cli/commands/state/get.js";
import { runStateList } from "../../src/cli/commands/state/list.js";
import { amendDecisionEntity, appendDecisionEntity, getDecisionEntity, listDecisionEntities, updateDecisionSatisfactionEntity } from "../../src/state/decisionEntities.js";
import { validateEntityState } from "../../src/state/entityStorage.js";
import { executeStateWrite } from "../../src/state/write/transaction.js";
import { operationSpec, type StateWriteRequest } from "../../src/state/write/operations.js";
import { buildExplain } from "../../src/state/write/explain.js";

const roots: string[] = [];
function project(entity = true): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-decision-entities-")); roots.push(root);
  if (entity) { fs.mkdirSync(path.join(root, ".agentera"), { recursive: true }); fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n"); }
  return root;
}
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });
function request(root: string, verb: "append" | "update" | "amend", values: Record<string, unknown>, dryRun = false): StateWriteRequest {
  const spec = operationSpec("decisions", verb)!;
  return { artifact: "decisions", spec, projectRoot: root, dryRun, force: false, values, callerPayload: structuredClone(values), input: null };
}
function base(root: string, id = "aaaaaaaaaa", choice = "Entity files"): Record<string, any> {
  return appendDecisionEntity(request(root, "append", { date: "2026-07-17", question: "Where should authority live?", context: "Parallel branches must merge.", alternatives: { chosen: "Entity files", rejected: ["Aggregate"] }, choice, reasoning: "Independent ownership.", confidence: "firm" }), { id }) as any;
}
function git(root: string, ...args: string[]): string {
  const env = { ...process.env };
  delete env.GIT_DIR; delete env.GIT_WORK_TREE; delete env.GIT_INDEX_FILE;
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

describe("decision entity authority", () => {
  it("appends one immutable base and never writes legacy projections or archives", () => {
    const root = project(); const written = executeStateWrite(request(root, "append", { date: "2026-07-17", question: "Q?", context: "C", alternatives: { chosen: "A" }, choice: "A", reasoning: "R", confidence: "firm" }));
    expect(written).toMatchObject({ artifact: "decisions", record: { question: "Q?" } });
    expect(fs.existsSync(path.join(root, ".agentera/decisions.yaml"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".agentera/archive"))).toBe(false);
    expect(validateEntityState(root)).toMatchObject({ valid: true, entityCount: 1 });
  });

  it("gets effective base, revision, and satisfaction detail with bare identity and provenance", () => {
    const root = project(); base(root);
    updateDecisionSatisfactionEntity(request(root, "update", { id: "aaaaaaaaaa", satisfaction: { state: "provisionally_satisfied", evidence: "tests pass" } }), { id: "bbbbbbbbbb" });
    const first = getDecisionEntity(root, "aaaaaaaaaa") as any;
    amendDecisionEntity(request(root, "amend", { id: "aaaaaaaaaa", base_sha256: first.entry.effective_sha256, choice: "Canonical entities" }), { id: "cccccccccc" });
    const result = getDecisionEntity(root, "aaaaaaaaaa") as any;
    expect(result.entry).toMatchObject({ id: "aaaaaaaaaa", artifact: "decisions", record: { choice: "Canonical entities", satisfaction: { state: "provisionally_satisfied", evidence: "tests pass" } }, provenance: { base: { id: "aaaaaaaaaa" }, revisions: [{ id: "cccccccccc" }], satisfaction: { id: "bbbbbbbbbb" } } });
    expect(JSON.stringify(result)).not.toMatch(/stable_id|artifact_id|entry_number|"number"/);
  });

  it("routes exact get/list through bare IDs and rejects numeric selectors in entity mode", () => {
    const root = project(); base(root); let out = "";
    expect(runStateGet("decisions", ["--id", "aaaaaaaaaa", "--format", "json"], { out: (text) => { out += text; } }, root)).toBe(0);
    expect(JSON.parse(out).entry.id).toBe("aaaaaaaaaa"); out = "";
    expect(runStateList("decisions", ["--limit", "1", "--format", "json"], { out: (text) => { out += text; } }, root)).toBe(0);
    expect(JSON.parse(out).entries[0].id).toBe("aaaaaaaaaa"); out = "";
    expect(runStateGet("decisions", ["--number", "1", "--format", "json"], { out: (text) => { out += text; } }, root)).toBe(2);
    expect(JSON.parse(out).error.message).toMatch(/requires --id/);
  });

  it("explains only bare selectors and base hashes for entity mutations", () => {
    const root = project();
    const update = buildExplain("decisions", root, "update") as any;
    expect(update.fields.map((field: any) => field.flag)).toContain("--id");
    expect(update.fields.map((field: any) => field.flag)).not.toContain("--number");
    const amend = buildExplain("decisions", root, "amend") as any;
    expect(amend.fields.filter((field: any) => field.required).map((field: any) => field.flag)).toEqual(expect.arrayContaining(["--id", "--base-sha256"]));
    expect(amend.example).not.toContain("--number");
  });

  it("enforces satisfaction evidence, user confirmation, transitions, replacement, and replay", () => {
    const root = project(); base(root);
    expect(() => updateDecisionSatisfactionEntity(request(root, "update", { id: "aaaaaaaaaa", satisfaction: { state: "provisionally_satisfied" } }))).toThrow(/requires non-empty/);
    const provisional = updateDecisionSatisfactionEntity(request(root, "update", { id: "aaaaaaaaaa", satisfaction: { state: "provisionally_satisfied", evidence: "green" } }), { id: "bbbbbbbbbb" }) as any;
    expect(provisional.operation.idempotent_replay).toBe(false);
    const confirmed = { id: "aaaaaaaaaa", satisfaction: { state: "user_confirmed_satisfied", user_confirmation: { confirmed_by: "user", confirmed_at: "2026-07-17T12:00:00Z" } } };
    expect(() => updateDecisionSatisfactionEntity(request(root, "update", { id: "aaaaaaaaaa", satisfaction: { state: "user_confirmed_satisfied" } }))).toThrow(/confirmation metadata/);
    updateDecisionSatisfactionEntity(request(root, "update", confirmed));
    expect((updateDecisionSatisfactionEntity(request(root, "update", confirmed)) as any).operation.idempotent_replay).toBe(true);
    expect(fs.readdirSync(path.join(root, ".agentera/entities/decisions/decision_satisfaction"))).toEqual(["bbbbbbbbbb.yaml"]);
  });

  it("validates amendment base hashes and safe paths, converges replays, and rejects divergent IDs", () => {
    const root = project(); base(root); const hash = (getDecisionEntity(root, "aaaaaaaaaa") as any).entry.effective_sha256;
    expect(() => amendDecisionEntity(request(root, "amend", { id: "aaaaaaaaaa", base_sha256: "0".repeat(64), choice: "new" }))).toThrow(/changed from requested base/);
    expect(() => amendDecisionEntity(request(root, "amend", { id: "aaaaaaaaaa", base_sha256: hash, satisfaction: { state: "open" } }))).toThrow(/not amendable/);
    amendDecisionEntity(request(root, "amend", { id: "aaaaaaaaaa", base_sha256: hash, choice: "new" }), { id: "bbbbbbbbbb" });
    expect((amendDecisionEntity(request(root, "amend", { id: "aaaaaaaaaa", base_sha256: hash, choice: "new" })) as any).operation.idempotent_replay).toBe(true);
    const current = getDecisionEntity(root, "aaaaaaaaaa") as any;
    expect((amendDecisionEntity(request(root, "amend", { id: "aaaaaaaaaa", base_sha256: current.entry.effective_sha256, choice: "new" })) as any).operation.idempotent_replay).toBe(true);
    expect(() => amendDecisionEntity(request(root, "amend", { id: "aaaaaaaaaa", base_sha256: current.entry.effective_sha256, choice: "other" }), { id: "bbbbbbbbbb" })).toThrow(/divergent content/);
  });

  it("paginates whole effective entries and invalidates a cursor after mutation", () => {
    const root = project(); base(root, "aaaaaaaaaa", "A"); base(root, "bbbbbbbbbb", "B"); base(root, "cccccccccc", "C");
    const first = listDecisionEntities(root, 1) as any; expect(first.entries).toHaveLength(1); expect(first.next_cursor).toBeTruthy();
    const second = listDecisionEntities(root, 1, undefined, first.next_cursor) as any; expect(second.entries).toHaveLength(1); expect(second.entries[0].id).not.toBe(first.entries[0].id);
    base(root, "dddddddddd", "D"); expect(() => listDecisionEntities(root, 1, undefined, first.next_cursor)).toThrow(/changed after this cursor snapshot/);
  });

  it("binds cursors to every revision and satisfaction input while stable snapshots continue", () => {
    const mutations: Array<[string, (root: string) => void, (root: string) => void]> = [
      ["satisfaction add", () => {}, (root) => { updateDecisionSatisfactionEntity(request(root, "update", { id: "aaaaaaaaaa", satisfaction: { state: "open" } }), { id: "dddddddddd" }); }],
      ["satisfaction mutate", (root) => { updateDecisionSatisfactionEntity(request(root, "update", { id: "aaaaaaaaaa", satisfaction: { state: "open" } }), { id: "dddddddddd" }); }, (root) => { const file = path.join(root, ".agentera/entities/decisions/decision_satisfaction/dddddddddd.yaml"); fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("state: open", "state: provisionally_satisfied\n  evidence: changed")); }],
      ["satisfaction remove", (root) => { updateDecisionSatisfactionEntity(request(root, "update", { id: "aaaaaaaaaa", satisfaction: { state: "open" } }), { id: "dddddddddd" }); }, (root) => { fs.rmSync(path.join(root, ".agentera/entities/decisions/decision_satisfaction/dddddddddd.yaml")); }],
      ["satisfaction ownership conflict", (root) => { updateDecisionSatisfactionEntity(request(root, "update", { id: "aaaaaaaaaa", satisfaction: { state: "open" } }), { id: "dddddddddd" }); }, (root) => { const dir = path.join(root, ".agentera/entities/decisions/decision_satisfaction"); fs.writeFileSync(path.join(dir, "eeeeeeeeee.yaml"), dumpYamlMapping({ id: "eeeeeeeeee", artifact: "decisions", record: { decision: "aaaaaaaaaa", state: "open" } })); }],
      ["revision add", () => {}, (root) => { const hash = (getDecisionEntity(root, "aaaaaaaaaa") as any).entry.effective_sha256; amendDecisionEntity(request(root, "amend", { id: "aaaaaaaaaa", base_sha256: hash, choice: "added" }), { id: "dddddddddd" }); }],
      ["revision mutate", addRevision, (root) => { const file = path.join(root, ".agentera/entities/decisions/decision_revision/dddddddddd.yaml"); fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("choice: revised", "choice: changed")); }],
      ["revision remove", addRevision, (root) => { fs.rmSync(path.join(root, ".agentera/entities/decisions/decision_revision/dddddddddd.yaml")); }],
      ["revision ownership conflict", addRevision, (root) => { const file = path.join(root, ".agentera/entities/decisions/decision_revision/dddddddddd.yaml"); const entity = YAML.parse(fs.readFileSync(file, "utf8")); entity.id = "eeeeeeeeee"; fs.writeFileSync(path.join(path.dirname(file), "eeeeeeeeee.yaml"), dumpYamlMapping(entity)); }],
    ];
    function addRevision(root: string): void { const hash = (getDecisionEntity(root, "aaaaaaaaaa") as any).entry.effective_sha256; amendDecisionEntity(request(root, "amend", { id: "aaaaaaaaaa", base_sha256: hash, choice: "revised" }), { id: "dddddddddd" }); }
    for (const [label, arrange, mutate] of mutations) {
      const root = project(); base(root, "aaaaaaaaaa", "A"); base(root, "bbbbbbbbbb", "B"); base(root, "cccccccccc", "C"); arrange(root);
      const first = listDecisionEntities(root, 1) as any;
      expect(() => listDecisionEntities(root, 1, undefined, first.next_cursor), `${label} stable`).not.toThrow();
      mutate(root);
      expect(() => listDecisionEntities(root, 1, undefined, first.next_cursor), label).toThrow(/changed after this cursor snapshot/);
    }
  });

  it("validates canonical revision schema, authority paths, provenance, hashes, and relations", () => {
    const invalid: Array<[string, Record<string, unknown>]> = [
      ["base hash", { decision: "aaaaaaaaaa", date: "2026-07-17", provenance: "historical_revision", base_sha256: "bad", changes: { choice: "new" } }],
      ["provenance", { decision: "aaaaaaaaaa", date: "2026-07-17", provenance: "historical_archive", base_sha256: "0".repeat(64), changes: { choice: "new" } }],
      ["changes mapping", { decision: "aaaaaaaaaa", date: "2026-07-17", provenance: "historical_revision", base_sha256: "0".repeat(64), changes: ["choice"] }],
      ["non-amendable path", { decision: "aaaaaaaaaa", date: "2026-07-17", provenance: "historical_revision", base_sha256: "0".repeat(64), changes: { unknown: "new" } }],
      ["identity overlap", { decision: "aaaaaaaaaa", date: "2026-07-17", provenance: "historical_revision", base_sha256: "0".repeat(64), changes: { decision: "bbbbbbbbbb", choice: "new" } }],
      ["temporal overlap", { decision: "aaaaaaaaaa", date: "2026-07-17", provenance: "historical_revision", base_sha256: "0".repeat(64), changes: { date: "2026-07-18", choice: "new" } }],
      ["satisfaction overlap", { decision: "aaaaaaaaaa", date: "2026-07-17", provenance: "historical_revision", base_sha256: "0".repeat(64), changes: { satisfaction: { state: "open" }, choice: "new" } }],
      ["relation", { decision: ["aaaaaaaaaa"], date: "2026-07-17", provenance: "historical_revision", base_sha256: "0".repeat(64), changes: { choice: "new" } }],
    ];
    for (const [label, record] of invalid) {
      const root = project(); base(root); const dir = path.join(root, ".agentera/entities/decisions/decision_revision"); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "bbbbbbbbbb.yaml"), dumpYamlMapping({ id: "bbbbbbbbbb", artifact: "decisions", record }));
      expect(validateEntityState(root).valid, label).toBe(false);
    }
    const root = project(); base(root); const hash = (getDecisionEntity(root, "aaaaaaaaaa") as any).entry.effective_sha256;
    amendDecisionEntity(request(root, "amend", { id: "aaaaaaaaaa", base_sha256: hash, choice: "valid" }), { id: "bbbbbbbbbb" });
    expect(validateEntityState(root)).toMatchObject({ valid: true, issues: [] });
  });

  it("fails effective reads and state validation on ambiguous satisfaction or revision ownership", () => {
    const root = project(); base(root); const hash = (getDecisionEntity(root, "aaaaaaaaaa") as any).entry.effective_sha256;
    for (const [id, state] of [["bbbbbbbbbb", "open"], ["cccccccccc", "provisionally_satisfied"]]) { const dir = path.join(root, ".agentera/entities/decisions/decision_satisfaction"); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `${id}.yaml`), dumpYamlMapping({ id, artifact: "decisions", record: { decision: "aaaaaaaaaa", state, ...(state === "provisionally_satisfied" ? { evidence: "x" } : {}) } })); }
    expect(validateEntityState(root).issues.some((issue) => issue.code === "conflicting_ownership")).toBe(true);
    expect(() => getDecisionEntity(root, "aaaaaaaaaa")).toThrow(/competing satisfaction owners/);
    fs.rmSync(path.join(root, ".agentera/entities/decisions/decision_satisfaction"), { recursive: true });
    for (const [id, choice] of [["bbbbbbbbbb", "B"], ["cccccccccc", "C"]]) { const dir = path.join(root, ".agentera/entities/decisions/decision_revision"); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `${id}.yaml`), dumpYamlMapping({ id, artifact: "decisions", record: { decision: "aaaaaaaaaa", date: "2026-07-17", provenance: "historical_revision", base_sha256: hash, changes: { choice } } })); }
    expect(() => getDecisionEntity(root, "aaaaaaaaaa")).toThrow(/competing revisions/);
  });

  it("keeps marker-absent decisions on unchanged legacy authority", () => {
    const root = project(false); executeStateWrite(request(root, "append", { question: "Legacy?", context: "No marker", alternatives: { chosen: "Legacy" }, choice: "Legacy", reasoning: "Cutover is explicit", confidence: "firm" }));
    expect(fs.existsSync(path.join(root, ".agentera/decisions.yaml"))).toBe(true); expect(fs.existsSync(path.join(root, ".agentera/entities"))).toBe(false);
  });

  it("lets Git merge unrelated bases and exposes competing same-decision ownership without data loss", () => {
    const root = project(); git(root, "init", "-b", "main"); git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.test"); git(root, "add", ".agentera/state-mode.yaml"); git(root, "commit", "-m", "base");
    const left = `${root}-left`, right = `${root}-right`; roots.push(left, right); git(root, "worktree", "add", "-b", "left", left, "main"); git(root, "worktree", "add", "-b", "right", right, "main");
    base(left, "aaaaaaaaaa", "left"); base(right, "bbbbbbbbbb", "right"); git(left, "add", ".agentera/entities"); git(left, "commit", "-m", "left"); git(right, "add", ".agentera/entities"); git(right, "commit", "-m", "right"); git(root, "merge", "--ff-only", "left"); git(root, "merge", "--no-edit", "right");
    expect((listDecisionEntities(root, 20) as any).entries.map((entry: any) => entry.id).sort()).toEqual(["aaaaaaaaaa", "bbbbbbbbbb"]);
  });
});
