import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import auditInstructions from "../../../src/capabilities/audit/instructions.js";
import buildInstructions from "../../../src/capabilities/build/instructions.js";
import { main } from "../../../src/cli/dispatch.js";
import discussInstructions from "../../../src/capabilities/discuss/instructions.js";
import orchestrateInstructions from "../../../src/capabilities/orchestrate/instructions.js";
import planInstructions from "../../../src/capabilities/plan/instructions.js";
import { CAPABILITY_INSTRUCTIONS } from "../../../src/capabilities/index.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

function planCreate(root: string, input: string): { rc: number; output: string } {
  let output = "";
  const rc = main(
    [
      "node",
      "agentera",
      "state",
      "plan",
      "create",
      "--input",
      input,
      "--format",
      "json",
      "--project",
      root,
    ],
    {
      out: (text) => {
        output += text;
      },
      err: (text) => {
        output += text;
      },
      stdin: () => "",
    },
  );
  return { rc, output };
}

function documentedFullPlan(): string {
  const match = planInstructions.match(/#### Full plan format[\s\S]*?```yaml\n([\s\S]*?)\n```/);
  expect(match, "PLAN instructions must include a full YAML example").not.toBeNull();
  return match![1];
}

function servedBuildInstructions(): string {
  let output = "";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-build-prime-"));
  const previous = process.cwd();
  try {
    fs.mkdirSync(path.join(root, ".agentera"));
    fs.writeFileSync(
      path.join(root, ".agentera/state-mode.yaml"),
      "schemaVersion: agentera.stateMode.v1\nmode: entities\n",
    );
    process.chdir(root);
    const rc = main(
      ["node", "agentera", "prime", "--context", "build", "--format", "json"],
      {
        out: (text) => {
          output += text;
        },
        err: (text) => {
          output += text;
        },
        stdin: () => "",
      },
    );
    expect(rc, output).toBe(0);
    return (JSON.parse(output) as Record<string, any>).capability_context.instructions as string;
  } finally {
    process.chdir(previous);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const BUILD_TERMINAL_ORDER_POLICIES = [
  {
    current: "orient through commit, exit signal reported",
    stale: "orient through log, exit signal reported",
    violation: "cycle_must_end_through_commit",
  },
  {
    current: "Steps: orient, select, research, plan, dispatch, verify, log, commit.",
    stale: "Steps: orient, select, research, plan, dispatch, verify, commit, log.",
    violation: "workflow_summary_must_log_before_commit",
  },
  {
    current: "implemented, verified, artifacts updated, committed",
    stale: "implemented, verified, committed, artifacts updated",
    violation: "complete_exit_must_update_artifacts_before_commit",
  },
] as const;

function buildCycleOrderViolations(text: string): string[] {
  const violations: string[] = [];
  const log = text.search(/### Step \d+: Log/);
  const commit = text.search(/### Step \d+: Commit/);
  if (log < 0 || commit < 0 || log >= commit) violations.push("log_must_precede_commit");
  if (!text.includes("### Step 7: Log")) violations.push("log_must_be_step_7");
  if (!text.includes("### Step 8: Commit")) violations.push("commit_must_be_step_8");
  for (const requiredWrite of [
    "**TODO.md**",
    "agentera state progress append",
    "**CHANGELOG.md**",
    "agentera state plan set-status",
  ]) {
    const write = text.indexOf(requiredWrite, Math.max(log, 0));
    if (write < log || write >= commit) violations.push(`write_before_commit:${requiredWrite}`);
  }
  for (const policy of BUILD_TERMINAL_ORDER_POLICIES) {
    if (!text.includes(policy.current) || text.includes(policy.stale)) violations.push(policy.violation);
  }
  return violations;
}

function restoreOldCommitBeforeLogOrder(text: string): string {
  const log = text.indexOf("### Step 7: Log");
  const commit = text.indexOf("### Step 8: Commit", log);
  const end = text.indexOf("\n---\n\n## Safety rails", commit);
  expect(log).toBeGreaterThanOrEqual(0);
  expect(commit).toBeGreaterThan(log);
  expect(end).toBeGreaterThan(commit);
  const logSection = text.slice(log, commit).replace("### Step 7: Log", "### Step 8: Log");
  const commitSection = text.slice(commit, end).replace("### Step 8: Commit", "### Step 7: Commit");
  return `${text.slice(0, log)}${commitSection}${logSection}${text.slice(end)}`;
}

describe("producer capability writer integration", () => {
  it("routes every writable capability artifact through the state writer", () => {
    expect(buildInstructions).toContain("agentera state progress append");
    expect(buildInstructions).toContain(
      "agentera state plan set-status --id ID --status complete",
    );
    expect(discussInstructions).toContain("agentera state decisions append");
    expect(discussInstructions).toContain("agentera state decisions append --input <path|->");
    expect(discussInstructions).toContain("agentera state decisions amend --id ID --base-sha256 HASH --input <path|->");
    expect(discussInstructions).toContain("satisfaction remains flag-only");
    expect(discussInstructions).not.toContain("Append with `agentera state decisions append`");
    expect(discussInstructions).toContain("agentera state decisions update --id ID");
    expect(planInstructions).toContain("agentera state plan create --input PATH");
    expect(planInstructions).toContain("agentera state plan archive --format json");
    expect(orchestrateInstructions).toContain("agentera state plan set-status");
    expect(orchestrateInstructions).toContain("agentera state plan record-evaluation");
    expect(orchestrateInstructions).toContain("before marking the task complete");
    expect(orchestrateInstructions).toContain("recovery for persisted out-of-order replacement state");
    expect(orchestrateInstructions).toContain("may receive its first PASS only");
    expect(orchestrateInstructions).toContain("Every replacement must be complete with latest persisted PASS before supersession");
    expect(auditInstructions).toContain("agentera state health append --input PATH");
  });

  it("requires Build artifact logging before its single commit on source and served surfaces", () => {
    const variants = {
      source: buildInstructions,
      served: servedBuildInstructions(),
    };
    const staleClaims = [
      "assigns the number",
      "inserts newest-first",
      "validates, compacts",
      "Progress compaction is writer-owned",
    ];

    for (const [variant, text] of Object.entries(variants)) {
      expect(buildCycleOrderViolations(text), `${variant} valid order`).toEqual([]);
      expect(
        buildCycleOrderViolations(restoreOldCommitBeforeLogOrder(text)),
        `${variant} old Commit-before-Log order`,
      ).toContain("log_must_precede_commit");
      expect(text, `${variant} single commit`).toContain("Commit once with a conventional commit message");
      for (const policy of BUILD_TERMINAL_ORDER_POLICIES) {
        expect(text, `${variant} terminal order`).toContain(policy.current);
        expect(text, `${variant} stale terminal order`).not.toContain(policy.stale);
        expect(
          buildCycleOrderViolations(text.replace(policy.current, policy.stale)),
          `${variant} terminal-order regression: ${policy.violation}`,
        ).toContain(policy.violation);
      }
      for (const claim of staleClaims) expect(text, `${variant} stale claim: ${claim}`).not.toContain(claim);
    }
  });

  it("keeps Build validation and exit schemas aligned with Log Step 7 and Commit Step 8", () => {
    const validation = YAML.parse(
      fs.readFileSync(
        path.join(REPO_ROOT, "skills/agentera/capabilities/build/schemas/validation.yaml"),
        "utf8",
      ),
    ) as Record<string, any>;
    const exit = YAML.parse(
      fs.readFileSync(
        path.join(REPO_ROOT, "skills/agentera/capabilities/build/schemas/exit.yaml"),
        "utf8",
      ),
    ) as Record<string, any>;

    expect(validation.VALIDATION[2].description).toContain("logging required artifacts (Step 7)");
    expect(validation.VALIDATION[2].description).toContain("committing once (Step 8)");
    expect(exit.EXIT_CONDITIONS[1].description).toContain("updates preceded the cycle's single");
  });

  it("keeps orchestration delegation runtime-neutral", () => {
    expect(orchestrateInstructions).toContain("host-provided worker facility");
    expect(orchestrateInstructions).not.toContain("runtime-native subagent descriptor");
    expect(orchestrateInstructions).not.toContain("runtime-native subagent substrate");
    expect(orchestrateInstructions).not.toMatch(/(?:\.codex\/agents|\.cursor\/agents|\.opencode\/agents)/);
  });

  it("keeps evaluator report fields in the Surface 2 delegation template", () => {
    const start = orchestrateInstructions.indexOf("**Surface 2:");
    const end = orchestrateInstructions.indexOf("### Step 4:", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const surface = orchestrateInstructions.slice(start, end);
    expect(surface).toContain("citation: `<file>:<line>` OR `not-applicable: <reason>`");
    expect(surface).toContain("verify_command");
    expect(surface).toContain("evaluator_handoff.output_requirements");
  });

  it("orders terminal-open health closure before plan completion and preserves failure follow-up", () => {
    const artifacts = YAML.parse(
      fs.readFileSync(
        path.join(REPO_ROOT, "skills/agentera/capabilities/orchestrate/schemas/artifacts.yaml"),
        "utf8",
      ),
    ) as Record<string, any>;
    const healthSchema = fs.readFileSync(
      path.join(REPO_ROOT, "skills/agentera/schemas/artifacts/health.yaml"),
      "utf8",
    );
    const health = YAML.parse(healthSchema) as Record<string, any>;
    const closureStart = orchestrateInstructions.indexOf("**Terminal-open closure sequence**");
    const closureEnd = orchestrateInstructions.indexOf("Step markers", closureStart);
    const closure = orchestrateInstructions.slice(closureStart, closureEnd);

    expect(artifacts.ARTIFACTS[3]).toMatchObject({
      artifact: "health",
      local_role: "produces_and_consumes",
    });
    expect(health.meta).toMatchObject({ producer: ["audit", "orchestrate"] });
    expect(healthSchema).toContain("# Audit normally owns health records. Orchestrate may append only the limited");
    expect(healthSchema).toContain("# artifact_freshness record for terminal-plan closure after Audit passes.");
    expect(health.meta.description).toContain("Audit normally owns health records.");
    expect(health.meta.description).toContain("limited artifact_freshness record for terminal-plan closure after Audit passes.");
    expect(orchestrateInstructions).toContain("Plan exists, `active: true` and `complete_plan: true`");
    expect(closure).toContain("agentera state health append --input PATH --format json");
    expect(closure.indexOf("agentera state health append --input PATH --format json")).toBeLessThan(
      closure.indexOf("agentera state plan set-plan-status --status complete --format json"),
    );
    expect(closure).toContain("WARN or FAIL requiring follow-up");
    expect(closure).toContain("keep the plan open");
    expect(closure).not.toContain("run `agentera state plan archive");
    expect(orchestrateInstructions).toContain("During terminal-open closure only, Orchestrate may publish the limited typed health record");
    expect(orchestrateInstructions).not.toContain("changes plan lifecycle state only through `agentera state plan set-status ...`");
    expect(orchestrateInstructions).toContain("**No plan in returned state**: bootstrap mode.");
  });

  it("uses the writer as the final plan publication gate", () => {
    const vocabulary = fs.readFileSync(
      path.join(REPO_ROOT, "references/cli/vocabulary.md"),
      "utf8",
    );

    expect(planInstructions).toContain("### Step 4: Validate and publish");
    expect(planInstructions).toContain("Optionally run `agentera check lint");
    expect(planInstructions).toContain("sole publication gate");
    expect(planInstructions).not.toContain("Pre-write self-audit");
    expect(vocabulary).toContain("Draft lint preview");
    expect(vocabulary).toContain("the typed writer validates final bytes when publishing");
  });

  it("uses lifecycle coherence instead of a fixed full-plan task count", () => {
    const validation = YAML.parse(
      fs.readFileSync(
        path.join(REPO_ROOT, "skills/agentera/capabilities/plan/schemas/validation.yaml"),
        "utf8",
      ),
    ) as Record<string, any>;
    const rule = validation.VALIDATION[2] as Record<string, any>;

    expect(rule.rule).toBe("coherent_lifecycle_scope");
    expect(rule.description).toContain("real lifecycle or coherence boundary");
    expect(planInstructions).toContain("coherent lifecycle boundary");
    expect(planInstructions).toContain("real lifecycle or coherence boundary");
    expect(planInstructions).not.toMatch(/\*\*Task decomposition\*\*:\s*\d/);
    expect(planInstructions).not.toMatch(/more than \d+ tasks/i);
  });

  it("keeps the source capability index aligned with plan instructions", () => {
    expect(CAPABILITY_INSTRUCTIONS.plan).toBe(planInstructions);
  });

  it("publishes the documented full plan YAML through the typed writer", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-plan-example-"));
    const omittedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-plan-example-"));
    try {
      const example = documentedFullPlan();
      const parsed = YAML.parse(example) as Record<string, any>;
      expect(parsed.overall_acceptance).toEqual(expect.any(String));
      expect(parsed.tasks[1].depends_on).toEqual(["1"]);
      expect(parsed.rejected).toEqual([
        expect.objectContaining({ issue: expect.any(String), rationale: expect.any(String) }),
      ]);

      const input = path.join(root, "plan.yaml");
      fs.mkdirSync(path.join(root, ".agentera"));
      fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
      fs.writeFileSync(input, example);
      const published = planCreate(root, input);
      expect(published.rc, published.output).toBe(0);

      delete parsed.rejected;
      const withoutRejections = path.join(omittedRoot, "without-rejections.yaml");
      fs.mkdirSync(path.join(omittedRoot, ".agentera"));
      fs.writeFileSync(path.join(omittedRoot, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
      fs.writeFileSync(withoutRejections, YAML.stringify(parsed));
      const omitted = planCreate(omittedRoot, withoutRejections);
      expect(omitted.rc, omitted.output).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(omittedRoot, { recursive: true, force: true });
    }
  });

  it("keeps cold-start agent surfaces discoverable", () => {
    const skill = fs.readFileSync(path.join(REPO_ROOT, "skills/agentera/SKILL.md"), "utf8");
    const agents = fs.readFileSync(path.join(REPO_ROOT, "AGENTS.md"), "utf8");
    expect(skill).toContain("npx -y agentera@next state decisions explain");
    expect(agents).toContain("agentera state decisions explain");
    expect(skill).toContain("--dry-run");
    expect(agents).toContain("--dry-run");
    expect(skill).toContain("not edit `.agentera/entities/` directly");
    expect(agents).toContain("instead of editing `.agentera/entities/`");
  });
});
