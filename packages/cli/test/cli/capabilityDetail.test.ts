import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { main } from "../../src/cli/dispatch.js";
import { CAPABILITY_INSTRUCTIONS } from "../../src/capabilities/index.js";
import { CAPABILITY_DETAILS } from "../../src/cli/commands/capabilityDetail.js";
import { cmdPrime } from "../../src/cli/commands/prime.js";
import { planStartupContract } from "../../src/cli/capabilityContext/contract.js";
import { sourceBuildOutputRoot, sourceSubprocessEnv } from "../helpers/sourceSubprocess.js";

const root = path.resolve(import.meta.dirname, "../../../..");
const temporary: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function query(args: string[]) {
  let out = "";
  let err = "";
  const rc = main(["node", "agentera", "prime", ...args], {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
  });
  expect(err).toBe("");
  expect(Buffer.byteLength(out)).toBeLessThanOrEqual(32_768);
  return { rc, payload: JSON.parse(out), out };
}
function commandArgs(command: string) {
  return (command.match(/'[^']*'|\S+/g) ?? []).slice(4).map((word) => (word.startsWith("'") ? word.slice(1, -1) : word));
}
function collect(args: string[]) {
  const items: any[] = [];
  let result = query(args);
  const mode = result.payload.completeness.mode;
  for (;;) {
    expect(result.rc, result.out).toBe(0);
    const page = result.payload;
    expect(page.qualifications.worker.status).toBe("available");
    expect(page.completeness.returned).toBe(page.items.length);
    items.push(...page.items);
    if (!page.next_command) break;
    result = query(commandArgs(page.next_command));
  }
  return { items, mode };
}
function reconstruct(args: string[], expected: any): any {
  const { items, mode } = collect(args);
  if (mode === "detail") return items[0].parts ? items.map((item) => item.content).join("") : items[0].content;
  const value: any = Array.isArray(expected) ? [] : {};
  for (const item of items) {
    const key = decodeURIComponent(item.name.split(".").at(-1));
    value[key] = reconstruct(commandArgs(item.content.detail_command), expected[key]);
  }
  return value;
}
describe("bounded static capability execution details", () => {
  it("all twelve startups retain full instructions and exact bounded detail actions independently of availability", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-capability-startup-"));
    temporary.push(dir);
    const previous = process.cwd();
    vi.stubEnv("HOME", dir);
    vi.stubEnv("AGENTERA_HOME", path.join(dir, "absent-app"));
    vi.stubEnv("AGENTERA_BOOTSTRAP_SOURCE_ROOT", root);
    process.chdir(dir);
    try {
      for (const capability of Object.keys(CAPABILITY_INSTRUCTIONS)) {
        let out = "";
        const rc = cmdPrime(
          { context: capability, format: "json" },
          {
            out: (text) => {
              out += text;
            },
          },
        );
        expect(rc, out).toBe(0);
        const context = JSON.parse(out).capability_context;
        expect(context.instructions).toBe(CAPABILITY_INSTRUCTIONS[capability]);
        if (capability === "plan") {
          expect(Buffer.byteLength(out)).toBeLessThanOrEqual(32_768);
          const summary = context.context.planning_context.startup_contract;
          expect(summary.detail_availability).toBe("summary");
          expect(summary.read_before_reliance).toBe(true);
          const complete = reconstruct(commandArgs(summary.detail_command), planStartupContract());
          expect(complete).toEqual(planStartupContract());
          expect(summary.omitted_fields.sort()).toEqual(
            Object.keys(complete)
              .filter((key) => !(key in summary))
              .sort(),
          );
          for (const key of Object.keys(complete).filter((key) => key in summary)) expect(summary[key]).toEqual(complete[key]);
        }
        expect(context.startup.availability).toBeInstanceOf(Array);
        for (const detail of CAPABILITY_DETAILS) {
          expect(context.guidance_details[detail]).toBe(`npx -y agentera@next prime --context ${capability} --detail ${detail}`);
          expect(query(commandArgs(context.guidance_details[detail])).rc).toBe(0);
        }
        expect(context.guidance_details.worker).toBe(`npx -y agentera@next prime --context ${capability} --detail worker`);
      }
    } finally {
      process.chdir(previous);
    }
  });
  for (const capability of Object.keys(CAPABILITY_INSTRUCTIONS)) {
    it(`${capability}: reconstructs all four canonical authorities and shared meanings`, () => {
      for (const detail of CAPABILITY_DETAILS.filter((detail) => detail !== "worker")) {
        const args = ["--context", capability, "--detail", detail, "--limit", "1"];
        const expected = detail === "instructions" ? { instructions: CAPABILITY_INSTRUCTIONS[capability] } : YAML.parse(fs.readFileSync(path.join(root, `skills/agentera/capabilities/${capability}/schemas/${detail}.yaml`), "utf8"));
        const { items } = collect(args);
        for (const [name, value] of Object.entries(expected)) {
          const item = items.find((item) => item.name === name);
          expect(item, name).toBeDefined();
          expect(reconstruct(commandArgs(item.content.detail_command), value)).toEqual(value);
        }
        const protocol = query([...args, "--section", "protocol"]).payload.items[0].content;
        const source = YAML.parse(fs.readFileSync(path.join(root, "skills/agentera/protocol.yaml"), "utf8"));
        expect(protocol.map((entry: any) => entry.name)).toEqual(Object.keys(source));
        expect(protocol.find((entry: any) => entry.name === "OPERATING_RULES").command).toBe("npx -y agentera@next schema --protocol --section 'OPERATING_RULES'");
      }
    });
  }
  it("accepts explicit JSON and rejects operational inputs and malformed selectors", () => {
    const args = ["--context", "build", "--detail", "artifacts"];
    expect(query([...args, "--format", "json"]).out).toBe(query(args).out);
    for (const extra of [["--input", "-"], ["--term-input", "secret"], ["--fields", "instructions"], ["--guidance"], ["--dashboard"], ["--orientation"], ["--format", "text"], ["--limit", "101"], ["--limit", "1.5"], ["--cursor", "bad"], ["--section", "missing"], ["--context", "plan"]])
      expect(query([...args, ...extra]).rc).toBe(64);
    expect(query(["--detail", "instructions"]).rc).toBe(64);
    expect(query(["--context", "../build", "--detail", "instructions"]).rc).toBe(64);
    expect(query(["--context", "build", "--detail", "worker"]).rc).toBe(0);
    expect(query(["--context", "orchestrate", "--detail", "worker"]).rc).toBe(0);
    expect(query(["--context", "unknown", "--detail", "instructions"]).payload.error.recovery).toBe("npx -y agentera@next prime --help");
    const first = query([...args, "--limit", "1"]);
    expect(query(commandArgs(first.payload.next_command).map((arg) => (arg === "build" ? "plan" : arg))).rc).toBe(64);
  });
  it.each(["invalid_exit", "[complete, invalid_exit]"])("rejects selected-document primitive reference %s with the existing structured failure", (value) => {
    vi.stubEnv("AGENTERA_BOOTSTRAP_SOURCE_ROOT", root);
    const target = path.join(root, "skills/agentera/capabilities/build/schemas/exit.yaml");
    const read = fs.readFileSync.bind(fs);
    vi.spyOn(fs, "readFileSync").mockImplementation(((file: any, ...args: any[]) => {
      const text = (read as any)(file, ...args);
      return String(file) === target ? text.replace("exit_signal: complete", `exit_signal: ${value}`) : text;
    }) as any);
    // Validate the selected document even when drilling into a different entry.
    for (const section of [[], ["--section", "EXIT_CONDITIONS.1"], ["--section", "EXIT_CONDITIONS.2"]]) {
      const result = query(["--context", "build", "--detail", "exit", ...section]);
      expect(result.rc).toBe(1);
      expect(result.payload.status).toBe("fail");
      expect(result.payload.error.class).toBe("schema_violation");
      expect(result.payload.error.recovery).toBe("npx -y agentera@next prime --context build --detail exit");
      expect(result.payload).not.toHaveProperty("items");
    }
  });
  it("keeps selected static reads independent of unrelated malformed capability documents", () => {
    vi.stubEnv("AGENTERA_BOOTSTRAP_SOURCE_ROOT", root);
    const target = path.join(root, "skills/agentera/capabilities/build/schemas/exit.yaml");
    const read = fs.readFileSync.bind(fs);
    const seen: string[] = [];
    vi.spyOn(fs, "readFileSync").mockImplementation(((file: any, ...args: any[]) => {
      seen.push(String(file));
      const text = (read as any)(file, ...args);
      return String(file) === target ? text.replace("exit_signal: complete", "exit_signal: invalid_exit") : text;
    }) as any);
    for (const detail of ["instructions", "artifacts", "validation"]) expect(query(["--context", "build", "--detail", detail]).rc).toBe(0);
    expect(query(["--context", "plan", "--detail", "exit"]).rc).toBe(0);
    expect(seen).not.toContain(target);
  });
  it("never reads project/private/installed state or writes during detail dispatch", () => {
    const read = fs.readFileSync.bind(fs);
    const seen: string[] = [];
    vi.spyOn(fs, "readFileSync").mockImplementation(((file: any, ...args: any[]) => {
      const name = String(file);
      seen.push(name);
      if (name.includes("/.agentera/") || name.includes("PROFILE.md") || name.includes("/history/") || name.endsWith("SKILL.md")) throw new Error("Private read forbidden");
      return (read as any)(file, ...args);
    }) as any);
    const write = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("Write forbidden");
    });
    for (const capability of Object.keys(CAPABILITY_INSTRUCTIONS)) for (const detail of CAPABILITY_DETAILS) expect(query(["--context", capability, "--detail", detail]).rc).toBe(0);
    expect(seen.length).toBeGreaterThan(0);
    expect(write).not.toHaveBeenCalled();
  });
  it("fresh-process detail is independent of absent/legacy/partial/corrupt project state and fails truthfully on missing authority", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-capability-detail-"));
    temporary.push(dir);
    const project = path.join(dir, "project");
    fs.mkdirSync(project);
    const run = (authority: string, detail = "artifacts") =>
      spawnSync(process.execPath, [path.join(sourceBuildOutputRoot(), "bin/agentera.js"), "prime", "--context", "build", "--detail", detail], {
        cwd: project,
        encoding: "utf8",
        env: sourceSubprocessEnv({
          ...process.env,
          HOME: dir,
          AGENTERA_HOME: path.join(dir, "stale-installed"),
          AGENTERA_BOOTSTRAP_SOURCE_ROOT: authority,
        }),
      });
    const baseline = run(root);
    expect(baseline.status, baseline.stderr).toBe(0);
    fs.mkdirSync(path.join(project, ".agentera"));
    for (const text of ["meta: {version: '2.0.0'}\n", "entities: {partial: true}\n", "secret: [corrupt\n"]) {
      fs.writeFileSync(path.join(project, ".agentera/plan.yaml"), text);
      const result = run(root);
      expect(result.stdout).toBe(baseline.stdout);
      expect(result.stderr).toBe("");
      expect(fs.readFileSync(path.join(project, ".agentera/plan.yaml"), "utf8")).toBe(text);
    }
    const missing = run(dir);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toBe("");
    expect(JSON.parse(missing.stdout).error.class).toBe("schema_violation");
    const writerBoundary = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `const writer = await import(${JSON.stringify(pathToFileURL(path.join(sourceBuildOutputRoot(), "state/write/runtimeOperations.js")).href)}); try { writer.runtimeOperationSpec("todo", "create"); process.exitCode = 1; } catch { process.stdout.write("validated at access"); }`],
      {
        encoding: "utf8",
        env: sourceSubprocessEnv({ ...process.env, AGENTERA_BOOTSTRAP_SOURCE_ROOT: dir }),
      },
    );
    expect(writerBoundary.status, writerBoundary.stderr).toBe(0);
    expect(writerBoundary.stdout).toBe("validated at access");
    fs.mkdirSync(path.join(dir, "skills/agentera/capabilities/build/schemas"), { recursive: true });
    for (const name of ["protocol.yaml", "capability_schema_contract.yaml"]) fs.copyFileSync(path.join(root, "skills/agentera", name), path.join(dir, "skills/agentera", name));
    const target = path.join(dir, "skills/agentera/capabilities/build/schemas/artifacts.yaml");
    for (const text of ["ARTIFACTS: [broken\n", "ARTIFACTS: {}\n", "ARTIFACTS: {1: {id: A1}}\n"]) {
      fs.writeFileSync(target, text);
      const result = run(dir);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout).error.class).toBe("schema_violation");
    }
    fs.copyFileSync(path.join(root, "skills/agentera/capabilities/build/schemas/artifacts.yaml"), target);
    expect(run(dir).status).toBe(0);
    vi.stubEnv("AGENTERA_BOOTSTRAP_SOURCE_ROOT", dir);
    const first = query(["--context", "build", "--detail", "artifacts", "--limit", "1"]);
    fs.appendFileSync(target, "\n# changed authority revision\n");
    expect(query(commandArgs(first.payload.next_command)).rc).toBe(64);
    const protocolPath = path.join(dir, "skills/agentera/protocol.yaml");
    const protocol = YAML.parse(fs.readFileSync(protocolPath, "utf8"));
    protocol.meta.version = "9.0.0";
    fs.writeFileSync(protocolPath, YAML.stringify(protocol));
    expect(run(dir).status).toBe(1);
    fs.writeFileSync(path.join(dir, "skills/agentera/protocol.yaml"), "meta: {name: protocol, version: 1.0.0}\n");
    expect(run(dir).status).toBe(1);
  });
});
