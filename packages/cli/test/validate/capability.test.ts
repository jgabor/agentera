import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildProtocolValueLookup,
  checkDeprecation,
  checkPrimitiveReferences,
  collectSchemaGroups,
  loadCapabilitySchemaContract,
  validateCapability,
} from "../../src/validate/capability.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const CONTRACT_PATH = path.join(REPO_ROOT, "skills", "agentera", "capability_schema_contract.yaml");
const PROTOCOL_PATH = path.join(REPO_ROOT, "skills", "agentera", "protocol.yaml");

function dedent(text: string): string {
  const lines = text.replace(/^\n/, "").split("\n");
  const indents = lines.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(min)).join("\n");
}

function writeCapability(
  capDir: string,
  schemaText: string | null,
  opts: { instructions?: boolean; prose?: boolean } = {},
): string {
  const instructions = opts.instructions ?? true;
  const prose = opts.prose ?? false;
  fs.mkdirSync(capDir, { recursive: true });
  if (instructions) {
    // D65: the per-capability prose is a TypeScript module at
    // packages/cli/src/capabilities/<name>/instructions.ts. The validator
    // resolves that path against the repo root using the capability name
    // derived from the capDir, so the test fixture must mirror the new
    // shape: write a minimal instructions.ts that exports the prose.
    const capabilityName = path.basename(capDir);
    const modulePath = path.join(REPO_ROOT, "packages", "cli", "src", "capabilities", capabilityName, "instructions.ts");
    fs.mkdirSync(path.dirname(modulePath), { recursive: true });
    fs.writeFileSync(
      modulePath,
      '// Fixture for capability validator (D65).\nexport const instructions: string = "# Fixture\\n";\nexport default instructions;\n',
    );
    fixtureModules.push(modulePath);
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
let fixtureModules: string[];
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vc-"));
  fixtureModules = [];
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const modulePath of fixtureModules) {
    fs.rmSync(modulePath, { force: true });
  }
});

function writeContract(mutate: (data: any) => void): string {
  const data = structuredClone(YAML.parse(fs.readFileSync(CONTRACT_PATH, "utf8")));
  mutate(data);
  const p = path.join(tmp, "contract.yaml");
  fs.writeFileSync(p, YAML.stringify(data));
  return p;
}

describe("validateCapability", () => {
  it("passes a valid fixture", () => {
    const capDir = writeCapability(path.join(tmp, "valid"), validSchema());
    expect(validateCapability(capDir, CONTRACT_PATH)).toEqual([]);
  });

  it("reports both V1 errors for a missing directory", () => {
    const capDir = path.join(tmp, "missing-directory");
    expect(validateCapability(capDir, CONTRACT_PATH)).toEqual([
      `V1 [error]: packages/cli/src/capabilities/missing-directory/instructions.ts not found in ${capDir}`,
      `V1 [error]: schemas/ directory not found in ${capDir}`,
    ]);
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
    expect(validateCapability(capDir, CONTRACT_PATH)).toEqual([
      `V1 [error]: packages/cli/src/capabilities/missing-instructions/instructions.ts not found in ${capDir}`,
    ]);
  });

  it("rejects legacy prose.md without the instructions module", () => {
    const capDir = writeCapability(path.join(tmp, "legacy-prose-only"), validSchema(), {
      instructions: false,
      prose: true,
    });
    expect(fs.existsSync(path.join(capDir, "prose" + ".md"))).toBe(true);
    expect(validateCapability(capDir, CONTRACT_PATH)).toEqual([
      `V1 [error]: packages/cli/src/capabilities/legacy-prose-only/instructions.ts not found in ${capDir}`,
    ]);
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
    expect(validateCapability(capDir, CONTRACT_PATH)).toEqual([
      `V2 [error]: required group EXIT_CONDITIONS missing in ${capDir}`,
    ]);
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
    expect(validateCapability(capDir, CONTRACT_PATH)).toEqual([
      `V5b [error]: TRIGGERS entry 1 in ${capDir} has invalid priority='urgent' (must be one of: high, medium, low)`,
    ]);
  });

  it("emits a deprecation warning that does not fail validation", () => {
    const capDir = writeCapability(
      path.join(tmp, "deprecation-warning"),
      validSchema().replace(
        "description: Artifact entry.",
        "description: Artifact entry.\n    deprecated: true\n    replaced_by: A99",
      ),
    );
    expect(validateCapability(capDir, CONTRACT_PATH)).toEqual([]);
    const contract = loadCapabilitySchemaContract(CONTRACT_PATH);
    const groups = collectSchemaGroups(path.join(capDir, "schemas"), contract.requiredGroups);
    expect(checkDeprecation(groups, capDir, contract)).toEqual([
      `V5 [warning]: entry 1 (A1) in ARTIFACTS in ${capDir} has replaced_by='A99' which does not match any entry ID`,
    ]);
  });

  it("observes contract-required groups", () => {
    const capDir = writeCapability(path.join(tmp, "valid"), validSchema());
    const contract = writeContract((data) => {
      data.REQUIRED_GROUPS.push("EXTRA_GROUP");
      data.GROUP_PREFIXES.EXTRA_GROUP = "X";
      data.ENTRY_REQUIREMENTS.groups.EXTRA_GROUP = { required_fields: ["id", "description"] };
      data.EXTRA_GROUP = {};
    });
    expect(validateCapability(capDir, contract)).toEqual([
      `V2 [error]: required group EXTRA_GROUP missing in ${capDir}`,
    ]);
  });

  it("observes contract-required fields", () => {
    const capDir = writeCapability(path.join(tmp, "valid"), validSchema());
    const contract = writeContract((data) => {
      data.ENTRY_REQUIREMENTS.groups.ARTIFACTS.required_fields.push("name");
    });
    expect(validateCapability(capDir, contract)).toEqual([
      `V4 [error]: entry 1 in ARTIFACTS in ${capDir} missing 'name'`,
    ]);
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
    expect(validateCapability(capDir, contract)).toEqual([
      `V1 [error]: schemas/ contains no .yaml files in ${capDir}`,
    ]);
  });

  it("declares group prefixes without enforcing them", () => {
    const capDir = writeCapability(path.join(tmp, "wrong-prefix"), validSchema({ triggerId: "WRONG1" }));
    expect(validateCapability(capDir, CONTRACT_PATH)).toEqual([]);
  });
});

describe("primitive references", () => {
  it("splits ownership between contract field mapping and protocol values", () => {
    const capDir = writeCapability(
      path.join(tmp, "primitive-reference"),
      validSchema().replace(
        "description: Validation entry.",
        "description: Validation entry.\n    severity: experimental",
      ),
    );
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
    const capDir = writeCapability(
      path.join(tmp, "primitive-contract-mapping"),
      validSchema().replace(
        "description: Validation entry.",
        "description: Validation entry.\n    severity: complete",
      ),
    );
    const contractPath = writeContract((data) => {
      data.PRIMITIVE_REFERENCE_FIELDS.fields.severity.protocol_groups = ["EXIT_SIGNALS"];
    });
    expect(checkPrimitiveReferences(capDir, PROTOCOL_PATH, contractPath)).toEqual([]);
  });
});
