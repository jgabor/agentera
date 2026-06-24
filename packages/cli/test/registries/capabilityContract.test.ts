import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ContractBootstrapError,
  loadCapabilitySchemaContract,
  validateContractBootstrap,
} from "../../src/registries/capabilityContract.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const CONTRACT_PATH = path.join(REPO_ROOT, "skills", "agentera", "capability_schema_contract.yaml");
const LEGACY_INSTRUCTION_FILE = "prose" + ".md";

function validContractData(): any {
  return YAML.parse(fs.readFileSync(CONTRACT_PATH, "utf8"));
}

function bootstrapErrors(data: any): string[] {
  return validateContractBootstrap(data, "fixture.yaml");
}

function assertHasErrorContaining(errors: string[], message: string): void {
  expect(errors.some((e) => e.includes(message)), JSON.stringify(errors)).toBe(true);
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeContract(data: any): string {
  const p = path.join(tmp, "contract.yaml");
  fs.writeFileSync(p, YAML.stringify(data));
  return p;
}

describe("capability schema contract loader", () => {
  it("builds a single model for capability rules from the valid contract", () => {
    const contractData = validContractData();
    const model = loadCapabilitySchemaContract(CONTRACT_PATH);

    expect(model.directoryRules.instructionPath).toBe(
      contractData.DIRECTORY_REQUIREMENTS.instruction_module.path,
    );
    expect(model.directoryRules.instructionModulePath).toBe(
      contractData.DIRECTORY_REQUIREMENTS.instruction_module.path,
    );
    expect("required_files" in contractData.DIRECTORY_REQUIREMENTS).toBe(false);
    expect(model.requiredGroups).toEqual(["TRIGGERS", "ARTIFACTS", "VALIDATION", "EXIT_CONDITIONS"]);
    expect(model.directoryRules.instructionPath).toBe("packages/cli/src/capabilities/<name>/instructions.ts");
    expect(model.directoryRules.instructionModulePath).toBe("packages/cli/src/capabilities/<name>/instructions.ts");
    expect(model.directoryRules.schemasPath).toBe("schemas");
    expect(model.directoryRules.schemaGlob).toBe("*.yaml");
    expect(model.directoryRules.minimumSchemaFiles).toBe(1);
    expect(model.entryRules.defaultRequiredFields).toEqual(["id", "description"]);
    expect(model.entryRules.requiredFieldsByGroup.TRIGGERS).toEqual(["id", "description", "priority"]);
    expect(model.triggerPriorityRules.required).toBe(true);
    expect(model.triggerPriorityRules.allowedValues).toEqual(["high", "medium", "low"]);
    expect(model.deprecationRules.marker_field).toBe("deprecated");
    expect(model.deprecationRules.replacement_field).toBe("replaced_by");
    expect(model.groupPrefixes).toEqual({
      TRIGGERS: "T",
      ARTIFACTS: "A",
      VALIDATION: "V",
      EXIT_CONDITIONS: "E",
    });
    expect(model.primitiveReferences.protocolValuesAuthority).toBe("protocol.yaml");
    expect(model.primitiveReferences.fields).toEqual({
      severity: ["SEVERITY_FINDING", "SEVERITY_ISSUE"],
      finding_severity: ["SEVERITY_FINDING"],
      issue_severity: ["SEVERITY_ISSUE"],
      decision_label: ["DECISION_LABELS"],
      exit_signal: ["EXIT_SIGNALS"],
      phase: ["PHASES"],
    });
    expect(model.routeAliases.routePrefix).toBe("/agentera");
    expect(model.routeAliases.canonicalNamePrecedence).toBe(true);
    expect(model.routeAliases.cliBoundary).toContain("`/agentera plan` routes to the plan capability");
    const aliasMap = Object.fromEntries(
      model.routeAliases.primaryAliases.map((r) => [r.alias, r.capability]),
    );
    expect(aliasMap).toEqual({
      status: "status",
      vision: "vision",
      discuss: "discuss",
      research: "research",
      plan: "plan",
      build: "build",
      optimize: "optimize",
      audit: "audit",
      document: "document",
      profile: "profile",
      design: "design",
      orchestrate: "orchestrate",
    });
  });

  const malformed: Array<[(data: any) => void, string]> = [
    [(data) => delete data.REQUIRED_GROUPS, "REQUIRED_GROUPS in fixture.yaml must be a non-empty list of strings"],
    [(data) => delete data.ENTRY_SCHEMA.fields, "ENTRY_SCHEMA.fields in fixture.yaml must be a mapping"],
    [(data) => delete data.GROUP_PREFIXES.VALIDATION, "GROUP_PREFIXES.VALIDATION in fixture.yaml must be a non-empty string"],
    [(data) => delete data.ENTRY_REQUIREMENTS, "ENTRY_REQUIREMENTS in fixture.yaml must be present as a mapping"],
    [(data) => delete data.EXIT_CONDITIONS, "self group EXIT_CONDITIONS missing in fixture.yaml"],
  ];
  it.each(malformed)("rejects malformed contract fixtures", (mutate, message) => {
    const data = structuredClone(validContractData());
    mutate(data);
    assertHasErrorContaining(bootstrapErrors(data), message);
  });

  it("rejects a legacy prose.md instruction module path", () => {
    const data = structuredClone(validContractData());
    data.DIRECTORY_REQUIREMENTS.instruction_module.path = LEGACY_INSTRUCTION_FILE;
    const p = writeContract(data);
    try {
      loadCapabilitySchemaContract(p);
      throw new Error("expected ContractBootstrapError");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractBootstrapError);
      expect((err as ContractBootstrapError).errors).toEqual([
        `bootstrap [error]: DIRECTORY_REQUIREMENTS.instruction_module.path in ${p} must be packages/cli/src/capabilities/<name>/instructions.ts`,
      ]);
    }
  });

  it("rejects required_files as duplicate directory authority", () => {
    const data = structuredClone(validContractData());
    data.DIRECTORY_REQUIREMENTS.required_files = [
      { path: LEGACY_INSTRUCTION_FILE, description: "Legacy duplicate authority." },
    ];
    const p = writeContract(data);
    try {
      loadCapabilitySchemaContract(p);
      throw new Error("expected ContractBootstrapError");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractBootstrapError);
      expect((err as ContractBootstrapError).errors).toEqual([
        `bootstrap [error]: DIRECTORY_REQUIREMENTS.required_files in ${p} duplicates instruction_module and schemas_directory authority`,
      ]);
    }
  });

  const ruleFamily: Array<[(data: any) => void, string]> = [
    [
      (data) => (data.DIRECTORY_REQUIREMENTS.schema_files.minimum_count = 0),
      "DIRECTORY_REQUIREMENTS.schema_files.minimum_count in fixture.yaml must be a positive integer",
    ],
    [
      (data) => (data.ENTRY_REQUIREMENTS.deprecation = []),
      "ENTRY_REQUIREMENTS.deprecation in fixture.yaml must be a mapping",
    ],
    [
      (data) => (data.FIELD_RULES.TRIGGERS.priority.allowed_values = []),
      "FIELD_RULES.TRIGGERS.priority.allowed_values in fixture.yaml must be a non-empty list of strings",
    ],
    [
      (data) => (data.PRIMITIVE_REFERENCE_FIELDS.fields.severity.protocol_groups = []),
      "PRIMITIVE_REFERENCE_FIELDS.fields.severity.protocol_groups in fixture.yaml must be a non-empty list of strings",
    ],
    [
      (data) => data.ROUTE_ALIASES.primary_aliases.push({ alias: "status", capability: "duplicate" }),
      "ROUTE_ALIASES.primary_aliases alias 'status' in fixture.yaml must be unique",
    ],
    [
      (data) => data.ROUTE_ALIASES.primary_aliases.push({ alias: "duplicate", capability: "status" }),
      "ROUTE_ALIASES.primary_aliases capability 'status' in fixture.yaml must be unique",
    ],
  ];
  it.each(ruleFamily)("each rule family has a focused failing fixture", (mutate, message) => {
    const data = structuredClone(validContractData());
    mutate(data);
    assertHasErrorContaining(bootstrapErrors(data), message);
  });

  it("raises a deterministic error for malformed contracts", () => {
    const data = structuredClone(validContractData());
    data.GROUP_PREFIXES.TRIGGERS = "";
    const p = writeContract(data);
    try {
      loadCapabilitySchemaContract(p);
      throw new Error("expected ContractBootstrapError");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractBootstrapError);
      expect((err as ContractBootstrapError).errors).toEqual([
        `bootstrap [error]: GROUP_PREFIXES.TRIGGERS in ${p} must be a non-empty string`,
      ]);
    }
  });

  it("keeps protocol primitives outside the capability contract model", () => {
    const model = loadCapabilitySchemaContract(CONTRACT_PATH);
    expect("protocolGroups" in model).toBe(false);
    expect("protocolValues" in model).toBe(false);
    expect(model.primitiveReferences.fields.severity).toEqual(["SEVERITY_FINDING", "SEVERITY_ISSUE"]);
  });
});
