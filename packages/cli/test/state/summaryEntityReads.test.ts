import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cmdPrime } from "../../src/cli/commands/prime.js";
import { main } from "../../src/cli/dispatch.js";
import { dumpYamlMapping } from "../../src/core/yaml.js";
import { canonicalRecordJson } from "../../src/state/archiveDiscovery.js";
import { amendDecisionEntity, appendDecisionEntity, getDecisionEntity, listDecisionEntities, updateDecisionSatisfactionEntity } from "../../src/state/decisionEntities.js";
import { appendHealthEntity, getHealthEntity, listHealthEntities } from "../../src/state/healthEntities.js";
import { appendProgressEntity, getProgressEntity, listProgressEntities } from "../../src/state/progressEntities.js";
import { operationSpec, type StateWriteRequest } from "../../src/state/write/operations.js";
import { projectedListSnapshot } from "../../src/state/listCursor.js";

const SOURCE_ROOT = path.resolve(import.meta.dirname, "../../../..");
const roots: string[] = [];

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-summary-reads-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".agentera"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
  return root;
}

function request(root: string, artifact: "progress" | "decisions" | "health", verb: "append" | "amend" | "update", values: Record<string, unknown>, dryRun = false): StateWriteRequest {
  const spec = operationSpec(artifact, verb);
  if (!spec) throw new Error(`${artifact} ${verb} spec missing`);
  return { artifact, spec, projectRoot: root, dryRun, force: false, values, callerPayload: structuredClone(values), input: artifact === "health" && verb === "append" ? values : null };
}

function audit(): Record<string, unknown> {
  return {
    date: "2026-07-17", dimensions: ["architecture_alignment"], findings_summary: { critical: 0, warning: 0, info: 0, filtered_by_confidence: 0 }, trajectory: "stable", grades: { architecture_alignment: "A" },
  };
}

function summary(root: string, artifact: "progress" | "decisions" | "health", id: string, text: string, satisfaction?: Record<string, unknown>): void {
  const sourcePath = `.agentera/${artifact}.yaml`;
  const collection = artifact === "progress" ? "cycles" : artifact === "decisions" ? "decisions" : "audits";
  const physical = { number: 1, summary: text, ...(satisfaction ? { satisfaction } : {}) };
  const sourceFile = path.join(root, sourcePath);
  const document = fs.existsSync(sourceFile) ? YAML.parse(fs.readFileSync(sourceFile, "utf8")) : {};
  document[collection] = [...(Array.isArray(document[collection]) ? document[collection] : []), physical];
  fs.writeFileSync(sourceFile, dumpYamlMapping(document));
  const digest = createHash("sha256").update(canonicalRecordJson(physical)).digest("hex");
  const boundary = artifact === "progress" ? "progress_summary" : artifact === "decisions" ? "decision_summary" : "health_summary";
  fs.mkdirSync(path.join(root, ".agentera/entities", artifact, boundary), { recursive: true });
  fs.writeFileSync(path.join(root, ".agentera/entities", artifact, boundary, `${id}.yaml`), dumpYamlMapping({
    id,
    artifact,
    record: { summary: text, ...(satisfaction ? { satisfaction } : {}), migration_provenance: { source_path: sourcePath, source_record_sha256: digest } },
  }));
}

function cli(root: string, args: string[]): { rc: number; out: string; err: string } {
  const previous = process.cwd();
  const sourceRoot = process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  process.chdir(root); process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = SOURCE_ROOT;
  let out = ""; let err = "";
  try {
    const rc = main(["node", "agentera", ...args], { out: (value) => { out += value; }, err: (value) => { err += value; }, stdin: () => args.includes("--input") ? JSON.stringify({ choice: "cannot amend" }) : "" });
    return { rc, out, err };
  } finally {
    process.chdir(previous);
    if (sourceRoot === undefined) delete process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
    else process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = sourceRoot;
  }
}

function full(root: string): void {
  appendProgressEntity(request(root, "progress", "append", { timestamp: "2026-07-17 12:00", type: "fix", phase: "build", what: "full progress", context: { intent: "retain ordinary detail" } }), { id: "aaaaaaaaaa", sourceRoot: SOURCE_ROOT });
  appendDecisionEntity(request(root, "decisions", "append", { date: "2026-07-17", question: "Full decision?", context: "Current detail", alternatives: { chosen: "yes" }, choice: "yes", reasoning: "full evidence", confidence: "firm" }), { id: "bbbbbbbbbb", sourceRoot: SOURCE_ROOT });
  appendHealthEntity(request(root, "health", "append", audit()), { id: "cccccccccc", sourceRoot: SOURCE_ROOT });
}

function mixed(root: string): void {
  full(root);
  summary(root, "progress", "dddddddddd", "retained progress history");
  summary(root, "decisions", "eeeeeeeeee", "retained decision history", { state: "user_confirmed_satisfied" });
  summary(root, "health", "ffffffffff", "retained health history");
}

function signatureAlias(token: string): string {
  const [payload, signature] = token.split(".");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  for (const replacement of alphabet) {
    const candidate = `${signature!.slice(0, -1)}${replacement}`;
    if (candidate !== signature && Buffer.from(candidate, "base64url").equals(Buffer.from(signature!, "base64url"))) {
      return `${payload}.${candidate}`;
    }
  }
  throw new Error("expected a noncanonical signature alias");
}

afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

describe("summary entity ordinary reads", () => {
  it("lists and gets full and immutable summary records with explicit retained-history metadata", () => {
    const root = project(); mixed(root);
    const readers = [
      ["progress", listProgressEntities(root, 20, {}, undefined, { sourceRoot: SOURCE_ROOT }), getProgressEntity(root, "dddddddddd", SOURCE_ROOT), "dddddddddd"],
      ["decisions", listDecisionEntities(root, 20, undefined, undefined, { sourceRoot: SOURCE_ROOT }), getDecisionEntity(root, "eeeeeeeeee", SOURCE_ROOT), "eeeeeeeeee"],
      ["health", listHealthEntities(root, 20, undefined, undefined, { sourceRoot: SOURCE_ROOT }), getHealthEntity(root, "ffffffffff", SOURCE_ROOT), "ffffffffff"],
    ] as const;
    for (const [artifact, listed, exact, summaryId] of readers) {
      const entries = (listed as any).entries;
      expect(entries.map((entry: any) => entry.id)).toContain(summaryId);
      expect(entries.find((entry: any) => entry.detail_availability === "full")).toMatchObject({ compatibility: "current", boundary: ({ progress: "progress_cycle", decisions: "decision", health: "health_audit" } as const)[artifact] });
      expect((exact as any)).toMatchObject({ status: "degraded", entry: {
        id: summaryId, artifact, detail_availability: "summary", compatibility: "degraded",
        record: { migration_provenance: { source_path: `.agentera/${artifact}.yaml`, source_record_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } },
        provenance: { boundary: ({ progress: "progress_summary", decisions: "decision_summary", health: "health_summary" } as const)[artifact], migration_provenance: expect.any(Object) },
        caveats: [expect.stringContaining("incomplete historical evidence")],
      } });
    }
    expect((getDecisionEntity(root, "eeeeeeeeee", SOURCE_ROOT) as any).entry.record.satisfaction).toEqual({ state: "user_confirmed_satisfied" });
  });

  it("orders summaries without absent temporal fields and invalidates a cursor when their retained provenance changes", () => {
    const root = project(); mixed(root);
    const pages = [
      [listProgressEntities(root, 1, {}, undefined, { sourceRoot: SOURCE_ROOT }), (cursor: string) => listProgressEntities(root, 1, {}, cursor, { sourceRoot: SOURCE_ROOT }), "aaaaaaaaaa", "dddddddddd"],
      [listDecisionEntities(root, 1, undefined, undefined, { sourceRoot: SOURCE_ROOT }), (cursor: string) => listDecisionEntities(root, 1, undefined, cursor, { sourceRoot: SOURCE_ROOT }), "bbbbbbbbbb", "eeeeeeeeee"],
      [listHealthEntities(root, 1, undefined, undefined, { sourceRoot: SOURCE_ROOT }), (cursor: string) => listHealthEntities(root, 1, undefined, cursor, { sourceRoot: SOURCE_ROOT }), "cccccccccc", "ffffffffff"],
    ] as const;
    for (const [first, continuePage, fullId, summaryId] of pages) {
      expect((first as any)).toMatchObject({ omitted: true, omitted_count: 1, entries: [{ id: fullId, detail_availability: "full" }] });
      expect((continuePage((first as any).next_cursor) as any).entries).toMatchObject([{ id: summaryId, detail_availability: "summary" }]);
    }
    const first = pages[0][0] as any;
    summary(root, "progress", "dddddddddd", "changed retained progress history");
    expect(() => listProgressEntities(root, 1, {}, first.next_cursor, { sourceRoot: SOURCE_ROOT })).toThrow(/changed after this cursor snapshot/);
  });

  it("orders same-minute full progress by publication order before compacted summaries", () => {
    const root = project();
    summary(root, "progress", "aaaaaaaaaa", "retained compacted history");
    appendProgressEntity(request(root, "progress", "append", { timestamp: "2026-07-17 12:00", type: "fix", phase: "build", what: "first full", context: { intent: "first" } }), { id: "zzzzzzzzzz", sourceRoot: SOURCE_ROOT });
    appendProgressEntity(request(root, "progress", "append", { timestamp: "2026-07-17 12:00", type: "fix", phase: "build", what: "last full", context: { intent: "last" } }), { id: "yyyyyyyyyy", sourceRoot: SOURCE_ROOT });
    const listed = listProgressEntities(root, 20, {}, undefined, { sourceRoot: SOURCE_ROOT }) as any;
    expect(listed.entries.map((entry: any) => [entry.id, entry.record.publication_order ?? null])).toEqual([
      ["yyyyyyyyyy", 2],
      ["zzzzzzzzzz", 1],
      ["aaaaaaaaaa", null],
    ]);
    expect(listed.entries[2]).toMatchObject({ boundary: "progress_summary", detail_availability: "summary" });
  });

  it("hashes the exact composed decision list projection and contract", () => {
    const root = project(); mixed(root);
    const listed = listDecisionEntities(root, 20, undefined, undefined, { sourceRoot: SOURCE_ROOT }) as any;
    const projection = {
      schemaVersion: listed.schemaVersion,
      command: listed.command,
      order: listed.snapshot.order,
      filters: listed.filters,
      source: listed.source,
      source_contract: listed.source_contract,
      entries: listed.entries,
    };
    expect(listed.entries.find((entry: any) => entry.id === "bbbbbbbbbb")).toMatchObject({ effective_sha256: expect.any(String), provenance: { revisions: [], satisfaction: null }, retrieval: { get: expect.any(String) } });
    expect(listed.snapshot.id).toBe(projectedListSnapshot(projection));
    const changed = structuredClone(projection);
    changed.entries[0].package_only_composed_field = true;
    expect(projectedListSnapshot(changed)).not.toBe(listed.snapshot.id);
  });

  it("rejects noncanonical payload and signature spellings for every list cursor while unchanged cursors continue", () => {
    const root = project(); mixed(root);
    const pages = [
      [() => listProgressEntities(root, 1, {}, undefined, { sourceRoot: SOURCE_ROOT }), (cursor: string) => listProgressEntities(root, 1, {}, cursor, { sourceRoot: SOURCE_ROOT })],
      [() => listDecisionEntities(root, 1, undefined, undefined, { sourceRoot: SOURCE_ROOT }), (cursor: string) => listDecisionEntities(root, 1, undefined, cursor, { sourceRoot: SOURCE_ROOT })],
      [() => listHealthEntities(root, 1, undefined, undefined, { sourceRoot: SOURCE_ROOT }), (cursor: string) => listHealthEntities(root, 1, undefined, cursor, { sourceRoot: SOURCE_ROOT })],
    ] as const;
    for (const [firstPage, continuePage] of pages) {
      const first = firstPage() as any;
      const repeated = firstPage() as any;
      expect(repeated.next_cursor).toBe(first.next_cursor);
      expect(() => continuePage(`${first.next_cursor.split(".")[0]}=.${first.next_cursor.split(".")[1]}`)).toThrow(/cursor/);
      expect(() => continuePage(signatureAlias(first.next_cursor))).toThrow(/cursor/);
      expect((continuePage(first.next_cursor) as any).entries).toHaveLength(1);
    }
  });

  it("refuses summary decision mutations before effects while full decisions remain amendable", () => {
    const root = project(); mixed(root);
    const before = fs.readdirSync(path.join(root, ".agentera/entities/decisions")).sort();
    for (const dryRun of [false, true]) {
      expect(() => amendDecisionEntity(request(root, "decisions", "amend", { id: "eeeeeeeeee", base_sha256: "a".repeat(64), choice: "cannot amend" }, dryRun), { sourceRoot: SOURCE_ROOT })).toThrow(/incomplete historical evidence is read-only/);
      expect(() => updateDecisionSatisfactionEntity(request(root, "decisions", "update", { id: "eeeeeeeeee", satisfaction: { state: "open" } }, dryRun), { sourceRoot: SOURCE_ROOT })).toThrow(/incomplete historical evidence is read-only/);
    }
    expect(fs.readdirSync(path.join(root, ".agentera/entities/decisions")).sort()).toEqual(before);
    const current = getDecisionEntity(root, "bbbbbbbbbb", SOURCE_ROOT) as any;
    const dry = amendDecisionEntity(request(root, "decisions", "amend", { id: "bbbbbbbbbb", base_sha256: current.entry.effective_sha256, choice: "still full" }, true), { sourceRoot: SOURCE_ROOT }) as any;
    expect(dry.operation.dry_run).toBe(true);
    expect(fs.existsSync(path.join(root, ".agentera/entities/decisions/decision_revision"))).toBe(false);
  });

  it("starts prime on summary-only and mixed history without fabricating current detail", () => {
    const summaryOnly = project();
    summary(summaryOnly, "progress", "dddddddddd", "retained progress history");
    summary(summaryOnly, "decisions", "eeeeeeeeee", "retained decision history", { state: "user_confirmed_satisfied" });
    summary(summaryOnly, "health", "ffffffffff", "retained health history");
    const previous = process.cwd(); process.chdir(summaryOnly);
    try {
      let out = ""; let err = "";
      expect(cmdPrime({ format: "json", dashboard: true }, { out: (value) => { out += value; }, err: (value) => { err += value; } })).toBe(0);
      const payload = JSON.parse(out);
      expect(err).toContain("Deprecation");
      expect(payload.progress).toMatchObject({ exists: true, status: "degraded_history", degraded_history: { summary_count: 1 } });
      expect(payload.progress.latest).toBeUndefined();
      expect(payload.health).toMatchObject({ exists: true, degraded_history: { summary_count: 1 } });
      expect(payload.health.date).toBeUndefined();
      expect(payload.decision).toBeUndefined();
    } finally { process.chdir(previous); }

    const mixedRoot = project(); mixed(mixedRoot); process.chdir(mixedRoot);
    try {
      let out = "";
      expect(cmdPrime({ format: "json", dashboard: true }, { out: (value) => { out += value; }, err: () => undefined })).toBe(0);
      const payload = JSON.parse(out);
      expect(payload.progress.latest).toMatchObject({ id: "aaaaaaaaaa", what: "full progress" });
      expect(payload.health).toMatchObject({ id: "cccccccccc", date: "2026-07-17" });
      expect(payload.decision).toBeUndefined();
    } finally { process.chdir(previous); }
  });

  it("keeps canonical full and compacted history evidence in bare prime", () => {
    const fullRoot = project(); full(fullRoot);
    const fullPrime = cli(fullRoot, ["prime", "--format", "json"]);
    expect(fullPrime.rc, fullPrime.err || fullPrime.out).toBe(0);
    const fullPayload = JSON.parse(fullPrime.out);
    for (const artifact of ["progress", "decisions", "health"]) {
      expect(fullPayload.history[artifact]).toMatchObject({
        status: "ok",
        compatibility: "current",
        counts: { total: 1, returned: 0, remaining: 1, full: 1, summary: 0 },
        retrieval: {
          list: `agentera state ${artifact} list --limit 20 --format json`,
          get: `agentera state ${artifact} get --id ID --format json`,
        },
        source_contract: {
          authority: "references/artifacts/state-storage-authority.yaml",
          detail: "full",
        },
      });
      expect(fullPayload.history[artifact]).not.toHaveProperty("caveats");
      expect(fullPayload.history[artifact]).not.toHaveProperty("degraded_history");
    }
    expect((getDecisionEntity(fullRoot, "bbbbbbbbbb", SOURCE_ROOT) as any).entry.record).toMatchObject({
      confidence: "firm",
    });

    const compactedRoot = project();
    summary(compactedRoot, "progress", "dddddddddd", "retained progress history");
    summary(compactedRoot, "decisions", "eeeeeeeeee", "retained decision history", {
      state: "open",
      review_needed: true,
      evidence: "requires exact review",
    });
    summary(compactedRoot, "health", "ffffffffff", "retained health history");
    const compactedPrime = cli(compactedRoot, ["prime", "--format", "json"]);
    expect(compactedPrime.rc, compactedPrime.err || compactedPrime.out).toBe(0);
    const compactedPayload = JSON.parse(compactedPrime.out);
    expect(compactedPayload.decision_attention).toBeNull();
    for (const artifact of ["progress", "decisions", "health"]) {
      const history = compactedPayload.history[artifact];
      expect(history).toMatchObject({
        status: "degraded",
        compatibility: "degraded",
        detail_availability: "omitted",
        counts: { total: 1, returned: 0, remaining: 1, full: 0, summary: 1 },
        caveats: [expect.stringContaining("incomplete historical evidence")],
        degraded_history: {
          summary_count: 1,
          returned_count: 0,
          omitted_count: 1,
          retrieval: {
            list: `agentera state ${artifact} list --limit 20 --format json`,
            get: `agentera state ${artifact} get --id ID --format json`,
          },
        },
        retrieval: {
          list: `agentera state ${artifact} list --limit 20 --format json`,
          get: `agentera state ${artifact} get --id ID --format json`,
        },
        source_contract: {
          authority: "references/artifacts/state-storage-authority.yaml",
          detail: "mixed",
        },
      });
      expect(history).not.toHaveProperty("entries");
      const recovery = cli(compactedRoot, String(history.retrieval.list).split(" ").slice(1));
      expect(recovery.rc, recovery.err || recovery.out).toBe(0);
    }
    expect((getDecisionEntity(compactedRoot, "eeeeeeeeee", SOURCE_ROOT) as any).entry.record.satisfaction).toEqual({
      state: "open",
      review_needed: true,
      evidence: "requires exact review",
    });
  });

  it("renders bounded summary-only history truthfully in human and bare JSON prime output", () => {
    const root = project();
    summary(root, "progress", "mmmmmmmmmm", "retained progress history");
    for (let index = 0; index < 12; index++) {
      const id = String.fromCharCode("a".charCodeAt(0) + index).repeat(10);
      summary(root, "health", id, `retained health history ${index}`);
    }
    const human = cli(root, ["prime"]);
    expect(human.rc, human.err).toBe(0);
    expect(human.out).toContain("health: degraded_history | summaries=12 | returned=0 | omitted=12 | detail=summary-only");
    expect(human.out).toContain("progress: degraded_history | summaries=1 | returned=0 | omitted=1 | detail=summary-only");
    expect(human.out).not.toContain("health: id=unknown");
    const json = cli(root, ["prime", "--format", "json"]);
    expect(json.rc, json.err).toBe(0);
    const payload = JSON.parse(json.out);
    expect(payload.progress).toMatchObject({ status: "degraded_history", degraded_history: { summary_count: 1, returned_count: 0, omitted_count: 1 } });
    expect(payload.health).toMatchObject({ exists: true, degraded_history: { summary_count: 12, returned_count: 0, omitted_count: 12 } });
    expect(payload.health).not.toHaveProperty("id");
  });

  it("keeps full current human lines and adds bounded mixed-history signals beyond the page limit", () => {
    const root = project(); full(root);
    for (let index = 0; index < 12; index++) {
      const suffix = String.fromCharCode("a".charCodeAt(0) + index).repeat(9);
      summary(root, "progress", `p${suffix}`, `retained progress ${index}`);
      summary(root, "decisions", `d${suffix}`, `retained decision ${index}`);
      summary(root, "health", `h${suffix}`, `retained health ${index}`);
    }
    const human = cli(root, ["prime"]);
    expect(human.rc, human.err).toBe(0);
    expect(human.out).toContain("progress: id=aaaaaaaaaa | artifact=progress | what=full progress");
    expect(human.out).toContain("health: id=cccccccccc | artifact=health");
    for (const artifact of ["progress", "decisions", "health"]) {
      expect(human.out).toContain(`${artifact}: degraded_history | summaries=12 | returned=0 | omitted=12 | detail=summary-only`);
    }
    expect(Buffer.byteLength(human.out, "utf8")).toBeLessThan(25_000);

    const authority = YAML.parse(fs.readFileSync(path.join(SOURCE_ROOT, "references/artifacts/state-storage-authority.yaml"), "utf8"));
    const dashboard = cli(root, ["prime", "--dashboard", "--format", "json"]);
    expect(dashboard.rc, dashboard.err).toBe(0);
    expect(Buffer.byteLength(dashboard.out, "utf8")).toBeLessThanOrEqual(authority.budgets.startup.surfaces.prime_dashboard.max_utf8_bytes);
    const projected = JSON.parse(dashboard.out);
    expect(projected.progress.latest).toMatchObject({ id: "aaaaaaaaaa", what: "full progress" });
    expect(projected.health).toMatchObject({ id: "cccccccccc", date: "2026-07-17" });
    expect(projected.decision).toBeUndefined();
    for (const artifact of ["progress", "decisions", "health"]) {
      expect(projected.history[artifact]).toMatchObject({
        status: "degraded",
        compatibility: "mixed",
        detail_availability: "omitted",
        counts: { total: 13, returned: 0, remaining: 13, full: 1, summary: 12 },
        omitted: true,
        omitted_count: 13,
        omission_reason: "startup_history_detail",
        degraded_history: { summary_count: 12, returned_count: 0, omitted_count: 12 },
        retrieval: {
          list: `agentera state ${artifact} list --limit 20 --format json`,
          get: `agentera state ${artifact} get --id ID --format json`,
        },
        caveats: [expect.stringContaining("incomplete historical evidence")],
      });
      expect(projected.history[artifact]).not.toHaveProperty("entries");
    }
    const bare = cli(root, ["prime", "--format", "json"]);
    expect(bare.rc, bare.err).toBe(0);
    expect(Buffer.byteLength(bare.out, "utf8")).toBeLessThanOrEqual(authority.budgets.startup.surfaces.prime_briefing.max_utf8_bytes);
    const status = cli(root, ["prime", "--context", "status", "--format", "json"]);
    expect(status.rc, status.err).toBe(0);
    expect(Buffer.byteLength(status.out, "utf8")).toBeLessThanOrEqual(authority.budgets.startup.surfaces.prime_status_context.max_utf8_bytes);
  });

  it("bounds a summary-only dashboard beyond every page limit without fabricating current records", () => {
    const root = project();
    for (let index = 0; index < 12; index++) {
      const suffix = String.fromCharCode("a".charCodeAt(0) + index).repeat(9);
      summary(root, "progress", `p${suffix}`, `retained progress ${index}`);
      summary(root, "decisions", `d${suffix}`, `retained decision ${index}`);
      summary(root, "health", `h${suffix}`, `retained health ${index}`);
    }
    const dashboard = cli(root, ["prime", "--dashboard", "--format", "json"]);
    expect(dashboard.rc, dashboard.err).toBe(0);
    const authority = YAML.parse(fs.readFileSync(path.join(SOURCE_ROOT, "references/artifacts/state-storage-authority.yaml"), "utf8"));
    expect(Buffer.byteLength(dashboard.out, "utf8")).toBeLessThanOrEqual(authority.budgets.startup.surfaces.prime_dashboard.max_utf8_bytes);
    const payload = JSON.parse(dashboard.out);
    expect(payload.progress).not.toHaveProperty("latest");
    expect(payload.health).not.toHaveProperty("id");
    expect(payload.decision).toBeUndefined();
    for (const artifact of ["progress", "decisions", "health"]) {
      expect(payload.history[artifact]).toMatchObject({
        compatibility: "degraded",
        counts: { total: 12, returned: 0, remaining: 12, full: 0, summary: 12 },
        omitted_count: 12,
        degraded_history: { summary_count: 12, returned_count: 0, omitted_count: 12 },
      });
      expect(payload.history[artifact]).not.toHaveProperty("entries");
    }
  });

  it("emits structured, actionable summary-decision mutation failures before effects", () => {
    const root = project(); mixed(root);
    const before = fs.readdirSync(path.join(root, ".agentera/entities/decisions")).sort();
    for (const args of [
      ["state", "decisions", "amend", "--id", "eeeeeeeeee", "--base-sha256", "a".repeat(64), "--input", "-"],
      ["state", "decisions", "update", "--id", "eeeeeeeeee", "--satisfaction-state", "open"],
    ]) {
      for (const dryRun of [false, true]) {
        const rejected = cli(root, [...args, ...(dryRun ? ["--dry-run"] : []), "--format", "json"]);
        expect(rejected.rc).toBe(1);
        const body = JSON.parse(rejected.out);
        expect(body).toMatchObject({ schemaVersion: "agentera.stateFailure.v1", status: "fail", error: { class: "unsupported_state", message: expect.stringContaining("incomplete historical evidence is read-only"), syntax: expect.stringContaining(`decisions ${args[2]}`), example: "agentera state decisions get --id eeeeeeeeee --format json", recovery: expect.stringContaining("agentera state decisions append") } });
      }
    }
    const text = cli(root, ["state", "decisions", "update", "--id", "eeeeeeeeee", "--satisfaction-state", "open"]);
    expect(text.rc).toBe(1);
    expect(text.err).toContain("Recovery: Run agentera state decisions get --id eeeeeeeeee --format json");
    expect(fs.readdirSync(path.join(root, ".agentera/entities/decisions")).sort()).toEqual(before);
  });

  it("invalidates an existing cursor when package-projected summary caveats change", async () => {
    const root = project(); mixed(root);
    const first = listProgressEntities(root, 1, {}, undefined, { sourceRoot: SOURCE_ROOT }) as any;
    vi.resetModules();
    vi.doMock("../../src/state/summaryEntityRead.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../src/state/summaryEntityRead.js")>();
      return { ...actual, detailMetadata: (entity: any) => ({ ...actual.detailMetadata(entity), ...(entity.boundary === "progress_summary" ? { caveats: ["package-projected caveat changed"] } : {}) }) };
    });
    try {
      const reader = await import("../../src/state/progressEntities.js");
      expect(() => reader.listProgressEntities(root, 1, {}, first.next_cursor, { sourceRoot: SOURCE_ROOT })).toThrow(/changed after this cursor snapshot/);
    } finally {
      vi.doUnmock("../../src/state/summaryEntityRead.js");
      vi.resetModules();
    }
  });
});
