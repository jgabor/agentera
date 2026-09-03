import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertProtectedRootAuthority,
  assertCompleteCompositeRows,
  assertRuntimeMatrixExecutionRegistry,
  EXPECTED_COMPOSITE_ROW_COUNT,
  EXPECTED_COMPOSITE_ROW_SHA256,
  PROTECTED_ROOT_IDENTIFIERS,
  PROTECTED_ROOT_AUTHORITY_COUNT,
  PROTECTED_ROOT_AUTHORITY_SHA256,
  physicalIdentity,
  RUNTIME_MATRIX_AUTHORITY_SHA256,
  runRuntimeBootstrapMatrix,
  runtimeMatrixExecutionRegistry,
  type ProtectedRootPaths,
  type RuntimeMatrixExecutionRegistry,
} from "../helpers/runtimeBootstrapMatrix.js";
import { DEVELOPMENT_RUNTIME_REQUIRED_FILES } from "../../src/core/developmentInvocation.js";
import {
  activationSourceDigest,
  canonicalObservationJson,
  createGeneratedOwnerEvidence,
  createSourceOwnerEvidence,
  finalizePackageOwnerEvidence,
  installRetainedPackageSnapshot,
  observeCurrentPackageArtifact,
  observationDigest,
  OWNER_EVIDENCE_MAX_BYTES,
  PACKAGE_OWNER_EVIDENCE_SCHEMA,
  readContentAddressedOwnerEvidence,
  readContentAddressedPackageIdentity,
  writeContentAddressedOwnerEvidence,
  writeContentAddressedPackageIdentity,
} from "../../src/validate/activationArtifactEvidence.js";
import { activationEvidenceManifestViolations, activationEvidenceViolations, assembleAndValidateActivationEvidence, createActivationEvidenceManifest } from "../../src/validate/activationEvidenceManifest.js";
import { collectActivationProductionEvidence, loadActivationProductionInputs, validateActivationConjunction } from "../../src/validate/activationConjunction.js";
import { createPackageFixture, type PackageFixture } from "../packaging/packageSetup.js";

let fixture: PackageFixture;
let cleanupPackageFixture: (() => void) | undefined;
const CHECKOUT_ROOT = path.resolve(import.meta.dirname, "../../../..");
const RELEASE_EVIDENCE_RUN = Boolean(process.env.AGENTERA_ACTIVATION_SOURCE_EVIDENCE_OUTPUT);
let matrixSummary: ReturnType<typeof runRuntimeBootstrapMatrix> | undefined;

beforeAll(async () => {
  ({ fixture, cleanup: cleanupPackageFixture } = await createPackageFixture());
});

afterAll(() => cleanupPackageFixture?.());

function rootEntries(paths: ProtectedRootPaths): Array<readonly [string, string]> {
  return [
    ["project", paths.project],
    ["home", paths.home],
    ["shared_skill", paths.sharedSkill],
    ["install", paths.install],
    ["package", paths.package],
    ["package_artifact", paths.tarball],
    ["cache", paths.cache],
    ["temporary", paths.temporary],
    ["absence", paths.priorAbsence],
  ];
}

describe("source-owned runtime bootstrap integration", () => {
  it("rejects protected-root and execution-registry origin mutations against fixed authorities", () => {
    expect(PROTECTED_ROOT_IDENTIFIERS).toEqual(["project", "home", "shared_skill", "install", "package", "package_artifact", "cache", "temporary", "absence"]);
    expect(PROTECTED_ROOT_AUTHORITY_COUNT).toBe(9);
    expect(PROTECTED_ROOT_AUTHORITY_SHA256).toBe("031fd076c396b44b31fb1d923245976a0d3b2fe1e0037de3ee4b711a08c8fd6e");
    expect(EXPECTED_COMPOSITE_ROW_COUNT).toBe(190);
    expect(EXPECTED_COMPOSITE_ROW_SHA256).toBe("dd3b04ddd46c487b3f0056a16b1b9225fad61cd25988fa907a10520fc41a5da7");
    expect(RUNTIME_MATRIX_AUTHORITY_SHA256).toBe("d8af8891a8dfa27618ecd165989f635c252caae46a7f93abe2503cf546f2d73c");

    const proofRoot = fs.mkdtempSync(path.join(fixture.root, "protected-root-authority-"));
    const paths: ProtectedRootPaths = {
      project: path.join(proofRoot, "project"),
      home: path.join(proofRoot, "home"),
      sharedSkill: path.join(proofRoot, "home/.agents/skills/agentera"),
      install: path.join(proofRoot, "install"),
      package: path.join(proofRoot, "package"),
      tarball: path.join(proofRoot, "agentera.tgz"),
      cache: path.join(proofRoot, "cache"),
      temporary: path.join(proofRoot, "temporary"),
      priorAbsence: path.join(proofRoot, "prior-absence"),
    };
    for (const directory of [paths.project, paths.home, paths.sharedSkill, paths.install, paths.package, paths.cache, paths.temporary]) fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(paths.tarball, "tarball");
    const roots = rootEntries(paths);
    expect(() => assertProtectedRootAuthority(roots, paths)).not.toThrow();

    const substitute = path.join(proofRoot, "substitute");
    fs.mkdirSync(substitute);
    const substituted = roots.map((entry) => (entry[0] === "package" ? ([entry[0], substitute] as const) : entry));
    expect(() => assertProtectedRootAuthority(substituted, paths)).toThrow(/substituted its fixed physical authority/);

    const realParent = path.join(proofRoot, "real-parent");
    fs.mkdirSync(realParent);
    expect(physicalIdentity(path.join(realParent, "absent"))).toBe(path.join(realParent, "absent"));
    const brokenAlias = path.join(proofRoot, "broken-alias");
    fs.symlinkSync(path.join(proofRoot, "missing-target"), brokenAlias, "dir");
    expect(() => physicalIdentity(`${brokenAlias}${path.sep}..`)).toThrow(/cannot resolve symlink/);

    expect(() => assertRuntimeMatrixExecutionRegistry(runtimeMatrixExecutionRegistry())).not.toThrow();
    const incompleteRegistry: RuntimeMatrixExecutionRegistry = runtimeMatrixExecutionRegistry();
    incompleteRegistry.rejections.pop();
    expect(() => assertRuntimeMatrixExecutionRegistry(incompleteRegistry)).toThrow();
  });

  it("smokes accepted startup and wrong-channel rejection with protected-root preservation", { timeout: 120_000 }, () => {
    if (RELEASE_EVIDENCE_RUN) return;
    const summary = runRuntimeBootstrapMatrix(fixture, CHECKOUT_ROOT, { bounded: true });
    expect(summary.runtimeCounts).toEqual({
      source: { accepted: 1, rejected: 1 },
      package: { accepted: 1, rejected: 1 },
    });
    expect(summary.rows).toHaveLength(4);
    expect(summary.rows.every((row) => row.preservationRoots === 9)).toBe(true);
    expect(summary.childStartRejections).toBe(0);
  });

  it.skipIf(!RELEASE_EVIDENCE_RUN)("preserves every protected root and rejects the governed runtime matrix before child start", { timeout: 300_000 }, () => {
    const summary = runRuntimeBootstrapMatrix(fixture, CHECKOUT_ROOT);
    matrixSummary = summary;
    expect(summary.runtimeCounts).toEqual({
      source: { accepted: 15, rejected: 80 },
      package: { accepted: 15, rejected: 80 },
    });
    expect(summary.stateCounts).toEqual({
      clean: { accepted: 8, rejected: 40 },
      v2: { accepted: 8, rejected: 40 },
      partial: { accepted: 8, rejected: 40 },
      v3: { accepted: 6, rejected: 40 },
    });
    expect(summary.preservationRootsPerRow).toBe(9);
    expect(summary.rows.every((row) => row.preservationRoots === 9)).toBe(true);
    expect(summary.childStartRejections).toBe(0);
    expect(summary.rows.filter((row) => !row.accepted)).toHaveLength(160);
    expect(summary.rows).toHaveLength(190);
    expect(summary.rows.filter((row) => row.id === "recovery-0")).toHaveLength(6);
    expect(summary.rows.filter((row) => row.id === "prime-quoted-lf")).toHaveLength(2);
    expect(summary.rows.filter((row) => row.id === "prime-quoted-cr")).toHaveLength(2);

    expect(() => assertCompleteCompositeRows(summary.rows, summary.expectedCompositeRowIds)).not.toThrow();
    expect(() => assertCompleteCompositeRows(summary.rows.slice(1), summary.expectedCompositeRowIds)).toThrow(/incomplete/);
    const duplicateRow = summary.rows.map((row, index) => (index === summary.rows.length - 1 ? summary.rows[0] : row));
    expect(() => assertCompleteCompositeRows(duplicateRow, summary.expectedCompositeRowIds)).toThrow(/unique/);
    const coordinatedOmission = [...summary.expectedCompositeRowIds];
    coordinatedOmission[0] = "source/clean/coordinated-replacement";
    expect(() => assertCompleteCompositeRows(summary.rows, coordinatedOmission)).toThrow(/authority count or digest drifted/);
    expect(summary.authority).toEqual({
      protectedRootCount: 9,
      protectedRootDigest: PROTECTED_ROOT_AUTHORITY_SHA256,
      compositeRowCount: 190,
      compositeRowDigest: EXPECTED_COMPOSITE_ROW_SHA256,
      matrixDigest: RUNTIME_MATRIX_AUTHORITY_SHA256,
    });
  });

  it("rejects missing source and package surfaces before the CLI boundary", { timeout: 240_000 }, async () => {
    const dispatcher = path.join(CHECKOUT_ROOT, "packages/cli/test/helpers/preCutoverBootstrapMissingSurfaceDispatcher.mjs");
    const project = path.join(fixture.root, "missing surface project");
    fs.mkdirSync(project);
    expect(DEVELOPMENT_RUNTIME_REQUIRED_FILES).toHaveLength(8);
    const requiredFiles = RELEASE_EVIDENCE_RUN ? DEVELOPMENT_RUNTIME_REQUIRED_FILES : DEVELOPMENT_RUNTIME_REQUIRED_FILES.slice(0, 1);
    let batches = 0;
    const missingSurfaceResults: unknown[] = [];
    for (const [runtime, root] of Object.entries({
      source: fixture.constructionRoot,
      package: fixture.packageRoot,
    })) {
      batches += 1;
      const result = spawnSync(process.execPath, [dispatcher, root, JSON.stringify(requiredFiles)], {
        cwd: project,
        env: process.env,
        encoding: "utf8",
        shell: false,
      });
      expect(result.status, runtime).toBe(0);
      const observations = JSON.parse(result.stdout);
      expect(observations, runtime).toHaveLength(requiredFiles.length);
      for (const observation of observations) {
        expect(observation.status, `${runtime}/${observation.relative}`).toBe(64);
        expect(observation.classification, `${runtime}/${observation.relative}`).toBe("invalid_authority");
        expect(observation.childStarted, `${runtime}/${observation.relative}`).toBe(false);
        expect(observation.restored, `${runtime}/${observation.relative}`).toBe(true);
        missingSurfaceResults.push({ runtime, ...observation });
      }
    }
    expect(batches).toBe(2);
    expect(missingSurfaceResults).toHaveLength(requiredFiles.length * 2);
    if (!RELEASE_EVIDENCE_RUN) return;
    expect(matrixSummary).toBeDefined();
    const productionInputs = loadActivationProductionInputs(CHECKOUT_ROOT, fixture.constructionRoot);
    const sourceEvidence = createSourceOwnerEvidence(CHECKOUT_ROOT, productionInputs, {
      fixture,
      runtimeSummary: matrixSummary!,
      missingSurfaceResults,
    });
    const sourceOutput = process.env.AGENTERA_ACTIVATION_SOURCE_EVIDENCE_OUTPUT;
    if (sourceOutput) {
      expect(writeContentAddressedOwnerEvidence(sourceOutput, sourceEvidence).digest).toBe(sourceEvidence.evidenceDigest);
    }
    const finalized = await finalizePackageOwnerEvidence({
      root: CHECKOUT_ROOT,
      fixture,
      requiredFiles: DEVELOPMENT_RUNTIME_REQUIRED_FILES,
    });
    const { evidence, packageIdentity } = finalized;
    const expectedSecondManifestFiles = [...fixture.pathIndependence.secondManifest.files].map(({ path: file, size, mode }) => ({ path: file, size, mode })).sort((left, right) => left.path.localeCompare(right.path));
    const portabilityFiles = (evidence.records["package.portability"].content as any).secondManifest.files;
    expect(portabilityFiles).toEqual({
      count: expectedSecondManifestFiles.length,
      digest: observationDigest(expectedSecondManifestFiles),
    });
    expect(Array.isArray(portabilityFiles)).toBe(false);
    const evidenceBytes = Buffer.byteLength(`${canonicalObservationJson(evidence)}\n`, "utf8");
    expect(evidenceBytes).toBeLessThanOrEqual(OWNER_EVIDENCE_MAX_BYTES);
    expect(OWNER_EVIDENCE_MAX_BYTES - evidenceBytes).toBeGreaterThanOrEqual(16_384);
    expect(evidence).toMatchObject({
      schemaVersion: PACKAGE_OWNER_EVIDENCE_SCHEMA,
      producerKind: "package-owner",
      packageIntegrity: fixture.manifest.integrity,
    });
    expect(packageIdentity).toMatchObject({
      packageEvidenceDigest: evidence.evidenceDigest,
      packageArtifact: {
        integrity: `sha512-${createHash("sha512")
          .update(fs.readFileSync(path.join(fixture.root, fixture.manifest.filename)))
          .digest("base64")}`,
        shasum: createHash("sha1")
          .update(fs.readFileSync(path.join(fixture.root, fixture.manifest.filename)))
          .digest("hex"),
        tarballSha256: createHash("sha256")
          .update(fs.readFileSync(path.join(fixture.root, fixture.manifest.filename)))
          .digest("hex"),
      },
    });
    const retainedProbe = path.join(fixture.root, "retained-package-identity-probe");
    const retainedEvidenceDirectory = path.join(retainedProbe, "evidence");
    const retainedIdentityDirectory = path.join(retainedProbe, "identity");
    writeContentAddressedOwnerEvidence(retainedEvidenceDirectory, evidence);
    writeContentAddressedPackageIdentity(retainedIdentityDirectory, packageIdentity);
    expect(readContentAddressedOwnerEvidence(retainedEvidenceDirectory, "package-owner").evidenceDigest).toBe(evidence.evidenceDigest);
    expect(readContentAddressedPackageIdentity(retainedIdentityDirectory)).toEqual(packageIdentity);
    expect(() => readContentAddressedPackageIdentity(path.join(retainedProbe, "missing-identity"))).toThrow(/package identity is missing/);
    fs.rmSync(retainedProbe, { recursive: true, force: true });

    const generation = fixture.sourceIdentity.identitySha256;
    const generatedEvidence = await createGeneratedOwnerEvidence({
      root: CHECKOUT_ROOT,
      generationRoot: fixture.constructionRoot,
      generation,
      productionInputs,
    });
    const manifest = createActivationEvidenceManifest({
      root: CHECKOUT_ROOT,
      generation,
      productionEvidence: collectActivationProductionEvidence(CHECKOUT_ROOT, productionInputs),
      sourceEvidence,
      generatedEvidence,
      packageEvidence: evidence,
    });
    expect(activationEvidenceManifestViolations(manifest, manifest)).toEqual([]);

    let sourceObservations = 0;
    let generatedObservations = 0;
    const mutablePackageEvidence = structuredClone(evidence);
    const assembledResult = assembleAndValidateActivationEvidence({
      root: CHECKOUT_ROOT,
      generationRoot: fixture.constructionRoot,
      generation,
      productionInputs,
      productionEvidence: collectActivationProductionEvidence(CHECKOUT_ROOT, productionInputs),
      sourceEvidence,
      packageEvidence: mutablePackageEvidence,
      expectedPackageIdentity: packageIdentity,
    });
    sourceObservations += assembledResult.observerCalls.source;
    generatedObservations += assembledResult.observerCalls.generated;
    const assembled = assembledResult.manifest;
    const packageRecord = mutablePackageEvidence.records["capability.extracted-modules"];
    packageRecord.content = { attacker: true };
    packageRecord.observationDigest = observationDigest(packageRecord.content);
    expect({ sourceObservations, generatedObservations }).toEqual({
      sourceObservations: 1,
      generatedObservations: 1,
    });
    expect(activationEvidenceManifestViolations(assembled, assembled)).toEqual([]);
    expect(assembled.producers.package.records["capability.extracted-modules"].content).not.toEqual({ attacker: true });

    const forged = structuredClone(manifest) as any;
    const forgedRecord = forged.producers.generated.records["capability.generated-modules"];
    forgedRecord.content = { attacker: true };
    forgedRecord.observationDigest = observationDigest(forgedRecord.content);
    forgedRecord.artifactContentDigest = observationDigest({ forged: forgedRecord.content });
    const { evidenceDigest: _forgedOwnerDigest, ...unsignedForgedOwner } = forged.producers.generated;
    forged.producers.generated.evidenceDigest = observationDigest(unsignedForgedOwner);
    const forgedRecords = new Map<string, any>([...Object.entries(forged.producers.source.records), ...Object.entries(forged.producers.generated.records), ...Object.entries(forged.producers.package.records)]);
    for (const check of forged.checks) {
      check.observationDigest = observationDigest(check.observationRefs.map((ref: string) => forgedRecords.get(ref)?.content ?? null));
    }
    const forgedBodyRefs = ["capability.source-modules", "capability.source-runtime-registry", "capability.generated-modules", "capability.generated-runtime-registry", "capability.generated-served", "capability.extracted-modules", "capability.extracted-runtime-registry", "capability.extracted-served"];
    const forgedIdentityRefs = ["capability.source-registry", "capability.source-routes", "capability.source-schemas", "capability.generated-registry", "capability.generated-routes", "capability.generated-schemas", "capability.extracted-registry", "capability.extracted-routes", "capability.extracted-schemas"];
    forged.capabilityParityDigest = observationDigest({
      bodies: forgedBodyRefs.map((ref) => ({
        ref,
        content: forgedRecords.get(ref)?.content ?? null,
      })),
      identities: forgedIdentityRefs.map((ref) => ({
        ref,
        content: forgedRecords.get(ref)?.content ?? null,
      })),
    });
    const { manifestDigest: _forgedManifestDigest, ...unsignedForgedManifest } = forged;
    forged.manifestDigest = observationDigest(unsignedForgedManifest);
    expect(
      activationEvidenceViolations(forged, {
        root: CHECKOUT_ROOT,
        generationRoot: fixture.constructionRoot,
        generation,
        productionInputs,
        expectedManifestDigest: forged.manifestDigest,
        expectedPackageIdentity: packageIdentity,
      }).join("\n"),
    ).toMatch(/capability\.generated-modules.*authoritative artifact observation/);
    expect(manifest.checks).toHaveLength(42);
    expect(new Set(manifest.checks.flatMap((check) => check.observationRefs)).size).toBe(manifest.checks.flatMap((check) => check.observationRefs).length);
    const records = new Map([...Object.entries(manifest.producers.source.records), ...Object.entries(manifest.producers.generated.records), ...Object.entries(manifest.producers.package.records)]);
    for (const check of manifest.checks) {
      expect(check.observationDigest).toBe(observationDigest(check.observationRefs.map((ref) => records.get(ref)?.content ?? null)));
    }

    const mutations: Array<[string, (copy: any) => void, RegExp]> = [
      [
        "source body",
        (copy) => {
          copy.producers.source.records["capability.source-modules"].content.bodies.design.bytes = 0;
        },
        /capability body projection/,
      ],
      [
        "generated module body",
        (copy) => {
          copy.producers.generated.records["capability.generated-modules"].content.bodies.design.sha256 = "0".repeat(64);
        },
        /capability body projection/,
      ],
      [
        "generated served body",
        (copy) => {
          copy.producers.generated.records["capability.generated-served"].content.bodies.design.sha256 = "0".repeat(64);
        },
        /capability body projection/,
      ],
      [
        "extracted module body",
        (copy) => {
          copy.producers.package.records["capability.extracted-modules"].content.bodies.design.sha256 = "0".repeat(64);
        },
        /capability body projection/,
      ],
      [
        "extracted served body",
        (copy) => {
          copy.producers.source.records["capability.extracted-served"].content.bodies.design.sha256 = "0".repeat(64);
        },
        /capability body projection/,
      ],
      [
        "registry name",
        (copy) => {
          copy.producers.package.records["capability.extracted-registry"].content[0] = "wrong";
        },
        /capability identity projection/,
      ],
      [
        "route set",
        (copy) => {
          copy.producers.generated.records["capability.generated-routes"].content.pop();
        },
        /capability identity projection/,
      ],
      [
        "schema set",
        (copy) => {
          copy.producers.package.records["capability.extracted-schemas"].content.pop();
        },
        /capability identity projection/,
      ],
      [
        "package integrity",
        (copy) => {
          copy.packageArtifact.integrity = "sha512-wrong";
        },
        /package artifact identity|package-owner evidence integrity/,
      ],
      [
        "package manifest",
        (copy) => {
          copy.producers.package.records["package.extracted-artifact"].content.manifest.type = "directory";
        },
        /content digest|expected independently observed/,
      ],
      [
        "construction-root portability",
        (copy) => {
          copy.producers.package.records["package.portability"].content.constructionRootCount = 1;
        },
        /extracted package portability evidence is incomplete or failed/,
      ],
      [
        "package semantic reason",
        (copy) => {
          copy.producers.package.records["package.extracted-registry"].content[0] += "changed";
        },
        /package semantic projection/,
      ],
      [
        "portability manifest digest",
        (copy) => {
          copy.producers.package.records["package.portability"].content.secondManifest.files.digest = "0".repeat(64);
        },
        /content digest|portability evidence|expected independently observed/,
      ],
      [
        "generated binder",
        (copy) => {
          copy.producers.generated.records["bootstrap.generated-binder"].content.rows[0].classification = "not_exact";
        },
        /content digest|expected independently observed/,
      ],
      [
        "extracted classification",
        (copy) => {
          copy.producers.source.records["bootstrap.extracted-classifications"].content[0].classification = "malformed";
        },
        /content digest|expected independently observed/,
      ],
      [
        "diagnostic",
        (copy) => {
          copy.producers.generated.records["bootstrap.generated-diagnostics"].content.pop();
        },
        /content digest|expected independently observed/,
      ],
      [
        "startup producer",
        (copy) => {
          copy.producers.package.records["bootstrap.extracted-startup"].content.pop();
        },
        /content digest|expected independently observed/,
      ],
      [
        "missing surface",
        (copy) => {
          copy.producers.source.records["bootstrap.missing-surface"].content.pop();
        },
        /content digest|expected independently observed/,
      ],
      [
        "artifact provenance",
        (copy) => {
          copy.producers.package.records["package.extracted-artifact"].artifactIdentity = "wrong";
        },
        /wrong producer or artifact provenance/,
      ],
      [
        "aliased record",
        (copy) => {
          copy.checks[1].observationRefs = [...copy.checks[0].observationRefs];
        },
        /aliased across checks|producer requirements drifted/,
      ],
      [
        "aliased producer content",
        (copy) => {
          const source = copy.producers.source.records["generic.cli.discovery"];
          const target = copy.producers.source.records["generic.cli.adversarial"];
          target.artifactContentDigest = source.artifactContentDigest;
          target.content = structuredClone(source.content);
          target.observationDigest = source.observationDigest;
        },
        /alias one producer artifact observation/,
      ],
    ];
    for (const [label, mutate, expected] of mutations) {
      const copy = structuredClone(manifest);
      mutate(copy);
      expect(activationEvidenceManifestViolations(copy, manifest).join("\n"), label).toMatch(expected);
    }

    const coordinatedBlank = structuredClone(manifest) as any;
    for (const producer of Object.values(coordinatedBlank.producers) as any[]) {
      for (const record of Object.values(producer.records) as any[]) {
        if (record.artifactClass.includes("capability") && record.content?.bodies?.design) {
          record.content.bodies.design = {
            sha256: createHash("sha256").update("").digest("hex"),
            bytes: 0,
          };
        }
      }
    }
    expect(activationEvidenceManifestViolations(coordinatedBlank, manifest).join("\n")).toMatch(/capability body projection/);

    const resigned = structuredClone(manifest) as any;
    const resignedRecords = new Map<string, any>([...Object.entries(resigned.producers.source.records), ...Object.entries(resigned.producers.generated.records), ...Object.entries(resigned.producers.package.records)]);
    for (const [ref, record] of resignedRecords) {
      if (record.content?.bodies?.design)
        record.content.bodies.design = {
          sha256: createHash("sha256").update("").digest("hex"),
          bytes: 0,
        };
      if (ref === "package.extracted-artifact") record.content.manifest.contentDigest = "0".repeat(64);
      record.artifactContentDigest = observationDigest({
        ref,
        content: record.content,
        resigned: true,
      });
      record.observationDigest = observationDigest(record.content);
    }
    for (const producer of Object.values(resigned.producers) as any[]) {
      const { evidenceDigest: _oldDigest, ...unsigned } = producer;
      producer.evidenceDigest = observationDigest(unsigned);
    }
    const bodyRefs = ["capability.source-modules", "capability.source-runtime-registry", "capability.generated-modules", "capability.generated-runtime-registry", "capability.generated-served", "capability.extracted-modules", "capability.extracted-runtime-registry", "capability.extracted-served"];
    const identityRefs = ["capability.source-registry", "capability.source-routes", "capability.source-schemas", "capability.generated-registry", "capability.generated-routes", "capability.generated-schemas", "capability.extracted-registry", "capability.extracted-routes", "capability.extracted-schemas"];
    resigned.capabilityParityDigest = observationDigest({
      bodies: bodyRefs.map((ref) => ({
        ref,
        content: resignedRecords.get(ref)?.content ?? null,
      })),
      identities: identityRefs.map((ref) => ({
        ref,
        content: resignedRecords.get(ref)?.content ?? null,
      })),
    });
    for (const check of resigned.checks) {
      check.observationDigest = observationDigest(check.observationRefs.map((ref: string) => resignedRecords.get(ref)?.content ?? null));
    }
    const { manifestDigest: _oldManifestDigest, ...unsignedManifest } = resigned;
    resigned.manifestDigest = observationDigest(unsignedManifest);

    const productionViolations = activationEvidenceViolations(resigned, {
      root: CHECKOUT_ROOT,
      generationRoot: fixture.constructionRoot,
      generation,
      productionInputs,
      expectedManifestDigest: manifest.manifestDigest,
      expectedPackageIdentity: packageIdentity,
    }).join("\n");
    expect(productionViolations).toMatch(/capability\.source-modules.*authoritative artifact observation/);
    expect(productionViolations).toMatch(/capability\.generated-modules.*authoritative artifact observation/);
    expect(productionViolations).toMatch(/trusted release observation/);

    const attackRoot = path.join(fixture.root, "coordinated-attack-checkout");
    const copyIntoAttackRoot = (relative: string): void => {
      const target = path.join(attackRoot, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(path.join(CHECKOUT_ROOT, relative), target, {
        recursive: true,
        verbatimSymlinks: true,
      });
    };
    for (const relative of ["references", "skills", "docs", "packages/cli/src", "packages/cli/scripts"]) copyIntoAttackRoot(relative);
    for (const relative of ["registry.json", "package.json", "packages/cli/package.json", "packages/cli/tsconfig.json"]) copyIntoAttackRoot(relative);
    fs.symlinkSync(path.join(CHECKOUT_ROOT, "packages/cli/node_modules"), path.join(attackRoot, "packages/cli/node_modules"), "dir");
    const attackGeneration = fixture.sourceIdentity.identitySha256;
    const attackGenerationRoot = path.join(attackRoot, "private-build", attackGeneration);
    fs.mkdirSync(attackGenerationRoot, { recursive: true });
    fs.cpSync(fs.realpathSync(path.join(fixture.constructionRoot, "dist")), path.join(attackGenerationRoot, "dist"), {
      recursive: true,
    });
    fs.cpSync(fs.realpathSync(path.join(fixture.constructionRoot, "bundle")), path.join(attackGenerationRoot, "bundle"), { recursive: true });
    fs.symlinkSync(path.join(CHECKOUT_ROOT, "packages/cli/node_modules"), path.join(attackGenerationRoot, "node_modules"), "dir");
    const attackPackageRoot = path.join(fixture.root, "coordinated-attack-package");
    fs.cpSync(fixture.packageRoot, attackPackageRoot, {
      recursive: true,
      verbatimSymlinks: true,
    });
    const attackTarball = path.join(fixture.root, "coordinated-attack-agentera-3.0.0-dev.42.tgz");
    fs.copyFileSync(path.join(fixture.root, fixture.manifest.filename), attackTarball);
    try {
      const attackSourceSnapshot = path.join(fixture.root, "coordinated-attack-snapshot-source");
      observeCurrentPackageArtifact(path.join(fixture.root, fixture.manifest.filename), fixture.packageRoot, attackSourceSnapshot);
      installRetainedPackageSnapshot(attackSourceSnapshot, attackGenerationRoot, packageIdentity);
      expect(activationSourceDigest(attackRoot)).toBe(activationSourceDigest(CHECKOUT_ROOT));
      const baselineInputs = loadActivationProductionInputs(attackRoot, attackGenerationRoot);
      const baselinePackageEvidence = structuredClone(evidence);
      const baselineManifest = createActivationEvidenceManifest({
        root: attackRoot,
        generation: attackGeneration,
        productionEvidence: collectActivationProductionEvidence(attackRoot, baselineInputs),
        sourceEvidence: createSourceOwnerEvidence(attackRoot, baselineInputs, {
          fixture,
          runtimeSummary: matrixSummary!,
          missingSurfaceResults,
        }),
        generatedEvidence: await createGeneratedOwnerEvidence({
          root: attackRoot,
          generationRoot: attackGenerationRoot,
          generation: attackGeneration,
          productionInputs: baselineInputs,
        }),
        packageEvidence: baselinePackageEvidence,
      });

      fs.appendFileSync(path.join(attackRoot, "packages/cli/src/capabilities/design/instructions.ts"), "\n// coordinated source tampering\n");
      fs.appendFileSync(path.join(attackGenerationRoot, "dist/capabilities/design/instructions.js"), "\n// coordinated generated tampering\n");
      const attackedPackageJson = path.join(attackPackageRoot, "package.json");
      fs.appendFileSync(attackedPackageJson, "\n");
      fs.writeFileSync(path.join(attackPackageRoot, "coordinated-addition.txt"), "attacker-added\n");
      fs.appendFileSync(attackTarball, "coordinated-tarball-tampering");
      const retainedSnapshot = path.join(attackGenerationRoot, ".activation-package-snapshot");
      fs.appendFileSync(path.join(retainedSnapshot, "package.tgz"), "retained-tarball-tampering");
      fs.writeFileSync(path.join(retainedSnapshot, "extracted", "retained-addition.txt"), "retained addition\n");

      const attackedInputs = loadActivationProductionInputs(attackRoot, attackGenerationRoot);
      const attackedPackageEvidence = structuredClone(baselinePackageEvidence) as any;
      const attackedArtifactRecord = attackedPackageEvidence.records["package.extracted-artifact"];
      const attackedArtifact = attackedArtifactRecord.content;
      const tarballBytes = fs.readFileSync(attackTarball);
      attackedArtifact.filename = fixture.manifest.filename;
      attackedArtifact.integrity = `sha512-${createHash("sha512").update(tarballBytes).digest("base64")}`;
      attackedArtifact.shasum = createHash("sha1").update(tarballBytes).digest("hex");
      attackedArtifact.tarballSha256 = createHash("sha256").update(tarballBytes).digest("hex");
      attackedArtifact.manifest.contentDigest = createHash("sha256").update(fs.readFileSync(attackedPackageJson)).digest("hex");
      const packageJsonEntry = attackedArtifact.extractedTree.entries.find((entry: any) => entry.path === "package.json");
      packageJsonEntry.size = fs.statSync(attackedPackageJson).size;
      packageJsonEntry.sha256 = attackedArtifact.manifest.contentDigest;
      attackedArtifact.extractedTree.entries.push({
        path: "coordinated-addition.txt",
        type: "file",
        mode: fs.statSync(path.join(attackPackageRoot, "coordinated-addition.txt")).mode & 0o777,
        size: fs.statSync(path.join(attackPackageRoot, "coordinated-addition.txt")).size,
        sha256: createHash("sha256")
          .update(fs.readFileSync(path.join(attackPackageRoot, "coordinated-addition.txt")))
          .digest("hex"),
      });
      attackedArtifact.extractedTree.entries.sort((left: any, right: any) => left.path.localeCompare(right.path));
      attackedArtifact.extractedTree.digest = observationDigest(attackedArtifact.extractedTree.entries);
      const resignedTarballEntries = attackedArtifact.extractedTree.entries.filter((entry: any) => entry.path !== "node_modules");
      attackedArtifact.tarballTree.count = resignedTarballEntries.length;
      attackedArtifact.tarballTree.digest = observationDigest(resignedTarballEntries);
      attackedPackageEvidence.sourceDigest = activationSourceDigest(attackRoot);
      attackedPackageEvidence.packageIntegrity = attackedArtifact.integrity;
      for (const record of Object.values(attackedPackageEvidence.records) as any[]) record.packageIntegrity = attackedArtifact.integrity;
      attackedArtifactRecord.artifactContentDigest = observationDigest(attackedArtifact);
      attackedArtifactRecord.observationDigest = observationDigest(attackedArtifact);
      const { evidenceDigest: _attackedEvidenceDigest, ...unsignedAttackedPackageEvidence } = attackedPackageEvidence;
      attackedPackageEvidence.evidenceDigest = observationDigest(unsignedAttackedPackageEvidence);

      const coordinatedManifest = createActivationEvidenceManifest({
        root: attackRoot,
        generation: attackGeneration,
        productionEvidence: collectActivationProductionEvidence(attackRoot, attackedInputs),
        sourceEvidence: createSourceOwnerEvidence(attackRoot, attackedInputs, {
          fixture,
          runtimeSummary: matrixSummary!,
          missingSurfaceResults,
        }),
        generatedEvidence: await createGeneratedOwnerEvidence({
          root: attackRoot,
          generationRoot: attackGenerationRoot,
          generation: attackGeneration,
          productionInputs: attackedInputs,
        }),
        packageEvidence: attackedPackageEvidence,
      });
      fs.writeFileSync(path.join(attackGenerationRoot, "activation-evidence.json"), `${JSON.stringify(coordinatedManifest)}\n`);

      const conjunction = validateActivationConjunction({
        root: attackRoot,
        expectedGeneration: attackGeneration,
        generationRoot: attackGenerationRoot,
        expectedEvidenceDigest: baselineManifest.manifestDigest,
        expectedPackageIdentity: packageIdentity,
      }) as any;
      expect(conjunction.status).toBe("fail");
      expect(conjunction.violations).toEqual(
        expect.arrayContaining([
          {
            owner: "packages/cli/scripts/verify-generated-overlap.mjs#writeActivationEvidence",
            violation: "retained package snapshot differs from the independently retained package identity",
            correction: "pnpm -C packages/cli run verify:package",
          },
        ]),
      );

      fs.rmSync(retainedSnapshot, { recursive: true, force: true });
      installRetainedPackageSnapshot(attackSourceSnapshot, attackGenerationRoot, packageIdentity);

      const generatedCli = path.join(attackGenerationRoot, "dist/bin/agentera.js");
      const originalGeneratedCli = fs.readFileSync(generatedCli);
      const originalGeneratedCliMode = fs.statSync(generatedCli).mode & 0o777;
      const observerCases: Array<[string, () => void, string]> = [
        ["missing", () => fs.rmSync(generatedCli), "authoritative activation evidence artifact is missing"],
        ["malformed", () => fs.writeFileSync(generatedCli, 'process.stdout.write("not-json")\n'), "authoritative activation evidence artifact is malformed"],
        ["unexecutable", () => fs.writeFileSync(generatedCli, "process.exit(64)\n"), "authoritative activation evidence artifact could not be executed"],
      ];
      for (const [label, breakArtifact, expectedViolation] of observerCases) {
        fs.writeFileSync(generatedCli, originalGeneratedCli, { mode: originalGeneratedCliMode });
        breakArtifact();
        const result = validateActivationConjunction({
          root: attackRoot,
          productionInputs: attackedInputs,
          expectedGeneration: attackGeneration,
          generationRoot: attackGenerationRoot,
          evidenceManifest: coordinatedManifest,
          expectedEvidenceDigest: baselineManifest.manifestDigest,
          expectedPackageIdentity: packageIdentity,
        }) as any;
        expect(result, label).toMatchObject({
          status: "fail",
          violation_count: 1,
          violations: [
            {
              owner: "packages/cli/scripts/verify-generated-overlap.mjs#writeActivationEvidence",
              violation: expectedViolation,
              correction: "pnpm -C packages/cli run verify:package",
            },
          ],
        });
        expect(JSON.stringify(result), label).not.toContain("unsupported_target");
      }
      fs.writeFileSync(generatedCli, originalGeneratedCli, { mode: originalGeneratedCliMode });
    } finally {
      fs.rmSync(attackRoot, { recursive: true, force: true });
      fs.rmSync(attackPackageRoot, { recursive: true, force: true });
      fs.rmSync(attackTarball, { force: true });
    }
  });
});
