import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { main } from "../../src/cli/dispatch.js";
import { CAPABILITY_INSTRUCTIONS } from "../../src/capabilities/index.js";
import { ROUTE_TOPICS } from "../../src/cli/commands/routeDetail.js";
import * as routeRuntime from "../../src/registries/hybridRoute.js";
import * as evaluation from "../../src/eval/hybridRouteEvaluation.js";
import { loadEvaluatorHandoffContract, validateEvaluationReport } from "../../src/registries/evaluatorHandoffContract.js";
import { sourceBuildOutputRoot, sourceSubprocessEnv } from "../helpers/sourceSubprocess.js";

const root = path.resolve(import.meta.dirname, "../../../..");
const temporary: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function query(args: string[], stdin?: string) {
  let out = "",
    err = "";
  const rc = main(["node", "agentera", ...args], {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    stdin: () => stdin ?? "",
  });
  expect(err).toBe("");
  expect(Buffer.byteLength(out)).toBeLessThanOrEqual(32768);
  return { rc, payload: JSON.parse(out), out };
}
function commandArgs(command: string) {
  return (command.match(/(?:'[^']*'|\\.|[^\s'\\]+)+/g) ?? []).slice(3).map((word) => word.replace(/'([^']*)'|\\(.)/g, (_match, quoted, escaped) => quoted ?? escaped));
}
function collect(args: string[]) {
  let result = query(args);
  const items: any[] = [],
    mode = result.payload.completeness?.mode;
  for (;;) {
    expect(result.rc, `${JSON.stringify(args)}\n${result.out}`).toBe(0);
    expect(result.payload.schemaVersion).toBe("agentera.guidanceDetail.v1");
    expect(result.payload.completeness.returned).toBe(result.payload.items.length);
    items.push(...result.payload.items);
    if (!result.payload.next_command) break;
    result = query(commandArgs(result.payload.next_command));
  }
  return { items, mode };
}
function reconstruct(args: string[], expected: any): any {
  const { items, mode } = collect(args);
  if (mode === "detail") return items[0].parts ? items.map((item) => item.content).join("") : items[0].content;
  const result: any = Array.isArray(expected) ? [] : {};
  for (const item of items) {
    const key = decodeURIComponent(item.name.split(".").at(-1));
    result[key] = reconstruct(commandArgs(item.content.detail_command), expected[key]);
  }
  return result;
}
const yaml = (relative: string) => YAML.parse(fs.readFileSync(path.join(root, relative), "utf8"));
function readSection(args: string[], kind = "object"): any {
  const { items, mode } = collect(args);
  if (mode === "detail") return items[0].parts ? items.map((item) => item.content).join("") : items[0].content;
  const result: any = kind === "array" ? [] : {};
  for (const item of items) result[decodeURIComponent(item.name.split(".").at(-1))] = readSection(commandArgs(item.content.detail_command), item.content.kind);
  return result;
}
function corrupt(relative: string, mutate: (value: any) => void) {
  vi.stubEnv("AGENTERA_BOOTSTRAP_SOURCE_ROOT", root);
  const target = path.join(root, relative),
    read = fs.readFileSync.bind(fs);
  vi.spyOn(fs, "readFileSync").mockImplementation(((file: any, ...args: any[]) => {
    const text = (read as any)(file, ...args);
    if (String(file) !== target) return text;
    const value = YAML.parse(text);
    mutate(value);
    return YAML.stringify(value);
  }) as any);
}

describe("static routing and worker contract discovery", () => {
  it("discovers every topic and losslessly serves the full normative routing contract without requests or evaluation", () => {
    const request = vi.spyOn(routeRuntime, "resolveRouteRequest").mockImplementation(() => {
      throw new Error("No synthetic requests");
    });
    const evaluate = vi.spyOn(evaluation, "evaluateHybridRoute").mockImplementation(() => {
      throw new Error("No evaluation execution");
    });
    let help = "";
    expect(
      main(["node", "agentera", "route", "explain", "--help"], {
        out: (text) => {
          help += text;
        },
      }),
    ).toBe(0);
    expect(help).toContain("Request-free static routing discovery");
    const index = collect(["route", "explain", "--limit", "1"]);
    expect(index.items.map((item) => item.name)).toEqual(ROUTE_TOPICS);
    const expected = yaml("references/cli/hybrid-route-contract.yaml");
    for (const item of index.items) {
      const args = commandArgs(item.content.detail_command);
      expect(query(args).rc).toBe(0);
      expect(reconstruct([...args, "--section", "contract"], expected)).toEqual(expected);
    }
    expect(request).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
  });
  it("serves complete phrase provenance and all trigger documents including status fallback, aliases and intent guidance", () => {
    const registry = yaml("skills/agentera/route-phrases.yaml");
    expect(reconstruct(["route", "explain", "--topic", "phrases", "--section", "registry"], registry)).toEqual(registry);
    const aliases = yaml("skills/agentera/capability_schema_contract.yaml").ROUTE_ALIASES;
    expect(reconstruct(["route", "explain", "--topic", "overview", "--section", "aliases"], aliases)).toEqual(aliases);
    for (const capability of Object.keys(CAPABILITY_INSTRUCTIONS)) {
      const expected = yaml(`skills/agentera/capabilities/${capability}/schemas/triggers.yaml`);
      expect(reconstruct(["route", "explain", "--topic", "triggers", "--capability", capability, "--section", capability, "--limit", "1"], expected)).toEqual(expected);
      expect(reconstruct(["route", "explain", "--topic", "phrases", "--capability", capability, "--section", "registry"], registry)).toEqual({
        ...registry,
        phrases: registry.phrases.filter((entry: any) => entry.capability === capability),
      });
    }
    for (const [topic, section, relative] of [
      ["overview", "model", "references/cli/routing-model.md"],
      ["triggers", "intent_guidance", "references/cli/trigger-schema-enrichment.md"],
    ]) {
      const expected = fs.readFileSync(path.join(root, relative), "utf8");
      expect(reconstruct(["route", "explain", "--topic", topic, "--section", section], expected)).toBe(expected);
    }
  });
  it("reconstructs every worker's full executable instructions, with explicit no-flow cases and complete evaluator requirements", () => {
    for (const [capability, instructions] of Object.entries(CAPABILITY_INSTRUCTIONS)) {
      const expected = Object.fromEntries(instructions.split(/(?=^## )/m).map((body, i) => [`${i + 1}: ${body.split("\n")[0].replace(/^#+\s*/, "")}`, body]));
      const args = ["prime", "--context", capability, "--detail", "worker"];
      const served = reconstruct([...args, "--section", "execution", "--limit", "1"], expected);
      expect(Object.values(served).join("")).toBe(instructions);
      const handoff = query([...args, "--section", "handoff"]).payload.items[0].content;
      if (["status", "vision", "discuss", "research", "document", "profile", "design"].includes(capability)) expect(handoff.status).toBe("not_applicable");
      if (["build", "audit", "optimize", "orchestrate"].includes(capability)) expect(handoff.status).toBe("defined");
      for (const flow of handoff.flows) expect(query(commandArgs(flow.command)).rc).toBe(0);
    }
    const evaluator = yaml("references/cli/capability-instruction-contract.yaml").evaluator_handoff;
    for (const capability of ["audit", "orchestrate"]) expect(reconstruct(["prime", "--context", capability, "--detail", "worker", "--section", "evaluator"], evaluator)).toEqual(evaluator);
  });
  it("supports a delegated implementation and evaluator handoff using only served obligations", () => {
    function instructions(capability: string) {
      return Object.values(readSection(["prime", "--context", capability, "--detail", "worker", "--section", "execution"])).join("");
    }
    const build = instructions("build");
    for (const obligation of [
      "exact task, acceptance, constraints, unresolved unknowns",
      "changed inputs, checks/commands, results, environment, coverage and remaining gaps",
      "Creating a worktree never authorizes",
      "the parent checks attribution and coverage",
      "Missing, stale, unrelated or insufficient worker evidence never establishes PASS",
    ])
      expect(build).toContain(obligation);
    const orchestrate = instructions("orchestrate");
    for (const obligation of ["Surface 1", "Surface 2", "evaluator_handoff", "verify_command", "record-evaluation", "--attempt-id", "--failure-evidence", "MUST NOT run tests", "user confirmation"]) expect(orchestrate).toContain(obligation);
    const evaluator = query(["prime", "--context", "audit", "--detail", "worker", "--section", "evaluator"]).payload.items[0].content;
    expect(evaluator.row_schema.required_fields).toEqual(["criterion", "status", "evidence"]);
    expect(evaluator.row_schema.warn_verify_command.allowed_prefixes).toEqual(["grep", "git show"]);
    expect(evaluator.evidence_policy).toContain("Missing, stale, unrelated or insufficient");
    // The fixture's task inputs are supplied by its caller. Both host handoffs
    // include the complete served obligations, not source-file instructions.
    const delegated = {
      task: {
        id: "fixture-task",
        intent: "Implement the selected fixture",
        acceptance: ["Changed behavior is observed"],
        constraints: ["No commit, push or unrelated changes"],
        unknowns: ["Changed-path coverage"],
        prior_evidence: [],
      },
      instructions: build,
    };
    const delivery = {
      task_id: delegated.task.id,
      changed_inputs: ["fixture.ts"],
      checks: [
        {
          command: "fixture-test",
          result: "pass",
          environment: "fixture",
          coverage: "selected path",
        },
      ],
      remaining_gaps: ["Uncovered path"],
    };
    const evaluatorHandoff = {
      task: delegated.task,
      evidence: delivery,
      instructions: instructions("audit"),
      output_requirements: evaluator.row_schema,
    };
    expect(evaluatorHandoff.task.acceptance).toEqual(delegated.task.acceptance);
    const report = {
      schemaVersion: evaluator.report_schema_version,
      rows: [
        {
          criterion: evaluatorHandoff.task.acceptance[0],
          status: "WARN",
          evidence: "Selected path passes; uncovered path remains",
          citation: "fixture.ts:1",
          verify_command: `${evaluator.row_schema.warn_verify_command.allowed_prefixes[0]} -n fixture fixture.ts`,
        },
      ],
    };
    const validator = loadEvaluatorHandoffContract(path.join(root, "references/cli/capability-instruction-contract.yaml"));
    expect(validateEvaluationReport(report, validator)).toEqual([]);
    expect(validateEvaluationReport({ ...report, rows: [{ ...report.rows[0], verify_command: undefined }] }, validator).join(" ")).toContain("missing verify_command");
    expect(validateEvaluationReport({ ...report, rows: [{ ...report.rows[0], citation: "unattributed" }] }, validator).join(" ")).toContain("citation must be");
  });
  it("rejects selectors, operational flags, private inputs, and stale/cross-selection cursors before side effects", () => {
    for (const extra of [["--input", "private"], ["--apply"], ["--consent"], ["--topic", "../x"], ["--section", "contract"], ["--capability", "build"], ["--format", "text"], ["--limit", "0"], ["--limit", "101"], ["--limit", "1.5"], ["--cursor", "bad"], ["--topic", "overview", "--topic", "receipt"], ["--topic"]]) {
      const result = query(["route", "explain", ...extra]);
      expect(result.rc, result.out).toBe(64);
      expect(result.out).not.toContain("private");
      expect(result.payload.error.recovery).toBeTruthy();
    }
    for (const extra of [["--input", "private"], ["--term-input", "private"], ["--guidance"], ["--fields", "instructions"], ["--cursor", "bad"], ["--section", "../x"]]) expect(query(["prime", "--context", "build", "--detail", "worker", ...extra]).rc).toBe(64);
    expect(query(["route", "explain", "--topic", "triggers", "--capability", "../x"]).rc).toBe(64);
    const first = query(["route", "explain", "--topic", "phrases", "--limit", "1"]);
    expect(query(commandArgs(first.payload.next_command).map((arg) => (arg === "phrases" ? "triggers" : arg))).rc).toBe(64);
    const worker = query(["prime", "--context", "audit", "--detail", "worker", "--limit", "1"]);
    expect(query(commandArgs(worker.payload.next_command).map((arg) => (arg === "audit" ? "orchestrate" : arg))).rc).toBe(64);
    corrupt("references/cli/hybrid-route-contract.yaml", (value) => {
      value.purpose += " Authority changed.";
    });
    expect(query(commandArgs(first.payload.next_command)).rc).toBe(64);
  });
  it.each(["receipt", "evaluation", "overview"])("rejects corrupted governing route structure before serving %s leaves", (topic) => {
    corrupt("references/cli/hybrid-route-contract.yaml", (value) => {
      value.protocol.receipt.validation_authority.host_output_shape.schema.properties = [];
    });
    const result = query(["route", "explain", "--topic", topic, "--section", "contract.purpose"]);
    expect(result.rc).toBe(1);
    expect(result.payload).not.toHaveProperty("items");
    expect(result.payload.error.recovery).toBeTruthy();
  });
  it.each([
    ["cli_seam", undefined],
    ["cli_seam", null],
    ["cli_seam", []],
    ["cli_seam", "invalid"],
    ["cli_seam", {}],
    ...["command", "input", "output"].flatMap((field) => [undefined, "", " \n ", 42].map((value) => [`cli_seam.${field}`, value])),
    ["cli_seam.exit_codes", undefined],
    ["cli_seam.exit_codes", []],
    ["cli_seam.exit_codes", {}],
    ...["ok", "invalid_input", "invalid_receipt"].flatMap((field) => [undefined, "0", 1].map((value) => [`cli_seam.exit_codes.${field}`, value])),
  ])("rejects missing or malformed receipt seam %s = %j before serving receipt detail", (selector, replacement) => {
    corrupt("references/cli/hybrid-route-contract.yaml", (value) => {
      const parts = String(selector).split(".");
      let selected = value.protocol.receipt;
      for (const key of parts.slice(0, -1)) selected = selected[key];
      if (replacement === undefined) delete selected[parts.at(-1)!];
      else selected[parts.at(-1)!] = replacement;
    });
    const result = query(["route", "explain", "--topic", "receipt", "--section", "contract.protocol.receipt"]);
    expect(result.rc, result.out).toBe(1);
    expect(result.payload).not.toHaveProperty("items");
    expect(result.payload).not.toHaveProperty("completeness");
    expect(result.payload.error.class).toBe("schema_violation");
    expect(result.payload.error.recovery).toBeTruthy();
  });
  it("serves the canonical receipt seam with its governing command, input, output and exit codes", () => {
    const expected = yaml("references/cli/hybrid-route-contract.yaml").protocol.receipt.cli_seam;
    const args = ["route", "explain", "--topic", "receipt", "--section", "contract.protocol.receipt.cli_seam"];
    expect(reconstruct(args, expected)).toEqual(expected);
  });
  it("rejects corrupt selected triggers and evaluator structure without falling back", () => {
    corrupt("skills/agentera/capabilities/status/schemas/triggers.yaml", (value) => {
      value.TRIGGERS[1].priority = "invalid";
    });
    expect(query(["route", "explain", "--topic", "triggers", "--capability", "status"]).rc).toBe(1);
    expect(query(["route", "explain", "--topic", "triggers", "--capability", "build"]).rc).toBe(0);
    vi.restoreAllMocks();
    corrupt("references/cli/capability-instruction-contract.yaml", (value) => {
      delete value.evaluator_handoff.row_schema;
    });
    for (const capability of ["audit", "orchestrate"]) expect(query(["prime", "--context", capability, "--detail", "worker", "--section", "execution"]).rc).toBe(1);
    expect(query(["prime", "--context", "build", "--detail", "worker"]).rc).toBe(0);
  });
  it.each([
    ["references/cli/hybrid-route-contract.yaml", "contract.protocol.response.version", "wrong", ["route", "explain", "--topic", "receipt"]],
    ["references/cli/hybrid-route-contract.yaml", "contract.protocol.receipt.validation_authority.schema.properties.remainder_span.properties.start.type", "wrong", ["route", "explain", "--topic", "receipt"]],
    ["skills/agentera/route-phrases.yaml", "contract.phrases.0.status", "wrong", ["route", "explain", "--topic", "phrases"]],
    ["skills/agentera/capabilities/status/schemas/triggers.yaml", "contract.TRIGGERS.1.exit_signal", "wrong", ["route", "explain", "--topic", "triggers", "--capability", "status"]],
    ["skills/agentera/capabilities/status/schemas/triggers.yaml", "contract.TRIGGERS.1.fallback", "wrong", ["route", "explain", "--topic", "triggers", "--capability", "status"]],
    ["references/cli/capability-instruction-contract.yaml", "contract.evaluator_handoff.row_schema.warn_verify_command.allowed_prefixes", [42], ["prime", "--context", "audit", "--detail", "worker"]],
  ] as const)("rejects selected nested corruption in %s at %s", (relative, selector, replacement, args) => {
    corrupt(relative, (value) => {
      const parts = selector.split(".").slice(1);
      let selected = value;
      for (const key of parts.slice(0, -1)) selected = selected[key];
      selected[parts.at(-1)!] = replacement;
    });
    const result = query([...args]);
    expect(result.rc, result.out).toBe(1);
    expect(result.payload).not.toHaveProperty("items");
  });
  it("binds worker continuation to current evaluator evidence authority", () => {
    const first = query(["prime", "--context", "audit", "--detail", "worker", "--limit", "1"]);
    corrupt("references/cli/capability-instruction-contract.yaml", (value) => {
      value.evaluator_handoff.evidence_policy += " Changed qualification.";
    });
    const result = query(commandArgs(first.payload.next_command));
    expect(result.rc).toBe(64);
    expect(result.payload.error.recovery).toContain("prime --context audit --detail worker");
  });
  it("never reads private/project/installed data, writes, runs a host or changes operational responses", () => {
    const requests = ["/agentera", "/agentera bygga: café", "HELP\tME decide: café", "make implementation plan"];
    const before = requests.map((request) => routeRuntime.resolveRouteRequest(request, root));
    const read = fs.readFileSync.bind(fs);
    vi.spyOn(fs, "readFileSync").mockImplementation(((file: any, ...args: any[]) => {
      const name = String(file);
      if (name.includes("/.agentera/") || name.endsWith("SKILL.md") || name.includes("PROFILE.md") || name.includes("/history/")) throw new Error("Forbidden private read");
      return (read as any)(file, ...args);
    }) as any);
    const write = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("No writes");
    });
    for (const topic of ROUTE_TOPICS) expect(query(["route", "explain", "--topic", topic]).rc).toBe(0);
    for (const capability of Object.keys(CAPABILITY_INSTRUCTIONS)) expect(query(["prime", "--context", capability, "--detail", "worker"]).rc).toBe(0);
    expect(requests.map((request) => routeRuntime.resolveRouteRequest(request, root))).toEqual(before);
    expect(write).not.toHaveBeenCalled();
  });
  it("invalid and stale nullable receipts retain exit 64 and never return startup authorization", () => {
    const request = "make implementation plan";
    const routed = routeRuntime.resolveRouteRequest(request, root);
    if (routed.outcome !== "semantic_required") throw new Error("Expected abstention");
    const receipt = {
      version: "agentera.route_receipt.v1",
      request_sha256: routed.request_sha256,
      semantic_capsule_sha256: routed.semantic_capsule_sha256,
      outcome: "select",
      capability: "build",
      compound: "none",
      question: null,
      remainder_span: null,
    };
    expect(query(["route", "receipt", "--input", "-"], JSON.stringify({ request, receipt })).rc).toBe(0);
    for (const changed of [
      { ...receipt, request_sha256: "0".repeat(64) },
      { ...receipt, semantic_capsule_sha256: "0".repeat(64) },
      { ...receipt, capability: "unknown" },
    ]) {
      const result = query(["route", "receipt", "--input", "-"], JSON.stringify({ request, receipt: changed }));
      expect(result.rc).toBe(64);
      expect(result.payload.error.recovery).toBeTruthy();
      expect(result.out).not.toContain("startup_command");
      expect(result.out).not.toContain(request);
    }
  });
  it("fresh-process discovery ignores absent/legacy/partial/corrupt project state and honors missing explicit authorities", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-route-worker-"));
    temporary.push(dir);
    const project = path.join(dir, "project");
    fs.mkdirSync(project);
    const run = (args: string[], authority = root) =>
      spawnSync(process.execPath, [path.join(sourceBuildOutputRoot(), "bin/agentera.js"), ...args], {
        cwd: project,
        encoding: "utf8",
        env: sourceSubprocessEnv({
          ...process.env,
          HOME: dir,
          AGENTERA_HOME: path.join(dir, "absent-app"),
          AGENTERA_BOOTSTRAP_SOURCE_ROOT: authority,
        }),
      });
    for (const args of [
      ["route", "explain", "--topic", "receipt"],
      ["prime", "--context", "orchestrate", "--detail", "worker"],
    ]) {
      const baseline = run(args);
      expect(baseline.status, baseline.stdout + baseline.stderr).toBe(0);
      fs.mkdirSync(path.join(project, ".agentera"), { recursive: true });
      for (const state of ["version: 2.0.0\n", "migration: partial\n", "not: [valid"]) {
        fs.writeFileSync(path.join(project, ".agentera/config.yaml"), state);
        expect(run(args).stdout).toBe(baseline.stdout);
      }
      const missing = run(args, path.join(dir, "missing-authority"));
      expect(missing.status).toBe(1);
      expect(JSON.parse(missing.stdout).error.recovery).toBeTruthy();
    }
  });
});
