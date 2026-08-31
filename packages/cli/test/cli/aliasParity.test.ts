import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildSchemaPayload,
  REMOVED_TOP_LEVEL_CORRECTIONS,
  TRANSITIONAL_TOP_LEVEL_ALIASES,
} from "../../src/cli/commands/schema.js";
import { cmdPrime } from "../../src/cli/commands/prime.js";
import { main } from "../../src/cli/dispatch.js";
import { printTopLevelHelp } from "../../src/cli/help.js";

const temporaryProjects: string[] = [];

type AliasEntry = {
  legacy: string;
  canonical: string;
};

type AdvertisedAlias = AliasEntry & {
  structured_example_argv: string[];
};

const QUIET_CHECK_ALIASES = new Set(["compact", "lint", "validate", "verify"]);

function capture(argv: string[]): { rc: number; out: string; err: string } {
  let out = "";
  let err = "";
  const rc = main(["node", "agentera", ...argv], {
    out: (text) => { out += text; },
    err: (text) => { err += text; },
  });
  return { rc, out, err };
}

function advertisedAliases(): AdvertisedAlias[] {
  return (buildSchemaPayload("schema").commands as Array<Record<string, unknown>>)
    .filter((command) => typeof command.alias_for === "string")
    .map((command) => ({
      legacy: String(command.name),
      canonical: String(command.alias_for),
      structured_example_argv: command.structured_example_argv as string[],
    }));
}

function canonicalArgv(alias: AdvertisedAlias, argv: string[]): string[] {
  return [...alias.canonical.split(" "), ...argv.slice(1)];
}

function parseStructured(result: { out: string; err: string }, label: string): Record<string, unknown> {
  expect(result.out, label).not.toBe("");
  expect(() => JSON.parse(result.out), `${label}\nstdout=${result.out}\nstderr=${result.err}`).not.toThrow();
  return JSON.parse(result.out);
}

afterEach(() => {
  for (const project of temporaryProjects.splice(0)) {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

describe("schema-advertised alias/runtime parity", () => {
  it("advertises exactly the authority-owned transitional aliases", () => {
    const expected = TRANSITIONAL_TOP_LEVEL_ALIASES
      .map(({ legacy, canonical }) => ({ legacy, canonical }));
    const actual = advertisedAliases().map(({ legacy, canonical }) => ({ legacy, canonical }));
    expect(actual).toEqual(expected);
    expect(new Set(actual.map(({ legacy }) => legacy)).size).toBe(actual.length);
  });

  it("executes every advertised alias and its canonical command with matching structured output", () => {
    for (const alias of advertisedAliases()) {
      const argv = [...alias.structured_example_argv];
      if (alias.legacy === "compact") {
        const project = fs.mkdtempSync(path.join(os.tmpdir(), "alias-parity-"));
        temporaryProjects.push(project);
        fs.mkdirSync(path.join(project, ".agentera"));
        fs.writeFileSync(path.join(project, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
        argv[argv.indexOf("PROJECT")] = project;
      }
      const legacy = capture(argv);
      const canonical = capture(canonicalArgv(alias, argv));
      expect(legacy.rc, alias.legacy).toBe(canonical.rc);
      expect(parseStructured(legacy, alias.legacy)).toEqual(parseStructured(canonical, alias.canonical));
      expect(legacy.err).toBe(QUIET_CHECK_ALIASES.has(alias.legacy)
        ? ""
        : `Deprecation: agentera ${alias.legacy} is deprecated; use agentera ${alias.canonical}\n`);
      expect(canonical.err, alias.canonical).toBe("");
    }
  });

  it("keeps every advertised alias structured on invalid input with canonical parity", () => {
    for (const alias of advertisedAliases()) {
      const argv = [alias.legacy, "--alias-parity-invalid", "--format", "json"];
      const legacy = capture(argv);
      const canonical = capture(canonicalArgv(alias, argv));
      expect(legacy.rc, alias.legacy).toBe(2);
      expect(legacy.rc, alias.legacy).toBe(canonical.rc);
      expect(parseStructured(legacy, alias.legacy)).toEqual(parseStructured(canonical, alias.canonical));
      if (QUIET_CHECK_ALIASES.has(alias.legacy)) expect(legacy.err).toBe("");
      else expect(legacy.err).toContain(`Deprecation: agentera ${alias.legacy} is deprecated`);
      expect(canonical.err, alias.canonical).toBe("");
    }
  });

  it("does not advertise retired names and returns an executable structured correction for each", () => {
    const corrections = Object.entries(REMOVED_TOP_LEVEL_CORRECTIONS)
      .map(([legacy, canonical]) => ({ legacy, canonical }));

    const advertised = advertisedAliases();
    for (const { legacy, canonical } of corrections) {
      expect(advertised.some((alias) => alias.legacy === legacy), legacy).toBe(false);
      const rejected = capture([legacy, "--format", "json"]);
      expect(rejected.rc, legacy).toBe(2);
      expect(rejected.err, legacy).toBe("");
      const payload = parseStructured(rejected, legacy) as {
        status: string;
        error: { valid_values: string[]; example: string; recovery: string };
      };
      expect(payload.status).toBe("fail");
      expect(payload.error.valid_values).toContain(canonical);
      expect(payload.error.recovery).toContain(payload.error.example);

      const correction = payload.error.example.split(" ").slice(1);
      const corrected = capture(correction);
      expect(corrected.rc, payload.error.example).not.toBe(2);
      parseStructured(corrected, payload.error.example);
    }
  });

  it("keeps retired gate out of live discovery, startup context, and structured command identity", () => {
    const schemaCommands = buildSchemaPayload("schema").commands as Array<Record<string, unknown>>;
    for (const command of schemaCommands) {
      expect(command.name).not.toBe("gate");
      expect(command.alias_for).not.toBe("gate");
      expect(command.structured_example_argv).not.toEqual(expect.arrayContaining(["gate"]));
    }
    expect(printTopLevelHelp()).not.toContain("  gate ");

    const prime = capturePrimeBuild();
    const expected = prime.execution_context.verification_expectations.expected_commands as Array<{
      command: string;
      source_provenance: unknown;
    }>;
    expect(expected).toEqual([
      expect.objectContaining({ command: "pnpm run verify", source_provenance: expect.any(Array) }),
    ]);
    expect(expected.some(({ command }) => command.split(/\s+/).includes("gate"))).toBe(false);
    expect(JSON.stringify(prime)).not.toContain("agentera gate");

    const project = fs.mkdtempSync(path.join(os.tmpdir(), "gate-retirement-"));
    temporaryProjects.push(project);
    fs.mkdirSync(path.join(project, ".agentera"));
    fs.writeFileSync(path.join(project, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
    const canonical = capture(["check", "compact", "--project", project, "--format", "json"]);
    const transitional = capture(["compact", "--project", project, "--format", "json"]);
    const canonicalPayload = parseStructured(canonical, "check compact");
    expect(canonicalPayload.command).toBe("check compact");
    expect(canonicalPayload).not.toHaveProperty("gate");
    expect(parseStructured(transitional, "compact")).toEqual(canonicalPayload);

    const retired = capture(["gate", "--format", "json"]);
    expect(retired.rc).toBe(2);
    expect(parseStructured(retired, "retired gate")).toMatchObject({
      status: "fail",
      error: {
        valid_values: ["check compact"],
        example: "agentera check compact --format json",
      },
    });
  });
});

function capturePrimeBuild(): Record<string, any> {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "prime-build-verification-"));
  temporaryProjects.push(project);
  fs.writeFileSync(path.join(project, "AGENTS.md"), [
    "| When | Command |",
    "| ---- | ------- |",
    "| Verification | `pnpm verify` |",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ scripts: { verify: "node verify.mjs" } }));
  let out = "";
  const rc = cmdPrime(
    { command: "prime", context: "build", format: "json", projectRoot: project },
    { out: (text) => { out += text; }, err: () => {} },
  );
  expect(rc).toBe(0);
  return JSON.parse(out).capability_context.context;
}
