import { describe, expect, it } from "vitest";

import { makeArgvValueReader, matchesArgvFlag, readArgvFlag } from "../../src/cli/dispatch/argvParser.js";

describe("argvParser", () => {
  it("reads space-separated and equals-form flags", () => {
    expect(readArgvFlag(["--format", "json"], 0, "--format")).toBe("json");
    expect(readArgvFlag(["--format=json"], 0, "--format")).toBe("json");
    expect(readArgvFlag(["--other"], 0, "--format")).toBeNull();
  });

  it("matches flag tokens", () => {
    expect(matchesArgvFlag(["--format", "json"], 0, "--format")).toBe(true);
    expect(matchesArgvFlag(["--format=json"], 0, "--format")).toBe(true);
    expect(matchesArgvFlag(["--other"], 0, "--format")).toBe(false);
  });

  it("advances the outer index for space-separated values", () => {
    const argv = ["--artifact", "plan", "--format", "json"];
    let i = 0;
    const value = makeArgvValueReader(argv, () => i, (n) => {
      i = n;
    });
    expect(value("--artifact")).toBe("plan");
    expect(i).toBe(1);
    i++;
    expect(value("--format")).toBe("json");
    expect(i).toBe(3);
  });
});
