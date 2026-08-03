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

  it("retains the deprecated issues count alias without duplicating todo detail", () => {
    const { payload, err } = primePayload();
    const todo = payload.todo as Record<string, unknown>;
    const issues = payload.issues as Record<string, unknown>;
    expect(Object.keys(issues)).toEqual(["critical", "degraded", "normal", "annoying"]);
    for (const field of Object.keys(issues)) expect(issues[field]).toBe(todo[field]);
    expect(issues).not.toHaveProperty("detail");
    expect(err).toContain("deprecated");
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
