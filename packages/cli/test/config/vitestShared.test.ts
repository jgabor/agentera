import { describe, expect, it } from "vitest";
import { maxWorkersFor } from "../../vitest.shared.ts";

describe("source worker policy", () => {
  it("uses the measured eight-worker default while retaining the explicit override", () => {
    expect(maxWorkersFor({})).toBe(8);
    expect(maxWorkersFor({ VITEST_MAX_WORKERS: "6" })).toBe(6);
  });
});
