import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  updatePersonalGlossaryProfile,
  type PersonalGlossaryEntry,
} from "../../src/analytics/personalGlossaryProfile.js";
import { assessTerminologyDrift } from "../../src/audit/terminologyDrift.js";
import { main } from "../../src/cli/dispatch.js";
import {
  glossaryConsumerContract,
  glossaryEntryAuthorityPath,
} from "../../src/registries/glossaryEntryContract.js";
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

function planInstructions(root: string, profileRoot: string): string {
  const result = spawnSync(
    process.execPath,
    [CLI, "prime", "--context", "plan", "--format", "json"],
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

function appendProgress(
  root: string,
  intent: Record<string, string>,
  callerFields: string[],
  writerFlags: string[],
) {
  const intentFlags = callerFields.flatMap((field, index) =>
    intent[field] === undefined ? [] : [writerFlags[index], intent[field]],
  );
  return spawnSync(
    process.execPath,
    [
      CLI,
      "state",
      "progress",
      "append",
      "--project",
      root,
      "--type",
      "fix",
      "--phase",
      "build",
      "--what",
      "Verify Plan writer intent",
      "--intent",
      "Submit the emitted Plan intent through the typed progress writer",
      ...intentFlags,
      "--format",
      "json",
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...sourceSubprocessEnv(),
        AGENTERA_BOOTSTRAP_SOURCE_ROOT: REPO_ROOT,
      },
    },
  );
}

function progressAppendContract(root: string) {
  return spawnSync(
    process.execPath,
    [CLI, "state", "progress", "explain", "--verb", "append", "--format", "json"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...sourceSubprocessEnv(),
        AGENTERA_BOOTSTRAP_SOURCE_ROOT: REPO_ROOT,
      },
    },
  );
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

function planAuthority(): Record<string, any> {
  return YAML.parse(fs.readFileSync(glossaryEntryAuthorityPath(), "utf8")).consumer_boundary
    .plan_integration;
}

function consumerAuthority(): Record<string, any> {
  return YAML.parse(fs.readFileSync(glossaryEntryAuthorityPath(), "utf8")).consumer_boundary;
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

  it("serves Plan review-before-fixing and autonomous Build handoff semantics", () => {
    const instructions = planInstructions(project(), temporary("missing-profile"));
    const command = "agentera report glossary-advice --input <file|-> --format json";

    expect(instructions).toContain("initial meaning-sensitive planning input");
    expect(instructions).toContain(command);
    expect(instructions).toContain(
      "scope, requirements, constraints, task or overall acceptance, or clarification",
    );
    expect(instructions).toContain("Do not invoke it for unchanged replay");
    expect(instructions).toContain("control-only continuation");
    expect(instructions).toContain("current bounded event input");
    expect(instructions.indexOf("first emit one focused clarification")).toBeLessThan(
      instructions.indexOf("only then finalize affected scope"),
    );
    expect(instructions).toContain(
      "leave affected scope, requirements, tasks, and acceptance explicitly unresolved or deferred",
    );
    expect(instructions).toContain("transient handoff intent");
    expect(instructions).toContain(
      "contains exactly `event: current`, `reason`, and `ownership_state`",
    );
    expect(instructions).toContain("emitted only—not delivered, stored, persisted, or published");
    expect(instructions).not.toContain("fresh opaque ten-letter lowercase ID");
    expect(instructions).not.toContain("`capability` is `plan`");
    expect(instructions).toContain("three caller-owned fields");
    expect(instructions).toContain("`capability: build`");
    expect(instructions).toContain("`transition_id: null`");
    expect(instructions).toContain("`inferred_equivalence`/`review_required`");
    expect(instructions).toContain("`authority_unavailable`/`authority_unavailable`");
    expect(instructions).toContain("`personal_input_unavailable`/`authority_unavailable`");
    expect(instructions).toContain("do not emit a handoff intent");
    expect(instructions).toContain("apply the project meaning");
    expect(instructions).toContain("without exposing the personal definition");
    expect(instructions).toContain("ordinary focused clarification only in interactive mode");
    expect(instructions).toContain("never call `agentera state glossary publish`");
    expect(instructions).not.toContain("PRIVATE_");
  });

  it("drives Plan mode, review order, abstention, advisory, and privacy from structured authority", () => {
    const plan = planAuthority();
    expect(plan.mode).toMatchObject({
      precedence: [
        "explicit_delegated_or_orchestrated_no_pause",
        "direct_user_invocation_with_available_clarification_turn",
        "unknown_or_ambiguous",
      ],
      signals: {
        explicit_delegated_or_orchestrated_no_pause: { result: "autonomous" },
        direct_user_invocation_with_available_clarification_turn: { result: "interactive" },
        unknown_or_ambiguous: { result: "interactive_waiting" },
      },
      silence_or_timeout: "never_autonomous",
    });
    expect(plan.interaction.review.interactive_sequence).toEqual([
      "emit_one_focused_clarification",
      "wait_for_user_answer",
      "refresh_advice_for_affected_term",
      "finalize_affected_scope_requirements_tasks_acceptance",
    ]);
    expect(plan.interaction.review.autonomous_sequence).toEqual([
      "abstain_from_disputed_meaning",
      "defer_affected_scope_requirements_tasks_acceptance",
      "emit_transient_handoff_intent",
    ]);
    expect(plan.autonomous_handoff_intent).toMatchObject({
      status: "transient_emitted_not_delivered",
      caller_fields: ["event", "reason", "ownership_state"],
      fixed_values: { event: "current" },
      accepted_writer_flags: [
        "--glossary-caveat-event",
        "--glossary-caveat-reason",
        "--glossary-caveat-ownership-state",
      ],
      writer_owned_fields: ["caveat_id", "capability", "transition_id"],
      forbidden_fields: ["caveat_id", "capability", "transition_id"],
      forbidden_claims: ["delivered", "stored", "persisted", "published", "durable_envelope"],
      allowed_reason_state_pairs: [
        { reason: "inferred_equivalence", ownership_state: "review_required" },
        { reason: "inferred_equivalence", ownership_state: "project_governs_exact" },
        { reason: "authority_unavailable", ownership_state: "authority_unavailable" },
        { reason: "personal_input_unavailable", ownership_state: "authority_unavailable" },
      ],
    });
    expect(plan.exact_project_personal_unavailable).toMatchObject({
      primary_outcome: "project_only",
      plan_action: "ground_exact_project_meaning",
      autonomous_handoff_intent: "none",
      durable_unresolved_caveat: "none",
    });
    expect(plan.behavior_matrix).toEqual({
      interactive_review_required: {
        mode: "interactive",
        plan_action: "clarify_refresh_then_finalize",
        handoff_intent: "none",
      },
      autonomous_review_required: {
        mode: "autonomous",
        plan_action: "abstain_and_defer",
        handoff_intent: "emitted",
      },
      exact_project_personal_unavailable: {
        mode: "any",
        plan_action: "ground_exact_project_meaning",
        handoff_intent: "none",
      },
      unavailable_unresolved: {
        mode: "autonomous",
        plan_action: "abstain_and_defer",
        handoff_intent: "emitted",
      },
      divergent_exact_collision: {
        mode: "any",
        plan_action: "ground_project_and_bound_tension",
        handoff_intent: "none",
      },
      irrelevant_or_no_applicable_entry: {
        mode: "any",
        plan_action: "leave_unaffected_planning_unchanged",
        handoff_intent: "none",
      },
    });
  });

  it("submits the authority-derived three-field Plan intent through the typed progress writer", () => {
    const root = project();
    const handoff = planAuthority().autonomous_handoff_intent;
    const reasonState = handoff.allowed_reason_state_pairs[0] as Record<string, string>;
    const intent = { ...handoff.fixed_values, ...reasonState } as Record<string, string>;
    const explained = progressAppendContract(root);
    expect(explained.status, explained.stderr).toBe(0);
    const writerContract = JSON.parse(explained.stdout);
    const flagsByField = new Map(
      writerContract.fields.map((field: Record<string, string>) => [field.field, field.flag]),
    );
    const writerFlags = handoff.caller_fields.map((field: string) =>
      flagsByField.get(`glossary_caveat.${field}`),
    );

    expect(Object.keys(intent)).toEqual(handoff.caller_fields);
    expect(writerFlags).toEqual(handoff.accepted_writer_flags);
    const accepted = appendProgress(root, intent, handoff.caller_fields, writerFlags);
    expect(accepted.status, accepted.stderr).toBe(0);
    const output = JSON.parse(accepted.stdout);
    const caveat = output.record.glossary_caveat;
    expect(caveat).toMatchObject(intent);
    expect(caveat.caveat_id).toMatch(/^[a-z]{10}$/);
    expect(caveat.capability).toBe("build");
    expect(caveat.transition_id).toBeNull();
    expect(Object.keys(caveat).sort()).toEqual(
      [...handoff.caller_fields, ...handoff.writer_owned_fields].sort(),
    );
    expect(path.resolve(output.path).startsWith(`${path.resolve(root)}${path.sep}`)).toBe(true);
    expect(fs.existsSync(output.path)).toBe(true);

    const missingEventRoot = project();
    const before = snapshotTree(missingEventRoot);
    const rejected = appendProgress(
      missingEventRoot,
      reasonState,
      handoff.caller_fields,
      writerFlags,
    );
    expect(rejected.status).not.toBe(0);
    expect(rejected.stdout + rejected.stderr).toContain(
      "glossary caveat requires contract-declared event, reason, and ownership state",
    );
    expect(snapshotTree(missingEventRoot)).toEqual(before);
  });

  it("executes structured Plan outcome rows without durable private or consumer-state output", () => {
    const plan = planAuthority();

    const reviewRoot = project();
    const reviewProfile = profile("Ready to sail", "PRIVATE_PERSONAL_DEFINITION");
    const review = advice(reviewRoot, reviewProfile, {
      schema_version: "agentera.glossaryAdviceRequest.v1",
      requested_term: "Ship Shape",
      host_review: {
        relation: "inferred_equivalence",
        candidate_owner: "personal",
        candidate_term: "Ready to sail",
      },
    });
    expect(JSON.parse(review.stdout).advice).toMatchObject({
      outcome: "inferred_equivalence",
      applicable_meaning: null,
      review: "required_when_meaning_sensitive",
    });
    expect(plan.behavior_matrix.interactive_review_required.plan_action).toBe(
      "clarify_refresh_then_finalize",
    );
    expect(plan.behavior_matrix.autonomous_review_required).toMatchObject({
      plan_action: "abstain_and_defer",
      handoff_intent: "emitted",
    });

    const unavailableProjectRoot = project();
    const unavailableProfile = profile("Ship Shape", "PRIVATE_FALLBACK_DEFINITION");
    fs.writeFileSync(
      path.join(unavailableProjectRoot, ".agentera/glossary.yaml"),
      "PRIVATE_MALFORMED_PROJECT",
    );
    const unavailableProject = advice(unavailableProjectRoot, unavailableProfile, {
      schema_version: "agentera.glossaryAdviceRequest.v1",
      requested_term: "Ship Shape",
    });
    expect(JSON.parse(unavailableProject.stdout).advice).toMatchObject({
      outcome: "invalid_or_unavailable_project",
      applicable_meaning: null,
    });
    expect(plan.unavailable.invalid_project).toMatchObject({
      autonomous: "abstain_defer_and_emit_authority_unavailable",
      handoff_pair: ["authority_unavailable", "authority_unavailable"],
    });

    const exactRoot = project();
    publishProject(exactRoot, "Ship Shape", "Project meaning");
    const malformedProfile = temporary("malformed-profile");
    fs.writeFileSync(path.join(malformedProfile, "PROFILE.md"), "PRIVATE_MALFORMED_PROFILE");
    const exactBefore = snapshotTree(exactRoot);
    const malformedBefore = snapshotTree(malformedProfile);
    const exact = advice(exactRoot, malformedProfile, {
      schema_version: "agentera.glossaryAdviceRequest.v1",
      requested_term: "Ship Shape",
    });
    expect(JSON.parse(exact.stdout).advice).toMatchObject({
      outcome: "project_only",
      applicable_owner: "project",
      applicable_meaning: "Project meaning",
      advisory: {
        reason: "personal_input_unavailable",
        ownership_state: "project_governs_exact",
      },
    });
    expect(plan.behavior_matrix.exact_project_personal_unavailable.handoff_intent).toBe("none");
    expect(snapshotTree(exactRoot)).toEqual(exactBefore);
    expect(snapshotTree(malformedProfile)).toEqual(malformedBefore);

    const divergentRoot = project();
    const divergentProfile = profile("Ship Shape", "PRIVATE_DIVERGENT_DEFINITION");
    publishProject(divergentRoot, "Ship Shape", "Project meaning");
    expect(
      JSON.parse(
        advice(divergentRoot, divergentProfile, {
          schema_version: "agentera.glossaryAdviceRequest.v1",
          requested_term: "Ship Shape",
        }).stdout,
      ).advice.outcome,
    ).toBe("divergent_exact_collision");
    expect(plan.behavior_matrix.divergent_exact_collision.plan_action).toBe(
      "ground_project_and_bound_tension",
    );

    const irrelevant = advice(reviewRoot, reviewProfile, {
      schema_version: "agentera.glossaryAdviceRequest.v1",
      requested_term: "Unrelated term",
    });
    expect(JSON.parse(irrelevant.stdout).advice.outcome).toBe("no_applicable_entry");
    expect(plan.behavior_matrix.irrelevant_or_no_applicable_entry.handoff_intent).toBe("none");

    const privacy = consumerAuthority().disclosure.plan_artifacts;
    const candidatePlan = YAML.stringify({
      scope: { included: ["Ship Shape behavior supplied by the user"] },
      tasks: [
        { acceptance: ["GIVEN the behavior is requested WHEN planned THEN it remains bounded"] },
      ],
      handoff: {
        event: "current",
        reason: "inferred_equivalence",
        ownership_state: "review_required",
      },
    });
    expect(privacy.allowed_sources).toEqual([
      "user_authored_term",
      "user_authored_clarification",
      "derived_behavioral_requirement",
    ]);
    for (const trap of [
      "PRIVATE_PERSONAL_DEFINITION",
      "PRIVATE_FALLBACK_DEFINITION",
      "PRIVATE_DIVERGENT_DEFINITION",
      "PRIVATE_ANCHOR",
      "PROFILE.md",
      "personal_explicit_definition",
      "provenance",
      "caveat_id",
      "capability",
      "transition_id",
    ]) {
      expect(candidatePlan).not.toContain(trap);
      expect(
        JSON.stringify({ reason: "inferred_equivalence", ownership_state: "review_required" }),
      ).not.toContain(trap);
    }
  });

  it("runs advice only for governed Plan changes and keeps consumer state mutation-free", () => {
    const root = project();
    const profileRoot = profile("Ready to sail", "Personal fallback meaning");
    publishProject(root, "Ship Shape", "Project meaning");
    fs.mkdirSync(path.join(root, ".agentera/entities/plan"), { recursive: true });
    fs.writeFileSync(path.join(root, ".agentera/entities/plan/sentinel.yaml"), "plan: unchanged\n");
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
    const request = (requested_term: string) => ({
      schema_version: "agentera.glossaryAdviceRequest.v1",
      requested_term,
    });
    const events = [
      { event: "initial_meaning_sensitive_input", request: request("Ship Shape") },
      { event: "unchanged_input_replay" },
      { event: "background_state_reread" },
      { event: "status_or_progress_render" },
      { event: "tool_output_without_requirement_or_intent_change" },
      { event: "artifact_rendering" },
      { event: "evaluator_text_without_user_change" },
      { event: "control_only_continuation" },
      {
        event: "later_user_requirement_change_that_can_change_meaning",
        request: request("Ready to sail"),
      },
      {
        event: "later_acceptance_change_that_can_change_meaning",
        request: request("Unrelated term"),
      },
    ];
    const outcomes = events.flatMap((event) => {
      if (!contract.refreshRequired.includes(event.event) || !event.request) return [];
      const result = advice(root, profileRoot, event.request);
      expect(result.status, result.stderr).toBe(0);
      return [JSON.parse(result.stdout).advice.outcome as string];
    });

    expect(outcomes).toEqual(["project_only", "proven_project_gap", "no_applicable_entry"]);
    expect(contract.refreshNotRequired).toEqual(
      expect.arrayContaining([
        "unchanged_input_replay",
        "background_state_reread",
        "status_or_progress_render",
        "tool_output_without_requirement_or_intent_change",
        "artifact_rendering",
        "evaluator_text_without_user_change",
        "control_only_continuation",
      ]),
    );
    expect(snapshotTree(root)).toEqual(projectBefore);
    expect(snapshotTree(profileRoot)).toEqual(profileBefore);
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
