import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runServiceDetail } from "../../src/cli/commands/serviceDetail.js";
import { serviceDetailArgs, type ServiceOwner } from "../../src/cli/commands/serviceDetailQuery.js";
import { runSchemaDetail } from "../../src/cli/commands/schemaDetail.js";
import { cmdReport } from "../../src/cli/commands/report.js";
import { analyzeCorpus, buildJsonPayload } from "../../src/analytics/usageStats.js";
import { VALIDATE_FAMILY_NAMES, VERIFY_TARGETS } from "../../src/cli/commands/checkCatalog.js";
import { sourceBuildOutputRoot, sourceSubprocessEnv } from "../helpers/sourceSubprocess.js";
import { validateFrozenGlossaryHoldout, validateFrozenGlossaryBehaviorFixture, loadGlossaryEvaluationBehaviorFixture } from "../../src/eval/glossaryEvaluation.js";

const root = path.resolve(import.meta.dirname, "../../../..");
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
function query(args: string[]) {
  let out = "",
    err = "";
  const io = {
    out: (text: string) => {
      out += text;
    },
    err: (text: string) => {
      err += text;
    },
  };
  const code = args[0] === "schema" ? runSchemaDetail(args.slice(1), io) : runServiceDetail(args[0] as ServiceOwner, serviceDetailArgs(args), io);
  expect(err).toBe("");
  expect(Buffer.byteLength(out)).toBeLessThanOrEqual(32768);
  return { code, value: JSON.parse(out), out };
}
const commandArgs = (command: string) => (command.match(/'[^']*'|\S+/g) ?? []).slice(3).map((word) => (word.startsWith("'") ? word.slice(1, -1) : word));
function read(args: string[], kind = "object"): any {
  let response = query(args);
  const items: any[] = [],
    mode = response.value.completeness?.mode;
  for (;;) {
    expect(response.code, response.out).toBe(0);
    items.push(...response.value.items);
    if (!response.value.next_command) break;
    response = query(commandArgs(response.value.next_command));
  }
  if (mode === "detail") return items[0].parts ? items.map((item) => item.content).join("") : items[0].content;
  const value: any = kind === "array" ? [] : {};
  for (const item of items) value[decodeURIComponent(item.name.split(".").at(-1))] = read(commandArgs(item.content.detail_command), item.content.kind);
  return value;
}
function corrupt(relative: string, mutate: (value: any) => void) {
  vi.stubEnv("AGENTERA_BOOTSTRAP_SOURCE_ROOT", root);
  const original = fs.readFileSync.bind(fs);
  vi.spyOn(fs, "readFileSync").mockImplementation(((file: any, ...args: any[]) => {
    const content = (original as any)(file, ...args);
    if (String(file) !== path.join(root, relative)) return content;
    const value = YAML.parse(content);
    mutate(value);
    return YAML.stringify(value);
  }) as any);
}

describe("purpose-owned report/check/recovery static guidance", () => {
  it("describes the actual summary and refresh output variants, not Profile Full inputs", () => {
    const summary = read(["report", "explain", "--operation", "summary", "--section", "output"]);
    const analysis = analyzeCorpus({
      records: [
        {
          source_kind: "conversation_turn",
          source_id: "turn",
          timestamp: "2026-01-01T00:00:00Z",
          project_id: "fixture",
          runtime: "opencode",
          data: { actor: "assistant", content: "── ◇ plan · start ──" },
        },
      ],
    });
    const actual = buildJsonPayload(analysis, { generatedAt: "now", extractedAt: null });
    expect(Object.keys(summary.ready).sort()).toEqual(Object.keys(actual).sort());
    expect(analysis.invocations).toHaveLength(1);
    expect(Object.keys(summary.ready.invocations[0]).sort()).toEqual(Object.keys(analysis.invocations[0]).sort());
    expect(Object.keys(summary.ready.skills["<capability>"]).sort()).toEqual(Object.keys(analysis.skills.plan).sort());
    expect(summary.effects).toContain("USAGE.md");
    const refresh = read(["report", "explain", "--operation", "refresh", "--section", "output"]);
    const out: string[] = [];
    expect(
      cmdReport(
        {
          action: "refresh",
          dryRun: true,
          format: "json",
          output: "/unused/intermediate/corpus.json",
        },
        { out: (text) => out.push(text) },
      ),
    ).toBe(0);
    const dryRun = JSON.parse(out.join(""));
    expect(Object.keys(refresh.dry_run).sort()).toEqual(Object.keys(dryRun).sort());
    expect(refresh.dry_run.privacy).toEqual(dryRun.privacy);
    out.length = 0;
    expect(cmdReport({ action: "refresh", format: "json" }, { out: (text) => out.push(text), err: () => {} })).toBe(2);
    const denied = JSON.parse(out.join(""));
    expect(Object.keys(refresh.consent_required).sort()).toEqual(Object.keys(denied).sort());
    expect(refresh.consent_required.status).toBe(denied.status);
    expect(refresh.attempted.projection.published).toHaveProperty("write_status");
    expect(refresh.recovery).toContain("separate statuses");
  });
  it.each([
    ["references/analysis/structured-input-inventory.yaml", ["check", "explain", "--operation", "validate", "--target", "retained-references"], "structured_input_inventory"],
    ["references/analysis/verification-policy.yaml", ["check", "explain", "--operation", "verify"], "verification_policy"],
  ])(
    "serves the complete source-only governance without running its owners: %s",
    (relative, args, section) => {
      expect(read([...args, "--section", section, "--limit", "2"])).toEqual(YAML.parse(fs.readFileSync(path.join(root, relative), "utf8")));
    },
    30000,
  );
  it.each([
    [
      "references/analysis/structured-input-inventory.yaml",
      (value: any) => {
        value.routes.pop();
      },
      ["check", "explain", "--operation", "validate", "--target", "retained-references"],
    ],
    [
      "references/analysis/verification-policy.yaml",
      (value: any) => {
        value.owners.source.config = [];
      },
      ["check", "explain", "--operation", "verify"],
    ],
  ])("fails closed on invalid selected source governance: %s", (relative, mutate, args) => {
    corrupt(relative, mutate);
    expect(query(args).code).toBe(1);
  });
  it("validates the same closed overlap declaration as the verification lane", () => {
    corrupt("references/analysis/verification-policy.yaml", (value) => {
      value.overlap.allowed_pending_assertion.owner = "package";
    });
    expect(query(["check", "explain", "--operation", "verify"]).code).toBe(1);
  });
  it("validates frozen evaluation references without returning corpus records", () => {
    const authority = YAML.parse(fs.readFileSync(path.join(root, "references/analysis/personal-glossary-evaluation-authority.yaml"), "utf8"));
    const holdoutBytes = fs.readFileSync(path.join(root, "references/analysis/personal-glossary-holdout.yaml"), "utf8");
    const corpusBytes = fs.readFileSync(path.join(root, "references/analysis/personal-glossary-evaluation-corpus.yaml"), "utf8");
    const holdout = YAML.parse(holdoutBytes),
      corpus = loadGlossaryEvaluationBehaviorFixture(root);
    expect(validateFrozenGlossaryHoldout(authority, holdout, holdoutBytes)).toEqual([]);
    expect(validateFrozenGlossaryBehaviorFixture(authority, holdout, corpus, corpusBytes)).toEqual([]);
    const result = read(["check", "explain", "--operation", "verify", "--target", "eval glossary", "--section", "fixture_boundary"]);
    expect(result.validation).toContain("No evaluation is run");
    corrupt("references/analysis/personal-glossary-evaluation-authority.yaml", (value) => {
      value.observations.behavior_fixture.fixture_sha256 = "0".repeat(64);
    });
    const failed = query(["check", "explain", "--operation", "verify", "--target", "eval glossary"]);
    expect(failed.code).toBe(1);
    expect(failed.out).not.toContain("synthetic_record_provenance");
  });
  it("serves actual lifecycle vocabulary and rejects malformed channel policy", () => {
    const value = read(["upgrade", "--explain", "--operation", "migrate", "--section", "vocabulary"]);
    expect(value).toEqual(YAML.parse(fs.readFileSync(path.join(root, "references/cli/app-lifecycle-vocabulary.yaml"), "utf8")));
    corrupt("references/cli/update-channels.yaml", (value) => {
      value.default_channel = "unknown";
    });
    expect(query(["doctor", "--explain"]).code).toBe(1);
  });
  it("compiled entry point is static before import-time/project gates and preserves isolated trees", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-service-detail-"));
    try {
      fs.mkdirSync(path.join(temporary, ".agentera"));
      fs.writeFileSync(path.join(temporary, ".agentera", "vision.yaml"), "malformed: [");
      fs.writeFileSync(path.join(temporary, "PROFILE.md"), "PRIVATE_DEFINITION_SENTINEL");
      const before = fs.readdirSync(temporary).sort();
      const bin = pathToFileURL(path.join(sourceBuildOutputRoot(), "bin/agentera.js")).href;
      for (const args of [
        ["report", "explain", "--operation", "summary", "--section", "output"],
        ["report", "explain", "--operation", "refresh", "--section", "output"],
        ["check", "explain", "--operation", "validate", "--target", "retained-references"],
        ["check", "explain", "--operation", "verify", "--section", "verification_policy"],
        ["report", "explain", "--operation", "glossary-advice"],
        ["check", "explain", "--operation", "validate", "--target", "state"],
        ["upgrade", "--explain", "--operation", "reset"],
        ["doctor", "--explain"],
        ["app-home", "--explain"],
      ]) {
        const script = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; const read = fs.readFileSync; fs.readFileSync = function(file, ...args) { if (String(file).startsWith(${JSON.stringify(temporary)})) throw new Error('PRIVATE_READ'); return read.call(this, file, ...args); }; for (const name of ['writeFileSync','appendFileSync','mkdirSync','renameSync','unlinkSync']) fs[name] = () => { throw new Error('WRITE'); }; syncBuiltinESMExports(); process.argv = ['node','agentera',...${JSON.stringify(args)}]; await import(${JSON.stringify(bin)});`;
        const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
          cwd: temporary,
          encoding: "utf8",
          env: sourceSubprocessEnv({
            ...process.env,
            HOME: temporary,
            AGENTERA_HOME: temporary,
            AGENTERA_PROFILE_DIR: temporary,
            AGENTERA_BOOTSTRAP_SOURCE_ROOT: root,
          }),
        });
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(result.stderr).toBe("");
        expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(32768);
        expect(result.stdout).not.toContain("PRIVATE_DEFINITION_SENTINEL");
      }
      expect(fs.readdirSync(temporary).sort()).toEqual(before);
      expect(fs.readFileSync(path.join(temporary, "PROFILE.md"), "utf8")).toBe("PRIVATE_DEFINITION_SENTINEL");
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }, 30000);
  it("discovers every report action including nested reads/reviews and default summary", () => {
    const operations = read(["report", "explain", "--section", "operations"]).map((item: any) => item.operation);
    expect(operations).toEqual([
      "summary",
      "refresh",
      "profile-grounding",
      "glossary-advice",
      "personal-glossary-candidates list",
      "personal-glossary-candidates get",
      "personal-glossary-decision",
      "personal-glossary-reviews queue",
      "personal-glossary-reviews disposition",
      "personal-glossary-reviews list",
      "personal-glossary-reviews get",
      "personal-glossary-publish",
    ]);
    for (const operation of operations) expect(query(["report", "explain", "--operation", operation]).code).toBe(0);
  });
  it("losslessly serves full glossary construction/review/publication and evidence authorities", () => {
    const entry = YAML.parse(fs.readFileSync(path.join(root, "references/artifacts/glossary-entry-contract.yaml"), "utf8"));
    expect(read(["report", "explain", "--operation", "personal-glossary-reviews disposition", "--section", "entry", "--limit", "2"])).toEqual(entry);
    expect(read(["schema", "--artifact", "glossary", "--section", "entry", "--limit", "2"])).toEqual(entry);
    expect(read(["report", "explain", "--operation", "refresh", "--section", "evidence"])).toEqual(YAML.parse(fs.readFileSync(path.join(root, "references/analysis/evidence-tier-authority.yaml"), "utf8")));
  }, 30000);
  it("uses dispatched check targets and exposes all lifecycle operations", () => {
    const targets = read(["check", "explain", "--operation", "validate", "--section", "targets"]);
    for (const target of VALIDATE_FAMILY_NAMES) expect(targets.some((item: any) => item.target === target)).toBe(true);
    for (const target of targets) expect(query(commandArgs(target.command)).code).toBe(0);
    const verify = read(["check", "explain", "--operation", "verify", "--section", "targets"]);
    expect(verify.map((item: any) => item.target)).toEqual(Object.entries(VERIFY_TARGETS).flatMap(([family, values]) => values.map((target) => `${family} ${target}`)));
    for (const target of verify) expect(query(commandArgs(target.command)).code).toBe(0);
    const operations = read(["upgrade", "--explain", "--section", "operations"]);
    expect(operations.map((item: any) => item.operation)).toEqual(["install", "refresh", "migrate", "reset", "cleanup"]);
    for (const item of operations) expect(query(commandArgs(item.command)).code).toBe(0);
    expect(query(["doctor", "--explain"]).code).toBe(0);
    expect(query(["app-home", "--explain"]).code).toBe(0);
  });
  it.each([
    ["report", "explain", "--input", "-"],
    ["report", "explain", "--consent", "local-history"],
    ["report", "explain", "--operation", "unknown"],
    ["check", "explain", "--operation", "lint", "--target", "x"],
    ["check", "explain", "--target", "state"],
    ["doctor", "--explain", "--home", "/private"],
    ["upgrade", "--explain", "--yes"],
    ["upgrade", "--explain", "--explain"],
    ["upgrade", "--explain=true"],
    ["app-home", "--explain", "--format", "text"],
    ["report", "explain", "--limit", "101"],
    ["doctor", "--explain", "--operation", "install"],
  ])("rejects operational or malformed static inputs: %j", (...args) => {
    expect(query(args).code).toBe(64);
  });
  it("binds cursors to selectors, limits and authority bytes", () => {
    const first = query(["report", "explain", "--operation", "glossary-advice", "--limit", "1"]);
    const next = commandArgs(first.value.next_command);
    expect(query(next).code).toBe(0);
    expect(query(next.map((value) => (value === "glossary-advice" ? "profile-grounding" : value))).code).toBe(64);
    corrupt("references/artifacts/glossary-entry-contract.yaml", (value) => {
      value.purpose += " A clarified sentence.";
    });
    expect(query(next).code).toBe(64);
  });
  it.each([
    [
      "references/artifacts/glossary-entry-contract.yaml",
      (value: any) => {
        value.shared_primitive.fields.confidence.range_from = "wrong";
      },
      ["report", "explain", "--operation", "glossary-advice"],
    ],
    [
      "references/artifacts/glossary-entry-contract.yaml",
      (value: any) => {
        value.shared_primitive.required_fields = [];
      },
      ["schema", "--artifact", "glossary", "--section", "entry"],
    ],
    [
      "references/analysis/evidence-tier-authority.yaml",
      (value: any) => {
        delete value.tiers;
      },
      ["report", "explain", "--operation", "refresh"],
    ],
    [
      "references/adapters/product-v1-reset.yaml",
      (value: any) => {
        value.policy.preserve_unlisted_state = false;
      },
      ["upgrade", "--explain", "--operation", "reset"],
    ],
    [
      "references/adapters/runtime-retired-resources.yaml",
      (value: any) => {
        value.schema_version = "invalid";
      },
      ["upgrade", "--explain", "--operation", "cleanup"],
    ],
  ] as const)("fails closed on selected malformed governance: %s", (file, mutate, args) => {
    corrupt(file, mutate);
    const result = query([...args]);
    expect(result.code, result.out).toBe(1);
    expect(result.out).not.toContain("Error:");
    expect(result.value.error.class).toBe("schema_violation");
  });
  it("does not open project/private stores or write during discovery", () => {
    vi.stubEnv("AGENTERA_BOOTSTRAP_SOURCE_ROOT", root);
    vi.stubEnv("AGENTERA_HOME", "/never-read-private-home");
    vi.stubEnv("AGENTERA_PROFILE_DIR", "/never-read-private-profile");
    const original = fs.readFileSync.bind(fs),
      reads: string[] = [];
    vi.spyOn(fs, "readFileSync").mockImplementation(((file: any, ...args: any[]) => {
      reads.push(String(file));
      return (original as any)(file, ...args);
    }) as any);
    const write = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("unexpected write");
    });
    for (const args of [
      ["report", "explain", "--operation", "personal-glossary-publish"],
      ["check", "explain", "--operation", "durability"],
      ["doctor", "--explain"],
      ["upgrade", "--explain", "--operation", "reset"],
      ["app-home", "--explain"],
    ])
      expect(query(args).code).toBe(0);
    expect(write).not.toHaveBeenCalled();
    expect(reads.some((file) => file.includes("never-read") || file.includes("/.agentera/") || file.endsWith("PROFILE.md"))).toBe(false);
  });
});
