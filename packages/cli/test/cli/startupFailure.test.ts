import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { bootstrapSourceFailure, classifyStartupError, startupFailureEnvelope, STARTUP_FAILURE_SCHEMA } from "../../src/cli/startupFailure.js";
import { sourceBuildOutputRoot, sourceSubprocessEnv } from "../helpers/sourceSubprocess.js";

const root = path.resolve(import.meta.dirname, "../../../..");
const temporaries: string[] = [];

afterEach(() => {
  for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function temporary(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-startup-failure-"));
  temporaries.push(directory);
  return directory;
}

/** A complete source root copy whose authorities a test may break. */
function sourceCopy(): { base: string; source: string; project: string; home: string } {
  const base = temporary();
  const source = path.join(base, "source");
  for (const entry of ["references", "skills", "registry.json"]) fs.cpSync(path.join(root, entry), path.join(source, entry), { recursive: true });
  const project = path.join(base, "project");
  fs.mkdirSync(path.join(project, ".agentera"), { recursive: true });
  fs.writeFileSync(path.join(project, ".agentera", "state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
  return { base, source, project, home: path.join(base, "home") };
}

function snapshot(directory: string): string[] {
  return (fs.readdirSync(directory, { recursive: true }) as string[]).sort();
}

function run(copy: ReturnType<typeof sourceCopy>, args: string[]) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: copy.home,
    XDG_CONFIG_HOME: path.join(copy.home, ".config"),
    XDG_DATA_HOME: path.join(copy.home, ".local/share"),
    XDG_CACHE_HOME: path.join(copy.home, ".cache"),
    XDG_STATE_HOME: path.join(copy.home, ".local/state"),
    AGENTERA_BOOTSTRAP_SOURCE_ROOT: copy.source,
  };
  delete env.AGENTERA_HOME;
  delete env.AGENTERA_PROFILE_DIR;
  delete env.AGENTERA_DEFAULT_INSTALL_ROOT;
  return spawnSync(process.execPath, [path.join(sourceBuildOutputRoot(), "bin/agentera.js"), ...args], { cwd: copy.project, encoding: "utf8", env: sourceSubprocessEnv(env) });
}

const INVOCATIONS = [["prime", "--context", "status", "--format", "json"], ["prime", "--context", "status"], ["doctor", "--format", "json"], ["doctor"]];

function expectStartupFailure(result: ReturnType<typeof run>, command: string, classification: string, reason: string): void {
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.stderr).toBe("");
  expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ schemaVersion: STARTUP_FAILURE_SCHEMA, status: "fail", command, classification, reason, state_changed: false });
  expect(result.stdout).not.toMatch(/ModuleJob|YAMLParseError|\n\s+at /);
}

describe("startup failure classification", () => {
  it("classifies runtime authority faults by kind, never by raw message", () => {
    const env = { AGENTERA_BOOTSTRAP_SOURCE_ROOT: root };
    const enoent = Object.assign(new Error("ENOENT: open /secret/path"), { code: "ENOENT" });
    const parse = Object.assign(new Error("Nested mappings are not allowed\n\n  a: [\n"), { name: "YAMLParseError" });
    expect(classifyStartupError(enoent, env)).toEqual({ classification: "runtime_authority_unavailable", reason: "missing" });
    expect(classifyStartupError(Object.assign(new Error("denied"), { code: "EACCES" }), env)).toEqual({ classification: "runtime_authority_unavailable", reason: "unreadable" });
    expect(classifyStartupError(parse, env)).toEqual({ classification: "runtime_authority_unavailable", reason: "malformed" });
    expect(classifyStartupError(new Error("YAML root must be a mapping"), env)).toEqual({ classification: "runtime_authority_unavailable", reason: "invalid" });
    const envelope = JSON.stringify(startupFailureEnvelope(classifyStartupError(parse, env), "prime", env));
    expect(envelope).not.toContain("Nested mappings");
  });

  it("reports an incomplete bootstrap source and accepts a complete one", () => {
    const empty = temporary();
    expect(bootstrapSourceFailure({ AGENTERA_BOOTSTRAP_SOURCE_ROOT: root })).toBeNull();
    const failure = classifyStartupError(new Error("ENOENT"), { AGENTERA_BOOTSTRAP_SOURCE_ROOT: empty });
    expect(failure).toEqual({ classification: "bootstrap_source_missing", reason: "missing", root: empty, missing: ["skills", "skills/agentera/SKILL.md", "registry.json"] });
    expect(startupFailureEnvelope(failure, "doctor", { AGENTERA_BOOTSTRAP_SOURCE_ROOT: empty })).toMatchObject({
      schemaVersion: STARTUP_FAILURE_SCHEMA,
      command: "doctor",
      recovery: expect.stringContaining("AGENTERA_BOOTSTRAP_SOURCE_ROOT"),
      state_changed: false,
    });
  });
});

describe("executable startup failure boundary", () => {
  it("runs prime and doctor normally with valid authority", () => {
    const copy = sourceCopy();
    const prime = run(copy, ["prime", "--context", "status"]);
    expect(prime.status, prime.stdout + prime.stderr).toBe(0);
    expect(JSON.parse(prime.stdout)).toMatchObject({ command: "prime", outcome: "ok" });
    const doctor = JSON.parse(run(copy, ["doctor"]).stdout) as Record<string, unknown>;
    expect(doctor.schemaVersion).not.toBe(STARTUP_FAILURE_SCHEMA);
    expect(doctor.signals).not.toContainEqual(expect.objectContaining({ kind: "version_authority_invalid" }));
  });

  it("returns one typed JSON failure when an authority breaks while the CLI is starting", () => {
    const copy = sourceCopy();
    fs.writeFileSync(path.join(copy.source, "references/artifacts/state-storage-authority.yaml"), "a: [\n  b: {\n");
    const before = snapshot(copy.base);
    for (const args of INVOCATIONS) expectStartupFailure(run(copy, args), args[0], "runtime_authority_unavailable", "malformed");
    expect(snapshot(copy.base)).toEqual(before);
  });

  it("returns the same typed failure from prime and doctor when the bootstrap source is incomplete", () => {
    const copy = sourceCopy();
    fs.rmSync(path.join(copy.source, "registry.json"));
    const before = snapshot(copy.base);
    const outputs = INVOCATIONS.map((args) => {
      const result = run(copy, args);
      expectStartupFailure(result, args[0], "bootstrap_source_missing", "missing");
      const { command: _command, ...rest } = JSON.parse(result.stdout) as Record<string, unknown>;
      return rest;
    });
    for (const output of outputs) expect(output).toEqual(outputs[0]);
    expect(snapshot(copy.base)).toEqual(before);
  });

  it("fails prime closed on corrupt version authority while doctor keeps its repair report", () => {
    const copy = sourceCopy();
    fs.writeFileSync(path.join(copy.source, "registry.json"), "{ broken");
    expectStartupFailure(run(copy, ["prime", "--context", "status"]), "prime", "version_authority_invalid", "malformed");
    const doctor = run(copy, ["doctor"]);
    expect(doctor.status).toBe(1);
    expect(JSON.parse(doctor.stdout)).toMatchObject({ status: "repair_needed", signals: expect.arrayContaining([expect.objectContaining({ kind: "version_authority_invalid", versionAuthority: "malformed" })]) });
  });
});
