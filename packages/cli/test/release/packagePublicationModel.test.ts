import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ACTIVATION_CLASS_AUTHORITIES, ACTIVATION_CLASSES } from "../../src/registries/activationContract.js";
import { SOURCE_GATE_IDS, validatePackagePublicationDocument } from "../../src/registries/packagePublication.js";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const authority = JSON.parse(fs.readFileSync(path.join(ROOT, "references/adapters/package-publication.json"), "utf8"));
const mutate = (change: (copy: any) => void) => {
  const copy = structuredClone(authority);
  change(copy);
  return () => validatePackagePublicationDocument(copy);
};

describe("strict package publication model", () => {
  it("owns exactly eleven ordered gates with capacity after performance and before readers", () => {
    const model = validatePackagePublicationDocument(authority);
    expect(model.sourceGates.map(({ name }) => name)).toEqual(SOURCE_GATE_IDS);
    expect(model.sourceDag.performanceBarrier).toEqual(["performance"]);
    expect(model.sourceDag.capacityBarrier).toEqual(["capacity"]);
    expect(model.sourceDag.barrierB).toEqual(["compact", "capability-contract", "activation-conjunction"]);
    expect(model.readiness).toMatchObject({
      schemaVersion: "agentera.releaseReadiness.v1",
      adapter: "development",
      phases: ["source-readiness", "metadata-review", "candidate-readiness"],
      receipts: { source: "source-receipt.json", candidate: "candidate-receipt.json" },
      outcomes: ["paused", "ready", "rejected"],
      exitCodes: { paused: 0, ready: 0, rejected: 1 },
    });
    expect(model.activationConjunction.classes).toHaveLength(7);
    expect(model.activationConjunction.dimensions).toHaveLength(6);
    expect(model.activationConjunction.checkIds).toHaveLength(42);
    expect(model.sourceQualificationMs).toBe(2_400_000);
    expect(model.versionCallerInventory).toMatchObject({
      development: {
        authority: "CI candidate from GITHUB_RUN_NUMBER plus 80 on checked-in manifest base line",
        currentExplicitTargetCallers: ["packages/cli/scripts/pack-package.mjs#--package-version with --git-ref"],
      },
      stable: { authority: "explicit target-version" },
      suite: { requiredVersion: "3.0.0" },
    });
    expect(mutate((copy) => { copy.benchmark.timeouts.sourceQualificationMs = 2_400_001; })).toThrow(/source qualification timeout/);
  });

  it("rejects reassigned development, stable, or suite version authority", () => {
    expect(mutate((copy) => { copy.ci.developmentPush.versionAuthority = "packages/cli/package.json#version"; })).toThrow(/development push version authority/);
    expect(mutate((copy) => { copy.ci.developmentPush.runNumberOffset = 82; })).toThrow(/development push version authority/);
    expect(mutate((copy) => { copy.versionCallerInventory.development.currentExplicitTargetCallers.push("obsolete caller"); })).toThrow(/development version callers/);
    expect(mutate((copy) => { copy.versionCallerInventory.stable.authority = "checked-in manifest"; })).toThrow(/version authority/);
  });

  it.each([
    ["unknown gate", (copy: any) => { copy.qualification.source.gates[0].name = "unknown"; }],
    ["omitted gate", (copy: any) => { copy.qualification.source.gates.pop(); }],
    ["duplicate gate", (copy: any) => { copy.qualification.source.gates[1] = structuredClone(copy.qualification.source.gates[0]); }],
    ["empty command", (copy: any) => { copy.qualification.source.gates[0].command = []; }],
    ["gate order", (copy: any) => { copy.qualification.source.gates.reverse(); }],
    ["duplicate phase entry", (copy: any) => { copy.qualification.source.dag.batchA[1] = copy.qualification.source.dag.batchA[0]; }],
    ["wrong phase membership", (copy: any) => { copy.qualification.source.dag.barrierB[0] = "stress"; }],
    ["capacity before performance", (copy: any) => {
      copy.qualification.source.dag.performanceBarrier = ["capacity"];
      copy.qualification.source.dag.capacityBarrier = ["performance"];
    }],
    ["omitted capacity barrier", (copy: any) => { delete copy.qualification.source.dag.capacityBarrier; }],
    ["unknown class", (copy: any) => { copy.qualification.source.activationConjunction.classes[0] = "unknown"; }],
    ["omitted dimension", (copy: any) => { copy.qualification.source.activationConjunction.dimensions.pop(); }],
    ["duplicate check", (copy: any) => { copy.qualification.source.activationConjunction.checkIds[1] = copy.qualification.source.activationConjunction.checkIds[0]; }],
    ["empty correction", (copy: any) => { copy.qualification.source.gates[0].correction = ""; }],
    ["missing readiness reuse", (copy: any) => { delete copy.qualification.readiness.reuse; }],
    ["changed metadata review rule", (copy: any) => { copy.qualification.readiness.metadataReview = ""; }],
    ["wrong readiness receipt", (copy: any) => { copy.qualification.readiness.receipts.candidate = "other.json"; }],
    ["wrong readiness exit", (copy: any) => { copy.qualification.readiness.exitCodes.rejected = 0; }],
    ["development readiness target version", (copy: any) => { copy.qualification.readiness.command = copy.qualification.readiness.command.replace("--source-commit", "--target-version VERSION --source-commit"); }],
    ["candidate target version", (copy: any) => { copy.qualification.candidate.inputs.splice(2, 0, "target_version"); }],
  ])("rejects %s", (_label, change) => expect(mutate(change)).toThrow(/package publication contract/));

  it.each(ACTIVATION_CLASSES)("rejects a well-formed wrong %s class owner and reports canonical identity", (classId) => {
    const canonical = ACTIVATION_CLASS_AUTHORITIES[classId];
    expect(mutate((copy) => {
      copy.qualification.source.activationConjunction.owners[classId] = {
        path: "packages/cli/src/cli/help.ts",
        symbol: "printTopLevelHelp",
        correction: "node packages/cli/dist/bin/agentera.js check compact",
      };
    })).toThrow(new RegExp(`${canonical.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}#${canonical.symbol}.*${canonical.correction.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  });

  it("rejects contract-defined census count, digest, and total reassignment", () => {
    expect(mutate((copy) => { copy.qualification.source.activationConjunction.census.classes.cli.count = 26; })).toThrow(/count 27/);
    expect(mutate((copy) => { copy.qualification.source.activationConjunction.census.classes.capability.sha256 = "f".repeat(64); })).toThrow(/007e1157/);
    expect(mutate((copy) => { copy.qualification.source.activationConjunction.census.total.sha256 = "a".repeat(64); })).toThrow(/68b71f1e/);
  });
});
