import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import { acquireGlossaryInputs, acquirePersonalGlossaryInput, acquireProjectGlossaryInput } from "../../src/analytics/glossaryInputAcquisition.js";
import { assessTerminologyDrift, type TerminologyDriftFinding } from "../../src/audit/terminologyDrift.js";
import { main } from "../../src/cli/dispatch.js";
import { glossaryAcquisitionContract } from "../../src/registries/glossaryEntryContract.js";
import { updatePersonalGlossaryProfile, type PersonalGlossaryEntry } from "../../src/analytics/personalGlossaryProfile.js";

const roots: string[] = [];
const START = "<!-- agentera:personal-glossary:start -->";
const END = "<!-- agentera:personal-glossary:end -->";

function temporaryRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `agentera-${label}-`));
  roots.push(root);
  return root;
}

function projectRoot(): string {
  const root = temporaryRoot("glossary-acquisition-project");
  fs.mkdirSync(path.join(root, ".agentera"));
  fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
  return root;
}

function profilePath(initial = "# Profile\n\nPRIVATE_PROFILE_TRAP\n"): string {
  const root = temporaryRoot("glossary-acquisition-profile");
  const pathname = path.join(root, "PROFILE.md");
  fs.writeFileSync(pathname, initial);
  return pathname;
}

function personalEntry(index = 0): PersonalGlossaryEntry {
  return {
    term: `PersonalTerm${index}`,
    meaning: `Personal meaning ${index}`,
    confidence: 82,
    permanence: "durable",
    temporal: { observed_at: "2026-07-27", last_confirmed_at: "2026-07-27" },
    provenance: {
      kind: "personal_explicit_definition",
      evidence: [
        {
          source_id: `PRIVATE_SOURCE_${index}`,
          evidence_anchor: `PRIVATE_ANCHOR_${index}`,
          signal_type: "correction",
        },
      ],
    },
  };
}

function writePersonalGlossary(pathname: string, count = 1): void {
  const entries = Array.from({ length: count }, (_, index) => personalEntry(index));
  updatePersonalGlossaryProfile({
    profilePath: pathname,
    freshEntries: entries,
    retainedHistory: {
      retainedHistory: new Map(
        entries.map((entry, index) => [
          entry.provenance.evidence[0]!.evidence_anchor,
          {
            sourceId: `PRIVATE_SOURCE_${index}`,
            sourceKind: "conversation_turn",
            signalType: "correction",
          },
        ]),
      ),
    },
    asOf: "2026-07-27",
  });
}

function writePersonalGlossaryFixture(pathname: string, count: number): void {
  const entries = Array.from({ length: count }, (_, index) => personalEntry(index));
  const document = {
    schema_version: "agentera.personalGlossarySection.v1",
    as_of: "2026-07-27",
    confidence_basis: Object.fromEntries(entries.map((entry) => [entry.term, entry.confidence])),
    entries,
  };
  fs.writeFileSync(pathname, `${START}\n## Glossary\n\n\`\`\`json\n${JSON.stringify(document, null, 2)}\n\`\`\`\n${END}\n`);
}

function finding(root: string): TerminologyDriftFinding {
  fs.writeFileSync(path.join(root, "term.ts"), "export type ProjectTerm = LegacyProjectTerm;\n");
  fs.writeFileSync(path.join(root, "term-extra.ts"), "export type ProjectAlias = ProjectTerm;\n");
  return assessTerminologyDrift({
    projectRoot: root,
    concepts: [
      {
        concept: "PRIVATE_PROJECT_MEANING",
        confidence: 84,
        severity: "warning",
        terms: [
          {
            term: "ProjectTerm",
            evidence: [
              { source_path: "term.ts", line: 1 },
              { source_path: "term-extra.ts", line: 1 },
            ],
          },
          { term: "LegacyProjectTerm", evidence: [{ source_path: "term.ts", line: 1 }] },
        ],
      },
    ],
    deliberateDecisionConcepts: new Set(),
    trackedIssueConcepts: new Set(),
  })[0]!;
}

function publishProjectGlossary(root: string): string {
  const proposal = finding(root);
  const request = {
    schema_version: "agentera.glossaryPublicationRequest.v1",
    proposal,
    confirmation: {
      proposal_digest: proposal.proposal_digest,
      confirmed_by: "user",
      confirmed_at: "2026-07-27T12:00:00Z",
    },
  };
  const rc = main(["node", "agentera", "state", "glossary", "publish", "--input", "-", "--format", "json", "--project", root], { out: () => {}, err: () => {}, stdin: () => JSON.stringify(request) });
  expect(rc).toBe(0);
  return path.join(root, ".agentera/glossary.yaml");
}

function emptyProjectDocument(): string {
  return "schema_version: agentera.projectGlossary.v1\napprovals: []\nentries: []\n";
}

function padProjectDocument(bytes: number): Buffer {
  const prefix = Buffer.from(`${emptyProjectDocument()}#`);
  return Buffer.concat([prefix, Buffer.alloc(bytes - prefix.byteLength, "x")]);
}

function padFile(pathname: string, bytes: number): void {
  const current = fs.readFileSync(pathname);
  fs.appendFileSync(pathname, Buffer.alloc(bytes - current.byteLength, " "));
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("bounded glossary input acquisition", () => {
  it("loads the single authoritative availability model and bounds", () => {
    expect(glossaryAcquisitionContract()).toEqual({
      maxSourceUtf8Bytes: 65536,
      maxEntries: 100,
      availabilityStates: ["absent", "valid_empty", "valid_present", "malformed", "unreadable", "ambiguous", "over_bound"],
      outputEntryFields: ["term", "meaning", "owner"],
    });
  });

  it("classifies absent, valid-empty, and valid-present project input without exposing approvals or provenance", () => {
    const root = projectRoot();
    expect(acquireProjectGlossaryInput(root)).toEqual({
      owner: "project",
      availability: "absent",
      entries: [],
      gap_proving: true,
      diagnostic: null,
    });

    const glossaryPath = path.join(root, ".agentera/glossary.yaml");
    fs.writeFileSync(glossaryPath, emptyProjectDocument());
    expect(acquireProjectGlossaryInput(root)).toMatchObject({
      availability: "valid_empty",
      entries: [],
      gap_proving: true,
    });

    publishProjectGlossary(root);
    const present = acquireProjectGlossaryInput(root);
    expect(present).toEqual({
      owner: "project",
      availability: "valid_present",
      entries: [{ term: "ProjectTerm", meaning: "PRIVATE_PROJECT_MEANING", owner: "project" }],
      gap_proving: false,
      diagnostic: null,
    });
    expect(JSON.stringify(present)).not.toMatch(/approval|proposal|source_path|provenance|term\.ts/);
    expect(present).not.toHaveProperty("gapProving");
  });

  it("classifies absent, valid-empty, and valid-present personal input while hiding the profile boundary and evidence", () => {
    const missing = path.join(temporaryRoot("missing-profile"), "PROFILE.md");
    expect(acquirePersonalGlossaryInput(missing)).toMatchObject({
      owner: "personal",
      availability: "absent",
      entries: [],
    });

    const noSection = profilePath();
    expect(acquirePersonalGlossaryInput(noSection)).toMatchObject({
      availability: "absent",
      entries: [],
    });

    const empty = profilePath(
      `${START}\n## Glossary\n\n\`\`\`json\n${JSON.stringify(
        {
          schema_version: "agentera.personalGlossarySection.v1",
          as_of: "2026-07-27",
          confidence_basis: {},
          entries: [],
        },
        null,
        2,
      )}\n\`\`\`\n${END}\n`,
    );
    expect(acquirePersonalGlossaryInput(empty)).toMatchObject({
      availability: "valid_empty",
      entries: [],
    });

    const pathname = profilePath();
    writePersonalGlossary(pathname);
    const present = acquirePersonalGlossaryInput(pathname);
    expect(present).toEqual({
      owner: "personal",
      availability: "valid_present",
      entries: [{ term: "PersonalTerm0", meaning: "Personal meaning 0", owner: "personal" }],
      gap_proving: false,
      diagnostic: null,
    });
    expect(JSON.stringify(present)).not.toMatch(/PRIVATE_PROFILE_TRAP|PRIVATE_SOURCE|PRIVATE_ANCHOR|provenance|profile/i);
  });

  it.each([
    ["malformed", "schema_version: wrong\napprovals: []\nentries: []\n"],
    ["over_bound", "x".repeat(65537)],
    [
      "over_bound",
      YAML.stringify({
        schema_version: "agentera.projectGlossary.v1",
        approvals: Array.from({ length: 101 }, () => ({})),
        entries: Array.from({ length: 101 }, () => ({})),
      }),
    ],
  ] as const)("fails closed for %s project bytes", (availability, bytes) => {
    const root = projectRoot();
    fs.writeFileSync(path.join(root, ".agentera/glossary.yaml"), bytes);
    const result = acquireProjectGlossaryInput(root);
    expect(result).toMatchObject({
      owner: "project",
      availability,
      entries: [],
      gap_proving: false,
    });
    expect(Object.keys(result.diagnostic ?? {})).toEqual(["class", "recovery"]);
    expect(JSON.stringify(result)).not.toContain(bytes.slice(0, 32));
  });

  it("accepts exactly 65,536 raw bytes and rejects replacement-decoded project bytes", () => {
    const exactRoot = projectRoot();
    fs.writeFileSync(path.join(exactRoot, ".agentera/glossary.yaml"), padProjectDocument(65536));
    expect(acquireProjectGlossaryInput(exactRoot)).toMatchObject({
      availability: "valid_empty",
      entries: [],
      gap_proving: true,
    });

    const invalidRoot = projectRoot();
    fs.writeFileSync(path.join(invalidRoot, ".agentera/glossary.yaml"), Buffer.concat([Buffer.from([0xff]), Buffer.from("PRIVATE_INVALID_UTF8_PROJECT_TRAP")]));
    const malformed = acquireProjectGlossaryInput(invalidRoot);
    expect(malformed).toMatchObject({ availability: "malformed", entries: [], gap_proving: false });
    expect(JSON.stringify(malformed)).not.toContain("PRIVATE_INVALID_UTF8_PROJECT_TRAP");
  });

  it("fails closed for unreadable and ambiguous project input, including unsafe docs overrides", () => {
    const unreadableRoot = projectRoot();
    const unreadablePath = path.join(unreadableRoot, ".agentera/glossary.yaml");
    fs.writeFileSync(unreadablePath, emptyProjectDocument());
    fs.chmodSync(unreadablePath, 0);
    expect(acquireProjectGlossaryInput(unreadableRoot)).toMatchObject({
      availability: "unreadable",
      entries: [],
      gap_proving: false,
    });
    fs.chmodSync(unreadablePath, 0o600);

    const ambiguousRoot = projectRoot();
    fs.writeFileSync(
      path.join(ambiguousRoot, ".agentera/docs.yaml"),
      YAML.stringify({
        mapping: [{ artifact: "GLOSSARY.md", path: "../../PRIVATE_PATH_TRAP.yaml" }],
      }),
    );
    const ambiguous = acquireProjectGlossaryInput(ambiguousRoot);
    expect(ambiguous).toMatchObject({ availability: "ambiguous", entries: [], gap_proving: false });
    expect(JSON.stringify(ambiguous)).not.toMatch(/PRIVATE_PATH_TRAP|\.\./);
  });

  it("uses the canonical docs override and rejects symlink ambiguity instead of falling back", () => {
    const root = projectRoot();
    fs.mkdirSync(path.join(root, "docs"));
    fs.writeFileSync(
      path.join(root, ".agentera/docs.yaml"),
      YAML.stringify({
        mapping: [{ artifact: "GLOSSARY.md", path: "docs/terms.yaml" }],
      }),
    );
    fs.writeFileSync(path.join(root, "docs/terms.yaml"), emptyProjectDocument());
    expect(acquireProjectGlossaryInput(root)).toMatchObject({
      availability: "valid_empty",
      gap_proving: true,
    });

    fs.unlinkSync(path.join(root, "docs/terms.yaml"));
    fs.symlinkSync(path.join(root, ".agentera/glossary.yaml"), path.join(root, "docs/terms.yaml"));
    expect(acquireProjectGlossaryInput(root)).toMatchObject({
      availability: "ambiguous",
      entries: [],
      gap_proving: false,
    });
  });

  it("rejects symlinked docs authority and descriptor-bound docs and target parent swaps", () => {
    const symlinkRoot = projectRoot();
    const external = temporaryRoot("external-docs-authority");
    const externalDocs = path.join(external, "docs.yaml");
    fs.writeFileSync(
      externalDocs,
      YAML.stringify({
        mapping: [{ artifact: "GLOSSARY.md", path: "PRIVATE_EXTERNAL_TARGET.yaml" }],
      }),
    );
    fs.symlinkSync(externalDocs, path.join(symlinkRoot, ".agentera/docs.yaml"));
    const symlinked = acquireProjectGlossaryInput(symlinkRoot);
    expect(symlinked).toMatchObject({ availability: "ambiguous", entries: [], gap_proving: false });
    expect(JSON.stringify(symlinked)).not.toMatch(/PRIVATE_EXTERNAL_TARGET|external-docs-authority/);

    const invalidDocsRoot = projectRoot();
    fs.writeFileSync(path.join(invalidDocsRoot, ".agentera/docs.yaml"), Buffer.concat([Buffer.from([0xff]), Buffer.from("PRIVATE_INVALID_UTF8_DOCS_TARGET")]));
    const invalidDocs = acquireProjectGlossaryInput(invalidDocsRoot);
    expect(invalidDocs).toMatchObject({
      availability: "ambiguous",
      entries: [],
      gap_proving: false,
    });
    expect(JSON.stringify(invalidDocs)).not.toContain("PRIVATE_INVALID_UTF8_DOCS_TARGET");

    const docsSwapRoot = projectRoot();
    fs.writeFileSync(path.join(docsSwapRoot, ".agentera/docs.yaml"), YAML.stringify({ mapping: [] }));
    let docsSwapped = false;
    const docsRaced = acquireProjectGlossaryInput(docsSwapRoot, {
      afterPathSnapshot(kind) {
        if (kind !== "docs_override" || docsSwapped) return;
        docsSwapped = true;
        fs.renameSync(path.join(docsSwapRoot, ".agentera"), path.join(docsSwapRoot, ".agentera-old"));
        fs.mkdirSync(path.join(docsSwapRoot, ".agentera"));
        fs.writeFileSync(
          path.join(docsSwapRoot, ".agentera/docs.yaml"),
          YAML.stringify({
            mapping: [{ artifact: "GLOSSARY.md", path: "PRIVATE_RACED_DOCS_TARGET.yaml" }],
          }),
        );
      },
    });
    expect(docsRaced).toMatchObject({ availability: "ambiguous", entries: [], gap_proving: false });
    expect(JSON.stringify(docsRaced)).not.toContain("PRIVATE_RACED_DOCS_TARGET");

    const targetSwapRoot = projectRoot();
    fs.mkdirSync(path.join(targetSwapRoot, "terms"));
    fs.writeFileSync(
      path.join(targetSwapRoot, ".agentera/docs.yaml"),
      YAML.stringify({
        mapping: [{ artifact: "GLOSSARY.md", path: "terms/glossary.yaml" }],
      }),
    );
    const externalTerms = temporaryRoot("external-terms-parent");
    fs.writeFileSync(path.join(externalTerms, "glossary.yaml"), emptyProjectDocument());
    let targetSwapped = false;
    const targetRaced = acquireProjectGlossaryInput(targetSwapRoot, {
      afterPathSnapshot(kind) {
        if (kind !== "glossary_target" || targetSwapped) return;
        targetSwapped = true;
        fs.renameSync(path.join(targetSwapRoot, "terms"), path.join(targetSwapRoot, "terms-old"));
        fs.symlinkSync(externalTerms, path.join(targetSwapRoot, "terms"));
      },
    });
    expect(targetRaced).toMatchObject({
      availability: "ambiguous",
      entries: [],
      gap_proving: false,
    });
    expect(JSON.stringify(targetRaced)).not.toMatch(/external-terms-parent|glossary\.yaml/);
  });

  it("fails closed for malformed, ambiguous, unreadable, byte-over-bound, and entry-over-bound personal input", () => {
    const malformed = profilePath(`${START}\n## Glossary\n\n\`\`\`json\nPRIVATE_RAW_TRAP\n\`\`\`\n${END}`);
    expect(acquirePersonalGlossaryInput(malformed)).toMatchObject({
      availability: "malformed",
      entries: [],
    });

    const ambiguous = profilePath(`${START}\n## Glossary\n${END}\n${START}\nPRIVATE_AMBIGUOUS_TRAP`);
    expect(acquirePersonalGlossaryInput(ambiguous)).toMatchObject({
      availability: "ambiguous",
      entries: [],
    });

    const unreadable = profilePath();
    fs.chmodSync(unreadable, 0);
    expect(acquirePersonalGlossaryInput(unreadable)).toMatchObject({
      availability: "unreadable",
      entries: [],
    });
    fs.chmodSync(unreadable, 0o600);

    const oversized = profilePath("PRIVATE_OVERSIZE_TRAP".repeat(4000));
    expect(acquirePersonalGlossaryInput(oversized)).toMatchObject({
      availability: "over_bound",
      entries: [],
    });

    const overCount = profilePath();
    writePersonalGlossaryFixture(overCount, 101);
    const bounded = acquirePersonalGlossaryInput(overCount);
    expect(bounded).toMatchObject({ availability: "over_bound", entries: [] });
    expect(JSON.stringify({ malformed: acquirePersonalGlossaryInput(malformed), bounded })).not.toMatch(/PRIVATE_RAW_TRAP|PRIVATE_SOURCE|PRIVATE_ANCHOR|PRIVATE_OVERSIZE_TRAP/);
  });

  it("accepts exact personal byte and entry bounds and fatally rejects invalid UTF-8", () => {
    const exactBytes = profilePath();
    writePersonalGlossaryFixture(exactBytes, 1);
    padFile(exactBytes, 65536);
    expect(fs.statSync(exactBytes).size).toBe(65536);
    expect(acquirePersonalGlossaryInput(exactBytes)).toMatchObject({
      availability: "valid_present",
      gap_proving: false,
    });

    const exactEntries = profilePath();
    writePersonalGlossaryFixture(exactEntries, 100);
    expect(fs.statSync(exactEntries).size).toBeLessThanOrEqual(65536);
    expect(acquirePersonalGlossaryInput(exactEntries)).toMatchObject({
      availability: "valid_present",
      entries: expect.arrayContaining([{ term: "PersonalTerm99", meaning: "Personal meaning 99", owner: "personal" }]),
    });
    expect(acquirePersonalGlossaryInput(exactEntries).entries).toHaveLength(100);

    const invalidUtf8 = profilePath();
    fs.writeFileSync(invalidUtf8, Buffer.concat([Buffer.from([0xff]), Buffer.from("PRIVATE_INVALID_UTF8_PROFILE_TRAP")]));
    const malformed = acquirePersonalGlossaryInput(invalidUtf8);
    expect(malformed).toMatchObject({ availability: "malformed", entries: [], gap_proving: false });
    expect(JSON.stringify(malformed)).not.toContain("PRIVATE_INVALID_UTF8_PROFILE_TRAP");
  });

  it("keeps valid project meanings usable without personal input and dual unavailability ungrounded", () => {
    const root = projectRoot();
    const projectPath = publishProjectGlossary(root);
    const missingProfile = path.join(temporaryRoot("missing-profile"), "PROFILE.md");
    const projectBefore = fs.readFileSync(projectPath);

    const oneAvailable = acquireGlossaryInputs(root, missingProfile);
    expect(oneAvailable.project.availability).toBe("valid_present");
    expect(oneAvailable.project.entries).toHaveLength(1);
    expect(oneAvailable.personal).toMatchObject({ availability: "absent", entries: [] });

    fs.writeFileSync(projectPath, "PRIVATE_MALFORMED_PROJECT_TRAP");
    const dualUnavailable = acquireGlossaryInputs(root, missingProfile);
    expect(dualUnavailable.project).toMatchObject({ availability: "malformed", entries: [] });
    expect(dualUnavailable.personal).toMatchObject({ availability: "absent", entries: [] });
    expect([...dualUnavailable.project.entries, ...dualUnavailable.personal.entries]).toEqual([]);
    expect(JSON.stringify(dualUnavailable)).not.toContain("PRIVATE_MALFORMED_PROJECT_TRAP");

    fs.writeFileSync(projectPath, projectBefore);
  });

  it("fails closed when acquired personal entries duplicate under Unicode caseless identity", () => {
    const pathname = profilePath();
    writePersonalGlossary(pathname);
    const profile = fs.readFileSync(pathname, "utf8");
    const match = /```json\n([\s\S]*?)\n```/.exec(profile);
    expect(match).not.toBeNull();
    const document = JSON.parse(match![1]);
    document.entries[0].term = "ΟΣ";
    document.entries.push({ ...structuredClone(document.entries[0]), term: "οσ" });
    document.confidence_basis = { ΟΣ: 82, οσ: 82 };
    fs.writeFileSync(pathname, profile.replace(match![1], JSON.stringify(document, null, 2)));

    expect(acquirePersonalGlossaryInput(pathname)).toMatchObject({
      availability: "malformed",
      entries: [],
      gap_proving: false,
    });
  });

  it("is read-only and keeps personal synthesis invariant to project glossary presence", () => {
    const root = projectRoot();
    const pathname = profilePath();
    writePersonalGlossary(pathname);
    const sentinel = path.join(temporaryRoot("live-sentinel"), "sentinel.txt");
    fs.writeFileSync(sentinel, "LIVE_SENTINEL_UNCHANGED");
    const profileBefore = fs.readFileSync(pathname);
    const sentinelBefore = fs.readFileSync(sentinel);

    const withoutProject = acquireGlossaryInputs(root, pathname).personal;
    const projectPath = publishProjectGlossary(root);
    const projectBefore = fs.readFileSync(projectPath);
    const withProject = acquireGlossaryInputs(root, pathname).personal;

    expect(withProject).toEqual(withoutProject);
    expect(fs.readFileSync(pathname)).toEqual(profileBefore);
    expect(fs.readFileSync(projectPath)).toEqual(projectBefore);
    expect(fs.readFileSync(sentinel)).toEqual(sentinelBefore);
  });
});
