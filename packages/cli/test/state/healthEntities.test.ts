import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runStateGet } from "../../src/cli/commands/state/get.js";
import { runStateList } from "../../src/cli/commands/state/list.js";
import { runStateWrite } from "../../src/cli/commands/state/write.js";
import { dumpYamlMapping } from "../../src/core/yaml.js";
import {
  appendHealthEntity,
  getHealthEntity,
  listHealthEntities,
} from "../../src/state/healthEntities.js";
import { validateEntityState } from "../../src/state/entityStorage.js";
import { buildExplain } from "../../src/state/write/explain.js";
import { executeStateWrite } from "../../src/state/write/transaction.js";
import { operationSpec, type StateWriteRequest } from "../../src/state/write/operations.js";

const roots: string[] = [];

function project(entity = true): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-health-entities-"));
  roots.push(root);
  if (entity) {
    fs.mkdirSync(path.join(root, ".agentera"), { recursive: true });
    fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
  }
  return root;
}

function audit(date = "2026-07-17", trajectory = "stable"): Record<string, unknown> {
  return {
    date,
    dimensions: ["architecture_alignment"],
    findings_summary: { critical: 0, warning: 1, info: 0, filtered_by_confidence: 0 },
    trajectory,
    grades: { architecture_alignment: "B" },
    dimensions_detail: [{
      name: "architecture_alignment",
      grade: "B",
      summary: "Entity authority is explicit.",
      findings: [{
        heading: "Repair evidence retained",
        location: "state health",
        evidence: "validator output and exact command",
        impact: "operators can recover without guessed history",
        suggested_action: "run agentera check validate state",
        severity: "warning",
        confidence: "high",
      }],
    }],
  };
}

function request(root: string, verb: "append" | "repair", values: Record<string, unknown>, dryRun = false): StateWriteRequest {
  const spec = operationSpec("health", verb);
  if (!spec) throw new Error(`health ${verb} spec missing`);
  return {
    artifact: "health",
    spec,
    projectRoot: root,
    dryRun,
    force: verb === "repair",
    values: verb === "append" ? {} : values,
    callerPayload: structuredClone(values),
    input: verb === "append" ? values : null,
  };
}

function append(root: string, id: string, date = "2026-07-17", trajectory = "stable"): void {
  appendHealthEntity(request(root, "append", audit(date, trajectory)), { id });
}

function legacy(root: string, id: string, date = "2026-07-17", trajectory = "stable"): void {
  const directory = path.join(root, ".agentera/entities/health/health_audit");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${id}.yaml`), dumpYamlMapping({ id, artifact: "health", record: audit(date, trajectory) }));
}

function git(root: string, ...args: string[]): string {
  const env = { ...process.env };
  delete env.GIT_DIR; delete env.GIT_WORK_TREE; delete env.GIT_INDEX_FILE;
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("health entity authority", () => {
  it("routes public input as the exact entity record and rejects envelopes before effects", () => {
    const root = project();
    const supplied = audit();
    const input = path.join(root, "audit.yaml");
    fs.writeFileSync(input, dumpYamlMapping(supplied));
    let out = "";
    let err = "";
    expect(runStateWrite("health", ["append", "--input", input, "--project", root, "--format", "json"], {
      out: (text) => { out += text; },
      err: (text) => { err += text; },
    })).toBe(0);
    expect(err).toBe("");
    const published = JSON.parse(out);
    expect(published).toMatchObject({ id: expect.stringMatching(/^[a-z]{10}$/), artifact: "health" });
    expect(published.record).toEqual({ ...supplied, appended_at: expect.any(String) });
    expect((getHealthEntity(root, published.id) as any).entry).toEqual(expect.objectContaining({
      id: published.id,
      artifact: "health",
      record: { ...supplied, appended_at: expect.any(String) },
    }));
    expect(fs.existsSync(path.join(root, ".agentera/health.yaml"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".agentera/archive"))).toBe(false);

    for (const forbidden of [
      { id: "aaaaaaaaaa", ...supplied },
      { artifact: "health", ...supplied },
      { number: 1, ...supplied },
      { stable_id: "health:1", ...supplied },
      { artifact_id: "health", ...supplied },
      { entry_number: 1, ...supplied },
      { appended_at: "2026-07-17T12:00:00.000Z", ...supplied },
      { record: supplied },
      { audit: supplied },
      { audits: [supplied] },
    ]) {
      const rejectedRoot = project();
      const rejectedInput = path.join(rejectedRoot, "audit.yaml");
      fs.writeFileSync(rejectedInput, dumpYamlMapping(forbidden));
      expect(runStateWrite("health", ["append", "--input", rejectedInput, "--project", rejectedRoot, "--format", "json"], {
        out: () => {},
        err: () => {},
      })).not.toBe(0);
      expect(fs.existsSync(path.join(rejectedRoot, ".agentera/entities"))).toBe(false);
      expect(fs.existsSync(path.join(rejectedRoot, ".agentera/health.yaml"))).toBe(false);
      expect(fs.existsSync(path.join(rejectedRoot, ".agentera/archive"))).toBe(false);
    }
  });

  it("publishes one immutable canonical audit with no projection, archive, or numeric vocabulary", () => {
    const root = project();
    const result = executeStateWrite(request(root, "append", audit())) as any;
    expect(result).toMatchObject({ artifact: "health", id: expect.stringMatching(/^[a-z]{10}$/), record: { date: "2026-07-17", appended_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) } });
    expect(fs.existsSync(path.join(root, ".agentera/health.yaml"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".agentera/archive"))).toBe(false);
    expect(validateEntityState(root)).toMatchObject({ valid: true, entityCount: 1 });
    expect(JSON.stringify(result)).not.toMatch(/stable_id|artifact_id|entry_number|"number"/);
  });

  it("explains entity append and immutable repair without legacy selectors or compaction", () => {
    const root = project();
    const appendExplain = buildExplain("health", root, "append") as any;
    expect(appendExplain).toMatchObject({
      path: ".agentera/entities/health/health_audit/<id>.yaml",
      next: {},
      compaction: expect.stringContaining("not applicable"),
      input_schema: { cli_owned_fields: ["id", "artifact", "appended_at"] },
    });
    expect(JSON.stringify(appendExplain)).not.toMatch(/entry_number|stable_id|"number"/);
    const repairExplain = buildExplain("health", root, "repair") as any;
    expect(repairExplain.fields).toEqual([]);
    expect(repairExplain.example).toBe("agentera check validate state --format json");
    expect(repairExplain.guidance.join(" ")).toMatch(/immutable.*check validate state/i);
  });

  it("gets and lists legacy full audits by bare ID with deterministic date and ID fallback", () => {
    const root = project();
    legacy(root, "bbbbbbbbbb", "2026-07-16", "improving");
    legacy(root, "cccccccccc", "2026-07-17");
    legacy(root, "aaaaaaaaaa", "2026-07-17");
    const exact = getHealthEntity(root, "aaaaaaaaaa") as any;
    expect(exact.entry).toMatchObject({
      id: "aaaaaaaaaa",
      artifact: "health",
      record: { dimensions_detail: [{ findings: [{ evidence: "validator output and exact command", suggested_action: "run agentera check validate state" }] }] },
      provenance: { storage: "canonical_entity_file", boundary: "health_audit", detail: "full" },
      retrieval: { get: "agentera state health get --id aaaaaaaaaa --format json" },
    });
    const listed = listHealthEntities(root, 20) as any;
    expect(listed.entries.map((entry: any) => entry.id)).toEqual(["aaaaaaaaaa", "cccccccccc", "bbbbbbbbbb"]);
    expect(listed.snapshot.order).toBe("appended_at_desc_then_id_asc_then_legacy_date_desc_then_id_asc");
    expect(JSON.stringify(listed)).toContain("validator output and exact command");
  });

  it("orders a later same-day CLI append before an older random ID", () => {
    const root = project();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-17T10:00:00.000Z"));
      append(root, "aaaaaaaaaa");
      vi.setSystemTime(new Date("2026-07-17T11:00:00.000Z"));
      append(root, "zzzzzzzzzz");
      append(root, "mmmmmmmmmm");

      const listed = listHealthEntities(root, 20) as any;
      expect(listed.entries.map((entry: any) => entry.id)).toEqual(["mmmmmmmmmm", "zzzzzzzzzz", "aaaaaaaaaa"]);
      expect(listed.entries.map((entry: any) => entry.record.appended_at)).toEqual([
        "2026-07-17T11:00:00.000Z",
        "2026-07-17T11:00:00.000Z",
        "2026-07-17T10:00:00.000Z",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes public get/list to entity authority and preserves whole-entry bounds with exact recovery", () => {
    const root = project(); legacy(root, "aaaaaaaaaa"); legacy(root, "bbbbbbbbbb", "2026-07-16");
    let out = "";
    expect(runStateGet("health", ["--id", "aaaaaaaaaa", "--format", "json"], { out: (text) => { out += text; } }, root)).toBe(0);
    expect(JSON.parse(out).entry.id).toBe("aaaaaaaaaa"); out = "";
    expect(runStateList("health", ["--limit", "1", "--format", "json"], { out: (text) => { out += text; } }, root)).toBe(0);
    const first = JSON.parse(out);
    expect(first).toMatchObject({ omitted: true, omitted_count: 1, omission_reason: "page_limit", retrieval: { get: "agentera state health get --id ID --format json" } });
    expect(JSON.stringify(first.entries[0])).toContain("validator output and exact command"); out = "";
    expect(runStateList("health", ["--limit", "1", "--cursor", first.next_cursor, "--format", "json"], { out: (text) => { out += text; } }, root)).toBe(0);
    expect(JSON.parse(out).entries[0].id).toBe("bbbbbbbbbb");
    expect(runStateGet("health", ["--number", "1", "--format", "json"], { out: () => {} }, root)).toBe(2);
  });

  it("binds cursors to an exact snapshot", () => {
    for (const mutation of ["add", "remove", "change"] as const) {
      const root = project(); legacy(root, "aaaaaaaaaa"); legacy(root, "bbbbbbbbbb", "2026-07-16");
      const first = listHealthEntities(root, 1) as any;
      if (mutation === "add") append(root, "cccccccccc", "2026-07-15");
      if (mutation === "remove") fs.rmSync(path.join(root, ".agentera/entities/health/health_audit/bbbbbbbbbb.yaml"));
      if (mutation === "change") fs.appendFileSync(path.join(root, ".agentera/entities/health/health_audit/bbbbbbbbbb.yaml"), "extra: invalid\n");
      expect(() => listHealthEntities(root, 1, undefined, first.next_cursor), mutation).toThrow(/changed after this cursor snapshot|canonical/);
    }
  });

  it("converges identical retries, rejects divergent IDs, and fails corrupt, missing, or conflicting detail", () => {
    const root = project();
    const first = appendHealthEntity(request(root, "append", audit()), { id: "aaaaaaaaaa" }) as any;
    expect(first.operation.idempotent_replay).toBe(false);
    expect((appendHealthEntity(request(root, "append", audit()), { id: "aaaaaaaaaa" }) as any).operation.idempotent_replay).toBe(true);
    expect(() => appendHealthEntity(request(root, "append", audit("2026-07-16")), { id: "aaaaaaaaaa" })).toThrow(/divergent content/);
    expect(() => getHealthEntity(root, "bbbbbbbbbb")).toThrow(/not found|no health entity/);
    fs.writeFileSync(path.join(root, ".agentera/entities/health/health_audit/aaaaaaaaaa.yaml"), dumpYamlMapping({ id: "aaaaaaaaaa", artifact: "health", record: { date: "2026-07-17" } }));
    expect(validateEntityState(root).valid).toBe(false);
    expect(() => getHealthEntity(root, "aaaaaaaaaa")).toThrow(/corrupt|audit contract/);
    fs.writeFileSync(path.join(root, ".agentera/entities/health/health_audit/aaaaaaaaaa.yaml"), "not: [valid\n");
    expect(() => getHealthEntity(root, "aaaaaaaaaa")).toThrow(/corrupt|canonical/);
    expect(() => listHealthEntities(root, 20)).toThrow(/corrupt|canonical/);
    const conflict = path.join(root, ".agentera/entities/progress/progress_cycle"); fs.mkdirSync(conflict, { recursive: true });
    fs.writeFileSync(path.join(conflict, "aaaaaaaaaa.yaml"), dumpYamlMapping({ id: "aaaaaaaaaa", artifact: "progress", record: { timestamp: "2026-07-17 12:00", type: "fix", phase: "build", what: "conflict", context: { intent: "conflict" } } }));
    expect(() => getHealthEntity(root, "aaaaaaaaaa")).toThrow(/multiple canonical candidates|ambiguous/);
  });

  it("rejects entity repair and marker-absent repair before effects", () => {
    const root = project(); append(root, "aaaaaaaaaa");
    const before = fs.readFileSync(path.join(root, ".agentera/entities/health/health_audit/aaaaaaaaaa.yaml"), "utf8");
    expect(() => executeStateWrite(request(root, "repair", { number: 1, keep: "first" }))).toThrow(/immutable.*check validate state/i);
    expect(fs.readFileSync(path.join(root, ".agentera/entities/health/health_audit/aaaaaaaaaa.yaml"), "utf8")).toBe(before);
    expect(fs.existsSync(path.join(root, ".agentera/health.yaml"))).toBe(false);

    const legacy = project(false); const target = path.join(legacy, ".agentera/health.yaml"); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, dumpYamlMapping({ audits: [{ number: 20, ...audit() }], archive: ["Audit 14 (2026-04-26): first", "Audit 14 (2026-04-26): duplicate"] }));
    expect(() => executeStateWrite(request(legacy, "repair", { number: 14, keep: "first" }))).toThrow(/durable entity-state marker/);
    expect(fs.readFileSync(target, "utf8")).toBe(dumpYamlMapping({ audits: [{ number: 20, ...audit() }], archive: ["Audit 14 (2026-04-26): first", "Audit 14 (2026-04-26): duplicate"] }));
  });

  it("rejects marker-absent append without publishing an aggregate", () => {
    const root = project(false); expect(() => executeStateWrite(request(root, "append", audit()))).toThrow(/durable entity-state marker/);
    expect(fs.existsSync(path.join(root, ".agentera/health.yaml"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".agentera/entities"))).toBe(false);
  });

  it("lets Git merge unrelated audits and exposes same-ID conflicts", () => {
    const root = project(); git(root, "init", "-b", "main"); git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.test"); git(root, "add", ".agentera/state-mode.yaml"); git(root, "commit", "-m", "base");
    const left = `${root}-left`, right = `${root}-right`; roots.push(left, right); git(root, "worktree", "add", "-b", "left", left, "main"); git(root, "worktree", "add", "-b", "right", right, "main");
    append(left, "aaaaaaaaaa"); append(right, "bbbbbbbbbb", "2026-07-16"); git(left, "add", ".agentera/entities"); git(left, "commit", "-m", "left"); git(right, "add", ".agentera/entities"); git(right, "commit", "-m", "right"); git(root, "merge", "--ff-only", "left"); git(root, "merge", "--no-edit", "right");
    expect((listHealthEntities(root, 20) as any).entries.map((entry: any) => entry.id).sort()).toEqual(["aaaaaaaaaa", "bbbbbbbbbb"]);

    const conflict = project(); git(conflict, "init", "-b", "main"); git(conflict, "config", "user.name", "Fixture"); git(conflict, "config", "user.email", "fixture@example.test"); git(conflict, "add", ".agentera/state-mode.yaml"); git(conflict, "commit", "-m", "base");
    const conflictLeft = `${conflict}-left`, conflictRight = `${conflict}-right`; roots.push(conflictLeft, conflictRight); git(conflict, "worktree", "add", "-b", "conflict-left", conflictLeft, "main"); git(conflict, "worktree", "add", "-b", "conflict-right", conflictRight, "main");
    append(conflictLeft, "aaaaaaaaaa"); append(conflictRight, "aaaaaaaaaa", "2026-07-16"); git(conflictLeft, "add", ".agentera/entities"); git(conflictLeft, "commit", "-m", "left"); git(conflictRight, "add", ".agentera/entities"); git(conflictRight, "commit", "-m", "right"); git(conflict, "merge", "--ff-only", "conflict-left");
    expect(() => git(conflict, "merge", "--no-edit", "conflict-right")).toThrow();
  });
});
