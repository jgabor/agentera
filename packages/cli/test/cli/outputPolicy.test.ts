import { describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch.js";
import { applyOutputPolicy, classifyOutputPath, OUTPUT_PATH_POLICIES } from "../../src/cli/outputPolicy.js";

function capture(args: string[]) {
  let out = "";
  let err = "";
  const rc = main(["node", "agentera", ...args], { out: (text) => (out += text), err: (text) => (err += text) });
  return { rc, out, err };
}

describe("shared output policy", () => {
  it("classifies every success and error path", () => {
    expect(Object.keys(OUTPUT_PATH_POLICIES).sort()).toEqual(["help", "operational", "prime_guidance", "version"]);
    expect(new Set(Object.values(OUTPUT_PATH_POLICIES).map((entry) => entry.error))).toEqual(new Set(["json"]));
    expect(classifyOutputPath(["schema"]).class).toBe("operational");
  });

  it("defaults operational output to the explicit JSON contract", () => {
    const implicit = capture(["schema"]);
    const explicit = capture(["schema", "--format", "json"]);
    expect(implicit).toEqual(explicit);
    expect(JSON.parse(implicit.out).command).toBe("schema");
  });

  it.each(["text", "yaml"])("rejects operational %s before dispatch", (format) => {
    const result = capture(["schema", "--format", format]);
    expect(result.rc).toBe(2);
    expect(result.err).toBe("");
    expect(JSON.parse(result.out).error).toMatchObject({ class: "invalid_choice", valid_values: ["json"] });
  });

  it("keeps each text exception text-only", () => {
    for (const args of [[], ["--help"], ["--version"], ["prime", "--guidance"]]) {
      const result = capture(args);
      expect(result.rc).toBe(0);
      expect(() => JSON.parse(result.out)).toThrow();
    }
  });

  it("returns JSON errors for selectors on text exceptions", () => {
    for (const args of [["--help", "--format", "json"], ["--version", "--format=json"], ["prime", "--guidance", "--format", "json"]]) {
      const result = capture(args);
      expect(result.rc).toBe(2);
      expect(result.err).toBe("");
      expect(JSON.parse(result.out).error.class).toBe("unrecognized_argument");
    }
  });

  it("rejects duplicate and missing operational selectors", () => {
    for (const args of [["schema", "--format", "json", "--format=json"], ["schema", "--format"]]) {
      let out = "";
      const result = applyOutputPolicy(args, { out: (text) => (out += text) });
      expect(result).toBe(2);
      expect(JSON.parse(out).error.class).toBe("invalid_choice");
    }
  });
});
