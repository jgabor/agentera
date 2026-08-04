import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cmdPrime } from "../../src/cli/commands/prime.js";
import { buildSchemaPayload } from "../../src/cli/commands/schema.js";
import { PRIME_STRUCTURED_FIELDS } from "../../src/cli/stateQuery.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

let tmp = "";
let previousCwd = "";
let previousHome: string | undefined;
let previousAppHome: string | undefined;
let previousSourceRoot: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prime-compat-"));
  const home = path.join(tmp, "home");
  const appHome = path.join(home, "agentera");
  const project = path.join(tmp, "project");
  fs.mkdirSync(appHome, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  previousCwd = process.cwd();
  previousHome = process.env.HOME;
  previousAppHome = process.env.AGENTERA_HOME;
  previousSourceRoot = process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  process.env.HOME = home;
  process.env.AGENTERA_HOME = appHome;
  process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = REPO_ROOT;
  process.chdir(project);
});

afterEach(() => {
  process.chdir(previousCwd);
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousAppHome === undefined) delete process.env.AGENTERA_HOME;
  else process.env.AGENTERA_HOME = previousAppHome;
  if (previousSourceRoot === undefined) delete process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  else process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = previousSourceRoot;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function capture(args: Parameters<typeof cmdPrime>[0]): { rc: number; out: string; err: string } {
  let out = "";
  let err = "";
  const rc = cmdPrime(args, { out: (text) => { out += text; }, err: (text) => { err += text; } });
  return { rc, out, err };
}

function primePayload(fields?: string): { payload: Record<string, unknown>; err: string } {
  const result = capture({ command: "prime", format: "json", ...(fields ? { fields } : {}) });
  expect(result.rc).toBe(0);
  return { payload: JSON.parse(result.out) as Record<string, unknown>, err: result.err };
}

const projectionCases = [
  {
    name: "sparse",
    args: { command: "prime", format: "json", fields: "todo" } as const,
    todo: (payload: Record<string, any>) => payload.todo,
  },
  {
    name: "status",
    args: { command: "prime", context: "status", format: "json" } as const,
    todo: (payload: Record<string, any>) => payload.capability_context.context.status_context.todo,
  },
  {
    name: "capability",
    args: { command: "prime", context: "build", format: "json" } as const,
    todo: (payload: Record<string, any>) => payload.capability_context.startup.availability.find(
      (entry: Record<string, unknown>) => entry.family === "todo",
    ),
  },
] as const;

describe("prime runtime compatibility boundary", () => {
  it("accepts every declared prime field and rejects unknown fields", () => {
    const result = capture({ command: "prime", format: "json", fields: PRIME_STRUCTURED_FIELDS.join(",") });
    expect(result.rc).toBe(0);
    const payload = JSON.parse(result.out) as Record<string, unknown>;
    for (const field of PRIME_STRUCTURED_FIELDS) expect(payload).toHaveProperty(field);
    expect(capture({ command: "prime", format: "json", fields: "not_a_real_field" }).rc).toBe(1);
  });

  it("keeps inactive conditional fields out of the default briefing", () => {
    const { payload } = primePayload();
    expect(payload).toHaveProperty("state_presence");
    for (const field of ["v1_migration", "docs", "objective"]) {
      expect(payload).not.toHaveProperty(field);
    }
  });

  it("uses one canonical field set for source_contract and schema discovery", () => {
    const { payload } = primePayload();
    const sourceContract = payload.source_contract as Record<string, unknown>;
    expect([...(sourceContract.fields as string[])].sort()).toEqual([...PRIME_STRUCTURED_FIELDS].sort());

    const schema = buildSchemaPayload("schema") as Record<string, unknown>;
    const commands = schema.commands as Array<{ name: string; structured_fields: string[] }>;
    const prime = commands.find((entry) => entry.name === "prime");
    expect(prime?.structured_fields).toEqual([...PRIME_STRUCTURED_FIELDS, "capability_context"]);
    const structuredOutput = schema.structured_output as { fields_by_command: { status: string[] } };
    expect(structuredOutput.fields_by_command.status).toEqual(PRIME_STRUCTURED_FIELDS);
  });

  it("emits only the canonical TODO field without an alias warning", () => {
    const { payload, err } = primePayload();
    expect(payload.todo).toEqual(expect.objectContaining({
      critical: expect.any(Number),
      degraded: expect.any(Number),
      normal: expect.any(Number),
      annoying: expect.any(Number),
    }));
    expect(payload).not.toHaveProperty("issues");
    expect(err).toBe("");
  });

  describe.each(projectionCases)("$name projection", ({ args, todo }) => {
    it("passes with canonical TODO output", () => {
      const result = capture(args);
      expect(result.rc).toBe(0);
      expect(todo(JSON.parse(result.out) as Record<string, any>)).toBeTruthy();
      expect(result.err).toBe("");
    });

    it("rejects the retired alias with one structured TODO correction", () => {
      const result = capture({ ...args, fields: "issues" });
      expect(result.rc).toBe(2);
      expect(result.err).toBe("");
      expect(JSON.parse(result.out)).toMatchObject({
        schemaVersion: "agentera.invalidInputEnvelope.v2",
        status: "fail",
        error: {
          class: "invalid_choice",
          valid_values: ["todo"],
          recovery: expect.stringContaining("'todo'"),
        },
      });
    });
  });

  it("returns each omitted conditional field when explicitly selected", () => {
    for (const field of ["v1_migration", "docs", "objective"]) {
      const { payload } = primePayload(field);
      expect(payload).toHaveProperty(field);
      expect(payload).toHaveProperty("command");
    }
  });

  it("emits detected v1 migration state in the default briefing", () => {
    fs.mkdirSync(path.join(process.cwd(), ".agentera"), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), ".agentera", "PROGRESS.md"), "# progress\n");
    const { payload } = primePayload();
    expect(payload.v1_migration).toMatchObject({ detected: true });
  });

  it("names CLI recovery commands for omitted startup detail", () => {
    const { payload } = primePayload();
    const source = payload.source_contract as Record<string, unknown>;
    const capabilityContext = source.capability_context as Record<string, unknown>;
    const startup = payload.startup as Record<string, unknown>;
    expect(capabilityContext.fetch_command).toContain("agentera prime --context");
    expect((startup.detail_discovery as Record<string, unknown>).schema).toContain("agentera schema");
  });
});
