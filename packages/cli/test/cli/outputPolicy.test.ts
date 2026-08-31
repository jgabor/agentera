import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

function withEntityProject<T>(run: (root: string) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "output-policy-"));
  const previous = process.cwd();
  const entities = path.join(root, ".agentera/entities/progress/progress_cycle");
  fs.mkdirSync(entities, { recursive: true });
  fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
  fs.writeFileSync(path.join(entities, "aaaaaaaaaa.yaml"), [
    "id: aaaaaaaaaa",
    "artifact: progress",
    "record:",
    "  timestamp: 2026-08-31 00:00",
    "  type: test",
    "  phase: build",
    "  what: Exercise output policy",
    "  context:",
    "    intent: Test nested dispatch",
    "",
  ].join("\n"));
  process.chdir(root);
  try {
    return run(root);
  } finally {
    process.chdir(previous);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function explicitNestedJson(args: string[]): string[] {
  return [args[0], "--format", "json", ...args.slice(1)];
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

  it("exercises every inventoried nested handler with passing and failing JSON behavior", () => {
    withEntityProject((root) => {
      const passing = [
        { route: "check", producer: "runValidate", args: ["check", "validate", "vocabularyAuthority"] },
        { route: "check", producer: "runVerify", args: ["check", "verify", "eval", "skills", "--dry-run"] },
        { route: "check", producer: "runDurability", args: ["check", "durability", "--project", root, "--artifact", "progress", "--id", "aaaaaaaaaa"] },
        { route: "check", producer: "runLint", args: ["check", "lint", "--artifact", "PLAN.md", "--text", "Clear draft text."] },
        { route: "check", producer: "runCompact", args: ["check", "compact", "--project", root, "--mode", "fix"] },
        { route: "check", producer: "runGate", args: ["check", "compact", "--project", root] },
        { route: "state", producer: "runQuery", args: ["state", "query", "--list-artifacts"] },
        { route: "state", producer: "runState", args: ["state", "progress", "list", "--limit", "1"] },
      ];
      const failing = [
        { route: "check", producer: "runValidate", args: ["check", "validate"] },
        { route: "check", producer: "runVerify", args: ["check", "verify", "--bogus"] },
        { route: "check", producer: "runDurability", args: ["check", "durability", "--artifact", "progress"] },
        { route: "check", producer: "runLint", args: ["check", "lint", "--text", "draft"] },
        { route: "state", producer: "runQuery", args: ["state", "query", "--bogus"] },
        { route: "state", producer: "runState", args: ["state", "progress", "bogus"] },
      ];

      for (const { producer, args } of passing) {
        const implicit = capture(args);
        const explicit = capture(explicitNestedJson(args));
        expect(implicit, producer).toEqual(explicit);
        expect(implicit.rc, producer).toBe(0);
        expect(implicit.err, producer).toBe("");
        expect(() => JSON.parse(implicit.out), producer).not.toThrow();
        expect(Buffer.byteLength(implicit.out), producer).toBeLessThanOrEqual(32_768);
      }

      fs.writeFileSync(path.join(root, ".agentera/entities/progress/progress_cycle/bbbbbbbbbb.yaml"), "invalid: [\n");
      failing.push(
        { route: "check", producer: "runCompact", args: ["check", "compact", "--project", root, "--mode", "fix"] },
        { route: "check", producer: "runGate", args: ["check", "compact", "--project", root] },
      );
      for (const route of ["check", "state"]) {
        const inventoried = LIVE_OUTPUT_ROUTE_INVENTORY.find((entry) => entry.route === route)?.producers
          .filter((producer) => producer !== "applyOutputPolicy" && producer !== "emitInvalidInput")
          .sort();
        expect(passing.filter((entry) => entry.route === route).map(({ producer }) => producer).sort()).toEqual(inventoried);
        expect(failing.filter((entry) => entry.route === route).map(({ producer }) => producer).sort()).toEqual(inventoried);
      }
      for (const { producer, args } of failing) {
        const implicit = capture(args);
        const explicit = capture(explicitNestedJson(args));
        expect(implicit, producer).toEqual(explicit);
        expect(implicit.rc, producer).not.toBe(0);
        expect(implicit.err, producer).toBe("");
        expect(() => JSON.parse(implicit.out), producer).not.toThrow();
        expect(Buffer.byteLength(implicit.out), producer).toBeLessThanOrEqual(32_768);
      }
    });
  });

  it.each(["check", "state"])("keeps missing and unsupported nested %s routes bounded and equivalent", (route) => {
    for (const tail of [[], ["unsupported"]]) {
      const implicit = capture([route, ...tail]);
      const explicit = capture([route, "--format=json", ...tail]);
      expect(implicit).toEqual(explicit);
      expect(implicit.rc).toBe(2);
      expect(implicit.err).toBe("");
      expect(JSON.parse(implicit.out).error.class).toBe(tail.length === 0 ? "missing_argument" : "unsupported_target");
      expect(Buffer.byteLength(implicit.out)).toBeLessThanOrEqual(32_768);
    }
  });

  it.each(["text", "yaml"])("rejects operational %s before dispatch", (format) => {
    const result = capture(["schema", "--format", format]);
    expect(result.rc).toBe(2);
    expect(result.err).toBe("");
    expect(JSON.parse(result.out).error).toMatchObject({ class: "invalid_choice", valid_values: ["json"] });
  });

  it.each(["text", "yaml"])("rejects state mutation %s selectors before effects", (format) => {
    withEntityProject((root) => {
      const input = path.join(root, "progress.yaml");
      fs.writeFileSync(input, "what: must not be read\n");
      const before = fs.readdirSync(path.join(root, ".agentera/entities/progress/progress_cycle"));
      const result = capture(["state", "progress", "append", "--input", input, "--format", format]);
      expect(result.rc).toBe(2);
      expect(result.err).toBe("");
      expect(JSON.parse(result.out).error).toMatchObject({ class: "invalid_choice", valid_values: ["json"] });
      expect(fs.readdirSync(path.join(root, ".agentera/entities/progress/progress_cycle"))).toEqual(before);
    });
  });

  it("does not expose a rejected format selector", () => {
    const rejected = "PRIVATE_FORMAT_TRAP";
    const result = capture(["report", "profile-grounding", `--format=${rejected}`]);
    expect(result.rc).toBe(2);
    expect(result.err).toBe("");
    expect(result.out).not.toContain(rejected);
    expect(JSON.parse(result.out).error).toMatchObject({ class: "invalid_choice", valid_values: ["json"] });
    expect(Buffer.byteLength(result.out)).toBeLessThanOrEqual(32_768);
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
