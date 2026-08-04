import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import { CAPABILITY_INSTRUCTIONS } from "../../src/capabilities/index.js";
import { capabilityContext } from "../../src/cli/capabilityContext/contract.js";
import { buildSchemaPayload } from "../../src/cli/commands/schema.js";
import { main } from "../../src/cli/dispatch.js";
import { printStateHelp } from "../../src/cli/help.js";
import { stateCommandNames } from "../../src/cli/help.js";
import { entityPublicRetrieval } from "../../src/state/retrievalAuthority.js";
import { entityListFamilies, entityListValidValues, validateEntityListHelp } from "../../src/state/entityRetrievalHelp.js";
import { ENTITY_LIST_RUNTIME_FAMILIES } from "../../src/state/entityListRuntimeRegistry.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const roots: string[] = [];

function authorityDocument(): any {
  return YAML.parse(fs.readFileSync(path.join(REPO_ROOT, "references/artifacts/state-storage-authority.yaml"), "utf8"));
}

function setListLimit(authority: any, limit: number): void {
  authority.entity_target.public_retrieval.list_help.defaults.bounds.default = limit;
  authority.entity_target.public_retrieval.list_help.defaults.bounds.maximum = limit;
  authority.entity_target.public_retrieval.policy.output_bounds.maximum_limit = limit;
  authority.api.list.default_limit = limit;
  authority.api.list.maximum_limit = limit;
  const entities = authority.entity_target.entities as any[];
  const seen = new Set<string>();
  for (const family of ENTITY_LIST_RUNTIME_FAMILIES) {
    const boundary = family.boundsBoundary ?? family.boundary;
    const identity = `${family.artifact}:${boundary}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const entity = entities.find((candidate) => candidate.artifact === family.artifact && candidate.boundary === boundary);
    entity.retrieval.default_limit = limit;
    entity.retrieval.maximum_limit = limit;
  }
}

function setExampleLimit(authority: any, limit: number): void {
  for (const family of Object.values(authority.entity_target.public_retrieval.list_help.families) as any[]) {
    family.example = String(family.example).replace(/--limit [1-9][0-9]*/, `--limit ${limit}`);
  }
}

function mutatedSourceRoot(authority: any): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retrieval-authority-source-"));
  roots.push(root);
  fs.cpSync(path.join(REPO_ROOT, "references"), path.join(root, "references"), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, "skills"), path.join(root, "skills"), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, "registry.json"), path.join(root, "registry.json"));
  fs.writeFileSync(path.join(root, "references/artifacts/state-storage-authority.yaml"), YAML.stringify(authority));
  return root;
}

function withSourceRoot<T>(sourceRoot: string, action: () => T): T {
  const previous = process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = sourceRoot;
  try {
    return action();
  } finally {
    if (previous === undefined) delete process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
    else process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = previous;
  }
}

function exampleArgs(example: string): string[] {
  const tokens = example.split(" ");
  expect(tokens[0]).toBe("agentera");
  return tokens.slice(1);
}

function seedExecutableExamples(root: string): void {
  const entities = path.join(root, ".agentera/entities");
  const planDirectory = path.join(entities, "plan/plan");
  const objectiveDirectory = path.join(entities, "objective/objective");
  fs.mkdirSync(planDirectory, { recursive: true });
  fs.mkdirSync(objectiveDirectory, { recursive: true });
  fs.writeFileSync(path.join(planDirectory, "abcdefghij.yaml"), YAML.stringify({
    id: "abcdefghij",
    artifact: "plan",
    record: {
      header: { level: "light", created: "2026-08-02", status: "open", title: "Executable retrieval examples" },
      what: "Exercise every authority-owned list example.",
      why: "Static corrections must execute against a coherent runtime.",
      scope: { included: ["retrieval examples"], excluded: ["mutations"] },
    },
  }));
  fs.writeFileSync(path.join(objectiveDirectory, "qjtrmnpvka.yaml"), YAML.stringify({
    id: "qjtrmnpvka",
    artifact: "objective",
    record: {
      header: { title: "Executable retrieval examples", status: "open", created: "2026-08-02" },
      objective: { description: "Exercise experiment retrieval", why: "The example requires an objective", measurement: "Command exits zero", constraints: [] },
      metric: { description: "exit status", direction: "minimize", unit: "failures" },
      baseline: { description: "zero failures" },
      gates: {},
      scope: { included: ["retrieval examples"], excluded: ["experiment publication"] },
    },
  }));
}

function seedAliasRecords(root: string): void {
  const records = [
    ["progress", "progress_cycle", "baaaaaaaaa", { timestamp: "2026-08-02 05:00", type: "fix", phase: "build", what: "First alias fixture", context: { intent: "test alias parity" } }],
    ["progress", "progress_cycle", "caaaaaaaaa", { timestamp: "2026-08-02 04:00", type: "fix", phase: "build", what: "Second alias fixture", context: { intent: "test alias parity" } }],
    ["decisions", "decision", "daaaaaaaaa", { date: "2026-08-02", question: "First?", context: "Alias parity", alternatives: [{ name: "yes", status: "chosen" }], choice: "yes", reasoning: "Canonical parser", confidence: "firm" }],
    ["decisions", "decision", "eaaaaaaaaa", { date: "2026-08-01", question: "Second?", context: "Alias parity", alternatives: [{ name: "yes", status: "chosen" }], choice: "yes", reasoning: "Canonical parser", confidence: "firm" }],
    ["todo", "todo_item", "faaaaaaaaa", { severity: "critical", status: "open", description: "First TODO alias fixture" }],
    ["todo", "todo_item", "gaaaaaaaaa", { severity: "normal", status: "open", description: "Second TODO alias fixture" }],
  ] as const;
  for (const [artifact, boundary, id, record] of records) {
    const directory = path.join(root, ".agentera/entities", artifact, boundary);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${id}.yaml`), YAML.stringify({ id, artifact, record }));
  }
}

function cutoverProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retrieval-contract-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".agentera"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
  return root;
}

function capture(root: string, argv: string[]): { rc: number; out: string; err: string } {
  const previous = process.cwd();
  let out = "";
  let err = "";
  process.chdir(root);
  try {
    const rc = main(["node", "agentera", ...argv], { out: (text) => { out += text; }, err: (text) => { err += text; } });
    return { rc, out, err };
  } finally {
    process.chdir(previous);
  }
}

afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("final entity retrieval public-contract parity", () => {
  it("keeps an independent exact implementation-completeness sentinel", () => {
    expect(ENTITY_LIST_RUNTIME_FAMILIES.map(({ key, artifact, boundary }) => [key, artifact, boundary])).toEqual([
      ["progress", "progress", "progress_cycle"],
      ["decisions", "decisions", "decision"],
      ["health", "health", "health_audit"],
      ["plans", "plan", "plan"],
      ["plan_tasks", "plan", "plan_task"],
      ["objective", "objective", "objective"],
      ["experiments", "experiments", "experiment"],
      ["todo", "todo", "todo_item"],
      ["docs", "docs", "documentation_inventory_entry"],
    ]);
  });

  it("validates and loads every authority-declared list-help family", () => {
    const authority = authorityDocument();
    expect(validateEntityListHelp(authority)).toEqual([]);
    const families = entityListFamilies(REPO_ROOT);
    expect(families.map(({ key }) => key).sort()).toEqual(ENTITY_LIST_RUNTIME_FAMILIES.map(({ key }) => key).sort());
  });

  it.each([
    ["removed docs family", (value: any) => { delete value.entity_target.public_retrieval.commands.docs; delete value.entity_target.public_retrieval.list_help.families.docs; }, ".missing.docs"],
    ["unknown ghost family", (value: any) => { value.entity_target.public_retrieval.commands.ghost = { list: "agentera state ghost list --format json", get: "agentera state ghost get --id ID --format json" }; value.entity_target.public_retrieval.list_help.families.ghost = { command_tokens: ["ghost"], filters: [], example: "agentera state ghost list --format json" }; }, ".unknown.ghost"],
    ["removed TODO summary fields", (value: any) => { delete value.entity_target.public_retrieval.list_help.families.todo.summary_fields; }, ".todo.summary_fields"],
    ["removed TODO summary notes", (value: any) => { delete value.entity_target.public_retrieval.list_help.families.todo.summary_field_notes; }, ".todo.summary_field_notes.required"],
    ["unknown TODO metadata", (value: any) => { value.entity_target.public_retrieval.list_help.families.todo.ghost = true; }, ".todo.unknown.ghost"],
    ["removed progress filters", (value: any) => { value.entity_target.public_retrieval.list_help.families.progress.filters = []; }, ".progress.filters.runtime_parity"],
    ["list-help bound drift", (value: any) => { value.entity_target.public_retrieval.list_help.defaults.bounds.maximum = 99; }, ".bounds.maximum_authority_parity"],
  ])("rejects Audit 1 mutation: %s", (_name, mutate, expected) => {
    const authority = authorityDocument();
    mutate(authority);
    expect(validateEntityListHelp(authority).some((error) => error.endsWith(expected))).toBe(true);
  });

  it.each([
    ["unknown defaults metadata", (value: any) => { value.entity_target.public_retrieval.list_help.defaults.ghost = true; }, ".defaults.unknown.ghost"],
    ["wrong bounds type", (value: any) => { value.entity_target.public_retrieval.list_help.defaults.bounds.default = "20"; }, ".bounds.default.value"],
    ["unknown filter metadata", (value: any) => { value.entity_target.public_retrieval.list_help.families.progress.filters[0].ghost = true; }, ".filters[0].unknown.ghost"],
    ["filter value syntax drift", (value: any) => { value.entity_target.public_retrieval.list_help.families.plans.filters[0].flag = "--status STATUS"; }, ".filters[0].flag_value_syntax"],
    ["malformed filter values", (value: any) => { value.entity_target.public_retrieval.list_help.families.plans.filters[0].values = ["open", 7]; }, ".filters[0].values"],
    ["wrong TODO note type", (value: any) => { value.entity_target.public_retrieval.list_help.families.todo.summary_field_notes = "queue_rank"; }, ".summary_field_notes.type"],
    ["wrong TODO ownership semantics", (value: any) => { value.entity_target.public_retrieval.list_help.families.todo.summary_field_notes.queue_rank.persisted = true; }, ".queue_rank.semantics"],
  ])("fails closed for metadata shape: %s", (_name, mutate, expected) => {
    const authority = authorityDocument();
    mutate(authority);
    expect(validateEntityListHelp(authority).some((error) => error.endsWith(expected))).toBe(true);
  });

  it.each([
    ["missing example", (value: any) => { delete value.entity_target.public_retrieval.list_help.families.progress.example; }, ".progress.example.type"],
    ["non-string example", (value: any) => { value.entity_target.public_retrieval.list_help.families.decisions.example = ["agentera"]; }, ".decisions.example.type"],
    ["non-canonical spacing", (value: any) => { value.entity_target.public_retrieval.list_help.families.health.example = "agentera  state health list --limit 20 --format json"; }, ".health.example.lexical_form"],
    ["unknown argument", (value: any) => { value.entity_target.public_retrieval.list_help.families.docs.example = "agentera state docs list --ghost value --limit 20 --format json"; }, ".docs.example.argument"],
    ["invalid positional identifier", (value: any) => { value.entity_target.public_retrieval.list_help.families.plan_tasks.example = "agentera state plan tasks list not-an-id --limit 20 --format json"; }, ".plan_tasks.example.identifier"],
    ["missing required identifier", (value: any) => { value.entity_target.public_retrieval.list_help.families.experiments.example = "agentera state experiments list --limit 20 --format json"; }, ".experiments.example.identifier_required"],
    ["invalid filter value", (value: any) => { value.entity_target.public_retrieval.list_help.families.plans.example = "agentera state plan list --status ghost --limit 20 --format json"; }, ".plans.example.filter_value"],
    ["mutually exclusive selectors", (value: any) => { value.entity_target.public_retrieval.list_help.families.todo.example = "agentera state todo list --ids-only --fields status --limit 20 --format json"; }, ".todo.example.selector"],
    ["invalid format", (value: any) => { value.entity_target.public_retrieval.list_help.families.objective.example = "agentera state objective list --limit 20 --format toml"; }, ".objective.example.format"],
  ])("fails closed for example grammar: %s", (_name, mutate, expected) => {
    const authority = authorityDocument();
    mutate(authority);
    expect(validateEntityListHelp(authority).some((error) => error.endsWith(expected))).toBe(true);
  });

  it("rejects coherent limit metadata with stale examples before schema startup", () => {
    const authority = authorityDocument();
    setListLimit(authority, 7);
    const errors = validateEntityListHelp(authority);
    expect(errors.filter((error) => error.endsWith(".example.limit"))).toHaveLength(ENTITY_LIST_RUNTIME_FAMILIES.length);
    const sourceRoot = mutatedSourceRoot(authority);
    withSourceRoot(sourceRoot, () => {
      expect(() => buildSchemaPayload("schema")).toThrow(/invalid state retrieval authority: .*\.example\.limit/);
    });
  });

  it("projects changed authority bare behavior directly into artifact help", () => {
    const authority = authorityDocument();
    authority.entity_target.public_retrieval.list_help.families.health.bare_read = "alias";
    delete authority.entity_target.public_retrieval.list_help.families.health.bare_recovery;
    const sourceRoot = mutatedSourceRoot(authority);
    withSourceRoot(sourceRoot, () => {
      expect(validateEntityListHelp(authority)).toEqual([]);
      expect(printStateHelp("health")).toContain("Bare: agentera state health is a strict alias of List.");
    });
  });

  it("consumes coherent limit metadata and examples through schema, help, runtime, and corrections", () => {
    const authority = authorityDocument();
    setListLimit(authority, 7);
    setExampleLimit(authority, 7);
    expect(validateEntityListHelp(authority)).toEqual([]);
    const sourceRoot = mutatedSourceRoot(authority);
    withSourceRoot(sourceRoot, () => {
      const schema = buildSchemaPayload("schema") as any;
      expect(schema.state_retrieval.list_help.defaults.bounds).toMatchObject({ default: 7, maximum: 7 });
      const root = cutoverProject();
      seedExecutableExamples(root);
      for (const family of entityListFamilies(sourceRoot)) {
        const help = capture(root, ["state", ...family.commandTokens, "list", "--help"]);
        expect(help).toMatchObject({ rc: 0, err: "" });
        expect(help.out).toContain("limit: minimum 1, default 7, maximum 7");
        expect(help.out).toContain(family.example);

        const advertised = capture(root, exampleArgs(family.example));
        expect(advertised.rc, `${family.key}: ${advertised.err || advertised.out}`).toBe(0);

        const rejectedArgs = exampleArgs(family.example);
        const limit = rejectedArgs.indexOf("--limit");
        expect(limit).toBeGreaterThan(-1);
        rejectedArgs[limit + 1] = "8";
        const rejected = capture(root, rejectedArgs);
        expect(rejected).toMatchObject({ rc: 2, err: "" });
        const correction = JSON.parse(rejected.out).error;
        expect(correction).toMatchObject({ example: family.example, recovery: `Run \`${family.example}\`; no state was changed.` });
        expect(correction.valid_values).toContain("--limit 1..7");
        const corrected = capture(root, exampleArgs(correction.example));
        expect(corrected.rc, `${family.key}: ${corrected.err || corrected.out}`).toBe(0);
      }
    });
  });

  it("projects the authority-owned final ID grammar through schema", () => {
    const authority = authorityDocument();
    const retrieval = entityPublicRetrieval(REPO_ROOT);
    expect(retrieval).toEqual(authority.entity_target.public_retrieval);
    expect(buildSchemaPayload("schema").state_retrieval).toEqual({
      authority: "references/artifacts/state-storage-authority.yaml",
      ...retrieval,
    });
    expect(JSON.stringify(retrieval.commands)).toContain("--id ID");
    expect(JSON.stringify(retrieval.commands)).not.toMatch(/--(?:number|task|plan)\b/);
  });

  it("keeps help and served capability instructions on bare canonical IDs", () => {
    const surfaces = [printStateHelp("plan"), printStateHelp("experiments"), ...Object.values(CAPABILITY_INSTRUCTIONS)].join("\n");
    expect(surfaces).toContain("--id ID");
    expect(surfaces).not.toMatch(/--(?:number|task)\s+[A-Z]/);
    expect(surfaces).not.toMatch(/agentera state (?:progress|decisions|health|plan|objective|experiments|todo|docs) --format json/);
    expect(surfaces).not.toMatch(/agentera state experiments get --objective/);
    expect(printStateHelp("plan")).toContain("Only the displayed bare-ID selectors are accepted");
  });

  it("generates family-specific list help and selector corrections from authority", () => {
    const root = cutoverProject();
    for (const family of entityListFamilies(REPO_ROOT)) {
      const help = capture(root, ["state", ...family.commandTokens, "list", "--help"]);
      expect(help).toMatchObject({ rc: 0, err: "" });
      expect(help.out).toContain(`usage: ${family.syntax}`);
      expect(help.out).toContain(`Summary fields:\n  ${family.summaryFields.join(", ")}`);
      expect(help.out).toContain(`limit: minimum ${family.bounds.minimum}, default ${family.bounds.default}, maximum ${family.bounds.maximum}`);
      expect(help.out).toContain(`formats: ${family.formats.join(", ")}`);
      expect(help.out).toContain(family.example);
      for (const filter of family.filters) expect(help.out).toContain(filter.flag);

      const mismatch = capture(root, ["state", ...family.commandTokens, "list", "--not-a-selector", "--format", "json"]);
      expect(mismatch).toMatchObject({ rc: 2, err: "" });
      expect(JSON.parse(mismatch.out).error).toMatchObject({
        class: "invalid_request",
        syntax: family.syntax,
        example: family.example,
        valid_values: entityListValidValues(family),
      });
    }
  });

  it("documents TODO queue rank as a computed summary field rather than a filter", () => {
    const family = entityListFamilies(REPO_ROOT).find(({ key }) => key === "todo")!;
    const help = capture(cutoverProject(), ["state", ...family.commandTokens, "list", "--help"]).out;
    expect(help).toContain("--severity SEVERITY");
    expect(help).toContain("--status STATUS");
    expect(help).toContain("queue_rank");
    expect(help).toContain("--queue-rank is not a filter");
    expect(help).toContain("--ids-only");
    expect(help).toContain("--fields FIELDS");
  });

  it("keeps human and structured failure streams, vocabulary, corrections, and exit status deterministic for all families", () => {
    const root = cutoverProject();
    for (const family of entityListFamilies(REPO_ROOT)) {
      const validValues = entityListValidValues(family);
      const text = capture(root, ["state", ...family.commandTokens, "list", "--not-a-selector"]);
      expect(text).toMatchObject({ rc: 2, out: "" });
      expect(text.err).toContain("Error: unrecognized argument '--not-a-selector'");
      expect(text.err).toContain(`Example: ${family.example}`);
      expect(text.err).toContain(`Recovery: Run \`${family.example}\`; no state was changed.`);
      for (const value of validValues) expect(text.err).toContain(value);

      const json = capture(root, ["state", ...family.commandTokens, "list", "--not-a-selector", "--format", "json"]);
      expect(json).toMatchObject({ rc: 2, err: "" });
      expect(JSON.parse(json.out).error).toMatchObject({
        class: "invalid_request",
        syntax: family.syntax,
        valid_values: validValues,
        example: family.example,
        recovery: `Run \`${family.example}\`; no state was changed.`,
      });
    }
  });

  it("makes every supported bare read an exact list alias or an executable canonical correction", () => {
    const root = cutoverProject();
    seedExecutableExamples(root);
    for (const family of entityListFamilies(REPO_ROOT)) {
      const bare = capture(root, ["state", ...family.commandTokens, "--format", "json"]);
      if (family.bareRead === "alias") {
        const explicit = capture(root, ["state", ...family.commandTokens, "list", "--format", "json"]);
        expect(bare, family.key).toEqual(explicit);
      } else {
        expect(bare, family.key).toMatchObject({ rc: 2, err: "" });
        const correction = JSON.parse(bare.out).error;
        expect(correction).toMatchObject({ class: "invalid_request", example: family.bareRecovery, recovery: `Run \`${family.bareRecovery}\`; no state was changed.` });
        expect(capture(root, exampleArgs(family.bareRecovery!)).rc, family.key).toBe(0);
      }
    }
  });

  it("keeps alias families byte-identical across valid and malformed list grammar while preserving writer dispatch", () => {
    const root = cutoverProject();
    seedAliasRecords(root);
    const scenarios: Record<string, string[][]> = {
      progress: [["--format", "json"], ["extra", "--format", "json"], ["--unknown", "--format", "json"], ["--topic", "alias", "--ids-only", "--format", "json"], ["--fields", "status", "--format", "yaml"], ["--format", "text"]],
      decisions: [["--format", "json"], ["extra", "--format", "json"], ["--unknown", "--format", "json"], ["--topic", "alias", "--ids-only", "--format", "json"], ["--fields", "confidence", "--format", "yaml"], ["--format", "text"]],
      todo: [["--format", "json"], ["extra", "--format", "json"], ["--unknown", "--format", "json"], ["--status", "open", "--ids-only", "--format", "json"], ["--fields", "status", "--format", "yaml"], ["--format", "text"]],
    };
    for (const key of ["progress", "decisions", "todo"] as const) {
      const family = entityListFamilies(REPO_ROOT).find((candidate) => candidate.key === key)!;
      for (const args of scenarios[key]) {
        const bare = capture(root, ["state", ...family.commandTokens, ...args]);
        const explicit = capture(root, ["state", ...family.commandTokens, "list", ...args]);
        expect(bare, `${key}: ${args.join(" ")}`).toEqual(explicit);
      }
      const first = capture(root, ["state", ...family.commandTokens, "list", "--limit", "1", "--format", "json"]);
      const cursor = JSON.parse(first.out).next_cursor;
      expect(cursor).toEqual(expect.any(String));
      expect(capture(root, ["state", ...family.commandTokens, "--limit", "1", "--cursor", cursor, "--format", "json"])).toEqual(
        capture(root, ["state", ...family.commandTokens, "list", "--limit", "1", "--cursor", cursor, "--format", "json"]),
      );
      const writer = capture(root, ["state", ...family.commandTokens, "explain", "--format", "json"]);
      expect(writer.rc, key).toBe(0);
      expect(JSON.parse(writer.out)).toMatchObject({ schemaVersion: "agentera.stateWriteExplain.v1", artifact: key });
    }
    const empty = cutoverProject();
    for (const key of ["progress", "decisions", "todo"] as const) {
      const family = entityListFamilies(REPO_ROOT).find((candidate) => candidate.key === key)!;
      expect(capture(empty, ["state", ...family.commandTokens, "--format", "json"])).toEqual(capture(empty, ["state", ...family.commandTokens, "list", "--format", "json"]));
    }
  });

  it("routes and discovers every registry family without a legacy retrieval handler map", () => {
    const commandRoots = new Set(stateCommandNames());
    for (const family of ENTITY_LIST_RUNTIME_FAMILIES) expect(commandRoots.has(family.commandTokens[0]), family.key).toBe(true);
    expect(fs.readFileSync(path.join(REPO_ROOT, "packages/cli/src/cli/commands/state/index.ts"), "utf8")).not.toContain("STATE_COMMAND_HANDLERS");
    expect(fs.readFileSync(path.join(REPO_ROOT, "packages/cli/src/cli/dispatch/index.ts"), "utf8")).toContain("runtimeEntityFamiliesForCommand(sub)");
  });

  it("generates exact-get help and structured selector rejection for every authority family", () => {
    const root = cutoverProject();
    seedExecutableExamples(root);
    for (const family of entityListFamilies(REPO_ROOT)) {
      const help = capture(root, ["state", ...family.commandTokens, "get", "--help"]);
      expect(help, family.key).toMatchObject({ rc: 0, err: "" });
      expect(help.out).toContain(`usage: ${family.get}`);
      const rejected = capture(root, ["state", ...family.commandTokens, "get", "extra", "--format", "json"]);
      expect(rejected, family.key).toMatchObject({ rc: 2, err: "" });
      expect(JSON.parse(rejected.out).error).toMatchObject({ class: "invalid_request", syntax: family.get });
    }
  });

  it("projects one exact detail command per deferred startup family", () => {
    const plan = capabilityContext("plan")?.availability as Record<string, any>[];
    const optimize = capabilityContext("optimize")?.availability as Record<string, any>[];
    expect(plan).toEqual(expect.arrayContaining([
      expect.objectContaining({ family: "decisions", availability: "deferred", detail_command: "npx -y agentera@next state decisions list --format json" }),
      expect.objectContaining({ family: "profile", availability: "deferred", detail_command: "npx -y agentera@next report profile-grounding --format json" }),
    ]));
    expect(optimize).toEqual(expect.arrayContaining([
      expect.objectContaining({ family: "experiments", availability: "deferred", detail_command: expect.stringContaining("--objective OBJECTIVE_ID") }),
    ]));
    expect(JSON.stringify({ plan, optimize })).not.toMatch(/write_contract|input_schema|examples/);
  });

  it("returns bounded structured corrections after the cutover gate", () => {
    const root = cutoverProject();
    for (const argv of [
      ["state", "plan", "show", "--format", "json"],
      ["state", "experiments", "show", "--format", "json"],
      ["state", "plan", "list", "--cursor", "not-a-cursor", "--format", "json"],
    ]) {
      const result = capture(root, argv);
      expect([1, 2]).toContain(result.rc);
      expect(result.err).toBe("");
      const payload = JSON.parse(result.out);
      expect(payload).toMatchObject({ status: "fail", error: { class: expect.any(String), recovery: expect.any(String) } });
      expect(Buffer.byteLength(result.out, "utf8")).toBeLessThanOrEqual(4096);
    }
  });
});
