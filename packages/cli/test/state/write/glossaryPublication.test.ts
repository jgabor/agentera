import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import {
  assessTerminologyDrift,
  terminologyProposalDigest,
  type TerminologyDriftFinding,
} from "../../../src/audit/terminologyDrift.js";
import { main } from "../../../src/cli/dispatch.js";

const roots: string[] = [];

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-glossary-publish-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".agentera"));
  fs.writeFileSync(
    path.join(root, ".agentera/state-mode.yaml"),
    "schemaVersion: agentera.stateMode.v1\nmode: entities\n",
  );
  return root;
}

function auditedProposal(root: string): TerminologyDriftFinding {
  const term = "JsonValue";
  const concept = "structured value";
  const file = `${concept.replaceAll(" ", "-")}.ts`;
  fs.writeFileSync(path.join(root, file), `export type ${term} = Legacy${term};\n`);
  return assessTerminologyDrift({
    projectRoot: root,
    concepts: [{
      concept,
      confidence: 84,
      severity: "warning",
      terms: [
        { term, evidence: [{ source_path: file, line: 1 }] },
        { term: `Legacy${term}`, evidence: [{ source_path: file, line: 1 }] },
      ],
    }],
    deliberateDecisionConcepts: new Set(),
    trackedIssueConcepts: new Set(),
  })[0]!;
}

function proposal(
  root: string,
  canonical = "JsonValue",
  concept = "structured value",
  variant = `Legacy${canonical}`,
): TerminologyDriftFinding {
  const sourcePath = `${concept.replaceAll(" ", "-")}.ts`;
  const lines = [`export type ${canonical} = ${variant};`, `export type CanonicalAlias = ${canonical};`];
  fs.writeFileSync(path.join(root, sourcePath), `${lines.join("\n")}\n`);
  const evidence = (line: number) => ({
    source_path: sourcePath,
    line,
    source_record_sha256: crypto.createHash("sha256").update(lines[line - 1]!).digest("hex"),
  });
  const value: Omit<TerminologyDriftFinding, "proposal_digest"> = {
    family: "terminology_drift",
    concept,
    proposed_canonical_term: canonical,
    canonical_evidence: [evidence(1), evidence(2)],
    variants: [{ term: variant, evidence: [evidence(1)] }],
    severity: "warning",
    confidence: 84,
  };
  return { ...value, proposal_digest: terminologyProposalDigest(value) };
}

function request(proposal: TerminologyDriftFinding, confirmedBy = "user"): Record<string, unknown> {
  return {
    schema_version: "agentera.glossaryPublicationRequest.v1",
    proposal,
    confirmation: {
      proposal_digest: proposal.proposal_digest,
      confirmed_by: confirmedBy,
      confirmed_at: "2026-07-26T14:00:00Z",
    },
  };
}

function run(root: string, document: Record<string, unknown>, extra: string[] = []) {
  let out = "";
  let err = "";
  const rc = main(
    ["node", "agentera", "state", "glossary", "publish", "--input", "-", ...extra, "--format", "json", "--project", root],
    { out: (text) => { out += text; }, err: (text) => { err += text; }, stdin: () => JSON.stringify(document) },
  );
  return { rc, err, json: out.trim() ? JSON.parse(out) : null };
}

function glossary(root: string): any {
  return YAML.parse(fs.readFileSync(path.join(root, ".agentera/glossary.yaml"), "utf8"));
}

function reverseMappingKeys(value: any): any {
  if (Array.isArray(value)) return value.map(reverseMappingKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).reverse().map(([key, item]) => [key, reverseMappingKeys(item)]),
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("typed project glossary publication", () => {
  it("discovers build-owned publication with a versioned working input example", () => {
    const root = project();
    let out = "";
    const rc = main(
      ["node", "agentera", "state", "glossary", "explain", "--verb", "publish", "--format", "json", "--project", root],
      { out: (text) => { out += text; }, err: () => {} },
    );
    const explained = JSON.parse(out);
    expect(rc).toBe(0);
    expect(explained).toMatchObject({
      artifact: "glossary",
      requested_verb: "publish",
      path: ".agentera/glossary.yaml",
      input_schema: { root: "one glossary publication request" },
      request_schema_version: "agentera.glossaryPublicationRequest.v1",
      document_schema_version: "agentera.projectGlossary.v1",
    });
    expect(explained.example).toContain("state glossary publish --input");
    expect(explained.guidance.join(" ")).toMatch(/confirmation.*user.*proposal digest/i);
  });

  it("publishes genuine audit output as a separate immutable approval and shared-only entry", () => {
    const root = project();
    const audited = auditedProposal(root);
    const result = run(root, request(audited));

    expect(result.rc, result.err).toBe(0);
    expect(result.json).toMatchObject({ artifact: "glossary", operation: { dry_run: false, idempotent_replay: false } });
    const document = glossary(root);
    expect(document).toMatchObject({ schema_version: "agentera.projectGlossary.v1" });
    expect(document.approvals).toEqual([{
      proposal_digest: audited.proposal_digest,
      proposal: audited,
      confirmation: {
        proposal_digest: audited.proposal_digest,
        confirmed_by: "user",
        confirmed_at: "2026-07-26T14:00:00Z",
      },
    }]);
    expect(Object.keys(document.entries[0])).toEqual([
      "term", "meaning", "confidence", "permanence", "temporal", "provenance",
    ]);
    expect(document.entries[0]).toMatchObject({
      term: "JsonValue",
      meaning: "structured value",
      confidence: 84,
      permanence: "stable",
      temporal: { observed_at: "2026-07-26", last_confirmed_at: "2026-07-26" },
      provenance: { kind: "project_file", evidence: [{ source_path: "structured-value.ts" }] },
    });
  });

  it("discovers the canonical registry identity after first publish without changing docs mapping", () => {
    const root = project();
    const docsPath = path.join(root, ".agentera/docs.yaml");
    const docsBytes = "mapping:\n  - artifact: DESIGN.md\n    path: docs/design.md\ncoverage:\n  status: partial\n";
    fs.writeFileSync(docsPath, docsBytes);
    expect(run(root, request(proposal(root))).rc).toBe(0);

    const previousCwd = process.cwd();
    let out = "";
    try {
      process.chdir(root);
      const rc = main(
        ["node", "agentera", "state", "query", "--list-artifacts", "--format", "json"],
        { out: (text) => { out += text; }, err: () => {} },
      );
      expect(rc).toBe(0);
    } finally {
      process.chdir(previousCwd);
    }
    const discovered = JSON.parse(out).artifacts.find((item: any) => item.artifact === "glossary");
    expect(discovered).toMatchObject({
      artifact: "glossary",
      implementation_status: "active",
      producer: ["build"],
      path: {
        default_path: ".agentera/glossary.yaml",
        mapped_path: ".agentera/glossary.yaml",
        display_path: ".agentera/glossary.yaml",
        resolution_source: "registry default",
        exists: true,
      },
    });
    expect(fs.readFileSync(docsPath, "utf8")).toBe(docsBytes);
  });

  it.each([
    ["missing confirmation", (value: any) => { delete value.confirmation; }],
    ["non-user confirmation", (value: any) => { value.confirmation.confirmed_by = "agent"; }],
    ["invalid confirmation timestamp", (value: any) => { value.confirmation.confirmed_at = "today"; }],
    ["digest mismatch", (value: any) => { value.confirmation.proposal_digest = "0".repeat(64); }],
    ["malformed request", (value: any) => { value.extra = true; }],
    ["malformed provenance", (value: any) => {
      value.proposal.canonical_evidence[0].source_record_sha256 = "INVALID";
      value.proposal.proposal_digest = terminologyProposalDigest(value.proposal);
      value.confirmation.proposal_digest = value.proposal.proposal_digest;
    }],
    ["noncanonical source identity", (value: any) => {
      value.proposal.canonical_evidence[0].source_path = `./${value.proposal.canonical_evidence[0].source_path}`;
      value.proposal.proposal_digest = terminologyProposalDigest(value.proposal);
      value.confirmation.proposal_digest = value.proposal.proposal_digest;
    }],
  ])("rejects %s before effects with recovery", (_label, mutate) => {
    const root = project();
    const value: any = request(proposal(root));
    mutate(value);
    const result = run(root, value);
    expect(result.rc).not.toBe(0);
    expect(result.json?.error.recovery).toBeTruthy();
    expect(fs.existsSync(path.join(root, ".agentera/glossary.yaml"))).toBe(false);
  });

  it.each([
    ["weaker canonical term", (value: any) => {
      const canonical = value.proposal.proposed_canonical_term;
      const canonicalEvidence = value.proposal.canonical_evidence;
      const weaker = value.proposal.variants[0].term;
      const weakerEvidence = value.proposal.variants[0].evidence;
      value.proposal.proposed_canonical_term = weaker;
      value.proposal.canonical_evidence = weakerEvidence;
      value.proposal.variants[0] = { term: canonical, evidence: [
        ...canonicalEvidence,
        { ...weakerEvidence[0], source_path: "extra.ts" },
      ] };
    }],
    ["impossible severity", (value: any) => {
      value.proposal.confidence = 60;
      value.proposal.severity = "warning";
    }],
  ])("rejects an Audit-inemittable %s even when self-digested", (_label, mutate) => {
    const root = project();
    const value: any = request(proposal(root));
    if (_label === "weaker canonical term") {
      fs.writeFileSync(path.join(root, "extra.ts"), "export type JsonValue = string;\n");
      const line = fs.readFileSync(path.join(root, "extra.ts"), "utf8").trimEnd();
      const digest = crypto.createHash("sha256").update(line).digest("hex");
      mutate(value);
      value.proposal.variants[0].evidence[1].source_record_sha256 = digest;
    } else mutate(value);
    value.proposal.proposal_digest = terminologyProposalDigest(value.proposal);
    value.confirmation.proposal_digest = value.proposal.proposal_digest;

    const result = run(root, value);
    expect(result.rc).not.toBe(0);
    expect(result.json?.error.message).toMatch(/canonical|severity|Audit/i);
    expect(fs.existsSync(path.join(root, ".agentera/glossary.yaml"))).toBe(false);
  });

  it.each(["stale", "missing", "outside"])("rejects %s source-line evidence before effects", (condition) => {
    const root = project();
    const value: any = proposal(root);
    const source = path.join(root, value.canonical_evidence[0].source_path);
    if (condition === "stale") fs.writeFileSync(source, "export type JsonValue = Changed;\n");
    if (condition === "missing") fs.unlinkSync(source);
    if (condition === "outside") {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-glossary-outside-"));
      roots.push(outside);
      fs.writeFileSync(path.join(outside, "terms.ts"), "export type JsonValue = LegacyJsonValue;\n");
      fs.unlinkSync(source);
      fs.symlinkSync(path.join(outside, "terms.ts"), source);
    }
    const result = run(root, request(value));
    expect(result.rc).not.toBe(0);
    expect(result.json?.error.recovery).toMatch(/rerun audit|restore/i);
    expect(fs.existsSync(path.join(root, ".agentera/glossary.yaml"))).toBe(false);
  });

  it("rejects malformed existing state and case-insensitive term conflicts without changing bytes", () => {
    const root = project();
    expect(run(root, request(proposal(root))).rc).toBe(0);
    const target = path.join(root, ".agentera/glossary.yaml");
    const before = fs.readFileSync(target, "utf8");
    const conflicting = proposal(root, "JSONVALUE", "different concept");
    const conflict = run(root, request(conflicting));
    expect(conflict.rc).not.toBe(0);
    expect(conflict.json?.error.class).toBe("conflict");
    expect(fs.readFileSync(target, "utf8")).toBe(before);

    fs.writeFileSync(target, "schema_version: wrong\napprovals: []\nentries: []\n");
    const malformed = fs.readFileSync(target, "utf8");
    expect(run(root, request(conflicting)).rc).not.toBe(0);
    expect(fs.readFileSync(target, "utf8")).toBe(malformed);
  });

  it.each([
    ["duplicate variant", "RequestEnvelope", "LegacyJsonValue", "LegacyJsonValue"],
    ["existing canonical as variant", "RequestEnvelope", "JsonValue", "JsonValue"],
    ["existing variant as canonical", "LegacyJsonValue", "OldEnvelope", "LegacyJsonValue"],
    ["case-normalized variant", "RequestEnvelope", "legacyjsonvalue", "legacyjsonvalue"],
  ])("rejects cross-set %s before effects with both canonical sets in recovery", (_label, canonical, variant, collision) => {
    const root = project();
    const first = request(proposal(root, "JsonValue", "structured value", "LegacyJsonValue"));
    expect(run(root, first).rc).toBe(0);
    const target = path.join(root, ".agentera/glossary.yaml");
    const before = fs.readFileSync(target, "utf8");
    const second = request(proposal(root, canonical, `second ${_label}`, variant));

    const result = run(root, second);
    expect(result.rc).not.toBe(0);
    expect(result.json?.error.class).toBe("conflict");
    expect(result.json?.error.message).toContain(collision);
    expect(result.json?.error.message).toContain("JsonValue");
    expect(result.json?.error.message).toContain(canonical);
    expect(result.json?.error.recovery).toMatch(/choose distinct canonical and variant terms.*rerun audit/i);
    expect(fs.readFileSync(target, "utf8")).toBe(before);
    expect(glossary(root).approvals).toHaveLength(1);
  });

  it("rejects a Greek final-sigma canonical collision before effects", () => {
    const root = project();
    expect(run(root, request(proposal(root, "ΟΣ", "greek first", "παλιό"))).rc).toBe(0);
    const target = path.join(root, ".agentera/glossary.yaml");
    const before = fs.readFileSync(target, "utf8");

    const result = run(root, request(proposal(root, "οσ", "greek second", "νεότερο")));
    expect(result.rc).not.toBe(0);
    expect(result.json?.error.class).toBe("conflict");
    expect(fs.readFileSync(target, "utf8")).toBe(before);
  });

  it("rejects an equivalent canonical/variant identity at proposal validation", () => {
    const root = project();
    const valueProposal = proposal(root, "ΟΣ", "equivalent Greek identity", "παλιό");
    valueProposal.variants[0]!.term = "οσ";
    valueProposal.proposal_digest = terminologyProposalDigest(valueProposal);
    const value: any = request(valueProposal);
    value.confirmation.proposal_digest = valueProposal.proposal_digest;

    const result = run(root, value);
    expect(result.rc).not.toBe(0);
    expect(result.json?.error.message).toMatch(/canonical Audit output|identity/i);
    expect(fs.existsSync(path.join(root, ".agentera/glossary.yaml"))).toBe(false);
  });

  it.each([
    ["approval without entry", (document: any) => { document.entries = []; }],
    ["entry with approval data", (document: any) => { document.entries[0].proposal_digest = document.approvals[0].proposal_digest; }],
    ["changed matching entry", (document: any) => { document.entries[0].meaning = "changed"; }],
  ])("rejects malformed existing %s instead of repairing it", (_label, mutate) => {
    const root = project();
    const first = request(proposal(root));
    expect(run(root, first).rc).toBe(0);
    const target = path.join(root, ".agentera/glossary.yaml");
    const document = glossary(root);
    mutate(document);
    fs.writeFileSync(target, YAML.stringify(document));
    const before = fs.readFileSync(target, "utf8");

    const result = run(root, first);
    expect(result.rc).not.toBe(0);
    expect(result.json?.error.recovery).toBeTruthy();
    expect(fs.readFileSync(target, "utf8")).toBe(before);
  });

  it("no-ops exact replay and preserves unrelated approvals and entries", () => {
    const root = project();
    const first = request(proposal(root));
    const second = request(proposal(root, "RequestEnvelope", "request envelope"));
    expect(run(root, first).rc).toBe(0);
    const firstDocument = glossary(root);
    expect(run(root, second).rc).toBe(0);
    const combined = glossary(root);
    expect(combined.approvals[0]).toEqual(firstDocument.approvals[0]);
    expect(combined.entries[0]).toEqual(firstDocument.entries[0]);
    const bytes = fs.readFileSync(path.join(root, ".agentera/glossary.yaml"), "utf8");
    const replay = run(root, second);
    expect(replay.rc, replay.err).toBe(0);
    expect(replay.json?.operation).toMatchObject({ idempotent_replay: true, changed: false });
    expect(fs.readFileSync(path.join(root, ".agentera/glossary.yaml"), "utf8")).toBe(bytes);
  });

  it("no-ops replay when request and persisted mapping keys are reordered", () => {
    const root = project();
    const first = request(proposal(root));
    expect(run(root, first).rc).toBe(0);
    const target = path.join(root, ".agentera/glossary.yaml");
    const reorderedDocument = reverseMappingKeys(glossary(root));
    fs.writeFileSync(target, YAML.stringify(reorderedDocument));
    const before = fs.readFileSync(target, "utf8");

    const replay = run(root, reverseMappingKeys(first));
    expect(replay.rc, replay.err).toBe(0);
    expect(replay.json?.operation).toMatchObject({ changed: false, idempotent_replay: true });
    expect(fs.readFileSync(target, "utf8")).toBe(before);
  });

  it("validates and reports dry-run without writing", () => {
    const root = project();
    const result = run(root, request(proposal(root)), ["--dry-run"]);
    expect(result.rc, result.err).toBe(0);
    expect(result.json?.operation).toMatchObject({ dry_run: true, changed: true });
    expect(result.json?.candidate).toMatchObject({ schema_version: "agentera.projectGlossary.v1" });
    expect(fs.existsSync(path.join(root, ".agentera/glossary.yaml"))).toBe(false);
  });
});
