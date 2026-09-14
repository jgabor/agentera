import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runServiceDetail } from "../../src/cli/commands/serviceDetail.js";
import { printCheckHelp } from "../../src/cli/help.js";
import { cmdLint } from "../../src/cli/commands/lint.js";
import { cmdCompact } from "../../src/cli/commands/compact.js";
import { cmdDurability, validateDurabilityArgs } from "../../src/cli/commands/durability.js";
import { parseDurabilityArgs, runDurability, runLint, runCompact } from "../../src/cli/dispatch/check.js";
import { StateRetrievalFailure } from "../../src/state/directRetrieval.js";
import { entityArtifactValues } from "../../src/state/entityStorage.js";
import { stateDurabilityContract } from "../../src/state/archiveDiscovery.js";
import { loadProjectionPolicy } from "../../src/state/projectionPolicy.js";
import * as durability from "../../src/state/durability.js";
import * as compaction from "../../src/hooks/compaction/index.js";
import type { CompactionOperation } from "../../src/hooks/compaction/types.js";
import type { ProjectionRecoveryReport } from "../../src/state/archiveRecovery.js";

const root = path.resolve(import.meta.dirname, "../../../..");
let temporary: string;
beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-check-detail-"));
  vi.stubEnv("AGENTERA_BOOTSTRAP_SOURCE_ROOT", root);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(temporary, { recursive: true, force: true });
});

function capture(run: (io: { out: (text: string) => void; err: (text: string) => void }) => number) {
  let out = "",
    err = "";
  const code = run({
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
  });
  expect(err).toBe("");
  return { code, value: JSON.parse(out), out };
}
function detail(operation: string, section = "output") {
  const response = capture((io) => runServiceDetail("check", ["--operation", operation, "--section", section], io));
  expect(response.code, response.out).toBe(0);
  expect(Buffer.byteLength(response.out)).toBeLessThanOrEqual(32768);
  expect(response.value.completeness.mode).toBe("detail");
  expect(response.value.next_command).toBeNull();
  return response.value.items[0].content;
}
// Every emitted field, including nested/optional fields in the populated fixtures,
// must have a meaning in the static contract. Dynamic mappings use prose leaves.
function covered(actual: any, guidance: any) {
  if (typeof guidance === "string") return;
  if (Array.isArray(actual)) {
    expect(Array.isArray(guidance)).toBe(true);
    for (const item of actual) if (item && typeof item === "object") covered(item, guidance[0]);
  } else if (actual && typeof actual === "object" && typeof guidance !== "string") {
    for (const [key, value] of Object.entries(actual)) {
      expect(guidance, `undocumented output field ${key}`).toHaveProperty(key);
      covered(value, guidance[key]);
    }
  }
}

describe("check explanation selector and producer parity", () => {
  it("keeps durability help aligned with detail and argument rejection without inspecting state", () => {
    const inspect = vi.spyOn(durability, "inspectDurability").mockImplementation(() => {
      throw new Error("must not inspect");
    });
    const help = printCheckHelp("durability");
    const usage = detail("durability", "usage");
    const selectors = detail("durability", "selectors");
    expect(help.split("\n\n")[0].replace("usage: ", "").replace(" [-h]", "").replace(/\s+/g, " ")).toBe(usage.syntax.replace("npx -y agentera@next", "agentera"));
    const artifacts = help.match(/--artifact ARTIFACT +Required: ([^\n]+)/)?.[1].split(", ");
    expect(artifacts).toEqual(selectors.artifacts);
    expect(artifacts).toHaveLength(8);
    expect(help).toContain("Required: bare ten-lowercase-letter entity ID");
    expect(help).toContain("--number is rejected");
    expect(help).not.toMatch(/^ +--number /m);
    expect(help).toContain(`Validated integer (1-${selectors.maximum_limit}); returns one entity`);
    for (const [argv, message] of [
      [[], "requires --artifact ARTIFACT --id ID"],
      [["--artifact", "progress", "--id", "qjtrmnpvka", "--number", "1"], "rejects --number"],
    ] as const) {
      const rejected = capture((io) => runDurability([...argv], io, "agentera check durability"));
      expect(rejected.code).toBe(2);
      expect(rejected.value.schemaVersion).toBe("agentera.stateFailure.v1");
      expect(rejected.value.error.class).toBe("invalid_request");
      expect(rejected.value.error.message).toContain(message);
      expect(help).toContain(rejected.value.error.syntax.replace("agentera check durability", "agentera check durability [-h]"));
    }
    expect(inspect).not.toHaveBeenCalled();
    expect(fs.readdirSync(temporary)).toEqual([]);
  });

  it("advertises durability's current required entity selectors and a valid example without inspecting state", () => {
    const inspect = vi.spyOn(durability, "inspectDurability").mockImplementation(() => {
      throw new Error("must not inspect");
    });
    const selectors = detail("durability", "selectors");
    const usage = detail("durability", "usage");
    expect(selectors.required).toEqual(["artifact", "id"]);
    expect(selectors.artifacts).toEqual(entityArtifactValues(root));
    expect(selectors.maximum_limit).toBe(stateDurabilityContract(root).maximumLimit);
    expect(selectors.rejected).toContain("number");
    expect(usage.syntax).toContain("--artifact ARTIFACT --id ID");
    expect(usage.syntax).not.toContain("--number");
    const parsed = parseDurabilityArgs(usage.example.split(" ").slice(5));
    expect(parsed).not.toHaveProperty("error");
    if ("error" in parsed) throw new Error(parsed.error);
    expect(() => validateDurabilityArgs(parsed, root)).not.toThrow();
    expect(parsed.id).toMatch(new RegExp(selectors.id_pattern));
    for (const artifact of selectors.artifacts) {
      for (const limit of [selectors.minimum_limit, selectors.maximum_limit]) {
        expect(() => validateDurabilityArgs({ ...parsed, artifact, limit }, root)).not.toThrow();
      }
    }
    for (const invalid of [
      { ...parsed, artifact: undefined },
      { ...parsed, id: undefined },
      { ...parsed, number: 1 },
      { ...parsed, id: "progress:qjtrmnpvka" },
      { ...parsed, artifact: "not-an-entity-artifact" },
      { ...parsed, limit: 0 },
      { ...parsed, limit: selectors.maximum_limit + 1 },
    ])
      expect(() => validateDurabilityArgs(invalid, root)).toThrow(StateRetrievalFailure);
    const rejected = capture((io) => runDurability(["--artifact", "progress", "--id", "qjtrmnpvka", "--number", "1"], io, "agentera check durability"));
    expect(rejected.code).toBe(2);
    expect(rejected.value.error.message).toContain("rejects --number");
    covered(rejected.value, detail("durability").failure);
    expect(inspect).not.toHaveBeenCalled();
  });

  it.each([false, true])("matches lint content failure fields and advisory/strict exits (strict=%s)", (strict) => {
    const contract = detail("lint");
    const result = capture((io) =>
      cmdLint(
        {
          artifact: "PLAN.md",
          text: "we should probably improve things",
          strict,
          format: "json",
        },
        io,
      ),
    );
    const expected = contract.outcomes[strict ? "content_issues_strict" : "content_issues_advisory"];
    expect(result.code).toBe(expected.exit_code);
    expect(result.value.status).toBe(expected.status);
    expect(result.value.strict).toBe(expected.strict);
    expect(result.value.summary.advisory).toBe(expected.advisory);
    expect(Object.keys(result.value).sort()).toEqual(Object.keys(contract.fields).sort());
    covered(result.value, contract.fields);
    expect(result.value.checks.map((check: any) => check.name)).toEqual(["verbosity", "abstraction", "filler"]);
    expect(result.value.summary.passed + result.value.summary.failed).toBe(3);
  });

  it.each([false, true])("matches lint authority failure without treating it as advisory success (strict=%s)", (strict) => {
    const contract = detail("lint");
    vi.stubEnv("AGENTERA_BOOTSTRAP_SOURCE_ROOT", temporary);
    const result = capture((io) =>
      cmdLint(
        {
          artifact: "PLAN.md",
          text: "updated src/example.ts at line 42",
          strict,
          format: "json",
        },
        io,
      ),
    );
    expect(result.code).toBe(contract.outcomes.authority_failure.exit_code);
    expect(result.value.status).toBe(contract.outcomes.authority_failure.status);
    expect(result.value.summary.advisory).toBe(!strict);
    expect(result.value.checks[0].detail).toMatch(/^verbosity authority error/);
    covered(result.value, contract.fields);
  });

  it("documents separate invalid-input envelopes for lint and compact", () => {
    for (const [operation, run, args] of [
      ["lint", runLint, ["--text", "draft"]],
      ["compact", runCompact, ["--mode", "unknown"]],
    ] as const) {
      const result = capture((io) => run([...args], io, `agentera check ${operation}`));
      expect(result.code).toBe(2);
      expect(result.value.schemaVersion).toBe(detail(operation).input_failure.schemaVersion);
      covered(result.value, detail(operation).input_failure);
    }
  });

  it.each(["complete", "degraded", "unavailable"] as const)("describes emitted durability evidence (%s) without running inspection or Git", (status) => {
    const contract = detail("durability");
    const values = stateDurabilityContract(root);
    const missing = status === "unavailable";
    const gitReason = status === "complete" ? "non_git" : "not_committed";
    const response: durability.DurabilityResponse = {
      command: "agentera check durability --project PATH --artifact ARTIFACT --id ID",
      status,
      project: temporary,
      read_only: true,
      remote_contact: false,
      head: { status: status === "complete" ? "unavailable" : "stable" },
      counts: {
        discovered: missing ? 0 : 1,
        returned: 1,
        local_verified: missing ? 0 : 1,
        local_unavailable: missing ? 1 : 0,
        local_corrupt: 0,
        reachable_recovery: 0,
      },
      entries: [
        {
          id: "qjtrmnpvka",
          artifact: "progress",
          status,
          local: {
            status: missing ? "unavailable" : "verified",
            detail_availability: missing ? "unavailable" : "full",
            path: ".agentera/entities/progress/entry/qjtrmnpvka.yaml",
            message: "fixture",
          },
          git: { status: "unavailable", reason: gitReason, reachable_recovery: false },
          retrieval: { get: "agentera state progress get --id qjtrmnpvka" },
        },
      ],
      diagnostics: [{ class: gitReason, message: "fixture", recovery: "read local state" }],
      source_contract: {
        syntax: contract.fields.command,
        status_values: values.statusValues,
        local_values: values.localValues,
        git_values: values.gitValues,
        read_only: true,
        remote_contact: false,
        writes_independent: true,
      },
    };
    vi.spyOn(durability, "inspectDurability").mockReturnValue(response);
    const result = capture((io) => cmdDurability({ project: temporary, artifact: "progress", id: "qjtrmnpvka", format: "json" }, io));
    expect(result.code).toBe(0);
    expect(result.value).toEqual(response);
    expect(Object.keys(result.value).sort()).toEqual(Object.keys(contract.fields).sort());
    covered(result.value, contract.fields);
    expect(contract.fields.source_contract.status_values).toEqual(values.statusValues);
    expect(contract.exit_codes[0]).toContain("unavailable");
  });

  const recovery: ProjectionRecoveryReport = {
    status: "blocked",
    attempted: 1,
    verified: 0,
    retained_full: 1,
    refused_count: 1,
    refusals: [
      {
        stable_id: "progress:1",
        artifact_id: "progress",
        entry_number: 1,
        archive_path: "archive/1.yaml",
        status: "blocked",
        reason: "corrupt",
        detail_availability: "full",
        source: "current_projection",
        error: {
          schemaVersion: "agentera.stateFailure.v1",
          class: "corrupt",
          message: "fixture",
          syntax: "fixture",
          example: "fixture",
          recovery: "retain detail",
          details: { reason: "fixture" },
        },
      },
    ],
  };
  function operation(action: string, mode = "check"): CompactionOperation {
    return {
      status: {
        artifact: "progress",
        path: "fixture.yaml",
        classification: "compactable",
        exists: true,
        active_count: 11,
        archive_count: 0,
        total_count: 11,
        over_limit_count: 1,
        pending_summarization_count: 1,
        projection_state: "over_defaults",
        protected_overflow_count: 0,
        projection_recovery: recovery,
        reason: "fixture",
      },
      mode,
      action,
      changed: false,
      message: "fixture",
      result: {
        full_before: 11,
        oneline_before: 0,
        full_after: 11,
        oneline_after: 0,
        dropped: 0,
        omitted_count: 0,
        omission_reason: "fixture",
        changed: false,
        recovery,
      },
    };
  }
  it.each([
    ["check", "ok", 0, "pass"],
    ["check", "over_limit", 1, "fail"],
    ["check", "formatting", 1, "fail"],
    ["check", "error", 2, "fail"],
    ["check", "volatile_todo_reference", 1, "fail"],
    ["check", "refused", 0, "pass"],
    ["check", "protected_overflow", 0, "pass"],
    ["fix", "compacted", 0, "pass"],
  ] as const)("matches compact %s/%s result fields and exit without executing compaction", (mode, action, code, status) => {
    const contract = detail("compact");
    const op = {
      ...operation(action, mode),
      diagnostics: [{ path: "fixture.yaml", reference: "TODO.md:3" }],
      omitted_count: 2,
    };
    const run = vi.spyOn(compaction, "runCompaction").mockReturnValue([op]);
    const result = capture((io) => cmdCompact({ project: temporary, mode, format: "json" }, io));
    expect(run).toHaveBeenCalledWith(temporary, mode);
    expect(result.code).toBe(code);
    expect(result.value.status).toBe(status);
    expect(result.value.summary.status).toBe(status);
    expect(Object.keys(result.value).sort()).toEqual(Object.keys(contract.fields).sort());
    covered(result.value, contract.fields);
    expect(result.value.summary.action_counts[action]).toBe(1);
    expect(result.value.summary.artifact_count).toBe(1);
    expect(result.value.operations[0].recovery).toEqual(recovery);
    expect(contract.exit_codes[code]).toBeTruthy();
    expect(fs.readdirSync(temporary)).toEqual([]);
  });

  it("matches compact's bounded omission and degraded fallback shapes", () => {
    const contract = detail("compact");
    const policy = loadProjectionPolicy(root);
    expect(contract.bounds.max_utf8_bytes).toBe(policy.maxUtf8Bytes);
    const run = vi.spyOn(compaction, "runCompaction").mockReturnValue([{ ...operation("ok"), message: "x".repeat(policy.maxUtf8Bytes * 2) }]);
    const trimmed = capture((io) => cmdCompact({ project: temporary, format: "json" }, io));
    expect(trimmed.code).toBe(0);
    expect(trimmed.value.operations).toEqual([]);
    expect(trimmed.value.summary.artifact_count).toBe(1);
    expect(trimmed.value.omitted_count).toBe(1);
    for (const key of Object.keys(contract.projection_omission)) expect(trimmed.value).toHaveProperty(key);
    expect(trimmed.value.retrieval).toEqual(contract.projection_omission.retrieval);
    expect(Buffer.byteLength(trimmed.out)).toBeLessThanOrEqual(policy.maxUtf8Bytes);
    run.mockReturnValue([]);
    const fallback = capture((io) => cmdCompact({ project: path.join(temporary, "x".repeat(policy.maxUtf8Bytes * 2)), format: "json" }, io));
    expect(fallback.code).toBe(0);
    expect(fallback.value.status).toBe("degraded");
    covered(fallback.value, contract.budget_fallback);
    expect(fallback.value.retrieval.available).toBe(false);
    expect(Buffer.byteLength(fallback.out)).toBeLessThanOrEqual(policy.maxUtf8Bytes);
    expect(fs.readdirSync(temporary)).toEqual([]);
  });
});
