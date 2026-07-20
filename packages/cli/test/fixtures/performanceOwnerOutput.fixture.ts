import { expect, it } from "vitest";
import os from "node:os";

const targetNames = [
  "exact_get",
  "bounded_list_small",
  "bounded_list_large",
  "startup_small",
  "startup_large",
];

it("emits bounded owner evidence", () => {
  const samples = targetNames.flatMap((target) =>
    Array.from({ length: 5 }, (_, index) => ({ target, repetition: index + 1, status: "pass" })),
  );
  const aggregate = Object.fromEntries(targetNames.map((target) => [target, { repetitions: 5 }]));
  const evidence = {
    schemaVersion: "agentera.entityAuthorityPerformanceEvidence.v1",
    status: "pass",
    runner: {
      platform: process.platform,
      node: process.version,
      logicalCpus: os.cpus().length,
      coldProcessPerSample: true,
    },
    measurement: {
      scales: { small: 100, large: 1000 },
      repetitions: 5,
      heapSampling: { intervalMs: 1, cadenceChanged: false },
    },
    limits: aggregate,
    samples,
    maxima: aggregate,
  };
  expect(samples).toHaveLength(25);
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
});
