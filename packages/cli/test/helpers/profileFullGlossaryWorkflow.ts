import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  persistPersonalGlossaryCandidateProjection,
  personalGlossaryCandidateProjectionPath,
  projectPersonalGlossaryCandidates,
  type PersonalGlossaryCandidateProjection,
} from "../../src/analytics/personalGlossaryCandidateProjection.js";
import {
  ADAPTER_VERSION,
  contentFingerprint,
  originIdentity,
} from "../../src/analytics/extractCorpus/core.js";
import { publishEvidenceTiers } from "../../src/analytics/extractCorpus/evidenceTiers.js";
import { mineExplicitGlossaryCandidates } from "../../src/analytics/personalGlossaryExplicitMining.js";
import { personalProfileGrounding } from "../../src/analytics/personalGlossaryProfile.js";
import { main } from "../../src/cli/dispatch/index.js";
import {
  createGlossaryEvidenceCapsule,
  type GlossaryEvidenceCapsule,
  type GlossaryHostClassificationReceipt,
} from "../../src/registries/glossaryCandidateContracts.js";

const START = "<!-- agentera:personal-glossary:start -->";
const END = "<!-- agentera:personal-glossary:end -->";
const ACTION_MARKER = /<!-- agentera:profile-full-action:([a-z-]+) -->/g;
const ACTIONS = [
  "capture-owned-glossary",
  "write-base-profile",
  "consume-existing-personal-glossary-generation",
  "decide-personal-glossary-candidates",
  "queue-personal-glossary-reviews",
  "publish-authorized-explicit-candidates",
] as const;
const RETAINED_AT = "2099-01-01T00:00:00.000Z";
const AS_OF = "2099-01-01";
const POLICY_VERSION = "agentera.personalGlossaryMiningPolicy.v1";

type Action = (typeof ACTIONS)[number];
type Mapping = Record<string, unknown>;

interface ServedProfileFullContract {
  actions: Action[];
  profilePath: string;
  candidateListLimit: number;
  questionReviewMaximum: number;
}

interface CandidateOutcome {
  capsule: GlossaryEvidenceCapsule;
  receipt: GlossaryHostClassificationReceipt;
  result: Mapping;
}

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface WorkflowResult {
  candidateReadFailures: number;
  candidateReadCount: number;
  exactReadCount: number;
  decisionFailures: number;
  decisionCount: number;
  degradedGeneration: boolean;
  published: number;
  publicationFailures: number;
  publicationCount: number;
  queued: number;
  abstained: number;
  questionPrompts: number;
  publicationStatuses: string[];
  authorizedPublications: Array<{ receipt: GlossaryHostClassificationReceipt; decision: Mapping }>;
}

export interface ProfileFullWorkflowObservation {
  profilePath: string;
  servedActions: Action[];
  initialBaseHasNoGlossary: boolean;
  preservedOwnedSection: boolean;
  malformedCasesRejected: number;
  missingGenerationPreserved: boolean;
  miningFailurePreserved: boolean;
  noCandidatesPreserved: boolean;
  degradedGenerationPreserved: boolean;
  perCandidateGetFailurePreserved: boolean;
  perCandidateDecisionFailurePreserved: boolean;
  publisherFailurePreserved: boolean;
  mixedCandidateReads: number;
  mixedExplicitPublications: number;
  mixedReviewsQueued: number;
  mixedAbstentions: number;
  questionPrompts: number;
  questionPromptMaximum: number;
  fallbackUsedDurableQueue: boolean;
  replayed: boolean;
  projectGlossaryTrapSurvived: boolean;
}

export interface ProductionGlossaryWorkflowObservation {
  generationBound: boolean;
  outcome: string;
  privacyBounded: boolean;
  recovery: string;
}

interface WorkflowFault {
  exactRead?: boolean;
  decision?: boolean;
  publication?: boolean;
}

function isolatedEnv(root: string): NodeJS.ProcessEnv {
  const env = {
    ...process.env,
    HOME: path.join(root, "home"),
    XDG_DATA_HOME: path.join(root, "xdg-data"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    XDG_CACHE_HOME: path.join(root, "xdg-cache"),
    AGENTERA_HOME: path.join(root, "app-home"),
    AGENTERA_PROFILE_DIR: path.join(root, "profile-data"),
  };
  for (const directory of [env.HOME, env.XDG_DATA_HOME, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.AGENTERA_HOME, env.AGENTERA_PROFILE_DIR]) {
    fs.mkdirSync(directory!, { recursive: true });
  }
  for (const key of Object.keys(env)) {
    if (/^AGENTERA_.*SOURCE.*ROOT$/.test(key)) delete env[key];
  }
  delete env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  return env;
}

function invoke(executable: string, args: string[], root: string, input?: string) {
  return spawnSync(process.execPath, [executable, ...args], {
    cwd: root,
    env: isolatedEnv(root),
    encoding: "utf8",
    input,
  });
}

export function invokeInProcess(args: string[], root: string, input?: string) {
  let stdout = "";
  let stderr = "";
  const cwd = process.cwd();
  const env = { ...process.env };
  try {
    process.chdir(root);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, isolatedEnv(root));
    const status = main(["node", "agentera", ...args], {
      out: (text) => { stdout += text; },
      err: (text) => { stderr += text; },
      stdin: input === undefined ? undefined : () => input,
    });
    return { status, stdout, stderr };
  } finally {
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
  }
}

function mapping(value: unknown): Mapping {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), "expected a JSON mapping");
  return value as Mapping;
}

function json(result: CliResult): Mapping {
  assert.equal(result.status, 0, `${result.stderr}${result.stdout}`);
  return mapping(JSON.parse(result.stdout));
}

export function runProductionGlossaryWorkflow(
  executable: string,
  root: string,
): ProductionGlossaryWorkflowObservation {
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, ".agentera"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".agentera", "state-mode.yaml"),
    "schemaVersion: agentera.stateMode.v1\nmode: entities\n",
  );
  const instructionRoot = path.join(root, "instruction-project");
  const configurationRoot = path.join(root, "configuration-project");
  fs.mkdirSync(instructionRoot, { recursive: true });
  fs.mkdirSync(configurationRoot, { recursive: true });
  fs.writeFileSync(path.join(instructionRoot, "AGENTS.md"), "# Rules\nKeep signal-braid explicit.\n");
  fs.writeFileSync(path.join(configurationRoot, "AGENTS.md"), "# Rules\nVerify signal-braid before delivery.\n");

  const refreshArgs = [
    "report", "refresh", "--format", "json",
    "--project-root", instructionRoot,
    "--project-root", configurationRoot,
    "--no-codex", "--no-opencode", "--no-copilot", "--no-cursor",
    "--accept-coverage-gap",
  ];
  const withoutConsent = invoke(executable, refreshArgs, root);
  assert.equal(withoutConsent.status, 2, withoutConsent.stderr || withoutConsent.stdout);
  const recovery = mapping(JSON.parse(withoutConsent.stdout));
  assert.deepEqual(recovery.privacy, {
    local_history_read: false,
    local_history_write: false,
    tier_write: false,
    required_consent: "local-history",
    provided_consent: null,
  });

  const refresh = json(invoke(executable, [...refreshArgs, "--consent", "local-history"], root));
  assert.equal(refresh.status, "pass");
  assert.deepEqual(mapping(refresh.privacy), {
    local_history_read: true,
    local_history_write: false,
    tier_write: true,
    projection_write: true,
    required_consent: "local-history",
    provided_consent: "local-history",
    historical_imports: [],
    historical_import_warning: null,
  });
  const generation = mapping(refresh.projection).generation;

  const listResult = invoke(
    executable,
    ["report", "personal-glossary-candidates", "list", "--limit", "20", "--format", "json"],
    root,
  );
  const list = json(listResult);
  assert.equal(list.generation, generation);
  const recurring = (list.entries as Mapping[]).find((entry) => entry.source_family === "recurring");
  assert(recurring, `production refresh did not retain a recurring candidate: ${listResult.stdout}`);
  for (const privateValue of [instructionRoot, configurationRoot, "Keep signal-braid explicit."]) {
    assert.equal(listResult.stdout.includes(privateValue), false);
  }

  const exact = json(invoke(executable, [
    "report", "personal-glossary-candidates", "get",
    "--candidate-id", String(recurring.candidate_id),
    "--candidate-revision", String(recurring.candidate_revision),
    "--generation", String(list.generation),
    "--policy-version", String(list.policy_version),
    "--format", "json",
  ], root));
  const entry = mapping(exact.entry);
  assert.equal(exact.candidate_projection_sha256, list.candidate_projection_sha256);

  const decision = json(invoke(
    executable,
    ["report", "personal-glossary-decision", "--input", "-", "--format", "json"],
    root,
    JSON.stringify({
      schema_version: "agentera.personalGlossaryAdmissionRequest.v2",
      candidate_id: entry.candidate_id,
      candidate_revision: entry.candidate_revision,
      candidate_capsule_sha256: entry.capsule_sha256,
      candidate_projection_sha256: exact.candidate_projection_sha256,
      generation: exact.generation,
      policy_version: exact.policy_version,
      classification: {
        term: entry.term,
        meaning: entry.meaning,
        scope: entry.scope,
        permanence: "durable",
        consistency: "consistent",
        confidence: 100,
      },
    }),
  ));
  assert.equal(decision.status, "review_required");
  assert.equal(mapping(decision.decision).outcome, "review_required");

  return {
    generationBound:
      exact.generation === list.generation &&
      exact.candidate_projection_sha256 === list.candidate_projection_sha256,
    outcome: String(decision.status),
    privacyBounded: true,
    recovery: String(recovery.recovery),
  };
}

function servedContract(root: string): ServedProfileFullContract {
  const args = ["prime", "--context", "profile", "--format", "json"];
  const prime = invokeInProcess(args, root);
  assert.equal(prime.status, 0, prime.stderr || prime.stdout);
  const context = mapping(JSON.parse(prime.stdout)).capability_context;
  const instructions = mapping(context).instructions;
  assert.equal(typeof instructions, "string", "prime omitted the served Profile instruction body");
  const markers = [...instructions.matchAll(ACTION_MARKER)].map((match: RegExpMatchArray) => match[1]);
  assert.deepEqual(markers, ACTIONS, "served Profile Full actions must be unique and ordered");
  assert(!instructions.includes("report profile-glossary"), "Profile Full retained the retired direct publication grammar");
  assert(!instructions.includes("Profile Full does not invoke"), "Profile Full still excludes authorized personal publication");
  assert(instructions.includes("MUST NOT run `report refresh`"), "Profile Full still refreshes history implicitly");
  assert(instructions.includes("Steps: verify, read, synthesize, generate."), "Profile Full retains implicit extraction steps");
  assert(!instructions.includes("published in Step 1"), "Profile Full still claims to publish a new signal tier");
  assert(!instructions.includes("Run Step 1 refresh"), "Profile Full still routes through an implicit refresh");
  assert(instructions.includes("never reads a project glossary"), "Profile Full lost project-glossary isolation");

  const candidateLimit = /personal-glossary-candidates list --limit (\d+) --format json/.exec(instructions);
  const questionLimit = /show at most (\d+) queued review cards/.exec(instructions);
  assert(candidateLimit, "served Profile instructions omit the bounded candidate command");
  assert(questionLimit, "served Profile instructions omit the bounded question limit");
  const profilePath = path.join(root, "profile-data", "PROFILE.md");
  return {
    actions: [...ACTIONS],
    profilePath,
    candidateListLimit: Number(candidateLimit[1]),
    questionReviewMaximum: Number(questionLimit[1]),
  };
}

function captureOwnedGlossary(profile: string): string | null {
  const starts = profile.split(START).length - 1;
  const ends = profile.split(END).length - 1;
  const headings = [...profile.matchAll(/^## Glossary\s*$/gm)].length;
  if (starts === 0 && ends === 0 && headings === 0) return null;
  personalProfileGrounding(profile);
  const start = profile.indexOf(START);
  const end = profile.indexOf(END, start) + END.length;
  assert(start >= 0 && end > start, "malformed owned Glossary section");
  return profile.slice(start, end);
}

function writeBaseProfile(profilePath: string, base: string, existing: string | null): void {
  if (base.includes(START) || base.includes(END) || /^## Glossary\s*$/m.test(base)) {
    throw new Error("generated base contains a Glossary section");
  }
  fs.writeFileSync(
    profilePath,
    existing === null ? base : `${base}${base.endsWith("\n") ? "\n" : "\n\n"}${existing}\n`,
  );
}

function writeBaseThroughServedActions(actions: readonly Action[], profilePath: string, base: string): string | null {
  let captured: string | null = null;
  for (const action of actions) {
    if (action === "capture-owned-glossary") {
      captured = fs.existsSync(profilePath) ? captureOwnedGlossary(fs.readFileSync(profilePath, "utf8")) : null;
      continue;
    }
    if (action === "write-base-profile") {
      writeBaseProfile(profilePath, base, captured);
      continue;
    }
    break;
  }
  return captured;
}

function ownedSection(): string {
  return `${START}\n## Glossary\n\n\`\`\`json\n${JSON.stringify({
    schema_version: "agentera.personalGlossarySection.v1",
    as_of: "2098-12-31",
    confidence_basis: { "ship shape": 80 },
    entries: [{
      term: "ship shape",
      meaning: "the complete form of a deliverable",
      confidence: 80,
      permanence: "durable",
      temporal: { observed_at: "2098-12-31", last_confirmed_at: "2098-12-31" },
      provenance: { kind: "personal_explicit_definition", evidence: [{ source_id: "source", evidence_anchor: "anchor", signal_type: "correction" }] },
    }],
  }, null, 2)}\n\`\`\`\n${END}`;
}

function tiersDir(root: string): string {
  return path.join(root, "profile-data", "intermediate", "tiers");
}

function record(sourceId: string, text: string): Mapping {
  return {
    source_id: sourceId,
    source_kind: "conversation_turn",
    timestamp: RETAINED_AT,
    project_id: "private-project",
    runtime: "opencode",
    source_class: "active_runtime",
    source_product: "opencode",
    active_runtime: true,
    adapter_version: ADAPTER_VERSION,
    data: { actor: "user", signal_type: "correction", text },
    origin_id: originIdentity(`fixture:${sourceId}`),
    content_fingerprint: contentFingerprint(text),
    session_id: `session-${sourceId}`,
    conversation_key: `session-${sourceId}`,
    author_class: "user",
  };
}

function explicitCapsule(root: string): GlossaryEvidenceCapsule {
  publishEvidenceTiers([record("explicit-source", "Actually, `ship shape` means the complete form of a deliverable.")], {
    tiersDir: tiersDir(root),
    adapterVersion: ADAPTER_VERSION,
    publishedAt: RETAINED_AT,
  });
  const mined = mineExplicitGlossaryCandidates({ tiersDir: tiersDir(root) });
  assert.equal(mined.state, "current");
  assert.equal(mined.candidates.length, 1);
  return mined.candidates[0]!.capsule;
}

function currentTierGeneration(root: string, seed: string): string {
  return publishEvidenceTiers([record(`tier-${seed}`, `Current tier generation ${seed}.`)], {
    tiersDir: tiersDir(root),
    adapterVersion: ADAPTER_VERSION,
    publishedAt: RETAINED_AT,
  }).generation;
}

function inferredCapsule(index: number, generation: string, scope: "personal" | "ambiguous" | "project" = "personal"): GlossaryEvidenceCapsule {
  return createGlossaryEvidenceCapsule({
    term: `inferred term ${index}`,
    meaning: `A review-only meaning ${index}.`,
    scope,
    provenance_kind: "personal_inferred_usage",
    evidence: [
      { source_id: `inferred-${index}-a`, evidence_anchor: `inferred-${index}-a`, source_kind: "instruction_document" },
      { source_id: `inferred-${index}-b`, evidence_anchor: `inferred-${index}-b`, source_kind: "project_config_signal" },
    ],
    policy_version: POLICY_VERSION,
    generation,
  });
}

function explicitProjectionCapsule(index: number, generation: string): GlossaryEvidenceCapsule {
  return createGlossaryEvidenceCapsule({
    term: `explicit term ${index}`,
    meaning: `An explicit meaning ${index}.`,
    scope: "personal",
    provenance_kind: "personal_explicit_definition",
    evidence: [{
      source_id: `explicit-${index}`,
      evidence_anchor: `explicit-${index}`,
      signal_type: "decision",
    }],
    policy_version: POLICY_VERSION,
    generation,
  });
}

function persistProjection(root: string, capsules: readonly GlossaryEvidenceCapsule[], generation: string): PersonalGlossaryCandidateProjection {
  const projection = projectPersonalGlossaryCandidates({
    generation,
    policy_version: POLICY_VERSION,
    retained_at: RETAINED_AT,
    candidates: capsules.map((capsule, index) => ({
      capsule,
      project_ids: [`private-project-${index}`],
      excerpts: index === 0 ? [`${capsule.term} is a bounded safe context.`] : [],
    })),
  });
  persistPersonalGlossaryCandidateProjection(projection, { env: isolatedEnv(root) });
  return projection;
}

function runFullCycle(
  executable: string,
  root: string,
  contract: ServedProfileFullContract,
  base: string,
  capsules: ReadonlyMap<string, GlossaryEvidenceCapsule>,
  questionChannel: boolean,
  fault: WorkflowFault = {},
): WorkflowResult {
  const result: WorkflowResult = {
    candidateReadFailures: 0,
    candidateReadCount: 0,
    exactReadCount: 0,
    decisionFailures: 0,
    decisionCount: 0,
    degradedGeneration: false,
    published: 0,
    publicationFailures: 0,
    publicationCount: 0,
    queued: 0,
    abstained: 0,
    questionPrompts: 0,
    publicationStatuses: [],
    authorizedPublications: [],
  };
  let captured: string | null = null;
  let list: Mapping | null = null;
  const outcomes: CandidateOutcome[] = [];

  for (const action of contract.actions) {
    if (action === "capture-owned-glossary") {
      captured = fs.existsSync(contract.profilePath)
        ? captureOwnedGlossary(fs.readFileSync(contract.profilePath, "utf8"))
        : null;
      continue;
    }
    if (action === "write-base-profile") {
      writeBaseProfile(contract.profilePath, base, captured);
      continue;
    }
    if (action === "consume-existing-personal-glossary-generation") {
      const afterBase = fs.readFileSync(contract.profilePath, "utf8");
      assert(afterBase.startsWith(base), "Profile Full must write its base before reading personal candidates");
      assert.equal(captureOwnedGlossary(afterBase), captured, "candidate retrieval must not replace the owned section");
      result.candidateReadCount += 1;
      const read = invokeInProcess([
        "report", "personal-glossary-candidates", "list", "--limit", String(contract.candidateListLimit), "--format", "json",
      ], root);
      if (read.status !== 0) {
        result.candidateReadFailures += 1;
        continue;
      }
      list = json(read);
      const entries = list.entries;
      assert(Array.isArray(entries), "candidate list omitted its bounded entries");
      assert(entries.length <= contract.candidateListLimit, "candidate list exceeded the served bound");
      result.degradedGeneration = mapping(mapping(list.summary).coverage).status === "degraded";
      continue;
    }
    if (action === "decide-personal-glossary-candidates") {
      if (list === null || result.degradedGeneration) continue;
      const entries = list.entries as unknown[];
      for (const value of entries) {
        const summary = mapping(value);
        const candidateId = String(summary.candidate_id);
        const capsule = capsules.get(candidateId);
        assert(capsule, `test fixture has no capsule for ${candidateId}`);
        result.exactReadCount += 1;
        const exactRead = invokeInProcess([
          "report", "personal-glossary-candidates", "get",
          "--candidate-id", candidateId,
          "--candidate-revision", String(summary.candidate_revision),
          ...(fault.exactRead ? ["--candidate-revision", "f".repeat(64)] : []),
          "--generation", String(list.generation),
          "--policy-version", String(list.policy_version),
          "--format", "json",
        ], root);
        if (exactRead.status !== 0) {
          result.candidateReadFailures += 1;
          continue;
        }
        const exact = json(exactRead);
        const entry = mapping(exact.entry);
        assert.equal(entry.term, capsule.term);
        assert.equal(entry.meaning, capsule.meaning);
        result.decisionCount += 1;
        const decisionArgs = ["report", "personal-glossary-decision", "--input", "-", "--format", "json"];
        const decisionInput = JSON.stringify({
          schema_version: "agentera.personalGlossaryAdmissionRequest.v2",
          candidate_id: entry.candidate_id,
          candidate_revision: entry.candidate_revision,
          candidate_capsule_sha256: entry.capsule_sha256,
          candidate_projection_sha256: list.candidate_projection_sha256,
          generation: list.generation,
          policy_version: list.policy_version,
          classification: {
            term: entry.term,
            meaning: entry.meaning,
            scope: entry.scope,
            permanence: "durable",
            consistency: "consistent",
            ...(fault.decision ? {} : { confidence: 80 }),
          },
        });
        const decisionRead = capsule.provenance_kind === "personal_explicit_definition" && !fault.decision
          ? invoke(executable, decisionArgs, root, decisionInput)
          : invokeInProcess(decisionArgs, root, decisionInput);
        if (decisionRead.status !== 0 || JSON.parse(decisionRead.stdout).status === "fail") {
          result.decisionFailures += 1;
          continue;
        }
        const decision = json(decisionRead);
        const receipt = mapping(decision.receipt);
        assert(receipt, "receipt construction must return one receipt");
        outcomes.push({ capsule, receipt, result: decision });
      }
      continue;
    }
    if (action === "queue-personal-glossary-reviews") {
      for (const outcome of outcomes) {
        const status = outcome.result.status;
        if (status === "abstain") {
          result.abstained += 1;
          continue;
        }
        if (status !== "review_required") continue;
        const queued = json(invokeInProcess([
          "report", "personal-glossary-reviews", "queue", "--input", "-", "--format", "json",
        ], root, JSON.stringify({
          schema_version: "agentera.personalGlossaryReviewQueueRequest.v1",
          receipt: outcome.receipt,
        })));
        assert(["queued", "unchanged_replay", "suppressed", "reopened"].includes(String(queued.status)));
        result.queued += 1;
        if (questionChannel && result.questionPrompts < contract.questionReviewMaximum) {
          result.questionPrompts += 1;
        }
      }
      continue;
    }
    if (action === "publish-authorized-explicit-candidates") {
      for (const outcome of outcomes) {
        if (outcome.result.status !== "automatic_admission") continue;
        assert.equal(outcome.result.reason, "explicit_current_authorized");
        const decision = mapping(outcome.result.decision);
        result.authorizedPublications.push({ receipt: outcome.receipt, decision });
        result.publicationCount += 1;
        const publishArgs = ["report", "personal-glossary-publish", "--input", "-", "--format", "json"];
        const publishInput = JSON.stringify({
          schema_version: "agentera.personalGlossaryPublishRequest.v1",
          receipt: outcome.receipt,
          decision,
          as_of: fault.publication ? "not-a-calendar-date" : AS_OF,
        });
        const publishedRead = fault.publication
          ? invokeInProcess(publishArgs, root, publishInput)
          : invoke(executable, publishArgs, root, publishInput);
        if (publishedRead.status !== 0 || JSON.parse(publishedRead.stdout).status === "fail") {
          result.publicationFailures += 1;
          continue;
        }
        const published = json(publishedRead);
        result.published += 1;
        result.publicationStatuses.push(String(published.status));
      }
    }
  }
  return result;
}

function setup(_executable: string, root: string): ServedProfileFullContract {
  fs.mkdirSync(path.join(root, ".agentera"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agentera", "state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
  return servedContract(root);
}

function writeExistingProfile(profilePath: string, base: string, section: string): void {
  fs.writeFileSync(profilePath, `${base}\n${section}\n`);
}

function trapProjectGlossary(root: string): string {
  const trap = path.join(root, ".agentera", "glossary.yaml");
  if (!fs.existsSync(trap)) fs.mkdirSync(trap, { recursive: true });
  assert(fs.statSync(trap).isDirectory(), "project glossary trap must be a directory");
  return trap;
}

export function runServedProfileFullWorkflow(executable: string, root: string): ProfileFullWorkflowObservation {
  const initialRoot = path.join(root, "initial");
  const initialContract = setup(executable, initialRoot);
  const initialBase = "# Decision Profile: Served Workflow\n\n## Process\n\nfirst base\n";
  assert.equal(writeBaseThroughServedActions(initialContract.actions, initialContract.profilePath, initialBase), null);
  const initial = fs.readFileSync(initialContract.profilePath, "utf8");
  assert.equal(initial, initialBase);

  const establishedOwned = ownedSection();
  const regeneratedBase = "# Decision Profile: Served Workflow\n\n## Decision Patterns\n\n- High confidence: preserve semantic seams.\n\n## Process\n\nregenerated base\n";
  const malformed = [
    "# Existing\n\n## Glossary\nmanual\n",
    `# Existing\n\n${START}\n## Glossary\n`,
    `# Existing\n\n${START}\n## Glossary\n\n\`\`\`json\n{}\n\`\`\`\n${END}\n`,
    `# Existing\n\n${START}\n## Glossary\n\n\`\`\`json\n{}\n\`\`\`\n${END}\n${START}\n`,
  ];
  let malformedCasesRejected = 0;
  for (const original of malformed) {
    fs.writeFileSync(initialContract.profilePath, original);
    assert.throws(() => writeBaseThroughServedActions(initialContract.actions, initialContract.profilePath, regeneratedBase));
    assert.equal(fs.readFileSync(initialContract.profilePath, "utf8"), original);
    malformedCasesRejected += 1;
  }

  const missingRoot = path.join(root, "missing");
  const missingContract = setup(executable, missingRoot);
  writeExistingProfile(missingContract.profilePath, initialBase, establishedOwned);
  const missing = runFullCycle(executable, missingRoot, missingContract, regeneratedBase, new Map(), false);
  const missingExpected = `${regeneratedBase}\n${establishedOwned}\n`;
  assert.equal(missing.candidateReadCount, 1);
  assert.equal(missing.candidateReadFailures, 1);
  assert.equal(fs.readFileSync(missingContract.profilePath, "utf8"), missingExpected);

  const failureRoot = path.join(root, "failure");
  const failureContract = setup(executable, failureRoot);
  writeExistingProfile(failureContract.profilePath, initialBase, establishedOwned);
  currentTierGeneration(failureRoot, "corrupt-projection");
  const projectionPath = personalGlossaryCandidateProjectionPath({ env: isolatedEnv(failureRoot) });
  fs.mkdirSync(path.dirname(projectionPath), { recursive: true });
  fs.writeFileSync(projectionPath, "not a candidate projection\n");
  const failure = runFullCycle(executable, failureRoot, failureContract, regeneratedBase, new Map(), false);
  assert.equal(failure.candidateReadFailures, 1);
  assert.equal(fs.readFileSync(failureContract.profilePath, "utf8"), missingExpected);

  const emptyRoot = path.join(root, "empty");
  const emptyContract = setup(executable, emptyRoot);
  writeExistingProfile(emptyContract.profilePath, initialBase, establishedOwned);
  fs.writeFileSync(path.join(emptyRoot, "AGENTS.md"), "# Rules\nUse ordinary words.\n");
  const emptyRefresh = json(invokeInProcess([
    "report", "refresh", "--consent", "local-history", "--format", "json",
    "--project-root", emptyRoot,
    "--no-codex", "--no-opencode", "--no-copilot", "--no-cursor",
    "--accept-coverage-gap",
  ], emptyRoot));
  assert.equal(emptyRefresh.status, "pass");
  const emptyList = json(invoke(
    executable,
    ["report", "personal-glossary-candidates", "list", "--limit", "20", "--format", "json"],
    emptyRoot,
  ));
  assert.deepEqual(emptyList.entries, []);
  const mining = mapping(mapping(emptyList.summary).mining);
  for (const family of ["explicit", "recurring"]) {
    const counts = mapping(mining[family]);
    assert.equal(typeof counts.candidate_count, "number");
    assert.equal(typeof counts.abstention_count, "number");
  }
  const empty = runFullCycle(executable, emptyRoot, emptyContract, regeneratedBase, new Map(), false);
  assert.equal(empty.candidateReadFailures, 0);
  assert.equal(empty.published, 0);
  assert.equal(fs.readFileSync(emptyContract.profilePath, "utf8"), missingExpected);

  const degradedRoot = path.join(root, "degraded");
  const degradedContract = setup(executable, degradedRoot);
  writeExistingProfile(degradedContract.profilePath, initialBase, establishedOwned);
  const degradedGeneration = currentTierGeneration(degradedRoot, "degraded");
  const degradedCapsules = [
    explicitProjectionCapsule(99, degradedGeneration),
    ...Array.from({ length: 51 }, (_, index) => inferredCapsule(index + 100, degradedGeneration)),
  ];
  const degradedProjection = persistProjection(degradedRoot, degradedCapsules, degradedGeneration);
  assert(degradedProjection.candidates.some(({ capsule }) => capsule.provenance_kind === "personal_explicit_definition"));
  const degraded = runFullCycle(executable, degradedRoot, degradedContract, regeneratedBase, new Map(), false);
  assert.equal(degraded.degradedGeneration, true);
  assert.equal(degraded.exactReadCount, 0);
  assert.equal(degraded.decisionCount, 0);
  assert.equal(degraded.queued, 0);
  assert.equal(degraded.publicationCount, 0);
  assert.equal(degraded.published, 0);
  assert.equal(fs.readFileSync(degradedContract.profilePath, "utf8"), missingExpected);
  assert.equal(captureOwnedGlossary(fs.readFileSync(degradedContract.profilePath, "utf8")), establishedOwned);

  const getFailureRoot = path.join(root, "candidate-get-failure");
  const getFailureContract = setup(executable, getFailureRoot);
  writeExistingProfile(getFailureContract.profilePath, initialBase, establishedOwned);
  const getFailureCapsule = explicitCapsule(getFailureRoot);
  persistProjection(getFailureRoot, [getFailureCapsule], getFailureCapsule.generation);
  const getFailure = runFullCycle(
    executable,
    getFailureRoot,
    getFailureContract,
    regeneratedBase,
    new Map([[getFailureCapsule.candidate_id, getFailureCapsule]]),
    false,
    { exactRead: true },
  );
  assert.equal(getFailure.candidateReadFailures, 1);
  assert.equal(getFailure.decisionCount, 0);
  assert.equal(getFailure.publicationCount, 0);
  assert.equal(fs.readFileSync(getFailureContract.profilePath, "utf8"), missingExpected);

  const decisionFailureRoot = path.join(root, "decision-failure");
  const decisionFailureContract = setup(executable, decisionFailureRoot);
  writeExistingProfile(decisionFailureContract.profilePath, initialBase, establishedOwned);
  const decisionFailureCapsule = explicitCapsule(decisionFailureRoot);
  persistProjection(decisionFailureRoot, [decisionFailureCapsule], decisionFailureCapsule.generation);
  const decisionFailure = runFullCycle(
    executable,
    decisionFailureRoot,
    decisionFailureContract,
    regeneratedBase,
    new Map([[decisionFailureCapsule.candidate_id, decisionFailureCapsule]]),
    false,
    { decision: true },
  );
  assert.equal(decisionFailure.decisionFailures, 1);
  assert.equal(decisionFailure.publicationCount, 0);
  assert.equal(fs.readFileSync(decisionFailureContract.profilePath, "utf8"), missingExpected);

  const publisherFailureRoot = path.join(root, "publisher-failure");
  const publisherFailureContract = setup(executable, publisherFailureRoot);
  writeExistingProfile(publisherFailureContract.profilePath, initialBase, establishedOwned);
  const publisherFailureCapsule = explicitCapsule(publisherFailureRoot);
  persistProjection(publisherFailureRoot, [publisherFailureCapsule], publisherFailureCapsule.generation);
  const publisherFailure = runFullCycle(
    executable,
    publisherFailureRoot,
    publisherFailureContract,
    regeneratedBase,
    new Map([[publisherFailureCapsule.candidate_id, publisherFailureCapsule]]),
    false,
    { publication: true },
  );
  assert.equal(publisherFailure.publicationFailures, 1);
  assert.equal(publisherFailure.published, 0);
  assert.equal(fs.readFileSync(publisherFailureContract.profilePath, "utf8"), missingExpected);

  const fallbackRoot = path.join(root, "fallback");
  const fallbackContract = setup(executable, fallbackRoot);
  writeExistingProfile(fallbackContract.profilePath, initialBase, establishedOwned);
  const fallbackCapsule = inferredCapsule(1, currentTierGeneration(fallbackRoot, "fallback"));
  persistProjection(fallbackRoot, [fallbackCapsule], fallbackCapsule.generation);
  const fallback = runFullCycle(
    executable,
    fallbackRoot,
    fallbackContract,
    regeneratedBase,
    new Map([[fallbackCapsule.candidate_id, fallbackCapsule]]),
    false,
  );
  assert.equal(fallback.queued, 1);
  assert.equal(fallback.questionPrompts, 0);
  assert.equal(fallback.published, 0);
  assert.equal(fs.readFileSync(fallbackContract.profilePath, "utf8"), missingExpected);

  const mixedRoot = root;
  const mixedContract = setup(executable, mixedRoot);
  writeExistingProfile(mixedContract.profilePath, initialBase, establishedOwned);
  const explicit = explicitCapsule(mixedRoot);
  const inferred = inferredCapsule(2, explicit.generation);
  const ambiguous = inferredCapsule(3, explicit.generation, "ambiguous");
  const projectScoped = inferredCapsule(4, explicit.generation, "project");
  persistProjection(mixedRoot, [explicit, inferred, ambiguous, projectScoped], explicit.generation);
  const glossaryTrap = trapProjectGlossary(mixedRoot);
  const mixedCapsules = new Map([
    [explicit.candidate_id, explicit],
    [inferred.candidate_id, inferred],
    [ambiguous.candidate_id, ambiguous],
    [projectScoped.candidate_id, projectScoped],
  ]);
  const mixed = runFullCycle(executable, mixedRoot, mixedContract, regeneratedBase, mixedCapsules, true);
  const mixedProfile = fs.readFileSync(mixedContract.profilePath, "utf8");
  assert.equal(mixed.published, 1);
  assert.equal(mixed.queued, 2);
  assert.equal(mixed.abstained, 1);
  assert.equal(mixed.questionPrompts, 2);
  assert(mixedProfile.startsWith(`${regeneratedBase}\n`));
  assert(mixedProfile.includes("ship shape"));
  assert(mixedProfile.includes("inferred term") === false, "review-only terms must not publish");
  assert(fs.statSync(glossaryTrap).isDirectory(), "project glossary trap must remain untouched");
  const beforeReplay = mixedProfile;
  const replayRequest = mixed.authorizedPublications[0]!;
  const replay = json(invoke(executable, [
    "report", "personal-glossary-publish", "--input", "-", "--format", "json",
  ], mixedRoot, JSON.stringify({
    schema_version: "agentera.personalGlossaryPublishRequest.v1",
    receipt: replayRequest.receipt,
    decision: replayRequest.decision,
    as_of: AS_OF,
  })));
  assert.equal(replay.status, "unchanged_replay");
  assert.equal(fs.readFileSync(mixedContract.profilePath, "utf8"), beforeReplay);

  const questionsRoot = path.join(root, "questions");
  const questionsContract = setup(executable, questionsRoot);
  writeExistingProfile(questionsContract.profilePath, initialBase, establishedOwned);
  const questionGeneration = currentTierGeneration(questionsRoot, "questions");
  const questionCapsules = [1, 2, 3, 4].map((index) => inferredCapsule(index + 10, questionGeneration));
  persistProjection(questionsRoot, questionCapsules, questionGeneration);
  const questions = runFullCycle(
    executable,
    questionsRoot,
    questionsContract,
    regeneratedBase,
    new Map(questionCapsules.map((capsule) => [capsule.candidate_id, capsule])),
    true,
  );
  assert.equal(questions.queued, questionCapsules.length);
  assert.equal(questions.questionPrompts, questionsContract.questionReviewMaximum);
  assert.equal(questions.published, 0);

  return {
    profilePath: mixedContract.profilePath,
    servedActions: mixedContract.actions,
    initialBaseHasNoGlossary: !initial.includes("## Glossary"),
    preservedOwnedSection: captureOwnedGlossary(fs.readFileSync(mixedContract.profilePath, "utf8")) !== null,
    malformedCasesRejected,
    missingGenerationPreserved: fs.readFileSync(missingContract.profilePath, "utf8") === missingExpected,
    miningFailurePreserved: fs.readFileSync(failureContract.profilePath, "utf8") === missingExpected,
    noCandidatesPreserved: fs.readFileSync(emptyContract.profilePath, "utf8") === missingExpected,
    degradedGenerationPreserved: fs.readFileSync(degradedContract.profilePath, "utf8") === missingExpected,
    perCandidateGetFailurePreserved:
      fs.readFileSync(getFailureContract.profilePath, "utf8") === missingExpected,
    perCandidateDecisionFailurePreserved:
      fs.readFileSync(decisionFailureContract.profilePath, "utf8") === missingExpected,
    publisherFailurePreserved:
      fs.readFileSync(publisherFailureContract.profilePath, "utf8") === missingExpected,
    mixedCandidateReads: mixed.candidateReadCount,
    mixedExplicitPublications: mixed.published,
    mixedReviewsQueued: mixed.queued,
    mixedAbstentions: mixed.abstained,
    questionPrompts: questions.questionPrompts,
    questionPromptMaximum: questionsContract.questionReviewMaximum,
    fallbackUsedDurableQueue: fallback.queued === 1 && fallback.questionPrompts === 0,
    replayed: replay.status === "unchanged_replay",
    projectGlossaryTrapSurvived: fs.statSync(glossaryTrap).isDirectory(),
  };
}
