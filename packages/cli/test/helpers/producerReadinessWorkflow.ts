import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import YAML from "yaml";

import { runServedProfileFullWorkflow } from "./profileFullGlossaryWorkflow.js";

const PROFILE_GLOSSARY_START = "<!-- agentera:personal-glossary:start -->";
const PROFILE_GLOSSARY_END = "<!-- agentera:personal-glossary:end -->";

type GroundingTrapSet = {
  term: string;
  meaning: string;
  sourceId: string;
  evidenceAnchor: string;
  sourceKind: string;
  signalType: string;
  raw: string;
};

export interface ProducerReadinessObservation {
  personal: {
    explicitEvidence: number;
    inferredEvidence: number;
    profileStatuses: string[];
    decayedConfidence: number;
    malformedOutputCasesRejected: number;
  };
  project: {
    auditReadOnly: boolean;
    entryFields: string[];
    approvalStoredSeparately: boolean;
    discoveryStatus: string;
    replayChanged: boolean;
    confirmedVariantViolations: number;
    profileUnchanged: boolean;
  };
  boundary: {
    startupCapabilities: string[];
    groundingStatuses: string[];
    malformedGroundingCasesRejected: number;
    groundingErrorsSanitized: boolean;
    nonGlossaryBytesExact: boolean;
    producerStateUnchanged: boolean;
    producerTermsHidden: boolean;
    personalStatus: string;
    projectStatus: string;
    consumerStatus: Record<string, string>;
    inactiveConsumerBehavior: string[];
  };
}

function environment(root: string): NodeJS.ProcessEnv {
  const env = {
    ...process.env,
    HOME: path.join(root, "home"),
    XDG_DATA_HOME: path.join(root, "xdg-data"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    XDG_CACHE_HOME: path.join(root, "xdg-cache"),
    AGENTERA_PROFILE_DIR: path.join(root, "profile-data"),
  };
  for (const directory of [
    env.HOME,
    env.XDG_DATA_HOME,
    env.XDG_CONFIG_HOME,
    env.XDG_CACHE_HOME,
    env.AGENTERA_PROFILE_DIR,
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  for (const key of Object.keys(env)) {
    if (/^AGENTERA_.*SOURCE.*ROOT$/.test(key)) delete env[key];
  }
  delete env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  delete env.AGENTERA_HOME;
  return env;
}

function invoke(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  input?: string,
) {
  return spawnSync(process.execPath, [executable, ...args], { cwd, env, input, encoding: "utf8" });
}

function groundingTraps(family: string): GroundingTrapSet {
  const prefix = `PRIVATE_${family.toUpperCase().replaceAll("-", "_")}`;
  return {
    term: `${prefix}_TERM`,
    meaning: `${prefix}_MEANING`,
    sourceId: `${prefix}_SOURCE_ID`,
    evidenceAnchor: `${prefix}_EVIDENCE_ANCHOR`,
    sourceKind: `${prefix}_SOURCE_KIND`,
    signalType: `${prefix}_SIGNAL_TYPE`,
    raw: `${prefix}_RAW_MARKER_BODY`,
  };
}

function trapValues(traps: GroundingTrapSet): string[] {
  return Object.values(traps);
}

function assertTrapsAbsent(
  result: ReturnType<typeof invoke>,
  traps: GroundingTrapSet,
  family: string,
): void {
  for (const channel of ["stdout", "stderr"] as const) {
    for (const trap of trapValues(traps)) {
      assert(!result[channel].includes(trap), `${family} leaked ${trap} through ${channel}`);
    }
  }
}

function trappedEntry(traps: GroundingTrapSet, term = traps.term): Record<string, unknown> {
  return {
    term,
    meaning: traps.meaning,
    confidence: 88,
    permanence: "durable",
    temporal: { observed_at: "2026-07-26", last_confirmed_at: "2026-07-26" },
    provenance: {
      kind: "personal_explicit_definition",
      evidence: [
        {
          source_id: traps.sourceId,
          evidence_anchor: traps.evidenceAnchor,
          source_kind: traps.sourceKind,
          signal_type: traps.signalType,
        },
      ],
    },
    raw_marker_body: traps.raw,
  };
}

function trappedDocument(traps: GroundingTrapSet, entries = [trappedEntry(traps)]): string {
  return JSON.stringify(
    {
      schema_version: "agentera.personalGlossarySection.v1",
      as_of: "2026-07-26",
      confidence_basis: Object.fromEntries(
        entries.map((entry) => [String(entry.term).trim().normalize("NFC").toLowerCase(), 88]),
      ),
      entries,
    },
    null,
    2,
  );
}

function ownedProfile(body: string): string {
  return `# Profile\n\n${PROFILE_GLOSSARY_START}\n## Glossary\n\n\`\`\`json\n${body}\n\`\`\`\n${PROFILE_GLOSSARY_END}\n`;
}

function digestTree(root: string): string {
  const records: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile())
        records.push(
          `${path.relative(root, target)}:${createHash("sha256").update(fs.readFileSync(target)).digest("hex")}`,
        );
    }
  };
  visit(root);
  return createHash("sha256").update(records.join("\n")).digest("hex");
}

async function load(executable: string, relative: string): Promise<any> {
  const dist = path.resolve(path.dirname(executable), "..");
  return import(pathToFileURL(path.join(dist, relative)).href);
}

function evidenceRecord(
  sourceId: string,
  sourceKind: string,
  signalType: string,
  data: Record<string, unknown>,
  adapterVersion: string,
) {
  const record = {
    source_id: sourceId,
    source_kind: sourceKind,
    timestamp: "2026-07-26T00:00:00.000Z",
    project_id: "producer-readiness",
    runtime:
      sourceKind.includes("document") || sourceKind.includes("config") ? "filesystem" : "opencode",
    source_class: "active_runtime",
    source_product:
      sourceKind.includes("document") || sourceKind.includes("config") ? "filesystem" : "opencode",
    active_runtime: true,
    adapter_version: adapterVersion,
    data: { ...data, signal_type: signalType },
    origin_id: createHash("sha256").update(`producer-readiness:${sourceId}`, "utf-8").digest("hex"),
    content_fingerprint: createHash("sha256").update(JSON.stringify(data), "utf-8").digest("hex"),
  };
  if (sourceKind === "conversation_turn" || sourceKind === "history_prompt") {
    const text = Object.values(data).find((value): value is string => typeof value === "string") ?? "";
    return {
      ...record,
      content_fingerprint: createHash("sha256").update(text, "utf-8").digest("hex"),
      author_class: data.actor === "assistant" ? "agent" : "user",
      conversation_key: `producer-readiness:${sourceId}`,
      session_id: `producer-readiness:${sourceId}`,
    };
  }
  return record;
}

export async function runProducerReadinessWorkflow(
  executable: string,
  root: string,
): Promise<ProducerReadinessObservation> {
  fs.mkdirSync(root, { recursive: true });
  const project = path.join(root, "project");
  fs.mkdirSync(path.join(project, ".agentera"), { recursive: true });
  const env = environment(project);
  fs.writeFileSync(
    path.join(project, ".agentera/state-mode.yaml"),
    "schemaVersion: agentera.stateMode.v1\nmode: entities\n",
  );

  const tiers = await load(executable, "analytics/extractCorpus/evidenceTiers.js");
  const corpus = await load(executable, "analytics/extractCorpus/core.js");
  const admission = await load(executable, "analytics/personalGlossaryAdmission.js");
  const tiersDir = path.join(root, "tiers");
  tiers.publishEvidenceTiers(
    [
      evidenceRecord(
        "explicit",
        "conversation_turn",
        "correction",
        { actor: "user", text: "Actually, `ship shape` means the complete form of a deliverable." },
        corpus.ADAPTER_VERSION,
      ),
      evidenceRecord(
        "instruction",
        "instruction_document",
        "instruction",
        { content: "Keep the signal braid explicit." },
        corpus.ADAPTER_VERSION,
      ),
      evidenceRecord(
        "configuration",
        "project_config_signal",
        "configuration",
        { signals: ["signal braid"] },
        corpus.ADAPTER_VERSION,
      ),
    ],
    { tiersDir, adapterVersion: corpus.ADAPTER_VERSION, publishedAt: "2026-07-26T00:00:00.000Z" },
  );
  const admitted = admission.admitPersonalGlossaryEvidence({
    tiersDir,
    requestedTerms: ["signal braid"],
  });
  const explicit = admitted.candidates.find(
    (entry: any) => entry.kind === "personal_explicit_definition",
  );
  const inferred = admitted.candidates.find(
    (entry: any) => entry.kind === "personal_inferred_usage",
  );
  assert.equal(explicit?.evidence.length, 1);
  assert.equal(inferred?.evidence.length, 2);

  fs.mkdirSync(path.join(project, ".agentera/glossary.yaml"));
  const profile = runServedProfileFullWorkflow(executable, project);
  fs.rmdirSync(path.join(project, ".agentera/glossary.yaml"));
  const profileBeforeProject = fs.readFileSync(profile.profilePath);

  const audit = await load(executable, "audit/terminologyDrift.js");
  fs.mkdirSync(path.join(project, "src"));
  fs.writeFileSync(
    path.join(project, "src/canonical.ts"),
    "export type ProjectCanonical = string;\n",
  );
  fs.writeFileSync(
    path.join(project, "src/canonical-extra.ts"),
    "export type Alias = ProjectCanonical;\n",
  );
  fs.writeFileSync(path.join(project, "src/variant.ts"), "export type ProjectVariant = string;\n");
  const beforeAudit = digestTree(project);
  const proposal = audit.assessTerminologyDrift({
    projectRoot: project,
    concepts: [
      {
        concept: "project readiness term",
        confidence: 84,
        severity: "warning",
        terms: [
          {
            term: "ProjectCanonical",
            evidence: [
              { source_path: "src/canonical.ts", line: 1 },
              { source_path: "src/canonical-extra.ts", line: 1 },
            ],
          },
          { term: "ProjectVariant", evidence: [{ source_path: "src/variant.ts", line: 1 }] },
        ],
      },
    ],
    deliberateDecisionConcepts: new Set(),
    trackedIssueConcepts: new Set(),
  })[0];
  assert(proposal, "Audit emitted no terminology proposal");
  const auditReadOnly = digestTree(project) === beforeAudit;
  const request = {
    schema_version: "agentera.glossaryPublicationRequest.v1",
    proposal,
    confirmation: {
      proposal_digest: proposal.proposal_digest,
      confirmed_by: "user",
      confirmed_at: "2026-07-26T14:00:00Z",
    },
  };
  const published = invoke(
    executable,
    ["state", "glossary", "publish", "--input", "-", "--format", "json", "--project", project],
    project,
    env,
    JSON.stringify(request),
  );
  assert.equal(published.status, 0, published.stderr || published.stdout);
  const document = YAML.parse(
    fs.readFileSync(path.join(project, ".agentera/glossary.yaml"), "utf8"),
  );
  const entryFields = Object.keys(document.entries[0]);
  const replay = invoke(
    executable,
    ["state", "glossary", "publish", "--input", "-", "--format", "json", "--project", project],
    project,
    env,
    JSON.stringify(request),
  );
  assert.equal(replay.status, 0, replay.stderr || replay.stdout);
  const replayChanged = JSON.parse(replay.stdout).operation.changed;
  const discovery = invoke(
    executable,
    ["state", "query", "--list-artifacts", "--format", "json"],
    project,
    env,
  );
  assert.equal(discovery.status, 0, discovery.stderr || discovery.stdout);
  const glossaryArtifact = JSON.parse(discovery.stdout).artifacts.find(
    (item: any) => item.artifact === "glossary",
  );
  assert(glossaryArtifact, `artifact discovery omitted glossary: ${discovery.stdout}`);

  fs.writeFileSync(
    path.join(project, "src/reintroduced.ts"),
    "export type Broken = ProjectVariant;\n",
  );
  const guard = await load(executable, "validate/v1LegacyCruft.js");
  const confirmedVariantViolations = guard
    .scanPost30CruftViolations(project)
    .filter((message: string) => message.includes("ProjectVariant")).length;
  const profileUnchanged = fs.readFileSync(profile.profilePath).equals(profileBeforeProject);

  const trapTerm = "PRIVATE_CONSUMER_TRAP_7F31";
  fs.writeFileSync(path.join(project, ".agentera/consumer-trap.yaml"), `term: ${trapTerm}\n`);
  fs.writeFileSync(path.join(project, "profile-data/consumer-trap.txt"), trapTerm);
  const observedFiles = [
    profile.profilePath,
    path.join(project, ".agentera/glossary.yaml"),
    path.join(project, ".agentera/consumer-trap.yaml"),
    path.join(project, "profile-data/consumer-trap.txt"),
  ];
  const beforeStartup = observedFiles.map((file) => fs.readFileSync(file));
  const startupCapabilities = ["discuss", "plan", "build"];
  const startupOutput: string[] = [];
  const groundingStatuses: string[] = [];
  let nonGlossaryBytesExact = true;
  const validProfile = fs.readFileSync(profile.profilePath);
  const validProfileText = validProfile.toString("utf8");
  const ownedStart = validProfileText.indexOf(PROFILE_GLOSSARY_START);
  const ownedEnd =
    validProfileText.indexOf(PROFILE_GLOSSARY_END, ownedStart) + PROFILE_GLOSSARY_END.length;
  assert(
    ownedStart >= 0 && ownedEnd >= PROFILE_GLOSSARY_END.length,
    "valid profile omitted its owned glossary section",
  );
  const expectedGrounding = `${validProfileText.slice(0, ownedStart)}${validProfileText.slice(ownedEnd)}`;
  for (const capability of startupCapabilities) {
    const result = invoke(
      executable,
      ["prime", "--context", capability, "--format", "json"],
      project,
      env,
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    startupOutput.push(result.stdout);
    const served = JSON.parse(result.stdout).capability_context;
    const grounding = served.startup?.availability?.find((row: Record<string, unknown>) => row.family === "profile");
    assert.equal(grounding?.detail_command, "npx -y agentera@next report profile-grounding --format json");
    assert.equal(grounding?.availability, "deferred");
    assert.equal(served.profile, undefined);
    assert(
      served.instructions.includes("npx -y agentera@next report profile-grounding --format json"),
      `${capability} pre-cutover instructions omit channel-bound grounding command`,
    );
    for (const forbidden of [
      "profile path for high-confidence entries",
      "served via `planning_context.profile.path` — read directly",
      "Every cycle runs the effective profile.",
    ]) {
      assert(
        !served.instructions.includes(forbidden),
        `${capability} instructions retain raw profile grounding: ${forbidden}`,
      );
    }
    const command = grounding.detail_command.replace(/^npx -y agentera@next /, "agentera ").split(" ").slice(1);
    const grounded = invoke(executable, command, project, env);
    assert.equal(grounded.status, 0, grounded.stderr || grounded.stdout);
    const payload = JSON.parse(grounded.stdout);
    groundingStatuses.push(payload.status);
    nonGlossaryBytesExact &&= payload.content === expectedGrounding;
    assert(
      payload.content.includes("High confidence: preserve semantic seams."),
      `${capability} lost non-glossary profile grounding`,
    );
    for (const hidden of ["ship shape", "complete form of a deliverable", "source", "anchor"]) {
      assert(
        !payload.content.includes(hidden),
        `${capability} grounding leaked personal glossary ${hidden}`,
      );
    }
  }
  const producerStateUnchanged = observedFiles.every((file, index) =>
    fs.readFileSync(file).equals(beforeStartup[index]!),
  );
  const producerTermsHidden = startupOutput.every(
    (output) =>
      !output.includes("ProjectCanonical") &&
      !output.includes("ship shape") &&
      !output.includes(trapTerm),
  );

  const authorityRoot = path.resolve(path.dirname(executable), "../..");
  const authority = YAML.parse(
    fs.readFileSync(
      path.join(authorityRoot, "bundle/references/artifacts/glossary-entry-contract.yaml"),
      "utf8",
    ),
  );
  const malformedProfiles = [
    (() => {
      const traps = groundingTraps("unowned");
      return {
        family: "unowned",
        traps,
        profile: `# Profile\n\n## Glossary\n${trappedDocument(traps)}\n`,
      };
    })(),
    (() => {
      const traps = groundingTraps("unmatched-marker");
      return {
        family: "unmatched-marker",
        traps,
        profile: `# Profile\n\n${PROFILE_GLOSSARY_START}\n## Glossary\n${trappedDocument(traps)}\n`,
      };
    })(),
    (() => {
      const traps = groundingTraps("duplicate-marker");
      return {
        family: "duplicate-marker",
        traps,
        profile: `${ownedProfile(trappedDocument(traps))}${PROFILE_GLOSSARY_START}\n${traps.raw}\n`,
      };
    })(),
    (() => {
      const traps = groundingTraps("invalid-json");
      return {
        family: "invalid-json",
        traps,
        profile: ownedProfile(
          `{${trapValues(traps)
            .map((trap) => JSON.stringify(trap))
            .join(",")}`,
        ),
      };
    })(),
    (() => {
      const traps = groundingTraps("yaml-body");
      return {
        family: "yaml-body",
        traps,
        profile: ownedProfile(YAML.stringify(trappedEntry(traps)).trimEnd()),
      };
    })(),
    (() => {
      const traps = groundingTraps("structured-entry");
      return { family: "structured-entry", traps, profile: ownedProfile(trappedDocument(traps)) };
    })(),
    (() => {
      const traps = groundingTraps("duplicate-term");
      const entries = [trappedEntry(traps), trappedEntry(traps, traps.term.toLowerCase())];
      return {
        family: "duplicate-term",
        traps,
        profile: ownedProfile(trappedDocument(traps, entries)),
      };
    })(),
    (() => {
      const traps = groundingTraps("oversized");
      const body = `${trappedDocument(traps)}\n${traps.raw.repeat(authority.consumer_boundary.profile_grounding.max_profile_utf8_bytes)}`;
      return { family: "oversized", traps, profile: `# Profile\n\n## Glossary\n${body}\n` };
    })(),
  ];
  let malformedGroundingCasesRejected = 0;
  let groundingErrorsSanitized = true;
  for (const { family, traps, profile: malformed } of malformedProfiles) {
    fs.writeFileSync(profile.profilePath, malformed);
    const before = fs.readFileSync(profile.profilePath);
    const rejected = invoke(
      executable,
      ["report", "profile-grounding", "--format", "json"],
      project,
      env,
    );
    assert.notEqual(rejected.status, 0, `${family} profile grounding succeeded`);
    assertTrapsAbsent(rejected, traps, family);
    assert(
      fs.readFileSync(profile.profilePath).equals(before),
      `${family} profile bytes changed after rejection`,
    );
    const rejectedPayload = JSON.parse(rejected.stdout);
    groundingErrorsSanitized &&=
      rejected.stderr === "" &&
      rejectedPayload.status === "repair_needed" &&
      ["malformed", "ambiguous", "oversized"].includes(rejectedPayload.validity?.class) &&
      rejectedPayload.content === null &&
      rejectedPayload.recovery === rejectedPayload.validity?.recovery;
    malformedGroundingCasesRejected += 1;
  }
  fs.writeFileSync(profile.profilePath, validProfile);

  for (const requestFamily of ["request-choice", "request-argument"]) {
    const requestTraps = groundingTraps(requestFamily);
    const privateValue = trapValues(requestTraps).join("-");
    const args =
      requestFamily === "request-choice" ? [`--format=${privateValue}`] : [`--${privateValue}`];
    const invalidRequest = invoke(
      executable,
      ["report", "profile-grounding", ...args],
      project,
      env,
    );
    assert.notEqual(invalidRequest.status, 0, `${requestFamily} private value was accepted`);
    assertTrapsAbsent(invalidRequest, requestTraps, requestFamily);
  }

  const pathTraps = groundingTraps("path");
  const trappedProfileDir = path.join(root, trapValues(pathTraps).join("-"));
  const unavailable = invoke(
    executable,
    ["report", "profile-grounding", "--format", "json"],
    project,
    { ...env, AGENTERA_PROFILE_DIR: trappedProfileDir },
  );
  assert.notEqual(unavailable.status, 0, "missing profile grounding succeeded");
  const unavailablePayload = JSON.parse(unavailable.stdout);
  assert.equal(unavailablePayload.status, "absent");
  assert.deepEqual(unavailablePayload.validity, {
    status: "absent",
    class: "absent",
    recovery: "Use the Profile capability to generate PROFILE.md, then retry agentera report profile-grounding --format json.",
  });
  assertTrapsAbsent(unavailable, pathTraps, "path");

  const readTraps = groundingTraps("read");
  const readHook = path.join(root, "profile-read-failure.mjs");
  fs.writeFileSync(
    readHook,
    [
      'import fs from "node:fs";',
      'import { syncBuiltinESMExports } from "node:module";',
      "const original = fs.openSync;",
      `const profilePath = ${JSON.stringify(profile.profilePath)};`,
      `const failure = ${JSON.stringify(trapValues(readTraps).join(" "))};`,
      "fs.openSync = function (target, ...args) {",
      "  if (String(target) === profilePath) throw new Error(failure);",
      "  return original.call(this, target, ...args);",
      "};",
      "syncBuiltinESMExports();",
      "",
    ].join("\n"),
  );
  const nodeOptions = [env.NODE_OPTIONS, `--import=${pathToFileURL(readHook).href}`]
    .filter(Boolean)
    .join(" ");
  const beforeReadFailure = fs.readFileSync(profile.profilePath);
  const unreadable = invoke(
    executable,
    ["report", "profile-grounding", "--format", "json"],
    project,
    { ...env, NODE_OPTIONS: nodeOptions },
  );
  assert.notEqual(unreadable.status, 0, "profile read failure was accepted");
  assertTrapsAbsent(unreadable, readTraps, "read");
  assert(
    fs.readFileSync(profile.profilePath).equals(beforeReadFailure),
    "profile bytes changed after read failure",
  );

  return {
    personal: {
      explicitEvidence: explicit.evidence.length,
      inferredEvidence: inferred.evidence.length,
      profileStatuses: [profile.firstStatus, profile.replayStatus, profile.laterStatus],
      decayedConfidence: profile.laterConfidence,
      malformedOutputCasesRejected: profile.malformedCasesRejected,
    },
    project: {
      auditReadOnly,
      entryFields,
      approvalStoredSeparately:
        document.approvals.length === 1 && !("proposal_digest" in document.entries[0]),
      discoveryStatus: glossaryArtifact?.implementation_status,
      replayChanged,
      confirmedVariantViolations,
      profileUnchanged,
    },
    boundary: {
      startupCapabilities,
      groundingStatuses,
      malformedGroundingCasesRejected,
      groundingErrorsSanitized,
      nonGlossaryBytesExact,
      producerStateUnchanged,
      producerTermsHidden,
      personalStatus: authority.ownership_contracts.personal.implementation.status,
      projectStatus: authority.ownership_contracts.project.implementation.status,
      consumerStatus: authority.consumer_boundary.implementation.capability_integrations,
      inactiveConsumerBehavior: authority.ownership_contracts.project.implementation.inactive,
    },
  };
}

export const EXPECTED_PRODUCER_READINESS: ProducerReadinessObservation = {
  personal: {
    explicitEvidence: 1,
    inferredEvidence: 2,
    profileStatuses: ["changed", "unchanged_replay", "changed"],
    decayedConfidence: 49,
    malformedOutputCasesRejected: 4,
  },
  project: {
    auditReadOnly: true,
    entryFields: ["term", "meaning", "confidence", "permanence", "temporal", "provenance"],
    approvalStoredSeparately: true,
    discoveryStatus: "active",
    replayChanged: false,
    confirmedVariantViolations: 1,
    profileUnchanged: true,
  },
  boundary: {
    startupCapabilities: ["discuss", "plan", "build"],
    groundingStatuses: ["ok", "ok", "ok"],
    malformedGroundingCasesRejected: 8,
    groundingErrorsSanitized: true,
    nonGlossaryBytesExact: true,
    producerStateUnchanged: true,
    producerTermsHidden: true,
    personalStatus: "active_partial",
    projectStatus: "active",
    consumerStatus: {
      build: "active",
      discuss: "active",
      plan: "active",
      prime: "active",
    },
    inactiveConsumerBehavior: ["lookup", "precedence", "semantic_equivalence_review"],
  },
};
