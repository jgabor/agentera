import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";
import YAML from "yaml";

import { cmdPrime } from "../../src/cli/commands/prime.js";
import { PRIME_STRUCTURED_FIELDS } from "../../src/cli/stateQuery.js";
import { createPrimeBudgetFixture, createPrimeLargeAttentionFixture, GPT5_TOKENIZER, measurePrimeOutput } from "../../scripts/measure-prime-budget.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");

type FixtureFactory = (repoRoot: string, temporaryRoot: string) => { appHome: string; home: string; profile: string; project: string };

function briefingBudget(): { bytes: number; gpt5_tokens: number } {
  const manifest = YAML.parse(fs.readFileSync(path.join(REPO_ROOT, "scripts/json_output_surface_manifest.yaml"), "utf8"));
  const surface = manifest.surfaces.find(({ id }: { id: string }) => id === "prime-briefing");
  return { bytes: surface.byte_budget, gpt5_tokens: surface.token_budget };
}

/** Run prime in a disposable fixture with an isolated home and bundle. */
function runPrimeIn(createFixture: FixtureFactory, fields?: string): { rc: number; out: string; err: string; temporaryRoot: string } {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prime-token-budget-"));
  const previousCwd = process.cwd();
  const previous = {
    HOME: process.env.HOME,
    AGENTERA_HOME: process.env.AGENTERA_HOME,
    AGENTERA_PROFILE_DIR: process.env.AGENTERA_PROFILE_DIR,
    PROFILERA_PROFILE_DIR: process.env.PROFILERA_PROFILE_DIR,
    AGENTERA_BOOTSTRAP_SOURCE_ROOT: process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT,
  };
  try {
    const { appHome, home, profile, project } = createFixture(REPO_ROOT, temporaryRoot);
    process.env.HOME = home;
    process.env.AGENTERA_HOME = appHome;
    process.env.AGENTERA_PROFILE_DIR = profile;
    process.env.PROFILERA_PROFILE_DIR = profile;
    process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = appHome;
    process.chdir(project);

    let out = "";
    let err = "";
    const rc = cmdPrime(
      { command: "prime", ...(fields ? { fields } : {}) },
      {
        out: (text) => {
          out += text;
        },
        err: (text) => {
          err += text;
        },
      },
    );
    return { rc, out, err, temporaryRoot };
  } finally {
    process.chdir(previousCwd);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

/** Every string leaf of a JSON value with its dotted path. */
function stringLeaves(value: unknown, at = ""): Array<[string, string]> {
  if (typeof value === "string") return [[at, value]];
  if (Array.isArray(value)) return value.flatMap((entry, index) => stringLeaves(entry, `${at}[${index}]`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, entry]) => stringLeaves(entry, at ? `${at}.${key}` : key));
  return [];
}

describe("prime GPT-5 token budget", () => {
  it("pins the tokenizer package, version, model, and manifest method", () => {
    const packageManifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "packages/cli/package.json"), "utf8"));
    const manifest = YAML.parse(fs.readFileSync(path.join(REPO_ROOT, "scripts/json_output_surface_manifest.yaml"), "utf8"));

    expect(packageManifest.devDependencies[GPT5_TOKENIZER.package]).toBe(GPT5_TOKENIZER.version);
    expect(manifest.measurement.tokens).toEqual({
      ...GPT5_TOKENIZER,
      count: "encode(stdout).length",
    });
  });

  it("keeps the bounded fixture prime briefing within its byte and GPT-5 token budgets", () => {
    const { rc, out, err, temporaryRoot } = runPrimeIn(createPrimeBudgetFixture);
    const result = measurePrimeOutput(out, briefingBudget());

    expect(rc).toBe(0);
    expect(err).toBe("");
    expect(out).not.toContain(temporaryRoot);
    expect(JSON.parse(out)).toMatchObject({
      command: "prime",
      app_home: { status: "up_to_date", source: "bundled app" },
      app: { status: "up_to_date" },
    });
    expect(result.violations, JSON.stringify(result)).toEqual([]);
  });

  it("keeps a large-attention fixture within budget and names every omission with a continuation command", () => {
    const { rc, out, err, temporaryRoot } = runPrimeIn(createPrimeLargeAttentionFixture);
    const result = measurePrimeOutput(out, briefingBudget());
    const payload = JSON.parse(out) as Record<string, any>;

    expect(rc, out).toBe(0);
    expect(err).toBe("");
    expect(out).not.toContain("unsupported_target");
    expect(out).not.toContain(temporaryRoot);
    expect(payload.brief.projection).toBe("ok");
    expect(result.violations, JSON.stringify(result)).toEqual([]);
    expect(payload.brief.omitted).toEqual({
      "plan.tasks": "npx -y agentera@next state plan tasks list",
      "plan.first_pending.acceptance": "npx -y agentera@next state plan tasks get --id bcdefghijk",
      "docs.entries": "npx -y agentera@next state docs list",
      "decision_attention.entries": "npx -y agentera@next state decisions list",
      "history.progress.entries": "npx -y agentera@next state progress list --limit 20",
      "history.decisions.entries": "npx -y agentera@next state decisions list --limit 20",
      "history.health.entries": "npx -y agentera@next state health list --limit 20",
      "next_action.alternatives": "npx -y agentera@next prime --context status",
    });
    // Only prose may be shortened. Commands, IDs, and field names stay exact.
    for (const [at, value] of stringLeaves(payload)) {
      if (/^(npx |agentera )/.test(value) || /(^|\.)(id|get|exact|list|fetch_command|detail_command|recovery_command)$/.test(at) || at.includes("depends_on") || at.startsWith("brief.omitted")) {
        expect(value, at).not.toContain("…");
      }
    }
  });

  it("measures the large-attention fixture's unprojected state above the brief budget", () => {
    const { rc, out } = runPrimeIn(createPrimeLargeAttentionFixture, PRIME_STRUCTURED_FIELDS.join(","));

    expect(rc).toBe(0);
    expect(measurePrimeOutput(out, briefingBudget()).violations).toContain("bytes");
  });

  it("rejects a deliberately oversized briefing", () => {
    const result = measurePrimeOutput("x ".repeat(3_001), { bytes: 12_000, gpt5_tokens: 3_000 });

    expect(result.violations).toEqual(["gpt5_tokens"]);
  });
});
