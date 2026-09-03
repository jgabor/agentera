import { describe, expect, it } from "vite-plus/test";

import { formatSourceBreakdown, summarizeSourceReport } from "../../scripts/source-test-breakdown.mjs";

const testRoot = "/repo/test";

describe("source test timing breakdown", () => {
  it("separates wall time from overlapping worker time and ranks areas, files, and tests", () => {
    const summary = summarizeSourceReport(
      {
        success: false,
        testResults: [
          {
            name: `${testRoot}/state/a.test.ts`,
            startTime: 1_000,
            endTime: 5_000,
            assertionResults: [
              { fullName: "slow | state test", status: "passed", duration: 3_000 },
              { fullName: "skipped state test", status: "skipped" },
            ],
          },
          {
            name: `${testRoot}/cli/b.test.ts`,
            startTime: 2_000,
            endTime: 3_000,
            assertionResults: [{ fullName: "failed CLI test", status: "failed", duration: 800 }],
          },
          {
            name: `${testRoot}/state/c.test.ts`,
            startTime: 3_500,
            endTime: 4_500,
            assertionResults: [{ fullName: "fast state test", status: "passed", duration: 500 }],
          },
        ],
      },
      { testRoot },
    );

    expect(summary.counts).toEqual({
      files: 3,
      tests: 4,
      passed: 2,
      failed: 1,
      skipped: 1,
      todo: 0,
    });
    expect(summary.suiteSpanMs).toBe(4_000);
    expect(summary.cumulativeSuiteMs).toBe(6_000);
    expect(summary.cumulativeAssertionMs).toBe(4_300);
    expect(summary.nonAssertionMs).toBe(1_700);
    expect(summary.averageConcurrency).toBe(1.5);
    expect(summary.areas).toEqual([
      { area: "state", files: 2, tests: 3, workerMs: 5_000 },
      { area: "cli", files: 1, tests: 1, workerMs: 1_000 },
    ]);
    expect(summary.slowFiles[0].file).toBe("state/a.test.ts");
    expect(summary.slowTests[0].name).toBe("slow | state test");

    const output = formatSourceBreakdown(summary, { ownerWallMs: 5_000 });
    expect(output).toContain("Status: **FAIL**");
    expect(output).toContain("Harness/startup/shutdown time: **1.000s**");
    expect(output).toContain("Average suite concurrency: **1.50**");
    expect(output).toContain("slow \\| state test");
  });

  it("rejects malformed timing evidence", () => {
    expect(() =>
      summarizeSourceReport(
        {
          success: true,
          testResults: [
            {
              name: `${testRoot}/bad.test.ts`,
              startTime: 2,
              endTime: 1,
              assertionResults: [],
            },
          ],
        },
        { testRoot },
      ),
    ).toThrow("ends before it starts");
  });
});
