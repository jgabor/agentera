import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import { dumpYamlMapping } from "../../src/core/yaml.js";
import { canonicalRecordJson } from "../../src/state/archiveDiscovery.js";
import { runStateGet } from "../../src/cli/commands/state/get.js";
import { runStateList } from "../../src/cli/commands/state/list.js";
import { amendDecisionEntity, appendDecisionEntity, getDecisionEntity, listDecisionEntities, updateDecisionSatisfactionEntity } from "../../src/state/decisionEntities.js";
import { canonicalEntityEnvelope, validateEntityState } from "../../src/state/entityStorage.js";
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
    expect(result.entry).toMatchObject({ id: "aaaaaaaaaa", artifact: "decisions", record: { choice: "Canonical entities", satisfaction: { state: "provisionally_satisfied", evidence: "tests pass" } }, provenance: { base: { id: "aaaaaaaaaa", artifact: "decisions" }, revisions: [{ id: "cccccccccc", artifact: "decisions" }], satisfaction: { id: "bbbbbbbbbb", artifact: "decisions" } } });
    expect(JSON.stringify(result)).not.toMatch(/stable_id|artifact_id|entry_number|"number"/);
  });

  it.each(["high", "medium", "low"])("reports migration-proven inherited confidence %s in exact and list reads", (confidence) => {
    const root = project(); base(root);
    const entityPath = path.join(root, ".agentera/entities/decisions/decision/aaaaaaaaaa.yaml");
    const entity = YAML.parse(fs.readFileSync(entityPath, "utf8"));
    entity.record.confidence = confidence;
    const sourceRecord = { number: 1, ...structuredClone(entity.record) };
    const sourceRecordSha256 = createHash("sha256").update(canonicalRecordJson(sourceRecord)).digest("hex");
    fs.writeFileSync(path.join(root, ".agentera/decisions.yaml"), dumpYamlMapping({ decisions: [sourceRecord] }));
    entity.migration_provenance = { kind: "inherited_decision_confidence", source: "current_projection", source_path: ".agentera/decisions.yaml", source_record_sha256: sourceRecordSha256, confidence };
    fs.writeFileSync(entityPath, dumpYamlMapping(entity));
    expect(validateEntityState(root)).toMatchObject({ valid: true });
    expect(() => canonicalEntityEnvelope(fs.readFileSync(entityPath, "utf8"), { artifact: "decisions", boundary: "decision", id: "aaaaaaaaaa" })).toThrow(/requires a source binding context/);
    expect(canonicalEntityEnvelope(fs.readFileSync(entityPath, "utf8"), { artifact: "decisions", boundary: "decision", id: "aaaaaaaaaa" }, undefined, { kind: "project", projectRoot: root }).migrationProvenance).toEqual(entity.migration_provenance);

    for (const entry of [(getDecisionEntity(root, "aaaaaaaaaa") as any).entry, (listDecisionEntities(root, 20) as any).entries[0]]) {
      expect(entry).toMatchObject({
        record: { confidence },
        provenance: { base: { migration_provenance: entity.migration_provenance } },
        caveats: [expect.stringContaining(`inherited unsupported confidence label '${confidence}'`)],
      });
      expect(entry.record).not.toHaveProperty("migration_provenance");
      expect(entry.effective_sha256).toBe(createHash("sha256").update(canonicalRecordJson(entry.record)).digest("hex"));
    }
  });

  it.each([
    ["known legacy without provenance", "high", undefined],
    ["arbitrary unsupported", "certain", undefined],
    ["arbitrary unsupported with fabricated provenance", "certain", { kind: "inherited_decision_confidence", source: "current_projection", source_path: ".agentera/decisions.yaml", source_record_sha256: "c".repeat(64), confidence: "certain" }],
    ["current confidence with provenance", "firm", { kind: "inherited_decision_confidence", source: "current_projection", source_path: ".agentera/decisions.yaml", source_record_sha256: "d".repeat(64), confidence: "firm" }],
    ["malformed provenance", "high", { kind: "inherited_decision_confidence" }],
    ["mismatched provenance", "high", { kind: "inherited_decision_confidence", source: "verified_archive", source_path: ".agentera/archive/decisions/1.yaml", source_record_sha256: "b".repeat(64), confidence: "low" }],
  ])("rejects canonical confidence state with %s", (_label, confidence, provenance) => {
    const root = project(); base(root);
    const entityPath = path.join(root, ".agentera/entities/decisions/decision/aaaaaaaaaa.yaml");
    const entity = YAML.parse(fs.readFileSync(entityPath, "utf8"));
    entity.record.confidence = confidence;
    if (provenance) entity.migration_provenance = provenance;
    fs.writeFileSync(entityPath, dumpYamlMapping(entity));
    expect(validateEntityState(root).valid).toBe(false);
    expect(() => getDecisionEntity(root, "aaaaaaaaaa")).toThrow(/not canonical/);
    expect(() => listDecisionEntities(root, 20)).toThrow(/not canonical/);
  });

  it.each([
    ["nonexistent projection", (root: string, source: Record<string, any>) => ({ source: "current_projection", source_path: ".agentera/decisions.yaml", digest: "a".repeat(64) })],
    ["fabricated projection digest", (root: string, source: Record<string, any>) => { fs.writeFileSync(path.join(root, ".agentera/decisions.yaml"), dumpYamlMapping({ decisions: [source] })); return { source: "current_projection", source_path: ".agentera/decisions.yaml", digest: "b".repeat(64) }; }],
    ["projection content mismatch", (root: string, source: Record<string, any>) => { source.choice = "Different source choice"; fs.writeFileSync(path.join(root, ".agentera/decisions.yaml"), dumpYamlMapping({ decisions: [source] })); return { source: "current_projection", source_path: ".agentera/decisions.yaml", digest: createHash("sha256").update(canonicalRecordJson(source)).digest("hex") }; }],
    ["wrong projection path", (root: string, source: Record<string, any>) => { fs.writeFileSync(path.join(root, ".agentera/decisions.yaml"), dumpYamlMapping({ decisions: [source] })); return { source: "current_projection", source_path: ".agentera/not-decisions.yaml", digest: createHash("sha256").update(canonicalRecordJson(source)).digest("hex") }; }],
    ["symlinked projection", (root: string, source: Record<string, any>) => { fs.writeFileSync(path.join(root, ".agentera/real-decisions.yaml"), dumpYamlMapping({ decisions: [source] })); fs.symlinkSync("real-decisions.yaml", path.join(root, ".agentera/decisions.yaml")); return { source: "current_projection", source_path: ".agentera/decisions.yaml", digest: createHash("sha256").update(canonicalRecordJson(source)).digest("hex") }; }],
    ["malformed archive", (root: string, source: Record<string, any>) => { const dir = path.join(root, ".agentera/archive/decisions"); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "1.yaml"), "not: an archive\n"); return { source: "verified_archive", source_path: ".agentera/archive/decisions/1.yaml", digest: createHash("sha256").update(canonicalRecordJson(source)).digest("hex") }; }],
    ["wrong archive path", (root: string, source: Record<string, any>) => ({ source: "verified_archive", source_path: ".agentera/archive/decisions/not-a-number.yaml", digest: createHash("sha256").update(canonicalRecordJson(source)).digest("hex") })],
    ["wrong archive identity", (root: string, source: Record<string, any>) => { const dir = path.join(root, ".agentera/archive/decisions"); fs.mkdirSync(dir, { recursive: true }); const digest = createHash("sha256").update(canonicalRecordJson(source)).digest("hex"); fs.writeFileSync(path.join(dir, "1.yaml"), dumpYamlMapping({ schemaVersion: "agentera.stateArchiveEntry.v1", artifact_id: "decisions", entry_number: 2, record: source, record_sha256: digest })); return { source: "verified_archive", source_path: ".agentera/archive/decisions/1.yaml", digest }; }],
    ["symlinked archive", (root: string, source: Record<string, any>) => { const dir = path.join(root, ".agentera/archive/decisions"); fs.mkdirSync(dir, { recursive: true }); const digest = createHash("sha256").update(canonicalRecordJson(source)).digest("hex"); fs.writeFileSync(path.join(dir, "real.yaml"), dumpYamlMapping({ schemaVersion: "agentera.stateArchiveEntry.v1", artifact_id: "decisions", entry_number: 1, record: source, record_sha256: digest })); fs.symlinkSync("real.yaml", path.join(dir, "1.yaml")); return { source: "verified_archive", source_path: ".agentera/archive/decisions/1.yaml", digest }; }],
  ])("rejects source-unbound inherited provenance: %s", (_label, arrange) => {
    const root = project(); base(root);
    const entityPath = path.join(root, ".agentera/entities/decisions/decision/aaaaaaaaaa.yaml");
    const entity = YAML.parse(fs.readFileSync(entityPath, "utf8"));
    entity.record.confidence = "high";
    const sourceRecord = { number: 1, ...structuredClone(entity.record) };
    const binding = arrange(root, sourceRecord);
    entity.migration_provenance = { kind: "inherited_decision_confidence", source: binding.source, source_path: binding.source_path, source_record_sha256: binding.digest, confidence: "high" };
    fs.writeFileSync(entityPath, dumpYamlMapping(entity));
    expect(validateEntityState(root).valid).toBe(false);
    expect(() => getDecisionEntity(root, "aaaaaaaaaa")).toThrow(/not canonical/);
  });

  it("keeps inherited provenance out of amendments and caveats only the effective inherited label", () => {
    const root = project(); base(root);
    const entityPath = path.join(root, ".agentera/entities/decisions/decision/aaaaaaaaaa.yaml");
    const entity = YAML.parse(fs.readFileSync(entityPath, "utf8"));
    entity.record.confidence = "high";
    const sourceRecord = { number: 1, ...structuredClone(entity.record) };
    const sourceRecordSha256 = createHash("sha256").update(canonicalRecordJson(sourceRecord)).digest("hex");
    const archiveDir = path.join(root, ".agentera/archive/decisions");
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(path.join(archiveDir, "1.yaml"), dumpYamlMapping({ schemaVersion: "agentera.stateArchiveEntry.v1", artifact_id: "decisions", entry_number: 1, record: sourceRecord, record_sha256: sourceRecordSha256 }));
    entity.migration_provenance = { kind: "inherited_decision_confidence", source: "verified_archive", source_path: ".agentera/archive/decisions/1.yaml", source_record_sha256: sourceRecordSha256, confidence: "high" };
    fs.writeFileSync(entityPath, dumpYamlMapping(entity));

    const inherited = (getDecisionEntity(root, "aaaaaaaaaa") as any).entry;
    amendDecisionEntity(request(root, "amend", { id: "aaaaaaaaaa", base_sha256: inherited.effective_sha256, choice: "Still inherited" }), { id: "bbbbbbbbbb" });
    const unchangedConfidence = (getDecisionEntity(root, "aaaaaaaaaa") as any).entry;
    expect(unchangedConfidence.caveats).toHaveLength(1);
    expect(unchangedConfidence.provenance.revisions[0]).not.toHaveProperty("migration_provenance");
    amendDecisionEntity(request(root, "amend", { id: "aaaaaaaaaa", base_sha256: unchangedConfidence.effective_sha256, confidence: "firm" }), { id: "cccccccccc" });
    const current = (getDecisionEntity(root, "aaaaaaaaaa") as any).entry;
    expect(current.record.confidence).toBe("firm");
    expect(current).not.toHaveProperty("caveats");
    expect(current.provenance.base.migration_provenance.confidence).toBe("high");
    expect(validateEntityState(root).valid).toBe(true);
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

  it("invalidates list cursors after a valid migration-provenance-only change", () => {
    const root = project(); base(root, "aaaaaaaaaa", "A"); base(root, "bbbbbbbbbb", "B"); base(root, "cccccccccc", "C");
    const entityPath = path.join(root, ".agentera/entities/decisions/decision/aaaaaaaaaa.yaml");
    const entity = YAML.parse(fs.readFileSync(entityPath, "utf8"));
    entity.record.confidence = "high";
    const sourceRecord = { number: 1, ...structuredClone(entity.record) };
    const digest = createHash("sha256").update(canonicalRecordJson(sourceRecord)).digest("hex");
    fs.writeFileSync(path.join(root, ".agentera/decisions.yaml"), dumpYamlMapping({ decisions: [sourceRecord] }));
    const archiveDir = path.join(root, ".agentera/archive/decisions"); fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(path.join(archiveDir, "1.yaml"), dumpYamlMapping({ schemaVersion: "agentera.stateArchiveEntry.v1", artifact_id: "decisions", entry_number: 1, record: sourceRecord, record_sha256: digest }));
    entity.migration_provenance = { kind: "inherited_decision_confidence", source: "current_projection", source_path: ".agentera/decisions.yaml", source_record_sha256: digest, confidence: "high" };
    fs.writeFileSync(entityPath, dumpYamlMapping(entity));
    const first = listDecisionEntities(root, 1) as any;
    entity.migration_provenance = { ...entity.migration_provenance, source: "verified_archive", source_path: ".agentera/archive/decisions/1.yaml" };
    fs.writeFileSync(entityPath, dumpYamlMapping(entity));
    expect(validateEntityState(root).valid).toBe(true);
    expect(() => listDecisionEntities(root, 1, undefined, first.next_cursor)).toThrow(/changed after this cursor snapshot/);
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
      const expected = label.includes("ownership conflict") ? /competing/ : /changed after this cursor snapshot/;
      expect(() => listDecisionEntities(root, 1, undefined, first.next_cursor), label).toThrow(expected);
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

  it("rejects marker-absent decisions without publishing an aggregate", () => {
    const root = project(false);
    expect(() => executeStateWrite(request(root, "append", { question: "Legacy?", context: "No marker", alternatives: { chosen: "Legacy" }, choice: "Legacy", reasoning: "Cutover is explicit", confidence: "firm" }))).toThrow(/durable entity-state marker/);
    expect(fs.existsSync(path.join(root, ".agentera/decisions.yaml"))).toBe(false); expect(fs.existsSync(path.join(root, ".agentera/entities"))).toBe(false);
  });

  it("lets Git merge unrelated bases and exposes competing same-decision ownership without data loss", () => {
    const root = project(); git(root, "init", "-b", "main"); git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.test"); git(root, "add", ".agentera/state-mode.yaml"); git(root, "commit", "-m", "base");
    const left = `${root}-left`, right = `${root}-right`; roots.push(left, right); git(root, "worktree", "add", "-b", "left", left, "main"); git(root, "worktree", "add", "-b", "right", right, "main");
    base(left, "aaaaaaaaaa", "left"); base(right, "bbbbbbbbbb", "right"); git(left, "add", ".agentera/entities"); git(left, "commit", "-m", "left"); git(right, "add", ".agentera/entities"); git(right, "commit", "-m", "right"); git(root, "merge", "--ff-only", "left"); git(root, "merge", "--no-edit", "right");
    expect((listDecisionEntities(root, 20) as any).entries.map((entry: any) => entry.id).sort()).toEqual(["aaaaaaaaaa", "bbbbbbbbbb"]);
  });
});
