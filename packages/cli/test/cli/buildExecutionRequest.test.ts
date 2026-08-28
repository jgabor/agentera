import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildExecutionContext } from "../../src/cli/capabilityContext/build.js";
import { cmdPrime } from "../../src/cli/commands/prime.js";
import {
  BUILD_EXECUTION_REQUEST_MAX_UTF8_BYTES,
  BuildExecutionRequestError,
  loadBuildExecutionRequest,
  type BuildExecutionRequest,
} from "../../src/cli/commands/prime/buildExecutionRequest.js";
import { main } from "../../src/cli/dispatch.js";
import type { SchemaInfo } from "../../src/cli/appContext.js";
import { planLifecycleState } from "../../src/cli/planLifecycleState.js";
import { STATE_FAMILY_FALLBACK_COMMANDS } from "../../src/cli/capabilityContext/types.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const VALID_YAML = [
  "schema_version: agentera.buildExecutionRequest.v1",
  "scope: Repair bounded startup",
  "acceptance:",
  "  - No plan fallback is emitted",
  "",
].join("\n");
const VALID_EMPTY_PROFILE = [
  "# Profile",
  "",
  "<!-- agentera:personal-glossary:start -->",
  "## Glossary",
  "",
  "```json",
  '{"schema_version":"agentera.personalGlossarySection.v1","as_of":"2026-07-30","confidence_basis":{},"entries":[]}',
  "```",
  "<!-- agentera:personal-glossary:end -->",
  "",
].join("\n");

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "build-input-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function capture(fn: (io: { out: (text: string) => void; err: (text: string) => void; stdin?: () => string }) => number) {
  let out = "";
  let err = "";
  const io = { out: (text: string) => { out += text; }, err: (text: string) => { err += text; } };
  const rc = fn(io);
  return { rc, out, err };
}

function request(kind: "file" | "stdin" = "stdin"): BuildExecutionRequest {
  return {
    schema_version: "agentera.buildExecutionRequest.v1",
    scope: "Repair bounded startup",
    acceptance: ["No plan fallback is emitted"],
    source: { kind, schema_version: "agentera.buildExecutionRequest.v1", persisted: false },
  };
}

function schema(name: string, file: string): Record<string, SchemaInfo> {
  return { [name]: { path: file, record: undefined, schema: {}, fields: {} } };
}

describe("Build execution request parser", () => {
  it("loads valid YAML from a file and valid JSON from stdin with exact transient provenance", () => {
    const file = path.join(tmp, "request.yaml");
    fs.writeFileSync(file, VALID_YAML);
    expect(loadBuildExecutionRequest(file)).toEqual(request("file"));

    const fromStdin = loadBuildExecutionRequest("-", () => JSON.stringify({
      schema_version: "agentera.buildExecutionRequest.v1",
      scope: "Repair bounded startup",
      acceptance: ["No plan fallback is emitted"],
    }));
    expect(fromStdin).toEqual(request("stdin"));
  });

  it.each([
    ["malformed UTF-8", Buffer.from([0xc3, 0x28])],
    ["malformed YAML", Buffer.from("scope: [", "utf8")],
    ["extra field", Buffer.from(`${VALID_YAML}secret: value\n`, "utf8")],
    ["wrong schema", Buffer.from(VALID_YAML.replace("agentera.buildExecutionRequest.v1", "wrong"), "utf8")],
    ["missing field", Buffer.from("schema_version: agentera.buildExecutionRequest.v1\nscope: x\n", "utf8")],
    ["empty scope", Buffer.from(VALID_YAML.replace("Repair bounded startup", "   "), "utf8")],
    ["overlong scope", Buffer.from(VALID_YAML.replace("Repair bounded startup", "x".repeat(161)), "utf8")],
    ["overlong acceptance", Buffer.from(VALID_YAML.replace("No plan fallback is emitted", "x".repeat(161)), "utf8")],
    ["control character", Buffer.from(JSON.stringify({ schema_version: "agentera.buildExecutionRequest.v1", scope: "bad\u0007", acceptance: ["pass"] }), "utf8")],
    ["empty acceptance", Buffer.from(VALID_YAML.replace("  - No plan fallback is emitted", "  - ' '"), "utf8")],
    ["too many acceptance items", Buffer.from(VALID_YAML.replace("  - No plan fallback is emitted", Array.from({ length: 13 }, (_, i) => `  - item ${i}`).join("\n")), "utf8")],
    ["duplicate acceptance", Buffer.from(VALID_YAML.replace("  - No plan fallback is emitted", "  - same\n  - same"), "utf8")],
    ["duplicate field", Buffer.from(`${VALID_YAML}scope: duplicate\n`, "utf8")],
    ["whole request over bound", Buffer.alloc(BUILD_EXECUTION_REQUEST_MAX_UTF8_BYTES + 1, 0x20)],
  ])("rejects %s without returning request content", (_label, bytes) => {
    try {
      loadBuildExecutionRequest("-", () => bytes);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(BuildExecutionRequestError);
      expect((error as BuildExecutionRequestError).body.message).not.toContain("secret");
    }
  });

  it.each(["file", "stdin"])("rejects oversized %s through the canonical envelope without source echo", (sourceKind) => {
    const sensitive = `private-${"x".repeat(BUILD_EXECUTION_REQUEST_MAX_UTF8_BYTES + 1)}`;
    const file = path.join(tmp, "oversized-request.yaml");
    if (sourceKind === "file") fs.writeFileSync(file, sensitive);
    const result = capture((io) => cmdPrime({
      context: "build",
      format: "json",
      input: sourceKind === "file" ? file : "-",
      projectRoot: tmp,
      home: path.join(tmp, "home"),
      installRoot: REPO_ROOT,
    }, sourceKind === "stdin" ? { ...io, stdin: () => sensitive } : io));
    expect(result.rc).toBe(2);
    expect(JSON.parse(result.out)).toMatchObject({
      schemaVersion: "agentera.invalidInputEnvelope.v2",
      error: { class: "schema_violation", message: expect.stringContaining("32768-byte") },
    });
    expect(result.out).not.toContain("private-");
    expect(result.out).not.toContain(file);
  });

  it.each(["symlink", "directory"])("rejects %s file input safely", (kind) => {
    const target = path.join(tmp, "request-target.yaml");
    fs.writeFileSync(target, VALID_YAML);
    const input = path.join(tmp, kind);
    if (kind === "symlink") fs.symlinkSync(target, input);
    else fs.mkdirSync(input);
    const result = capture((io) => cmdPrime({
      context: "build", format: "json", input, projectRoot: tmp,
      home: path.join(tmp, "home"), installRoot: REPO_ROOT,
    }, io));
    expect(result.rc).toBe(2);
    expect(JSON.parse(result.out)).toMatchObject({
      schemaVersion: "agentera.invalidInputEnvelope.v2",
      error: { class: "invalid_format", message: expect.stringContaining("regular file") },
    });
    expect(result.out).not.toContain(input);
    expect(result.out).not.toContain("Repair bounded startup");
  });

  it("rejects a file replaced by a symlink while it is opened", () => {
    const input = path.join(tmp, "request.yaml");
    const original = path.join(tmp, "original-request.yaml");
    fs.writeFileSync(input, VALID_YAML);
    const nativeOpen = fs.openSync;
    const open = vi.spyOn(fs, "openSync").mockImplementation(((target, flags, mode) => {
      if (target === input) {
        fs.renameSync(input, original);
        fs.symlinkSync(original, input);
      }
      return nativeOpen(target, flags, mode);
    }) as typeof fs.openSync);
    try {
      expect(() => loadBuildExecutionRequest(input)).toThrow(BuildExecutionRequestError);
    } finally {
      open.mockRestore();
    }
  });
});

describe("Build no-plan execution context", () => {
  it("is complete from explicit transient scope and acceptance when other execution state is available", () => {
    const changelog = path.join(tmp, "CHANGELOG.md");
    fs.writeFileSync(changelog, "# Changelog\n\n## [Unreleased]\n## [1.0.0] - 2026-01-01\n");
    const context = buildExecutionContext(
      "build",
      schema("changelog", changelog),
      { exists: false, active: false, tasks: [] },
      { exists: true },
      { exists: true },
      [{ status: "open", severity: "normal", text: "bounded work" }],
      { exists: true, mapping: [] },
      { status: "loaded" },
      { status: "up_to_date" },
      tmp,
      request(),
    );

    expect(context).toMatchObject({
      mode: "no_plan",
      work_selection: {
        status: "selected",
        selection_reason: "explicit_no_plan_scope",
        task: null,
        scope: "Repair bounded startup",
        source_provenance: {
          source_family: "transient_build_execution_request",
          command: "npx -y agentera@next prime --context build --input <file|-> --format json",
          source_kind: "stdin",
          persisted: false,
        },
      },
      acceptance_criteria: {
        status: "available",
        items: ["No plan fallback is emitted"],
        source_provenance: { field: "acceptance", schema_version: "agentera.buildExecutionRequest.v1" },
      },
      artifact_update_requirements: {
        required_families: ["todo", "changelog"],
        conditional_families: ["progress"],
        plan_status_update_required: false,
      },
      progress_logging_requirements: { requirement: "conditional" },
      source_contract: { complete_for_execution_context: true },
    });
    expect(context?.fallback_commands).not.toContain(STATE_FAMILY_FALLBACK_COMMANDS.plan);
  });

  it("fails safe without transient input and gives one advancing no-plan recovery", () => {
    const context = buildExecutionContext(
      "build", {}, { exists: false, active: false, tasks: [] }, { exists: false }, { exists: false }, [],
      { exists: false }, { status: "not_loaded" }, { status: "up_to_date" }, tmp,
    );
    expect(planLifecycleState({ exists: false, active: false })).toMatchObject({ status: "unavailable" });
    expect(context).toMatchObject({
      mode: "no_plan",
      plan_lifecycle_state: { status: "unavailable" },
      source_contract: { complete_for_execution_context: false },
    });
    expect(context?.fallback_commands).toContain("npx -y agentera@next prime --context build --input - --format json");
    expect(context?.fallback_commands).not.toContain(STATE_FAMILY_FALLBACK_COMMANDS.plan);
    expect(context?.state_family_caveats).toContain("Explicit no-plan scope and acceptance are required before Build can execute without a current plan.");
  });

  it("allows healthy archived-only history with transient work but keeps degraded history fail-safe", () => {
    const changelog = path.join(tmp, "CHANGELOG.md");
    fs.writeFileSync(changelog, "# Changelog\n\n## [Unreleased]\n## [1.0.0] - 2026-01-01\n");
    const base = [
      "build", schema("changelog", changelog), undefined, { exists: true }, { exists: true },
      [{ status: "open", severity: "normal", text: "bounded work" }], { exists: true, mapping: [] },
      { status: "loaded" }, { status: "up_to_date" }, tmp, request(),
    ] as const;
    const healthy = buildExecutionContext(...[...base.slice(0, 2), { exists: true, active: false, tasks: [] }, ...base.slice(3)] as Parameters<typeof buildExecutionContext>);
    const degraded = buildExecutionContext(...[...base.slice(0, 2), { exists: true, active: false, tasks: [], diagnostics: [{ category: "invalid", path: "archive" }] }, ...base.slice(3)] as Parameters<typeof buildExecutionContext>);
    expect(healthy).toMatchObject({ mode: "no_plan", source_contract: { complete_for_execution_context: true } });
    expect(healthy?.fallback_commands).not.toContain(STATE_FAMILY_FALLBACK_COMMANDS.plan);
    expect(degraded).toMatchObject({ mode: "no_plan", source_contract: { complete_for_execution_context: false } });
    expect(degraded?.fallback_commands).toContain(STATE_FAMILY_FALLBACK_COMMANDS.plan);
  });

  it("preserves plan-driven and completed-plan pass and fail-safe completeness", () => {
    const changelog = path.join(tmp, "CHANGELOG.md");
    fs.writeFileSync(changelog, "# Changelog\n\n## [Unreleased]\n## [1.0.0] - 2026-01-01\n");
    const run = (plan: Record<string, unknown>, docsExists = true) => buildExecutionContext(
      "build", schema("changelog", changelog), plan, { exists: true }, { exists: true },
      [{ status: "open", severity: "normal", text: "bounded work" }],
      { exists: docsExists, mapping: [] }, { status: "loaded" }, { status: "up_to_date" }, tmp,
    );
    const pending = {
      exists: true, active: true, complete_plan: false,
      tasks: [{ id: "aaaaaaaaaa", name: "Current", status: "pending", depends_on: [], acceptance: ["Pass"] }],
    };
    expect(run(pending)).toMatchObject({ mode: "plan_driven", source_contract: { complete_for_execution_context: true } });
    expect(run({ ...pending, tasks: [{ ...pending.tasks[0], acceptance: [] }] })).toMatchObject({
      mode: "plan_driven", source_contract: { complete_for_execution_context: false },
    });

    const completed = {
      exists: true, active: true, complete_plan: true,
      tasks: [{ id: "bbbbbbbbbb", name: "Done", status: "complete", depends_on: [], acceptance: ["Pass"] }],
    };
    expect(run(completed)).toMatchObject({ mode: "completed_plan_sweep", source_contract: { complete_for_execution_context: true } });
    expect(run(completed, false)).toMatchObject({ mode: "completed_plan_sweep", source_contract: { complete_for_execution_context: false } });
  });
});

describe("prime --context build --input", () => {
  it.each([
    ["bare", []],
    ["status", ["--context", "status"]],
    ["other capability", ["--context", "audit"]],
    ["dashboard", ["--context", "build", "--dashboard"]],
    ["guidance", ["--context", "build", "--guidance"]],
  ])("rejects %s input use before reading input through the canonical envelope", (_name, mode) => {
    const { rc, out } = capture((io) => main([
      "node", "agentera", "prime", ...mode, "--input", "sensitive-request.yaml", "--format", "json",
    ], io));
    expect(rc).toBe(2);
    expect(JSON.parse(out)).toMatchObject({ schemaVersion: "agentera.invalidInputEnvelope.v2", error: { class: "unsupported_target" } });
    expect(out).not.toContain("sensitive-request");
  });

  it("emits the canonical envelope for malformed request input", () => {
    const { rc, out } = capture((io) => cmdPrime({
      context: "build", format: "json", input: "-", projectRoot: tmp, home: path.join(tmp, "home"), installRoot: REPO_ROOT,
    }, { ...io, stdin: () => "scope: [" }));
    expect(rc).toBe(2);
    expect(JSON.parse(out)).toMatchObject({
      schemaVersion: "agentera.invalidInputEnvelope.v2",
      status: "fail",
      error: { class: "invalid_format" },
    });
  });

  it("rejects transient input when an active current plan owns execution", () => {
    const planDir = path.join(tmp, ".agentera/entities/plan/plan");
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(path.join(tmp, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
    fs.writeFileSync(path.join(planDir, "aaaaaaaaaa.yaml"), [
      "id: aaaaaaaaaa", "artifact: plan", "record:", "  header:", "    level: light", "    created: 2026-07-30",
      "    title: Current", "    status: open", "  what: Execute current work", "  why: Preserve plan ownership",
      "  scope:", "    included: [state]", "    excluded: []", "",
    ].join("\n"));
    const input = path.join(tmp, "request.yaml");
    fs.writeFileSync(input, VALID_YAML);
    const { rc, out } = capture((io) => cmdPrime({
      context: "build", format: "json", input, projectRoot: tmp, home: path.join(tmp, "home"),
      installRoot: REPO_ROOT,
    }, io));
    expect(rc).toBe(2);
    expect(JSON.parse(out)).toMatchObject({ schemaVersion: "agentera.invalidInputEnvelope.v2", error: { class: "conflict" } });
    expect(out).not.toContain("Repair bounded startup");
  });

  it("threads stdin provenance without mutating a temporary project", () => {
    fs.mkdirSync(path.join(tmp, ".agentera"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
    const before = fs.readFileSync(path.join(tmp, ".agentera/state-mode.yaml"), "utf8");
    const result = capture((io) => cmdPrime({
      context: "build", format: "json", input: "-", projectRoot: tmp, home: path.join(tmp, "home"), installRoot: REPO_ROOT,
    }, { ...io, stdin: () => VALID_YAML }));
    expect(result.rc).toBe(0);
    const execution = JSON.parse(result.out).capability_context.context.execution_context;
    expect(execution).toMatchObject({
      mode: "no_plan",
      work_selection: { source_provenance: { source_kind: "stdin", persisted: false } },
      artifact_update_requirements: { plan_status_update_required: false },
    });
    expect(execution.fallback_commands).not.toContain(STATE_FAMILY_FALLBACK_COMMANDS.plan);
    expect(fs.readFileSync(path.join(tmp, ".agentera/state-mode.yaml"), "utf8")).toBe(before);
    expect(fs.readdirSync(path.join(tmp, ".agentera"))).toEqual(["state-mode.yaml"]);
  });

  it("keeps Build execution input and no-review term input unambiguous", () => {
    fs.mkdirSync(path.join(tmp, ".agentera"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
    const profileDir = path.join(tmp, "profile");
    fs.mkdirSync(profileDir);
    fs.writeFileSync(path.join(profileDir, "PROFILE.md"), VALID_EMPTY_PROFILE);
    const requestFile = path.join(tmp, "request.yaml");
    const termFile = path.join(tmp, "term");
    fs.writeFileSync(requestFile, VALID_YAML);
    fs.writeFileSync(termFile, "private-selected-term");

    vi.stubEnv("AGENTERA_PROFILE_DIR", profileDir);
    try {
      const result = capture((io) => cmdPrime({
        context: "build", format: "json", input: requestFile, termInput: termFile,
        projectRoot: tmp, home: path.join(tmp, "home"), installRoot: REPO_ROOT,
      }, io));

      expect(result.rc).toBe(0);
      const payload = JSON.parse(result.out).capability_context;
      expect(payload.context.execution_context.mode).toBe("no_plan");
      expect(payload.glossary_advice.outcome).toBe("no_applicable_entry");
      expect(result.out).not.toContain("private-selected-term");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects shared stdin before reading either input", () => {
    let reads = 0;
    const result = capture((io) => main([
      "node", "agentera", "prime", "--context", "build", "--input", "-", "--term-input", "-", "--format", "json",
    ], { ...io, stdin: () => { reads += 1; return "private"; } }));
    expect(result.rc).toBe(2);
    expect(JSON.parse(result.out).error.class).toBe("conflicting_stdin");
    expect(reads).toBe(0);
    expect(result.out).not.toContain("private");
  });
});
