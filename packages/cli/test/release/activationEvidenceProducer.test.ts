import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createSourceOwnerEvidence,
  SOURCE_OWNER_EVIDENCE_SCHEMA,
} from "../../src/validate/activationArtifactEvidence.js";
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
    const modules = (evidence.records["capability.source-modules"].content as any);
    const runtime = (evidence.records["capability.source-runtime-registry"].content as any);
    expect(modules.identities).toHaveLength(12);
    expect(runtime).toEqual(modules);
    expect(Object.values(modules.bodies).every((body: any) => body.bytes > 0 && /^[a-f0-9]{64}$/.test(body.sha256))).toBe(true);
    expect(evidence.records).toHaveProperty("bootstrap.source-authority");
  });
});
