import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cmdPrime } from "../../src/cli/commands/prime.js";
import { evaluateTodoReadinessQueue, type TodoReadinessEntity } from "../../src/cli/todoReadinessSelection.js";
import { resolveRouteRequest } from "../../src/registries/hybridRoute.js";
import { loadTodoReadinessContract } from "../../src/registries/todoReadinessContract.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const READINESS = loadTodoReadinessContract(
  path.join(REPO_ROOT, "skills/agentera/schemas/artifacts/todo.yaml"),
  path.join(REPO_ROOT, "skills/agentera/protocol.yaml"),
  path.join(REPO_ROOT, "skills/agentera/capability_schema_contract.yaml"),
);

let tempRoot: string;
let project: string;
let home: string;
let appHome: string;
let previousCwd: string;
let previousHome: string | undefined;
let previousAgenteraHome: string | undefined;
let previousProfileDir: string | undefined;
let previousProfileraProfileDir: string | undefined;
let previousBootstrapSourceRoot: string | undefined;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "status-readiness-integration-"));
  project = path.join(tempRoot, "project");
  home = path.join(tempRoot, "home");
  appHome = path.join(home, "agentera");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(appHome, { recursive: true });
  previousCwd = process.cwd();
  previousHome = process.env.HOME;
  previousAgenteraHome = process.env.AGENTERA_HOME;
  previousProfileDir = process.env.AGENTERA_PROFILE_DIR;
  previousProfileraProfileDir = process.env.PROFILERA_PROFILE_DIR;
  previousBootstrapSourceRoot = process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  process.env.HOME = home;
  process.env.AGENTERA_HOME = appHome;
  process.env.AGENTERA_PROFILE_DIR = path.join(tempRoot, "profile");
  process.env.PROFILERA_PROFILE_DIR = path.join(tempRoot, "profile");
  process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = REPO_ROOT;
  process.chdir(project);
});

afterEach(() => {
  process.chdir(previousCwd);
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousAgenteraHome === undefined) delete process.env.AGENTERA_HOME;
  else process.env.AGENTERA_HOME = previousAgenteraHome;
  if (previousProfileDir === undefined) delete process.env.AGENTERA_PROFILE_DIR;
  else process.env.AGENTERA_PROFILE_DIR = previousProfileDir;
  if (previousProfileraProfileDir === undefined) delete process.env.PROFILERA_PROFILE_DIR;
  else process.env.PROFILERA_PROFILE_DIR = previousProfileraProfileDir;
  if (previousBootstrapSourceRoot === undefined) delete process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  else process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = previousBootstrapSourceRoot;
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function readiness(capability: string, queueRank = 1, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    capability,
    reason: `${capability} owns this synthetic fixture.`,
    dependencies: [],
    blocked: null,
    gate: null,
    queue_rank: queueRank,
    order_reason: "Synthetic reviewer-declared queue order.",
    ...overrides,
  };
}

function todo(
  id: string,
  description: string,
  itemReadiness?: Record<string, unknown>,
  options: { severity?: string; status?: string } = {},
): TodoReadinessEntity {
  return {
    id,
    artifact: "todo",
    record: {
      severity: options.severity ?? "normal",
      status: options.status ?? "open",
      description,
      ...(itemReadiness ? { readiness: itemReadiness } : {}),
    },
  };
}

function publish(items: TodoReadinessEntity[]): void {
  const entityRoot = path.join(project, ".agentera/entities/todo/todo_item");
  fs.rmSync(entityRoot, { recursive: true, force: true });
  fs.mkdirSync(entityRoot, { recursive: true });
  fs.writeFileSync(
    path.join(project, ".agentera/state-mode.yaml"),
    "schemaVersion: agentera.stateMode.v1\nmode: entities\n",
  );
  for (const item of items) {
    fs.writeFileSync(path.join(entityRoot, `${item.id}.yaml`), YAML.stringify(item));
  }
}

function runPrime(format: "json" | "text", context?: "status"): { rc: number; out: string; err: string; payload?: Record<string, any> } {
  let out = "";
  let err = "";
  const rc = cmdPrime(
    { command: "prime", format, context, home, installRoot: appHome },
    { out: (text) => (out += text), err: (text) => (err += text) },
  );
  return { rc, out, err, ...(format === "json" ? { payload: JSON.parse(out) as Record<string, any> } : {}) };
}

function statusContext(): Record<string, any> {
  const result = runPrime("json", "status");
  expect(result.rc, result.err).toBe(0);
  return result.payload!.capability_context.context.status_context;
}

describe("status TODO readiness integration", () => {
  it("uses the exact Task 1 destination allowlist without admitting status or orchestrate", () => {
    expect([...READINESS.allowedDestinations].sort()).toEqual([
      "audit",
      "build",
      "design",
      "discuss",
      "document",
      "optimize",
      "plan",
      "profile",
      "research",
      "vision",
    ]);
    expect(READINESS.allowedDestinations).not.toContain("status");
    expect(READINESS.allowedDestinations).not.toContain("orchestrate");
  });

  it.each(READINESS.allowedDestinations)("selects %s and abstains from the same destination on an ordering conflict", (capability) => {
    const phase = READINESS.phaseByCapability.get(capability);
    const selected = todo("aaaaaaaaaa", `${capability} positive`, readiness(capability));
    publish([selected]);

    expect(statusContext().next_action).toMatchObject({
      capability,
      phase,
      id: "aaaaaaaaaa",
      artifact: "todo",
      outcome: "actionable",
      eligible: true,
      retrieval: { exact: "npx -y agentera@next state todo get --id aaaaaaaaaa" },
    });

    const conflicting = todo("bbbbbbbbbb", `${capability} conflict`, readiness(capability));
    publish([selected, conflicting]);
    expect(statusContext().next_action).toMatchObject({
      capability: "status",
      outcome: "needs-triage",
      eligible: false,
      reason: "Assign distinct queue_rank values to same-severity actionable items after review.",
    });
  });

  it("keeps bare and host JSON projections byte-exact on TODO recommendation fields", () => {
    publish([todo(
      "aaaaaaaaaa",
      "Resolve the glossary boundary",
      readiness("discuss", 1, { reason: "Resolve the declared glossary boundary." }),
    )]);

    const json = runPrime("json");
    const host = runPrime("json", "status");
    expect(json.rc, json.err).toBe(0);
    expect(host.rc, host.err).toBe(0);

    const expected = {
      object: "TODO aaaaaaaaaa: Resolve the glossary boundary",
      capability: "discuss",
      reason: "Resolve the declared glossary boundary.",
      phase: "deliberate",
      id: "aaaaaaaaaa",
      artifact: "todo",
      outcome: "actionable",
      eligible: true,
      retrieval: { exact: "npx -y agentera@next state todo get --id aaaaaaaaaa" },
    };
    expect(json.payload!.next_action).toMatchObject(expected);
    expect(host.payload!.capability_context.context.status_context.next_action).toEqual(json.payload!.next_action);
  });

  it("projects blocked recovery without selecting an implementation destination", () => {
    const items = [todo("aaaaaaaaaa", "Blocked fixture", readiness("build", 1, {
      blocked: { reason: "Synthetic blocker.", recovery: "Remove the synthetic blocker." },
    }))];
    publish(items);

    const evaluated = evaluateTodoReadinessQueue(items, REPO_ROOT);
    expect(evaluated).toMatchObject({ selected: null, triage: { count: 1 }, abstainRecovery: "Remove the synthetic blocker." });
    expect(evaluated.evaluations[0]).toMatchObject({ result: "blocked", eligible: false, attention: "item" });
    expect(statusContext()).toMatchObject({
      attention: expect.arrayContaining(["normal: TODO: Blocked fixture"]),
      next_action: { capability: "status", eligible: false, reason: "Remove the synthetic blocker." },
    });
  });

  it("projects gated recovery without turning the gate into a destination", () => {
    const items = [todo("aaaaaaaaaa", "Gated fixture", readiness("build", 1, {
      gate: { state: "pending", reason: "Synthetic approval.", recovery: "Obtain synthetic approval." },
    }))];
    publish(items);

    const evaluated = evaluateTodoReadinessQueue(items, REPO_ROOT);
    expect(evaluated).toMatchObject({ selected: null, triage: { count: 0 }, abstainRecovery: "Obtain synthetic approval." });
    expect(evaluated.evaluations[0]).toMatchObject({ result: "gated", eligible: false, attention: "none" });
    expect(statusContext().next_action).toMatchObject({ capability: "status", eligible: false, reason: "Obtain synthetic approval." });
  });

  it("projects unresolved dependencies as waiting with their canonical recovery", () => {
    const items = [
      todo("aaaaaaaaaa", "Waiting fixture", readiness("build", 1, {
        dependencies: [{ artifact: "todo", id: "bbbbbbbbbb" }],
      }), { severity: "critical" }),
      todo("bbbbbbbbbb", "Gated prerequisite", readiness("discuss", 1, {
        gate: { state: "pending", reason: "Prerequisite review.", recovery: "Review the prerequisite." },
      })),
    ];
    publish(items);

    const evaluated = evaluateTodoReadinessQueue(items, REPO_ROOT);
    expect(evaluated.evaluations.find((entry) => entry.id === "aaaaaaaaaa")).toMatchObject({
      result: "waiting",
      eligible: false,
      attention: "none",
      recovery: "Resolve the canonical TODO dependency, then re-evaluate this item.",
    });
    expect(statusContext().next_action).toMatchObject({
      capability: "status",
      eligible: false,
      reason: "Resolve the canonical TODO dependency, then re-evaluate this item.",
    });
  });

  it("projects absent readiness as bounded triage and recovery", () => {
    const items = [todo("aaaaaaaaaa", "Needs triage fixture")];
    publish(items);

    const evaluated = evaluateTodoReadinessQueue(items, REPO_ROOT);
    expect(evaluated).toMatchObject({
      selected: null,
      triage: { count: 1 },
      abstainRecovery: "Review the item and declare readiness through the typed TODO writer.",
    });
    expect(evaluated.evaluations[0]).toMatchObject({ result: "needs-triage", eligible: false, attention: "item" });
    expect(statusContext().next_action).toMatchObject({
      capability: "status",
      eligible: false,
      reason: "Review the item and declare readiness through the typed TODO writer.",
    });
  });

  it("keeps mixed triage visible without displacing actionable work", () => {
    const items = [
      todo("aaaaaaaaaa", "Needs triage fixture"),
      todo("bbbbbbbbbb", "Actionable fixture", readiness("design")),
    ];
    publish(items);

    const evaluated = evaluateTodoReadinessQueue(items, REPO_ROOT);
    expect(evaluated).toMatchObject({
      selected: { id: "bbbbbbbbbb", capability: "design", eligible: true },
      triage: {
        count: 1,
        recovery: "Review unannotated or invalid items separately; do not displace actionable work.",
      },
    });
    const nextAction = statusContext().next_action;
    expect(nextAction).toMatchObject({ id: "bbbbbbbbbb", capability: "design", eligible: true });
    expect(nextAction.alternatives).toContainEqual(expect.objectContaining({
      capability: "status",
      outcome: "needs-triage",
      eligible: false,
      reason: "Review unannotated or invalid items separately; do not displace actionable work.",
    }));
  });

  it("uses severity and contract-owned recovery for an all-non-actionable queue", () => {
    const items = [
      todo("aaaaaaaaaa", "Critical blocked fixture", readiness("build", 7, {
        blocked: { reason: "Critical blocker.", recovery: "Resolve the critical blocker." },
      }), { severity: "critical" }),
      todo("bbbbbbbbbb", "Normal gated fixture", readiness("plan", 1, {
        gate: { state: "pending", reason: "Normal gate.", recovery: "Resolve the normal gate." },
      })),
    ];
    publish(items);

    const evaluated = evaluateTodoReadinessQueue(items, REPO_ROOT);
    expect(evaluated).toMatchObject({ selected: null, abstainRecovery: "Resolve the critical blocker." });
    expect(statusContext()).toMatchObject({
      attention: expect.arrayContaining(["critical: TODO: Critical blocked fixture"]),
      next_action: { capability: "status", eligible: false, reason: "Resolve the critical blocker." },
    });
  });

  it("selects the synthetic glossary review and ignores early, late, and input-order prose signals", () => {
    // Synthetic regression derived from public project TODO azytlqzxoa. The fixture
    // copies no persisted readiness or private data; its discuss assignment is test-only.
    const glossaryDescription = "Add glossary synthesis from bounded correction signals with project-glossary suppression.";
    const lateSignal = `${"Neutral synthetic control. ".repeat(500)}help me decide whether this should be audited.`;
    const glossary = todo("azytlqzxoa", glossaryDescription, readiness("discuss", 1, {
      reason: "Resolve the glossary product boundary before implementation.",
    }));
    const control = todo("zzzzzzzzzz", lateSignal, readiness("build", 2, {
      reason: "The synthetic control is implementation-ready.",
    }));
    publish([glossary, control]);

    expect(statusContext().next_action).toMatchObject({ id: "azytlqzxoa", capability: "discuss", phase: "deliberate", eligible: true });
    expect(evaluateTodoReadinessQueue([control, glossary], REPO_ROOT).selected).toMatchObject({ id: "azytlqzxoa", capability: "discuss" });
    expect(resolveRouteRequest(glossaryDescription, REPO_ROOT).outcome).toBe("semantic_required");

    control.record.description = `help me decide whether this should be audited. ${"Neutral synthetic control. ".repeat(500)}`;
    publish([control]);
    expect(statusContext().next_action).toMatchObject({ id: "zzzzzzzzzz", capability: "build", phase: "build", eligible: true });
  });
});
