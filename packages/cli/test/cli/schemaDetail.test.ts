import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { main } from "../../src/cli/dispatch.js";
import { stateWriterArtifactContract } from "../../src/state/write/operations.js";
import { sourceBuildOutputRoot, sourceSubprocessEnv } from "../helpers/sourceSubprocess.js";
import { schemaDetailDiscovery } from "../../src/cli/commands/schemaDetail.js";
import { guidanceDetail, GuidanceInputError, type GuidanceSection } from "../../src/cli/guidanceDetail.js";

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
  const rc = main(["node", "agentera", "schema", ...args], {
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
function commandArgs(command: string): string[] {
  // All selected production command values here contain no embedded shell quote.
  return (command.match(/'[^']*'|\S+/g) ?? []).slice(4).map((word) => (word.startsWith("'") ? word.slice(1, -1) : word));
}
function collect(args: string[]) {
  const items: any[] = [];
  let result = query(args);
  const mode = result.payload.completeness.mode;
  for (;;) {
    expect(result.rc, result.out).toBe(0);
    const page = result.payload;
    expect(page.completeness.returned).toBe(page.items.length);
    expect(page.completeness.omitted).toBe(page.completeness.total - page.items.length);
    items.push(...page.items);
    if (!page.next_command) break;
    result = query(commandArgs(page.next_command));
  }
  return { mode, items };
}
function reconstruct(args: string[], expected: unknown): unknown {
  const { mode, items } = collect(args);
  if (mode === "detail") return items[0].parts ? items.map((item) => item.content).join("") : items[0].content;
  const value: any = Array.isArray(expected) ? [] : {};
  for (const item of items) {
    const key = decodeURIComponent(item.name.split(".").at(-1));
    value[key] = reconstruct(commandArgs(item.content.detail_command), (expected as any)[key]);
  }
  return value;
}

describe("selected static schema contracts", () => {
  it("links only the current writer operations without inventing singleton writers", () => {
    for (const { artifact } of schemaDetailDiscovery().artifacts) {
      const writing = query(["--artifact", artifact, "--section", "writing"]).payload.items[0].content;
      const current = stateWriterArtifactContract(artifact, "compact");
      expect(writing.explain_command).toBe(current ? `npx -y agentera@next state ${artifact} explain` : null);
      expect(writing.explain_by_verb).toEqual(Object.fromEntries(Object.entries(current?.explain_by_verb ?? {}).map(([verb, command]) => [verb, String(command).replace(/^agentera /, "npx -y agentera@next ")])));
    }
  });
  it("keeps fresh-process static discovery independent of operational import-time authorities", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-static-process-"));
    temporary.push(dir);
    const run = () =>
      spawnSync(process.execPath, [path.join(sourceBuildOutputRoot(), "bin/agentera.js"), "schema", "--protocol"], {
        cwd: dir,
        encoding: "utf8",
        env: sourceSubprocessEnv({
          ...process.env,
          HOME: dir,
          AGENTERA_HOME: path.join(dir, "missing-home"),
          AGENTERA_BOOTSTRAP_SOURCE_ROOT: dir,
        }),
      });
    const missing = run();
    expect(missing.status).toBe(1);
    expect(missing.stderr).toBe("");
    expect(JSON.parse(missing.stdout)).toMatchObject({
      status: "fail",
      error: { class: "schema_violation" },
    });
    fs.mkdirSync(path.join(dir, "skills/agentera"), { recursive: true });
    fs.copyFileSync(path.join(root, "skills/agentera/protocol.yaml"), path.join(dir, "skills/agentera/protocol.yaml"));
    const available = run();
    expect(available.status, available.stderr).toBe(0);
    expect(JSON.parse(available.stdout).schemaVersion).toBe("agentera.guidanceDetail.v1");
    expect(fs.readdirSync(dir)).toEqual(["skills"]);
  });
  it("discovers and losslessly serves all twelve artifact schemas and both shared contracts", () => {
    const discovery = schemaDetailDiscovery();
    const owners = [
      ...discovery.artifacts.map(({ artifact, command }) => ({
        command,
        file: `skills/agentera/schemas/artifacts/${artifact}.yaml`,
      })),
      { command: discovery.protocol, file: "skills/agentera/protocol.yaml" },
      {
        command: discovery.capability_contract,
        file: "skills/agentera/capability_schema_contract.yaml",
      },
    ];
    expect(discovery.artifacts).toHaveLength(12);
    for (const owner of owners) {
      const source = YAML.parse(fs.readFileSync(path.join(root, owner.file), "utf8"));
      const index = collect([...commandArgs(owner.command), "--limit", "7"]);
      for (const [name, expected] of Object.entries(source)) {
        const entry = index.items.find((item) => item.name === name);
        expect(entry, `${owner.file} ${name}`).toBeDefined();
        expect(entry.authority).toBe(owner.file);
        expect(entry.classification).toBeTruthy();
        expect(reconstruct(commandArgs(entry.content.detail_command), expected), `${owner.file} ${name}`).toEqual(expected);
      }
      const notes = index.items.find((item) => item.name === "source_notes");
      expect(notes).toBeDefined();
      expect(collect(commandArgs(notes.content.detail_command)).items.length).toBeGreaterThan(0);
    }
  }, 120_000);

  it("serves required referenced primitives and complete nested storage/authoring guidance", () => {
    for (const [owner, section, file] of [
      [["--artifact", "glossary"], "entry", "references/artifacts/glossary-entry-contract.yaml"],
      [["--artifact", "plan"], "storage", "references/artifacts/state-storage-authority.yaml"],
      [["--capability-contract"], "instructions", "references/cli/capability-instruction-contract.yaml"],
    ] as const) {
      const expected = YAML.parse(fs.readFileSync(path.join(root, file), "utf8"));
      expect(reconstruct([...owner, "--section", section, "--limit", "3"], expected)).toEqual(expected);
    }
    const plan = query(["--artifact", "plan", "--section", "TASK"]);
    expect(plan.payload.qualifications.entity_authority.aggregate_schema_below).toBe("atomic_create_input");
    expect(plan.payload.qualifications.source_meta.authority).toBe("legacy_migration_input_only");
    expect(plan.payload.qualifications.storage_authority.implementation_boundary).toContain("no independent legacy");
    const progress = query(["--artifact", "progress", "--section", "BUDGET"]);
    expect(progress.payload.qualifications.entity_authority.legacy_schema_below).toBe("migration_input_only");
  }, 120_000);

  it("does not read project, host, profile, history or write any files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-static-contract-"));
    temporary.push(dir);
    fs.mkdirSync(path.join(dir, ".agentera"));
    fs.writeFileSync(path.join(dir, ".agentera", "docs.yaml"), "secret: [corrupt");
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    vi.stubEnv("HOME", dir);
    vi.stubEnv("AGENTERA_HOME", path.join(dir, "missing-home"));
    const read = vi.spyOn(fs, "readFileSync");
    const write = vi.spyOn(fs, "writeFileSync");
    for (const args of [["--artifact", "vision"], ["--protocol"], ["--capability-contract"]]) expect(query(args).rc).toBe(0);
    expect(read.mock.calls.every(([file]) => !String(file).startsWith(dir))).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    ["--artifact", "../plan"],
    ["--artifact"],
    ["--protocol", "--artifact", "plan"],
    ["--protocol", "--protocol"],
    ["--section", "BUDGET"],
    ["--limit", "1"],
    ["--protocol", "--section", "../secret"],
    ["--protocol", "--limit", "0"],
    ["--protocol", "--limit", "101"],
    ["--protocol", "--limit", "1.5"],
    ["--protocol", "--cursor", "bad"],
    ["--protocol", "--format", "yaml"],
    ["--protocol", "--project", "/private"],
    ["--protocol=true"],
    ["--artifact=plan", "--apply"],
  ])("rejects invalid static selectors with structured exact recovery: %j", (...args) => {
    const result = query(args);
    expect(result.rc).toBe(64);
    expect(result.payload.schemaVersion).toBe("agentera.invalidInputEnvelope.v2");
    expect(result.payload.error).toMatchObject({
      class: expect.any(String),
      syntax: expect.any(String),
      example: expect.any(String),
      recovery: expect.stringMatching(/^npx -y agentera@next schema/),
    });
    expect(result.out).not.toContain("/private");
  });

  it("preserves explicit JSON and rejects stale or cross-selection cursors", () => {
    expect(query(["--protocol", "--format", "json"]).out).toBe(query(["--protocol"]).out);
    const next = commandArgs(query(["--protocol", "--limit", "1"]).payload.next_command);
    expect(query(next).rc).toBe(0);
    expect(query(next.map((value) => (value === "1" ? "2" : value))).rc).toBe(64);
    expect(query(next.map((value) => (value === "--protocol" ? "--capability-contract" : value))).rc).toBe(64);
  });

  it("invalidates cached comments and cursors and revalidates changed authority metadata", () => {
    const next = commandArgs(query(["--protocol", "--limit", "1"]).payload.next_command);
    const file = path.join(root, "skills/agentera/protocol.yaml");
    const read = fs.readFileSync.bind(fs);
    let change = "comment";
    vi.spyOn(fs, "readFileSync").mockImplementation(((selected: any, ...args: any[]) => {
      const text = (read as any)(selected, ...args);
      if (String(selected) !== file) return text;
      if (change === "comment") return `${text}\n# Fresh cached-authority comment\n`;
      const value = YAML.parse(text);
      value.meta.version = "9.9.9";
      return YAML.stringify(value);
    }) as typeof fs.readFileSync);
    expect(query(next).rc).toBe(64);
    expect(query(["--protocol", "--section", "source_notes"]).out).toContain("Fresh cached-authority comment");
    change = "metadata";
    expect(query(["--protocol"]).rc).toBe(1);
    expect(query(["--protocol"]).rc).toBe(1);
    vi.restoreAllMocks();
    expect(query(["--protocol"]).rc).toBe(0);
  });

  it("rejects parseable versioned protocol guidance with missing groups and an undefined phase successor", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-static-invalid-protocol-"));
    temporary.push(dir);
    vi.stubEnv("AGENTERA_BOOTSTRAP_SOURCE_ROOT", dir);
    fs.mkdirSync(path.join(dir, "skills/agentera"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "skills/agentera/protocol.yaml"),
      YAML.stringify({
        meta: { name: "protocol", version: "1.0.0" },
        GROUP_PREFIXES: { PHASES: "PH" },
        PHASES: { 1: { id: "PH1", value: "build", valid_successors: ["does_not_exist"] } },
      }),
    );
    for (const args of [["--protocol"], ["--protocol", "--section", "PHASES"]]) {
      const result = query(args);
      expect(result.rc).toBe(1);
      expect(result.payload).toMatchObject({
        schemaVersion: "agentera.invalidInputEnvelope.v2",
        status: "fail",
        error: { class: "schema_violation", recovery: "npx -y agentera@next schema --protocol" },
      });
      expect(result.payload).not.toHaveProperty("items");
      expect(result.out).not.toContain("governing_contract");
      expect(result.out).not.toContain(dir);
    }
  });

  it("fails closed for explicitly selected missing, corrupt and incompatible authority", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-static-authority-"));
    temporary.push(dir);
    vi.stubEnv("AGENTERA_BOOTSTRAP_SOURCE_ROOT", dir);
    expect(query(["--protocol"]).rc).toBe(1);
    fs.mkdirSync(path.join(dir, "skills/agentera"), { recursive: true });
    for (const text of ["invalid: [", "meta: {name: protocol, version: 9}\nX: {}\nY: {}", "meta: {name: protocol, version: 1.0.0}"]) {
      fs.writeFileSync(path.join(dir, "skills/agentera/protocol.yaml"), text);
      const result = query(["--protocol"]);
      expect(result.rc).toBe(1);
      expect(result.out).not.toContain(dir);
    }
  });
});

describe("bounded semantic detail machinery", () => {
  it("subdivides nesting and losslessly pages oversized Unicode prose with digest-bound cursors", () => {
    const prose = "😀 'quoted' \\ \n".repeat(8_000);
    const sections: GuidanceSection[] = [
      {
        name: "RULES",
        content: { prose, nested: [false, null, { "a.b": 1 }] },
        authority: "fixture",
        classification: "governing_contract",
      },
    ];
    const options = {
      baseCommand: "npx -y agentera@next schema --protocol",
      selection: { protocol: true },
      sections,
      limit: 1,
      authorityDigest: "one",
    };
    const index = guidanceDetail({ ...options, section: "RULES" });
    expect(index.completeness.mode).toBe("index");
    let page = guidanceDetail({ ...options, section: "RULES.prose" });
    let recovered = "";
    const cursor = commandArgs(page.next_command!).at(-1)!;
    for (;;) {
      expect(Buffer.byteLength(JSON.stringify(page) + "\n")).toBeLessThanOrEqual(32_768);
      recovered += (page.items[0] as any).content;
      if (!page.next_command) break;
      page = guidanceDetail({
        ...options,
        section: "RULES.prose",
        cursor: commandArgs(page.next_command).at(-1),
      });
    }
    expect(recovered).toBe(prose);
    expect(() => guidanceDetail({ ...options, section: "RULES.prose", cursor, authorityDigest: "changed" })).toThrow(GuidanceInputError);
    expect((guidanceDetail({ ...options, section: "RULES.nested.2.a%2Eb" }).items[0] as any).content).toBe(1);
  });
});
