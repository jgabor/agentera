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

function profileWithEntries(entries: Array<{ term: string; meaning: string }>): string {
  const root = temporary("profile");
  const pathname = path.join(root, "PROFILE.md");
  fs.writeFileSync(pathname, "# Profile\n\nPRIVATE_UNRELATED_PROFILE_BYTES\n");
  updatePersonalGlossaryProfile({
    profilePath: pathname,
    freshEntries: entries.map(({ term, meaning }) => personalEntry(term, meaning)),
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

function profile(term: string, meaning: string): string {
  return profileWithEntries([{ term, meaning }]);
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

function adviceEventClass(
  refresh: Record<"required" | "not_required", string[]>,
  event: string,
): "refresh" | "no_refresh" {
  if (refresh.required.includes(event)) return "refresh";
  if (refresh.not_required.includes(event)) return "no_refresh";
  throw new Error(`undeclared glossary advice event: ${event}`);
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
      allowed_reason_state_pairs: "consumer_boundary.autonomous_caveat.allowed_current_pairs",
    });
    expect(consumerAuthority().autonomous_caveat.allowed_current_pairs).toEqual([
      { reason: "inferred_equivalence", ownership_state: "review_required" },
      { reason: "inferred_equivalence", ownership_state: "project_governs_exact" },
      { reason: "authority_unavailable", ownership_state: "authority_unavailable" },
      { reason: "personal_input_unavailable", ownership_state: "authority_unavailable" },
    ]);
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
    expect(handoff.allowed_reason_state_pairs).toBe(
      "consumer_boundary.autonomous_caveat.allowed_current_pairs",
    );
    const reasonState = consumerAuthority().autonomous_caveat.allowed_current_pairs[0] as Record<
      string,
      string
    >;
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
      "glossary caveat requires one contract-declared reason and ownership state pair",
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

  it("invokes source advice for every authority-required Plan event and no excluded event", () => {
    const root = project();
    const profileRoot = profile("Ready to sail", "A release may proceed after checks pass");
    publishProject(root, "Ship Shape", "Project meaning");
    const projectBefore = snapshotTree(root);
    const profileBefore = snapshotTree(profileRoot);
    const authority = consumerAuthority();
    const refresh = authority.refresh_events as Record<"required" | "not_required", string[]>;
    const clarificationEvent = refresh.required.find((event) => event.includes("clarification"))!;
    const turns = [
      ...refresh.required.map((event, index) => ({
        event,
        request: {
          schema_version: "agentera.glossaryAdviceRequest.v1",
          requested_term:
            index === 0
              ? "Ship Shape"
              : event === clarificationEvent
                ? "Ready to sail"
                : `Changed Plan meaning ${index}`,
        },
      })),
      ...refresh.not_required.map((event) => ({ event, request: undefined })),
    ];
    const invokedEvents: string[] = [];
    const outcomes = turns.flatMap((turn) => {
      if (adviceEventClass(refresh, turn.event) === "no_refresh") return [];
      invokedEvents.push(turn.event);
      expect(Buffer.byteLength(JSON.stringify(turn.request), "utf8")).toBeLessThanOrEqual(
        authority.advice_resolution.invocation.max_request_utf8_bytes,
      );
      const result = advice(root, profileRoot, turn.request!);
      expect(result.status, result.stderr).toBe(0);
      return [JSON.parse(result.stdout).advice.outcome as string];
    });

    expect(turns.slice(0, refresh.required.length).map(({ event }) => event)).toEqual(
      refresh.required,
    );
    expect(turns.slice(refresh.required.length).map(({ event }) => event)).toEqual(
      refresh.not_required,
    );
    expect(invokedEvents).toEqual(refresh.required);
    expect(invokedEvents).toHaveLength(refresh.required.length);
    expect(outcomes).toEqual(
      refresh.required.map((event, index) =>
        index === 0
          ? "project_only"
          : event === clarificationEvent
            ? "proven_project_gap"
            : "no_applicable_entry",
      ),
    );
    expect(snapshotTree(root)).toEqual(projectBefore);
    expect(snapshotTree(profileRoot)).toEqual(profileBefore);
  });

  it("replays connected interactive and autonomous Plan review flows from authority", () => {
    const plan = planAuthority();
    const consumer = consumerAuthority();
    const reviewRoot = project();
    const reviewProfile = profileWithEntries([
      { term: "Ready to sail", meaning: "A release may proceed after checks pass" },
      { term: "Unrelated private term", meaning: "PRIVATE_DISPUTED_MEANING" },
    ]);
    const reviewProjectBefore = snapshotTree(reviewRoot);
    const reviewProfileBefore = snapshotTree(reviewProfile);
    const reviewedRequest = {
      schema_version: "agentera.glossaryAdviceRequest.v1",
      requested_term: "Ship Shape",
      host_review: {
        relation: "inferred_equivalence",
        candidate_owner: "personal",
        candidate_term: "Ready to sail",
      },
    };
    const initial = advice(reviewRoot, reviewProfile, reviewedRequest);
    expect(initial.status, initial.stderr).toBe(0);
    const initialAdvice = JSON.parse(initial.stdout).advice as Record<string, unknown>;
    expect(initialAdvice).toMatchObject({
      outcome: "inferred_equivalence",
      applicable_meaning: null,
      review: "required_when_meaning_sensitive",
    });

    const interactive = plan.interaction.review.interactive_sequence as string[];
    const createInteractiveReplay = () => {
      const planning = {
        affected: {
          scope: "blocked",
          requirements: "blocked",
          tasks: "blocked",
          acceptance: "blocked",
        },
        unrelated: { constraint: "UNCHANGED_UNRELATED_FIELD" },
      };
      const unrelatedBefore = structuredClone(planning.unrelated);
      let index = 0;
      let clarificationCount = 0;
      let refreshInvocationCount = 0;
      let refreshedRequest: Record<string, unknown> | null = null;
      let refreshedAdvice: Record<string, unknown> | null = null;
      const finalize = (): void => {
        if (
          clarificationCount !== 1 ||
          refreshInvocationCount !== 1 ||
          typeof refreshedAdvice?.applicable_meaning !== "string" ||
          !["project", "personal"].includes(String(refreshedAdvice.applicable_owner)) ||
          refreshedAdvice.review !== "none"
        ) {
          throw new Error("affected Plan fields require one usable refreshed advice outcome");
        }
        for (const field of Object.keys(planning.affected) as Array<
          keyof typeof planning.affected
        >) {
          planning.affected[field] = "finalized_after_review";
        }
      };
      const step = (event: string, userAnswer?: string, invokeRefresh = true): void => {
        if (event !== interactive[index]) {
          throw new Error(`contradictory Plan replay order: expected ${interactive[index]}`);
        }
        if (event === "emit_one_focused_clarification") clarificationCount += 1;
        if (event === "refresh_advice_for_affected_term") {
          const answer = userAnswer?.trim() ?? "";
          const prefix = "Use exact term: ";
          if (!answer.startsWith(prefix) || answer.slice(prefix.length).trim().length === 0) {
            throw new Error("review refresh requires a material clarification answer");
          }
          const requestedTerm = answer.slice(prefix.length).trim();
          if (requestedTerm === reviewedRequest.requested_term) {
            throw new Error("review refresh request must change the affected meaning");
          }
          refreshedRequest = {
            schema_version: reviewedRequest.schema_version,
            requested_term: requestedTerm,
          };
          expect(Buffer.byteLength(JSON.stringify(refreshedRequest), "utf8")).toBeLessThanOrEqual(
            consumer.advice_resolution.invocation.max_request_utf8_bytes,
          );
          if (invokeRefresh) {
            const refreshed = advice(reviewRoot, reviewProfile, refreshedRequest);
            expect(refreshed.status, refreshed.stderr).toBe(0);
            refreshInvocationCount += 1;
            refreshedAdvice = JSON.parse(refreshed.stdout).advice;
          }
        }
        if (event === "finalize_affected_scope_requirements_tasks_acceptance") finalize();
        index += 1;
      };
      return {
        planning,
        unrelatedBefore,
        step,
        finalize,
        result: () => ({ refreshedRequest, refreshedAdvice, refreshInvocationCount }),
      };
    };
    const readyForRefresh = () => {
      const replay = createInteractiveReplay();
      replay.step(interactive[0]!);
      replay.step(interactive[1]!);
      return replay;
    };

    expect(() => createInteractiveReplay().step(interactive.at(-1)!)).toThrow(
      "contradictory Plan replay order",
    );
    expect(() => createInteractiveReplay().finalize()).toThrow(
      "affected Plan fields require one usable refreshed advice outcome",
    );
    expect(() => readyForRefresh().step(interactive[2]!, "   ")).toThrow(
      "material clarification answer",
    );
    expect(() => readyForRefresh().step(interactive[2]!, "Use exact term: Ship Shape")).toThrow(
      "request must change the affected meaning",
    );
    const missingRefresh = readyForRefresh();
    missingRefresh.step(interactive[2]!, "Use exact term: Ready to sail", false);
    expect(() => missingRefresh.step(interactive[3]!)).toThrow(
      "one usable refreshed advice outcome",
    );

    const successfulInteractive = readyForRefresh();
    successfulInteractive.step(interactive[2]!, "Use exact term: Ready to sail");
    expect(successfulInteractive.result()).toMatchObject({
      refreshedRequest: {
        schema_version: "agentera.glossaryAdviceRequest.v1",
        requested_term: "Ready to sail",
      },
      refreshedAdvice: {
        outcome: "proven_project_gap",
        applicable_meaning: "A release may proceed after checks pass",
        applicable_owner: "personal",
        review: "none",
      },
      refreshInvocationCount: 1,
    });
    successfulInteractive.step(interactive[3]!);
    expect(new Set(Object.values(successfulInteractive.planning.affected))).toEqual(
      new Set(["finalized_after_review"]),
    );
    expect(successfulInteractive.planning.unrelated).toEqual(successfulInteractive.unrelatedBefore);

    const unavailableRoot = project();
    const unavailableProfile = profile("Ready to sail", "PRIVATE_UNAVAILABLE_MEANING");
    fs.writeFileSync(path.join(unavailableRoot, ".agentera/glossary.yaml"), "PRIVATE_BAD_PROJECT");
    const unavailableProjectBefore = snapshotTree(unavailableRoot);
    const unavailableProfileBefore = snapshotTree(unavailableProfile);
    const unavailable = advice(unavailableRoot, unavailableProfile, {
      schema_version: "agentera.glossaryAdviceRequest.v1",
      requested_term: "Ship Shape",
    });
    expect(unavailable.status, unavailable.stderr).toBe(0);
    const unavailableAdvice = JSON.parse(unavailable.stdout).advice as Record<string, unknown>;
    expect(unavailableAdvice.outcome).toBe("invalid_or_unavailable_project");

    const modeSignal = plan.mode.precedence[0] as string;
    expect(modeSignal).toBe("explicit_delegated_or_orchestrated_no_pause");
    expect(plan.mode.signals[modeSignal].result).toBe("autonomous");
    const autonomous = plan.interaction.review.autonomous_sequence as string[];
    const handoff = plan.autonomous_handoff_intent;
    const allowedPairs = consumer.autonomous_caveat.allowed_current_pairs as Array<
      Record<string, string>
    >;
    const replayAutonomous = (
      adviceOutcome: Record<string, unknown>,
      pair: Record<string, string>,
    ) => {
      let index = 0;
      const planningContent = {
        affected: {
          scope: "unresolved",
          requirements: "unresolved",
          tasks: "unresolved",
          acceptance: "unresolved",
        },
        unrelated: {
          title: "UNCHANGED_AUTONOMOUS_TITLE",
          constraints: ["UNCHANGED_AUTONOMOUS_CONSTRAINT"],
          tasks: [{ name: "UNCHANGED_AUTONOMOUS_TASK", acceptance: ["UNCHANGED_ACCEPTANCE"] }],
        },
      };
      const unrelatedBeforeValue = structuredClone(planningContent.unrelated);
      const unrelatedBeforeBytes = Buffer.from(JSON.stringify(planningContent.unrelated));
      let usedMeaning: string | null = null;
      let intent: Record<string, string> | null = null;
      const step = (event: string): void => {
        if (event !== autonomous[index]) throw new Error("contradictory autonomous Plan order");
        if (event === "abstain_from_disputed_meaning") usedMeaning = null;
        if (event === "defer_affected_scope_requirements_tasks_acceptance") {
          for (const field of Object.keys(planningContent.affected) as Array<
            keyof typeof planningContent.affected
          >) {
            planningContent.affected[field] = "explicitly_deferred";
          }
        }
        if (event === "emit_transient_handoff_intent") {
          if (
            new Set(Object.values(planningContent.affected)).size !== 1 ||
            planningContent.affected.scope !== "explicitly_deferred"
          ) {
            throw new Error("autonomous handoff cannot precede affected-field deferral");
          }
          intent = { ...handoff.fixed_values, ...pair };
        }
        index += 1;
      };
      expect(() => step(autonomous.at(-1)!)).toThrow("contradictory autonomous Plan order");
      for (const event of autonomous) step(event);
      expect(adviceOutcome.applicable_meaning).toBeNull();
      expect(usedMeaning).toBeNull();
      expect(new Set(Object.values(planningContent.affected))).toEqual(
        new Set(["explicitly_deferred"]),
      );
      expect(Object.keys(intent!).sort()).toEqual([...handoff.caller_fields].sort());
      expect(intent).toEqual({
        event: handoff.fixed_values.event,
        reason: pair.reason,
        ownership_state: pair.ownership_state,
      });
      expect(handoff.status).toBe("transient_emitted_not_delivered");
      return {
        status: handoff.status as string,
        intent: intent!,
        unrelatedBeforeValue,
        unrelatedAfterValue: planningContent.unrelated,
        unrelatedBeforeBytes,
        unrelatedAfterBytes: Buffer.from(JSON.stringify(planningContent.unrelated)),
      };
    };
    const reviewPair = allowedPairs.find(
      (pair) =>
        pair.reason === "inferred_equivalence" && pair.ownership_state === "review_required",
    )!;
    const unavailablePair = allowedPairs.find(
      (pair) =>
        pair.reason === plan.unavailable.invalid_project.handoff_pair[0] &&
        pair.ownership_state === plan.unavailable.invalid_project.handoff_pair[1],
    )!;
    const reviewReplay = replayAutonomous(initialAdvice, reviewPair);
    const unavailableReplay = replayAutonomous(unavailableAdvice, unavailablePair);
    expect(reviewReplay.status).toBe("transient_emitted_not_delivered");
    expect(unavailableReplay.status).toBe("transient_emitted_not_delivered");
    for (const replay of [reviewReplay, unavailableReplay]) {
      expect(replay.unrelatedAfterValue).toEqual(replay.unrelatedBeforeValue);
      expect(replay.unrelatedAfterBytes).toEqual(replay.unrelatedBeforeBytes);
    }
    const reviewIntent = reviewReplay.intent;
    const unavailableIntent = unavailableReplay.intent;
    const validateIntent = (intent: Record<string, string>): void => {
      if (
        Object.keys(intent).join("\0") !== handoff.caller_fields.join("\0") ||
        intent.event !== handoff.fixed_values.event ||
        !allowedPairs.some(
          (pair) =>
            pair.reason === intent.reason && pair.ownership_state === intent.ownership_state,
        )
      ) {
        throw new Error("invalid emitted-only Plan handoff intent");
      }
    };
    validateIntent(reviewIntent);
    validateIntent(unavailableIntent);
    expect(() => validateIntent({ ...reviewIntent, capability: "plan" })).toThrow(
      "invalid emitted-only Plan handoff intent",
    );

    const writerRoot = project();
    const explained = progressAppendContract(writerRoot);
    expect(explained.status, explained.stderr).toBe(0);
    const flags = new Map(
      JSON.parse(explained.stdout).fields.map((field: Record<string, string>) => [
        field.field,
        field.flag,
      ]),
    );
    const writerFlags = handoff.caller_fields.map((field: string) =>
      flags.get(`glossary_caveat.${field}`),
    );
    for (const intent of [reviewIntent, unavailableIntent]) {
      const written = appendProgress(writerRoot, intent, handoff.caller_fields, writerFlags);
      expect(written.status, written.stderr).toBe(0);
      expect(JSON.parse(written.stdout).record.glossary_caveat).toMatchObject(intent);
    }

    const replaySurfaces = [
      initial.stdout,
      initial.stderr,
      JSON.stringify(successfulInteractive.result().refreshedAdvice),
      unavailable.stdout,
      unavailable.stderr,
      JSON.stringify(successfulInteractive.planning),
      JSON.stringify(reviewIntent),
      JSON.stringify(unavailableIntent),
    ].join("\n");
    for (const trap of [
      "PRIVATE_DISPUTED_MEANING",
      "PRIVATE_UNAVAILABLE_MEANING",
      "PRIVATE_BAD_PROJECT",
      "PRIVATE_ANCHOR",
      "PRIVATE_SOURCE",
      "PROFILE.md",
    ]) {
      expect(replaySurfaces).not.toContain(trap);
    }
    expect(snapshotTree(reviewRoot)).toEqual(reviewProjectBefore);
    expect(snapshotTree(reviewProfile)).toEqual(reviewProfileBefore);
    expect(snapshotTree(unavailableRoot)).toEqual(unavailableProjectBefore);
    expect(snapshotTree(unavailableProfile)).toEqual(unavailableProfileBefore);
  });

  it("replays Build advice only for initial and changed cycle intent events", () => {
    const root = project();
    const profileRoot = profileWithEntries([
      { term: "Ready to sail", meaning: "Changed cycle personal meaning" },
      { term: "Unrelated private term", meaning: "PRIVATE_UNRELATED_PROFILE_MEANING" },
    ]);
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
    const authority = consumerAuthority();
    const refresh = authority.refresh_events as Record<"required" | "not_required", string[]>;
    const initialRequest = {
      schema_version: "agentera.glossaryAdviceRequest.v1",
      requested_term: "Ship Shape",
    };
    const changedRequest = {
      schema_version: "agentera.glossaryAdviceRequest.v1",
      requested_term: "Ready to sail",
    };
    const events = [
      { event: refresh.required[0], request: initialRequest },
      {
        event: refresh.required.find((event) => event.includes("cycle_intent_change"))!,
        request: changedRequest,
      },
      ...refresh.not_required.map((event) => ({ event })),
    ];
    const invokedEvents: string[] = [];
    const subprocessSurfaces: string[] = [];
    const outcomes = events.flatMap((event) => {
      if (adviceEventClass(refresh, event.event) === "no_refresh") return [];
      invokedEvents.push(event.event);
      expect(Object.keys(event.request!).sort()).toEqual(
        authority.advice_resolution.invocation.request_fields
          .filter((field: string) => field !== "host_review")
          .sort(),
      );
      expect(Buffer.byteLength(JSON.stringify(event.request), "utf8")).toBeLessThanOrEqual(
        authority.advice_resolution.invocation.max_request_utf8_bytes,
      );
      const result = advice(root, profileRoot, event.request!);
      expect(result.status, result.stderr).toBe(0);
      subprocessSurfaces.push(
        result.stdout,
        result.stderr,
        JSON.stringify(JSON.parse(result.stdout)),
      );
      return [JSON.parse(result.stdout).advice.outcome as string];
    });

    expect(events[0]!.event).toBe("initial_meaning_sensitive_input");
    expect(events[1]!.event).toBe("later_cycle_intent_change_that_can_change_meaning");
    expect(events[0]!.request).not.toEqual(events[1]!.request);
    expect(invokedEvents).toEqual([events[0]!.event, events[1]!.event]);
    expect(outcomes).toEqual(["project_only", "proven_project_gap"]);
    expect(events.slice(2).map(({ event }) => event)).toEqual(refresh.not_required);
    for (const trap of [
      "PRIVATE_UNRELATED_PROFILE_MEANING",
      "PRIVATE_UNRELATED_PROFILE_BYTES",
      "PRIVATE_ANCHOR",
      "PRIVATE_SOURCE",
      "PROFILE.md",
    ]) {
      expect(subprocessSurfaces.join("\n")).not.toContain(trap);
    }
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
