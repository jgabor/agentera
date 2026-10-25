import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { expectStatusWithinBudget } from "../helpers/statusBudget.js";
import { encode } from "gpt-tokenizer/model/gpt-5";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { createEntityAuthorityFixture } from "../helpers/entityAuthorityFixture.js";
import { sourceBuildOutputRoot, sourceSubprocessEnv } from "../helpers/sourceSubprocess.js";
import { CAPABILITY_NAMES } from "../../src/cli/capabilityContext/types.js";
import { main } from "../../src/cli/dispatch/index.js";
import { PRIME_MANUAL } from "../../src/cli/prime-blob.js";
import { BriefBudgetError } from "../../src/cli/commands/prime/briefByteBudget.js";
import { fitRoutedResponse } from "../../src/cli/commands/prime/orientationOutput.js";
import { PRIME_ROUTE_REQUEST_MAX_UTF8_BYTES } from "../../src/cli/commands/route.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const MANIFEST = YAML.parse(fs.readFileSync(path.join(REPO_ROOT, "scripts/json_output_surface_manifest.yaml"), "utf8"));
const ROUTED_BUDGETS = MANIFEST.surfaces.find((surface: { id: string }) => surface.id === "prime-routed-start").budget_by_carried;

let tmp: string;
let project: string;
let home: string;
let previousCwd: string;
let previousEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prime-routed-"));
  project = path.join(tmp, "project");
  home = path.join(tmp, "home");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  previousCwd = process.cwd();
  previousEnv = {
    AGENTERA_BOOTSTRAP_SOURCE_ROOT: process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT,
    AGENTERA_HOME: process.env.AGENTERA_HOME,
    HOME: process.env.HOME,
  };
  process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = REPO_ROOT;
  process.env.AGENTERA_HOME = path.join(home, "agentera");
  process.env.HOME = home;
  process.chdir(project);
});

afterEach(() => {
  process.chdir(previousCwd);
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function run(args: string[], stdin?: string): { rc: number; out: string; err: string } {
  let out = "";
  let err = "";
  const rc = main(["node", "agentera", ...args], {
    out: (text) => (out += text),
    err: (text) => (err += text),
    ...(stdin === undefined ? {} : { stdin: () => stdin }),
  });
  return { rc, out, err };
}

const routeBody = (request: string) => JSON.stringify({ version: "agentera.route_request.v1", request });
const routed = (request: string) => run(["prime", "--input", "-"], routeBody(request));
const json = (text: string) => JSON.parse(text) as Record<string, any>;

function entityProject(): void {
  createEntityAuthorityFixture(project, 25, YAML.parse(fs.readFileSync(path.join(REPO_ROOT, "references/artifacts/state-storage-authority.yaml"), "utf8")));
}

function freshGitProject(): void {
  expect(spawnSync("git", ["init", "-q"], { cwd: project }).status).toBe(0);
}

function snapshot(root: string): string {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(`${path.relative(root, full)}:${fs.readFileSync(full).toString("base64")}`);
    }
  };
  walk(root);
  return files.join("\n");
}

describe("prime routes a request from --input", () => {
  it("returns the manual, the bare brief, the unchanged route and the direct start for /agentera build", () => {
    entityProject();
    const result = routed("/agentera build");
    expect(result.rc, result.err).toBe(0);
    const payload = json(result.out);
    const { route, start, ...brief } = payload;
    expect(payload.manual).toBe(PRIME_MANUAL);
    expect(route).toEqual(json(run(["route", "request", "--input", "-"], routeBody("/agentera build")).out));
    expect(route).toMatchObject({ outcome: "deterministic_selection", capability: "build" });
    expect(start).toEqual(json(run(["prime", "--context", "build"]).out));
    expect(brief).toEqual(json(run(["prime"]).out));
  });

  it("sends /agentera the manual and the status capsule without repeating the orientation", () => {
    entityProject();
    const result = routed("/agentera");
    expect(result.rc, result.err).toBe(0);
    const payload = json(result.out);
    expect(Object.keys(payload)).toEqual(["command", "manual", "route", "start"]);
    expect(payload.manual).toBe(PRIME_MANUAL);
    expect(payload.route).toMatchObject({ outcome: "deterministic_selection", tier: "bare", capability: "status" });
    expect(payload.start).toEqual(json(run(["prime", "--context", "status"]).out));
  });

  it("keeps every routed response within the brief budget plus what it carries", () => {
    entityProject();
    const requests = [...CAPABILITY_NAMES.map((capability) => [`/agentera ${capability}`, capability === "status" ? "status" : "capability"]), ["/agentera", "status"], ["make implementation plan", "semantic_required"]];
    for (const [request, carried] of requests) {
      const result = routed(request);
      expect(result.rc, `${request}: ${result.out}`).toBe(0);
      if (carried === "status") {
        expectStatusWithinBudget(result.out, request);
        continue;
      }
      expect(Buffer.byteLength(result.out), request).toBeLessThanOrEqual(ROUTED_BUDGETS[carried].byte_budget);
      expect(encode(result.out).length, request).toBeLessThanOrEqual(ROUTED_BUDGETS[carried].token_budget);
    }
  });

  it("carries the same route result as route request for every frozen corpus request", { timeout: 60_000 }, () => {
    freshGitProject();
    const corpus = YAML.parse(fs.readFileSync(path.join(REPO_ROOT, "fixtures/routing/hybrid-corpus.yaml"), "utf8"));
    const cases = [...corpus.route_cases, ...corpus.receipt_cases] as Array<{ id: string; request: string; valid?: boolean; receipt?: Record<string, unknown> }>;
    expect(cases.length).toBeGreaterThan(40);
    for (const entry of cases) {
      const direct = run(["route", "request", "--input", "-"], routeBody(entry.request));
      const result = routed(entry.request);
      const payload = json(result.out);
      expect(payload.route, entry.id).toEqual(json(direct.out));
      if (payload.route.outcome === "semantic_required") {
        expect(result.rc, entry.id).toBe(0);
        expect(payload, entry.id).not.toHaveProperty("start");
        expect(payload, entry.id).not.toHaveProperty("refusal");
      } else {
        expect(Boolean(payload.start) !== Boolean(payload.refusal), entry.id).toBe(true);
      }
      if (entry.valid && entry.receipt) {
        expect(payload.route.request_sha256, entry.id).toBe(entry.receipt.request_sha256);
        expect(payload.route.semantic_capsule_sha256, entry.id).toBe(entry.receipt.semantic_capsule_sha256);
      }
    }
  });

  it("returns the direct start's gate refusal and no capsule, and starts what the gate allows", () => {
    freshGitProject();
    const refused = routed("/agentera build");
    const direct = run(["prime", "--context", "build"]);
    expect(direct.rc).toBe(1);
    expect(refused.rc).toBe(direct.rc);
    const payload = json(refused.out);
    expect(payload.refusal).toEqual(json(direct.out));
    expect(payload.refusal.error.class).toBe("fresh_initialization_required");
    expect(payload).not.toHaveProperty("start");

    const allowed = routed("/agentera plan");
    expect(allowed.rc, allowed.out).toBe(0);
    expect(json(allowed.out).start).toEqual(json(run(["prime", "--context", "plan"]).out));
    expect(fs.readdirSync(project)).toEqual([".git"]);
  });

  it("rejects an empty, malformed, oversized or build request body without changing anything", () => {
    entityProject();
    const before = snapshot(project);
    const cases: Array<[string, string]> = [
      ["", "invalid_format"],
      ["request: [unclosed", "invalid_format"],
      [routeBody("x".repeat(PRIME_ROUTE_REQUEST_MAX_UTF8_BYTES)), "schema_violation"],
      [JSON.stringify({ request: "x", extra: 1 }), "schema_violation"],
      [JSON.stringify({ schema_version: "agentera.buildExecutionRequest.v1", scope: "x", acceptance: ["y"] }), "unsupported_target"],
    ];
    for (const [body, errorClass] of cases) {
      const result = run(["prime", "--input", "-"], body);
      expect(result.rc, body.slice(0, 40)).toBe(2);
      expect(json(result.out)).toMatchObject({ schemaVersion: "agentera.invalidInputEnvelope.v2", status: "fail", error: { class: errorClass } });
    }
    const missing = run(["prime", "--input", "sensitive-request.yaml"]);
    expect(missing.rc).toBe(2);
    expect(json(missing.out).error.class).toBe("invalid_format");
    expect(missing.out).not.toContain("sensitive-request");
    const fields = run(["prime", "--input", "-", "--fields", "plan"], routeBody("/agentera"));
    expect(json(fields.out).error.class).toBe("mutually_exclusive");
    expect(snapshot(project)).toBe(before);
    expect(json(routed("/agentera plan").out).route.capability).toBe("plan");
  });
});

describe("calls per documented entry path", () => {
  const CLI = "npx -y agentera@next ";
  const CALL_BUDGET = { bare: 1, direct: 1, phrase: 1, natural: 3 } as const;
  type EntryPath = keyof typeof CALL_BUDGET;
  type Invoke = (args: string[], stdin?: string) => { rc: number; out: string; err: string };

  const cliArgs = (command: string) => {
    expect(command.startsWith(CLI), command).toBe(true);
    return command.slice(CLI.length).split(" ");
  };

  // The skill's pointer table is the documented entry; every row must name one command.
  function documentedEntry(): string[] {
    const skill = fs.readFileSync(path.join(REPO_ROOT, "skills/agentera/SKILL.md"), "utf8");
    const rows = skill.split("\n").filter((line) => line.startsWith("| ") && line.includes(CLI));
    const commands = new Set(rows.map((row) => /`(npx -y agentera@next [^`]+)`/.exec(row)?.[1]));
    expect(rows).toHaveLength(3);
    expect([...commands]).toEqual([`${CLI}prime --input -`]);
    return cliArgs(`${CLI}prime --input -`);
  }

  // Follows the CLI's own replies until a capability's startup capsule arrives.
  function follow(request: string, receiptCapability: string, invoke: Invoke): { calls: string[]; capability: string } {
    const calls: string[] = [];
    const call = (args: string[], stdin?: string) => {
      calls.push(args.join(" "));
      const result = invoke(args, stdin);
      expect(result.rc, `${args.join(" ")}: ${result.out}${result.err}`).toBe(0);
      return json(result.out);
    };
    const finish = (capsule: Record<string, any>) => {
      expect(capsule.capability_context.instructions.length, request).toBeGreaterThan(0);
      return { calls, capability: capsule.capability_context.capability as string };
    };
    const entry = call(documentedEntry(), routeBody(request));
    if (entry.start) return finish(entry.start);
    const { route } = entry;
    if (route.outcome !== "semantic_required") return finish(call(cliArgs(`${CLI}prime --context ${route.capability}`)));
    const receipt = { version: route.receipt_contract.version, request_sha256: route.request_sha256, semantic_capsule_sha256: route.semantic_capsule_sha256, outcome: "select", capability: receiptCapability, compound: "none", question: null, remainder_span: null };
    const selected = call(cliArgs(route.receipt_contract.stdin_command), JSON.stringify({ request, receipt }));
    return finish(call(cliArgs(selected.route_provenance.startup_command)));
  }

  function measure(invoke: Invoke) {
    const corpus = YAML.parse(fs.readFileSync(path.join(REPO_ROOT, "fixtures/routing/hybrid-corpus.yaml"), "utf8"));
    const natural = corpus.receipt_cases.find((entry: { id: string }) => entry.id === "DEV-RECEIPT-SELECT-PASS");
    const phrases = YAML.parse(fs.readFileSync(path.join(REPO_ROOT, "skills/agentera/route-phrases.yaml"), "utf8")).phrases;
    const phrase = phrases.find((entry: { status: string; capability: string }) => entry.status === "active" && entry.capability === "plan");
    const requests: Record<EntryPath, [string, string]> = {
      bare: ["/agentera", "status"],
      direct: ["/agentera build", "build"],
      phrase: [phrase.phrase, phrase.capability],
      natural: [natural.request, natural.receipt.capability],
    };
    const results = Object.fromEntries(
      Object.entries(requests).map(([name, [request, capability]]) => {
        const result = follow(request, capability, invoke);
        expect(result.capability, name).toBe(capability);
        return [name, result.calls];
      }),
    ) as Record<EntryPath, string[]>;
    const over = (Object.keys(CALL_BUDGET) as EntryPath[]).filter((name) => results[name].length > CALL_BUDGET[name]);
    return { results, over };
  }

  it("needs one call for bare, direct and curated-phrase requests and three for natural language", () => {
    entityProject();
    const { results, over } = measure(run);
    expect(over).toEqual([]);
    expect(Object.fromEntries(Object.entries(results).map(([name, calls]) => [name, calls.length]))).toEqual(CALL_BUDGET);
    expect(results.natural).toEqual(["prime --input -", "route receipt --input -", "prime --context plan"]);
  });

  it("fails a deterministic path whose reply lacks the startup capsule", () => {
    entityProject();
    const withoutStart: Invoke = (args, stdin) => {
      const result = run(args, stdin);
      if (args.join(" ") !== "prime --input -") return result;
      const { start: _start, ...rest } = json(result.out);
      return { ...result, out: JSON.stringify(rest) };
    };
    const { results, over } = measure(withoutStart);
    expect(over).toEqual(["bare", "direct", "phrase"]);
    expect(results.direct).toEqual(["prime --input -", "prime --context build"]);
  });
});

describe("prime stdin reads", () => {
  function spawnBuilt(args: string[]) {
    return spawn(process.execPath, [path.join(sourceBuildOutputRoot(), "bin/agentera.js"), ...args], {
      cwd: project,
      env: sourceSubprocessEnv({ ...process.env }),
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  function exited(child: ReturnType<typeof spawn>, ms: number): Promise<number | null | "running"> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve("running"), ms);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  it("returns from bare prime and the bare CLI while stdin stays open", { timeout: 60_000 }, async () => {
    freshGitProject();
    for (const args of [[], ["prime"]]) {
      const child = spawnBuilt(args);
      let stdout = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      expect(await exited(child, 25_000), args.join(" ")).toBe(0);
      expect(json(stdout).manual).toBe(PRIME_MANUAL);
      child.stdin.destroy();
    }
  });

  it("waits for stdin to close only when --input - is given", { timeout: 60_000 }, async () => {
    freshGitProject();
    const child = spawnBuilt(["prime", "--input", "-"]);
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    const done = exited(child, 25_000);
    expect(await exited(child, 1_500)).toBe("running");
    child.stdin.end(routeBody("/agentera"));
    expect(await done).toBe(0);
    expect(json(stdout).route.capability).toBe("status");
  });
});

describe("routed response fitting", () => {
  const head = { command: "prime", manual: "manual" };
  const carried = { route: { outcome: "deterministic_selection" }, start: { body: "s".repeat(200) } };
  const brief = (budget: number) => {
    if (budget >= 600) return { command: "prime", outcome: "ok", manual: "manual", brief: { text: "b".repeat(400) } };
    if (budget >= 200) return { command: "prime", outcome: "degraded", manual: "manual", brief: { text: "b".repeat(50) } };
    throw new BriefBudgetError(budget, 200);
  };
  const fit = (budget: number) => fitRoutedResponse(budget, head, carried, brief, "npx -y agentera@next prime");

  const pointerOnly = { ...head, ...carried, omitted: { orientation: "npx -y agentera@next prime" } };
  const pointerBytes = Buffer.byteLength(`${JSON.stringify(pointerOnly, null, 2)}\n`);

  it("keeps the full brief, then a degraded brief, then only a pointer to it", () => {
    expect(fit(1_200)).toMatchObject({ fits: true, response: { outcome: "ok", start: carried.start } });
    expect(fit(650)).toMatchObject({ fits: true, response: { outcome: "degraded", start: carried.start } });
    expect(fit(pointerBytes)).toEqual({ fits: true, bytes: pointerBytes, response: pointerOnly });
  });

  it("reports a response that cannot fit even without the brief", () => {
    expect(fit(pointerBytes - 1)).toMatchObject({ fits: false, bytes: pointerBytes });
  });
});
