import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch.js";
import { buildSchemaPayload } from "../../src/cli/commands/schema.js";
import {
  classifyConfidenceLabel,
  decisionRevisionContract,
  legacyLabelCoexistence,
} from "../../src/state/decisionRevision.js";
import { decisionOverlayContract } from "../../src/state/archiveDiscovery.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const AUTHORITY_PATH = path.join(REPO_ROOT, "references/artifacts/state-storage-authority.yaml");

const roots: string[] = [];

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-decision-amend-"));
  fs.mkdirSync(path.join(root, ".agentera"));
  fs.writeFileSync(path.join(root, ".agentera", "state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

interface Captured {
  rc: number;
  out: string;
  err: string;
  json: Record<string, any> | null;
}

function run(root: string, args: string[], stdin = ""): Captured {
  if (!stdin && args.includes("--input") && args[args.indexOf("--input") + 1] === "-") {
    if (args[0] === "decisions" && args[1] === "append") stdin = JSON.stringify({ question: "Where should writes live?", context: "The read side already lives under state", alternatives: { chosen: "state family", rejected: ["top-level write"] }, choice: "Use the state family", reasoning: "One artifact namespace", confidence: "firm" });
    else if (args[0] === "decisions" && args[1] === "amend") stdin = JSON.stringify({ choice: "revised choice" });
  }
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

function runHelp(root: string, args: string[]): Captured {
  let out = "";
  let err = "";
  const rc = main(
    ["node", "agentera", "state", ...args, "--help", "--project", root],
    { out: (t) => (out += t), err: (t) => (err += t), stdin: () => "" },
  );
  return { rc, out, err, json: null };
}

/**
 * Write a mutated copy of the authority into a temp source root so the real
 * loader (which reads <sourceRoot>/references/artifacts/state-storage-authority.yaml)
 * can be exercised with malformed contract bytes.
 */
function withMutatedAuthority(mutate: (doc: Record<string, any>) => void): string {
  const tmp = project();
  const doc = YAML.parse(fs.readFileSync(AUTHORITY_PATH, "utf8")) as Record<string, any>;
  mutate(doc);
  const dir = path.join(tmp, "references", "artifacts");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "state-storage-authority.yaml"), YAML.stringify(doc), "utf8");
  return tmp;
}

function decisionAppendArgs(): string[] {
  return [
    "decisions",
    "append",
    "--input",
    "-",
    "--format",
    "json",
  ];
}

describe("decision amendment revision authority", () => {
  it("declares entity amendments and a migration-only aggregate source", () => {
    const contract = decisionRevisionContract();

    expect(contract.location).toBe(".agentera/revisions/decisions.yaml");
    expect(contract.schemaVersion).toBe("agentera.decisionRevision.v1");
    expect(contract.identityKey).toBe("decisions:<decision-number>");
    expect(contract.amendablePaths).toEqual([
      "question",
      "context",
      "alternatives.chosen",
      "alternatives.rejected",
      "choice",
      "reasoning",
      "confidence",
      "feeds_into",
    ]);
    expect(contract.migrationAmendablePaths).toEqual(["alternatives"]);
    expect(contract.legacyAmendablePaths).toContain("alternatives");
    expect(contract.identityPaths).toEqual(["number"]);
    expect(contract.temporalPaths).toEqual(["date"]);
    expect(contract.legacySourceState).toBe("migration_input_only");
    expect(contract.applyState).toBe("entity_implemented_legacy_source_retired");
    expect(contract.immutability).toContain("immutable historical evidence");
    expect(contract.separationFromOverlay).toContain("Current satisfaction");
    expect(contract.publicationOrder.length).toBeGreaterThan(0);
  });

  it("keeps revisions separate from the satisfaction overlay and from identity/temporal paths", () => {
    const revision = decisionRevisionContract();
    const overlay = decisionOverlayContract();

    // Revisions never touch satisfaction overlay mutable paths.
    for (const amendable of revision.amendablePaths) {
      expect(
        overlay.mutablePaths.some(
          (mutable) => amendable === mutable || amendable.startsWith(`${mutable}.`),
        ),
      ).toBe(false);
    }
    // Identity and temporal paths are never amendable.
    for (const reserved of [...revision.identityPaths, ...revision.temporalPaths]) {
      expect(revision.amendablePaths).not.toContain(reserved);
    }
    expect(revision.identityPrefix).toBe(overlay.identityPrefix);
  });

  it("rejects a revisions section that makes an identity path amendable", () => {
    const tmp = withMutatedAuthority((doc) => {
      doc.revisions.amendable_paths.push("number");
    });

    expect(() => decisionRevisionContract(tmp)).toThrow(/identity or temporal path 'number'/);
  });

  it("rejects a revisions section that overlaps a satisfaction overlay path", () => {
    const tmp = withMutatedAuthority((doc) => {
      doc.revisions.amendable_paths.push("satisfaction.state");
    });

    expect(() => decisionRevisionContract(tmp)).toThrow(/overlay mutable path/);
  });

  it("rejects a missing revisions section", () => {
    const tmp = withMutatedAuthority((doc) => {
      delete doc.revisions;
    });

    expect(() => decisionRevisionContract(tmp)).toThrow(/revisions section is required/);
  });
});

describe("decision amend command discovery", () => {
  it("explains amend identity, fields, dry-run guidance, and example consistently", () => {
    const root = project();
    const result = run(root, ["decisions", "explain", "--verb", "amend", "--format", "json"]);

    expect(result.rc).toBe(0);
    expect(result.json?.requested_verb).toBe("amend");
    expect(result.json?.verbs).toEqual(["append", "update", "amend", "explain"]);
    const idField = (result.json?.fields as any[]).find((f) => f.flag === "--id");
    expect(idField).toMatchObject({ required: true, type: "string" });
    const baseHash = (result.json?.fields as any[]).find((f) => f.flag === "--base-sha256");
    expect(baseHash).toMatchObject({ required: true, type: "string" });
    expect(result.json?.input.mode).toBe("structured");
    expect(result.json?.input.sources).toEqual(["file", "stdin"]);
    expect(result.json?.input_schema.record_fields).toEqual(expect.arrayContaining(["question", "alternatives", "confidence"]));
    const guidance = result.json?.guidance as string[];
    expect(guidance.some((g) => g.includes("bare --id") && g.includes("--base-sha256"))).toBe(true);
    expect(guidance.some((g) => g.includes("immutable revision entity"))).toBe(true);
    expect(result.json?.example).toContain("amend --id qjtrmnpvka");
    expect(result.json?.example).toContain("--base-sha256");
  });

  it("surfaces amend as a decisions writer mutation across schema introspection and help", () => {
    const payload = buildSchemaPayload("schema");
    const decisions = (payload.state_writer.artifacts as any[]).find(
      (a) => a.artifact === "decisions",
    );

    expect(decisions.mutations).toEqual(["append", "update", "amend"]);
    expect(decisions.explain_by_verb.amend).toBe(
      "agentera state decisions explain --verb amend --format json",
    );

    const root = project();
    const help = runHelp(root, ["decisions"]);
    expect(help.rc).toBe(0);
    expect(help.out).toContain("{append,update,amend,explain}");
    expect(help.out).toContain("agentera state decisions explain --verb VERB --format json");
  });

  it("refuses to amend a missing decision entity before side effects", () => {
    const root = project();
    const result = run(root, [
      "decisions",
      "amend",
      "--id",
      "aaaaaaaaaa",
      "--base-sha256",
      "0".repeat(64),
      "--input",
      "-",
      "--dry-run",
      "--format",
      "json",
    ], JSON.stringify({ choice: "revised choice", reasoning: "revised reasoning", confidence: "firm" }));

    expect(result.rc).toBe(1);
    expect(JSON.parse(result.out).error).toMatchObject({ id: "aaaaaaaaaa", message: expect.stringMatching(/not found|does not exist/) });
    // No side effects: no revision entity or decision projection is created.
    expect(fs.existsSync(path.join(root, ".agentera", "entities", "decisions", "decision_revision"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".agentera", "decisions.yaml"))).toBe(false);
  });
});

describe("decision number ownership across append, update, and amend", () => {
  it("assigns append IDs while update and amend require a caller-selected bare ID", () => {
    const root = project();

    const appendExplain = run(root, ["decisions", "explain", "--verb", "append", "--format", "json"]);
    expect(appendExplain.rc).toBe(0);
    expect(appendExplain.json?.guidance).toContain("a bare ten-letter ID is assigned by the CLI; do not pass an identity");
    expect(
      (appendExplain.json?.fields as any[]).some((f) => f.flag === "--number"),
    ).toBe(false);

    const updateExplain = run(root, ["decisions", "explain", "--verb", "update", "--format", "json"]);
    expect(updateExplain.rc).toBe(0);
    const updateGuidance = updateExplain.json?.guidance as string[];
    expect(updateGuidance.some((g) => g.includes("bare --id"))).toBe(true);
    expect((updateExplain.json?.fields as any[]).find((f) => f.flag === "--id")).toMatchObject({ required: true, type: "string" });
    expect((updateExplain.json?.fields as any[]).some((f) => f.flag === "--number")).toBe(false);

    const amendExplain = run(root, ["decisions", "explain", "--verb", "amend", "--format", "json"]);
    const amendGuidance = amendExplain.json?.guidance as string[];
    expect(amendGuidance.some((g) => g.includes("bare --id"))).toBe(true);
    expect((amendExplain.json?.fields as any[]).find((f) => f.flag === "--id")).toMatchObject({ required: true, type: "string" });
    expect((amendExplain.json?.fields as any[]).some((f) => f.flag === "--number")).toBe(false);
  });

  it("rejects --number on append and requires --number on update", () => {
    const root = project();

    const appendWithNumber = run(root, [
      "decisions",
      "append",
      "--number",
      "5",
      "--question",
      "x",
      "--context",
      "x",
      "--alternative-chosen",
      "x",
      "--choice",
      "x",
      "--reasoning",
      "x",
      "--confidence",
      "firm",
      "--format",
      "json",
    ]);
    expect(appendWithNumber.rc).toBe(2);
    expect(appendWithNumber.json?.error.class).toBe("unrecognized_argument");
    expect(appendWithNumber.json?.error.message).toContain("--number is assigned by the CLI");

    // update without --number is rejected because the caller must select an existing decision.
    const updateWithoutNumber = run(root, [
      "decisions",
      "update",
      "--satisfaction-state",
      "open",
      "--format",
      "json",
    ]);
    expect(updateWithoutNumber.rc).toBe(2);
    expect(updateWithoutNumber.json?.error.class).toBe("missing_argument");
  });
});

describe("legacy confidence label coexistence", () => {
  it("declares current vocabulary and classifies untouched unsupported labels as explicit legacy", () => {
    const contract = legacyLabelCoexistence();

    expect(contract.currentVocabulary).toEqual(["firm", "provisional", "exploratory"]);
    expect(contract.knownLegacyExamples).toContain("high");
    expect(contract.classificationRule).toContain("explicit legacy state");
    expect(contract.noSilentNormalization).toContain("never rewritten");

    // Positive: an untouched inherited unsupported label stays legacy and is allowed.
    const untouched = classifyConfidenceLabel(contract, "high", false);
    expect(untouched.classification).toBe("explicit_legacy");
    expect(untouched.allowed).toBe(true);
    expect(untouched.caveat).toContain("explicit legacy state");

    // Positive: current vocabulary on new/amended content is accepted.
    const current = classifyConfidenceLabel(contract, "firm", true);
    expect(current.classification).toBe("current");
    expect(current.allowed).toBe(true);
  });

  it("rejects unsupported labels supplied as new or amended content", () => {
    const contract = legacyLabelCoexistence();

    // Negative: a new/amended unsupported label is rejected (current vocabulary required).
    const touched = classifyConfidenceLabel(contract, "high", true);
    expect(touched.classification).toBe("rejected");
    expect(touched.allowed).toBe(false);
    expect(touched.caveat).toContain("requires current vocabulary");
  });

  it("rejects a new amend confidence outside the current vocabulary at parse time", () => {
    const root = project();

    // New/amended confidence must be current vocabulary; "high" is rejected before side effects.
    const amendLegacy = run(root, [
      "decisions",
      "amend",
      "--id",
      "qjtrmnpvka",
      "--base-sha256",
      "0".repeat(64),
      "--input",
      "-",
      "--dry-run",
      "--format",
      "json",
    ], JSON.stringify({ confidence: "high" }));
    expect(amendLegacy.rc).toBe(2);
    expect(amendLegacy.json?.error.class).toBe("schema_violation");
    expect(fs.existsSync(path.join(root, ".agentera", "entities", "decisions", "decision_revision"))).toBe(false);
  });

  it("rejects a new appended decision confidence outside the current vocabulary", () => {
    const root = project();

    const appended = run(root, decisionAppendArgs(), JSON.stringify({ question: "q", context: "c", alternatives: { chosen: "a" }, choice: "a", reasoning: "r", confidence: "high" }));

    expect(appended.rc).toBe(2);
    expect(appended.json?.error.class).toBe("schema_violation");
  });
});
