import fs from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DISPATCHER_TOP_LEVEL_COMMANDS } from "../../src/cli/dispatch/commands.js";
import { printTopLevelHelp } from "../../src/cli/help.js";
import { cmdSchema } from "../../src/cli/commands/schema.js";
import {
  ACTIVATION_CENSUS_AUTHORITY,
  ACTIVATION_CLASSES,
  ACTIVATION_CLASS_AUTHORITIES,
  ACTIVATION_DIMENSIONS,
  ACTIVATION_EVIDENCE_SOURCES,
  ACTIVATION_CANONICAL_TUPLES,
  ACTIVATION_TUPLE_AUTHORITY,
  canonicalTupleJson,
  type ActivationClassId,
} from "../../src/registries/activationContract.js";
import { loadPackagePublicationModel } from "../../src/registries/packagePublication.js";
import {
  installRetainedPackageSnapshot,
  observationDigest,
  observeCurrentPackageArtifact,
} from "../../src/validate/activationArtifactEvidence.js";
import {
  activationCensus,
  activationConjunctionMain,
  collectActivationProductionEvidence,
  deriveActivationSurfaces,
  loadActivationProductionInputs,
  validateActivationConjunction,
  type ActivationProductionInputs,
} from "../../src/validate/activationConjunction.js";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const model = loadPackagePublicationModel(ROOT);
const productionInputs = loadActivationProductionInputs(ROOT);
const baseline = (): ActivationProductionInputs => structuredClone(productionInputs);
const validate = (inputs = baseline()) => validateActivationConjunction({ root: ROOT, productionInputs: inputs });
const authorityFailure = (result: any, classId: ActivationClassId, fragment?: string) => {
  const authority = ACTIVATION_CLASS_AUTHORITIES[classId];
  expect(result.status).toBe("fail");
  expect(result.violations).toContainEqual(expect.objectContaining({
    owner: `${authority.path}#${authority.selector ?? authority.symbol}`,
    correction: authority.correction,
    ...(fragment ? { violation: expect.stringContaining(fragment) } : {}),
  }));
};

function omitUsage(inputs: ActivationProductionInputs): void {
  const cli = inputs.classes.cli;
  cli.census.commands = cli.census.commands.filter((id: string) => id !== "usage");
  cli.dimensions.discovery.commands = cli.dimensions.discovery.commands.filter((id: string) => id !== "usage");
  cli.dimensions.behavior.dispatchSource = cli.dimensions.behavior.dispatchSource.replace(/\s*case "usage":\s*return runUsage\([^;]+;/, "");
  cli.dimensions.diagnostics.commands = cli.dimensions.diagnostics.commands.filter((id: string) => id !== "usage");
  cli.dimensions.diagnostics.runtimeDiagnosticCommands = cli.dimensions.diagnostics.runtimeDiagnosticCommands.filter((id: string) => id !== "usage");
  cli.dimensions.package_projection.commands = cli.dimensions.package_projection.commands.filter((id: string) => id !== "usage");
  cli.dimensions.instructions.helpText = cli.dimensions.instructions.helpText.replace(",usage,", ",");
  cli.dimensions.instructions.declaredCommands = cli.dimensions.instructions.declaredCommands.filter((id: string) => id !== "usage");
  cli.dimensions.adversarial.commands = cli.dimensions.adversarial.commands.filter((id: string) => id !== "usage");
}

function omitDesign(inputs: ActivationProductionInputs): void {
  const capability = inputs.classes.capability;
  delete capability.census.instructions.design;
  delete capability.dimensions.discovery.instructions.design;
  capability.dimensions.behavior.routes = capability.dimensions.behavior.routes.filter((id: string) => id !== "design");
  capability.dimensions.diagnostics.schemaDirectories = capability.dimensions.diagnostics.schemaDirectories.filter((id: string) => id !== "design");
  capability.dimensions.package_projection.capabilities = capability.dimensions.package_projection.capabilities.filter((id: string) => id !== "design");
  capability.dimensions.instructions.targets = capability.dimensions.instructions.targets.filter(({ id }: any) => id !== "design");
  for (const field of ["registryCapabilities", "schemaDirectories", "instructionNames", "aliases"]) {
    capability.dimensions.adversarial[field] = capability.dimensions.adversarial[field].filter((id: string) => id !== "design");
  }
}

describe("activation conjunction", () => {
  it("closes the exact code-owned class and total census", () => {
    const evidence = collectActivationProductionEvidence(ROOT, baseline());
    expect(activationCensus(evidence)).toEqual({ classes: ACTIVATION_CENSUS_AUTHORITY.classes, total: ACTIVATION_CENSUS_AUTHORITY.total });
    const result = validate();
    expect(result.status).toBe("pass");
    expect((result.counts as any)).toMatchObject({ classes: 7, surfaces: 304, dimensions: 6 });
  });

  it("recomputes every immutable canonical tuple count and digest independently", () => {
    const digest = (values: string[]) => createHash("sha256").update(values.sort().join("\n")).digest("hex");
    for (const classId of ACTIVATION_CLASSES) {
      const tuples = ACTIVATION_CANONICAL_TUPLES.filter((tuple) => tuple.class === classId).map(canonicalTupleJson);
      expect({ count: tuples.length, sha256: digest(tuples) }).toEqual(ACTIVATION_TUPLE_AUTHORITY.classes[classId]);
    }
    expect({ count: ACTIVATION_CANONICAL_TUPLES.length, sha256: digest(ACTIVATION_CANONICAL_TUPLES.map(canonicalTupleJson)) })
      .toEqual(ACTIVATION_TUPLE_AUTHORITY.total);
  });

  it("rejects the three exact audit tuple-authority probes", () => {
    const tupleFailure = (result: any, classId: ActivationClassId, surfaceId: string) => {
      const tuple = ACTIVATION_CANONICAL_TUPLES.find((candidate) => candidate.class === classId && candidate.surface_id === surfaceId)!;
      expect(result.violations).toContainEqual(expect.objectContaining({
        owner: `${tuple.owner_path}#${tuple.owner_selector ?? tuple.owner_symbol_or_selector}`,
        correction: tuple.canonical_correction,
        violation: expect.stringContaining("production tuple drifted"),
      }));
    };
    const referenceOwner = baseline();
    const first = referenceOwner.classes.reference.census.inventory.find((entry: any) => entry.production_owner);
    const second = referenceOwner.classes.reference.census.inventory.find((entry: any) => entry.production_owner && entry.path !== first.path);
    first.production_owner = structuredClone(second.production_owner);
    tupleFailure(validate(referenceOwner), "reference", first.path);

    const packageSelector = baseline();
    for (const input of [packageSelector.classes.package.census, ...Object.values(packageSelector.classes.package.dimensions)] as any[]) {
      input.record.version_surfaces.surfaces.find((entry: any) => entry.id === "registry").selector = "skills[0].name";
    }
    tupleFailure(validate(packageSelector), "package", "version:registry");

    const coordinatedReference = baseline();
    for (const input of [coordinatedReference.classes.reference.census, ...Object.values(coordinatedReference.classes.reference.dimensions)] as any[]) {
      const entry = input.inventory.find((candidate: any) => candidate.production_owner);
      entry.production_owner = structuredClone(second.production_owner);
    }
    tupleFailure(validate(coordinatedReference), "reference", first.path);

    const coordinatedReason = baseline();
    for (const input of [coordinatedReason.classes.package.census, ...Object.values(coordinatedReason.classes.package.dimensions)] as any[]) {
      input.record.bootstrap_command_authority.emitted_producers[0].reason = "coordinated reason drift";
    }
    tupleFailure(validate(coordinatedReason), "package", `emitted:${coordinatedReason.classes.package.census.record.bootstrap_command_authority.emitted_producers[0].path}`);
  });

  it("rejects a valid-looking wrong owner and correction in every class", () => {
    for (const classId of ACTIVATION_CLASSES) {
      const rows = deriveActivationSurfaces(collectActivationProductionEvidence(ROOT, baseline()));
      const row = rows.find((candidate) => candidate.classId === classId)!;
      row.owner = { path: "packages/cli/src/cli/help.ts", symbol: "printTopLevelHelp", selector: "valid-selector" };
      row.correction = "pnpm -C packages/cli run typecheck";
      const result = validateActivationConjunction({ root: ROOT, productionInputs: baseline(), surfaces: rows });
      expect(result.status).toBe("fail");
      expect(result.violations).toEqual(expect.arrayContaining([
        expect.objectContaining({ violation: expect.stringContaining("canonical tuple"), correction: ACTIVATION_CANONICAL_TUPLES.find((tuple) => tuple.class === classId)!.canonical_correction }),
      ]));
    }
  });

  it("binds capability body evidence independently", () => {
    const probes: Array<(inputs: ActivationProductionInputs) => void> = [
      (inputs) => { inputs.classes.capability.census.instructions.design += "source drift"; },
      (inputs) => { inputs.classes.capability.dimensions.behavior.servedInstructions.design += "served drift"; },
      (inputs) => { inputs.classes.capability.dimensions.diagnostics.generatedInstructions.design += "generated drift"; },
      (inputs) => { inputs.classes.capability.dimensions.package_projection.packagedInstructions.design += "package drift"; },
      (inputs) => { inputs.classes.capability.dimensions.adversarial.registryCapabilities[0] = "wrong-name"; },
      (inputs) => { inputs.classes.capability.dimensions.behavior.routes.pop(); },
      (inputs) => { inputs.classes.capability.dimensions.diagnostics.schemaDirectories.pop(); },
    ];
    for (const mutate of probes) { const inputs = baseline(); mutate(inputs); authorityFailure(validate(inputs), "capability"); }
    const coordinatedBlank = baseline();
    const capability = coordinatedBlank.classes.capability;
    capability.census.instructions.design = "";
    capability.dimensions.discovery.instructions.design = "";
    capability.dimensions.behavior.servedInstructions.design = "";
    capability.dimensions.diagnostics.generatedInstructions.design = "";
    capability.dimensions.package_projection.packagedInstructions.design = "";
    capability.dimensions.instructions.servedInstructions.design = "";
    capability.dimensions.adversarial.instructionBodies.design = "";
    authorityFailure(validate(coordinatedBlank), "capability");
  });

  it("binds package and bootstrap independent behavior records", () => {
    const probes: Array<[ActivationClassId, (inputs: ActivationProductionInputs) => void]> = [
      ["package", (inputs) => { inputs.classes.package.census.record.version_surfaces.surfaces[0].path = "wrong.json"; }],
      ["package", (inputs) => { inputs.classes.package.dimensions.behavior.constructionPlan[0].path = "wrong.json"; }],
      ["package", (inputs) => { inputs.classes.package.dimensions.diagnostics.record.bundle_surfaces.generated_files[0].classification = "stale"; }],
      ["package", (inputs) => { inputs.classes.package.dimensions.package_projection.record.bundle_surfaces.files.pop(); }],
      ["package", (inputs) => { inputs.classes.package.dimensions.instructions.record.version_surfaces.surfaces[0].selector = "skills[0].name"; }],
      ["package", (inputs) => { inputs.classes.package.dimensions.adversarial.record.bundle_surfaces.files.pop(); }],
      ["bootstrap", (inputs) => { inputs.classes.bootstrap.dimensions.discovery.runtimeIds[0] = "wrong"; }],
      ["bootstrap", (inputs) => { inputs.classes.bootstrap.dimensions.behavior.binderBehavior.pop(); }],
      ["bootstrap", (inputs) => { inputs.classes.bootstrap.dimensions.package_projection.extractedClassifications[0].classification = "malformed"; }],
      ["bootstrap", (inputs) => { inputs.classes.bootstrap.dimensions.diagnostics.diagnostics[0].classification = "accepted"; }],
      ["bootstrap", (inputs) => { inputs.classes.bootstrap.dimensions.instructions.startupProducers.pop(); }],
      ["bootstrap", (inputs) => { inputs.classes.bootstrap.dimensions.adversarial.invalidCommandResults[0].classification = "accepted"; }],
    ];
    for (const [classId, mutate] of probes) { const inputs = baseline(); mutate(inputs); authorityFailure(validate(inputs), classId); }
  });

  it.each([
    ["missing emitted reason", (entry: any) => { delete entry.reason; }],
    ["changed emitted reason", (entry: any) => { entry.reason = "changed"; }],
    ["changed generated classification", (entry: any) => { entry.classification = "stale"; }],
    ["changed generated path", (entry: any) => { entry.path = "wrong.json"; }],
    ["changed generated format", (entry: any) => { entry.format = "yaml"; }],
  ])("binds package projection semantic parity for %s", (_label, mutate) => {
    const inputs = baseline();
    const projection = inputs.classes.package.dimensions.package_projection.record;
    const entry = _label.includes("emitted")
      ? projection.bootstrap_command_authority.emitted_producers[0]
      : projection.bundle_surfaces.generated_files[0];
    mutate(entry);
    authorityFailure(validate(inputs), "package");
  });

  it("uses 42 recognized independent production evidence identities", () => {
    const evidence = collectActivationProductionEvidence(ROOT, baseline());
    const sourceIds = ACTIVATION_CLASSES.flatMap((classId) => ACTIVATION_DIMENSIONS.map((dimension) => {
      const record = evidence.classes[classId]!.dimensions[dimension]!;
      expect(record.sourceId).toBe(ACTIVATION_EVIDENCE_SOURCES[classId][dimension]);
      expect({ count: record.identities.length, sha256: activationCensus({ classes: {
        ...evidence.classes,
        [classId]: { ...evidence.classes[classId]!, surfaces: record.identities.map((id) => ({ id, owner: { path: "x", symbol: "x" }, correction: "x" })) },
      } }).classes[classId]!.sha256 }).toEqual(ACTIVATION_CENSUS_AUTHORITY.classes[classId]);
      return record.sourceId;
    }));
    expect(new Set(sourceIds).size).toBe(42);
    const rows = deriveActivationSurfaces(evidence);
    expect(rows.every((row) => row.dimensions.every((check) => check.checkId === `${row.classId}.${check.dimension}` && check.evidenceRef === (ACTIVATION_EVIDENCE_SOURCES as any)[row.classId][check.dimension]))).toBe(true);
  });

  it("projects the exact dispatcher independently through help and schema", () => {
    expect(printTopLevelHelp()).toContain(`{${DISPATCHER_TOP_LEVEL_COMMANDS.join(",")}}`);
    let output = "";
    expect(cmdSchema({ format: "json" }, { out: (text) => { output += text; } })).toBe(0);
    expect(JSON.parse(output).dispatcher_top_level.commands).toEqual(DISPATCHER_TOP_LEVEL_COMMANDS);
  });

  it.each([
    ["discovery", (inputs: ActivationProductionInputs) => { inputs.classes.cli.dimensions.discovery.commands.pop(); }],
    ["behavior", (inputs: ActivationProductionInputs) => { inputs.classes.cli.dimensions.behavior.dispatchSource = inputs.classes.cli.dimensions.behavior.dispatchSource.replace(/\s*case "usage":\s*return runUsage\([^;]+;/, ""); }],
    ["diagnostics", (inputs: ActivationProductionInputs) => { inputs.classes.cli.dimensions.diagnostics.runtimeDiagnosticCommands.pop(); }],
    ["package_projection", (inputs: ActivationProductionInputs) => { inputs.classes.cli.dimensions.package_projection.commands.pop(); }],
    ["instructions", (inputs: ActivationProductionInputs) => { inputs.classes.cli.dimensions.instructions.helpText = inputs.classes.cli.dimensions.instructions.helpText.replace(",usage,", ","); }],
    ["adversarial", (inputs: ActivationProductionInputs) => { inputs.classes.cli.dimensions.adversarial.commands.pop(); }],
  ] as const)("fails independent %s production evidence", (dimension, mutate) => {
    const inputs = baseline();
    mutate(inputs);
    authorityFailure(validate(inputs), "cli", `${dimension} evidence failed exact identity closure`);
  });

  it.each([
    ["CLI runtime command handler", "cli", "behavior", (inputs: ActivationProductionInputs) => {
      inputs.classes.cli.dimensions.behavior.dispatchSource = inputs.classes.cli.dimensions.behavior.dispatchSource.replace(/\s*case "usage":\s*return runUsage\([^;]+;/, "");
    }],
    ["capability instruction route", "capability", "behavior", (inputs: ActivationProductionInputs) => {
      inputs.classes.capability.dimensions.behavior.routes = inputs.classes.capability.dimensions.behavior.routes.filter((id: string) => id !== "design");
    }],
    ["runtime lifecycle/retired loader", "runtime", "behavior", (inputs: ActivationProductionInputs) => {
      inputs.classes.runtime.dimensions.behavior.retired.diagnosticResources.pop();
    }],
    ["retained-reference consumer", "reference", "behavior", (inputs: ActivationProductionInputs) => {
      const entry = inputs.classes.reference.dimensions.behavior.inventory.find((candidate: any) => candidate.classification !== "runbook");
      entry.consumers = [];
    }],
    ["state recovery contract", "state", "diagnostics", (inputs: ActivationProductionInputs) => {
      inputs.classes.state.dimensions.diagnostics.operations[0].projection.recovery.runtime = "";
    }],
    ["package generated classification", "package", "diagnostics", (inputs: ActivationProductionInputs) => {
      inputs.classes.package.dimensions.diagnostics.record.bundle_surfaces.generated_files[0].classification = "stale";
    }],
    ["bootstrap rejection class", "bootstrap", "diagnostics", (inputs: ActivationProductionInputs) => {
      inputs.classes.bootstrap.dimensions.diagnostics.rejections[0].classification = "accepted";
    }],
  ] as const)("fails a real %s production-input mutation", (_label, classId, dimension, mutate) => {
    const inputs = baseline();
    mutate(inputs);
    authorityFailure(validate(inputs), classId, `${dimension} evidence failed exact identity closure`);
  });

  it("fails the exact coordinated usage omission instead of shrinking CLI", () => {
    const inputs = baseline();
    omitUsage(inputs);
    const result = validate(inputs);
    authorityFailure(result, "cli", "census closure failed");
    expect((result.counts as any).surfaces).toBe(303);
  });

  it("fails the exact coordinated design omission instead of shrinking capabilities", () => {
    const inputs = baseline();
    omitDesign(inputs);
    const result = validate(inputs);
    authorityFailure(result, "capability", "census closure failed");
    expect((result.counts as any).by_class.capability).toBe(11);
  });

  it("rejects count-preserving replacement, extra identity, class reassignment, and digest drift", () => {
    const replacement = baseline();
    replacement.classes.cli.census.commands[replacement.classes.cli.census.commands.indexOf("usage")] = "bogus";
    authorityFailure(validate(replacement), "cli", "census closure failed");

    const extra = baseline();
    extra.classes.package.census.record.version_surfaces.surfaces.push({ id: "extra", path: "registry.json", selector: "version" });
    authorityFailure(validate(extra), "package", "census closure failed");

    const extraDimensionEvidence = baseline();
    extraDimensionEvidence.classes.cli.dimensions.discovery.commands.push("extra");
    authorityFailure(validate(extraDimensionEvidence), "cli", "discovery evidence failed exact identity closure");

    const reassigned = baseline();
    reassigned.classes.cli.census.commands = reassigned.classes.cli.census.commands.filter((id: string) => id !== "usage");
    reassigned.classes.capability.census.instructions.usage = "replacement";
    const reassignedResult = validate(reassigned);
    authorityFailure(reassignedResult, "cli", "census closure failed");
    authorityFailure(reassignedResult, "capability", "census closure failed");
    authorityFailure(reassignedResult, "package", "total census closure failed");

    const drift = baseline();
    drift.classes.state.census.readFamilies[0].key = "replacement";
    authorityFailure(validate(drift), "state", "census closure failed");
  });

  it("covers owner/consumer/runbook, state read/write/bound, package record/projection, and bootstrap axis mutations", () => {
    const probes: Array<[ActivationClassId, (inputs: ActivationProductionInputs) => void]> = [
      ["reference", (inputs) => { inputs.classes.reference.dimensions.instructions.inventory.find((entry: any) => entry.classification === "runbook").command = ""; }],
      ["reference", (inputs) => { inputs.classes.reference.dimensions.adversarial.inventory.find((entry: any) => entry.production_owner).production_owner.module = "wrong"; }],
      ["runtime", (inputs) => { inputs.classes.runtime.dimensions.instructions.lifecycle.canonicalSkillPath = ""; }],
      ["capability", (inputs) => { inputs.classes.capability.dimensions.instructions.targets.find(({ id }: any) => id === "design").sha256 = "bad"; }],
      ["capability", (inputs) => { inputs.classes.capability.dimensions.diagnostics.schemaDirectories.pop(); }],
      ["capability", (inputs) => { inputs.classes.capability.dimensions.package_projection.capabilities.pop(); }],
      ["state", (inputs) => { inputs.classes.state.census.readFamilies.pop(); }],
      ["state", (inputs) => { inputs.classes.state.census.operations.pop(); }],
      ["state", (inputs) => { inputs.classes.state.dimensions.adversarial.bounds.minimum = 0; }],
      ["package", (inputs) => { inputs.classes.package.census.record.bundle_surfaces.files[0].id = "changed"; }],
      ["package", (inputs) => { inputs.classes.package.dimensions.package_projection.record.bundle_surfaces.files.pop(); }],
      ["bootstrap", (inputs) => { inputs.classes.bootstrap.census.runtimeIds.pop(); }],
    ];
    for (const [classId, mutate] of probes) {
      const inputs = baseline();
      mutate(inputs);
      authorityFailure(validate(inputs), classId);
    }
  });

  it("rejects wrong row owner, selector, correction, evidence reference, and class assignment with canonical recovery", () => {
    const rows = deriveActivationSurfaces(collectActivationProductionEvidence(ROOT, baseline()));
    rows[0]!.owner = { path: "packages/cli/src/cli/help.ts", symbol: "printTopLevelHelp" };
    rows[1]!.owner.selector = "wrong-selector";
    rows[2]!.correction = "pnpm -C packages/cli run typecheck";
    rows[3]!.dimensions[0]!.evidenceRef = "cli.wrong";
    rows[4]!.classId = "capability";
    const result = validateActivationConjunction({ root: ROOT, productionInputs: baseline(), surfaces: rows });
    authorityFailure(result, "cli");
    expect(result.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ violation: expect.stringContaining("owner does not match the canonical tuple") }),
      expect.objectContaining({ violation: expect.stringContaining("correction does not match the canonical tuple") }),
      expect.objectContaining({ violation: "evidence reference is not recognized for this class and dimension" }),
      expect.objectContaining({ violation: "retained surface set is missing, duplicate, reassigned, or unknown" }),
    ]));
  });

  it.each([
    ["owner path", (rows: any[]) => { rows[0].owner.path = `packages/cli/src/${"x".repeat(250)}.ts`; }],
    ["owner symbol", (rows: any[]) => { rows[0].owner.symbol = "x".repeat(121); }],
    ["owner selector", (rows: any[]) => { rows[0].owner.selector = "x".repeat(241); }],
    ["correction", (rows: any[]) => { rows[0].correction = `node ${"x".repeat(321)}`; }],
    ["surface ID", (rows: any[]) => { rows[0].surfaceId = "x".repeat(241); }],
    ["check ID", (rows: any[]) => { rows[0].dimensions[0].checkId = "x".repeat(81); }],
  ])("rejects an overlong %s without serializing it", (_label, mutate) => {
    const rows = deriveActivationSurfaces(collectActivationProductionEvidence(ROOT, baseline()));
    mutate(rows);
    const serialized = JSON.stringify(validateActivationConjunction({ root: ROOT, productionInputs: baseline(), surfaces: rows }));
    expect(JSON.parse(serialized).status).toBe("fail");
    expect(serialized.length).toBeLessThan(model.activationConjunction.bounds.maxOutputBytes);
    expect(serialized).not.toContain("x".repeat(121));
  });

  it("bounds many violations and emits compact output with 25 percent headroom", () => {
    const rows = deriveActivationSurfaces(collectActivationProductionEvidence(ROOT, baseline()));
    for (const row of rows) for (const dimension of row.dimensions) dimension.status = "fail";
    let output = "";
    expect(activationConjunctionMain({ root: ROOT, productionInputs: baseline(), surfaces: rows, out: (text) => { output += text; } })).toBe(1);
    const result = JSON.parse(output);
    expect(result.violation_count).toBe(model.activationConjunction.bounds.maxViolations);
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(196_608);
  });

  it("rejects overlong and path-varied generation provenance", () => {
    expect(validateActivationConjunction({ root: ROOT, productionInputs: baseline(), expectedGeneration: "x".repeat(65) }).status).toBe("fail");
    expect(validateActivationConjunction({ root: ROOT, productionInputs: baseline(), expectedGeneration: "1".repeat(64), generationRoot: path.join(ROOT, "elsewhere") }).status).toBe("fail");
  });

  it("rejects a fully re-signed manifest after the retained package snapshot changes", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-retained-package-"));
    const generation = "1".repeat(64);
    const generationRoot = path.join(temporaryRoot, "private-build", generation);
    try {
      const inputRoot = path.join(temporaryRoot, "input");
      const inputPackage = path.join(inputRoot, "package");
      fs.mkdirSync(inputPackage, { recursive: true });
      fs.writeFileSync(path.join(inputPackage, "package.json"), "{\"name\":\"agentera\",\"version\":\"3.0.0-dev.42\"}\n");
      fs.writeFileSync(path.join(inputPackage, "payload.txt"), "retained package payload\n");
      const tarball = path.join(temporaryRoot, "agentera-3.0.0-dev.42.tgz");
      expect(spawnSync("tar", ["-czf", tarball, "-C", inputRoot, "package"]).status).toBe(0);
      const extractionRoot = path.join(temporaryRoot, "initial-extraction");
      fs.mkdirSync(extractionRoot);
      expect(spawnSync("tar", ["-xzf", tarball, "-C", extractionRoot]).status).toBe(0);
      const sourceSnapshot = path.join(temporaryRoot, "package-parent-snapshot");
      const observed = observeCurrentPackageArtifact(tarball, path.join(extractionRoot, "package"), sourceSnapshot);
      const unsignedIdentity = {
        schemaVersion: "agentera.activationPackageIdentity.v1" as const,
        packageEvidenceDigest: "1".repeat(64),
        packageArtifact: {
          filename: observed.filename,
          integrity: observed.integrity,
          shasum: observed.shasum,
          tarballSha256: observed.tarballSha256,
        },
        packageArtifactObservationDigest: "2".repeat(64),
        extractedTree: { count: observed.extractedTree.entries.length, digest: observed.extractedTree.digest },
        tarballTree: { count: observed.tarballTree.entries.length, digest: observed.tarballTree.digest },
      };
      const packageIdentity = { ...unsignedIdentity, identityDigest: observationDigest(unsignedIdentity) };

      for (const relative of ["", "dist", "bundle"]) fs.mkdirSync(path.join(generationRoot, relative), { recursive: true });
      for (const relative of ["dist/.agentera-build-source.json", "bundle/.agentera-build-source.json"]) {
        fs.writeFileSync(path.join(generationRoot, relative), `${JSON.stringify({ identitySha256: generation })}\n`);
      }
      installRetainedPackageSnapshot(sourceSnapshot, generationRoot, packageIdentity);

      const retainedRoot = path.join(generationRoot, ".activation-package-snapshot");
      fs.appendFileSync(path.join(retainedRoot, "package.tgz"), "post-finalization mutation");
      fs.writeFileSync(path.join(retainedRoot, "extracted", "unobserved-addition.txt"), "post-finalization addition\n");

      const attackedTarball = fs.readFileSync(path.join(retainedRoot, "package.tgz"));
      const attackedArtifact = {
        filename: observed.filename,
        integrity: `sha512-${createHash("sha512").update(attackedTarball).digest("base64")}`,
        shasum: createHash("sha1").update(attackedTarball).digest("hex"),
        tarballSha256: createHash("sha256").update(attackedTarball).digest("hex"),
      };
      const signedProducer = (producerKind: string, schemaVersion: string, packageIntegrity: string | null) => {
        const unsigned = {
          schemaVersion,
          producerKind,
          sourceDigest: "3".repeat(64),
          generation: producerKind === "generated-owner" ? generation : null,
          packageIntegrity,
          records: {},
        };
        return { ...unsigned, evidenceDigest: observationDigest(unsigned) };
      };
      const unsignedManifest = {
        schemaVersion: "agentera.activationEvidence.v1",
        generation,
        currentSourceDigest: "3".repeat(64),
        packageArtifact: attackedArtifact,
        tupleDigest: ACTIVATION_TUPLE_AUTHORITY.total.sha256,
        producers: {
          source: signedProducer("source-owner", "agentera.activationSourceOwnerEvidence.v1", null),
          generated: signedProducer("generated-owner", "agentera.activationGeneratedOwnerEvidence.v1", null),
          package: signedProducer("package-owner", "agentera.activationPackageOwnerEvidence.v1", attackedArtifact.integrity),
        },
        capabilityParityDigest: "4".repeat(64),
        packageSemanticParityDigest: "5".repeat(64),
        checks: [],
      };
      const resignedManifest = { ...unsignedManifest, manifestDigest: observationDigest(unsignedManifest) };
      fs.writeFileSync(path.join(generationRoot, "activation-evidence.json"), `${JSON.stringify(resignedManifest)}\n`);

      const result = validateActivationConjunction({
        root: temporaryRoot,
        contract: model.activationConjunction,
        productionInputs: baseline(),
        expectedGeneration: generation,
        generationRoot,
        evidenceManifest: resignedManifest,
        expectedEvidenceDigest: resignedManifest.manifestDigest,
        expectedPackageIdentity: packageIdentity,
      }) as any;
      expect(result).toMatchObject({
        status: "fail",
        violation_count: 1,
        violations: [{
          owner: "packages/cli/scripts/verify-generated-overlap.mjs#writeActivationEvidence",
          violation: "retained package snapshot differs from the independently retained package identity",
          correction: "pnpm -C packages/cli run verify:package",
        }],
      });
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("uses a fixed bounded source-only package failure", () => {
    const packageBundle = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-activation-package-"));
    try {
      fs.mkdirSync(path.join(packageBundle, "references/adapters"), { recursive: true });
      fs.mkdirSync(path.join(packageBundle, "skills/agentera"), { recursive: true });
      fs.copyFileSync(path.join(ROOT, "references/adapters/package-publication.json"), path.join(packageBundle, "references/adapters/package-publication.json"));
      fs.writeFileSync(path.join(packageBundle, ".agentera-npx-bundle.json"), "{}\n");
      fs.writeFileSync(path.join(packageBundle, "registry.json"), "{}\n");
      fs.writeFileSync(path.join(packageBundle, "skills/agentera/SKILL.md"), "---\nname: agentera\n---\n");
      const result = validateActivationConjunction({ root: packageBundle });
      expect(result).toMatchObject({ status: "fail", violations: [expect.objectContaining({ violation: "source checkout required" })] });
      expect(JSON.stringify(result)).not.toContain(packageBundle);
    } finally { fs.rmSync(packageBundle, { recursive: true, force: true }); }
  });
});
