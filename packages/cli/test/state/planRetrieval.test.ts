import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch/index.js";

const roots: string[] = [];
const activeId = "plan:123e4567-e89b-42d3-a456-426614174000";
const archiveId = "plan:223e4567-e89b-42d3-a456-426614174000";

function plan(id: string | undefined, title: string, created: string, status = "complete") {
  return {
    header: { ...(id ? { id } : {}), title, created, status },
    what: `Deliver ${title}`,
    tasks: [{ number: 1, name: "Ship it", status: status === "complete" ? "complete" : "pending" }],
  };
}

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-plans-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".agentera", "archive"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agentera", "plan.yaml"), YAML.stringify(plan(activeId, "Active", "2026-07-15", "open")));
  fs.writeFileSync(path.join(root, ".agentera", "archive", "PLAN-archive.yaml"), YAML.stringify(plan(archiveId, "Archive", "2026-07-14")));
  return root;
}

function capture(root: string, args: string[]): { rc: number; out: string; err: string } {
  const previous = process.cwd();
  let out = "";
  let err = "";
  process.chdir(root);
  try {
    const rc = main(["node", "agentera", "state", "plan", ...args], {
      out: (text) => (out += text),
      err: (text) => (err += text),
    });
    return { rc, out, err };
  } finally {
    process.chdir(previous);
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("active and archived plan retrieval", () => {
  it("lists plans by deterministic recency with identity, lifecycle, provenance, and exact recovery", () => {
    const root = project();
    const result = capture(root, ["list", "--format", "json"]);
    expect(result.rc).toBe(0);
    const payload = JSON.parse(result.out);
    expect(payload.command).toBe("state plan list");
    expect(payload.order).toBe("created_desc_then_plan_id_asc");
    expect(payload.entries.map((entry: any) => entry.stable_id)).toEqual([activeId, archiveId]);
    expect(payload.entries[0]).toMatchObject({ active: true, archived: false, status: "open" });
    expect(payload.entries[1]).toMatchObject({ active: false, archived: true, status: "complete" });
    expect(payload.entries[1].retrieval.get).toBe(`agentera state plan get --plan ${archiveId} --format json`);
    expect(payload.omitted).toBe(false);
    expect(payload.omitted_count).toBe(0);
    expect(payload.retrieval).toEqual({ get: "agentera state plan get --plan PLAN_ID --format json" });
  });

  it("paginates a stable snapshot and excludes plans archived after the first page", () => {
    const root = project();
    const first = JSON.parse(capture(root, ["list", "--limit", "1", "--format", "json"]).out);
    expect(first.omitted).toBe(true);
    expect(first.omitted_count).toBe(1);
    expect(first.omission_reason).toBe("page_limit");
    expect(first.retrieval.continue).toContain(`--cursor ${first.next_cursor}`);

    const laterId = "plan:323e4567-e89b-42d3-a456-426614174000";
    fs.writeFileSync(path.join(root, ".agentera", "archive", "PLAN-later.yaml"), YAML.stringify(plan(laterId, "Later", "2026-07-16")));
    const second = capture(root, ["list", "--limit", "10", "--cursor", first.next_cursor, "--format", "json"]);
    expect(second.rc).toBe(0);
    expect(JSON.parse(second.out).entries.map((entry: any) => entry.stable_id)).toEqual([archiveId]);

    const activePath = path.join(root, ".agentera", "plan.yaml");
    const active = YAML.parse(fs.readFileSync(activePath, "utf8"));
    active.header.title = "Mutated";
    fs.writeFileSync(activePath, YAML.stringify(active));
    const unavailable = capture(root, ["list", "--cursor", first.next_cursor, "--format", "json"]);
    expect(unavailable.rc).toBe(1);
    expect(JSON.parse(unavailable.out).error.class).toBe("cursor_snapshot_unavailable");
  });

  it("keeps a large archive snapshot cursor inside the JSON list budget", () => {
    const root = project();
    for (let index = 0; index < 80; index += 1) {
      const suffix = index.toString(16).padStart(12, "0");
      const id = `plan:123e4567-e89b-42d3-a456-${suffix}`;
      const filename = `PLAN-${String(index).padStart(3, "0")}-${"long-archive-name-".repeat(4)}.yaml`;
      fs.writeFileSync(path.join(root, ".agentera", "archive", filename), YAML.stringify(plan(id, `Archive ${index}`, "2026-07-13")));
    }
    const result = capture(root, ["list", "--limit", "1", "--format", "json"]);
    expect(result.rc).toBe(0);
    expect(Buffer.byteLength(result.out, "utf8")).toBeLessThanOrEqual(32768);
    const payload = JSON.parse(result.out);
    expect(payload.next_cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(payload.omitted_count).toBe(81);
  });

  it("returns the full selected plan without caller-side archive traversal", () => {
    const root = project();
    const result = capture(root, ["get", "--plan", archiveId, "--format", "json"]);
    expect(result.rc).toBe(0);
    const payload = JSON.parse(result.out);
    expect(payload.command).toBe("state plan get");
    expect(payload.entry).toMatchObject({ stable_id: archiveId, active: false, archived: true });
    expect(payload.plan).toMatchObject({ header: { id: archiveId, title: "Archive" }, what: "Deliver Archive" });
    expect(payload.source.provenance.lifecycle_positions).toEqual(["archived"]);
    expect(payload.source_contract.complete_for_plan_retrieval).toBe(true);
  });

  it("derives deterministic legacy identity and collapses byte-equivalent mirrors", () => {
    const root = project();
    const legacy = YAML.stringify(plan(undefined, "Legacy", "2026-07-13"));
    const firstPath = path.join(root, ".agentera", "archive", "PLAN-legacy-a.yaml");
    const secondPath = path.join(root, ".agentera", "archive", "PLAN-legacy-b.yaml");
    fs.writeFileSync(firstPath, legacy);
    fs.writeFileSync(secondPath, legacy);

    const listed = JSON.parse(capture(root, ["list", "--format", "json"]).out);
    const legacyEntries = listed.entries.filter((entry: any) => entry.stable_id.startsWith("legacy-plan:"));
    expect(legacyEntries).toHaveLength(1);
    expect(legacyEntries[0].compatibility).toBe("degraded");
    expect(legacyEntries[0].provenance.mirrored_paths).toEqual([firstPath, secondPath].sort());
    const fetched = JSON.parse(capture(root, ["get", "--plan", legacyEntries[0].stable_id, "--format", "json"]).out);
    expect(fetched.plan.what).toBe("Deliver Legacy");
    expect(fetched.source.provenance.mirrored_paths).toEqual([firstPath, secondPath].sort());
  });

  it("keeps unrelated invalid archives as non-fatal compatibility diagnostics", () => {
    const root = project();
    const invalidPath = path.join(root, ".agentera", "archive", "PLAN-invalid.yaml");
    fs.writeFileSync(invalidPath, YAML.stringify(plan(undefined, "Invalid", "2026-07-12", "complete")).replace("status: complete", "status: broken"));

    const listed = capture(root, ["list", "--format", "json"]);
    expect(listed.rc).toBe(0);
    const payload = JSON.parse(listed.out);
    expect(payload.status).toBe("degraded");
    expect(payload.source.compatibility_diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: invalidPath, category: "lifecycle" }),
    ]));

    const valid = capture(root, ["get", "--plan", archiveId, "--format", "json"]);
    expect(valid.rc).toBe(0);
    expect(JSON.parse(valid.out).source.compatibility_diagnostics).toHaveLength(1);
  });

  it("fails explicitly for selected invalid, missing, malformed, and ambiguous identities", () => {
    const root = project();
    const invalidId = "plan:423e4567-e89b-42d3-a456-426614174000";
    const invalidPath = path.join(root, ".agentera", "archive", "PLAN-invalid-selected.yaml");
    fs.writeFileSync(invalidPath, YAML.stringify(plan(invalidId, "Invalid selected", "2026-07-12", "complete")).replace("status: complete", "status: broken"));
    const invalid = capture(root, ["get", "--plan", invalidId, "--format", "json"]);
    expect(invalid.rc).toBe(1);
    expect(JSON.parse(invalid.out).error).toMatchObject({ class: "corrupt", stable_id: invalidId });

    const missingId = "plan:523e4567-e89b-42d3-a456-426614174000";
    const missing = capture(root, ["get", "--plan", missingId, "--format", "json"]);
    expect(missing.rc).toBe(1);
    expect(JSON.parse(missing.out).error).toMatchObject({ class: "not_found", stable_id: missingId });

    const malformed = capture(root, ["get", "--plan", "not-a-plan", "--format", "json"]);
    expect(malformed.rc).toBe(2);
    expect(JSON.parse(malformed.out).error.class).toBe("invalid_request");

    fs.writeFileSync(path.join(root, ".agentera", "archive", "PLAN-collision.yaml"), YAML.stringify(plan(activeId, "Different", "2026-07-11")));
    const ambiguous = capture(root, ["get", "--plan", activeId, "--format", "json"]);
    expect(ambiguous.rc).toBe(1);
    expect(JSON.parse(ambiguous.out).error).toMatchObject({ class: "ambiguous", stable_id: activeId });
    expect(JSON.parse(ambiguous.out).error.details.candidate_paths).toHaveLength(2);
  });
});
