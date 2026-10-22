import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";
import YAML from "yaml";

import { cmdPrime } from "../../src/cli/commands/prime.js";
import { PRIME_STRUCTURED_FIELDS } from "../../src/cli/stateQuery.js";
import { runHostSkillLifecycle } from "../../src/setup/hostSkillLifecycle.js";
import { createPrimeBudgetFixture, createPrimeLargeAttentionFixture, GPT5_TOKENIZER, measurePrimeOutput } from "../../scripts/measure-prime-budget.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");

type FixtureFactory = (repoRoot: string, temporaryRoot: string) => { appHome: string; home: string; profile: string; project: string; sourceRoot?: string };

function briefingBudget(): { bytes: number; gpt5_tokens: number } {
  const manifest = YAML.parse(fs.readFileSync(path.join(REPO_ROOT, "scripts/json_output_surface_manifest.yaml"), "utf8"));
  const surface = manifest.surfaces.find(({ id }: { id: string }) => id === "prime-briefing");
  return { bytes: surface.byte_budget, gpt5_tokens: surface.token_budget };
}

/** The bounded fixture with the previous shared skill installed in the
 *  isolated home, so bare prime carries shared_skill.upgrade_offer. As in a
 *  real npx run, the bundle that supplies the current host skill is separate
 *  from the app home that holds install state; an overlap blocks the offer. */
function createPrimeSkillOfferFixture(repoRoot: string, temporaryRoot: string) {
  const roots = createPrimeBudgetFixture(repoRoot, temporaryRoot);
  const sourceRoot = path.join(temporaryRoot, "bundle");
  fs.cpSync(roots.appHome, sourceRoot, { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, "host/agentera"), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "skills/agentera/SKILL.md"), path.join(sourceRoot, "host/agentera/SKILL.md"));
  const source = path.join(temporaryRoot, "previous-runtime");
  for (const relative of ["registry.json", "references/adapters/package-registry.yaml"]) {
    fs.mkdirSync(path.dirname(path.join(source, relative)), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, relative), path.join(source, relative));
  }
  fs.mkdirSync(path.join(source, "skills/agentera"), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "packages/cli/test/fixtures/shared-skill/previous-SKILL-3.0.0.md"), path.join(source, "skills/agentera/SKILL.md"));
  const installed = runHostSkillLifecycle({ home: roots.home, appHome: roots.appHome, sourceRoot: source, apply: true });
  if (installed.status !== "success") throw new Error(`previous shared skill install failed: ${JSON.stringify(installed)}`);
  return { ...roots, sourceRoot };
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
    const { appHome, home, profile, project, sourceRoot = appHome } = createFixture(REPO_ROOT, temporaryRoot);
    process.env.HOME = home;
    process.env.AGENTERA_HOME = appHome;
    process.env.AGENTERA_PROFILE_DIR = profile;
    process.env.PROFILERA_PROFILE_DIR = profile;
    process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = sourceRoot;
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

  it("keeps a fixture carrying a shared-skill update offer within its byte and GPT-5 token budgets", () => {
    const { rc, out, err } = runPrimeIn(createPrimeSkillOfferFixture);
    const result = measurePrimeOutput(out, briefingBudget());
    const payload = JSON.parse(out) as Record<string, any>;

    expect(rc, out).toBe(0);
    expect(err).toBe("");
    expect(payload.shared_skill.upgrade_offer).toMatchObject({
      question: "Agentera’s installed skill needs an update. Update it now? Your project files will not change.",
      approval: "explicit_yes_only",
    });
    expect(payload.brief.projection).toBe("ok");
    expect(result.violations, JSON.stringify(result)).toEqual([]);
  });

  it("measures the large-attention fixture's unprojected state above the brief budget", () => {
    const { rc, out } = runPrimeIn(createPrimeLargeAttentionFixture, PRIME_STRUCTURED_FIELDS.join(","));

    expect(rc).toBe(0);
    expect(measurePrimeOutput(out, briefingBudget()).violations).toContain("bytes");
  });

  it("rejects a briefing one token over the declared budget", () => {
    const budget = briefingBudget();
    const result = measurePrimeOutput("x ".repeat(budget.gpt5_tokens + 1), budget);

    expect(result.measurement.bytes).toBeLessThanOrEqual(budget.bytes);
    expect(result.violations).toEqual(["gpt5_tokens"]);
  });
});
