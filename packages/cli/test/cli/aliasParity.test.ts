import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import { buildSchemaPayload } from "../../src/cli/commands/schema.js";
import { main } from "../../src/cli/dispatch.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const AUTHORITY_PATH = path.join(REPO_ROOT, "references/cli/audience-namespace-cli-migration.yaml");
const temporaryProjects: string[] = [];

type AliasEntry = {
  legacy: string;
  canonical: string;
};

type AdvertisedAlias = AliasEntry & {
  structured_example_argv: string[];
};

function capture(argv: string[]): { rc: number; out: string; err: string } {
  let out = "";
  let err = "";
  const rc = main(["node", "agentera", ...argv], {
    out: (text) => { out += text; },
    err: (text) => { err += text; },
  });
  return { rc, out, err };
}

function authority(): Record<string, unknown> {
  return YAML.parse(fs.readFileSync(AUTHORITY_PATH, "utf8"));
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
    const expected = (authority().transitional_stderr_aliases as AliasEntry[])
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
        argv[argv.indexOf("PROJECT")] = project;
      }
      const legacy = capture(argv);
      const canonical = capture(canonicalArgv(alias, argv));
      expect(legacy.rc, alias.legacy).toBe(canonical.rc);
      expect(parseStructured(legacy, alias.legacy)).toEqual(parseStructured(canonical, alias.canonical));
      expect(legacy.err).toBe(
        `Deprecation: agentera ${alias.legacy} is deprecated; use agentera ${alias.canonical}\n`,
      );
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
      expect(legacy.err).toContain(`Deprecation: agentera ${alias.legacy} is deprecated`);
      expect(canonical.err, alias.canonical).toBe("");
    }
  });

  it("does not advertise retired names and returns an executable structured correction for each", () => {
    const contract = authority();
    const removed = contract.removed_top_level_commands as string[];
    const corrections = contract.removed_top_level_corrections as AliasEntry[];
    expect(corrections.map(({ legacy }) => legacy)).toEqual(removed);

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
});
