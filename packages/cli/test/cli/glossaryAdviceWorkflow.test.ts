import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  updatePersonalGlossaryProfile,
  type PersonalGlossaryEntry,
} from "../../src/analytics/personalGlossaryProfile.js";
import { assessTerminologyDrift } from "../../src/audit/terminologyDrift.js";
import { main } from "../../src/cli/dispatch.js";
import { glossaryConsumerContract } from "../../src/registries/glossaryEntryContract.js";
import { sourceModuleUrl, sourceSubprocessEnv } from "../helpers/sourceSubprocess.js";

const roots: string[] = [];
const CLI = fileURLToPath(sourceModuleUrl("bin/agentera.js"));
const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");

function temporary(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `agentera-glossary-advice-${label}-`));
  roots.push(root);
  return root;
}

function project(): string {
  const root = temporary("project");
  fs.mkdirSync(path.join(root, ".agentera"));
  fs.writeFileSync(
    path.join(root, ".agentera/state-mode.yaml"),
    "schemaVersion: agentera.stateMode.v1\nmode: entities\n",
  );
  return root;
}

function personalEntry(term: string, meaning: string): PersonalGlossaryEntry {
  return {
    term,
    meaning,
    confidence: 90,
    permanence: "durable",
    temporal: { observed_at: "2026-07-27", last_confirmed_at: "2026-07-27" },
    provenance: {
      kind: "personal_explicit_definition",
      evidence: [
        {
          source_id: "PRIVATE_SOURCE",
          evidence_anchor: "PRIVATE_ANCHOR",
          signal_type: "correction",
        },
      ],
    },
  };
}

function profile(term: string, meaning: string): string {
  const root = temporary("profile");
  const pathname = path.join(root, "PROFILE.md");
  fs.writeFileSync(pathname, "# Profile\n\nPRIVATE_UNRELATED_PROFILE_BYTES\n");
  const entry = personalEntry(term, meaning);
  updatePersonalGlossaryProfile({
    profilePath: pathname,
    freshEntries: [entry],
    retainedHistory: {
      retainedHistory: new Map([
        [
          "PRIVATE_ANCHOR",
          { sourceId: "PRIVATE_SOURCE", sourceKind: "conversation_turn", signalType: "correction" },
        ],
      ]),
    },
    asOf: "2026-07-27",
  });
  return root;
}

function publishProject(root: string, term: string, meaning: string): void {
  fs.writeFileSync(path.join(root, "one.ts"), `export type ${term} = LegacyTerm;\n`);
  fs.writeFileSync(path.join(root, "two.ts"), `export const value: ${term} = "x";\n`);
  const proposal = assessTerminologyDrift({
    projectRoot: root,
    concepts: [
      {
        concept: meaning,
        confidence: 90,
        severity: "warning",
        terms: [
          {
            term,
            evidence: [
              { source_path: "one.ts", line: 1 },
              { source_path: "two.ts", line: 1 },
            ],
          },
          { term: "LegacyTerm", evidence: [{ source_path: "one.ts", line: 1 }] },
        ],
      },
    ],
    deliberateDecisionConcepts: new Set(),
    trackedIssueConcepts: new Set(),
  })[0]!;
  const request = {
    schema_version: "agentera.glossaryPublicationRequest.v1",
    proposal,
    confirmation: {
      proposal_digest: proposal.proposal_digest,
      confirmed_by: "user",
      confirmed_at: "2026-07-27T12:00:00Z",
    },
  };
  expect(
    main(
      [
        "node",
        "agentera",
        "state",
        "glossary",
        "publish",
        "--input",
        "-",
        "--format",
        "json",
        "--project",
        root,
      ],
      { out: () => {}, err: () => {}, stdin: () => JSON.stringify(request) },
    ),
  ).toBe(0);
}

function advice(root: string, profileRoot: string, request: Record<string, unknown>) {
  return spawnSync(
    process.execPath,
    [CLI, "report", "glossary-advice", "--input", "-", "--format", "json"],
    {
      cwd: root,
      input: JSON.stringify(request),
      encoding: "utf8",
      env: {
        ...sourceSubprocessEnv(),
        AGENTERA_BOOTSTRAP_SOURCE_ROOT: REPO_ROOT,
        AGENTERA_PROFILE_DIR: profileRoot,
      },
    },
  );
}

function discussInstructions(root: string, profileRoot: string): string {
  const result = spawnSync(
    process.execPath,
    [CLI, "prime", "--context", "discuss", "--format", "json"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...sourceSubprocessEnv(),
        AGENTERA_BOOTSTRAP_SOURCE_ROOT: REPO_ROOT,
        AGENTERA_PROFILE_DIR: profileRoot,
      },
    },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout).capability_context.instructions as string;
}

function snapshotTree(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  const visit = (directory: string): void => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const pathname = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(pathname);
      else snapshot[path.relative(root, pathname)] = fs.readFileSync(pathname).toString("base64");
    }
  };
  visit(root);
  return snapshot;
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("packaged Build glossary advice seam", () => {
  it("grounds exact project authority without mutating glossary, approvals, profile, or state", () => {
    const root = project();
    const profileRoot = profile("Ship Shape", "Personal meaning");
    publishProject(root, "Ship Shape", "Project meaning");
    const glossary = path.join(root, ".agentera/glossary.yaml");
    const beforeGlossary = fs.readFileSync(glossary);
    const beforeProfile = fs.readFileSync(path.join(profileRoot, "PROFILE.md"));

    const result = advice(root, profileRoot, {
      schema_version: "agentera.glossaryAdviceRequest.v1",
      requested_term: "ship shape",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "ok",
      advice: {
        outcome: "divergent_exact_collision",
        applicable_owner: "project",
        applicable_meaning: "Project meaning",
        tension: "divergent_exact_collision",
      },
    });
    expect(fs.readFileSync(glossary)).toEqual(beforeGlossary);
    expect(fs.readFileSync(path.join(profileRoot, "PROFILE.md"))).toEqual(beforeProfile);
    expect(fs.existsSync(path.join(root, ".agentera/entities/progress"))).toBe(false);
  });

  it("uses personal meaning only for a proven project gap and abstains for malformed authority", () => {
    const root = project();
    const profileRoot = profile("Ship Shape", "Personal meaning");
    fs.writeFileSync(
      path.join(root, ".agentera/glossary.yaml"),
      "schema_version: agentera.projectGlossary.v1\napprovals: []\nentries: []\n",
    );
    const request = {
      schema_version: "agentera.glossaryAdviceRequest.v1",
      requested_term: "Ship Shape",
    };

    expect(JSON.parse(advice(root, profileRoot, request).stdout).advice).toMatchObject({
      outcome: "proven_project_gap",
      applicable_owner: "personal",
      applicable_meaning: "Personal meaning",
    });
    fs.writeFileSync(path.join(root, ".agentera/glossary.yaml"), "PRIVATE_MALFORMED_PROJECT_TRAP");
    const malformed = advice(root, profileRoot, request);
    expect(JSON.parse(malformed.stdout).advice).toMatchObject({
      outcome: "invalid_or_unavailable_project",
      applicable_owner: null,
      applicable_meaning: null,
      tension: "authority_unavailable",
    });
    expect(malformed.stdout + malformed.stderr).not.toContain("PRIVATE_MALFORMED_PROJECT_TRAP");
  });

  it("requires host-reviewed inferred equivalence without assuming a meaning", () => {
    const root = project();
    const profileRoot = profile("Ready to sail", "A release is ready");
    const base = {
      schema_version: "agentera.glossaryAdviceRequest.v1",
      requested_term: "Ship Shape",
    };
    expect(JSON.parse(advice(root, profileRoot, base).stdout).advice.outcome).toBe(
      "no_applicable_entry",
    );
    const reviewed = advice(root, profileRoot, {
      ...base,
      host_review: {
        relation: "inferred_equivalence",
        candidate_owner: "personal",
        candidate_term: "Ready to sail",
      },
    });
    expect(JSON.parse(reviewed.stdout).advice).toMatchObject({
      outcome: "inferred_equivalence",
      applicable_meaning: null,
      applicable_owner: null,
      review: "required_when_meaning_sensitive",
      tension: "inferred_equivalence",
    });
  });

  it("keeps malformed requests and private review traps out of stdout and stderr", () => {
    const root = project();
    const profileRoot = profile("Ready to sail", "PRIVATE_DEFINITION_TRAP");
    const trap = "PRIVATE_TERM_PATH_ANCHOR_PROVENANCE_TRAP";
    const result = advice(root, profileRoot, {
      schema_version: "agentera.glossaryAdviceRequest.v1",
      requested_term: "Ship Shape",
      host_review: {
        relation: "inferred_equivalence",
        candidate_owner: "personal",
        candidate_term: trap,
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).not.toContain(trap);
    expect(result.stdout + result.stderr).not.toContain("PRIVATE_DEFINITION_TRAP");
  });

  it("serves governed refresh, clarification-before-reliance, autonomy, and publication isolation in Build startup", () => {
    const root = project();
    const result = spawnSync(
      process.execPath,
      [CLI, "prime", "--context", "build", "--format", "json"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...sourceSubprocessEnv(),
          AGENTERA_BOOTSTRAP_SOURCE_ROOT: REPO_ROOT,
          AGENTERA_PROFILE_DIR: temporary("missing-profile"),
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const instructions = JSON.parse(result.stdout).capability_context.instructions as string;
    expect(instructions).toContain("initial meaning-sensitive cycle intent");
    expect(instructions).toContain("Do not refresh for unchanged replay");
    expect(instructions.indexOf("ask one focused clarification")).toBeLessThan(
      instructions.indexOf("before meaning-sensitive execution"),
    );
    expect(instructions).toContain("do not use the disputed meaning");
    expect(instructions).toContain("never call `agentera state glossary publish`");
    expect(instructions).toContain(
      "Explicit project publication remains the separate Build-owned digest-confirmed operation",
    );
  });

  it("serves bounded Discuss event, review, tension, fallback, and mutation-isolation semantics", () => {
    const root = project();
    const profileRoot = profile("Ship Shape", "Project meaning");
    const instructions = discussInstructions(root, profileRoot);
    const command = "agentera report glossary-advice --input <file|-> --format json";

    expect(instructions).toContain("initial meaning-sensitive user input");
    expect(instructions).toContain(command);
    expect(instructions).toContain("later user-authored change to a deliberation premise");
    expect(instructions).toContain("Do not invoke it for unchanged replay");
    expect(instructions).toContain("Done-only control");
    expect(instructions).toContain("never add an unbounded or persistent transcript scan");
    expect(instructions.indexOf("ask one focused clarification first")).toBeLessThan(
      instructions.indexOf("meaning-sensitive reasoning or decision framing"),
    );
    expect(instructions).toContain("with a Done option and no second question");
    expect(instructions).toContain("apply the project meaning");
    expect(instructions).toContain("scratchpad tension or Crux");
    expect(instructions).toContain("continue without glossary grounding");
    expect(instructions).toContain("never call `agentera state glossary publish`");
    expect(instructions).toContain("publishes no consumer caveat");
  });

  it("runs advice only at governed Discuss turns and leaves every project and profile byte unchanged", () => {
    const root = project();
    const profileRoot = profile("Ship Shape", "Project meaning");
    publishProject(root, "Ship Shape", "Project meaning");
    fs.writeFileSync(path.join(root, ".agentera/docs.yaml"), "sentinel: docs\n");
    fs.mkdirSync(path.join(root, ".agentera/entities/decisions"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".agentera/entities/decisions/sentinel.yaml"),
      "decision: unchanged\n",
    );
    fs.mkdirSync(path.join(root, ".agentera/entities/progress"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".agentera/entities/progress/sentinel.yaml"),
      "progress: unchanged\n",
    );
    const projectBefore = snapshotTree(root);
    const profileBefore = snapshotTree(profileRoot);
    const contract = glossaryConsumerContract();
    const requests = {
      project: {
        schema_version: "agentera.glossaryAdviceRequest.v1",
        requested_term: "Ship Shape",
      },
      irrelevant: {
        schema_version: "agentera.glossaryAdviceRequest.v1",
        requested_term: "Unrelated term",
      },
    };
    const turns = [
      { event: "initial_meaning_sensitive_input", request: requests.project },
      { event: "unrelated_conversation_turn" },
      { event: "unchanged_input_replay" },
      { event: "status_or_progress_render" },
      { event: "tool_output_without_requirement_or_intent_change" },
      { event: "done_only_control" },
      {
        event: "later_deliberation_premise_change_that_can_change_meaning",
        request: requests.irrelevant,
      },
      { event: "clarification_answer_for_a_reviewed_term", request: requests.project },
    ];
    const outputs = turns.flatMap((turn) => {
      if (!contract.refreshRequired.includes(turn.event) || !turn.request) return [];
      const result = advice(root, profileRoot, turn.request);
      expect(result.status, result.stderr).toBe(0);
      return [JSON.parse(result.stdout).advice];
    });

    expect(outputs.map((output) => output.outcome)).toEqual([
      "equivalent_exact_collision",
      "no_applicable_entry",
      "equivalent_exact_collision",
    ]);
    expect(contract.refreshNotRequired).toEqual(
      expect.arrayContaining([
        "unrelated_conversation_turn",
        "unchanged_input_replay",
        "status_or_progress_render",
        "tool_output_without_requirement_or_intent_change",
      ]),
    );
    expect(snapshotTree(root)).toEqual(projectBefore);
    expect(snapshotTree(profileRoot)).toEqual(profileBefore);
  });
});
