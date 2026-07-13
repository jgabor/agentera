import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { describe, expect, it } from "vitest";

import { CAPABILITY_INSTRUCTIONS } from "../../src/capabilities/index.js";
import { decisionSatisfactionContext } from "../../src/cli/commands/state/decisions.js";
import { progressVerificationSummary } from "../../src/cli/capabilityContext/progress.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const AUTHORITY_PATH = path.join(REPO_ROOT, "references/artifacts/state-storage-authority.yaml");
const BUNDLE_ROOT = path.join(REPO_ROOT, "packages/cli/bundle");
const STATE_ARTIFACTS = new Set(["decisions", "progress", "health"]);
const CAPABILITY_NAMES = Object.keys(CAPABILITY_INSTRUCTIONS);

function readYaml(relativePath: string): Record<string, any> {
  return YAML.parse(fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8")) as Record<string, any>;
}

function schemaConsumers(relativePath: string): string[] {
  const schema = readYaml(relativePath);
  return Object.values(schema.ARTIFACTS ?? {})
    .filter((entry): entry is Record<string, any> => Boolean(entry && typeof entry === "object"))
    .filter((entry) => String(entry.local_role ?? "").includes("consumes"))
    .map((entry) => String(entry.artifact_id))
    .filter((artifact) => STATE_ARTIFACTS.has(artifact));
}

function sourceAndBundle(relativePath: string): [string, string] {
  const source = fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
  const bundled = fs.readFileSync(path.join(BUNDLE_ROOT, relativePath), "utf8");
  return [source, bundled];
}

describe("state consumer matrix", () => {
  it("covers all 12 source and bundled capability consumers with generated parity", () => {
    const authority = readYaml("references/artifacts/state-storage-authority.yaml");
    const matrix = authority.consumer_matrix;
    const consumers = matrix.capabilities as Array<Record<string, any>>;

    expect(matrix.status).toBe("active_authority");
    expect(matrix.required_capabilities).toEqual(CAPABILITY_NAMES);
    expect(consumers.map((entry) => entry.name)).toEqual(CAPABILITY_NAMES);
    expect(new Set(consumers.map((entry) => entry.name)).size).toBe(12);
    expect(matrix.access_contract.list).toContain("list --limit 20");
    expect(matrix.access_contract.get).toContain("get --number N");

    const rawReadPattern = /(?:fs\.)?readFile(?:Sync)?\([^)]*(?:decisions|progress|health)/i;
    const staleCommandPattern = /agentera (?:state )?(?:decisions|progress|health) --format json/;
    for (const entry of consumers) {
      const sourcePath = String(entry.source);
      const bundlePath = String(entry.bundle);
      expect(fs.existsSync(path.join(REPO_ROOT, sourcePath)), sourcePath).toBe(true);
      expect(fs.existsSync(path.join(REPO_ROOT, bundlePath)), bundlePath).toBe(true);
      expect(fs.existsSync(path.join(BUNDLE_ROOT, bundlePath)), `generated ${bundlePath}`).toBe(true);

      const schemaStateConsumers = schemaConsumers(bundlePath);
      expect(schemaStateConsumers.sort(), entry.name).toEqual([...entry.state_consumers].sort());
      const [bundleSource, generatedBundle] = sourceAndBundle(bundlePath);
      expect(generatedBundle, `generated parity for ${bundlePath}`).toBe(bundleSource);

      const instruction = CAPABILITY_INSTRUCTIONS[String(entry.name)] ?? "";
      expect(bundleSource, bundlePath).not.toMatch(staleCommandPattern);
      expect(instruction, entry.name).not.toMatch(rawReadPattern);
      expect(bundleSource, bundlePath).not.toMatch(rawReadPattern);
      expect(instruction, entry.name).toContain("agentera prime");
    }
  });

  it("preserves Decision 53 review truth across all satisfaction states", () => {
    const cases = [
      [{ number: 53 }, true],
      [{ number: 53, satisfaction: { state: "open" } }, true],
      [{ number: 53, satisfaction: { state: "provisionally_satisfied", evidence: "verified" } }, true],
      [{ number: 53, satisfaction: { state: "user_confirmed_satisfied" } }, true],
      [{ number: 53, satisfaction: { state: "user_confirmed_satisfied", user_confirmation: { confirmed_by: "user", confirmed_at: "2026-07-14T00:00:00Z" } } }, false],
    ] as const;

    for (const [entry, reviewNeeded] of cases) {
      expect(decisionSatisfactionContext(entry), JSON.stringify(entry)).toMatchObject({ review_needed: reviewNeeded });
    }
  });

  it("preserves bounded progress verification presence from prime projection", () => {
    expect(
      progressVerificationSummary({
        exists: true,
        latest: { number: 777 },
        latest_verification: { present: true },
      }),
    ).toMatchObject({
      verified_present: true,
      non_empty_evidence_present: true,
      non_empty_evidence_fields: ["verified"],
      verification_summary: { present: true },
    });
  });
});
