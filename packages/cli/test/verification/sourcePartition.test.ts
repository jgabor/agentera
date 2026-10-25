import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { loadVerificationPolicy } from "../../scripts/overlap-pending.mjs";
import { parseIsolatedOwnersDelegation, parseSourcePartition, sourcePartitionErrors, sourcePartitionFiles } from "../../scripts/source-partition.mjs";
import { verificationPolicyErrors } from "../../src/registries/verificationPolicy.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const CORE = ["core/a.test.ts", "core/b.test.ts"];
const SOURCE = [...CORE, ...Array.from({ length: 9 }, (_, index) => `source/${String(index).padStart(2, "0")}.test.ts`)];
const PARTITIONS = {
  core: CORE,
  shards: 3,
  default_weight_ms: 1000,
  weights_ms: { "source/00.test.ts": 9000, "source/01.test.ts": 8000, "source/02.test.ts": 7000 },
};

function every(sourceFiles = SOURCE, partitions = PARTITIONS) {
  return ["core", ...Array.from({ length: partitions.shards }, (_, index) => `shard:${index + 1}/${partitions.shards}`)].map((spec) => sourcePartitionFiles(sourceFiles, partitions, parseSourcePartition(spec, partitions)));
}

describe("source partitions", () => {
  it("splits the source inventory into disjoint core and shard lists that cover it exactly", () => {
    const lists = every();
    expect(lists[0]).toEqual(CORE);
    expect(lists.flat().sort()).toEqual([...SOURCE].sort());
    expect(new Set(lists.flat()).size).toBe(SOURCE.length);
    expect(every([...SOURCE].reverse())).toEqual(lists);
  });

  it("balances shards by weight, longest first", () => {
    const [, ...shards] = every();
    expect(shards.map((files) => files.filter((file) => file in PARTITIONS.weights_ms))).toEqual([["source/00.test.ts"], ["source/01.test.ts"], ["source/02.test.ts"]]);
    const load = (files: string[]) => files.reduce((total, file) => total + (PARTITIONS.weights_ms[file as keyof typeof PARTITIONS.weights_ms] ?? PARTITIONS.default_weight_ms), 0);
    expect(Math.max(...shards.map(load)) - Math.min(...shards.map(load))).toBeLessThanOrEqual(2000);
  });

  it("rejects malformed partition requests", () => {
    expect(parseSourcePartition(undefined, PARTITIONS)).toBeUndefined();
    expect(() => parseSourcePartition("shard:4/3", PARTITIONS)).toThrow("shard index 4 exceeds 3");
    expect(() => parseSourcePartition("shard:1/2", PARTITIONS)).toThrow("does not match the policy's 3 shards");
    expect(() => parseSourcePartition("shard:0/3", PARTITIONS)).toThrow("must be 'core' or 'shard:INDEX/COUNT'");
    expect(() => parseSourcePartition("all", PARTITIONS)).toThrow("must be 'core' or 'shard:INDEX/COUNT'");
    expect(() => parseSourcePartition("core", undefined)).toThrow("requires verification-policy.yaml#source_partitions");
  });

  it("reports core and weight entries that do not match the source inventory", () => {
    expect(sourcePartitionErrors(PARTITIONS, SOURCE, CORE)).toEqual([]);
    expect(sourcePartitionErrors(undefined, SOURCE, CORE)).toEqual([]);
    expect(
      sourcePartitionErrors(
        {
          ...PARTITIONS,
          core: ["core/a.test.ts", "core/a.test.ts", "package/x.test.ts"],
          weights_ms: { "core/a.test.ts": 1, "gone.test.ts": 1 },
        },
        SOURCE,
        CORE,
      ),
    ).toEqual([
      "source partition core file is not a source-owned inventory file: package/x.test.ts",
      "source partition core repeats a file",
      "source partition core must contain core/b.test.ts",
      "source partition weight names a core file: core/a.test.ts",
      "source partition weight names a file that is not source-owned: gone.test.ts",
    ]);
    expect(sourcePartitionErrors({ ...PARTITIONS, shards: 10 }, SOURCE, CORE)).toEqual(["source partition shards (10) exceed the 9 non-core source files"]);
  });

  it("accepts only the governed isolated owners, in order, and only an explicit delegation", () => {
    const policy = loadVerificationPolicy(fs.readFileSync(path.join(REPO_ROOT, "references/analysis/verification-policy.yaml")));
    expect(parseIsolatedOwnersDelegation(undefined, policy.isolated_owners)).toBeUndefined();
    expect(parseIsolatedOwnersDelegation("delegate", policy.isolated_owners)).toEqual(["stress", "performance", "capacity"]);
    expect(() => parseIsolatedOwnersDelegation("1", policy.isolated_owners)).toThrow("must be 'delegate'");
    expect(() => parseIsolatedOwnersDelegation("delegate", undefined)).toThrow("requires verification-policy.yaml#isolated_owners");
    expect(verificationPolicyErrors({ ...policy, isolated_owners: ["performance", "stress", "capacity"] })).toEqual(["verification.isolated_owners must be exactly [stress, performance, capacity]"]);
  });

  it("keeps the governed core on the activation evidence producer and the declared pending assertion", () => {
    const policy = loadVerificationPolicy(fs.readFileSync(path.join(REPO_ROOT, "references/analysis/verification-policy.yaml")));
    expect(policy.source_partitions.core).toEqual(expect.arrayContaining(["packages/cli/test/integration/runtimeBootstrapMatrix.test.ts", policy.overlap.allowed_pending_assertion.path]));
  });
});
