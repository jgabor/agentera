import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { cmdPrime } from "../../src/cli/commands/prime.js";
import { cmdQuery } from "../../src/cli/commands/query.js";
import { cmdState } from "../../src/cli/commands/state/index.js";
import { main } from "../../src/cli/dispatch.js";

const SOURCE_CONTRACT_ORACLE_PATH = path.join(
  __dirname,
  "fixtures",
  "oracle",
  "source-contract.json",
);

type ValueType = "string" | "number" | "boolean" | "array" | "object" | "null";
type FieldTypeMap = Record<string, ValueType | "string|null" | "array<string>" | "array<object>">;

interface PrimeCommandSpec {
  argv: string[];
  exitCode: number;
  sourceContractLocation: string;
  description: string;
  requiredTopLevelKeys: string[];
  fieldsValueType: "array<string>";
  renderValueType: "string";
  renderSubstring: string;
  accessValueType: "string";
  accessSubstring: string;
  emptyStateValueType: "string";
  capabilityStartupValueType: "object";
  capabilityContextValue: null;
  capabilityStartupRequiredKeys: string[];
  capabilityStartupFieldTypes: FieldTypeMap;
  rawArtifactReadsRequiredDefault: false;
  completeForCapabilityStartupPinned: false;
}

interface PrimeContextCommandSpec {
  argv: string[];
  exitCode: number;
  description: string;
  topLevelSourceContract: {
    description: string;
    shape: "empty_object";
    valueType: "object";
    keyCount: 0;
  };
  perCapabilitySourceContract: {
    description: string;
    sourceContractLocation: string;
    sharedRequiredKeys: string[];
    sharedFieldTypes: FieldTypeMap;
    completenessKeyByCapability: Record<string, string>;
    completenessKeyType: "boolean";
    caveatedKeyPresent: { present: string[]; absent: string[] };
    caveatedKeyType: "boolean";
    rawArtifactReadsRequiredDefault: false;
    contextSpecificListFieldsByCapability: Record<string, FieldTypeMap>;
  };
}

interface StatePlanCommandSpec {
  argv: string[];
  exitCode: number;
  sourceContractLocation: string;
  description: string;
  requiredTopLevelKeys: string[];
  artifactValue: string;
  canonicalArtifactLabelValue: string;
  fieldTypes: FieldTypeMap;
  completeStateRequiredKeys: string[];
  completeStateFieldTypes: FieldTypeMap;
  rawArtifactAccessBoundaryRequiredKeys: string[];
  rawArtifactAccessBoundaryFieldTypes: FieldTypeMap;
  rawArtifactReadsRequiredDefault: false;
}

interface StateTodoCommandSpec {
  argv: string[];
  exitCode: number;
  sourceContractEmitted: false;
  description: string;
  requiredTopLevelKeys: string[];
}

interface StateQueryListArtifactsCommandSpec {
  argv: string[];
  exitCode: number;
  sourceContractLocation: string;
  description: string;
  requiredTopLevelKeys: string[];
  fieldTypes: FieldTypeMap;
  rawArtifactReadsRequiredForDiscoveryDefault: false;
  allowedRawArtifactUsesCardinalityAtLeast: number;
}

interface SourceContractOracle {
  schemaVersion: "agentera.sourceContractOracle.v1";
  format: "json";
  sharedSourceContractPattern: {
    description: string;
    topLevelType: "object";
    requiredShapeKeys: {
      rawArtifactReadsRequiredField: { type: "boolean"; namesByCommand: Record<string, string> };
      rawArtifactPolicyField: { type: "string"; namesByCommand: Record<string, string> };
      caveatsOrFallbackField: { type: "array<string>"; namesByCommand: Record<string, string> };
    };
  };
  commands: {
    prime: PrimeCommandSpec;
    prime_context: PrimeContextCommandSpec;
    state_plan: StatePlanCommandSpec;
    state_todo: StateTodoCommandSpec;
    state_query_list_artifacts: StateQueryListArtifactsCommandSpec;
  };
  relatedOracles: {
    invalidInputEnvelope: string;
    validateFamily: string;
    verifyEvalFamily: string;
    npmCliSurface: string;
  };
  fieldNameReconciliation: {
    description: string;
    todoEnumeration: string[];
    liveKeys: string[];
    reconciledKeys: string[];
  };
}

const SOURCE_CONTRACT_ORACLE = JSON.parse(
  fs.readFileSync(SOURCE_CONTRACT_ORACLE_PATH, "utf8"),
) as SourceContractOracle;

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

function capture(
  fn: (io: { out: (t: string) => void; err: (t: string) => void }) => number,
): { rc: number; out: string; err: string } {
  let out = "";
  let err = "";
  const rc = fn({ out: (t) => (out += t), err: (t) => (err += t) });
  return { rc, out, err };
}

function readJson(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

function typeOf(v: unknown): ValueType {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v as ValueType;
}

function typeMatches(actual: unknown, expected: FieldTypeMap[string]): boolean {
  if (expected === "string|null") return actual === null || typeof actual === "string";
  if (expected === "array<string>") return Array.isArray(actual) && actual.every((x) => typeof x === "string");
  if (expected === "array<object>") return Array.isArray(actual) && actual.every((x) => x !== null && typeof x === "object");
  if (expected === "array") return Array.isArray(actual);
  if (expected === "object") return actual !== null && typeof actual === "object" && !Array.isArray(actual);
  return typeOf(actual) === expected;
}

function assertRequiredKeys(
  payload: Record<string, unknown>,
  required: string[],
  family: string,
  oraclePath: string,
): void {
  for (const key of required) {
    if (!(key in payload)) {
      throw new Error(
        `oracle contract drift on command '${family}': required key '${key}' is missing from the live source_contract. Update ${oraclePath} with an intentional key addition or revert the field change.`,
      );
    }
    expect(payload, `command '${family}'`).toHaveProperty(key);
  }
}

function assertValueTypes(
  payload: Record<string, unknown>,
  expected: FieldTypeMap,
  family: string,
  oraclePath: string,
): void {
  for (const [key, type] of Object.entries(expected)) {
    if (!(key in payload)) continue;
    const v = payload[key];
    if (!typeMatches(v, type)) {
      const actual = typeOf(v);
      throw new Error(
        `oracle contract drift on command '${family}': key '${key}' expected type '${type}' but live source_contract has '${actual}'. Update ${oraclePath} with an intentional type change or revert the field.`,
      );
    }
  }
}

function assertExactKeys(
  payload: Record<string, unknown>,
  required: string[],
  family: string,
  oraclePath: string,
): void {
  const expected = new Set<string>(required);
  const actual = new Set(Object.keys(payload));
  const missing: string[] = [...expected].filter((k) => !actual.has(k)).sort();
  const extra: string[] = [...actual].filter((k) => !expected.has(k)).sort();
  if (missing.length > 0 || extra.length > 0) {
    const lines: string[] = [
      `oracle contract drift on command '${family}': key set does not match the frozen contract.`,
    ];
    if (missing.length > 0) {
      lines.push(
        `  missing keys: [${missing.join(", ")}] (the oracle requires these but the live source_contract does not emit them — likely a regression).`,
      );
    }
    if (extra.length > 0) {
      lines.push(
        `  extra keys: [${extra.join(", ")}] (the live source_contract emits these but the oracle does not declare them — update ${oraclePath} with an intentional key addition or revert the field).`,
      );
    }
    throw new Error(lines.join("\n"));
  }
}

function runDispatch(argv: string[]): { rc: number; payload: Record<string, unknown> } {
  const { rc, out } = capture((io) => main(["node", "agentera", ...argv], io));
  return { rc, payload: readJson(out) };
}

describe("source_contract oracle (parity)", () => {
  it("declares the five source_contract emissions in the oracle", () => {
    // The five pinned emissions must stay in lockstep with the CLI surface
    // inventory: prime, prime --context, state plan, state todo (no source_contract),
    // state query --list-artifacts.
    expect(new Set(Object.keys(SOURCE_CONTRACT_ORACLE.commands))).toEqual(
      new Set(["prime", "prime_context", "state_plan", "state_todo", "state_query_list_artifacts"]),
    );
  });

  it("schemaVersion is pinned to the source-contract oracle version", () => {
    expect(SOURCE_CONTRACT_ORACLE.schemaVersion).toBe("agentera.sourceContractOracle.v1");
    expect(SOURCE_CONTRACT_ORACLE.format).toBe("json");
  });

  it("cites the existing oracle family without duplicating content", () => {
    expect(SOURCE_CONTRACT_ORACLE.relatedOracles.invalidInputEnvelope).toBe(
      "packages/cli/test/cli/fixtures/oracle/invalid-input-envelope.json",
    );
    expect(SOURCE_CONTRACT_ORACLE.relatedOracles.validateFamily).toBe(
      "packages/cli/test/cli/fixtures/oracle/validate-family.json",
    );
    expect(SOURCE_CONTRACT_ORACLE.relatedOracles.verifyEvalFamily).toBe(
      "packages/cli/test/cli/fixtures/oracle/verify-eval-family.json",
    );
    expect(SOURCE_CONTRACT_ORACLE.relatedOracles.npmCliSurface).toBe(
      "packages/cli/test/cli/fixtures/oracle/npm-cli-surface.json",
    );
  });

  it("reconciles the TODO.md field names against the live prime keys (AC1)", () => {
    // The TODO enumeration said `complete_for_capability_startup`, `missing`,
    // `cli_fallback`, `raw_artifact_reads_required`, `confidence_caveats`.
    // The live prime keys are `complete_for_capability_startup`, `missing_state`,
    // `cli_fallback`, `raw_artifact_reads_required`, `confidence_caveats`.
    // The oracle pins the LIVE keys per AC1 and AC2.
    const reconciled = SOURCE_CONTRACT_ORACLE.fieldNameReconciliation;
    expect(reconciled.todoEnumeration).toEqual([
      "complete_for_capability_startup",
      "missing",
      "cli_fallback",
      "raw_artifact_reads_required",
      "confidence_caveats",
    ]);
    expect(reconciled.liveKeys).toEqual([
      "complete_for_capability_startup",
      "missing_state",
      "cli_fallback",
      "raw_artifact_reads_required",
      "confidence_caveats",
    ]);
    expect(reconciled.reconciledKeys).toEqual([
      "complete_for_capability_startup",
      "missing_state",
      "cli_fallback",
      "raw_artifact_reads_required",
      "confidence_caveats",
    ]);
  });
});

describe("prime source_contract (oracle parity)", () => {
  function capturePrime(): { rc: number; payload: Record<string, unknown> } {
    const { rc, out } = capture((io) => cmdPrime({ format: "json" }, io));
    return { rc, payload: readJson(out) };
  }

  it("prime top-level source_contract matches the oracle", () => {
    const spec = SOURCE_CONTRACT_ORACLE.commands.prime;
    const { rc, payload } = capturePrime();
    expect(rc, "prime rc").toBe(spec.exitCode);
    const sc = payload.source_contract as Record<string, unknown>;
    expect(sc, "prime emits payload.source_contract").toBeDefined();
    expect(typeof sc, "prime source_contract is an object").toBe("object");
    assertRequiredKeys(sc, spec.requiredTopLevelKeys, "prime", "source-contract.json");
    assertExactKeys(sc, spec.requiredTopLevelKeys, "prime", "source-contract.json");
    assertValueTypes(sc, spec.fieldTypes as FieldTypeMap, "prime", "source-contract.json");
  });

  it("prime render/access pin the README-style dashboard and single-call access", () => {
    const spec = SOURCE_CONTRACT_ORACLE.commands.prime;
    const { payload } = capturePrime();
    const sc = payload.source_contract as Record<string, unknown>;
    expect(typeof sc.render, "render is a string").toBe("string");
    expect((sc.render as string).includes(spec.renderSubstring), "render substring pinned").toBe(true);
    expect(typeof sc.access, "access is a string").toBe("string");
    expect((sc.access as string).includes(spec.accessSubstring), "access substring pinned").toBe(true);
    expect(sc.empty_state, "empty_state is a string").toEqual(expect.any(String));
    expect(sc.capability_context, "capability_context is null on the bare prime path").toBeNull();
  });

  it("prime capability_startup sub-object matches the TODO-reconciled field set (AC1/AC2)", () => {
    const spec = SOURCE_CONTRACT_ORACLE.commands.prime;
    const { payload } = capturePrime();
    const sc = payload.source_contract as Record<string, unknown>;
    const cs = sc.capability_startup as Record<string, unknown>;
    expect(typeof cs, "capability_startup is an object").toBe("object");
    assertRequiredKeys(cs, spec.capabilityStartupRequiredKeys, "prime.capability_startup", "source-contract.json");
    assertExactKeys(cs, spec.capabilityStartupRequiredKeys, "prime.capability_startup", "source-contract.json");
    assertValueTypes(cs, spec.capabilityStartupFieldTypes, "prime.capability_startup", "source-contract.json");
    // The TODO enumerated `complete_for_capability_startup` and `missing_state`; assert they are present
    // and have the correct types (per AC4: value CONTENT is not pinned, only type and shape).
    expect(typeof cs.complete_for_capability_startup, "complete_for_capability_startup is boolean").toBe("boolean");
    expect(Array.isArray(cs.missing_state), "missing_state is an array").toBe(true);
    expect(Array.isArray(cs.cli_fallback), "cli_fallback is an array").toBe(true);
    expect(Array.isArray(cs.confidence_caveats), "confidence_caveats is an array").toBe(true);
    expect(typeof cs.raw_artifact_reads_required, "raw_artifact_reads_required is boolean").toBe("boolean");
    expect(cs.raw_artifact_reads_required, "raw_artifact_reads_required default").toBe(false);
  });
});

describe("prime --context <capability> source_contract (oracle parity)", () => {
  const BESPOKE_CAPABILITIES = ["orchestrate", "build", "audit", "optimize", "document"];
  const NON_BESPOKE_CAPABILITIES = ["status", "plan", "discuss", "research", "vision", "design", "profile"];

  function capturePrimeContext(capability: string): { rc: number; payload: Record<string, unknown> } {
    return runDispatch(["prime", "--context", capability, "--format", "json"]);
  }

  function readBespokeSourceContract(payload: Record<string, unknown>, capability: string): Record<string, unknown> | null {
    const capCtx = payload.capability_context as Record<string, unknown> | undefined;
    if (!capCtx) return null;
    const ctx = capCtx.context as Record<string, unknown> | undefined;
    if (!ctx) return null;
    for (const key of Object.keys(ctx)) {
      if (key === "capability" || key === "schema_error" || key === "first_invocation_read") continue;
      const bespoke = ctx[key] as Record<string, unknown> | undefined;
      if (bespoke && typeof bespoke === "object" && "source_contract" in bespoke) {
        return bespoke.source_contract as Record<string, unknown>;
      }
    }
    return null;
  }

  it("prime --context top-level source_contract is NOT emitted (absent key, not empty object)", () => {
    const spec = SOURCE_CONTRACT_ORACLE.commands.prime_context;
    for (const capability of BESPOKE_CAPABILITIES) {
      const { rc, payload } = capturePrimeContext(capability);
      expect(rc, `prime --context ${capability} rc`).toBe(spec.exitCode);
      // The top-level source_contract is intentionally absent on the --context path;
      // only `command`, `status`, and `capability_context` are at the top level.
      expect(
        "source_contract" in payload,
        `${capability} top-level source_contract is absent`,
      ).toBe(false);
    }
  });

  it.each(BESPOKE_CAPABILITIES)("prime --context %s per-capability source_contract matches the oracle", (capability) => {
    const spec = SOURCE_CONTRACT_ORACLE.commands.prime_context.perCapabilitySourceContract;
    const { rc, payload } = capturePrimeContext(capability);
    expect(rc, `prime --context ${capability} rc`).toBe(0);
    const sc = readBespokeSourceContract(payload, capability);
    expect(sc, `${capability} emits a per-capability source_contract`).not.toBeNull();
    expect(sc, `${capability} source_contract is an object`).toBeTypeOf("object");
    assertRequiredKeys(sc!, spec.sharedRequiredKeys, `prime_context.${capability}`, "source-contract.json");
    assertValueTypes(sc!, spec.sharedFieldTypes, `prime_context.${capability}`, "source-contract.json");
    // Completeness key varies by capability but is always a boolean.
    const completenessKey = spec.completenessKeyByCapability[capability];
    expect(completenessKey, `${capability} has a pinned completeness key`).toBeTypeOf("string");
    expect(sc!, `${capability} has its completeness key`).toHaveProperty(completenessKey!);
    expect(typeof (sc as Record<string, unknown>)[completenessKey!], `${completenessKey} is boolean`).toBe(
      "boolean",
    );
    // `caveated` key is present on 4 of 5 capabilities (not orkestrera).
    const caveatedExpected = spec.caveatedKeyPresent.present.includes(capability);
    const hasCaveated = "caveated" in sc!;
    expect(hasCaveated, `${capability} caveated key presence`).toBe(caveatedExpected);
    if (caveatedExpected) {
      expect(typeof (sc as Record<string, unknown>).caveated, `${capability} caveated is boolean`).toBe("boolean");
    }
    // Context-specific list fields: each capability's pinned fields must be present and
    // match the pinned value type (per AC4: value content is not pinned, only the shape).
    const contextFields = spec.contextSpecificListFieldsByCapability[capability];
    for (const [fieldName, expectedType] of Object.entries(contextFields)) {
      expect(sc!, `${capability} has context-specific field '${fieldName}'`).toHaveProperty(fieldName);
      const actualValue = (sc as Record<string, unknown>)[fieldName];
      if (!typeMatches(actualValue, expectedType)) {
        throw new Error(
          `oracle contract drift on prime_context.${capability}: field '${fieldName}' expected type '${expectedType}' but live source_contract has '${typeOf(actualValue)}'. Update source-contract.json with an intentional type change or revert the field.`,
        );
      }
    }
  });

  it.each(NON_BESPOKE_CAPABILITIES)("prime --context %s (non-bespoke) does not emit a per-capability source_contract", (capability) => {
    const { rc, payload } = capturePrimeContext(capability);
    expect(rc, `prime --context ${capability} rc`).toBe(0);
    // Non-bespoke capabilities (hej, planera, resonera, inspirera, visionera, visualisera, profilera)
    // share the bare capability_context.context.{capability, schema_error, first_invocation_read}
    // shape and have no bespoke source_contract under context.<bespoke>.source_contract.
    const sc = readBespokeSourceContract(payload, capability);
    expect(sc, `${capability} has no per-capability source_contract`).toBeNull();
  });
});

describe("state plan source_contract (oracle parity)", () => {
  function captureStatePlan(): { rc: number; payload: Record<string, unknown> } {
    return runDispatch(["state", "plan", "--format", "json"]);
  }

  it("state plan top-level source_contract matches the oracle", () => {
    const spec = SOURCE_CONTRACT_ORACLE.commands.state_plan;
    const { rc, payload } = captureStatePlan();
    expect(rc, "state plan rc").toBe(spec.exitCode);
    const sc = payload.source_contract as Record<string, unknown>;
    expect(typeof sc, "state plan source_contract is an object").toBe("object");
    assertRequiredKeys(sc, spec.requiredTopLevelKeys, "state_plan", "source-contract.json");
    assertExactKeys(sc, spec.requiredTopLevelKeys, "state_plan", "source-contract.json");
    assertValueTypes(sc, spec.fieldTypes, "state_plan", "source-contract.json");
    expect(sc.artifact, "state plan artifact literal").toBe(spec.artifactValue);
    expect(sc.canonical_artifact_label, "state plan canonical_artifact_label literal").toBe(
      spec.canonicalArtifactLabelValue,
    );
  });

  it("state plan complete_state and raw_artifact_access_boundary sub-objects match the oracle", () => {
    const spec = SOURCE_CONTRACT_ORACLE.commands.state_plan;
    const { payload } = captureStatePlan();
    const sc = payload.source_contract as Record<string, unknown>;
    const cs = sc.complete_state as Record<string, unknown>;
    expect(typeof cs, "complete_state is an object").toBe("object");
    assertRequiredKeys(cs, spec.completeStateRequiredKeys, "state_plan.complete_state", "source-contract.json");
    assertValueTypes(cs, spec.completeStateFieldTypes, "state_plan.complete_state", "source-contract.json");
    const rab = sc.raw_artifact_access_boundary as Record<string, unknown>;
    expect(typeof rab, "raw_artifact_access_boundary is an object").toBe("object");
    assertRequiredKeys(
      rab,
      spec.rawArtifactAccessBoundaryRequiredKeys,
      "state_plan.raw_artifact_access_boundary",
      "source-contract.json",
    );
    assertValueTypes(
      rab,
      spec.rawArtifactAccessBoundaryFieldTypes,
      "state_plan.raw_artifact_access_boundary",
      "source-contract.json",
    );
    // The raw_artifact_reads_required default is false in normal operation.
    expect(sc.raw_artifact_reads_required, "raw_artifact_reads_required default").toBe(false);
  });
});

describe("state todo (no source_contract) (oracle parity)", () => {
  function captureStateTodo(): { rc: number; payload: Record<string, unknown> } {
    return runDispatch(["state", "todo", "--format", "json"]);
  }

  it("state todo does NOT emit a source_contract (documented exclusion)", () => {
    const spec = SOURCE_CONTRACT_ORACLE.commands.state_todo;
    const { rc, payload } = captureStateTodo();
    expect(rc, "state todo rc").toBe(spec.exitCode);
    expect("source_contract" in payload, "state todo has NO source_contract key").toBe(false);
    // The standard state envelope is still emitted; pin the npm-cli-surface required keys.
    for (const key of spec.requiredTopLevelKeys) {
      expect(payload, `state todo has top-level key '${key}'`).toHaveProperty(key);
    }
  });
});

describe("state query --list-artifacts source_contract (oracle parity)", () => {
  function captureStateQueryListArtifacts(): { rc: number; payload: Record<string, unknown> } {
    return runDispatch(["state", "query", "--list-artifacts", "--format", "json"]);
  }

  it("state query --list-artifacts top-level source_contract matches the oracle", () => {
    const spec = SOURCE_CONTRACT_ORACLE.commands.state_query_list_artifacts;
    const { rc, payload } = captureStateQueryListArtifacts();
    expect(rc, "state query --list-artifacts rc").toBe(spec.exitCode);
    const sc = payload.source_contract as Record<string, unknown>;
    expect(typeof sc, "state query --list-artifacts source_contract is an object").toBe("object");
    assertRequiredKeys(sc, spec.requiredTopLevelKeys, "state_query_list_artifacts", "source-contract.json");
    assertExactKeys(sc, spec.requiredTopLevelKeys, "state_query_list_artifacts", "source-contract.json");
    assertValueTypes(sc, spec.fieldTypes, "state_query_list_artifacts", "source-contract.json");
    // The discovery-mode raw-reads-required default is false.
    expect(sc.raw_artifact_reads_required_for_discovery, "raw_artifact_reads_required_for_discovery default").toBe(
      false,
    );
    // allowed_raw_artifact_uses is a string array of at least the pinned cardinality
    // (content is not pinned per AC4).
    const uses = sc.allowed_raw_artifact_uses as unknown[];
    expect(Array.isArray(uses), "allowed_raw_artifact_uses is an array").toBe(true);
    expect(uses.length, "allowed_raw_artifact_uses has at least the pinned cardinality").toBeGreaterThanOrEqual(
      spec.allowedRawArtifactUsesCardinalityAtLeast,
    );
  });
});

describe("shared source_contract pattern (cross-cutting structural contract)", () => {
  it("every source_contract emission is an object and carries a boolean 'is raw reads required' field", () => {
    // The shared pattern: every emission is an object, every emission has a boolean
    // 'is raw reads required' field (named differently per command but always present),
    // every emission has at least one string policy field, and most have an array
    // of caveats/fallbacks. Content is NOT pinned (per AC4).
    const samples: Array<{ label: string; payload: Record<string, unknown>; readsRequiredKey: string }> = [
      {
        label: "prime.capability_startup",
        payload: (runDispatch(["prime", "--format", "json"]).payload.source_contract as Record<string, unknown>)
          .capability_startup as Record<string, unknown>,
        readsRequiredKey: "raw_artifact_reads_required",
      },
      {
        label: "prime_context.orkestrera",
        payload: readBespokeInPayload(runDispatch(["prime", "--context", "orchestrate", "--format", "json"]).payload),
        readsRequiredKey: "raw_artifact_reads_required",
      },
      {
        label: "state_plan",
        payload: runDispatch(["state", "plan", "--format", "json"]).payload.source_contract as Record<string, unknown>,
        readsRequiredKey: "raw_artifact_reads_required",
      },
      {
        label: "state_query_list_artifacts",
        payload: runDispatch(["state", "query", "--list-artifacts", "--format", "json"]).payload.source_contract as Record<string, unknown>,
        readsRequiredKey: "raw_artifact_reads_required_for_discovery",
      },
    ];
    for (const sample of samples) {
      expect(typeof sample.payload, `${sample.label} source_contract is an object`).toBe("object");
      expect(sample.payload, `${sample.label} has '${sample.readsRequiredKey}'`).toHaveProperty(
        sample.readsRequiredKey,
      );
      expect(
        typeof (sample.payload as Record<string, unknown>)[sample.readsRequiredKey],
        `${sample.label}.${sample.readsRequiredKey} is boolean`,
      ).toBe("boolean");
    }
  });

  it("every source_contract emission has a string policy field that is NOT empty", () => {
    const samples: Array<{ label: string; payload: Record<string, unknown>; policyKey: string }> = [
      {
        label: "prime.capability_startup",
        payload: (runDispatch(["prime", "--format", "json"]).payload.source_contract as Record<string, unknown>)
          .capability_startup as Record<string, unknown>,
        policyKey: "raw_artifact_read_policy",
      },
      {
        label: "prime_context.orkestrera",
        payload: readBespokeInPayload(runDispatch(["prime", "--context", "orchestrate", "--format", "json"]).payload),
        policyKey: "raw_artifact_read_policy",
      },
      {
        label: "state_plan",
        payload: runDispatch(["state", "plan", "--format", "json"]).payload.source_contract as Record<string, unknown>,
        policyKey: "raw_artifact_read_policy",
      },
      {
        label: "state_query_list_artifacts",
        payload: runDispatch(["state", "query", "--list-artifacts", "--format", "json"]).payload.source_contract as Record<string, unknown>,
        policyKey: "raw_artifact_read_policy",
      },
    ];
    for (const sample of samples) {
      const policy = (sample.payload as Record<string, unknown>)[sample.policyKey];
      expect(typeof policy, `${sample.label}.${sample.policyKey} is a string`).toBe("string");
      expect((policy as string).length, `${sample.label}.${sample.policyKey} is non-empty`).toBeGreaterThan(0);
    }
  });
});

function readBespokeInPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const capCtx = payload.capability_context as Record<string, unknown> | undefined;
  if (!capCtx) return {};
  const ctx = capCtx.context as Record<string, unknown> | undefined;
  if (!ctx) return {};
  for (const key of Object.keys(ctx)) {
    if (key === "capability" || key === "schema_error" || key === "first_invocation_read") continue;
    const bespoke = ctx[key] as Record<string, unknown> | undefined;
    if (bespoke && typeof bespoke === "object" && "source_contract" in bespoke) {
      return bespoke.source_contract as Record<string, unknown>;
    }
  }
  return {};
}

describe("source_contract drift detector (AC3)", () => {
  it("fails with a named diff when an undeclared key is added", () => {
    const baseRequired = [
      "fields",
      "render",
      "access",
      "empty_state",
      "capability_startup",
      "capability_context",
    ];
    const matching = {
      fields: [],
      render: "x",
      access: "x",
      empty_state: "x",
      capability_startup: {},
      capability_context: null,
    };
    expect(() => assertExactKeys(matching, baseRequired, "prime", "source-contract.json")).not.toThrow();
    const extra = { ...matching, brand_new_field: "x" };
    expect(() => assertExactKeys(extra, baseRequired, "prime", "source-contract.json")).toThrow(
      /brand_new_field/,
    );
    const missing = {
      fields: [],
      render: "x",
      access: "x",
      empty_state: "x",
      capability_startup: {},
    };
    expect(() => assertExactKeys(missing, baseRequired, "prime", "source-contract.json")).toThrow(
      /capability_context/,
    );
  });

  it("typeMatches accepts the pinned union of types", () => {
    expect(typeMatches([], "array<string>"), "empty array is array<string>").toBe(true);
    expect(typeMatches(["a", "b"], "array<string>"), "string array").toBe(true);
    expect(typeMatches([1], "array<string>"), "number array is NOT array<string>").toBe(false);
    expect(typeMatches(null, "string|null"), "null matches string|null").toBe(true);
    expect(typeMatches("x", "string|null"), "string matches string|null").toBe(true);
    expect(typeMatches(1, "string|null"), "number does NOT match string|null").toBe(false);
    expect(typeMatches({}, "object"), "empty object matches object").toBe(true);
    expect(typeMatches([], "object"), "array does NOT match object").toBe(false);
  });
});
