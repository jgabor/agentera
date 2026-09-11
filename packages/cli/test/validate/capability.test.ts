import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildProtocolValueLookup, checkDeprecation, checkPrimitiveReferences, checkTriggerEnrichment, collectSchemaGroups, loadCapabilitySchemaContract, validateCapability } from "../../src/validate/capability.js";
import { BOOTSTRAP_SOURCE_ROOT_ENV } from "../../src/core/sourceRoot.js";
import { CAPABILITY_INSTRUCTIONS } from "../../src/capabilities/index.js";
import { HUMAN_REFERENCE_LABELS, HUMAN_REFERENCE_INSTRUCTIONS, humanReference, withHumanReferences } from "../../src/capabilities/humanReferences.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const CONTRACT_PATH = path.join(REPO_ROOT, "skills", "agentera", "capability_schema_contract.yaml");
const PROTOCOL_PATH = path.join(REPO_ROOT, "skills", "agentera", "protocol.yaml");

describe("shared human references", () => {
  it("binds all served capabilities and the public skill to the protocol labels", () => {
    vi.stubEnv(BOOTSTRAP_SOURCE_ROOT_ENV, REPO_ROOT);
    const protocol = YAML.parse(fs.readFileSync(PROTOCOL_PATH, "utf8"));
    expect(HUMAN_REFERENCE_LABELS).toEqual(protocol.HUMAN_REFERENCES.labels);
    expect(Object.keys(HUMAN_REFERENCE_LABELS)).toEqual(["decision", "plan", "task", "todo"]);
    const skill = fs.readFileSync(path.join(REPO_ROOT, "skills/agentera/SKILL.md"), "utf8");
    for (const label of Object.values(protocol.HUMAN_REFERENCES.labels)) expect(skill).toContain(label);
    for (const body of Object.values(CAPABILITY_INSTRUCTIONS)) expect(body).toContain(HUMAN_REFERENCE_INSTRUCTIONS);
    expect(CAPABILITY_INSTRUCTIONS.status).not.toContain("PLAN Task N:");
  });

  it("uses content without title metadata and preserves identity and meaning after glyph loss", () => {
    for (const family of Object.keys(HUMAN_REFERENCE_LABELS) as Array<keyof typeof HUMAN_REFERENCE_LABELS>) {
      const first = humanReference(family, "Keep bounded reads", "aaaaaaaaaa", "in_progress");
      const second = humanReference(family, "Keep bounded reads", "bbbbbbbbbb", "in_progress");
      expect(first).toBe(`Keep bounded reads · ${HUMAN_REFERENCE_LABELS[family]} aaaaaaaaaa · in progress`);
      expect(second).toContain("bbbbbbbbbb");
      expect(first.replace(/[⛋≡□→]/gu, "")).toContain(`${HUMAN_REFERENCE_LABELS[family].slice(2)} aaaaaaaaaa · in progress`);
      expect(humanReference(family, " ", undefined, undefined)).toBe(`description unavailable · ${HUMAN_REFERENCE_LABELS[family]} ID unavailable · status/confidence unavailable`);
      // Exercise the imported text primitive at its actual rendering boundary.
      const long = humanReference(family, "𐐀".repeat(200), "aaaaaaaaaa", "open");
      const suffix = ` · ${HUMAN_REFERENCE_LABELS[family]} aaaaaaaaaa · open`;
      expect(long).toBe(`${"𐐀".repeat(110 - Array.from(suffix).length - 1)}…${suffix}`);
    }
  });

  it("omits redundant human protocol citations but leaves machine examples and inline selectors exact", () => {
    const machine = "```yaml\nconfidence: DL2\nrelationship: aaaaaaaaaa\n```";
    const rendered = withHumanReferences(`provisional (DL2); severity arrows (VT5-VT8).\n${machine}\nUse \`DL2\` as a selector.\nFinding severity per protocol SF1-SF3; cap to CS4 or below.\n\`\`\`text\nwarning (SF2, confidence 70+); confidence (0-100, protocol: CS1-CS5).\n\`\`\``);
    expect(rendered).toContain("provisional; severity arrows.");
    expect(rendered).toContain(machine);
    expect(rendered).toContain("Use `DL2` as a selector.");
    expect(rendered).toContain("finding severity (critical, warning, info); cap to weak evidence (30-49) or below.");
    expect(rendered).toContain("warning (confidence 70+); confidence (0-100).");
  });
});

function dedent(text: string): string {
  const lines = text.replace(/^\n/, "").split("\n");
  const indents = lines.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(min)).join("\n");
}

function writeCapability(capDir: string, schemaText: string | null, opts: { instructions?: boolean; prose?: boolean } = {}): string {
  const instructions = opts.instructions ?? true;
  const prose = opts.prose ?? false;
  fs.mkdirSync(capDir, { recursive: true });
  if (instructions) {
    // Mirror the production layout inside the isolated source-root override.
    const capabilityName = path.basename(capDir);
    const modulePath = path.join(tmp, "packages", "cli", "src", "capabilities", capabilityName, "instructions.ts");
    fs.mkdirSync(path.dirname(modulePath), { recursive: true });
    fs.writeFileSync(modulePath, '// Fixture for capability validator (D65).\nexport const instructions: string = "# Fixture\\n";\nexport default instructions;\n');
  }
  if (prose) {
    // Legacy compatibility fixture: a prose.md file in the capDir must not
    // satisfy the instruction module requirement; it remains a historical
    // artifact only.
    fs.writeFileSync(path.join(capDir, "prose" + ".md"), "# Legacy fixture\n");
  }
  const schemas = path.join(capDir, "schemas");
  fs.mkdirSync(schemas);
  if (schemaText !== null) {
    fs.writeFileSync(path.join(schemas, "fixture.yaml"), dedent(schemaText));
  }
  return capDir;
}

function validSchema(opts: { triggerPriority?: string; triggerId?: string } = {}): string {
  const triggerPriority = opts.triggerPriority ?? "high";
  const triggerId = opts.triggerId ?? "T1";
  return dedent(`
    TRIGGERS:
      1:
        id: ${triggerId}
        description: Trigger entry.
        priority: ${triggerPriority}
    ARTIFACTS:
      1:
        id: A1
        description: Artifact entry.
    VALIDATION:
      1:
        id: V1
        description: Validation entry.
    EXIT_CONDITIONS:
      1:
        id: E1
        description: Exit entry.
  `);
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vc-"));
  vi.stubEnv(BOOTSTRAP_SOURCE_ROOT_ENV, tmp);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function checkoutSourceInventory() {
  const root = path.join(REPO_ROOT, "packages/cli/src");
  return fs
    .readdirSync(root, { recursive: true })
    .map(String)
    .filter((file) => /\.(?:ts|mjs)$/.test(file))
    .sort()
    .map((file) => ({
      path: file,
      sha256: createHash("sha256")
        .update(fs.readFileSync(path.join(root, file)))
        .digest("hex"),
    }));
}

function writeContract(mutate: (data: any) => void): string {
  const data = structuredClone(YAML.parse(fs.readFileSync(CONTRACT_PATH, "utf8")));
  mutate(data);
  const p = path.join(tmp, "contract.yaml");
  fs.writeFileSync(p, YAML.stringify(data));
  return p;
}

describe("validateCapability", () => {
  it("keeps checkout source unchanged while fixture instruction modules exist", () => {
    const before = checkoutSourceInventory();
    const capDir = writeCapability(path.join(tmp, "source-isolation-proof"), validSchema());
    const modulePath = path.join(tmp, "packages/cli/src/capabilities/source-isolation-proof/instructions.ts");
    expect(fs.statSync(modulePath).isFile()).toBe(true);
    expect(validateCapability(capDir, CONTRACT_PATH)).toEqual([]);
    expect(checkoutSourceInventory()).toEqual(before);
    // The module is still alive: cleanup cannot conceal a checkout write.
    expect(fs.existsSync(modulePath)).toBe(true);
  });

  it.each(["missing", "directory"])("rejects a %s fixture module without falling back to checkout instructions", (kind) => {
    const before = checkoutSourceInventory();
    expect(fs.statSync(path.join(REPO_ROOT, "packages/cli/src/capabilities/status/instructions.ts")).isFile()).toBe(true);
    const capDir = writeCapability(path.join(tmp, "status"), validSchema(), {
      instructions: false,
    });
    if (kind === "directory")
      fs.mkdirSync(path.join(tmp, "packages/cli/src/capabilities/status/instructions.ts"), {
        recursive: true,
      });
    expect(validateCapability(capDir, CONTRACT_PATH)).toEqual([`V1 [error]: packages/cli/src/capabilities/status/instructions.ts not found in ${capDir}`]);
    expect(checkoutSourceInventory()).toEqual(before);
  });

  it("passes a valid fixture", () => {
    const capDir = writeCapability(path.join(tmp, "valid"), validSchema());
    expect(validateCapability(capDir, CONTRACT_PATH)).toEqual([]);
  });

  it("reports both V1 errors for a missing directory", () => {
    const capDir = path.join(tmp, "missing-directory");
    expect(validateCapability(capDir, CONTRACT_PATH)).toEqual([`V1 [error]: packages/cli/src/capabilities/missing-directory/instructions.ts not found in ${capDir}`, `V1 [error]: schemas/ directory not found in ${capDir}`]);
  });

  it("reports V1 + V2 for empty schemas", () => {
    const capDir = writeCapability(path.join(tmp, "empty-schemas"), null);
    expect(validateCapability(capDir, CONTRACT_PATH)).toEqual([
      `V1 [error]: schemas/ contains no .yaml files in ${capDir}`,
      `V2 [error]: required group TRIGGERS missing in ${capDir}`,
      `V2 [error]: required group ARTIFACTS missing in ${capDir}`,
      `V2 [error]: required group VALIDATION missing in ${capDir}`,
      `V2 [error]: required group EXIT_CONDITIONS missing in ${capDir}`,
    ]);
  });

  it("requires instructions.ts when schemas exist", () => {
    const capDir = writeCapability(path.join(tmp, "missing-instructions"), validSchema(), {
      instructions: false,
    });
    expect(validateCapability(capDir, CONTRACT_PATH)).toEqual([`V1 [error]: packages/cli/src/capabilities/missing-instructions/instructions.ts not found in ${capDir}`]);
  });

  it("rejects legacy prose.md without the instructions module", () => {
    const capDir = writeCapability(path.join(tmp, "legacy-prose-only"), validSchema(), {
      instructions: false,
      prose: true,
    });
    expect(fs.existsSync(path.join(capDir, "prose" + ".md"))).toBe(true);
    expect(validateCapability(capDir, CONTRACT_PATH)).toEqual([`V1 [error]: packages/cli/src/capabilities/legacy-prose-only/instructions.ts not found in ${capDir}`]);
  });

  it("reports a missing required group", () => {
    const capDir = writeCapability(
      path.join(tmp, "missing-group"),
      dedent(`
        TRIGGERS:
          1:
            id: T1
            description: Trigger entry.
            priority: high
        ARTIFACTS:
          1:
            id: A1
            description: Artifact entry.
        VALIDATION:
          1:
            id: V1
            description: Validation entry.
      `),
    );
    expect(validateCapability(capDir, CONTRACT_PATH)).toEqual([`V2 [error]: required group EXIT_CONDITIONS missing in ${capDir}`]);
  });

  it("passes when a required group is a non-mapping (treated as empty)", () => {
    const capDir = writeCapability(
      path.join(tmp, "malformed-group"),
      dedent(`
        TRIGGERS:
          - not a mapping
        ARTIFACTS:
          1:
            id: A1
            description: Artifact entry.
        VALIDATION:
          1:
            id: V1
            description: Validation entry.
        EXIT_CONDITIONS:
          1:
            id: E1
            description: Exit entry.
      `),
    );
    expect(validateCapability(capDir, CONTRACT_PATH)).toEqual([]);
  });

  it("flags an invalid trigger priority", () => {
    const capDir = writeCapability(path.join(tmp, "invalid-priority"), validSchema({ triggerPriority: "urgent" }));
    expect(validateCapability(capDir, CONTRACT_PATH)).toEqual([`V5b [error]: TRIGGERS entry 1 in ${capDir} has invalid priority='urgent' (must be one of: high, medium, low)`]);
  });

  it("emits a deprecation warning that does not fail validation", () => {
    const capDir = writeCapability(path.join(tmp, "deprecation-warning"), validSchema().replace("description: Artifact entry.", "description: Artifact entry.\n    deprecated: true\n    replaced_by: A99"));
    const expectedWarning = `V5 [warning]: entry 1 (A1) in ARTIFACTS in ${capDir} ` + "has replaced_by='A99' which does not match any entry ID";
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(validateCapability(capDir, CONTRACT_PATH)).toEqual([]);
      expect(stderrSpy).toHaveBeenCalledOnce();
      expect(stderrSpy).toHaveBeenCalledWith(expectedWarning + "\n");
    } finally {
      stderrSpy.mockRestore();
    }
    const contract = loadCapabilitySchemaContract(CONTRACT_PATH);
    const groups = collectSchemaGroups(path.join(capDir, "schemas"), contract.requiredGroups);
    expect(checkDeprecation(groups, capDir, contract)).toEqual([expectedWarning]);
  });

  it("observes contract-required groups", () => {
    const capDir = writeCapability(path.join(tmp, "valid"), validSchema());
    const contract = writeContract((data) => {
      data.REQUIRED_GROUPS.push("EXTRA_GROUP");
      data.GROUP_PREFIXES.EXTRA_GROUP = "X";
      data.ENTRY_REQUIREMENTS.groups.EXTRA_GROUP = { required_fields: ["id", "description"] };
      data.EXTRA_GROUP = {};
    });
    expect(validateCapability(capDir, contract)).toEqual([`V2 [error]: required group EXTRA_GROUP missing in ${capDir}`]);
  });

  it("observes contract-required fields", () => {
    const capDir = writeCapability(path.join(tmp, "valid"), validSchema());
    const contract = writeContract((data) => {
      data.ENTRY_REQUIREMENTS.groups.ARTIFACTS.required_fields.push("name");
    });
    expect(validateCapability(capDir, contract)).toEqual([`V4 [error]: entry 1 in ARTIFACTS in ${capDir} missing 'name'`]);
  });

  it("observes the contract priority enum", () => {
    const capDir = writeCapability(path.join(tmp, "valid"), validSchema({ triggerPriority: "urgent" }));
    const contract = writeContract((data) => {
      data.FIELD_RULES.TRIGGERS.priority.allowed_values = ["urgent"];
    });
    expect(validateCapability(capDir, contract)).toEqual([]);
  });

  it("observes the contract directory yaml minimum", () => {
    const capDir = writeCapability(path.join(tmp, "valid"), validSchema());
    const contract = writeContract((data) => {
      data.DIRECTORY_REQUIREMENTS.schema_files.minimum_count = 2;
    });
    expect(validateCapability(capDir, contract)).toEqual([`V1 [error]: schemas/ contains no .yaml files in ${capDir}`]);
  });

  it("declares group prefixes without enforcing them", () => {
    const capDir = writeCapability(path.join(tmp, "wrong-prefix"), validSchema({ triggerId: "WRONG1" }));
    expect(validateCapability(capDir, CONTRACT_PATH)).toEqual([]);
  });
});

describe("trigger enrichment (V7)", () => {
  // Each `extra` block is a sibling-yielded YAML fragment at the trigger-entry
  // level (col-0 aligned by the caller). The helper prefixes every line with
  // 4 spaces so the fragment nests correctly under entry 1 (which sits at
  // col 4).
  function triggerSchema(extra: string): string {
    const indented = extra
      .split("\n")
      .map((l) => "    " + l)
      .join("\n");
    return [
      "TRIGGERS:",
      "  1:",
      "    id: T1",
      "    description: Trigger entry.",
      "    priority: high",
      indented,
      "ARTIFACTS:",
      "  1:",
      "    id: A1",
      "    description: Artifact entry.",
      "VALIDATION:",
      "  1:",
      "    id: V1",
      "    description: Validation entry.",
      "EXIT_CONDITIONS:",
      "  1:",
      "    id: E1",
      "    description: Exit entry.",
    ].join("\n");
  }

  it("accepts a triggers.yaml that omits all enriched fields (backward compatibility)", () => {
    const capDir = writeCapability(path.join(tmp, "bare"), validSchema());
    expect(validateCapability(capDir, CONTRACT_PATH)).toEqual([]);
  });

  it("accepts fully populated legacy compatibility fields and semantic disambiguation", () => {
    const capDir = writeCapability(
      path.join(tmp, "enriched"),
      triggerSchema(`patterns:
  - "refine the vision"
confidence_threshold: 55
borderline_band: 10
patterns_regex:
  - "\\\\brefine\\\\s+the\\\\s+vision\\\\b"
disambiguates_against:
  - capability: build
    hint: "vision refines existing project direction; build implements code"
  - capability: optimize
    hint: "vision is about what to build, not tuning existing code"`),
    );
    expect(validateCapability(capDir, CONTRACT_PATH)).toEqual([]);
  });

  it("fails when legacy patterns is not a list of strings", () => {
    const capDir = writeCapability(path.join(tmp, "patterns-invalid"), triggerSchema("patterns: 42"));
    expect(validateCapability(capDir, CONTRACT_PATH)).toEqual([`V7 [error]: TRIGGERS entry 1 (T1) in ${capDir} has patterns=42 (must be a list of strings)`]);
  });

  it("fails when confidence_threshold is above 100 with the valid range and offending entry ID", () => {
    const capDir = writeCapability(path.join(tmp, "ct-high"), triggerSchema("confidence_threshold: 150"));
    expect(validateCapability(capDir, CONTRACT_PATH)).toEqual([`V7 [error]: TRIGGERS entry 1 (T1) in ${capDir} has confidence_threshold=150 (must be an integer in range 0..100)`]);
  });

  it("fails when confidence_threshold is below 0", () => {
    const capDir = writeCapability(path.join(tmp, "ct-low"), triggerSchema("confidence_threshold: -5"));
    expect(validateCapability(capDir, CONTRACT_PATH)).toEqual([`V7 [error]: TRIGGERS entry 1 (T1) in ${capDir} has confidence_threshold=-5 (must be an integer in range 0..100)`]);
  });

  it("fails when confidence_threshold is a non-integer", () => {
    const capDir = writeCapability(path.join(tmp, "ct-float"), triggerSchema("confidence_threshold: 12.5"));
    expect(validateCapability(capDir, CONTRACT_PATH)).toEqual([`V7 [error]: TRIGGERS entry 1 (T1) in ${capDir} has confidence_threshold=12.5 (must be an integer in range 0..100)`]);
  });

  it("fails when disambiguates_against.capability references a non-existent capability", () => {
    const capDir = writeCapability(
      path.join(tmp, "da-bad-cap"),
      triggerSchema(`disambiguates_against:
  - capability: nonexistent_capability
    hint: "distinguishes from undefined"`),
    );
    const allowed = "status, vision, discuss, research, plan, build, optimize, audit, document, profile, design, orchestrate";
    expect(validateCapability(capDir, CONTRACT_PATH)).toEqual([`V7 [error]: TRIGGERS entry 1 (T1) in ${capDir} disambiguates_against[0].capability='nonexistent_capability' is not a canonical capability ID (must be one of: ${allowed})`]);
  });

  it("fails when disambiguates_against entry is missing the hint", () => {
    const capDir = writeCapability(
      path.join(tmp, "da-no-hint"),
      triggerSchema(`disambiguates_against:
  - capability: build`),
    );
    expect(validateCapability(capDir, CONTRACT_PATH)).toEqual([`V7 [error]: TRIGGERS entry 1 (T1) in ${capDir} disambiguates_against[0] missing or empty 'hint' (must be a non-empty string distinguishing this trigger from the named capability)`]);
  });

  it("fails when disambiguates_against hint is empty whitespace", () => {
    const capDir = writeCapability(
      path.join(tmp, "da-blank-hint"),
      triggerSchema(`disambiguates_against:
  - capability: build
    hint: "   "`),
    );
    expect(validateCapability(capDir, CONTRACT_PATH)).toEqual([`V7 [error]: TRIGGERS entry 1 (T1) in ${capDir} disambiguates_against[0] missing or empty 'hint' (must be a non-empty string distinguishing this trigger from the named capability)`]);
  });

  it("fails when disambiguates_against is not a list", () => {
    const capDir = writeCapability(path.join(tmp, "da-string"), triggerSchema('disambiguates_against: "build"'));
    expect(validateCapability(capDir, CONTRACT_PATH)).toEqual([`V7 [error]: TRIGGERS entry 1 (T1) in ${capDir} has disambiguates_against='build' (must be a list of mappings each with 'capability' and 'hint')`]);
  });

  it("fails when patterns_regex contains an invalid regex", () => {
    const capDir = writeCapability(
      path.join(tmp, "pr-bad-regex"),
      triggerSchema(`patterns_regex:
  - "[unclosed"`),
    );
    expect(validateCapability(capDir, CONTRACT_PATH)).toEqual([`V7 [error]: TRIGGERS entry 1 (T1) in ${capDir} patterns_regex[0]='[unclosed' is not a valid regular expression`]);
  });

  it("fails when borderline_band is out of range", () => {
    const capDir = writeCapability(path.join(tmp, "bb-high"), triggerSchema("borderline_band: 150"));
    expect(validateCapability(capDir, CONTRACT_PATH)).toEqual([`V7 [error]: TRIGGERS entry 1 (T1) in ${capDir} has borderline_band=150 (must be an integer in range 0..100)`]);
  });

  it("validates the contract file against its own enrichment rules", () => {
    const contract = loadCapabilitySchemaContract(CONTRACT_PATH);
    const groups = { TRIGGERS: { 1: { id: "T1", description: "x", priority: "high" } } };
    expect(checkTriggerEnrichment(groups, "self", contract)).toEqual([]);
  });
});

describe("primitive references", () => {
  it("splits ownership between contract field mapping and protocol values", () => {
    const capDir = writeCapability(path.join(tmp, "primitive-reference"), validSchema().replace("description: Validation entry.", "description: Validation entry.\n    severity: experimental"));
    const protocol = structuredClone(YAML.parse(fs.readFileSync(PROTOCOL_PATH, "utf8")));
    protocol.SEVERITY_FINDING[99] = {
      id: "SF99",
      value: "experimental",
      meaning: "Fixture-only value proving protocol.yaml owns primitive values.",
    };
    const protocolPath = path.join(tmp, "protocol.yaml");
    fs.writeFileSync(protocolPath, YAML.stringify(protocol));

    expect(checkPrimitiveReferences(capDir, protocolPath, CONTRACT_PATH)).toEqual([]);
    const contract = loadCapabilitySchemaContract(CONTRACT_PATH);
    expect(contract.primitiveReferences.fields.severity).toEqual(["SEVERITY_FINDING", "SEVERITY_ISSUE"]);
    expect(buildProtocolValueLookup(protocol).SEVERITY_FINDING.has("experimental")).toBe(true);
  });

  it("takes the field mapping from the contract fixture", () => {
    const capDir = writeCapability(path.join(tmp, "primitive-contract-mapping"), validSchema().replace("description: Validation entry.", "description: Validation entry.\n    severity: complete"));
    const contractPath = writeContract((data) => {
      data.PRIMITIVE_REFERENCE_FIELDS.fields.severity.protocol_groups = ["EXIT_SIGNALS"];
    });
    expect(checkPrimitiveReferences(capDir, PROTOCOL_PATH, contractPath)).toEqual([]);
  });
});
