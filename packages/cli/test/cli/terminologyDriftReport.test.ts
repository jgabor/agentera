import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { assessTerminologyDrift } from "../../src/audit/terminologyDrift.js";
import { main } from "../../src/cli/dispatch.js";

const roots: string[] = [];

function project(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentera-terminology-drift-")));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".agentera"));
  fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/order.ts"), "// A work item is queued.\nexport type WorkItem = Ticket;\n");
  fs.writeFileSync(path.join(root, "README.md"), "Every work item has an owner.\nOpen a ticket to report a bug.\n");
  return root;
}

function run(args: string[], stdin?: unknown) {
  let out = "";
  let err = "";
  const rc = main(["node", "agentera", ...args], {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    ...(stdin === undefined ? {} : { stdin: () => JSON.stringify(stdin) }),
  });
  return { rc, out, err, json: out.trim() ? JSON.parse(out) : null };
}

const WORK_ITEM = {
  term: "work item",
  evidence: [
    { source_path: "README.md", line: 1 },
    { source_path: "src/order.ts", line: 1 },
  ],
};
const TICKET = { term: "ticket", evidence: [{ source_path: "README.md", line: 2 }] };

function driftRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "agentera.terminologyDriftRequest.v1",
    concept: "unit of tracked work",
    confidence: 82,
    severity: "warning",
    terms: [WORK_ITEM, TICKET],
    ...overrides,
  };
}

function report(root: string, request: unknown) {
  return run(["report", "terminology-drift", "--input", "-", "--project", root, "--format", "json"], request);
}

function treeDigest(root: string): string {
  const records: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else records.push(`${path.relative(root, target)}:${crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex")}`);
    }
  };
  visit(root);
  return records.join("\n");
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("report terminology-drift", () => {
  it("publishes one project glossary entry using only CLI output for the proposal and digest", () => {
    const root = project();
    const audit = report(root, driftRequest());
    expect(audit.rc, audit.err).toBe(0);
    expect(audit.json).toMatchObject({ command: "report terminology-drift", status: "finding", reason: null, effects: { writes: false } });
    const finding = audit.json.finding;
    expect(finding).toMatchObject({ family: "terminology_drift", proposed_canonical_term: "work item", variants: [{ term: "ticket" }] });
    expect(finding.proposal_digest).toMatch(/^[a-f0-9]{64}$/);

    // The user confirms the exact digest Audit displayed; Build wraps the finding verbatim.
    const publication = {
      schema_version: "agentera.glossaryPublicationRequest.v1",
      proposal: finding,
      confirmation: { proposal_digest: finding.proposal_digest, confirmed_by: "user", confirmed_at: "2026-10-18T15:00:00+02:00" },
    };
    const publish = ["state", "glossary", "publish", "--input", "-", "--project", root, "--format", "json"];
    const preview = run([...publish, "--dry-run"], publication);
    expect(preview.rc, preview.err || preview.out).toBe(0);
    expect(preview.json.operation).toEqual({ dry_run: true, changed: true, idempotent_replay: false });
    expect(fs.existsSync(path.join(root, ".agentera/glossary.yaml"))).toBe(false);

    const published = run(publish, publication);
    expect(published.rc, published.err || published.out).toBe(0);
    expect(published.json.operation).toEqual({ dry_run: false, changed: true, idempotent_replay: false });
    const document = YAML.parse(fs.readFileSync(path.join(root, ".agentera/glossary.yaml"), "utf8"));
    expect(document.approvals).toHaveLength(1);
    expect(document.approvals[0].proposal_digest).toBe(finding.proposal_digest);
    expect(document.entries).toEqual([expect.objectContaining({ term: "work item", meaning: "unit of tracked work", confidence: 82, provenance: expect.objectContaining({ kind: "project_file" }) })]);

    const validated = run(["check", "validate", "state", "--cwd", root, "--format", "json"]);
    expect(validated.rc, validated.err || validated.out).toBe(0);
  });

  it("matches Audit's library output and never writes", () => {
    const root = project();
    const before = treeDigest(root);
    const result = report(root, driftRequest({ personal_term: "task" }));
    expect(result.rc, result.err).toBe(0);
    const [expected] = assessTerminologyDrift({
      projectRoot: root,
      concepts: [driftRequest() as never],
      personalTerms: new Map([["unit of tracked work", "task"]]),
      deliberateDecisionConcepts: new Set(),
      trackedIssueConcepts: new Set(),
    });
    expect(result.json.finding).toEqual(expected);
    expect(result.json.finding.personal_divergence).toEqual({ personal_term: "task", project_term: "work item" });
    expect(treeDigest(root)).toBe(before);
  });

  it.each([
    ["confidence_out_of_range", { confidence: 10 }],
    ["unverified_evidence", { terms: [WORK_ITEM, { term: "ticket", evidence: [{ source_path: "README.md", line: 1 }] }] }],
    ["unverified_evidence", { terms: [WORK_ITEM, { term: "ticket", evidence: [{ source_path: "../outside.md", line: 1 }] }] }],
    ["no_drift", { terms: [WORK_ITEM, { term: "work item", evidence: [{ source_path: "src/order.ts", line: 1 }] }] }],
  ] as Array<[string, Record<string, unknown>]>)("returns no finding with reason %s", (reason, overrides) => {
    const root = project();
    const result = report(root, driftRequest(overrides));
    expect(result.rc, result.err).toBe(0);
    expect(result.json).toMatchObject({ status: "no_finding", finding: null, reason, next: null });
  });

  it.each([
    ["undeclared field", driftRequest({ proposal_digest: "0".repeat(64) })],
    ["wrong schema version", driftRequest({ schema_version: "v0" })],
    ["one term", driftRequest({ terms: [WORK_ITEM] })],
    ["evidence without a line", driftRequest({ terms: [{ term: "work item", evidence: [{ source_path: "README.md" }] }, TICKET] })],
  ] as Array<[string, Record<string, unknown>]>)("rejects a malformed request: %s", (_label, request) => {
    const root = project();
    const result = report(root, request);
    expect(result.rc).not.toBe(0);
    expect(result.json.error.class).toBe("schema_violation");
    expect(result.json.error.recovery).toContain("no state was changed");
  });

  it("is served by report explain", () => {
    const result = run(["report", "explain", "--operation", "terminology-drift", "--section", "usage", "--format", "json"]);
    expect(result.rc, result.err).toBe(0);
    expect(result.out).toContain("agentera.terminologyDriftRequest.v1");
  });
});
