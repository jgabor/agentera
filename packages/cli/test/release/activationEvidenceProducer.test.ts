import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createSourceOwnerEvidence, OWNER_EVIDENCE_MAX_BYTES, SOURCE_OWNER_EVIDENCE_SCHEMA, writeContentAddressedOwnerEvidence } from "../../src/validate/activationArtifactEvidence.js";
import { loadActivationProductionInputs } from "../../src/validate/activationConjunction.js";

const ROOT = path.resolve(import.meta.dirname, "../../../..");

describe("activation source owner evidence", () => {
  it("observes source capability modules independently and emits bounded content-addressed evidence", () => {
    const evidence = createSourceOwnerEvidence(ROOT, loadActivationProductionInputs(ROOT));
    expect(evidence).toMatchObject({
      schemaVersion: SOURCE_OWNER_EVIDENCE_SCHEMA,
      producerKind: "source-owner",
      generation: null,
      packageIntegrity: null,
    });
    const modules = evidence.records["capability.source-modules"].content as any;
    const runtime = evidence.records["capability.source-runtime-registry"].content as any;
    expect(modules.identities).toHaveLength(12);
    expect(runtime).toEqual(modules);
    expect(Object.values(modules.bodies).every((body: any) => body.bytes > 0 && /^[a-f0-9]{64}$/.test(body.sha256))).toBe(true);
    expect(evidence.records).toHaveProperty("bootstrap.source-authority");
  });

  it("rejects oversized owner evidence before creating output and reports byte contributors", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "activation-evidence-bound-"));
    try {
      const evidence = createSourceOwnerEvidence(ROOT, loadActivationProductionInputs(ROOT)) as any;
      evidence.records["capability.source-modules"].content.padding = "x".repeat(OWNER_EVIDENCE_MAX_BYTES);
      const output = path.join(root, "evidence");
      expect(() => writeContentAddressedOwnerEvidence(output, evidence)).toThrow(new RegExp(`activation owner evidence is \\d+ bytes, over the ${OWNER_EVIDENCE_MAX_BYTES}-byte bound; largest records:`));
      expect(fs.existsSync(output)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
