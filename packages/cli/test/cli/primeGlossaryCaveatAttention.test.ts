import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch/index.js";
import { collectOrientationState } from "../../src/cli/commands/prime.js";
import { buildOrientationJsonPayload, printOrientationTextBriefing } from "../../src/cli/commands/prime/orientationOutput.js";
import { dumpYamlMapping } from "../../src/core/yaml.js";
import { discoverEntities, validateEntityState } from "../../src/state/entityStorage.js";
import { projectCurrentGlossaryCaveats, validateProgressGlossaryCaveat } from "../../src/state/progressGlossaryCaveat.js";
import { glossaryCaveatContract } from "../../src/registries/glossaryCaveatContract.js";
import { sourceBuildOutputRoot, sourceSubprocessEnv } from "../helpers/sourceSubprocess.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const REVIEW = "normal: glossary review required before meaning-sensitive work";
const roots: string[] = [];

let project: string;
let home: string;
let previousCwd: string;
let previousEnv: Record<string, string | undefined>;

function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (directory: string): void => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const pathname = path.join(directory, entry.name);
      const relative = path.relative(root, pathname);
      if (entry.isDirectory()) visit(pathname);
      else result[relative] = fs.readFileSync(pathname).toString("base64");
    }
  };
  visit(root);
  return result;
}

function caveat(caveatId: string, event = "current", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    caveat_id: caveatId,
    event,
    capability: "build",
    reason: "inferred_equivalence",
    ownership_state: "review_required",
    transition_id: null,
    ...overrides,
  };
}

function progress(entityId: string, glossaryCaveat?: Record<string, unknown>, timestamp = "2000-01-01 00:00"): void {
  const target = path.join(project, ".agentera/entities/progress/progress_cycle", `${entityId}.yaml`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    dumpYamlMapping({
      id: entityId,
      artifact: "progress",
      record: {
        timestamp,
        type: "test",
        phase: "build",
        what: "bounded fixture",
        context: { intent: "exercise prime projection" },
        ...(glossaryCaveat ? { glossary_caveat: glossaryCaveat } : {}),
      },
    }),
  );
}

function todo(): void {
  const target = path.join(project, ".agentera/entities/todo/todo_item/zzzzzzzzzz.yaml");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    dumpYamlMapping({
      id: "zzzzzzzzzz",
      artifact: "todo",
      record: { severity: "normal", status: "open", description: "Unrelated attention" },
    }),
  );
}

function runPrime(format: "json" | "text"): { rc: number; out: string; err: string } {
  let out = "";
  let err = "";
  const argv = ["node", "agentera", "prime", ...(format === "json" ? ["--format", "json"] : [])];
  const rc = main(argv, { out: (text) => (out += text), err: (text) => (err += text) });
  return { rc, out, err };
}

function runStatusContext(): { rc: number; out: string; err: string } {
  let out = "";
  let err = "";
  const rc = main(["node", "agentera", "prime", "--context", "status", "--format", "json"], {
    out: (text) => (out += text),
    err: (text) => (err += text),
  });
  return { rc, out, err };
}

function projection() {
  return projectCurrentGlossaryCaveats(discoverEntities(project, REPO_ROOT).entities, glossaryCaveatContract(path.join(REPO_ROOT, "references/artifacts/glossary-entry-contract.yaml")));
}

function runBuilt(args: string[], stdin = ""): { rc: number | null; out: string; err: string } {
  const result = spawnSync(process.execPath, [process.env.AGENTERA_GLOSSARY_TEST_EXECUTABLE ?? path.join(sourceBuildOutputRoot(), "bin/agentera.js"), ...args], {
    cwd: project,
    input: stdin,
    env: sourceSubprocessEnv({
      ...process.env,
      AGENTERA_BOOTSTRAP_SOURCE_ROOT: REPO_ROOT,
      AGENTERA_HOME: path.join(home, "agentera"),
      HOME: home,
    }),
    encoding: "utf8",
  });
  return { rc: result.status, out: result.stdout, err: result.stderr };
}

function appendArgs(reason: string, ownershipState: string): string[] {
  return ["state", "progress", "append", "--input", "-", "--format", "json"];
}

function expectReadOnly(run: () => void): void {
  const beforeProject = snapshot(project);
  const beforeHome = snapshot(home);
  run();
  expect(snapshot(project)).toEqual(beforeProject);
  expect(snapshot(home)).toEqual(beforeHome);
}

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prime-glossary-caveat-"));
  roots.push(root);
  project = path.join(root, "project");
  home = path.join(root, "home");
  fs.mkdirSync(path.join(project, ".agentera"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(project, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
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
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("prime glossary caveat attention", () => {
  it("projects old current evidence through JSON and text without lifecycle details or writes", () => {
    progress("aaaaaaaaaa", caveat("currentone"));
    const validation = validateEntityState(project);
    expect(validation.valid, JSON.stringify(validation, null, 2)).toBe(true);
    for (const format of ["json", "text"] as const)
      expectReadOnly(() => {
        const result = runPrime(format);
        expect(result.rc, `${result.err}\n${result.out}`).toBe(0);
        expect(result.out).toContain(REVIEW);
        expect(result.out).not.toMatch(/currentone|inferred_equivalence|review_required|2000-01-01/);
      });
    expectReadOnly(() => {
      const result = runStatusContext();
      expect(result.rc, `${result.err}\n${result.out}`).toBe(0);
      expect(result.out).toContain(REVIEW);
      expect(result.out).not.toMatch(/currentone|inferred_equivalence|review_required|2000-01-01/);
    });
  });

  it("projects through freshly compiled prime and status processes without writes", () => {
    progress("aaaaaaaaaa", caveat("currentone"));
    for (const args of [["prime", "--format", "json"], ["prime"], ["prime", "--context", "status", "--format", "json"]])
      expectReadOnly(() => {
        const result = runBuilt(args);
        expect(result.rc, `${args.join(" ")}: ${result.out}${result.err}`).toBe(0);
        expect(result.out).toContain(REVIEW);
        expect(result.out).not.toMatch(/currentone|inferred_equivalence|review_required|2000-01-01/);
      });
  });

  it("removes only matching resolved evidence and preserves unrelated attention order", () => {
    todo();
    progress("aaaaaaaaaa", caveat("currentone"));
    progress("bbbbbbbbbb", caveat("currenttwo"));
    progress("cccccccccc", caveat("currentone", "resolved"));
    const result = runPrime("json");
    expect(result.rc, result.err).toBe(0);
    const attention = JSON.parse(result.out).attention as string[];
    expect(attention.filter((item) => item === REVIEW)).toHaveLength(1);
    expect(attention.some((item) => item.includes("TODO: Unrelated attention"))).toBe(true);
    expect(projection().currentCount).toBe(1);
  });

  it("follows matching supersession and keeps only the successor current", () => {
    progress("aaaaaaaaaa", caveat("currentone"));
    progress("bbbbbbbbbb", caveat("currenttwo"));
    progress("cccccccccc", caveat("currentone", "superseded", { transition_id: "currenttwo" }));
    const result = runPrime("json");
    expect(result.rc, result.err).toBe(0);
    expect((JSON.parse(result.out).attention as string[]).filter((item) => item === REVIEW)).toHaveLength(1);
    expect(result.out).not.toMatch(/currentone|currenttwo|superseded/);
    expect(projection().currentCount).toBe(1);
  });

  it("accepts only canonical Build-owned progress-cycle sources", () => {
    const contract = glossaryCaveatContract(path.join(REPO_ROOT, "references/artifacts/glossary-entry-contract.yaml"));
    const record = { glossary_caveat: caveat("currentone") };
    const otherEntities = [
      { classification: "valid", artifact: "plan", boundary: "plan", record },
      { classification: "valid", artifact: "todo", boundary: "todo_item", record },
      { classification: "valid", artifact: "decisions", boundary: "decision", record },
      { classification: "valid", artifact: "progress", boundary: "plan", record },
      {
        classification: "valid",
        artifact: "progress",
        boundary: "progress_cycle",
        record: { glossary_caveat: caveat("currenttwo", "current", { capability: "plan" }) },
      },
    ];
    expect(projectCurrentGlossaryCaveats(otherEntities, contract)).toMatchObject({
      currentCount: 0,
      attention: null,
    });
  });

  it("enforces all and only the four shared reason/state pairs in validation and writing", () => {
    const contract = glossaryCaveatContract(path.join(REPO_ROOT, "references/artifacts/glossary-entry-contract.yaml"));
    const valid = new Set(["inferred_equivalence/review_required", "inferred_equivalence/project_governs_exact", "authority_unavailable/authority_unavailable", "personal_input_unavailable/authority_unavailable"]);
    const reasons = ["inferred_equivalence", "authority_unavailable", "personal_input_unavailable"];
    const states = ["review_required", "project_governs_exact", "authority_unavailable"];
    for (const reason of reasons) {
      for (const ownershipState of states) {
        const pair = `${reason}/${ownershipState}`;
        const parsed = validateProgressGlossaryCaveat(
          {
            glossary_caveat: caveat("currentone", "current", {
              reason,
              ownership_state: ownershipState,
            }),
          },
          contract,
        );
        expect(parsed.status, pair).toBe(valid.has(pair) ? "valid" : "invalid");
        const before = snapshot(project);
        const written = runBuilt(
          appendArgs(reason, ownershipState),
          JSON.stringify({
            type: "test",
            phase: "build",
            what: "pair fixture",
            context: { intent: "validate shared pair" },
            glossary_caveat: { event: "current", reason, ownership_state: ownershipState },
          }),
        );
        expect(written.rc, `${pair}: ${written.out}${written.err}`).toBe(valid.has(pair) ? 0 : 1);
        if (!valid.has(pair)) expect(snapshot(project), pair).toEqual(before);
      }
    }
    expect(valid.has("personal_input_unavailable/project_governs_exact")).toBe(false);
    expect(projection().currentCount).toBe(4);
  });

  it("reserves one of six public slots, preserves retained order, and leaves next_action unchanged", () => {
    const state = collectOrientationState({ home, env: process.env });
    const unrelated = Array.from({ length: 8 }, (_, index) => `normal: unrelated-${index + 1}`);
    state.attention = [...unrelated, REVIEW];
    state.glossary_caveat_attention = REVIEW;
    state.glossary_caveat_attention_policy = { public_limit: 6, reserved_slots: 1 };
    const withoutGlossary = buildOrientationJsonPayload(
      {
        ...state,
        attention: unrelated,
        glossary_caveat_attention: null,
        glossary_caveat_attention_policy: null,
      },
      "prime",
    );
    const json = buildOrientationJsonPayload(state, "prime");
    expect(json.attention).toEqual([...unrelated.slice(0, 5), REVIEW]);
    expect(json.next_action).toEqual(withoutGlossary.next_action);
    let text = "";
    printOrientationTextBriefing(state, "prime", (value) => (text += value));
    const retained = [...unrelated.slice(0, 5), REVIEW];
    for (const item of retained) expect(text.indexOf(`- ${item}`), item).toBeGreaterThanOrEqual(0);
    for (let index = 1; index < retained.length; index += 1) expect(text.indexOf(`- ${retained[index - 1]}`)).toBeLessThan(text.indexOf(`- ${retained[index]}`));
    expect(text).not.toContain("normal: unrelated-6");
  });

  it("omits absent and unrelated progress evidence", () => {
    progress("aaaaaaaaaa");
    const result = runPrime("json");
    expect(result.rc, result.err).toBe(0);
    expect(result.out).not.toContain(REVIEW);
  });

  it("does not let orphan, mismatched, or duplicate terminal evidence suppress a valid current", () => {
    progress("aaaaaaaaaa", caveat("currentone"));
    progress("bbbbbbbbbb", caveat("orphanxxxx", "resolved"));
    progress("cccccccccc", caveat("currentone", "resolved", { reason: "authority_unavailable" }));
    progress("dddddddddd", caveat("currentone", "resolved"));
    progress("eeeeeeeeee", caveat("currentone", "resolved"));
    const result = runPrime("json");
    expect(result.rc, result.err).toBe(0);
    expect(result.out).toContain(REVIEW);
    expect(result.out).not.toMatch(/orphanxxxx|currentone|authority_unavailable/);
  });

  it.each([
    ["event", { event: "private-event" }],
    ["reason", { reason: "private-definition" }],
    ["ownership", { ownership_state: "private-owner" }],
    ["identity", { caveat_id: "SECRET_PROFILE_PATH" }],
  ])("fails closed or omits malformed %s evidence without leaking bytes", (_label, override) => {
    progress("aaaaaaaaaa", caveat("currentone", "current", override));
    fs.writeFileSync(path.join(project, "privacy-trap.txt"), "SECRET_DEFINITION SECRET_ANCHOR SECRET_PROVENANCE");
    const result = runPrime("json");
    expect(`${result.out}${result.err}`).not.toMatch(/private-event|private-definition|private-owner|SECRET_PROFILE_PATH|SECRET_DEFINITION|SECRET_ANCHOR|SECRET_PROVENANCE/);
  });

  it("omits malformed progress from prime and returns path-safe direct retrieval errors", () => {
    const target = path.join(project, ".agentera/entities/progress/progress_cycle/aaaaaaaaaa.yaml");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `id: privatepath\nartifact: progress\nrecord:\n  timestamp: 2000-01-01 00:00\n  type: test\n  phase: build\n  what: SECRET_RAW_VALUE\n  context:\n    intent: SECRET_PRIVATE_PATH\n`);
    const forbidden = /privatepath|SECRET_RAW_VALUE|SECRET_PRIVATE_PATH|aaaaaaaaaa\.yaml|\.agentera\/entities/;
    for (const args of [["prime", "--format", "json"], ["prime"], ["prime", "--context", "status", "--format", "json"]])
      expectReadOnly(() => {
        const result = runBuilt(args);
        expect(result.rc, `${args.join(" ")}: ${result.out}${result.err}`).toBe(0);
        expect(`${result.out}${result.err}`).not.toMatch(forbidden);
      });
    for (const args of [
      ["state", "progress", "list", "--format", "json"],
      ["state", "progress", "get", "--id", "aaaaaaaaaa", "--format", "json"],
      ["state", "progress", "list"],
      ["state", "progress", "get", "--id", "aaaaaaaaaa"],
    ])
      expectReadOnly(() => {
        const result = runBuilt(args);
        expect(result.rc, `${args.join(" ")}: ${result.out}${result.err}`).toBe(1);
        expect(`${result.out}${result.err}`).toContain("canonical progress evidence");
        expect(`${result.out}${result.err}`).not.toMatch(forbidden);
      });
  });

  it("emits one bounded item for a long valid history", () => {
    for (let index = 0; index < 24; index += 1) {
      const caveatId = `caveat${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + (index % 26))}xx`;
      const entityId = `${String.fromCharCode(97 + index)}aaaaaaaaa`.slice(0, 10);
      progress(entityId, caveat(caveatId), `1999-01-${String((index % 28) + 1).padStart(2, "0")} 00:00`);
    }
    const result = runPrime("json");
    expect(result.rc, result.err).toBe(0);
    expect((JSON.parse(result.out).attention as string[]).filter((item) => item === REVIEW)).toHaveLength(1);
  });
});
