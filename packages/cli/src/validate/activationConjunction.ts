import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { CAPABILITY_INSTRUCTIONS, capabilityInstructionModulePath } from "../capabilities/index.js";
import { capabilityInstructionTarget } from "../cli/capabilityContext/contract.js";
import { CAPABILITY_ROUTING_NAMES } from "../cli/commands/capability.js";
import { DISPATCHER_COMMANDS, DISPATCHER_TOP_LEVEL_COMMANDS } from "../cli/dispatch/commands.js";
import { DIAGNOSTIC_TOP_LEVEL_COMMANDS, HELP_TOP_LEVEL_COMMANDS, SCHEMA_TOP_LEVEL_COMMANDS } from "../cli/dispatch/projections.js";
import { printTopLevelHelp } from "../cli/help.js";
import type { JsonObject } from "../core/jsonValue.js";
import { isNpxBundleRoot, resolveSourceRoot } from "../core/sourceRoot.js";
import { loadYamlMapping } from "../core/yaml.js";
import { ACTIVATION_CENSUS_AUTHORITY, ACTIVATION_CHECK_IDS, ACTIVATION_CLASSES, ACTIVATION_CLASS_AUTHORITIES, ACTIVATION_DIMENSIONS, ACTIVATION_EVIDENCE_SOURCES, type ActivationClassId, type ActivationDimensionId } from "../registries/activationContract.js";
import { ACTIVATION_CANONICAL_TUPLES, ACTIVATION_TUPLE_AUTHORITY, canonicalTupleJson, digestCanonicalTuples, type ActivationCanonicalTuple } from "../registries/activationTuples.js";
import { loadCapabilitySchemaContract } from "../registries/capabilityContract.js";
import { loadPackagePublicationModel, type ActivationConjunctionContract } from "../registries/packagePublication.js";
import { loadRegistry } from "../registries/packageRegistry.js";
import { loadLifecycleAuthority } from "../runtime/lifecycleAuthority.js";
import { loadNativeResourceCleanupContract, retiredResourceDiagnosticIds, type NativeResourceCleanupContract, type RetiredResourceDiagnosticDefinition } from "../runtime/nativeResourceCleanup.js";
import { entityListFamilies } from "../state/entityRetrievalHelp.js";
import { ENTITY_LIST_RUNTIME_BOUNDS, ENTITY_LIST_RUNTIME_FAMILIES } from "../state/entityListRuntimeRegistry.js";
import { stateWriterContract } from "../state/write/operations.js";
import { runtimeOperationSpecs } from "../state/write/runtimeOperations.js";
import { BOOTSTRAP_ACCEPTED_SPECS, BOOTSTRAP_PROJECT_STATE_IDS, BOOTSTRAP_REJECTION_SPECS, BOOTSTRAP_RUNTIME_IDS, bootstrapMatrixAuthority } from "./bootstrapAuthority.js";
import { ACTIVATION_EVIDENCE_FILE, activationEvidenceViolations, readActivationEvidenceManifest, type ActivationEvidenceManifest } from "./activationEvidenceManifest.js";
import { packageDescriptorSemantics, packageDescriptors, packageSemanticSelector } from "./activationPackageSemantics.js";
import { loadSourceCapabilityInstructions, retainedPackageSnapshotViolations, type ActivationPackageIdentity } from "./activationArtifactEvidence.js";

export interface ActivationOwner {
  path: string;
  symbol: string;
  selector?: string;
}
export interface ActivationDimensionEvidence {
  dimension: string;
  status: "pass" | "fail";
  checkId: string;
  evidenceRef: string;
}
export interface ActivationSurfaceRow {
  classId: string;
  surfaceId: string;
  owner: ActivationOwner;
  dimensions: ActivationDimensionEvidence[];
  correction?: string;
}
export interface ProductionSurface {
  id: string;
  owner: ActivationOwner;
  correction: string;
  semanticSelector?: string | null;
}
export interface ActivationEvidenceRecord {
  sourceId: string;
  identities: string[];
  valid: boolean;
}
export interface ClassProductionEvidence {
  surfaces: ProductionSurface[];
  dimensions: Record<string, ActivationEvidenceRecord>;
}
export interface ActivationProductionEvidence {
  classes: Record<string, ClassProductionEvidence>;
}
export interface ActivationClassProductionInputs {
  census: any;
  dimensions: Record<ActivationDimensionId, any>;
}
export interface ActivationProductionInputs {
  classes: Record<ActivationClassId, ActivationClassProductionInputs>;
}
export interface ActivationConjunctionInputs {
  root?: string;
  contract?: ActivationConjunctionContract;
  productionInputs?: ActivationProductionInputs;
  surfaces?: ActivationSurfaceRow[];
  expectedGeneration?: string;
  generationRoot?: string;
  evidenceManifest?: ActivationEvidenceManifest | unknown;
  expectedEvidenceDigest?: string;
  expectedPackageIdentity?: ActivationPackageIdentity | unknown;
}
export interface ActivationViolation {
  owner: string;
  violation: string;
  correction: string;
}

const OWNER_PATH = /^(?:packages\/cli\/(?:src\/.+\.ts|scripts\/.+\.mjs)|references\/.+\.(?:json|ya?ml))$/;
const SYMBOL = /^[A-Za-z_$][A-Za-z0-9_.$-]*$/;
const GENERATION_ID = /^[0-9a-f]{64}$/;
const RETAINED_CLASSES = new Set(["current", "migration-only", "runbook"]);

function exactSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === new Set(left).size && right.length === new Set(right).size && [...left].sort().join("\0") === [...right].sort().join("\0");
}
function ownerText(owner: ActivationOwner): string {
  return `${owner.path}#${owner.selector ?? owner.symbol}`;
}
function tupleOwnerText(tuple: ActivationCanonicalTuple): string {
  return `${tuple.owner_path}#${tuple.owner_selector ?? tuple.owner_symbol_or_selector}`;
}
function tupleDiagnostic(tuple: ActivationCanonicalTuple): string {
  const semantic = tuple.semantic_selector_if_any === null ? "none" : createHash("sha256").update(tuple.semantic_selector_if_any).digest("hex");
  return `${tuple.class}:${tuple.surface_id} owner=${tupleOwnerText(tuple)} symbol=${tuple.owner_symbol_or_selector} semantic_sha256=${semantic}`;
}
function digestIdentities(ids: readonly string[]): string {
  return createHash("sha256")
    .update([...ids].sort().join("\n"), "utf8")
    .digest("hex");
}
function plainClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function registryJson(root: string): any {
  return JSON.parse(fs.readFileSync(path.join(root, "registry.json"), "utf8"));
}
function retainedInventoryAt(root: string): any[] {
  const authority = loadYamlMapping(fs.readFileSync(path.join(root, "references/meta/retained-reference-authority.yaml"), "utf8")) as any;
  return Array.isArray(authority.inventory) ? authority.inventory.filter((entry: any) => RETAINED_CLASSES.has(entry?.classification)) : [];
}
function classAuthority(classId: ActivationClassId) {
  return ACTIVATION_CLASS_AUTHORITIES[classId];
}
function classOwnerText(classId: ActivationClassId): string {
  const owner = classAuthority(classId);
  return `${owner.path}#${owner.selector ?? owner.symbol}`;
}
function surfacesWithClassOwner(ids: readonly string[], classId: ActivationClassId): ProductionSurface[] {
  const authority = classAuthority(classId);
  return ids.map((id) => ({ id, owner: { path: authority.path, symbol: authority.symbol, ...(authority.selector ? { selector: authority.selector } : {}) }, correction: authority.correction }));
}
function evidence(classId: ActivationClassId, dimension: ActivationDimensionId, identities: string[], valid = true): ActivationEvidenceRecord {
  return { sourceId: ACTIVATION_EVIDENCE_SOURCES[classId][dimension], identities, valid };
}
function parseDispatchCases(source: string): string[] {
  const routed = [...source.matchAll(/case\s+"([^"]+)"\s*:/g)].map((match) => match[1]!);
  return [...new Set(routed.filter((id) => id !== "version" && id !== "--version"))];
}
function helpCommandIds(text: string): string[] {
  const match = /usage: agentera \[-h\] \[--version\] \{([^}]+)\}/.exec(text);
  return match?.[1]?.split(",") ?? [];
}
function capabilityTargets(instructions: Record<string, string>): any[] {
  return Object.entries(instructions).map(([id, body]) => {
    const target = capabilityInstructionTarget(id);
    return { id, module: target.module, present: target.instructions_present === true, length: body.length, sha256: createHash("sha256").update(body, "utf8").digest("hex") };
  });
}
function instructionBodyDigests(instructions: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(instructions)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, body]) => [id, createHash("sha256").update(body, "utf8").digest("hex")]),
  );
}
function exactInstructionBodies(left: Record<string, string>, right: Record<string, string>): boolean {
  return JSON.stringify(instructionBodyDigests(left)) === JSON.stringify(instructionBodyDigests(right));
}
function nonEmptyInstructionBodies(instructions: Record<string, string>): boolean {
  return Object.values(instructions).every((body) => typeof body === "string" && Buffer.byteLength(body, "utf8") > 0);
}
function packageRootFor(root: string, generationRoot?: string): string {
  const bundle = generationRoot ? path.join(generationRoot, "bundle") : "";
  return bundle && fs.existsSync(path.join(bundle, "registry.json")) ? bundle : root;
}
function runtimeIdsFromLoaded(lifecycle: any, retired: NativeResourceCleanupContract): string[] {
  return [...(lifecycle.runtimes.length === 0 ? ["portable.shared-skill-cli"] : []), ...[...new Set(retired.resources.map(({ host }) => `host:${host}`))].sort(), ...retiredResourceDiagnosticIds(retired).map((id) => `retired:${id}`)];
}
function expandedDiagnosticRecordIds(record: RetiredResourceDiagnosticDefinition): string[] {
  if (!record.id.includes("{name}")) return [record.id];
  return record.names.map((name) => record.id.replace("{name}", name));
}
function runtimeBehaviorIds(lifecycle: any, retired: NativeResourceCleanupContract): string[] {
  return [
    ...(lifecycle.runtimes.length === 0 && lifecycle.canonicalSkillPath ? ["portable.shared-skill-cli"] : []),
    ...[...new Set(retired.resources.filter(({ hostSupportStatus }) => Boolean(hostSupportStatus)).map(({ host }) => `host:${host}`))].sort(),
    ...retired.diagnosticResources.filter(({ destinations }) => destinations.length > 0).flatMap((record) => expandedDiagnosticRecordIds(record).map((id) => `retired:${id}`)),
  ];
}
function runtimeDiagnosticIds(lifecycle: any, retired: NativeResourceCleanupContract): string[] {
  return [
    ...(lifecycle.sourcePath.endsWith("runtime-lifecycle-authority.yaml") ? ["portable.shared-skill-cli"] : []),
    ...[...new Set(retired.resources.filter(({ durableProof }) => durableProof.length > 0).map(({ host }) => `host:${host}`))].sort(),
    ...retiredResourceDiagnosticIds(retired).map((id) => `retired:${id}`),
  ];
}
function runtimeInstructionIds(lifecycle: any, retired: NativeResourceCleanupContract): string[] {
  return [
    ...(lifecycle.canonicalSkillPath ? ["portable.shared-skill-cli"] : []),
    ...[...new Set(retired.resources.filter(({ safetyNote }) => safetyNote.length > 0).map(({ host }) => `host:${host}`))].sort(),
    ...retired.diagnosticResources.filter(({ id, destinations, names, contains }) => destinations.length > 0 && (names.length > 0 || contains !== null || !id.includes("{name}"))).flatMap((record) => expandedDiagnosticRecordIds(record).map((id) => `retired:${id}`)),
  ];
}
function runtimeAdversarialIds(lifecycle: any, retired: NativeResourceCleanupContract): string[] {
  return runtimeIdsFromLoaded(lifecycle, retired).filter((id) => /^[A-Za-z0-9][A-Za-z0-9._:-]+$/.test(id));
}
function referenceIds(inventory: any[]): string[] {
  return inventory.map((entry) => String(entry.path));
}
function referenceBehaviorIds(inventory: any[]): string[] {
  return inventory
    .filter((entry) => (entry.classification === "runbook" ? typeof entry.command === "string" && entry.command.length > 0 : Array.isArray(entry.consumers) && entry.consumers.some((consumer: any) => ["runtime", "validator"].includes(consumer?.kind) && consumer?.consumption === "loads")))
    .map((entry) => entry.path);
}
function referenceDiagnosticIds(inventory: any[]): string[] {
  return inventory
    .filter((entry) => typeof entry.path === "string" && (entry.classification === "runbook" ? typeof entry.maintainer === "string" && typeof entry.working_directory === "string" && typeof entry.command === "string" : entry.production_owner && Array.isArray(entry.consumers) && entry.consumers.length > 0))
    .map((entry) => entry.path);
}
function referenceInstructionIds(inventory: any[]): string[] {
  return inventory
    .filter((entry) =>
      entry.classification === "runbook" ? entry.source_checkout_root === "." && entry.working_directory === "." && /^(?:pnpm|node) /.test(entry.command ?? "") : Array.isArray(entry.consumers) && entry.consumers.every((consumer: any) => typeof consumer.module === "string" && typeof consumer.symbol === "string"),
    )
    .map((entry) => entry.path);
}
function referenceAdversarialIds(inventory: any[]): string[] {
  return inventory.filter((entry) => (entry.classification === "runbook" ? !/[\0\r\n]/.test(entry.command ?? "") : OWNER_PATH.test(entry.production_owner?.module ?? "") && SYMBOL.test(entry.production_owner?.symbol ?? ""))).map((entry) => entry.path);
}
function stateIds(input: any): string[] {
  return [...input.readFamilies.map((family: any) => `read:${family.key}`), ...input.operations.map((operation: any) => `write:${operation.artifact}.${operation.verb}`)];
}
function stateProjectionIds(input: any): string[] {
  const reads = input.helpFamilies.map((family: any) => `read:${family.key}`);
  const artifacts = Array.isArray(input.writerContract?.artifacts) ? input.writerContract.artifacts : [];
  const writes = artifacts.flatMap((artifact: any) => (artifact.operations ?? []).map((operation: any) => `write:${artifact.artifact}.${operation.verb}`));
  return [...reads, ...writes];
}
function bootstrapIds(matrix: any): string[] {
  return [...matrix.runtimeIds.map((id: string) => `runtime:${id}`), ...matrix.stateIds.map((id: string) => `state:${id}`), ...matrix.accepted.map(({ id }: any) => `accepted:${id}`), ...matrix.rejections.map(({ id }: any) => `rejection:${id}`)];
}
function bootstrapBehaviorIds(matrix: any): string[] {
  return [
    ...matrix.runtimeIds.filter((id: unknown) => typeof id === "string").map((id: string) => `runtime:${id}`),
    ...matrix.stateIds.filter((id: unknown) => typeof id === "string").map((id: string) => `state:${id}`),
    ...matrix.accepted.filter((entry: any) => entry.classification === "accepted" && entry.states.length > 0).map(({ id }: any) => `accepted:${id}`),
    ...matrix.rejections.filter((entry: any) => ["wrong_channel", "not_exact", "malformed"].includes(entry.classification) && entry.states.length > 0).map(({ id }: any) => `rejection:${id}`),
  ];
}
function bootstrapDiagnosticIds(matrix: any): string[] {
  return [
    ...matrix.runtimeIds.filter((id: unknown) => /^[a-z]+$/.test(String(id))).map((id: string) => `runtime:${id}`),
    ...matrix.stateIds.filter((id: unknown) => /^[a-z0-9]+$/.test(String(id))).map((id: string) => `state:${id}`),
    ...matrix.accepted.filter((entry: any) => entry.classification === "accepted" && entry.states.every((state: string) => matrix.stateIds.includes(state))).map(({ id }: any) => `accepted:${id}`),
    ...matrix.rejections.filter((entry: any) => typeof entry.candidate === "string" && entry.candidate.length > 0 && ["wrong_channel", "not_exact", "malformed"].includes(entry.classification)).map(({ id }: any) => `rejection:${id}`),
  ];
}
function bootstrapInstructionIds(matrix: any): string[] {
  return [
    ...matrix.runtimeIds.filter((id: string) => ["source", "package"].includes(id)).map((id: string) => `runtime:${id}`),
    ...matrix.stateIds.filter((id: string) => ["clean", "v2", "partial", "v3"].includes(id)).map((id: string) => `state:${id}`),
    ...matrix.accepted.filter((entry: any) => entry.states.length > 0 && new Set(entry.states).size === entry.states.length).map(({ id }: any) => `accepted:${id}`),
    ...matrix.rejections.filter((entry: any) => entry.states.length > 0 && typeof entry.candidate === "string").map(({ id }: any) => `rejection:${id}`),
  ];
}
function bootstrapAdversarialIds(matrix: any): string[] {
  return [
    ...matrix.runtimeIds.filter((id: string) => !/[;&|\s]/.test(id)).map((id: string) => `runtime:${id}`),
    ...matrix.stateIds.filter((id: string) => !/[;&|\s]/.test(id)).map((id: string) => `state:${id}`),
    ...matrix.accepted.filter((entry: any) => entry.classification === "accepted" && !entry.candidate).map(({ id }: any) => `accepted:${id}`),
    ...matrix.rejections.filter((entry: any) => typeof entry.candidate === "string" && ["wrong_channel", "not_exact", "malformed"].includes(entry.classification)).map(({ id }: any) => `rejection:${id}`),
  ];
}

/** Load injectable inputs from production exports, loaders, and projections. */
export function loadActivationProductionInputs(root: string, generationRoot?: string): ActivationProductionInputs {
  const packageRoot = packageRootFor(root, generationRoot);
  const capabilityContract = loadCapabilitySchemaContract(path.join(root, "skills/agentera/capability_schema_contract.yaml"));
  const schemaDirectories = () =>
    fs
      .readdirSync(path.join(root, "skills/agentera/capabilities"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  const sourceRegistryCapabilities = () => registryJson(root)?.skills?.[0]?.capabilities ?? [];
  const packagedRegistryCapabilities = () => registryJson(packageRoot)?.skills?.[0]?.capabilities ?? [];
  const runtimeInput = (usePackage = false) => {
    const authorityRoot = usePackage ? packageRoot : root;
    return { lifecycle: loadLifecycleAuthority(path.join(authorityRoot, "references/adapters/runtime-lifecycle-authority.yaml")), retired: loadNativeResourceCleanupContract(path.join(authorityRoot, "references/adapters/runtime-retired-resources.yaml")) };
  };
  const referenceInput = (usePackage = false) => ({ inventory: retainedInventoryAt(usePackage ? packageRoot : root) });
  const stateInput = () => ({ readFamilies: structuredClone(ENTITY_LIST_RUNTIME_FAMILIES), operations: runtimeOperationSpecs(), bounds: structuredClone(ENTITY_LIST_RUNTIME_BOUNDS), helpFamilies: entityListFamilies(), writerContract: stateWriterContract() });
  const packageInput = (usePackage = false) => {
    const authorityRoot = usePackage ? packageRoot : root;
    const record = loadRegistry(path.join(authorityRoot, "references/adapters/package-registry.yaml"), authorityRoot).get("agentera");
    return { record, constructionPlan: packageDescriptors(record).map(({ id, entry }) => ({ id, path: entry.path })) };
  };
  const bootstrapInput = () => bootstrapMatrixAuthority();
  const bootstrapBehaviorInput = () => ({ ...bootstrapMatrixAuthority(), binderBehavior: bootstrapIds(bootstrapMatrixAuthority()) });
  const bootstrapDiagnosticInput = () => ({ ...bootstrapMatrixAuthority(), diagnostics: BOOTSTRAP_REJECTION_SPECS.map(({ id, classification }) => ({ id, classification })) });
  const bootstrapPackageInput = () => ({ ...bootstrapMatrixAuthority(), extractedClassifications: [...BOOTSTRAP_ACCEPTED_SPECS, ...BOOTSTRAP_REJECTION_SPECS].map(({ id, classification }) => ({ id, classification })) });
  const bootstrapInstructionInput = () => ({ ...bootstrapMatrixAuthority(), startupProducers: BOOTSTRAP_ACCEPTED_SPECS.map(({ id }) => id) });
  const bootstrapAdversarialInput = () => ({ ...bootstrapMatrixAuthority(), invalidCommandResults: BOOTSTRAP_REJECTION_SPECS.map(({ id, classification }) => ({ id, classification })) });
  const sourceCapabilityObservation = loadSourceCapabilityInstructions(root);
  const instructions = structuredClone(sourceCapabilityObservation.modules);
  return plainClone({
    classes: {
      cli: {
        census: { commands: [...DISPATCHER_TOP_LEVEL_COMMANDS] },
        dimensions: {
          discovery: { commands: [...DISPATCHER_TOP_LEVEL_COMMANDS] },
          behavior: { dispatchSource: fs.readFileSync(path.join(root, "packages/cli/src/cli/dispatch/index.ts"), "utf8"), capabilityRoutes: [...CAPABILITY_ROUTING_NAMES] },
          diagnostics: { commands: [...DIAGNOSTIC_TOP_LEVEL_COMMANDS], runtimeDiagnosticCommands: [...DISPATCHER_COMMANDS] },
          package_projection: { commands: [...SCHEMA_TOP_LEVEL_COMMANDS] },
          instructions: { helpText: printTopLevelHelp(), declaredCommands: [...HELP_TOP_LEVEL_COMMANDS] },
          adversarial: { commands: [...DISPATCHER_COMMANDS] },
        },
      },
      capability: {
        census: { instructions },
        dimensions: {
          discovery: { instructions: structuredClone(sourceCapabilityObservation.modules) },
          behavior: { routes: ["status", ...CAPABILITY_ROUTING_NAMES], servedInstructions: structuredClone(CAPABILITY_INSTRUCTIONS) },
          diagnostics: { schemaDirectories: schemaDirectories(), generatedInstructions: structuredClone(CAPABILITY_INSTRUCTIONS) },
          package_projection: { capabilities: packagedRegistryCapabilities(), packagedInstructions: structuredClone(CAPABILITY_INSTRUCTIONS) },
          instructions: { targets: capabilityTargets(CAPABILITY_INSTRUCTIONS), servedInstructions: structuredClone(CAPABILITY_INSTRUCTIONS) },
          adversarial: {
            registryCapabilities: sourceRegistryCapabilities(),
            schemaDirectories: schemaDirectories(),
            instructionNames: Object.keys(CAPABILITY_INSTRUCTIONS),
            aliases: capabilityContract.routeAliases.primaryAliases.map(({ capability }) => capability),
            instructionBodies: structuredClone(CAPABILITY_INSTRUCTIONS),
            omissionRejected: true,
            driftRejected: true,
          },
        },
      },
      runtime: { census: runtimeInput(), dimensions: { discovery: runtimeInput(), behavior: runtimeInput(), diagnostics: runtimeInput(), package_projection: runtimeInput(true), instructions: runtimeInput(), adversarial: runtimeInput() } },
      reference: { census: referenceInput(), dimensions: { discovery: referenceInput(), behavior: referenceInput(), diagnostics: referenceInput(), package_projection: referenceInput(true), instructions: referenceInput(), adversarial: referenceInput() } },
      state: { census: stateInput(), dimensions: { discovery: stateInput(), behavior: stateInput(), diagnostics: stateInput(), package_projection: stateInput(), instructions: stateInput(), adversarial: stateInput() } },
      package: { census: packageInput(), dimensions: { discovery: packageInput(), behavior: packageInput(), diagnostics: packageInput(), package_projection: packageInput(true), instructions: packageInput(), adversarial: packageInput() } },
      bootstrap: { census: bootstrapInput(), dimensions: { discovery: bootstrapInput(), behavior: bootstrapBehaviorInput(), diagnostics: bootstrapDiagnosticInput(), package_projection: bootstrapPackageInput(), instructions: bootstrapInstructionInput(), adversarial: bootstrapAdversarialInput() } },
    },
  }) as ActivationProductionInputs;
}

/** Collect facts from injectable production inputs without deriving expectations from them. */
export function collectActivationProductionEvidence(root: string, productionInputs: ActivationProductionInputs = loadActivationProductionInputs(root)): ActivationProductionEvidence {
  const inputs = productionInputs.classes;
  const classes: Record<string, ClassProductionEvidence> = {};

  const cliIds = inputs.cli.census.commands as string[];
  classes.cli = {
    surfaces: surfacesWithClassOwner(cliIds, "cli"),
    dimensions: {
      discovery: evidence("cli", "discovery", inputs.cli.dimensions.discovery.commands),
      behavior: evidence("cli", "behavior", [...parseDispatchCases(inputs.cli.dimensions.behavior.dispatchSource), ...inputs.cli.dimensions.behavior.capabilityRoutes]),
      diagnostics: evidence(
        "cli",
        "diagnostics",
        inputs.cli.dimensions.diagnostics.commands.filter((id: string) => inputs.cli.dimensions.diagnostics.runtimeDiagnosticCommands.includes(id)),
      ),
      package_projection: evidence("cli", "package_projection", inputs.cli.dimensions.package_projection.commands),
      instructions: evidence(
        "cli",
        "instructions",
        helpCommandIds(inputs.cli.dimensions.instructions.helpText).filter((id) => inputs.cli.dimensions.instructions.declaredCommands.includes(id)),
      ),
      adversarial: evidence(
        "cli",
        "adversarial",
        inputs.cli.dimensions.adversarial.commands.filter((id: string) => !/\s|[;&|]/.test(id)),
      ),
    },
  };

  const capabilityIds = Object.keys(inputs.capability.census.instructions);
  const sourceInstructionBodies = inputs.capability.census.instructions;
  classes.capability = {
    surfaces: capabilityIds.map((id) => ({ id, owner: { path: capabilityInstructionModulePath(id), symbol: "instructions" }, correction: classAuthority("capability").correction })),
    dimensions: {
      discovery: evidence("capability", "discovery", Object.keys(inputs.capability.dimensions.discovery.instructions), nonEmptyInstructionBodies(sourceInstructionBodies) && exactInstructionBodies(sourceInstructionBodies, inputs.capability.dimensions.discovery.instructions)),
      behavior: evidence("capability", "behavior", inputs.capability.dimensions.behavior.routes, exactInstructionBodies(sourceInstructionBodies, inputs.capability.dimensions.behavior.servedInstructions)),
      diagnostics: evidence("capability", "diagnostics", inputs.capability.dimensions.diagnostics.schemaDirectories, exactInstructionBodies(sourceInstructionBodies, inputs.capability.dimensions.diagnostics.generatedInstructions)),
      package_projection: evidence("capability", "package_projection", inputs.capability.dimensions.package_projection.capabilities, exactInstructionBodies(sourceInstructionBodies, inputs.capability.dimensions.package_projection.packagedInstructions)),
      instructions: evidence(
        "capability",
        "instructions",
        inputs.capability.dimensions.instructions.targets.filter((target: any) => target.present && target.length > 0 && /^[0-9a-f]{64}$/.test(target.sha256) && target.module === capabilityInstructionModulePath(target.id)).map(({ id }: any) => id),
        exactInstructionBodies(sourceInstructionBodies, inputs.capability.dimensions.instructions.servedInstructions),
      ),
      adversarial: evidence(
        "capability",
        "adversarial",
        [...new Set([...inputs.capability.dimensions.adversarial.registryCapabilities, ...inputs.capability.dimensions.adversarial.schemaDirectories, ...inputs.capability.dimensions.adversarial.instructionNames, ...inputs.capability.dimensions.adversarial.aliases])].filter((id) =>
          [inputs.capability.dimensions.adversarial.registryCapabilities, inputs.capability.dimensions.adversarial.schemaDirectories, inputs.capability.dimensions.adversarial.instructionNames, inputs.capability.dimensions.adversarial.aliases].every((values: string[]) => values.includes(id as string)),
        ) as string[],
        exactInstructionBodies(sourceInstructionBodies, inputs.capability.dimensions.adversarial.instructionBodies) && inputs.capability.dimensions.adversarial.omissionRejected === true && inputs.capability.dimensions.adversarial.driftRejected === true,
      ),
    },
  };

  const runtimeCensusIds = runtimeIdsFromLoaded(inputs.runtime.census.lifecycle, inputs.runtime.census.retired);
  const runtimeSurfaces = runtimeCensusIds.map((id): ProductionSurface => ({
    id,
    owner: id.startsWith("retired:") || id.startsWith("host:") ? { path: "packages/cli/src/runtime/nativeResourceCleanup.ts", symbol: "loadNativeResourceCleanupContract", selector: id } : { path: "packages/cli/src/runtime/lifecycleAuthority.ts", symbol: "loadLifecycleAuthority", selector: id },
    correction: classAuthority("runtime").correction,
  }));
  classes.runtime = {
    surfaces: runtimeSurfaces,
    dimensions: {
      discovery: evidence("runtime", "discovery", runtimeIdsFromLoaded(inputs.runtime.dimensions.discovery.lifecycle, inputs.runtime.dimensions.discovery.retired)),
      behavior: evidence("runtime", "behavior", runtimeBehaviorIds(inputs.runtime.dimensions.behavior.lifecycle, inputs.runtime.dimensions.behavior.retired)),
      diagnostics: evidence("runtime", "diagnostics", runtimeDiagnosticIds(inputs.runtime.dimensions.diagnostics.lifecycle, inputs.runtime.dimensions.diagnostics.retired)),
      package_projection: evidence("runtime", "package_projection", runtimeIdsFromLoaded(inputs.runtime.dimensions.package_projection.lifecycle, inputs.runtime.dimensions.package_projection.retired)),
      instructions: evidence("runtime", "instructions", runtimeInstructionIds(inputs.runtime.dimensions.instructions.lifecycle, inputs.runtime.dimensions.instructions.retired)),
      adversarial: evidence("runtime", "adversarial", runtimeAdversarialIds(inputs.runtime.dimensions.adversarial.lifecycle, inputs.runtime.dimensions.adversarial.retired)),
    },
  };

  const referenceCensus = inputs.reference.census.inventory;
  const referenceSurfaces = referenceCensus.map((entry: any): ProductionSurface => ({
    id: entry.path,
    owner: entry.production_owner ? { path: entry.production_owner.module, symbol: entry.production_owner.symbol, selector: entry.path } : { path: "references/meta/retained-reference-authority.yaml", symbol: "inventory", selector: entry.path },
    correction: classAuthority("reference").correction,
  }));
  classes.reference = {
    surfaces: referenceSurfaces,
    dimensions: {
      discovery: evidence("reference", "discovery", referenceIds(inputs.reference.dimensions.discovery.inventory)),
      behavior: evidence("reference", "behavior", referenceBehaviorIds(inputs.reference.dimensions.behavior.inventory)),
      diagnostics: evidence("reference", "diagnostics", referenceDiagnosticIds(inputs.reference.dimensions.diagnostics.inventory)),
      package_projection: evidence("reference", "package_projection", referenceIds(inputs.reference.dimensions.package_projection.inventory)),
      instructions: evidence("reference", "instructions", referenceInstructionIds(inputs.reference.dimensions.instructions.inventory)),
      adversarial: evidence("reference", "adversarial", referenceAdversarialIds(inputs.reference.dimensions.adversarial.inventory)),
    },
  };

  const stateCensus = inputs.state.census;
  const readSurfaces = stateCensus.readFamilies.map((family: any): ProductionSurface => ({ id: `read:${family.key}`, owner: { path: "packages/cli/src/state/entityListRuntimeRegistry.ts", symbol: "ENTITY_LIST_RUNTIME_REGISTRY", selector: family.key }, correction: classAuthority("state").correction }));
  const writeSurfaces = stateCensus.operations.map((operation: any): ProductionSurface => ({
    id: `write:${operation.artifact}.${operation.verb}`,
    owner: { path: "packages/cli/src/state/write/runtimeOperations.ts", symbol: "runtimeOperationSpecs", selector: `${operation.artifact}.${operation.verb}` },
    correction: classAuthority("state").correction,
  }));
  const stateDiagnosticInput = inputs.state.dimensions.diagnostics;
  const stateInstructionInput = inputs.state.dimensions.instructions;
  const stateAdversarialInput = inputs.state.dimensions.adversarial;
  classes.state = {
    surfaces: [...readSurfaces, ...writeSurfaces],
    dimensions: {
      discovery: evidence("state", "discovery", stateIds(inputs.state.dimensions.discovery)),
      behavior: evidence(
        "state",
        "behavior",
        stateIds(inputs.state.dimensions.behavior).filter((id) =>
          id.startsWith("read:") ? inputs.state.dimensions.behavior.readFamilies.find((family: any) => `read:${family.key}` === id)?.commandTokens.length > 0 : inputs.state.dimensions.behavior.operations.find((operation: any) => `write:${operation.artifact}.${operation.verb}` === id)?.inputMode !== undefined,
        ),
      ),
      diagnostics: evidence("state", "diagnostics", [
        ...stateDiagnosticInput.readFamilies.filter((family: any) => family.boundary && stateDiagnosticInput.bounds.maxUtf8Bytes > 0).map((family: any) => `read:${family.key}`),
        ...stateDiagnosticInput.operations.filter((operation: any) => operation.projection.recovery.runtime.length > 0).map((operation: any) => `write:${operation.artifact}.${operation.verb}`),
      ]),
      package_projection: evidence("state", "package_projection", stateProjectionIds(inputs.state.dimensions.package_projection)),
      instructions: evidence("state", "instructions", [
        ...stateInstructionInput.helpFamilies.filter((family: any) => family.syntax && family.example).map((family: any) => `read:${family.key}`),
        ...stateInstructionInput.operations.filter((operation: any) => operation.projection.examples.length > 0).map((operation: any) => `write:${operation.artifact}.${operation.verb}`),
      ]),
      adversarial: evidence("state", "adversarial", [
        ...stateAdversarialInput.readFamilies.filter((family: any) => stateAdversarialInput.bounds.minimum > 0 && stateAdversarialInput.bounds.maximum >= stateAdversarialInput.bounds.default).map((family: any) => `read:${family.key}`),
        ...stateAdversarialInput.operations.filter((operation: any) => operation.inputMaxBytes >= 0 && operation.projection.formatValues.length === 2).map((operation: any) => `write:${operation.artifact}.${operation.verb}`),
      ]),
    },
  };

  const packageCensusDescriptors = packageDescriptors(inputs.package.census.record);
  const packageSurfaces = packageCensusDescriptors.map((descriptor): ProductionSurface => ({
    id: descriptor.id,
    owner: { path: "packages/cli/src/registries/packageRegistry.ts", symbol: "loadRegistry", selector: descriptor.entry.selector ?? descriptor.entry.path },
    semanticSelector: packageSemanticSelector(descriptor.entry),
    correction: classAuthority("package").correction,
  }));
  const packageDimensionDescriptors = (dimension: ActivationDimensionId) => packageDescriptors(inputs.package.dimensions[dimension].record);
  const packageCensusSemantics = packageDescriptorSemantics(packageCensusDescriptors);
  const exactPackageSemantics = (dimension: ActivationDimensionId) => JSON.stringify(packageDescriptorSemantics(packageDimensionDescriptors(dimension))) === JSON.stringify(packageCensusSemantics);
  classes.package = {
    surfaces: packageSurfaces,
    dimensions: {
      discovery: evidence(
        "package",
        "discovery",
        packageDimensionDescriptors("discovery").map(({ id }) => id),
        exactPackageSemantics("discovery"),
      ),
      behavior: evidence(
        "package",
        "behavior",
        packageDimensionDescriptors("behavior")
          .filter(({ entry }) => typeof entry.path === "string" && entry.path.length > 0)
          .map(({ id }) => id),
        exactPackageSemantics("behavior") && JSON.stringify(inputs.package.dimensions.behavior.constructionPlan) === JSON.stringify(inputs.package.census.constructionPlan),
      ),
      diagnostics: evidence(
        "package",
        "diagnostics",
        packageDimensionDescriptors("diagnostics")
          .filter(({ id, entry }) => !id.startsWith("generated:") || (entry.classification === "active" && entry.command_authority_reason?.length > 0))
          .map(({ id }) => id),
        exactPackageSemantics("diagnostics"),
      ),
      package_projection: evidence(
        "package",
        "package_projection",
        packageDimensionDescriptors("package_projection").map(({ id }) => id),
        exactPackageSemantics("package_projection"),
      ),
      instructions: evidence(
        "package",
        "instructions",
        packageDimensionDescriptors("instructions")
          .filter(({ entry }) => typeof entry.path === "string" && (typeof entry.selector === "string" || !String(entry.id ?? "").startsWith("version:")))
          .map(({ id }) => id),
        exactPackageSemantics("instructions"),
      ),
      adversarial: evidence(
        "package",
        "adversarial",
        packageDimensionDescriptors("adversarial")
          .filter(({ entry }) => typeof entry.path === "string" && !/[\0\r\n]/.test(entry.selector ?? entry.path))
          .map(({ id }) => id),
        exactPackageSemantics("adversarial"),
      ),
    },
  };

  const bootstrapCensusIds = bootstrapIds(inputs.bootstrap.census);
  const bootstrapSurfaces = surfacesWithClassOwner(bootstrapCensusIds, "bootstrap").map((surface) => ({ ...surface, owner: { ...surface.owner, selector: surface.id } }));
  classes.bootstrap = {
    surfaces: bootstrapSurfaces,
    dimensions: {
      discovery: evidence("bootstrap", "discovery", bootstrapIds(inputs.bootstrap.dimensions.discovery)),
      behavior: evidence("bootstrap", "behavior", bootstrapBehaviorIds(inputs.bootstrap.dimensions.behavior), exactSet(inputs.bootstrap.dimensions.behavior.binderBehavior, bootstrapCensusIds)),
      diagnostics: evidence("bootstrap", "diagnostics", bootstrapDiagnosticIds(inputs.bootstrap.dimensions.diagnostics), JSON.stringify(inputs.bootstrap.dimensions.diagnostics.diagnostics) === JSON.stringify(BOOTSTRAP_REJECTION_SPECS.map(({ id, classification }) => ({ id, classification })))),
      package_projection: evidence(
        "bootstrap",
        "package_projection",
        bootstrapIds(inputs.bootstrap.dimensions.package_projection),
        JSON.stringify(inputs.bootstrap.dimensions.package_projection.extractedClassifications) === JSON.stringify([...BOOTSTRAP_ACCEPTED_SPECS, ...BOOTSTRAP_REJECTION_SPECS].map(({ id, classification }) => ({ id, classification }))),
      ),
      instructions: evidence(
        "bootstrap",
        "instructions",
        bootstrapInstructionIds(inputs.bootstrap.dimensions.instructions),
        exactSet(
          inputs.bootstrap.dimensions.instructions.startupProducers,
          BOOTSTRAP_ACCEPTED_SPECS.map(({ id }) => id),
        ),
      ),
      adversarial: evidence("bootstrap", "adversarial", bootstrapAdversarialIds(inputs.bootstrap.dimensions.adversarial), JSON.stringify(inputs.bootstrap.dimensions.adversarial.invalidCommandResults) === JSON.stringify(BOOTSTRAP_REJECTION_SPECS.map(({ id, classification }) => ({ id, classification })))),
    },
  };

  return structuredClone({ classes });
}

export function activationCensus(evidenceInput: ActivationProductionEvidence): { classes: Record<string, { count: number; sha256: string }>; total: { count: number; sha256: string } } {
  const classes = Object.fromEntries(
    ACTIVATION_CLASSES.map((classId) => {
      const ids = evidenceInput.classes[classId]?.surfaces.map(({ id }) => id) ?? [];
      return [classId, { count: ids.length, sha256: digestIdentities(ids) }];
    }),
  );
  const totalIds = ACTIVATION_CLASSES.flatMap((classId) => (evidenceInput.classes[classId]?.surfaces ?? []).map(({ id }) => `${classId}:${id}`));
  return { classes, total: { count: totalIds.length, sha256: digestIdentities(totalIds) } };
}

export function deriveActivationSurfaces(evidenceInput: ActivationProductionEvidence): ActivationSurfaceRow[] {
  return ACTIVATION_CLASSES.flatMap((classId) => {
    const classEvidence = evidenceInput.classes[classId];
    if (!classEvidence) return [];
    return classEvidence.surfaces.map((surface) => ({
      classId,
      surfaceId: surface.id,
      owner: structuredClone(surface.owner),
      dimensions: ACTIVATION_DIMENSIONS.map((dimension) => {
        const record = classEvidence.dimensions[dimension];
        return { dimension, status: record?.valid === true && record.identities.includes(surface.id) ? ("pass" as const) : ("fail" as const), checkId: `${classId}.${dimension}`, evidenceRef: record?.sourceId ?? "missing" };
      }),
      correction: surface.correction,
    }));
  });
}

function productionTuples(evidenceInput: ActivationProductionEvidence): ActivationCanonicalTuple[] {
  return ACTIVATION_CLASSES.flatMap((classId) =>
    (evidenceInput.classes[classId]?.surfaces ?? []).map((surface) => ({
      class: classId,
      surface_id: surface.id,
      owner_path: surface.owner.path,
      owner_symbol_or_selector: surface.owner.symbol,
      owner_selector: surface.owner.selector ?? null,
      semantic_selector_if_any: surface.semanticSelector ?? null,
      canonical_correction: surface.correction,
    })),
  );
}

function canonicalRows(evidenceInput: ActivationProductionEvidence): ActivationSurfaceRow[] {
  return ACTIVATION_CANONICAL_TUPLES.map((tuple) => ({
    classId: tuple.class,
    surfaceId: tuple.surface_id,
    owner: { path: tuple.owner_path, symbol: tuple.owner_symbol_or_selector, ...(tuple.owner_selector === null ? {} : { selector: tuple.owner_selector }) },
    correction: tuple.canonical_correction,
    dimensions: ACTIVATION_DIMENSIONS.map((dimension) => {
      const record = evidenceInput.classes[tuple.class]?.dimensions[dimension];
      return { dimension, status: record?.valid === true && record.identities.includes(tuple.surface_id) ? ("pass" as const) : ("fail" as const), checkId: `${tuple.class}.${dimension}`, evidenceRef: record?.sourceId ?? "missing" };
    }),
  }));
}

export function discoverActivationSurfaces(root: string): ActivationSurfaceRow[] {
  return deriveActivationSurfaces(collectActivationProductionEvidence(root));
}

function generationViolation(root: string, id: string, generationRoot: string | undefined, contract: ActivationConjunctionContract): string | null {
  if (id.length > contract.bounds.maxGenerationIdCharacters || !GENERATION_ID.test(id)) return "build identity violates the exact SHA-256 grammar or bound";
  if (!generationRoot) return "private build root is missing";
  const actual = path.resolve(generationRoot);
  if (path.basename(actual) !== id) return "private build root does not match its build identity";
  for (const relative of ["dist/.agentera-build-source.json", "bundle/.agentera-build-source.json"]) {
    try {
      if (JSON.parse(fs.readFileSync(path.join(actual, relative), "utf8")).identitySha256 !== id) return "build identity does not match across package surfaces";
    } catch {
      return "build identity is missing from a required package surface";
    }
  }
  return null;
}

function boundedIdentity(surface: ActivationSurfaceRow, contract: ActivationConjunctionContract): string | null {
  const { bounds } = contract;
  if (surface.surfaceId.length > bounds.maxSurfaceIdCharacters || !/^[A-Za-z0-9][A-Za-z0-9._:/\[\]=@-]*$/.test(surface.surfaceId)) return "surface ID violates grammar or bound";
  if (surface.owner.path.length > bounds.maxPathCharacters || !OWNER_PATH.test(surface.owner.path)) return "owner path violates grammar or bound";
  if (surface.owner.symbol.length > bounds.maxSymbolCharacters || !SYMBOL.test(surface.owner.symbol)) return "owner symbol violates grammar or bound";
  if (surface.owner.selector !== undefined && (surface.owner.selector.length === 0 || surface.owner.selector.length > bounds.maxSelectorCharacters || /[\0\r\n]/.test(surface.owner.selector))) return "owner selector violates grammar or bound";
  if (!surface.correction || surface.correction.length > bounds.maxCorrectionCharacters || !/^(?:pnpm|node) [^\0\r\n]+$/.test(surface.correction)) return "correction violates runnable grammar or bound";
  return null;
}

function validateActivationConjunctionUnchecked(inputs: ActivationConjunctionInputs = {}): JsonObject {
  const root = inputs.root ?? resolveSourceRoot();
  if (isNpxBundleRoot(root)) return fixedFailure("source checkout required");
  const contract = inputs.contract ?? loadPackagePublicationModel(root).activationConjunction;
  const generation = inputs.expectedGeneration ?? process.env.AGENTERA_ACTIVATION_GENERATION_ID;
  const generationRoot = inputs.generationRoot ?? process.env.AGENTERA_ACTIVATION_GENERATION_ROOT;
  const expectedEvidenceDigest = inputs.expectedEvidenceDigest ?? process.env.AGENTERA_ACTIVATION_EVIDENCE_DIGEST;
  const expectedPackageIdentity =
    inputs.expectedPackageIdentity ??
    (() => {
      const serialized = process.env.AGENTERA_ACTIVATION_PACKAGE_IDENTITY;
      if (serialized === undefined) return null;
      try {
        return JSON.parse(serialized);
      } catch {
        return serialized;
      }
    })();
  const productionInputs = inputs.productionInputs ?? loadActivationProductionInputs(root, generationRoot);
  const productionEvidence = collectActivationProductionEvidence(root, productionInputs);
  const actualTuples = productionTuples(productionEvidence);
  const expected = canonicalRows(productionEvidence);
  const observed = inputs.surfaces ?? deriveActivationSurfaces(productionEvidence);
  const census = activationCensus(productionEvidence);
  const violations: ActivationViolation[] = [];
  const fallback = classAuthority("package");
  const add = (owner: string, violation: string, correction = fallback.correction) => {
    if (violations.length >= contract.bounds.maxViolations) return;
    const safeViolation = violation.length <= contract.bounds.maxDiagnosticCharacters && !/[\0\r\n]/.test(violation) ? violation : "diagnostic violates the governed bound";
    violations.push({ owner, violation: safeViolation, correction });
  };

  const canonicalByIdentity = new Map(ACTIVATION_CANONICAL_TUPLES.map((tuple) => [`${tuple.class}:${tuple.surface_id}`, tuple]));
  const actualByIdentity = new Map<string, ActivationCanonicalTuple[]>();
  for (const tuple of actualTuples) {
    const key = `${tuple.class}:${tuple.surface_id}`;
    actualByIdentity.set(key, [...(actualByIdentity.get(key) ?? []), tuple]);
  }
  for (const canonical of ACTIVATION_CANONICAL_TUPLES) {
    const key = `${canonical.class}:${canonical.surface_id}`;
    const matches = actualByIdentity.get(key) ?? [];
    if (matches.length !== 1) {
      add(tupleOwnerText(canonical), `${key} canonical tuple is ${matches.length === 0 ? "missing" : "duplicated"}; canonical tuple ${tupleDiagnostic(canonical)}`, canonical.canonical_correction);
    } else if (canonicalTupleJson(matches[0]!) !== canonicalTupleJson(canonical)) {
      add(tupleOwnerText(canonical), `${key} production tuple drifted; canonical tuple ${tupleDiagnostic(canonical)}`, canonical.canonical_correction);
    }
  }
  for (const actual of actualTuples) {
    if (!canonicalByIdentity.has(`${actual.class}:${actual.surface_id}`)) {
      const sameId = ACTIVATION_CANONICAL_TUPLES.find((tuple) => tuple.surface_id === actual.surface_id);
      const canonical = sameId ?? ACTIVATION_CANONICAL_TUPLES.find((tuple) => tuple.class === actual.class) ?? ACTIVATION_CANONICAL_TUPLES[0]!;
      add(tupleOwnerText(canonical), `${actual.class}:${actual.surface_id} is extra or class-reassigned; canonical tuple ${tupleDiagnostic(canonical)}`, canonical.canonical_correction);
    }
  }
  for (const classId of ACTIVATION_CLASSES) {
    const tuples = actualTuples.filter((tuple) => tuple.class === classId);
    const authority = ACTIVATION_TUPLE_AUTHORITY.classes[classId];
    if (tuples.length !== authority.count || digestCanonicalTuples(tuples) !== authority.sha256) {
      const canonical = ACTIVATION_CANONICAL_TUPLES.find((tuple) => tuple.class === classId)!;
      add(tupleOwnerText(canonical), `${classId} tuple digest mismatch: expected ${authority.count}/${authority.sha256}, observed ${tuples.length}/${digestCanonicalTuples(tuples)}; canonical tuple ${tupleDiagnostic(canonical)}`, canonical.canonical_correction);
    }
  }
  if (actualTuples.length !== ACTIVATION_TUPLE_AUTHORITY.total.count || digestCanonicalTuples(actualTuples) !== ACTIVATION_TUPLE_AUTHORITY.total.sha256) {
    const canonical = ACTIVATION_CANONICAL_TUPLES.find((tuple) => tuple.class === "package")!;
    add(tupleOwnerText(canonical), `total tuple digest mismatch: expected ${ACTIVATION_TUPLE_AUTHORITY.total.count}/${ACTIVATION_TUPLE_AUTHORITY.total.sha256}, observed ${actualTuples.length}/${digestCanonicalTuples(actualTuples)}; canonical tuple ${tupleDiagnostic(canonical)}`, canonical.canonical_correction);
  }

  if (!exactSet(contract.classes, ACTIVATION_CLASSES)) add(classOwnerText("package"), "class set differs from code-owned activation authority");
  if (!exactSet(contract.dimensions, ACTIVATION_DIMENSIONS)) add(classOwnerText("package"), "dimension set differs from code-owned activation authority");
  if (!exactSet(contract.checkIds, ACTIVATION_CHECK_IDS)) add(classOwnerText("package"), "check ID set differs from code-owned activation authority");
  for (const classId of ACTIVATION_CLASSES) {
    const canonical = classAuthority(classId);
    const declared = contract.owners[classId];
    if (!declared || declared.path !== canonical.path || declared.symbol !== canonical.symbol || declared.selector !== canonical.selector || declared.correction !== canonical.correction) {
      add(classOwnerText(classId), "class owner or correction differs from code-owned activation authority", canonical.correction);
    }
    const actualCensus = census.classes[classId]!;
    const expectedCensus = ACTIVATION_CENSUS_AUTHORITY.classes[classId];
    if (actualCensus.count !== expectedCensus.count || actualCensus.sha256 !== expectedCensus.sha256) {
      add(classOwnerText(classId), `census closure failed: expected ${expectedCensus.count}/${expectedCensus.sha256}, observed ${actualCensus.count}/${actualCensus.sha256}`, canonical.correction);
    }
    const classEvidence = productionEvidence.classes[classId];
    for (const dimension of ACTIVATION_DIMENSIONS) {
      const record = classEvidence?.dimensions[dimension];
      const expectedSource = ACTIVATION_EVIDENCE_SOURCES[classId][dimension];
      if (!record || record.sourceId !== expectedSource) {
        add(classOwnerText(classId), `${dimension} evidence source is missing or unrecognized`, canonical.correction);
        continue;
      }
      if (!record.valid || record.identities.length !== expectedCensus.count || digestIdentities(record.identities) !== expectedCensus.sha256 || new Set(record.identities).size !== record.identities.length) {
        add(classOwnerText(classId), `${dimension} evidence failed exact identity closure`, canonical.correction);
      }
    }
  }
  if (census.total.count !== ACTIVATION_CENSUS_AUTHORITY.total.count || census.total.sha256 !== ACTIVATION_CENSUS_AUTHORITY.total.sha256) {
    add(classOwnerText("package"), `total census closure failed: expected ${ACTIVATION_CENSUS_AUTHORITY.total.count}/${ACTIVATION_CENSUS_AUTHORITY.total.sha256}, observed ${census.total.count}/${census.total.sha256}`);
  }
  if (observed.length > contract.bounds.maxRows) add(classOwnerText("package"), "surface row count exceeds its bound");
  const expectedById = new Map(expected.map((row) => [`${row.classId}:${row.surfaceId}`, row]));
  const observedIds = observed.map((row) => `${row.classId}:${row.surfaceId}`);
  if (!exactSet([...expectedById.keys()], observedIds)) add(classOwnerText("package"), "retained surface set is missing, duplicate, reassigned, or unknown");
  for (const surface of observed.slice(0, contract.bounds.maxRows)) {
    const expectedSurface = expectedById.get(`${surface.classId}:${surface.surfaceId}`);
    const classId = ACTIVATION_CLASSES.includes(surface.classId as ActivationClassId) ? (surface.classId as ActivationClassId) : undefined;
    if (!classId) {
      add(classOwnerText("package"), "surface has an unknown class");
      continue;
    }
    const canonical = classAuthority(classId);
    const identityFailure = boundedIdentity(surface, contract);
    if (identityFailure) {
      add(classOwnerText(classId), identityFailure, canonical.correction);
      continue;
    }
    const canonicalTuple = canonicalByIdentity.get(`${surface.classId}:${surface.surfaceId}`);
    if (!expectedSurface || ownerText(surface.owner) !== ownerText(expectedSurface.owner) || surface.owner.symbol !== expectedSurface.owner.symbol) {
      add(canonicalTuple ? tupleOwnerText(canonicalTuple) : classOwnerText(classId), `owner does not match the canonical tuple${canonicalTuple ? ` ${tupleDiagnostic(canonicalTuple)}` : ""}`, canonicalTuple?.canonical_correction ?? canonical.correction);
    }
    if (!expectedSurface || surface.correction !== expectedSurface.correction) {
      add(canonicalTuple ? tupleOwnerText(canonicalTuple) : classOwnerText(classId), `correction does not match the canonical tuple${canonicalTuple ? ` ${tupleDiagnostic(canonicalTuple)}` : ""}`, canonicalTuple?.canonical_correction ?? canonical.correction);
    }
    if (
      !exactSet(
        surface.dimensions.map(({ dimension }) => dimension),
        ACTIVATION_DIMENSIONS,
      )
    )
      add(classOwnerText(classId), "dimensions are missing, duplicate, or unknown", canonical.correction);
    for (const dimension of surface.dimensions) {
      const dimensionId = ACTIVATION_DIMENSIONS.includes(dimension.dimension as ActivationDimensionId) ? (dimension.dimension as ActivationDimensionId) : undefined;
      const expectedSource = dimensionId ? ACTIVATION_EVIDENCE_SOURCES[classId][dimensionId] : undefined;
      if (dimension.checkId.length > contract.bounds.maxCheckIdCharacters || dimension.checkId !== `${surface.classId}.${dimension.dimension}` || !ACTIVATION_CHECK_IDS.includes(dimension.checkId)) add(classOwnerText(classId), "check ID is not recognized for this class and dimension", canonical.correction);
      if (!expectedSource || dimension.evidenceRef !== expectedSource) add(classOwnerText(classId), "evidence reference is not recognized for this class and dimension", canonical.correction);
      if (dimension.status !== "pass") add(classOwnerText(classId), `${dimension.dimension} evidence failed`, canonical.correction);
    }
  }
  if (generation) {
    const stale = generationViolation(root, generation, generationRoot, contract);
    if (stale) add("packages/cli/scripts/release-qualification.mjs#runSourceQualificationDag", stale, fallback.correction);
    if (!stale && generationRoot) {
      const snapshotViolations = retainedPackageSnapshotViolations(generationRoot, expectedPackageIdentity);
      for (const violation of snapshotViolations) {
        add("packages/cli/scripts/verify-generated-overlap.mjs#writeActivationEvidence", violation, fallback.correction);
      }
      if (snapshotViolations.length === 0) {
        const manifest = inputs.evidenceManifest ?? readActivationEvidenceManifest(generationRoot);
        for (const violation of activationEvidenceViolations(manifest, { root, generationRoot, generation, productionInputs, expectedManifestDigest: expectedEvidenceDigest ?? "", expectedPackageIdentity })) {
          add("packages/cli/scripts/verify-generated-overlap.mjs#writeActivationEvidence", violation, fallback.correction);
        }
      }
    }
  }
  return report(contract, observed, census, violations, generation, generationRoot);
}

export function validateActivationConjunction(inputs: ActivationConjunctionInputs = {}): JsonObject {
  try {
    return validateActivationConjunctionUnchecked(inputs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = /ENOENT|missing|no (?:such|CLI|package root)/i.test(message) ? "authoritative activation evidence artifact is missing" : /JSON|parse|syntax|malformed/i.test(message) ? "authoritative activation evidence artifact is malformed" : "authoritative activation evidence artifact could not be executed";
    return authoritativeEvidenceFailure(reason);
  }
}

function compactRows(rows: ActivationSurfaceRow[]): JsonObject[] {
  return rows.map((row) => ({ class: row.classId, surface: row.surfaceId, owner: ownerText(row.owner), checks: row.dimensions.map(({ checkId, status }) => [checkId, status]) }));
}
function report(contract: ActivationConjunctionContract, rows: ActivationSurfaceRow[], census: ReturnType<typeof activationCensus>, violations: ActivationViolation[], generation?: string, generationRoot?: string): JsonObject {
  const reportableRows = rows.filter((row) => boundedIdentity(row, contract) === null && row.dimensions.every(({ checkId, evidenceRef }) => checkId.length <= contract.bounds.maxCheckIdCharacters && ACTIVATION_CHECK_IDS.includes(checkId) && evidenceRef.length <= 80));
  const result: JsonObject = {
    schemaVersion: contract.gateIdentity,
    command: "check validate activation-conjunction",
    target_family: "activation-conjunction",
    status: violations.length === 0 ? "pass" : "fail",
    valid: violations.length === 0,
    counts: { classes: ACTIVATION_CLASSES.length, surfaces: rows.length, dimensions: ACTIVATION_DIMENSIONS.length, by_class: Object.fromEntries(ACTIVATION_CLASSES.map((id) => [id, rows.filter((row) => row.classId === id).length])) },
    census,
    evidence_sources: Object.fromEntries(ACTIVATION_CLASSES.flatMap((classId) => ACTIVATION_DIMENSIONS.map((dimension) => [`${classId}.${dimension}`, ACTIVATION_EVIDENCE_SOURCES[classId][dimension]]))),
    provenance: { source: "current-source", package: generation ? "fresh-generation" : "not-required", ...(generation ? { generation } : {}) },
    tuple_authority: ACTIVATION_TUPLE_AUTHORITY as unknown as JsonObject,
    evidence_manifest:
      generation && generationRoot
        ? {
            schema: "agentera.activationEvidence.v1",
            path: `private-build/${generation}/${ACTIVATION_EVIDENCE_FILE}`,
            digest: (() => {
              const manifest = readActivationEvidenceManifest(generationRoot) as any;
              return typeof manifest?.manifestDigest === "string" ? manifest.manifestDigest : null;
            })(),
          }
        : null,
    rows: compactRows(reportableRows.slice(0, contract.bounds.maxRows)),
    violation_count: violations.length,
    violations: violations as unknown as JsonObject[],
    side_effects: { activation: false, publication: false, receipt: false, candidate: false, registry: false },
  };
  return Buffer.byteLength(JSON.stringify(result), "utf8") <= contract.bounds.maxOutputBytes ? result : fixedFailure("bounded activation report exceeded its serialized output limit");
}
function fixedFailure(reason: "source checkout required" | "bounded activation report exceeded its serialized output limit"): JsonObject {
  return {
    schemaVersion: "agentera.activationConjunction.v1",
    command: "check validate activation-conjunction",
    target_family: "activation-conjunction",
    status: "fail",
    valid: false,
    rows: [],
    violation_count: 1,
    violations: [{ owner: "packages/cli/src/validate/activationConjunction.ts#activationConjunctionMain", violation: reason, correction: "node packages/cli/dist/bin/agentera.js check validate activation-conjunction" }],
    side_effects: { activation: false, publication: false, receipt: false, candidate: false, registry: false },
  };
}
function authoritativeEvidenceFailure(reason: string): JsonObject {
  return {
    schemaVersion: "agentera.activationConjunction.v1",
    command: "check validate activation-conjunction",
    target_family: "activation-conjunction",
    status: "fail",
    valid: false,
    rows: [],
    violation_count: 1,
    violations: [{ owner: "packages/cli/scripts/verify-generated-overlap.mjs#writeActivationEvidence", violation: reason, correction: ACTIVATION_CLASS_AUTHORITIES.package.correction }],
    side_effects: { activation: false, publication: false, receipt: false, candidate: false, registry: false },
  };
}
export function activationConjunctionMain(options: ActivationConjunctionInputs & { out?: (text: string) => void } = {}): number {
  let result = validateActivationConjunction(options);
  let serialized = `${JSON.stringify(result)}\n`;
  const maximum = options.contract?.bounds.maxOutputBytes ?? 196_608;
  if (Buffer.byteLength(serialized, "utf8") > maximum) {
    result = fixedFailure("bounded activation report exceeded its serialized output limit");
    serialized = `${JSON.stringify(result)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > maximum) throw new Error("internal fixed activation fallback exceeds output bound");
  }
  (options.out ?? ((text) => process.stdout.write(text)))(serialized);
  return result.valid === true ? 0 : 1;
}
