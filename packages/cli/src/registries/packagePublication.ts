import fs from "node:fs";
import path from "node:path";

export const ACTIVATION_CLASSES = [
  "cli", "capability", "runtime", "reference", "state", "package", "bootstrap",
] as const;
export type ActivationClassId = (typeof ACTIVATION_CLASSES)[number];

export const ACTIVATION_DIMENSIONS = [
  "discovery", "behavior", "diagnostics", "package_projection", "instructions", "adversarial",
] as const;
export type ActivationDimensionId = (typeof ACTIVATION_DIMENSIONS)[number];

export interface ActivationClassAuthority {
  readonly path: string;
  readonly symbol: string;
  readonly selector?: string;
  readonly correction: string;
}
export interface ActivationCensusIdentity { readonly count: number; readonly sha256: string }

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** Code-owned identity that the publication document must project exactly. */
export const ACTIVATION_CLASS_AUTHORITIES: Readonly<Record<ActivationClassId, ActivationClassAuthority>> = deepFreeze({
  cli: {
    path: "packages/cli/src/cli/dispatch/commands.ts", symbol: "DISPATCHER_TOP_LEVEL_COMMANDS",
    correction: "pnpm -C packages/cli test:source -- test/cli/activationConjunction.test.ts",
  },
  capability: {
    path: "packages/cli/src/capabilities/index.ts", symbol: "CAPABILITY_INSTRUCTIONS",
    correction: "pnpm -C packages/cli test:source -- test/cli/activationConjunction.test.ts",
  },
  runtime: {
    path: "packages/cli/src/runtime/lifecycleAuthority.ts", symbol: "loadLifecycleAuthority",
    correction: "pnpm -C packages/cli test:source -- test/runtime/runtimeLifecycle.test.ts",
  },
  reference: {
    path: "packages/cli/src/validate/retainedReferenceAuthority.ts", symbol: "validateRetainedReferenceAuthority",
    correction: "node packages/cli/dist/bin/agentera.js check validate retained-references --format json",
  },
  state: {
    path: "packages/cli/src/state/write/runtimeOperations.ts", symbol: "runtimeOperationSpecs",
    correction: "node packages/cli/dist/bin/agentera.js check validate state --format json",
  },
  package: {
    path: "packages/cli/src/registries/packageRegistry.ts", symbol: "loadRegistry",
    correction: "pnpm -C packages/cli run verify:package",
  },
  bootstrap: {
    path: "packages/cli/src/validate/bootstrapAuthority.ts", symbol: "bootstrapMatrixAuthority",
    correction: "pnpm -C packages/cli test:source -- test/cli/runtimeBootstrapMatrix.test.ts",
  },
});

/** SHA-256 uses the sorted exact UTF-8 identities joined by one LF byte. */
export const ACTIVATION_CENSUS_AUTHORITY: Readonly<{
  algorithm: "sha256(sorted_utf8_ids_joined_by_lf)";
  classes: Readonly<Record<ActivationClassId, ActivationCensusIdentity>>;
  total: ActivationCensusIdentity;
}> = deepFreeze({
  algorithm: "sha256(sorted_utf8_ids_joined_by_lf)",
  classes: {
    cli: { count: 27, sha256: "986a637f5c11c57ab7a897a01bd291d0811846e5339c3831c715932cf9659ad4" },
    capability: { count: 12, sha256: "007e1157a892fec54182b1803aeaa442cf8e2e332e6a055c3bd020e2b0731867" },
    runtime: { count: 81, sha256: "03fe600a3a27f05daf0d1b59c16b00bedc354a13c70ea60be0b457175fdf743c" },
    reference: { count: 22, sha256: "2b48c82bb7ee10388d9ebb4fa7ea3743ea82a7e9aaedfcd5a858eeedb9d891ae" },
    state: { count: 38, sha256: "7ab0dd6ef1b1b1ce66bd9ea94d1de3d542528233e928a44102e289bf12416681" },
    package: { count: 66, sha256: "3548af7e84151c90690a6eb3d1cb6c7847f39b290161ecab599d8cb1bf0d2cb0" },
    bootstrap: { count: 34, sha256: "71c2038744e2518a6adb722acbb5f9352bddfb5d1c92eeb0e347297ef2ca2f1e" },
  },
  total: { count: 280, sha256: "051ed9a57857a39e11ed8fb583bff9d2a67a306c5ab897a0ee829212468bc23a" },
});

/** Each dimension names the production contract it observes independently. */
export const ACTIVATION_EVIDENCE_SOURCES: Readonly<Record<ActivationClassId, Readonly<Record<ActivationDimensionId, string>>>> = deepFreeze({
  cli: { discovery: "cli.dispatcher-inventory", behavior: "cli.dispatch-handler-registry", diagnostics: "cli.command-diagnostic-registry", package_projection: "cli.schema-dispatcher-projection", instructions: "cli.public-help-declaration", adversarial: "cli.invalid-shape-command-authority" },
  capability: { discovery: "capability.instruction-registry", behavior: "capability.route-handler-registry", diagnostics: "capability.schema-contract-directories", package_projection: "capability.packaged-registry-projection", instructions: "capability.served-instruction-targets", adversarial: "capability.registry-schema-closure" },
  runtime: { discovery: "runtime.lifecycle-retirement-loader", behavior: "runtime.cleanup-behavior-records", diagnostics: "runtime.retired-diagnostic-expansion", package_projection: "runtime.packaged-authority-loaders", instructions: "runtime.lifecycle-declaration-records", adversarial: "runtime.retirement-shape-authority" },
  reference: { discovery: "reference.retained-inventory", behavior: "reference.production-consumers", diagnostics: "reference.authority-entry-validation", package_projection: "reference.packaged-retained-inventory", instructions: "reference.consumer-runbook-contracts", adversarial: "reference.owner-command-shape-authority" },
  state: { discovery: "state.read-write-runtime-registries", behavior: "state.read-write-dispatch-contracts", diagnostics: "state.recovery-and-bound-contracts", package_projection: "state.schema-discovery-projections", instructions: "state.help-and-example-projections", adversarial: "state.input-and-output-bound-authorities" },
  package: { discovery: "package.registry-surface-records", behavior: "package.construction-classification-records", diagnostics: "package.generated-surface-classifications", package_projection: "package.packaged-registry-projection", instructions: "package.identity-and-selector-contracts", adversarial: "package.selector-shape-authority" },
  bootstrap: { discovery: "bootstrap.matrix-axis-registry", behavior: "bootstrap.acceptance-execution-specs", diagnostics: "bootstrap.rejection-classification-specs", package_projection: "bootstrap.packaged-matrix-authority", instructions: "bootstrap.state-applicability-contracts", adversarial: "bootstrap.invalid-command-classification-authority" },
});

export const ACTIVATION_CHECK_IDS = Object.freeze(ACTIVATION_CLASSES.flatMap((classId) =>
  ACTIVATION_DIMENSIONS.map((dimension) => `${classId}.${dimension}`)));
export const SOURCE_GATE_IDS = [
  "source", "stress", "performance", "capacity", "package", "generated-overlap", "typecheck", "build",
  "compact", "capability-contract", "activation-conjunction",
] as const;
export const SOURCE_DAG_PHASES = {
  batchA: ["generated-overlap", "stress", "typecheck"],
  performanceBarrier: ["performance"],
  capacityBarrier: ["capacity"],
  barrierB: ["compact", "capability-contract", "activation-conjunction"],
  generatedOverlapOrigins: ["source", "package", "build", "generated-overlap"],
} as const;
export interface ActivationOwnerContract {
  path: string;
  symbol: string;
  selector?: string;
  correction: string;
}

export interface ActivationConjunctionContract {
  gateIdentity: string;
  classes: string[];
  dimensions: string[];
  checkIds: string[];
  bounds: {
    maxRows: number;
    maxViolations: number;
    maxDiagnosticCharacters: number;
    maxOutputBytes: number;
    maxGenerationIdCharacters: number;
    maxPathCharacters: number;
    maxSymbolCharacters: number;
    maxSelectorCharacters: number;
    maxCorrectionCharacters: number;
    maxCheckIdCharacters: number;
    maxSurfaceIdCharacters: number;
  };
  owners: Record<string, ActivationOwnerContract>;
  census: {
    algorithm: string;
    classes: Record<string, ActivationCensusIdentity>;
    total: ActivationCensusIdentity;
  };
}

export interface SourceGateContract {
  name: string;
  command: string[];
  owner: string;
  correction: string;
}

export interface ReleaseReadinessContract {
  schemaVersion: "agentera.releaseReadiness.v1";
  component: "release-readiness";
  adapter: "development";
  command: string;
  phases: ["source-readiness", "metadata-review", "candidate-readiness"];
  receipts: {
    source: "source-receipt.json";
    candidate: "candidate-receipt.json";
  };
  reuse: string;
  metadataReview: string;
  outcomes: ["paused", "ready", "rejected"];
  exitCodes: {
    paused: 0;
    ready: 0;
    rejected: 1;
  };
}

export interface PackagePublicationModel {
  sourceGates: SourceGateContract[];
  sourceDag: {
    batchA: string[];
    performanceBarrier: string[];
    capacityBarrier: string[];
    barrierB: string[];
    generatedOverlapOrigins: string[];
    overlapCleanupMarginMs: number;
    overlapParentReconciliationMarginMs: number;
    minimumExecutionWindowMs: Record<string, number>;
  };
  sourceQualificationMs: number;
  readiness: ReleaseReadinessContract;
  activationConjunction: ActivationConjunctionContract;
}

const EXACT_COMMANDS: Record<string, readonly string[]> = {
  source: ["pnpm", "-C", "packages/cli", "run", "test:source"],
  stress: ["pnpm", "-C", "packages/cli", "run", "test:stress"],
  performance: ["pnpm", "-C", "packages/cli", "run", "test:performance"],
  capacity: ["pnpm", "-C", "packages/cli", "run", "test:capacity"],
  package: ["pnpm", "-C", "packages/cli", "run", "verify:package"],
  "generated-overlap": ["pnpm", "-C", "packages/cli", "run", "verify:generated-overlap"],
  typecheck: ["pnpm", "-C", "packages/cli", "run", "typecheck"],
  build: ["pnpm", "-C", "packages/cli", "build"],
  compact: ["node", "packages/cli/dist/bin/agentera.js", "check", "compact"],
  "capability-contract": ["node", "packages/cli/dist/bin/agentera.js", "check", "validate", "capability-contract", "--format", "json"],
  "activation-conjunction": ["node", "packages/cli/dist/bin/agentera.js", "check", "validate", "activation-conjunction", "--format", "json"],
};

function fail(message: string): never { throw new Error(`package publication contract: ${message}`); }
function exactList(value: unknown, expected: readonly string[], label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) fail(`${label} must be a string list`);
  if (value.length !== new Set(value).size) fail(`${label} contains duplicates`);
  if (value.length !== expected.length || value.some((entry, index) => entry !== expected[index])) fail(`${label} must exactly match governed order`);
  return [...value] as string[];
}
function positiveInteger(value: unknown, label: string, maximum = 1_000_000): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) fail(`${label} must be a bounded positive integer`);
  return value as number;
}
function boundedText(value: unknown, label: string, maximum: number, grammar: RegExp): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || !grammar.test(value)) fail(`${label} is invalid`);
  return value;
}
function exactCommand(value: unknown, expected: readonly string[], label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 12) fail(`${label} must be a bounded nonempty command`);
  const command = value.map((token, index) => boundedText(token, `${label}[${index}]`, 160, /^[^\s\0-\x1f\x7f]+$/));
  if (command.length !== expected.length || command.some((token, index) => token !== expected[index])) fail(`${label} does not match its governed command`);
  return command;
}

function exactCensusIdentity(value: any, expected: ActivationCensusIdentity, label: string): ActivationCensusIdentity {
  if (!value || Object.keys(value).sort().join("\0") !== "count\0sha256") fail(`${label} must contain exact count and sha256 fields`);
  if (value.count !== expected.count || value.sha256 !== expected.sha256) {
    fail(`${label} must equal count ${expected.count} and sha256 ${expected.sha256}`);
  }
  return { count: expected.count, sha256: expected.sha256 };
}

/** Validate the sole publication authority against behavior-owned exact sets and grammar. */
export function validatePackagePublicationDocument(raw: any): PackagePublicationModel {
  if (raw?.schemaVersion !== "agentera.packagePublication.v2") fail("schemaVersion is invalid");
  const source = raw?.qualification?.source;
  const readiness = raw?.qualification?.readiness;
  const activation = source?.activationConjunction;
  if (!source || !activation || activation.gateIdentity !== "agentera.activationConjunction.v1") fail("source activation conjunction is missing or invalid");
  if (
    !readiness
    || readiness.schemaVersion !== "agentera.releaseReadiness.v1"
    || readiness.component !== "release-readiness"
    || readiness.adapter !== "development"
  ) fail("release readiness authority is missing or invalid");
  const readinessCommand = boundedText(
    readiness.command,
    "release readiness command",
    320,
    /^node packages\/cli\/scripts\/release-readiness\.mjs development --candidate-dir DIR --target-version VERSION --source-commit COMMIT \[--metadata-commit COMMIT\] \[--json\]$/,
  );
  const readinessPhases = exactList(
    readiness.phases,
    ["source-readiness", "metadata-review", "candidate-readiness"],
    "release readiness phases",
  ) as ReleaseReadinessContract["phases"];
  if (
    !readiness.receipts
    || Object.keys(readiness.receipts).sort().join("\0") !== "candidate\0source"
    || readiness.receipts.source !== "source-receipt.json"
    || readiness.receipts.candidate !== "candidate-receipt.json"
  ) fail("release readiness receipts must name the governed source and candidate receipts");
  const readinessReuse = boundedText(
    readiness.reuse,
    "release readiness reuse rule",
    1200,
    /^[^\0\r\n]+$/,
  );
  const readinessMetadataReview = boundedText(
    readiness.metadataReview,
    "release readiness metadata review rule",
    1200,
    /^[^\0\r\n]+$/,
  );
  const readinessOutcomes = exactList(
    readiness.outcomes,
    ["paused", "ready", "rejected"],
    "release readiness outcomes",
  ) as ReleaseReadinessContract["outcomes"];
  if (
    !readiness.exitCodes
    || Object.keys(readiness.exitCodes).sort().join("\0") !== "paused\0ready\0rejected"
    || readiness.exitCodes.paused !== 0
    || readiness.exitCodes.ready !== 0
    || readiness.exitCodes.rejected !== 1
  ) fail("release readiness exit codes must map paused and ready to 0 and rejected to 1");

  if (!Array.isArray(source.gates) || source.gates.length !== SOURCE_GATE_IDS.length) fail(`source gates must contain exactly ${SOURCE_GATE_IDS.length} entries`);
  const sourceGates = source.gates.map((gate: any, index: number): SourceGateContract => {
    const name = SOURCE_GATE_IDS[index];
    if (!gate || gate.name !== name) fail(`source gate ${index} must be '${name}'`);
    const command = exactCommand(gate.command, EXACT_COMMANDS[name]!, `gate ${name} command`);
    const owner = boundedText(gate.owner, `gate ${name} owner`, 240, /^packages\/cli\/(?:src\/.+\.ts|scripts\/.+\.mjs|package\.json)#[A-Za-z0-9_.-]+$/);
    const correction = boundedText(gate.correction, `gate ${name} correction`, 320, /^(?:pnpm|node) [^\0\r\n]+$/);
    if (correction !== command.join(" ")) fail(`gate ${name} correction must equal its command`);
    return { name, command, owner, correction };
  });

  const dag = source.dag;
  const batchA = exactList(dag?.batchA, SOURCE_DAG_PHASES.batchA, "source batch A");
  const performanceBarrier = exactList(dag?.performanceBarrier, SOURCE_DAG_PHASES.performanceBarrier, "source performance barrier");
  const capacityBarrier = exactList(dag?.capacityBarrier, SOURCE_DAG_PHASES.capacityBarrier, "source capacity barrier");
  const barrierB = exactList(dag?.barrierB, SOURCE_DAG_PHASES.barrierB, "source barrier B");
  const generatedOverlapOrigins = exactList(dag?.generatedOverlapOrigins, SOURCE_DAG_PHASES.generatedOverlapOrigins, "generated overlap origins");
  const phases = [...batchA, ...performanceBarrier, ...capacityBarrier, ...barrierB];
  if (phases.length !== new Set(phases).size) fail("source execution phases must be disjoint");
  const scheduled = new Set([...phases, ...generatedOverlapOrigins]);
  if (scheduled.size !== SOURCE_GATE_IDS.length || SOURCE_GATE_IDS.some((name) => !scheduled.has(name))) fail("source schedule must cover every gate exactly through its declared origin");
  const minimumExecutionWindowMs: Record<string, number> = {};
  if (!dag?.minimumExecutionWindowMs || Object.keys(dag.minimumExecutionWindowMs).length !== barrierB.length) fail("barrier B minimum execution windows must exactly match barrier B");
  for (const name of barrierB) minimumExecutionWindowMs[name] = positiveInteger(dag.minimumExecutionWindowMs[name], `${name} minimum execution window`, 120_000);

  const classes = exactList(activation.classes, ACTIVATION_CLASSES, "activation classes");
  const dimensions = exactList(activation.dimensions, ACTIVATION_DIMENSIONS, "activation dimensions");
  const checkIds = exactList(activation.checkIds, ACTIVATION_CHECK_IDS, "activation check IDs");
  if (!activation.owners || Object.keys(activation.owners).join("\0") !== classes.join("\0")) fail("activation owners must exactly match ordered classes");
  const owners: Record<string, ActivationOwnerContract> = {};
  for (const classId of classes) {
    const owner = activation.owners[classId];
    if (!owner) fail(`activation owner '${classId}' is missing`);
    const canonical = ACTIVATION_CLASS_AUTHORITIES[classId as keyof typeof ACTIVATION_CLASS_AUTHORITIES];
    const expectedFields = ["path", "symbol", ...(canonical.selector ? ["selector"] : []), "correction"].sort();
    if (Object.keys(owner).sort().join("\0") !== expectedFields.join("\0")
      || owner.path !== canonical.path
      || owner.symbol !== canonical.symbol
      || owner.selector !== canonical.selector
      || owner.correction !== canonical.correction) {
      fail(`activation owner '${classId}' must equal ${canonical.path}#${canonical.selector ?? canonical.symbol}; correction: ${canonical.correction}`);
    }
    owners[classId] = {
      path: boundedText(owner.path, `${classId} owner path`, 240, /^packages\/cli\/(?:src\/.+\.ts|scripts\/.+\.mjs)$/),
      symbol: boundedText(owner.symbol, `${classId} owner symbol`, 120, /^[A-Za-z_$][A-Za-z0-9_.$-]*$/),
      ...(owner.selector ? { selector: boundedText(owner.selector, `${classId} owner selector`, 240, /^[^\0\r\n]+$/) } : {}),
      correction: boundedText(owner.correction, `${classId} correction`, 320, /^(?:pnpm|node) [^\0\r\n]+$/),
    };
  }
  const census = activation.census;
  if (!census || Object.keys(census).sort().join("\0") !== "algorithm\0classes\0total"
    || census.algorithm !== ACTIVATION_CENSUS_AUTHORITY.algorithm) fail("activation census authority is missing or invalid");
  if (!census.classes || Object.keys(census.classes).join("\0") !== classes.join("\0")) fail("activation census classes must exactly match ordered classes");
  const censusClasses: Record<string, ActivationCensusIdentity> = {};
  for (const classId of classes) {
    censusClasses[classId] = exactCensusIdentity(census.classes[classId], ACTIVATION_CENSUS_AUTHORITY.classes[classId as keyof typeof ACTIVATION_CENSUS_AUTHORITY.classes], `activation census '${classId}'`);
  }
  const censusTotal = exactCensusIdentity(census.total, ACTIVATION_CENSUS_AUTHORITY.total, "activation census total");
  const boundNames = ["maxRows", "maxViolations", "maxDiagnosticCharacters", "maxOutputBytes", "maxGenerationIdCharacters", "maxPathCharacters", "maxSymbolCharacters", "maxSelectorCharacters", "maxCorrectionCharacters", "maxCheckIdCharacters", "maxSurfaceIdCharacters"] as const;
  if (!activation.bounds || Object.keys(activation.bounds).sort().join("\0") !== [...boundNames].sort().join("\0")) fail("activation bounds must contain the exact governed fields");
  const bounds = Object.fromEntries(boundNames.map((name) => [name, positiveInteger(activation.bounds[name], `activation bounds.${name}`, name === "maxOutputBytes" ? 262_144 : 100_000)])) as ActivationConjunctionContract["bounds"];
  if (bounds.maxOutputBytes > 196_608) fail("activation output bound must retain 25 percent headroom");

  return {
    sourceGates,
    sourceDag: {
      batchA, performanceBarrier, capacityBarrier, barrierB, generatedOverlapOrigins,
      overlapCleanupMarginMs: positiveInteger(dag.overlapCleanupMarginMs, "overlap cleanup margin", 60_000),
      overlapParentReconciliationMarginMs: positiveInteger(dag.overlapParentReconciliationMarginMs, "parent reconciliation margin", 60_000),
      minimumExecutionWindowMs,
    },
    sourceQualificationMs: positiveInteger(raw?.benchmark?.timeouts?.sourceQualificationMs, "source qualification timeout", 900_000),
    readiness: {
      schemaVersion: readiness.schemaVersion,
      component: readiness.component,
      adapter: readiness.adapter,
      command: readinessCommand,
      phases: readinessPhases,
      receipts: {
        source: readiness.receipts.source,
        candidate: readiness.receipts.candidate,
      },
      reuse: readinessReuse,
      metadataReview: readinessMetadataReview,
      outcomes: readinessOutcomes,
      exitCodes: {
        paused: readiness.exitCodes.paused,
        ready: readiness.exitCodes.ready,
        rejected: readiness.exitCodes.rejected,
      },
    },
    activationConjunction: {
      gateIdentity: activation.gateIdentity, classes, dimensions, checkIds, bounds, owners,
      census: { algorithm: ACTIVATION_CENSUS_AUTHORITY.algorithm, classes: censusClasses, total: censusTotal },
    },
  };
}

export function loadPackagePublicationModel(root: string): PackagePublicationModel {
  const file = path.join(root, "references/adapters/package-publication.json");
  return validatePackagePublicationDocument(JSON.parse(fs.readFileSync(file, "utf8")));
}
