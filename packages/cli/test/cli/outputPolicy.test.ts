import { describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch.js";
import { DISPATCHER_TOP_LEVEL_COMMANDS } from "../../src/cli/dispatch/commands.js";
import { applyOutputPolicy, LIVE_OUTPUT_ROUTE_INVENTORY, OUTPUT_PATH_POLICIES } from "../../src/cli/outputPolicy.js";

function capture(args: string[]) {
  let out = "";
  let err = "";
  const rc = main(["node", "agentera", ...args], { out: (text) => (out += text), err: (text) => (err += text) });
  return { rc, out, err };
}

describe("shared output policy", () => {
  it("classifies every success and error path", () => {
    expect(Object.keys(OUTPUT_PATH_POLICIES).sort()).toEqual(["help", "operational", "prime_guidance", "version"]);
    const operationalRoutes = LIVE_OUTPUT_ROUTE_INVENTORY
      .filter(({ kind }) => kind === "operational")
      .map(({ route }) => route);
    expect(operationalRoutes).toEqual(["version", ...DISPATCHER_TOP_LEVEL_COMMANDS]);
    expect(LIVE_OUTPUT_ROUTE_INVENTORY.every(({ producers }) => producers.length > 0)).toBe(true);
    expect(LIVE_OUTPUT_ROUTE_INVENTORY.every(({ error }) => error === "json")).toBe(true);
    expect(LIVE_OUTPUT_ROUTE_INVENTORY.filter(({ kind }) => kind === "exception").every(({ success }) => success === "text")).toBe(true);
    expect(LIVE_OUTPUT_ROUTE_INVENTORY.filter(({ kind }) => kind === "operational").every(({ success }) => success === "json")).toBe(true);
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

  it.each([
    ["bare", [], ["--format", "json"]],
    ["top-level help", ["--help"], ["--help", "unexpected"]],
    ["command help", ["schema", "--help"], ["unexpected", "--help"]],
    ["version", ["--version"], ["--version", "unexpected"]],
    ["guidance", ["prime", "--guidance"], ["prime", "--guidance", "unexpected"]],
  ])("keeps valid %s text and rejects its invalid producer path as JSON", (_name, valid, invalid) => {
    const success = capture(valid);
    expect(success.rc).toBe(0);
    expect(success.err).toBe("");
    expect(() => JSON.parse(success.out)).toThrow();

    const failure = capture(invalid);
    expect(failure.rc).toBe(2);
    expect(failure.err).toBe("");
    expect(JSON.parse(failure.out)).toMatchObject({ schemaVersion: "agentera.invalidInputEnvelope.v2", status: "fail" });
  });

  it("returns JSON errors for selectors on text exceptions", () => {
    for (const args of [["--help", "--format", "json"], ["--version", "--format=json"], ["prime", "--guidance", "--format", "json"]]) {
      const result = capture(args);
      expect(result.rc).toBe(2);
      expect(result.err).toBe("");
      expect(JSON.parse(result.out).error.class).toBe("unrecognized_argument");
    }
  });

  it.each([
    [["prime", "--context", "build", "--guidance"], "mutually_exclusive"],
    [["prime", "--dashboard", "--guidance"], "mutually_exclusive"],
    [["prime", "--guidance", "--input", "unread.yaml"], "unsupported_target"],
  ])("rejects the invalid guidance combination %j as JSON", (args, errorClass) => {
    const result = capture(args);
    expect(result.rc).toBe(2);
    expect(result.err).toBe("");
    expect(JSON.parse(result.out).error.class).toBe(errorClass);
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
