import { describe, expect, it } from "vitest";

import { runQualificationBenchmark } from "../../scripts/release-benchmark.mjs";

function phases(timings: Record<string, number>) {
  return {
    runPreflight: () => ({ elapsedMs: timings.preflight, owners: [{ name: "preflight", elapsedMs: timings.preflight }]}),
    runSource: () => ({
      elapsedMs: timings.source,
      owners: [
        { name: "source", elapsedMs: Math.floor(timings.source / 2), executed: "ordered", reused: false },
        { name: "stress", elapsedMs: Math.ceil(timings.source / 2), executed: "ordered", reused: false },
      ],
    }),
    runCandidate: () => ({
      elapsedMs: timings.candidate,
      owners: [{ name: "local-exact-artifact-smoke", elapsedMs: timings.candidate, executed: "ordered", reused: false }],
    }),
  };
}

describe("release qualification benchmark coordinator", () => {
  it("records three cold repetitions, owner execution, reconciled totals, and medians", async () => {
    let repetition = 0;
    const report = await runQualificationBenchmark({
      runPreflight: () => ({ elapsedMs: [8, 5, 11][repetition], owners: [{ name: "preflight", elapsedMs: [8, 5, 11][repetition] }]}),
      runSource: () => ({ elapsedMs: [100, 120, 110][repetition], owners: [{ name: "source", elapsedMs: [100, 120, 110][repetition] }]}),
      runCandidate: () => ({
        elapsedMs: [40, 30, 50][repetition++],
        owners: [{ name: "local-exact-artifact-smoke", elapsedMs: [40, 30, 50][repetition - 1] }],
      }),
      qualifiedPublication: {
        elapsedMs: 90,
        owners: [{ name: "promotion", elapsedMs: 90, executed: "recorded", reused: false }],
      },
    });

    expect(report.repetitions).toHaveLength(3);
    expect(report.repetitions.every((run) => run.coldCache)).toBe(true);
    expect(report.repetitions.every((run) => run.preflight.reconciled && run.source.reconciled && run.candidate.reconciled)).toBe(true);
    expect(report.medianElapsedMs).toEqual({ preflight: 8, fullQualification: 150 });
    expect(report.qualifiedPublication).toMatchObject({ elapsedMs: 90, reconciled: true });
  });

  it("emits the original first failing owner immediately and does not run later owners", async () => {
    const events: unknown[] = [];
    let candidates = 0;
    await expect(runQualificationBenchmark({
      ...phases({ preflight: 1, source: 1, candidate: 1 }),
      runSource: () => {
        const error = new Error("stress fixture failed");
        (error as Error & { owner?: string }).owner = "stress";
        throw error;
      },
      runCandidate: () => {
        candidates += 1;
        return { elapsedMs: 1 };
      },
      emit: (event: unknown) => events.push(event),
    })).rejects.toMatchObject({
      firstFailure: { owner: "stress", phase: "source-qualification", detail: "stress fixture failed" },
    });
    expect(candidates).toBe(0);
    expect(events.at(-1)).toEqual({
      event: "failed",
      repetition: 1,
      firstFailure: { owner: "stress", phase: "source-qualification", detail: "stress fixture failed" },
    });
  });

  it("fails closed on a full qualification or qualified-publication budget overrun", async () => {
    await expect(runQualificationBenchmark(phases({ preflight: 1, source: 299_999, candidate: 1 }))).rejects.toThrow(
      "full-qualification",
    );
    await expect(runQualificationBenchmark({
      ...phases({ preflight: 1, source: 1, candidate: 1 }),
      qualifiedPublication: { elapsedMs: 120_000, owners: [] },
    })).rejects.toThrow("qualified publication exceeded");
  });
});
